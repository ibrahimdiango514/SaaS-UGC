import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FROZEN_ARTIFACT_MIGRATIONS,
  LOADER_TARGETS,
  SLICE_CHARS,
  buildBundle,
  republishGroup,
} from '../scripts/build-edge-loader.mjs';

/**
 * Republication des artefacts — décodage réel du fichier de migration.
 *
 * ## Pourquoi ce test existe
 * Une migration appliquée est immuable. Les deux publications d'origine
 * (`20261124110000`, `20261124110100`) portent l'ancien bundle ; les chargeurs
 * déployés en attendent un nouveau. La correctrice ne peut donc pas être de
 * réécrire l'ancien fichier — cela corrigerait le dépôt sans corriger la base,
 * et le chargeur échouerait sur `artifact_digest_mismatch`.
 *
 * La republication passe par une NOUVELLE migration, et ce test la vérifie comme
 * le fera Postgres puis le chargeur : il lit les tranches DANS LE FICHIER,
 * les recompose, décompresse le gzip et compare le texte obtenu à la taille et
 * au SHA-256 qu'attend chaque chargeur.
 *
 * ## Ce que ce test ne peut pas prouver
 * Rien sur le contenu réellement présent en base : aucun PostgreSQL n'est
 * disponible ici. Il prouve que la migration déposerait le bon contenu, pas
 * qu'elle a été appliquée.
 */

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');

/** Constantes attendues par un chargeur déployé, lues dans son source. */
function contratChargeur(slug: string): { chars: number; sha256: string } {
  const loader = readFileSync(join(ROOT, 'supabase/functions', slug, 'loader.ts'), 'utf8');
  const chars = /const CHARS = (\d+);/.exec(loader);
  const sha = /const SHA256 = "([0-9a-f]{64})";/.exec(loader);
  if (!chars || !sha) throw new Error(`contrat illisible dans le chargeur ${slug}`);
  return { chars: Number(chars[1]), sha256: sha[1] };
}

/** Tranches d'un artefact, telles qu'écrites dans le fichier SQL. */
function tranches(sql: string, slug: string): string[] {
  const motif = new RegExp(`\\('${slug}', (\\d+), '([A-Za-z0-9+/=]+)'\\)`, 'g');
  return [...sql.matchAll(motif)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((row) => row[2]);
}

/** Recompose puis décompresse, comme le chargeur en production. */
function decoder(sql: string, slug: string): string {
  const base64 = tranches(sql, slug).join('');
  return gunzipSync(Buffer.from(base64, 'base64')).toString('utf8');
}

const PUBLIES = Object.keys(LOADER_TARGETS).filter(
  (slug) => (LOADER_TARGETS[slug] as { republish?: boolean }).republish,
);

describe('Migrations déjà appliquées — intouchées', () => {
  it('les publications historiques restent figées, jamais régénérées', () => {
    for (const [slug, version] of Object.entries(FROZEN_ARTIFACT_MIGRATIONS)) {
      const chemin = join(MIGRATIONS, `${version}_${slug.replace(/-/g, '_')}_artifact.sql`);
      const sql = readFileSync(chemin, 'utf8');
      // L'ancien bundle doit toujours y être : la base l'a déjà appliqué, le
      // réécrire créerait un écart entre le dépôt et la base.
      const ancien = decoder(sql, slug);
      const attendu = contratChargeur(slug);
      expect(ancien.length).not.toBe(attendu.chars);
      expect(createHash('sha256').update(ancien, 'utf8').digest('hex')).not.toBe(attendu.sha256);
    }
  });

  it('aucune migration historique n’a été modifiée sur place', () => {
    // Deux artefacts partageant un numéro de migration ne doivent pas être
    // republiés DANS ce numéro : le fichier d'origine garde son ancien contenu.
    for (const slug of PUBLIES) {
      const version = (FROZEN_ARTIFACT_MIGRATIONS as Record<string, string>)[slug];
      expect(version).toBeTruthy();
      expect(LOADER_TARGETS[slug].migration).not.toBe(version);
      expect(LOADER_TARGETS[slug].migration > version).toBe(true);
    }
  });
});

describe('Nouvelle migration — ce que le chargeur lira réellement', () => {
  const groupe = republishGroup(PUBLIES[0]);
  const fichier = join(
    MIGRATIONS,
    `${LOADER_TARGETS[PUBLIES[0]].migration}_${groupe.map((s) => s.replace(/-/g, '_')).join('_et_')}_artifacts_republish.sql`,
  );
  const sql = readFileSync(fichier, 'utf8');

  it('supprime les tranches du nom avant de les réinsérer', () => {
    // Sans le `delete`, l'insertion violerait la clé (name, part) ou laisserait
    // d'anciennes tranches en surnombre.
    for (const slug of PUBLIES) {
      expect(sql).toContain(`delete from public._edge_function_artifact_slices where name = '${slug}';`);
      expect(sql).toContain(`insert into public._edge_function_artifact_slices(name, part, chunk)`);
    }
  });

  for (const slug of PUBLIES) {
    describe(slug, () => {
      const contrat = contratChargeur(slug);
      /*
       * Décodage PARESSEUX : appelé dans chaque test, jamais à la collecte.
       * Sinon une tranche corrompue fait échouer le chargement du fichier et le
       * rapport affiche « no tests » — un échec de collecte, pas un échec
       * lisible — au lieu de nommer le test en cause.
       */
      const brut = (): string => decoder(sql, slug);

      it('les tranches recomposées forment un gzip valide', () => {
        expect(() => brut()).not.toThrow();
      });

      it('produit la taille attendue par le chargeur', () => {
        expect(brut().length).toBe(contrat.chars);
      });

      it('produit le SHA-256 attendu par le chargeur', () => {
        expect(createHash('sha256').update(brut(), 'utf8').digest('hex')).toBe(contrat.sha256);
      });

      it('respecte les contrôles de longueur imposés (15576 / 14860)', () => {
        const base64 = tranches(sql, slug).join('');
        expect(base64.length).toBe(slug === 'vyora-ai' ? 15_576 : 14_860);
        // Le garde SQL intégré doit porter la même valeur : un écart entre le
        // test et la migration rendrait le test rassurant à tort.
        expect(sql).toContain(`length(assembled) <> ${base64.length}`);
        expect(sql).toContain(`length(assembled) <> ${base64.length} then`);
      });

      it('les tranches sont numérotées et bornées comme le chargeur le suppose', () => {
        const parts = tranches(sql, slug);
        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) expect(part.length).toBeLessThanOrEqual(SLICE_CHARS);
        // Le chargeur lit `order by part.asc` : une numérotation trouée
        // produirait une concaténation silencieusement fausse.
        const numeros = [...sql.matchAll(new RegExp(`\\('${slug}', (\\d+),`, 'g'))].map((m) => Number(m[1]));
        expect(numeros.sort((a, b) => a - b)).toEqual(numeros.map((_, i) => i));
      });

      it('le contenu publié est bien le bundle du dépôt', () => {
        // Ancrage final : si le code change sans republier, ce test échoue.
        expect(brut()).toBe(buildBundle(ROOT, slug).source);
      });
    });
  }

  it('ne touche ni vyora-provider-health ni vyora-mcp', () => {
    for (const slug of ['vyora-provider-health', 'vyora-mcp']) {
      expect(sql).not.toContain(`'${slug}'`);
    }
  });
});
