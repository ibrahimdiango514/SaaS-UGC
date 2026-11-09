import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handler } from '../supabase/functions/reelora-ai/index.ts';
import { humanizeError } from '../src/lib/errors';

/*
 * Groq unavailability is tested WITHOUT a real Groq key or a real network call.
 * The point is to prove that Reelora never manufactures an AI answer: when the
 * provider is missing, errors, or returns nothing, the function fails loudly,
 * refunds the consumed quota unit once, and returns no invented text/scenes.
 */

const SUPABASE_URL = 'https://project.supabase.co';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

interface Call { url: string; method: string; body: Record<string, unknown> | null }
const calls: Call[] = [];

const state = {
  groqStatus: 200,
  groqBody: {} as Record<string, unknown>,
  consumeOk: true,
};

function groqText(content: string): Record<string, unknown> {
  return { choices: [{ message: { content } }] };
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  let body: Record<string, unknown> | null = null;
  if (typeof init?.body === 'string') {
    try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = null; }
  }
  calls.push({ url, method, body });
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  if (url.includes('/auth/v1/user')) return json({ id: USER_ID });
  if (url.includes('/rest/v1/rpc/reelora_consume_quota')) {
    return state.consumeOk ? json({ used: 1, limit: 5 }) : json({ message: 'quota_exceeded:prompt:5:5' }, 400);
  }
  if (url.includes('/rest/v1/rpc/')) return json(true);
  if (url.includes('/rest/v1/reelora_prompt_templates')) return json([]);
  if (url === GROQ_URL) return json(state.groqBody, state.groqStatus);
  return json([], 200);
}

function post(body: Record<string, unknown>, jwt = 'Bearer valid-user-jwt'): Request {
  return new Request(`${SUPABASE_URL}/functions/v1/reelora-ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: jwt } : {}) },
    body: JSON.stringify(body),
  });
}
const rpcCalls = (name: string) => calls.filter((c) => c.url.includes(`/rest/v1/rpc/${name}`));
const refundCalls = () => rpcCalls('reelora_refund_quota');
const groqCalls = () => calls.filter((c) => c.url === GROQ_URL);
async function payload(r: Response): Promise<Record<string, unknown>> {
  return r.json() as Promise<Record<string, unknown>>;
}
const errorOf = (p: Record<string, unknown>) => p.error as { code: string; message: string };
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const originalEnv = { ...process.env };
beforeEach(() => {
  calls.length = 0;
  state.groqStatus = 200;
  state.groqBody = groqText('{}');
  state.consumeOk = true;
  process.env = { ...originalEnv, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    SUPABASE_ANON_KEY: 'anon-test-key', GROQ_API_KEY: 'groq-test-key' };
  vi.stubGlobal('fetch', fakeFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe('Authentification et garde-fou de configuration', () => {
  it('refuse sans JWT et sans appeler Groq', async () => {
    const r = await handler(post({ action: 'generate_script' }, ''));
    expect(r.status).toBe(401);
    expect(groqCalls()).toHaveLength(0);
  });

  it('GROQ_NOT_CONFIGURED explicite : 503, aucun quota consommé, aucun appel Groq, aucun texte simulé', async () => {
    delete process.env.GROQ_API_KEY;
    const r = await handler(post({ action: 'generate_script', product: 'Sérum' }));
    expect(r.status).toBe(503);
    const p = await payload(r);
    expect(errorOf(p).code).toBe('GROQ_NOT_CONFIGURED');
    expect(errorOf(p).message).toMatch(/GROQ_API_KEY/);
    expect(errorOf(p).message).toMatch(/ni simulé/);
    expect(rpcCalls('reelora_consume_quota')).toHaveLength(0);
    expect(groqCalls()).toHaveLength(0);
    expect(refundCalls()).toHaveLength(0);
    expect(p.scenes).toBeUndefined();
  });

  it('la sonde de santé expose un booléen groq:false sans révéler de secret', () => {
    const health = read('supabase/functions/reelora-health/index.ts');
    expect(health).toContain('GROQ_API_KEY');
    expect(health).not.toContain('JSON.stringify(Deno.env');
  });
});

describe('Aucune réponse IA simulée et remboursement unique', () => {
  it('une erreur HTTP Groq renvoie AI_PROVIDER_ERROR, rembourse une fois, sans contenu fabriqué', async () => {
    state.groqStatus = 429;
    state.groqBody = { error: { message: 'rate limit' } };
    const r = await handler(post({ action: 'generate_script', product: 'Sérum' }));
    expect(r.status).toBe(502);
    const p = await payload(r);
    expect(errorOf(p).code).toBe('AI_PROVIDER_ERROR');
    expect(errorOf(p).message).toMatch(/Aucun texte n’est simulé/);
    expect(rpcCalls('reelora_consume_quota')).toHaveLength(1);
    expect(refundCalls()).toHaveLength(1);
    expect(p.script_text).toBeUndefined();
  });

  it('une réponse Groq vide renvoie AI_EMPTY_RESPONSE et rembourse, sans script ni scènes inventés', async () => {
    state.groqBody = { choices: [{ message: { content: '   ' } }] };
    const r = await handler(post({ action: 'generate_script', product: 'Sérum' }));
    expect(r.status).toBe(502);
    const p = await payload(r);
    expect(errorOf(p).code).toBe('AI_EMPTY_RESPONSE');
    expect(p.script_text).toBeUndefined();
    expect(p.scenes).toBeUndefined();
    expect(refundCalls()).toHaveLength(1);
  });

  it('generate_scenes sans scènes Groq échoue au lieu de découper le script en 3 plans fictifs', async () => {
    state.groqBody = groqText('{"scenes":[]}');
    const r = await handler(post({ action: 'generate_scenes', script_text: 'Un script UGC valide écrit par l’utilisateur.' }));
    expect(r.status).toBe(502);
    const p = await payload(r);
    expect(errorOf(p).code).toBe('AI_EMPTY_RESPONSE');
    expect(p.scenes).toBeUndefined();
    expect(refundCalls()).toHaveLength(1);
  });

  it('improve_prompt ne renvoie jamais le prompt de l’utilisateur comme texte prétendument amélioré', async () => {
    state.groqBody = groqText('{"variables":[]}');
    const r = await handler(post({ action: 'improve_prompt', content: 'Une créatrice présente un sérum dans une salle de bain.' }));
    expect(r.status).toBe(502);
    const p = await payload(r);
    expect(errorOf(p).code).toBe('AI_EMPTY_RESPONSE');
    expect(p.content).toBeUndefined();
  });

  it('un quota refusé ne déclenche ni Groq ni remboursement superflus', async () => {
    state.consumeOk = false;
    const r = await handler(post({ action: 'generate_script', product: 'Sérum' }));
    expect(r.status).toBe(429);
    expect(errorOf(await payload(r)).code).toBe('QUOTA_EXCEEDED');
    expect(groqCalls()).toHaveLength(0);
    expect(refundCalls()).toHaveLength(0);
  });

  it('la source ne contient aucun fallback de scènes ou de prompt fabriqué localement', () => {
    const source = read('supabase/functions/reelora-ai/index.ts');
    expect(source).not.toContain('fallbackText');
    expect(source).not.toContain('Plan UGC');
    expect(source).not.toContain('Accroche face caméra');
    expect(source).not.toContain('Démonstration du produit en usage réel');
    expect(source).toContain('AI_EMPTY_RESPONSE');
    expect(source).not.toContain('Deno.env.get');
  });
});

describe('Quand Groq répond réellement, seul son contenu est retourné', () => {
  it('generate_script retourne le texte de Groq et une liste vide si aucune scène n’est fournie', async () => {
    const script = 'Accroche : voici notre sérum. Démonstration en lumière naturelle.';
    state.groqBody = groqText(JSON.stringify({
      hook: 'Et si votre peau…', script_text: script, call_to_action: 'Découvrez-le',
    }));
    const r = await handler(post({ action: 'generate_script', product: 'Sérum', project_id: null }));
    expect(r.status).toBe(200);
    const p = await payload(r);
    expect(p.script_text).toBe(script);
    expect(p.scenes).toEqual([]);
    expect(refundCalls()).toHaveLength(0);
  });

  it('generate_scenes retourne exactement les scènes de Groq sans en inventer', async () => {
    const scenes = [{ scene_type: 'hook', duration_seconds: 3, visual_prompt: 'Gros plan du flacon au réveil' }];
    state.groqBody = groqText(JSON.stringify({ scenes }));
    const r = await handler(post({ action: 'generate_scenes', script_text: 'Script UGC.' }));
    expect(r.status).toBe(200);
    const p = await payload(r);
    expect(p.scenes).toHaveLength(1);
    expect((p.scenes as Record<string, unknown>[])[0].visual_prompt).toBe('Gros plan du flacon au réveil');
    expect(refundCalls()).toHaveLength(0);
  });
});

describe('États côté interface et messages français', () => {
  it('les boutons IA du studio sont désactivés et explicités quand Groq est absent', () => {
    const composer = read('src/studio/components/PromptComposer.tsx');
    expect(composer).toContain('disabled={!groqConfigured || busy !== null}');
    expect(composer).toContain('groqConfigured === false');
    expect(composer).toContain('GROQ_API_KEY');
  });

  it('les erreurs Groq sont traduites sans laisser de code brut', () => {
    expect(humanizeError('GROQ_NOT_CONFIGURED')).toMatch(/GROQ_API_KEY/);
    expect(humanizeError('AI_EMPTY_RESPONSE')).toMatch(/n’est simulé|ni simulé|aucun contenu/i);
    expect(humanizeError('AI_PROVIDER_ERROR')).toMatch(/fournisseur IA/);
  });
});
