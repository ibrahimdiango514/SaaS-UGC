// @vitest-environment node
/**
 * REELORA AI ENGINE & BUSINESS GROW — Suite de tests automatisés.
 *
 * DISTINCTION STRICTE :
 * - Tests structurels & contrats réels : inspectent migrations SQL, RLS, config.toml,
 *   isolation Studio UGC ↔ Business Grow, règles de routage et registres d'outils/connecteurs.
 * - Tests simulés (HTTP & Supabase mockés) : vérifient les adaptateurs Groq & Google Gemini,
 *   le fallback automatique, le tracking des coûts, la mémoire métier, la confirmation d'outils
 *   et le cycle réserve/capture/remboursement Business Grow SANS appels réseau réels.
 * - Aucun appel réel aux APIs Groq ou Gemini n'a été exécuté ici faute de clés API configurées.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    rpc: vi.fn(),
    from: vi.fn(),
  },
  STORAGE_BUCKET: 'ugc-assets',
  SITE_URL: 'https://reelora.test',
}));

import { GroqAdapter } from '../supabase/functions/reelora-ai-engine/providers/groq.ts';
import { GeminiAdapter } from '../supabase/functions/reelora-ai-engine/providers/gemini.ts';
import { ProviderRegistry } from '../supabase/functions/reelora-ai-engine/providers/registry.ts';
import { AllProvidersFailedError, buildCandidateChain, orchestrateAI } from '../supabase/functions/reelora-ai-engine/router.ts';
import { buildBusinessGrowSystemPrompt } from '../supabase/functions/reelora-ai-engine/businessGrow.ts';
import { createAiEngineHandler } from '../supabase/functions/reelora-ai-engine/index.ts';
import {
  AI_MODEL_CATALOG,
  AI_PROVIDER_CATALOG,
  EXTERNAL_CONNECTOR_CATALOG,
  buildUgcBriefHandoff,
  canExecuteToolLocally,
  connectorRequirementMessage,
  evaluateBusinessProfile,
  isConnectorAuthorized,
  previewRoutingPlan,
  requiresExplicitUserApproval,
} from '../src/ai/index';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe('1. Sécurité, isolation crédits Studio UGC ↔ Business Grow & migrations SQL', () => {
  it('le moteur frontend src/ai/* ne lit jamais de secrets serveur', () => {
    const aiDir = join(root, 'src/ai');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(full);
      }
    };
    walk(aiDir);
    const code = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(code).not.toContain('Deno.env');
    expect(code).not.toContain('process.env');
    expect(code).not.toMatch(/VITE_(GROQ|GEMINI|OPENAI|ANTHROPIC|DEEPSEEK|MISTRAL)/);
    expect(code).not.toMatch(/(GROQ|GEMINI|OPENAI|ANTHROPIC|DEEPSEEK|MISTRAL)_API_KEY\s*=/);
    expect(code).not.toContain('SERVICE_ROLE');
  });

  it('tous les RPC appelés par src/ai/client.ts existent dans les migrations SQL', () => {
    const clientCode = read('src/ai/client.ts');
    const rpcNames = Array.from(clientCode.matchAll(/\.rpc(?:\s+as\s+any)?\)\(\s*['"]([a-z0-9_]+)['"]/g))
      .map((m) => m[1])
      .filter((name) => name.startsWith('reelora_bg_'));
    const migrations = readdirSync(join(root, 'supabase/migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => read(join('supabase/migrations', f)))
      .join('\n');

    expect(rpcNames.length).toBeGreaterThanOrEqual(3);
    for (const rpcName of rpcNames) {
      expect(migrations).toContain(`function public.${rpcName}(`);
    }
  });

  it('les migrations Business Grow n’interagissent jamais avec ugc_wallets ni les crédits Studio UGC', () => {
    const schemaSql = read('supabase/migrations/20261110000001_reelora_ai_engine_schema.sql');
    const rpcSqlRaw = read('supabase/migrations/20261110000002_reelora_ai_engine_rpc.sql');
    const rpcSqlNoComments = rpcSqlRaw.replace(/--[^\n]*/g, '');

    expect(schemaSql).toContain('saas_ugc.bg_wallets');
    expect(schemaSql).toContain('saas_ugc.bg_credit_ledger');
    expect(schemaSql).toContain('ugc_private.is_workspace_member(workspace_id)');
    expect(schemaSql).toContain('enable row level security');
    expect(schemaSql).not.toContain('vault_secret_ref\n  from saas_ugc.bg_external_connectors');

    expect(rpcSqlRaw).toContain('revoke all on function public.reelora_bg_reserve_credits');
    expect(rpcSqlRaw).toContain('revoke all on function public.reelora_bg_capture_credits');
    expect(rpcSqlRaw).toContain('revoke all on function public.reelora_bg_release_credits');
    expect(rpcSqlNoComments).not.toContain('ugc_wallets');
    expect(rpcSqlNoComments).not.toContain('ugc_credit_ledger');
    expect(rpcSqlNoComments).not.toContain('reelora_consume_quota');
  });

  it('supabase/config.toml protège reelora-ai-engine par JWT vérifié', () => {
    const cfg = read('supabase/config.toml');
    expect(cfg).toMatch(/\[functions\.reelora-ai-engine\][\s\S]*?verify_jwt\s*=\s*true/);
  });
});

describe('2. Adaptateurs fournisseurs Groq & Google Gemini (appels HTTP simulés)', () => {
  it('signale un état non configuré et ne prétend jamais être connecté sans clé serveur', async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;

    const groq = new GroqAdapter();
    const gemini = new GeminiAdapter();

    expect(groq.isConfigured()).toBe(false);
    expect(gemini.isConfigured()).toBe(false);

    const gv = await groq.verify();
    const mv = await gemini.verify();
    expect(gv.verified).toBe(false);
    expect(gv.configured).toBe(false);
    expect(gv.errorCode).toBe('NOT_CONFIGURED');
    expect(mv.verified).toBe(false);
    expect(mv.configured).toBe(false);
    expect(mv.errorCode).toBe('NOT_CONFIGURED');
  });

  it('GroqAdapter exécute un appel complet, extrait tokens/coût/outils et normalise les erreurs', async () => {
    process.env.GROQ_API_KEY = 'groq-test-secret';
    const groq = new GroqAdapter();

    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer groq-test-secret');
      return new Response(
        JSON.stringify({
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              content: 'Voici une recommandation stratégique.',
              tool_calls: [{
                function: {
                  name: 'propose_action_plan',
                  arguments: JSON.stringify({ objective: 'Doubler les ventes', steps: [{ title: 'Campagne TikTok' }] }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 450, completion_tokens: 180 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }));

    const res = await groq.generate({
      model: 'llama-3.3-70b-versatile',
      systemPrompt: 'Assistant',
      messages: [{ role: 'user', content: 'Analyse ma croissance' }],
    });
    expect(res.providerKey).toBe('groq');
    expect(res.text).toBe('Voici une recommandation stratégique.');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].toolName).toBe('propose_action_plan');
    expect(res.inputTokens).toBe(450);
    expect(res.outputTokens).toBe(180);
    expect(res.estimatedCostUsd).toBeGreaterThan(0);

    // Rate limit 429 classification
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'rate limit exceeded' } }),
      { status: 429, headers: { 'retry-after': '12' } },
    )));
    await expect(groq.generate({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSec: 12 });
  });

  it('GeminiAdapter envoie x-goog-api-key en header (jamais en query param), parse texte + functionCall + usage', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test-secret';
    const gemini = new GeminiAdapter();

    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      // Security: key must NEVER be in URL query string
      expect(String(url)).not.toContain('gemini-test-secret');
      expect(String(url)).toContain('/models/gemini-2.5-flash:generateContent');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe('gemini-test-secret');
      return new Response(
        JSON.stringify({
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [
                { text: 'Plan d’action Gemini prêt.' },
                {
                  functionCall: {
                    name: 'propose_business_memory_save',
                    args: { category: 'goal', memory_key: 'q4_target', summary: '+30% CA T4' },
                  },
                },
              ],
            },
          }],
          usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 240 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }));

    const res = await gemini.generate({
      model: 'gemini-2.5-flash',
      systemPrompt: 'Contexte entreprise',
      messages: [{ role: 'user', content: 'Plan Q4' }],
      jsonMode: true,
    });
    expect(res.providerKey).toBe('gemini');
    expect(res.text).toBe('Plan d’action Gemini prêt.');
    expect(res.toolCalls[0].toolName).toBe('propose_business_memory_save');
    expect(res.inputTokens).toBe(600);
    expect(res.outputTokens).toBe(240);

    // Safety block classification
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }),
      { status: 200 },
    )));
    await expect(gemini.generate({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'test' }] }))
      .rejects.toMatchObject({ code: 'SAFETY_BLOCKED' });
  });
});

describe('3. Orchestrateur central, routage et fallback automatique', () => {
  it('bascule automatiquement sur Google Gemini si Groq échoue en 429 ou est indisponible', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.GEMINI_API_KEY = 'gemini-key';

    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('api.groq.com')) {
        return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), { status: 429 });
      }
      if (u.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Réponse via fallback Gemini.' }] } }],
            usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45 },
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    }));

    const registry = new ProviderRegistry();
    const out = await orchestrateAI(
      {
        space: 'business_grow',
        taskType: 'chat',
        messages: [{ role: 'user', content: 'Aide-moi sur mon offre' }],
      },
      registry,
    );

    expect(out.fallbackUsed).toBe(true);
    expect(out.response.providerKey).toBe('gemini');
    expect(out.response.modelId).toBe('gemini-2.5-flash');
    expect(out.response.text).toBe('Réponse via fallback Gemini.');
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[0]).toMatchObject({ providerKey: 'groq', status: 'rate_limited' });
    expect(out.attempts[1]).toMatchObject({ providerKey: 'gemini', status: 'succeeded' });
  });

  it('respecte le mode manuel sans fallback si allowFallback=false et échoue proprement si tout échoue', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.GEMINI_API_KEY = 'gemini-key';

    const registry = new ProviderRegistry();
    const manualChain = buildCandidateChain(
      {
        space: 'business_grow',
        taskType: 'strategy',
        messages: [{ role: 'user', content: 'Test' }],
        routing: {
          selectionMode: 'manual',
          preferredProviderKey: 'groq',
          preferredModelId: 'qwen/qwen3-32b',
          allowFallback: false,
        },
      },
      registry,
    );
    expect(manualChain).toHaveLength(1);
    expect(manualChain[0]).toMatchObject({ providerKey: 'groq', modelId: 'qwen/qwen3-32b', reason: 'manual' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('Server down', { status: 503 })));
    await expect(
      orchestrateAI(
        {
          space: 'business_grow',
          taskType: 'chat',
          messages: [{ role: 'user', content: 'Test' }],
          routing: { selectionMode: 'manual', preferredProviderKey: 'groq', preferredModelId: 'llama-3.3-70b-versatile', allowFallback: false },
        },
        registry,
      ),
    ).rejects.toBeInstanceOf(AllProvidersFailedError);
  });
});

describe('4. Handler Edge reelora-ai-engine & Business Grow complet (simulé)', () => {
  it('hydrate mémoire & profil, isole strictement les crédits Business Grow et rembourse en cas d’échec total', async () => {
    process.env.SUPABASE_URL = 'https://mock.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    process.env.GROQ_API_KEY = 'groq-secret';
    process.env.GEMINI_API_KEY = 'gemini-secret';

    const rpcCalls: Array<{ fn: string; body: Record<string, unknown> }> = [];
    const insertedRequests: Array<Record<string, unknown>> = [];
    const insertedMessages: Array<Record<string, unknown>> = [];
    const insertedTools: Array<Record<string, unknown>> = [];
    let failAllProviders = false;

    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = String(input);
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      const parsedBody = bodyStr ? JSON.parse(bodyStr) as Record<string, unknown> : {};

      if (url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: 'user-bg-1' }), { status: 200 });
      }
      if (url.includes('/rest/v1/rpc/')) {
        const fn = url.split('/rest/v1/rpc/')[1];
        rpcCalls.push({ fn, body: parsedBody });
        if (fn === 'reelora_bg_ensure_wallet') return new Response(JSON.stringify({ workspace_id: 'ws-bg-1' }), { status: 200 });
        if (fn === 'reelora_bg_reserve_credits') return new Response(JSON.stringify({ ok: true, available_credits: 47 }), { status: 200 });
        if (fn === 'reelora_bg_capture_credits') return new Response(JSON.stringify({ ok: true, charged: parsedBody.p_charged }), { status: 200 });
        if (fn === 'reelora_bg_release_credits') return new Response(JSON.stringify({ ok: true, released: parsedBody.p_reserved }), { status: 200 });
        return new Response(JSON.stringify(true), { status: 200 });
      }
      if (url.includes('/rest/v1/ugc_workspaces')) {
        return new Response(JSON.stringify([{ id: 'ws-bg-1' }]), { status: 200 });
      }
      if (url.includes('/rest/v1/reelora_bg_business_profiles')) {
        return new Response(JSON.stringify([{
          id: 'prof-1',
          company_name: 'Kora Cosmétiques',
          industry: 'Beauté naturelle',
          positioning: 'Soins karité premium fabriqués au Mali',
          communication_tone: 'Chaleureux et expert',
          ai_memory_consent: true,
        }]), { status: 200 });
      }
      if (url.includes('/rest/v1/reelora_bg_business_memories')) {
        return new Response(JSON.stringify([{
          id: 'mem-1',
          category: 'goal',
          memory_key: 'launch_q4',
          summary: 'Lancer la gamme sérum karité avec 300 commandes mensuelles.',
          pinned: true,
        }]), { status: 200 });
      }
      if (url.includes('/rest/v1/reelora_ai_requests') && init?.method === 'POST') {
        insertedRequests.push(parsedBody);
        return new Response(JSON.stringify([parsedBody]), { status: 201 });
      }
      if (url.includes('/rest/v1/reelora_bg_messages') && init?.method === 'POST') {
        insertedMessages.push(parsedBody);
        return new Response(JSON.stringify([{ id: `msg-${insertedMessages.length}` }]), { status: 201 });
      }
      if (url.includes('/rest/v1/reelora_bg_tool_executions') && init?.method === 'POST') {
        insertedTools.push(parsedBody);
        return new Response(JSON.stringify([parsedBody]), { status: 201 });
      }
      if (url.includes('/rest/v1/')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('api.groq.com')) {
        if (failAllProviders) return new Response('down', { status: 503 });
        // Ensure hydrated company memory actually reached Groq
        expect(bodyStr).toContain('Kora Cosmétiques');
        expect(bodyStr).toContain('300 commandes mensuelles');
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            message: {
              content: 'Voici votre plan d’acquisition pour Kora Cosmétiques.',
              tool_calls: [{
                function: {
                  name: 'propose_business_memory_save',
                  arguments: JSON.stringify({ category: 'insight', memory_key: 'canal_prioritaire', summary: 'Prioriser TikTok et Instagram Reels.' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 300, completion_tokens: 90 },
        }), { status: 200 });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        if (failAllProviders) return new Response('down', { status: 503 });
      }
      return new Response('{}', { status: 500 });
    }));

    const handler = createAiEngineHandler();

    // Unauthenticated rejected
    const unauth = await handler(new Request('https://mock.supabase.co/functions/v1/reelora-ai-engine', {
      method: 'POST',
      body: JSON.stringify({ action: 'health' }),
    }));
    expect(unauth.status).toBe(401);

    // Business Grow chat turn
    const okRes = await handler(new Request('https://mock.supabase.co/functions/v1/reelora-ai-engine', {
      method: 'POST',
      headers: { Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'business_chat',
        workspaceId: 'ws-bg-1',
        conversationId: 'conv-1',
        taskType: 'marketing_campaign',
        prompt: 'Propose une campagne de lancement.',
      }),
    }));
    expect(okRes.status).toBe(200);
    const okJson = await okRes.json() as Record<string, unknown>;
    expect(okJson.provider).toBe('groq');
    expect((okJson.usage as { studioUgcCreditsCharged: number }).studioUgcCreditsCharged).toBe(0);
    expect(rpcCalls.some((c) => c.fn === 'reelora_bg_reserve_credits')).toBe(true);
    expect(rpcCalls.some((c) => c.fn === 'reelora_bg_capture_credits')).toBe(true);
    // CRITICAL ISOLATION ASSERTION: Studio UGC quota/wallet RPCs are NEVER called
    expect(rpcCalls.some((c) => c.fn === 'reelora_consume_quota' || c.fn === 'ugc_reserve_credits')).toBe(false);
    expect(insertedMessages).toHaveLength(2);
    expect(insertedTools[0]).toMatchObject({
      tool_name: 'propose_business_memory_save',
      status: 'pending_approval',
    });

    // All providers fail -> full BG credit refund via reelora_bg_release_credits
    failAllProviders = true;
    const failRes = await handler(new Request('https://mock.supabase.co/functions/v1/reelora-ai-engine', {
      method: 'POST',
      headers: { Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'business_chat',
        workspaceId: 'ws-bg-1',
        taskType: 'chat',
        prompt: 'Test panne totale',
      }),
    }));
    expect(failRes.status).toBe(502);
    expect(rpcCalls.some((c) => c.fn === 'reelora_bg_release_credits')).toBe(true);
  });
});

describe('5. Contrats Business Grow, outils, connecteurs préparés & Studio UGC handoff', () => {
  it('évalue le profil métier, prépare un handoff Studio UGC sans débit et bloque les outils/connecteurs non autorisés', () => {
    expect(AI_PROVIDER_CATALOG.map((p) => p.providerKey)).toEqual([
      'groq', 'gemini', 'openai', 'anthropic', 'deepseek', 'mistral',
    ]);
    expect(AI_MODEL_CATALOG.filter((m) => m.providerKey === 'gemini').length).toBeGreaterThanOrEqual(3);

    const completeness = evaluateBusinessProfile({
      company_name: 'Kora',
      industry: 'Cosmétique',
      products_services: [{ name: 'Sérum Karité' }],
      target_customers: ['Femmes 25-40 ans'],
      business_goals: ['+30% de ventes'],
    });
    expect(completeness.scorePercent).toBeGreaterThan(55);
    expect(completeness.readyForStrategy).toBe(true);

    const handoff = buildUgcBriefHandoff({
      title: 'Campagne Sérum Karité',
      platform: 'TikTok',
      hookIdea: 'Ma peau terne a changé en 7 jours',
      keyMessage: 'Karité pur pressé à froid',
      callToAction: 'Commander maintenant',
    });
    expect(handoff.sourceSpace).toBe('business_grow');
    expect(handoff.consumesStudioCreditsOnDraft).toBe(false);

    expect(requiresExplicitUserApproval({ toolName: 'propose_business_memory_save', riskLevel: 'write_requires_approval' })).toBe(true);
    expect(canExecuteToolLocally({
      id: 't1', workspace_id: 'w1', user_id: 'u1', business_profile_id: null,
      conversation_id: null, message_id: null, request_id: null,
      tool_name: 'propose_action_plan', risk_level: 'write_requires_approval',
      status: 'pending_approval', input_args: {}, output_result: {},
      error_message: null, approved_by: null, approved_at: null, executed_at: null, created_at: '',
    }).allowed).toBe(false);

    expect(EXTERNAL_CONNECTOR_CATALOG.map((c) => c.platform)).toEqual([
      'facebook', 'instagram', 'youtube', 'tiktok', 'shopify', 'woocommerce',
    ]);
    expect(isConnectorAuthorized(null)).toBe(false);
    expect(connectorRequirementMessage('shopify')).toContain('n’est pas encore connecté');

    const promptCheck = buildBusinessGrowSystemPrompt({
      taskType: 'sales_analysis',
      profile: { id: 'p1', company_name: 'Kora', ai_memory_consent: true },
      memories: [],
      connectors: [],
    });
    expect(promptCheck).toContain('Aucune boutique (Shopify, WooCommerce) ni réseau social');

    const preview = previewRoutingPlan('strategy', { selectionMode: 'auto' }, []);
    expect(preview[0]).toMatchObject({ providerKey: 'gemini', modelId: 'gemini-2.5-pro', role: 'primary' });
    expect(preview[1]).toMatchObject({ providerKey: 'groq', role: 'fallback' });
  });
});
