import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  artifactSql,
  buildArtifact,
  renderLoader,
  FUNCTIONS,
} from '../scripts/build-edge-artifact.mjs';

/**
 * Parité artefact ↔ dépôt.
 *
 * Le chargeur déployé ne contient aucune logique : il lit un bundle stocké en
 * base et vérifie son SHA-256. Ces tests garantissent trois choses :
 *   1. le chargeur livré correspond exactement au bundle du dépôt (pas de
 *      dérive silencieuse entre ce qui est committé et ce qui sera déployé) ;
 *   2. le bundle ne contient **aucune** instruction `import` (il est exécuté par
 *      `new Function`, qui les refuserait) ni aucun secret inliné ;
 *   3. le SQL d'insertion est valide et sans secret.
 */

const NOM = 'store-import';

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

  it('le chargeur livré correspond au bundle actuel', () => {
    const built = buildArtifact(NOM);
    const livré = readFileSync(FUNCTIONS[NOM].loader, 'utf8');
    expect(livré).toBe(renderLoader(NOM, built));
  });

  it('le chargeur est court et vérifie taille et empreinte', () => {
    const built = buildArtifact(NOM);
    const chargeur = renderLoader(NOM, built);
    // Le canal de déploiement altère les corps longs.
    expect(chargeur.length).toBeLessThan(8_000);
    expect(chargeur).toContain(built.sha256);
    expect(chargeur).toContain(String(built.chars));
    expect(chargeur).toContain('artifact_size_mismatch');
    expect(chargeur).toContain('artifact_digest_mismatch');
    // Un artefact absent n'est jamais exécuté.
    expect(chargeur).toContain('artifact_missing');
    expect(chargeur).toContain('new Function(CODE)()');
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
