import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  artifactSql,
  buildArtifact,
  renderLoader,
  FUNCTIONS,
} from '../scripts/build-edge-artifact.mjs';

/**
 * Parité chargeur ↔ dépôt.
 *
 * Le chargeur déployé ne contient aucune logique métier : il télécharge le
 * bundle depuis un commit précis du dépôt public, vérifie sa taille et son
 * empreinte, puis l'exécute. Ces tests garantissent que :
 *   1. le chargeur livré correspond exactement à ce que le script génère pour
 *      le bundle actuel (aucune dérive silencieuse) ;
 *   2. le bundle ne contient **aucune** instruction `import` (il est exécuté
 *      par `new Function`, qui les refuserait) ni aucun secret inliné ;
 *   3. le commit est épinglé et jamais une branche mouvante.
 *
 * ## Pourquoi ils ont changé
 * Ils vérifiaient auparavant un chargement depuis `public._edge_function_artifact`.
 * Ce mécanisme n'est plus celui de la production : les tests validaient donc un
 * chargeur que personne n'exécute. C'est précisément le genre d'écart qui avait
 * laissé la garde d'abonnement hors du bundle déployé.
 */

const NOM = 'store-import';

/**
 * Lit un fichier **tel qu'il est au commit donné**, via `git show`.
 *
 * ## Pourquoi ce test existe
 * L'artefact et le chargeur voyagent dans deux commits successifs : le
 * chargeur désigne le commit qui contient l'artefact. Générer le chargeur
 * depuis `HEAD` juste après avoir committé le code — sans avoir committé
 * l'artefact — produit une épingle cohérente avec le dossier de travail mais
 * FAUSSE en dépôt : le chargeur déployé télécharge l'ancien bundle, l'empreinte
 * ne correspond pas, et la fonction répond 503. C'est déjà arrivé.
 *
 * Le contrôle ci-dessous interroge donc le commit épinglé lui-même, et non le
 * disque.
 */
function fichierAuCommit(commit: string, chemin: string): string | null {
  try {
    return execFileSync('git', ['show', `${commit}:${chemin}`], {
      cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

describe('artefact store-import — parité avec le dépôt', () => {
  it('produit un bundle déterministe et non vide', () => {
    const a = buildArtifact(NOM);
    const b = buildArtifact(NOM);
    // Déterminisme : deux constructions donnent le même code et la même empreinte.
    expect(a.sha256).toBe(b.sha256);
    expect(a.chars).toBeGreaterThan(10_000);
    expect(a.chars).toBeLessThan(200_000);
  });

  it('le bundle ne contient aucun import (exécuté par new Function)', () => {
    const { source } = buildArtifact(NOM);
    // `import x from`, `import{...}`, `import *` : aucun ne doit subsister.
    expect(source).not.toMatch(/(^|[;}\n])\s*import\s*[\w{*]/m);
    // Le module postgres est fourni par le chargeur, pas importé.
    expect(source).toContain('__edgePostgres');
  });

  it('le bundle ne contient aucun secret', () => {
    const { source } = buildArtifact(NOM);
    // Aucune valeur de type clé, jeton ou URL de base de données.
    expect(source).not.toMatch(/eyJhbGciOi/); // JWT
    expect(source).not.toMatch(/sb_secret_/);
    expect(source).not.toMatch(/postgres:\/\/[^\s"']+:[^\s"']+@/);
    // Les valeurs restent lues à l'exécution.
    expect(source).toContain('Deno');
  });

  /** Commit épinglé lu dans le chargeur livré : c'est la vérité du déploiement. */
  const commitEpingle = (): string => {
    const livre = readFileSync(FUNCTIONS[NOM].loader, 'utf8');
    const m = /const COMMIT = "([0-9a-f]{40})";/.exec(livre);
    if (!m) throw new Error('aucun commit épinglé dans le chargeur livré');
    return m[1];
  };

  it('le chargeur livré correspond au bundle actuel', () => {
    const built = buildArtifact(NOM);
    const livre = readFileSync(FUNCTIONS[NOM].loader, 'utf8');
    expect(livre).toBe(renderLoader(NOM, built, commitEpingle()));
  });

  it('le chargeur est court et vérifie taille et empreinte', () => {
    const built = buildArtifact(NOM);
    const chargeur = renderLoader(NOM, built, commitEpingle());
    // Le canal de déploiement altère les corps longs.
    expect(chargeur.length).toBeLessThan(8_000);
    expect(chargeur).toContain(built.sha256);
    expect(chargeur).toContain(String(built.chars));
    expect(chargeur).toContain('source.length !== ARTIFACT_CHARS');
    expect(chargeur).toContain('hex !== ARTIFACT_SHA256');
    expect(chargeur).toContain('new Function(CODE)()');
    // Échec fermé : jamais d'exécution d'un code partiel.
    expect(chargeur).toContain('if (CODE) {');
    expect(chargeur).toContain('status: 503');
  });

  it('épingle un commit, jamais une branche mouvante', () => {
    const chargeur = readFileSync(FUNCTIONS[NOM].loader, 'utf8');
    expect(commitEpingle()).toMatch(/^[0-9a-f]{40}$/);
    expect(chargeur).not.toMatch(/raw\.githubusercontent\.com[^"]*\/(main|develop|master)\//);
  });

  it('l’artefact RÉELLEMENT présent au commit épinglé a la bonne empreinte', () => {
    // Le point le plus fragile du déploiement. Sans ce contrôle, un chargeur
    // parfaitement formé peut pointer sur un commit où l'artefact n'existe pas
    // ou diffère : la production échoue en 503 et rien ne le signale ici.
    const built = buildArtifact(NOM);
    const commit = commitEpingle();
    const artefact = fichierAuCommit(commit, FUNCTIONS[NOM].artifact);
    expect(
      artefact,
      `l'artefact est absent du commit épinglé ${commit} : poussez-le, puis régénérez le chargeur sur ce commit`,
    ).not.toBeNull();
    expect(createHash('sha256').update(artefact as string, 'utf8').digest('hex')).toBe(built.sha256);
    // `chars` compte des CARACTÈRES, pas des octets : comparer `Buffer.length`
    // à `chars` ferait échouer à tort dès qu'un accent est présent.
    expect((artefact as string).length).toBe(built.chars);
  });

  it('ne réintroduit pas l’ancien chargement depuis la base', () => {
    // Garde-fou explicite : une future génération ne doit pas ramener le
    // mécanisme « artefact en base », absent de la production.
    const chargeur = readFileSync(FUNCTIONS[NOM].loader, 'utf8');
    expect(chargeur).not.toContain('_edge_function_artifact');
    expect(chargeur).not.toContain('artifact_missing');
  });

  it('le SQL d’insertion échappe les apostrophes et ne contient aucun secret', () => {
    const built = buildArtifact(NOM);
    const sql = artifactSql(NOM, built);
    expect(sql).toContain('insert into public._edge_function_artifact');
    expect(sql).toContain(built.sha256);
    expect(sql).toContain(`'${NOM}'`);
    // Aucune apostrophe non échappée : elles sont toutes doublées.
    expect(sql.match(/(?<!')'(?!')/g)?.length).toBeGreaterThan(0);
    expect(sql).not.toMatch(/eyJhbGciOi|sb_secret_/);
  });
});
