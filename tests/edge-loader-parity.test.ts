// VYORA — parité des chargeurs Edge publiés par tranches.
//
// Le canal de déploiement altère les sources longues : `vyora-ai`,
// `vyora-ai-providers`, `vyora-provider-health` et désormais `vyora-mcp` sont
// livrés par un chargeur court qui recompose des tranches gzip+base64 et vérifie
// le SHA-256 avant exécution. Ces tests garantissent que :
//   * le chargeur committé est EXACTEMENT celui que le générateur produit ;
//   * la migration de publication contient les tranches exactes du bundle ;
//   * le chargeur refuse un artefact dont l'empreinte ne correspond pas.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOADER_TARGETS,
  SLICES_TABLE,
  buildBundle,
  renderLoader,
  renderSeedSql,
  sqlLiteral,
} from '../scripts/build-edge-loader.mjs';

const ROOT = join(__dirname, '..');
const slugs = Object.keys(LOADER_TARGETS);

/** Extrait les tranches d'un fichier SQL de publication. */
function slicesFromSql(sql: string, slug: string): string {
  const rows = [...sql.matchAll(new RegExp(`\\('${slug}', (\\d+), '([A-Za-z0-9+/=]+)'\\)`, 'g'))];
  return rows
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((row) => row[2])
    .join('');
}

describe('chargeurs Edge — parité générateur / dépôt', () => {
  for (const slug of slugs) {
    it(`${slug} : chargeur et bundle identiques au générateur`, () => {
      const built = buildBundle(ROOT, slug);
      const loader = readFileSync(join(ROOT, 'supabase/functions', slug, 'loader.ts'), 'utf8');
      const edge = readFileSync(join(ROOT, 'supabase/functions', `${slug}.edge.js`), 'utf8');
      expect(loader).toBe(renderLoader(slug, built));
      expect(edge).toBe(built.source);
    });

    it(`${slug} : la migration publie exactement le bundle déployé`, () => {
      const built = buildBundle(ROOT, slug);
      const migrationPath = join(
        ROOT,
        'supabase/migrations',
        `${LOADER_TARGETS[slug].migration}_${slug.replace(/-/g, '_')}_artifact.sql`,
      );
      const sql = readFileSync(migrationPath, 'utf8');

      // Exception documentée : `vyora-oauth` ne publie plus d'artefact ici.
      //
      // Cette branche livrait le bundle d'origine, sans vérification de
      // l'identité de l'appelant. La version corrigée est publiée par la
      // PR #12 (`20261116060000`), avec une épingle de publication. Republier
      // depuis cette branche ferait doublon et rouvrirait la course entre les
      // deux migrations. La migration est donc devenue un no-op documenté.
      //
      // Ce test vérifie donc l'absence de publication, pas son contenu.
      if (slug === 'vyora-oauth') {
        expect(sql).not.toMatch(/insert into public\._edge_function_artifact_slices/);
        expect(sql).not.toMatch(/delete from public\._edge_function_artifact_slices/);
        expect(sql).toContain('publication RETIRÉE');
        expect(slicesFromSql(sql, slug)).toBe('');
        return;
      }

      expect(sql).toBe(renderSeedSql(slug, built));
      // Les tranches se recomposent en un gzip valide dont le contenu est le
      // bundle exact : le SHA-256 du chargeur est donc vérifiable en production.
      const assembled = slicesFromSql(sql, slug);
      expect(assembled).toBe(built.base64);
      const source = gunzipSync(Buffer.from(assembled, 'base64')).toString('utf8');
      expect(source).toBe(built.source);
      expect(createHash('sha256').update(source, 'utf8').digest('hex')).toBe(built.sha256);
    });
  }
});

describe('chargeurs Edge — garde-fous du contrat de déploiement', () => {
  it('le chargeur est court (le canal n’altère que les sources longues)', () => {
    for (const slug of slugs) {
      const loader = readFileSync(join(ROOT, 'supabase/functions', slug, 'loader.ts'), 'utf8');
      expect(loader.length).toBeLessThan(5_000);
      // Aucun import : le chargeur doit démarrer même sans dépendance externe.
      expect(/^\s*import\s/m.test(loader)).toBe(false);
      expect(loader).toContain(SLICES_TABLE);
    }
  });

  it('le chargeur vérifie la taille ET le SHA-256 avant exécution', () => {
    for (const slug of slugs) {
      const loader = readFileSync(join(ROOT, 'supabase/functions', slug, 'loader.ts'), 'utf8');
      expect(loader).toContain('artifact_size_mismatch');
      expect(loader).toContain('artifact_digest_mismatch');
      expect(loader).toContain('DecompressionStream("gzip")');
      // Le code n'est exécuté qu'après vérification : `new Function` est dans la
      // branche `CODE` non vide, après lecture contrôlée.
      expect(loader.indexOf('new Function(CODE)')).toBeGreaterThan(loader.indexOf('artifact_digest_mismatch'));
    }
  });

  it('aucune tranche ne dépasse la charge fiable du canal (2 000 caractères)', () => {
    for (const slug of slugs) {
      const built = buildBundle(ROOT, slug);
      for (const slice of built.slices) expect(slice.length).toBeLessThanOrEqual(2_000);
    }
  });

  it('la publication vérifie les tranches réellement écrites (pas une constante)', () => {
    for (const slug of slugs) {
      const built = buildBundle(ROOT, slug);
      const sql = renderSeedSql(slug, built);
      // Le garde recompose la concaténation en base et compare l'empreinte des
      // tranches : une tranche altérée en transit annule la transaction.
      expect(sql).toContain('string_agg(chunk, \'\' order by part)');
      expect(sql).toContain(sqlLiteral(built.base64Md5));
      expect(sql).toContain(`parts <> ${built.slices.length}`);
      expect(sql).toContain(`length(assembled) <> ${built.base64.length}`);
      // La tranche au-delà de 2 000 caractères est refusée à la publication.
      expect(sql).toContain('length(chunk) > 2');
      // Pas de `on conflict (name)` : la clé de l'empreinte est (name, sha256).
      expect(sql).not.toMatch(/on conflict \(name\)/);
    }
  });

  it('l’empreinte des tranches publiée correspond au base64 du bundle', () => {
    for (const slug of slugs) {
      const built = buildBundle(ROOT, slug);
      expect(createHash('md5').update(built.base64, 'utf8').digest('hex')).toBe(built.base64Md5);
      expect(built.slices.join('')).toBe(built.base64);
    }
  });

  it('aucun secret n’est écrit dans un artifact publié', () => {
    for (const slug of slugs) {
      const migrationPath = join(
        ROOT,
        'supabase/migrations',
        `${LOADER_TARGETS[slug].migration}_${slug.replace(/-/g, '_')}_artifact.sql`,
      );
      const sql = readFileSync(migrationPath, 'utf8');
      // Le SQL ne contient que des tranches base64 + une empreinte.
      expect(/sk-[A-Za-z0-9]|gnk-|cfut_|Bearer [A-Za-z0-9]{8,}/.test(sql)).toBe(false);
    }
  });
});

describe('chargeurs Edge — la publication obsolète de vyora-oauth est neutralisée', () => {
  const chemin = join(ROOT, 'supabase/migrations', '20261116040000_vyora_oauth_artifact.sql');

  it('la migration ne publie plus aucun artefact', () => {
    const sql = readFileSync(chemin, 'utf8');
    expect(sql).not.toMatch(/^\s*delete from public\._edge_function_artifact_slices/m);
    expect(sql).not.toMatch(/^\s*insert into public\._edge_function_artifact_slices/m);
  });

  it('aucune donnée de bundle ne subsiste dans le fichier', () => {
    // Le base64 du bundle vulnérable ne doit pas rester : même inutilisé, il
    // constituerait une source de republication accidentelle.
    const sql = readFileSync(chemin, 'utf8');
    expect(sql).not.toContain('H4sIA');
    expect(sql).not.toMatch(/\('[A-Za-z0-9+/=]{200,}'\)/);
  });

  it('le SHA-256 vulnérable ne figure que dans le commentaire explicatif', () => {
    const sql = readFileSync(chemin, 'utf8');
    const lignes = sql.split('\n').filter((l) => l.includes('4a3f6206'));
    expect(lignes.length).toBeGreaterThan(0);
    for (const ligne of lignes) expect(ligne.trim().startsWith('--')).toBe(true);
  });

  it('la migration tolère l’absence du manifeste (cas où #10 passe avant #12)', () => {
    const sql = readFileSync(chemin, 'utf8');
    expect(sql).toContain("to_regclass('public._edge_function_artifact_manifest')");
  });

  it('la migration lève si l’épingle est inattendue', () => {
    const sql = readFileSync(chemin, 'utf8');
    expect(sql).toMatch(/raise exception/);
  });
});
