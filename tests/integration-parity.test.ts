import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * One single MuAPI integration, wired end-to-end. These tests guard the contract
 * between the Video Studio frontend, the committed Edge Function sources and the
 * Supabase config. They are pure source checks: no network, no secret, no job.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const video = read('supabase/functions/reelora-video/index.ts');
const worker = read('supabase/functions/reelora-video-worker/index.ts');
const config = read('supabase/config.toml');

describe('Une seule intégration MuAPI, de bout en bout', () => {
  it('déclare les quatre fonctions Studio, Business Grow, le bootstrap propriétaire et les trois fonctions de paiement', () => {
    const declared = [...config.matchAll(/^\[functions\.([a-z0-9-]+)\]/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual(['business-grow', 'reelora-health', 'reelora-owner-bootstrap', 'reelora-video', 'reelora-video-worker', 'studio-runtime', 'universal-catalog', 'vyora-ai', 'vyora-payments', 'vyora-payments-reconcile', 'vyora-provider-discovery', 'vyora-provider-health', 'vyora-saspay-webhook']);
    expect(config).toMatch(/\[functions\.business-grow\]\r?\nverify_jwt = true/);
    // Paiement : la fonction appelée par le navigateur exige un JWT.
    expect(config).toMatch(/\[functions\.vyora-payments\]\r?\nverify_jwt = true/);
  });

  it('la passerelle vidéo lit uniquement le secret serveur MUAPI_API_KEY', () => {
    expect(video).toContain('const MUAPI_KEY = () => env("MUAPI_API_KEY")');
    expect(video).toContain('"x-api-key"');
    expect(video).toContain('function redact(');
    expect(video).not.toContain('VITE_MUAPI');
    // The header comment legitimately states that legacy providers are NOT used.
    // What must be absent is any live reference to their endpoints or secrets.
    expect(video).not.toContain('HEYGEN_API_KEY');
    expect(video).not.toContain('FAL_KEY');
    expect(video).not.toContain('api.fal.ai');
  });

  it('le frontend envoie des chemins Storage privés que la passerelle sait signer', () => {
    // Le Studio immersif est l'entrée principale : c'est lui qui porte les
    // imports média (image, image finale, vidéo source, audio source).
    const studio = read('src/studio/GenerationStudio.tsx');
    for (const key of [
      'image_storage_path', 'last_image_storage_path', 'image_url', 'last_image_url',
      'video_storage_path', 'audio_storage_path', 'video_url', 'audio_url',
    ]) {
      expect(studio).toContain(key);
    }
    for (const marker of ['function workspaceImagePath(', 'async function signStoragePath(', 'lastImageUrl', 'LAST_IMAGE_MISSING']) {
      expect(video).toContain(marker);
    }
    // Les sources média sont assemblées puis transmises à `buildMuapiBody`.
    // Depuis les références multiples, l'appel porte aussi les images de
    // référence : le contrat vérifié est la présence de chaque source.
    expect(video).toMatch(/buildMuapiBody\(model, payload, prompt, imageUrl, lastImageUrl, \{[^}]*videoUrl[^}]*audioUrl[^}]*\}/);
    expect(video).toContain('imageUrls: extraImageUrls');
    // Aucune liste d'images n'est envoyée si le modèle ne la déclare pas.
    expect(video).toContain('for (const key of ["images_list", "image_urls", "reference_images"])');
    for (const marker of ['VIDEO_MISSING', 'AUDIO_MISSING', 'video_storage_path', 'audio_storage_path']) {
      expect(video).toContain(marker);
    }
  });

  it('le worker enrichit result_payload avec les métadonnées affichées par la bibliothèque', () => {
    for (const key of ['params', 'visual_prompt', 'mode', 'credits_reserved']) {
      expect(worker).toContain(`${key}:`);
    }
    expect(worker).not.toContain('model_id:');
    expect(worker).toContain('p_result_payload');
    // The library reads the metadata persisted by finalize_generation (which
    // originates from result_payload) and falls back on request_payload.
    const library = read('src/pages/Library.tsx');
    for (const marker of ['asset.metadata', 'request_payload', 'signedStorageUrl', 'paramsSummary']) {
      expect(library).toContain(marker);
    }
  });

  it('le catalogue et le devis restent dérivés de la base, sans endpoint inventé', () => {
    expect(video).toContain('reelora_video_models?active=eq.true');
    expect(video).toContain('/api/v1/models');
    expect(video).toContain('allowed.has(str(m.name, 120))');
    const quote = read('docs/devis-test-muapi.md');
    for (const value of ['désactivée', '110 %', 'opaque', '10 minutes', 'coût en crédits']) {
      expect(quote).toContain(value);
    }
    expect(quote).toContain("Aucun devis réel ni génération payante");
  });
});

describe('Passerelle IA unique : indisponibilité explicite, aucune simulation', () => {
  it('la passerelle centrale est la seule fonction IA et exige un JWT', () => {
    const config = read('supabase/config.toml');
    expect(config).toMatch(/\[functions\.vyora-ai\]\s*\nverify_jwt\s*=\s*true/);
    expect(config).not.toContain('[functions.reelora-ai]');
    const api = read('src/lib/api.ts');
    expect(api).toContain("invokeEdge<T>(edgeFunctionName('ai'), body)");
    expect(api).toContain("import { edgeFunctionName } from './platform-identity'");
    expect(api).not.toContain("'reelora-ai'");
  });

  it('une réponse vide est un échec remboursé, jamais un texte fabriqué', () => {
    const gateway = read('supabase/functions/vyora-ai/index.ts');
    expect(gateway).toContain('AI_EMPTY_RESPONSE');
    expect(gateway).toContain('await refund(quotaKind, projectId, userId)');
    expect(gateway).not.toContain('Plan UGC');
    expect(gateway).not.toContain('fallbackText');
    expect(gateway).not.toContain('Accroche face caméra');
  });

  it('le studio désactive l’aide IA et la documente quand le fournisseur central est absent', () => {
    const composer = read('src/studio/components/PromptComposer.tsx');
    expect(composer).toContain('disabled={!aiConfigured || busy !== null}');
    expect(composer).toContain('aiConfigured === false');
  });
});
