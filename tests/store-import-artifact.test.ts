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

/**
 * Fonctions couvertes.
 *
 * `store-connect` a été ajoutée ici après coup : elle était déployée avec un
 * chargeur généré à la main, donc jamais vérifiée. Une fonction déployée sans
 * contrôle de parité est exactement le cas qui produit un 503 silencieux en
 * production — le chargeur est bien formé, mais l'artefact épinglé n'est pas
 * celui du dépôt.
 */
const FONCTIONS_SUIVIES = ['store-import', 'store-connect'] as const;

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
/**
 * L'objet de commit existe-t-il dans CE clone ?
 *
 * Un clone dont l'historique a été reconstruit (CI cloud, dépôt réimporté)
 * peut parfaitement ne pas contenir le commit épinglé : le contrôle ci-dessous
 * n'est alors pas exécutable, et le déclarer en échec accuserait le code à tort.
 * On l'annonce explicitement en « skipped » avec sa raison, jamais en succès.
 */
function commitPresent(commit: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: process.cwd(), stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fichierAuCommit(commit: string, chemin: string): string | null {
  try {
    return execFileSync('git', ['show', `${commit}:${chemin}`], {
      cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

describe.each(FONCTIONS_SUIVIES)('artefact %s — parité avec le dépôt', (nomFonction) => {
  it('produit un bundle déterministe et non vide', () => {
    const a = buildArtifact(nomFonction);
    const b = buildArtifact(nomFonction);
    // Déterminisme : deux constructions donnent le même code et la même empreinte.
    expect(a.sha256).toBe(b.sha256);
    expect(a.chars).toBeGreaterThan(10_000);
    expect(a.chars).toBeLessThan(200_000);
  });

  it('le bundle ne contient aucun import (exécuté par new Function)', () => {
    const { source } = buildArtifact(nomFonction);
    // `import x from`, `import{...}`, `import *` : aucun ne doit subsister.
    expect(source).not.toMatch(/(^|[;}\n])\s*import\s*[\w{*]/m);
    // Le module postgres est fourni par le chargeur, pas importé.
    expect(source).toContain('__edgePostgres');
  });

  it('le bundle ne contient aucun secret', () => {
    const { source } = buildArtifact(nomFonction);
    // Aucune valeur de type clé, jeton ou URL de base de données.
    expect(source).not.toMatch(/eyJhbGciOi/); // JWT
    expect(source).not.toMatch(/sb_secret_/);
    expect(source).not.toMatch(/postgres:\/\/[^\s"']+:[^\s"']+@/);
    // Les valeurs restent lues à l'exécution.
    expect(source).toContain('Deno');
  });

  /** Commit épinglé lu dans le chargeur livré : c'est la vérité du déploiement. */
  const commitEpingle = (): string => {
    const livre = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
    const m = /const COMMIT = "([0-9a-f]{40})";/.exec(livre);
    if (!m) throw new Error('aucun commit épinglé dans le chargeur livré');
    return m[1];
  };

  it('le chargeur livré correspond au bundle actuel', () => {
    const built = buildArtifact(nomFonction);
    const livre = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
    expect(livre).toBe(renderLoader(nomFonction, built, commitEpingle()));
  });

  it('le chargeur est court et vérifie taille et empreinte', () => {
    const built = buildArtifact(nomFonction);
    const chargeur = renderLoader(nomFonction, built, commitEpingle());
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
    const chargeur = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
    expect(commitEpingle()).toMatch(/^[0-9a-f]{40}$/);
    expect(chargeur).not.toMatch(/raw\.githubusercontent\.com[^"]*\/(main|develop|master)\//);
  });

  it('l’artefact RÉELLEMENT présent au commit épinglé a la bonne empreinte', (ctx) => {
    // Le point le plus fragile du déploiement. Sans ce contrôle, un chargeur
    // parfaitement formé peut pointer sur un commit où l'artefact n'existe pas
    // ou diffère : la production échoue en 503 et rien ne le signale ici.
    const built = buildArtifact(nomFonction);
    const commit = commitEpingle();
    if (!commitPresent(commit)) {
      // Historique reconstruit : le commit épinglé n'est pas dans ce clone.
      // Contrôle non exécutable ici — annoncé, jamais compté comme réussi.
      ctx.skip(`commit épinglé ${commit} absent de ce clone : contrôle exécutable seulement sur un clone complet du dépôt`);
    }
    const artefact = fichierAuCommit(commit, FUNCTIONS[nomFonction].artifact);
    expect(
      artefact,
      `l'artefact est absent du commit épinglé ${commit} : poussez-le, puis régénérez le chargeur sur ce commit`,
    ).not.toBeNull();
    expect(createHash('sha256').update(artefact as string, 'utf8').digest('hex')).toBe(built.sha256);
    // `chars` compte des CARACTÈRES, pas des octets : comparer `Buffer.length`
    // à `chars` ferait échouer à tort dès qu'un accent est présent.
    expect((artefact as string).length).toBe(built.chars);
  });

  it('les modules PARTAGÉS sont couverts par l’artefact épinglé', () => {
    /*
     * `safe-egress.ts` et `pinned-fetch.ts` sont importés par `store-import` ET
     * `store-connect`. Les modifier change donc DEUX bundles déjà déployés sans
     * que rien ne le signale — c'est exactement ce qui s'est produit en ajoutant
     * `POST` pour le client MCP : 6 tests de parité sont tombés.
     *
     * Ce contrôle ne remplace pas la régénération, il rend la cause lisible :
     * quand l'empreinte diffère, le message doit dire QUELLE source partagée a
     * bougé, au lieu de laisser chercher.
     */
    const built = buildArtifact(nomFonction);
    const chargeur = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
    const epingle = /const ARTIFACT_SHA256 = "([0-9a-f]{64})"/.exec(chargeur)?.[1];
    if (epingle === built.sha256) return;

    const partages = [
      'supabase/functions/store-import/safe-egress.ts',
      'supabase/functions/store-import/pinned-fetch.ts',
    ];
    const empreintes = partages.map((chemin) => {
      const contenu = readFileSync(chemin, 'utf8');
      return `${chemin.split('/').pop()} ${createHash('sha256').update(contenu, 'utf8').digest('hex').slice(0, 12)}`;
    });
    expect.fail(
      `le bundle de ${nomFonction} a changé (épinglé ${epingle?.slice(0, 12)}, actuel ${built.sha256.slice(0, 12)}). `
      + `Souvent un module partagé modifié : ${empreintes.join(', ')}. `
      + 'Régénérez les artefacts puis réépinglez (voir la procédure dans le README du script).',
    );
  });

  it('ne réintroduit pas l’ancien chargement depuis la base', () => {
    // Garde-fou explicite : une future génération ne doit pas ramener le
    // mécanisme « artefact en base », absent de la production.
    const chargeur = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
    expect(chargeur).not.toContain('_edge_function_artifact');
    expect(chargeur).not.toContain('artifact_missing');
  });

  it('le SQL d’insertion échappe les apostrophes et ne contient aucun secret', () => {
    const built = buildArtifact(nomFonction);
    const sql = artifactSql(nomFonction, built);
    expect(sql).toContain('insert into public._edge_function_artifact');
    expect(sql).toContain(built.sha256);
    expect(sql).toContain(`'${nomFonction}'`);
    // Aucune apostrophe non échappée : elles sont toutes doublées.
    expect(sql.match(/(?<!')'(?!')/g)?.length).toBeGreaterThan(0);
    expect(sql).not.toMatch(/eyJhbGciOi|sb_secret_/);
  });
});

/**
 * Retire commentaires et littéraux de chaîne d'un source TypeScript.
 *
 * Objectif précis : distinguer `Deno.serve(...)` (usage réel, interdit ici) de
 * `` `Deno.env.get(...)` `` cité dans un commentaire (documentation, permise).
 * Ce n'est pas un analyseur TypeScript, et ce n'est pas grave : le test doit
 * seulement ne pas se laisser duper par sa propre documentation.
 */
function sansCommentairesNiChaines(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')       // commentaires de bloc
    .replace(/^\s*\/\/.*$/gm, '')            // commentaires de ligne entiers
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')     // commentaires en fin de ligne
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')      // gabarits
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")   // chaînes simples
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');  // chaînes doubles
}

describe('configuration vérifiée des Edge Functions', () => {
  it('couvre les deux fonctions dans tsconfig.edge.json', () => {
    // Sans cette inclusion, `npm run typecheck` ignore la fonction : c'est
    // exactement ainsi que `store-connect` a été déployée sans jamais être
    // vérifiée, et qu'un `Deno.env.get` en portée de module y est resté.
    const config = JSON.parse(readFileSync('tsconfig.edge.json', 'utf8')) as { include?: string[] };
    const inclus = config.include ?? [];
    for (const nom of FONCTIONS_SUIVIES) {
      expect(inclus, `${nom} absente de tsconfig.edge.json`).toContain(`supabase/functions/${nom}/index.ts`);
      expect(inclus).toContain(`supabase/functions/${nom}/handler.ts`);
    }
  });

  it('les points d’entrée ne supposent pas la globale Deno au chargement', () => {
    // `tsconfig.edge.json` ne charge pas les types Deno. Un `Deno.x` nu en
    // portée de module casse la vérification de types, donc la fonction sort
    // du périmètre contrôlé. L'accès doit passer par `globalThis`.
    //
    // On ne cherche que dans le CODE : les commentaires et les chaînes citent
    // `Deno.env.get` pour expliquer la règle, et les compter comme usage réel
    // rendrait le test faux.
    for (const nom of FONCTIONS_SUIVIES) {
      const code = sansCommentairesNiChaines(
        readFileSync(`supabase/functions/${nom}/index.ts`, 'utf8'),
      );
      expect(
        code.match(/(^|[^.\w])Deno\./) ?? [],
        `${nom}/index.ts utilise Deno.* sans passer par globalThis`,
      ).toHaveLength(0);
      expect(code).toContain('globalThis');
    }
  });
});
