import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { humanizeError } from '../src/lib/errors';

/*
 * Une seule passerelle IA pour Studio : SORAHNEX AI GATEWAY -> FreeLLMAPI.
 *
 * L'ancienne passerelle Groq (`reelora-ai`) est supprimée : ses actions
 * (script, prompt, accroches, visuel, scènes) sont servies par `vyora-ai`, qui
 * consomme et rembourse les mêmes quotas. Ces tests sont des invariants de
 * source : aucun appel réseau, aucun secret.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('Une seule passerelle IA', () => {
  it('l’ancienne passerelle Groq n’existe plus dans le dépôt ni dans la configuration', () => {
    expect(existsSync(join(process.cwd(), 'supabase/functions/reelora-ai/index.ts'))).toBe(false);
    const config = read('supabase/config.toml');
    expect(config).not.toContain('[functions.reelora-ai]');
    expect(config).toMatch(/\[functions\.vyora-ai\]\s*\nverify_jwt\s*=\s*true/);
  });

  it('le client ne connaît que `vyora-ai`, sans repli nommant un fournisseur', () => {
    const api = read('src/lib/api.ts');
    expect(api).toContain("invokeEdge<T>('vyora-ai', body)");
    expect(api).not.toContain("'reelora-ai'");
    expect(api).not.toMatch(/api\.groq\.com|generativelanguage\.googleapis\.com/i);
  });

  it('aucun endpoint Groq / Gemini / Cloudflare ne subsiste dans le code applicatif', () => {
    for (const path of [
      'src/lib/api.ts',
      'supabase/functions/vyora-ai/index.ts',
      'supabase/functions/vyora-provider-health/index.ts',
      'supabase/functions/vyora-provider-discovery/index.ts',
    ]) {
      const source = read(path);
      expect(source).not.toMatch(/api\.groq\.com|generativelanguage\.googleapis\.com|api\.cloudflare\.com/i);
      expect(source).not.toMatch(/BUSINESS_GROW_(GROQ|GEMINI|CLOUDFLARE)_/);
    }
  });

  it('la sonde de santé ne teste que le fournisseur central', () => {
    const health = read('supabase/functions/reelora-health/index.ts');
    expect(health).toContain('FREE_LLM_API_KEY');
    expect(health).not.toContain('GROQ');
    expect(health).not.toContain('GEMINI');
    expect(health).not.toContain('JSON.stringify(Deno.env');
  });

  it('le Studio désactive l’aide IA quand le fournisseur central est absent', () => {
    const composer = read('src/studio/components/PromptComposer.tsx');
    expect(composer).toContain('disabled={!aiConfigured || busy !== null}');
    expect(composer).toContain('aiConfigured === false');
    expect(composer).not.toContain('GROQ');
  });

  it('l’administration n’énumère plus Groq / Gemini et affiche le registre central', () => {
    const admin = read('src/pages/admin/AdminSections.tsx');
    expect(admin).not.toMatch(/label="Groq"|label="Gemini"/);
    expect(admin).toContain('FreeLLMAPI');
    expect(admin).toContain('Object.entries(health?.providers ?? {})');
  });

  it('les erreurs du gateway central sont traduites sans code brut', () => {
    expect(humanizeError('AI_NOT_CONFIGURED')).toMatch(/assistance IA est indisponible/i);
    expect(humanizeError('AI_EMPTY_RESPONSE')).toMatch(/n’est simulé|ni simulé|aucun contenu/i);
    expect(humanizeError('AI_PROVIDER_ERROR')).toMatch(/service IA/);
  });
});
