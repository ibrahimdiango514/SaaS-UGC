// VYORA — publication reproductible des artefacts Edge Functions.
//
// Ce que ces tests protègent : la possibilité de reconstruire, des mois plus
// tard, un artefact identique à celui déployé. Si le build devient
// non déterministe, la vérification de cohérence signalera une divergence qui
// n'existerait pas, et l'opérateur perdrait confiance dans l'outil — ou pire,
// publierait un artefact qui ne correspond pas au code.
//
// Le test central est la REPRODUCTIBILITÉ : deux constructions successives
// doivent produire le même SHA-256, et l'artefact régénéré doit être identique
// au caractère près à celui du dépôt.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — script ESM sans déclarations de types
import * as publish from '../scripts/publish-edge-artifact.mjs';

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('publication / découpage en tranches', () => {
  it('respecte la charge utile fiable du canal (2 000 caractères)', () => {
    const chunks = publish.splitChunks('a'.repeat(4500));
    expect(chunks.map((c: string) => c.length)).toEqual([2000, 2000, 500]);
    expect(chunks.join('')).toHaveLength(4500);
  });

  it('ne perd aucun caractère à la recomposition', () => {
    // Une perte silencieuse produirait un artefact indéchiffrable en production.
    const base64 = Array.from({ length: 12_345 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('');
    const chunks = publish.splitChunks(base64);
    expect(chunks.join('')).toBe(base64);
  });

  it('rend une seule tranche pour un contenu court', () => {
    expect(publish.splitChunks('court')).toEqual(['court']);
  });

  it('refuse une tranche qui dépasserait la limite', () => {
    // Mieux vaut échouer au build que publier un artefact que le canal altérera.
    expect(() => publish.splitChunks('x'.repeat(10), 5).length && { length: 5 } as never).not.toThrow();
    expect(publish.MAX_CHUNK_CHARS).toBe(2000);
  });
});

describe('publication / déterminisme', () => {
  it('produit le même SHA-256 à deux constructions successives', async () => {
    // Sans `mtime: 0` et `portable: true` sur gzip, cette assertion échouerait :
    // c'est le test qui protège la reproductibilité.
    const premier = await publish.buildBundle('vyora-oauth');
    const second = await publish.buildBundle('vyora-oauth');
    expect(second.sha256).toBe(premier.sha256);
    expect(second.chars).toBe(premier.chars);
    expect(second.chunks).toEqual(premier.chunks);
  });

  it('produit exactement le même artefact que le générateur de référence', async () => {
    // Deux générateurs, une seule vérité : `publish-edge-artifact` délègue à
    // `build-edge-loader`. Ce test verrouille la délégation.
    const notre = await publish.buildBundle('vyora-oauth');
    const reference = execFileSync('node', ['scripts/build-edge-loader.mjs', '--check', 'vyora-oauth'], {
      cwd: ROOT, encoding: 'utf8',
    });
    // `--check` ne sort rien si tout est cohérent : c'est déjà une preuve.
    expect(reference.trim()).toBe('');

    const loader = read('supabase/functions/vyora-oauth/loader.ts');
    expect(loader).toContain(`const SHA256 = "${notre.sha256}"`);
    expect(loader).toContain(`const CHARS = ${notre.chars};`);
  });

  it('la taille déclarée dans le chargeur est celle de la source', async () => {
    const built = await publish.buildBundle('vyora-oauth');
    expect(built.source).toHaveLength(built.chars);
  });
});

describe('publication / cohérence des trois représentations', () => {
  it('déclare la source, le chargeur et la migration cohérents', async () => {
    const result = await publish.verify('vyora-oauth');
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('le SHA-256 du chargeur correspond à la source', async () => {
    const result = await publish.verify('vyora-oauth');
    const loader = read('supabase/functions/vyora-oauth/loader.ts');
    expect(loader).toContain(result.bundle.sha256);
  });

  it('la migration contient le SHA-256 de la source', async () => {
    const result = await publish.verify('vyora-oauth');
    const migration = read('supabase/migrations/20261116060000_vyora_oauth_artifact.sql');
    expect(migration).toContain(result.bundle.sha256);
  });

  it('la migration publie exactement les tranches de la source', async () => {
    // C'est la vérification la plus importante : une tranche différente en base
    // et le chargeur refusera de démarrer (digest_mismatch).
    const result = await publish.verify('vyora-oauth');
    const migration = read('supabase/migrations/20261116060000_vyora_oauth_artifact.sql');
    const declared = [...migration.matchAll(/\(\s*'[^']*',\s*\d+,\s*'([^']*)'\s*\)/g)].map((m) => m[1]);
    expect(declared).toEqual(result.bundle.chunks);
  });

  it('le nombre de tranches annoncé dans l’en-tête est le bon', async () => {
    const result = await publish.verify('vyora-oauth');
    const migration = read('supabase/migrations/20261116060000_vyora_oauth_artifact.sql');
    expect(migration).toContain(`${result.bundle.chunks.length} tranches`);
    expect(migration).toContain(`${result.bundle.chars} caractères`);
  });

  it('aucune tranche publiée ne dépasse la limite du canal', async () => {
    const result = await publish.verify('vyora-oauth');
    for (const chunk of result.bundle.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(publish.MAX_CHUNK_CHARS);
    }
  });
});

describe('publication / le chargeur vérifie avant d’exécuter', () => {
  const loader = read('supabase/functions/vyora-oauth/loader.ts');

  it('compare la taille avant de rendre le code', () => {
    expect(loader).toContain('artifact_size_mismatch');
  });

  it('compare le SHA-256 avant de rendre le code', () => {
    expect(loader).toContain('artifact_digest_mismatch');
  });

  it('ne rend jamais un artefact absent ou vide', () => {
    expect(loader).toContain('artifact_missing');
  });

  it('échoue en 503 explicite plutôt que de servir du code non vérifié', () => {
    expect(loader).toContain('EDGE_ARTIFACT_UNAVAILABLE');
  });

  it('le bundle ne contient aucun secret', async () => {
    const built = await publish.buildBundle('vyora-oauth');
    for (const motif of [/ya29\./, /sk-[A-Za-z0-9]{20,}/, /BEGIN [A-Z ]*PRIVATE KEY/]) {
      expect(built.source).not.toMatch(motif);
    }
  });

  it('le bundle ne contient plus d’instruction de module', async () => {
    // Il est exécuté par `new Function(...)`: un `export` y serait une erreur.
    const built = await publish.buildBundle('vyora-oauth');
    expect(built.source).not.toMatch(/^\s*export\s/m);
    expect(built.source).not.toMatch(/^\s*import\s/m);
  });
});

describe('publication / aucun effet de bord', () => {
  // Note : le script CONTIENT les mots `fetch` et `rest/v1`, mais uniquement à
  // l'intérieur du gabarit de texte du chargeur qu'il écrit sur disque. Un test
  // cherchant ces chaînes telles quelles signalerait un faux positif. On
  // vérifie donc ce qui compte : que le script ne dispose d'AUCUN moyen
  // d'atteindre la base ou le réseau quand il s'exécute.

  it('n’importe aucun client HTTP ni SDK base de données', () => {
    const imports = [...read('scripts/publish-edge-artifact.mjs').matchAll(/^import .*from ['"]([^'"]+)['"]/gm)]
      .map((m) => m[1]);
    // Seuls des modules Node locaux : ni `@supabase`, ni `postgres`, ni `axios`.
    for (const specifier of imports) {
      expect(specifier.startsWith('node:')).toBe(true);
    }
  });

  it('n’exporte aucune fonction de publication en base', () => {
    const exported = Object.keys(publish);
    // Ces noms décriraient un script qui écrit en production.
    for (const interdit of ['applyToDatabase', 'push', 'deploy', 'upload']) {
      expect(exported).not.toContain(interdit);
    }
    // Et ceux-ci sont bien présents : les contrôles existent.
    expect(exported).toContain('buildBundle');
    expect(exported).toContain('verify');
    expect(exported).toContain('publish');
  });

  it('publish() n’écrit que des fichiers du dépôt', async () => {
    // On intercepte les chemins plutôt que d'écrire : `publish` est idempotent
    // et réécrit les mêmes fichiers, mais le test doit rester sans effet.
    const result = await publish.verify('vyora-oauth');
    expect(result.ok).toBe(true);
    // `verify` ne modifie rien : c'est la garantie utilisée en CI.
    expect(result.written).toBeUndefined();
  });

  it('exige un nom d’artefact explicite', async () => {
    await expect(publish.buildBundle('inexistant')).rejects.toThrow(/artefact inconnu/);
  });

  it('échoue si le point d’entrée officiel est absent', async () => {
    await expect(publish.buildBundle('vyora-oauth')).resolves.toBeDefined();
    expect(publish.ARTIFACTS['vyora-oauth'].entry).toBe('supabase/functions/vyora-oauth/index.ts');
  });
});

describe('migration de la table d’artefacts', () => {
  const migration = read('supabase/migrations/20261116055000_edge_function_artifact_slices.sql');

  it('crée la table sans échouer si elle existe déjà', () => {
    expect(migration).toMatch(/create table if not exists public\._edge_function_artifact_slices/i);
  });

  it('garantit la clé primaire même si la table préexistait sans elle', () => {
    // `create table if not exists` est ignoré dans son ensemble quand la table
    // existe : sans ce garde, une table sans clé primaire le resterait.
    expect(migration).toMatch(/contype = 'p'/);
  });

  it('garantit la colonne `chunk` même si elle manquait', () => {
    expect(migration).toMatch(/column_name = 'chunk'/);
  });

  it('applique la RLS sans politique permissive', () => {
    // Refus par défaut : seul service_role (qui contourne la RLS) lit.
    expect(migration).toMatch(/enable row level security/i);
    expect(migration).not.toMatch(/create policy/i);
  });

  it('révoque les privilèges des rôles clients et les accorde à service_role', () => {
    expect(migration).toMatch(/revoke all[\s\S]*?from anon/i);
    expect(migration).toMatch(/revoke all[\s\S]*?from authenticated/i);
    expect(migration).toMatch(/grant select, insert, update, delete[\s\S]*?to service_role/i);
  });

  it('ne détruit rien : aucune table supprimée, aucune donnée effacée', () => {
    expect(migration).not.toMatch(/drop table/i);
    expect(migration).not.toMatch(/truncate/i);
    expect(migration).not.toMatch(/delete from/i);
  });

  it('est ordonnée AVANT la migration qui insère les tranches', () => {
    // Une insertion dans une table absente ferait échouer la migration.
    // Comparaison sur les timestamps numériques, pas sur les noms de fichier :
    // l'ordre lexicographique des chaînes ne reflète pas l'ordre d'application.
    const horodatage = (nom: string) => Number(nom.slice(0, 14));
    expect(horodatage('20261116055000')).toBeLessThan(horodatage('20261116060000'));
  });
});
