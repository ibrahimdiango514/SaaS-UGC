/**
 * Capacités média du Studio : import vidéo / audio, transmission au devis et à
 * la génération, et absence de verrous trompeurs dans la navigation.
 *
 * Ces tests sont statiques : ils garantissent que la connexion frontend →
 * backend existe réellement et qu'aucune capacité opérationnelle n'est
 * présentée comme verrouillée. Ils ne déclenchent aucun appel fournisseur.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREATION_MODES } from '../src/studio/plan';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const STUDIO = read('src/studio/GenerationStudio.tsx');
const PROMPT_BAR = read('src/studio/components/PromptBar.tsx');
const TOP_BAR = read('src/studio/components/StudioTopBar.tsx');
const EDGE = read('supabase/functions/reelora-video/index.ts');
const API = read('src/lib/api.ts');

describe('Sources média (Video→Video, Audio→Video)', () => {
  it('déclare les modes adossés à une capacité réelle du catalogue', () => {
    const ids = CREATION_MODES.map((m) => m.id);
    expect(ids).toContain('video-source');
    expect(ids).toContain('audio-source');
    expect(CREATION_MODES.find((m) => m.id === 'video-source')?.mode).toBe('video-to-video');
    expect(CREATION_MODES.find((m) => m.id === 'audio-source')?.mode).toBe('audio-to-video');
  });

  it('importe la vidéo et l’audio dans le bucket privé du workspace', () => {
    expect(PROMPT_BAR).toContain('sourceVideoFile');
    expect(PROMPT_BAR).toContain('sourceAudioFile');
    // Le contrôle d'import n'apparaît que si le modèle déclare le champ.
    expect(PROMPT_BAR).toContain('modelAcceptsVideo');
    expect(PROMPT_BAR).toContain('modelAcceptsAudio');
    expect(STUDIO).toContain('uploadEditorMedia');
  });

  it('transmet les sources signées au devis puis à la génération', () => {
    // Devis : deux appels (estimation + rafraîchissement du devis fournisseur).
    expect(STUDIO.match(/video_url: reference\?\.videoUrl, audio_url: reference\?\.audioUrl,/g)).toHaveLength(2);
    expect(STUDIO).toContain('video_storage_path: reference.videoPath');
    expect(STUDIO).toContain('audio_storage_path: reference.audioPath');
    expect(API).toContain('video_url?: string;');
    expect(API).toContain('audio_url?: string;');
  });

  it('bloque honnêtement quand un média obligatoire manque', () => {
    expect(STUDIO).toContain("out.push('Importez une vidéo source pour ce modèle.')");
    expect(STUDIO).toContain("out.push('Importez un fichier audio source pour ce modèle.')");
  });

  it('côté serveur : signe, valide et transmet uniquement les champs déclarés', () => {
    for (const marker of [
      'VIDEO_MISSING', 'AUDIO_MISSING',
      'video_storage_path', 'audio_storage_path',
      'buildQuoteBody', 'buildMuapiBody',
    ]) {
      expect(EDGE).toContain(marker);
    }
    // Les sources ne sont envoyées que si le modèle les déclare.
    expect(EDGE).toContain('if (fields.includes("audio_url"))');
    expect(EDGE).toContain('for (const key of ["video_url", "input_video"])');
  });

  it('refuse toujours les entrées non câblées (mask, LoRA, listes)', () => {
    const supported = EDGE.slice(
      EDGE.indexOf('const SUPPORTED_REQUIRED_FIELDS'),
      EDGE.indexOf(']);', EDGE.indexOf('const SUPPORTED_REQUIRED_FIELDS')),
    );
    expect(supported).not.toContain('mask_');
    expect(supported).not.toContain('loras');
    expect(supported).not.toContain('images_list');
  });
});

describe('Navigation du Studio sans verrou trompeur', () => {
  it('n’expose plus aucune catégorie verrouillée', () => {
    expect(TOP_BAR).not.toContain('available: false');
    expect(TOP_BAR).not.toContain('cursor-not-allowed');
    expect(TOP_BAR).not.toContain('À venir');
  });

  it('chaque catégorie pointe vers une route réelle', () => {
    const routes = [...TOP_BAR.matchAll(/to: '([^']+)'/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const route of routes) {
      expect(route.startsWith('/app/')).toBe(true);
    }
    // Video→Video et Lip Sync ouvrent le Studio sur le bon mode.
    expect(routes).toContain('/app/studio?mode=video-source');
    expect(routes).toContain('/app/studio?mode=audio-source');
  });

  it('le deep link `?mode=` ouvre réellement la capacité demandée', () => {
    expect(STUDIO).toContain("search.get('mode')");
    expect(STUDIO).toContain('CREATION_MODES.find((m) => m.id === search.get(\'mode\'))');
  });
});
