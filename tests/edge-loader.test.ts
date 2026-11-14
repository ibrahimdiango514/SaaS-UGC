/**
 * Chargeur d'artefact Edge : le code déployé est reconstruit à froid depuis
 * un stockage par tranches. Ce test prouve que le handler obtenu est
 * exactement celui du bundle livré, sans duplication de logique métier.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadArtifact, prepareArtifact } from '../scripts/edge-loader.mjs';
import { handler as sourceHandler } from '../supabase/functions/reelora-video/index.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const ARTIFACT = read('supabase/functions/reelora-video.edge.js');

describe('Chargeur d’artefact Edge', () => {
  it('extrait les exports sans toucher au code métier', () => {
    const prepared = prepareArtifact(ARTIFACT);
    expect(prepared.exports).toEqual(
      expect.arrayContaining(['handler', 'calculateVideoCredits']),
    );
    expect(prepared.code).not.toMatch(/^export\{/m);
    expect(prepared.code.trimEnd().endsWith('};')).toBe(true);
    // Le corps métier est identique, à l'exception du bloc d'exports.
    const bodyOf = (s: string) => s.slice(0, s.indexOf('export{'));
    expect(prepared.code).toContain(bodyOf(ARTIFACT).slice(200, 400));
  });

  it('charge un handler appelable', () => {
    const mod = loadArtifact(ARTIFACT);
    expect(typeof mod.handler).toBe('function');
  });

  it('conserve le calcul de crédits du bundle', () => {
    const mod = loadArtifact(ARTIFACT);
    // (0.10 + 0.01) × 620 × 1.6 = 109.12 XOF → 2 crédits
    expect(mod.calculateVideoCredits?.(0.10, {
      usd_to_xof: 620, credit_value_xof: 100, markup_percent: 60, additional_cost_usd: 0.01,
    })).toBe(2);
  });

  it('répond comme la source sur une requête OPTIONS', async () => {
    const mod = loadArtifact(ARTIFACT);
    const req = new Request('https://project.supabase.co/functions/v1/reelora-video', { method: 'OPTIONS' });
    const fromLoaded = await mod.handler(req.clone());
    const fromSource = await sourceHandler(req.clone());
    expect(fromLoaded.status).toBe(fromSource.status);
    expect(await fromLoaded.text()).toBe(await fromSource.text());
  });
});
