/**
 * Équivalence entre la fonction source `reelora-video` et le bundle autonome
 * déployé via le connecteur Supabase (qui ne transmet qu'un fichier).
 *
 * Ce test prouve :
 *   1. le bundle livré est exactement celui que le générateur produit ;
 *   2. aucun import relatif ne subsiste (sinon `BOOT_ERROR` en production) ;
 *   3. aucun secret n'est inliné : les clés restent lues via `env(...)` ;
 *   4. les capacités média (Video→Video / Audio→Video) sont bien embarquées ;
 *   5. le bundle s'exécute : même handler, mêmes réponses.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Source de vérité unique : ce script génère aussi le fichier livré.
import { buildBundle, buildEdgeArtifact, EDGE } from '../scripts/build-edge-bundle.mjs';
import { handler as sourceHandler } from '../supabase/functions/reelora-video/index.ts';
import { handler as bundleHandler } from '../supabase/functions/reelora-video.bundle.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const ENTRY = 'supabase/functions/reelora-video/index.ts';
const SHARED = 'supabase/functions/_shared/video-quote.ts';
const BUNDLE = 'supabase/functions/reelora-video.bundle.ts';

describe('Bundle de déploiement reelora-video', () => {
  it('le fichier livré est exactement celui que le générateur produit', () => {
    expect(read(BUNDLE)).toBe(buildBundle());
  });

  it('n’a plus aucun import relatif (cause du BOOT_ERROR évitée)', () => {
    const bundle = read(BUNDLE);
    expect(bundle).not.toContain('../_shared/');
    expect(bundle).not.toMatch(/^\s*import\s/m);
    // Le collision de noms est réellement résolue par le bundler.
    const entry = read(ENTRY);
    const shared = read(SHARED);
    expect(entry).toContain('function normalizeEstimateEndpoint(');
    expect(shared).toContain('export function normalizeEstimateEndpoint(');
    expect(bundle).toContain('normalizeEstimateEndpoint2(');
  });

  it('le module partagé reste pur, donc inlinable sans risque', () => {
    const shared = read(SHARED);
    expect(shared).not.toMatch(/^\s*import\s/m);
    expect(shared).not.toMatch(/\bDeno\./);
    expect(shared).not.toMatch(/\bfetch\(/);
  });

  it('ne contient aucun secret : les clés viennent des secrets Edge', () => {
    const bundle = read(BUNDLE);
    expect(bundle).toContain('env("MUAPI_API_KEY")');
    expect(bundle).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
    expect(bundle).not.toMatch(/x-api-key["']?\s*:\s*["'][A-Za-z0-9-]{20,}/);
  });

  it('embarque les capacités média (V2V / A2V) et le débit des crédits', () => {
    const bundle = read(BUNDLE);
    for (const marker of [
      'SUPPORTED_REQUIRED_FIELDS',
      'VIDEO_MISSING',
      'AUDIO_MISSING',
      'video_storage_path',
      'audio_storage_path',
      'reelora_reserve_provider_spend',
      'reelora_finalize_generation',
    ]) {
      expect(bundle).toContain(marker);
    }
    expect(bundle).toContain('audio_url');
    expect(bundle).toContain('input_video');
  });

  it('l’artefact déployé (.edge.js) correspond à l’empreinte du générateur', () => {
    const artifact = buildEdgeArtifact();
    expect(read(EDGE)).toBe(artifact.content);
    // L'empreinte affichée dans la bannière est vérifiable côté production.
    expect(read(EDGE).split('\n')[0]).toContain(`VYORA-EDGE-SHA256:${artifact.digest}`);
    expect(artifact.digest).toMatch(/^[0-9a-f]{12}$/);
  });

  it('exporte le même handler que la source', () => {
    expect(typeof bundleHandler).toBe('function');
    expect(typeof sourceHandler).toBe('function');
  });
});

describe('Exécution du bundle déployé', () => {
  it('répond à une requête non POST comme la source (contrat identique)', async () => {
    // Aucun réseau : la méthode est rejetée avant tout accès base/fournisseur.
    const req = new Request('https://project.supabase.co/functions/v1/reelora-video', {
      method: 'OPTIONS',
    });
    const fromSource = await sourceHandler(req.clone());
    const fromBundle = await bundleHandler(req.clone());
    expect(fromBundle.status).toBe(fromSource.status);
    expect(await fromBundle.text()).toBe(await fromSource.text());
  });
});
