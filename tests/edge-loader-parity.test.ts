// SORAHNEX — parité des chargeurs Edge publiés par tranches.
//
// Le canal de déploiement altère les sources longues : `vyora-ai`,
// `vyora-ai-providers` et `vyora-provider-health` sont donc livrés par un
// chargeur court qui recompose des tranches gzip+base64 et vérifie le SHA-256
// avant exécution. Ces tests garantissent que :
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
  renderRepublishSql,
  renderSeedSql,
  republishGroup,
  sqlLiteral,
} from '../scripts/build-edge-loader.mjs';

const ROOT = join(__dirname, '..');
const slugs = Object.keys(LOADER_TARGETS);

/** Chemin de la migration qui publie réellement cet artefact. */
function cheminMigration(slug: string): string {
  const { migration, republish } = LOADER_TARGETS[slug] as { migration: string; republish?: boolean };
  if (!republish) {
    return join(ROOT, 'supabase/migrations', `${migration}_${slug.replace(/-/g, '_')}_artifact.sql`);
  }
  // Publication groupée : un fichier porte plusieurs artefacts.
  const groupe = republishGroup(slug);
  return join(
    ROOT,
    'supabase/migrations',
    `${migration}_${groupe.map((s) => s.replace(/-/g, '_')).join('_et_')}_artifacts_republish.sql`,
  );
}

/** Extrait les tranches d'un fichier SQL de publication. */
function slicesFromSql(sql: string, slug: string): string {
  const rows = [...sql.matchAll(new RegExp(`\\('${slug}', (\\d+), '([A-Za-z0-9+/=]+)'\\)`, 'g'))];
  return rows
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((row) => row[2])
    .join('');
}

/*
 * Délai explicite : ces tests lancent esbuild puis décompressent des artefacts.
 * La valeur par défaut de 5 s suffisait en local mais pas sous charge CI, d'où
 * des échecs intermittents sur une machine aléatoirement lente.
 */
describe('chargeurs Edge — parité générateur / dépôt', { timeout: 30_000 }, () => {
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
      const sql = readFileSync(cheminMigration(slug), 'utf8');
      if ((LOADER_TARGETS[slug] as { republish?: boolean }).republish) {
        // Fichier groupé : on compare le fichier ENTIER à sa composition, sinon
        // une tranche d'un autre artefact pourrait y dériver sans être vue.
        const groupe = republishGroup(slug);
        expect(sql).toBe(
          renderRepublishSql(groupe.map((s) => ({ slug: s, built: buildBundle(ROOT, s) }))),
        );
      } else {
        expect(sql).toBe(renderSeedSql(slug, built));
      }
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

describe('chargeurs Edge — garde-fous du contrat de déploiement', { timeout: 30_000 }, () => {
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
      const sql = readFileSync(cheminMigration(slug), 'utf8');
      // Le SQL ne contient que des tranches base64 + une empreinte.
      expect(/sk-[A-Za-z0-9]|gnk-|cfut_|Bearer [A-Za-z0-9]{8,}/.test(sql)).toBe(false);
    }
  });
});
