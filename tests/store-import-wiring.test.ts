import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { buildArtifact } from '../scripts/build-edge-artifact.mjs';

/**
 * Câblage de l'Edge Function `store-import`.
 *
 * ## Le défaut que ces tests empêchent de revenir
 * `index.ts` appelait `importFile` sans l'importer. Aucun test ne pouvait le
 * voir : `tsconfig.json` ne couvrait que `src/` et `tests/`, donc les Edge
 * Functions n'étaient jamais vérifiées, et le bundle se construisait sans
 * broncher (esbuild laisse un identifiant libre tel quel). Le résultat, mesuré
 * en production : tout import de fichier répondait **500
 * `STORE_IMPORT_BACKEND_ERROR`**, et un `ReferenceError: importFile is not
 * defined` restait dans les journaux.
 *
 * Ces tests portent sur le bundle réellement exécuté, pas sur la source : c'est
 * le bundle qui tourne, et c'est lui qui portait le défaut.
 */

const BUNDLE = buildArtifact('store-import');

describe('câblage du bundle store-import', () => {
  it('contient l’analyseur de fichier, et non un identifiant libre', () => {
    // `importFile` doit être défini DANS le bundle : une fonction déclarée
    // localement par esbuild, pas une variable globale supposée exister.
    const defini = /function\s+importFile\s*\(/.test(BUNDLE.source)
      || /importFile\s*=\s*(?:async\s*)?(?:function|\()/.test(BUNDLE.source)
      || /(?:const|let|var)\s+importFile\s*=/.test(BUNDLE.source);
    expect(defini).toBe(true);
  });

  it('n’appelle aucun identifiant laissé libre par un import manquant', () => {
    // Les noms du parseur doivent tous être présents : s'il en manque un, le
    // bundle a été construit sur une source dont l'import a été oublié.
    const attendus = ['importFile', 'importDelimited', 'importXlsx'];
    for (const nom of attendus) {
      const declare = new RegExp(`(?:function\\s+${nom}\\s*\\(|(?:const|let|var)\\s+${nom}\\s*=)`).test(BUNDLE.source);
      const appele = new RegExp(`\\b${nom}\\s*\\(`).test(BUNDLE.source);
      if (appele) expect(declare, `${nom} est appelé sans être déclaré`).toBe(true);
    }
  });

  it('applique l’exposant de devise correct au prix écrit', () => {
    // Le prix était calculé avec `produit.currencyExponent`, propriété
    // inexistante : la division se rabattait sur /100 et écrivait 12 000 XOF
    // comme 120. Le bundle doit passer par `minorToDecimal`.
    expect(BUNDLE.source).toContain('minorToDecimal');
    expect(BUNDLE.source).not.toContain('currencyExponent');
  });

  it('garde la vérification d’abonnement dans le bundle exécuté', () => {
    expect(BUNDLE.source).toContain('BUSINESS_GROW_SUBSCRIPTION_REQUIRED');
    expect(BUNDLE.source).toContain('checkImportAccess');
  });
});

describe('configuration de vérification des Edge Functions', () => {
  it('couvre store-import par un tsconfig dédié', () => {
    // Sans ce fichier, `npm run typecheck` ne voit pas les Edge Functions :
    // c'est exactement ce trou qui a laissé passer l'import manquant.
    expect(existsSync('tsconfig.edge.json')).toBe(true);
    const config = JSON.parse(readFileSync('tsconfig.edge.json', 'utf8')) as {
      include?: string[];
    };
    expect(config.include ?? []).toContain('supabase/functions/store-import/index.ts');
  });

  it('déclare le module npm: pour que TypeScript puisse résoudre postgres', () => {
    expect(existsSync('supabase/functions/types/npm-postgres.d.ts')).toBe(true);
  });
});
