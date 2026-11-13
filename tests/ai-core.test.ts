// VYORA AI CORE — tests unitaires : adaptateurs (7 fournisseurs), registre,
// routage intelligent, moteur d'exécution (secours plafonné, journalisation).
//
// Aucune clé réelle : chaque appel réseau est un fetch simulé ; on vérifie le
// contrat de chaque fournisseur (URL, en-têtes, corps, parsing des tokens) et
// les règles de routage/budget/anti-boucle du moteur.
import { describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDERS,
  modelBaseKey,
  parseRegistrySnapshot,
  buildAiChain,
  estimateCostUsd,
  runAiCall,
  AiProviderError,
  type AiCallLogEntry,
  type AiChatMessage,
  type AiEngineDeps,
  type AiRegistrySnapshot,
} from '../supabase/functions/_shared/ai-core/index.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<AiRegistrySnapshot> = {}): AiRegistrySnapshot {
  return {
    version: 2,
    providers: [
      { key: 'groq', name: 'Groq', status: 'available', aggregator: false },
      { key: 'deepseek', name: 'DeepSeek', status: 'available', aggregator: false },
      { key: 'openrouter', name: 'OpenRouter', status: 'available', aggregator: true },
      { key: 'mistral', name: 'Mistral AI', status: 'available', aggregator: false },
    ],
    models: [
      {
        provider: 'groq', key: 'gpt-oss-20b', providerModel: 'openai/gpt-oss-20b',
        name: 'GPT-OSS 20B', verified: true, tier: 'fast',
        capabilities: { writing: true, reasoning: true }, contextIn: 128_000, maxOut: 8_000,
        costIn: 0.075, costOut: 0.3, rpm: 30_000, tpm: null,
      },
      {
        provider: 'deepseek', key: 'flash', providerModel: 'deepseek-chat',
        name: 'DeepSeek Flash', verified: true, tier: 'economy',
        capabilities: { writing: true, reasoning: true }, contextIn: 64_000, maxOut: 8_000,
        costIn: 0.3, costOut: 1.2, rpm: null, tpm: null,
      },
      {
        provider: 'deepseek', key: 'v4-pro', providerModel: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro', verified: true, tier: 'advanced',
        capabilities: { writing: true, reasoning: true }, contextIn: 1_000_000, maxOut: 16_000,
        costIn: 0.044, costOut: 0.396, rpm: null, tpm: null,
      },
      {
        provider: 'mistral', key: 'small', providerModel: 'mistral-small-latest',
        name: 'Mistral Small', verified: false, tier: 'economy',
        capabilities: { writing: true }, contextIn: 32_000, maxOut: 8_000,
        costIn: null, costOut: null, rpm: null, tpm: null,
      },
      {
        provider: 'openrouter', key: 'gpt-oss-20b-or', providerModel: 'openai/gpt-oss-20b',
        name: 'GPT-OSS 20B (OpenRouter)', verified: true, tier: 'fast',
        capabilities: { writing: true, reasoning: true }, contextIn: 128_000, maxOut: 8_000,
        costIn: 0.075, costOut: 0.3, rpm: null, tpm: null,
      },
      {
        provider: 'openrouter', key: 'free-flash', providerModel: 'some-vendor/flash-free',
        name: 'Flash Free (agrégateur)', verified: true, tier: 'fallback',
        capabilities: { writing: true }, contextIn: 32_000, maxOut: 4_000,
        costIn: 0, costOut: 0, rpm: null, tpm: null,
      },
    ],
    roles: [
      { key: 'business_advisor', capabilities: {}, enabled: true },
      { key: 'business_analysis', capabilities: { reasoning: true }, enabled: true },
    ],
    rules: [
      { role: 'business_advisor', provider: 'groq', model: 'gpt-oss-20b', priority: 1 },
      { role: 'business_advisor', provider: 'deepseek', model: 'flash', priority: 2 },
      { role: 'business_analysis', provider: 'deepseek', model: 'v4-pro', priority: 1 },
    ],
    budget: { monthly: null, alert: 80, daily: null },
    monthlySpendUsd: 0,
    ...overrides,
  };
}

function okFetch(body: Record<string, unknown> | ((url: string) => Record<string, unknown>), status = 200): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const payload = typeof body === 'function' ? body(url) : body;
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const OPENAI_OK = {
  choices: [{ message: { role: 'assistant', content: 'Réponse du fournisseur.' } }],
  usage: { prompt_tokens: 12, completion_tokens: 34 },
};

// ---------------------------------------------------------------------------
// Adaptateurs — contrat par fournisseur
// ---------------------------------------------------------------------------

describe('adaptateurs — contrats de transport', () => {
  const creds = { apiKey: 'test-key' };
  const messages: AiChatMessage[] = [
    { role: 'system', content: 'Système.' },
    { role: 'user', content: 'Bonjour' },
  ];

  it('groq : URL, Bearer, corps et tokens (protocole historique inchangé)', () => {
    const req = AI_PROVIDERS.groq.buildRequest({ credentials: creds, model: 'openai/gpt-oss-20b', messages, options: { temperature: 0.7, maxOutputTokens: 1000 } });
    expect(req.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer test-key');
    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe('openai/gpt-oss-20b');
    expect(body.max_tokens).toBe(1000);
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toHaveLength(2);
    const parsed = AI_PROVIDERS.groq.parse(OPENAI_OK);
    expect(parsed.content).toBe('Réponse du fournisseur.');
    expect(parsed.inputTokens).toBe(12);
    expect(parsed.outputTokens).toBe(34);
  });

  it('gemini : URL du modèle, x-goog-api-key, systemInstruction + usage', () => {
    const req = AI_PROVIDERS.gemini.buildRequest({ credentials: creds, model: 'gemini-2.5-flash', messages });
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(req.headers['x-goog-api-key']).toBe('test-key');
    const body = req.body as Record<string, unknown>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Système.' }] });
    expect((body.contents as unknown[]).map((c) => (c as { role: string }).role)).toEqual(['user']);
    const parsed = AI_PROVIDERS.gemini.parse({
      candidates: [{ content: { parts: [{ text: '  Bonjour !  ' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 21 },
    });
    expect(parsed.content).toBe('Bonjour !');
    expect(parsed.inputTokens).toBe(7);
    expect(parsed.outputTokens).toBe(21);
  });

  it('deepseek / mistral / grok : protocoles OpenAI sur leurs URLs respectives', () => {
    expect(AI_PROVIDERS.deepseek.buildRequest({ credentials: creds, model: 'deepseek-chat', messages }).url)
      .toBe('https://api.deepseek.com/chat/completions');
    expect(AI_PROVIDERS.mistral.buildRequest({ credentials: creds, model: 'mistral-small-latest', messages }).url)
      .toBe('https://api.mistral.ai/v1/chat/completions');
    expect(AI_PROVIDERS.grok.buildRequest({ credentials: creds, model: 'grok-4.7', messages }).url)
      .toBe('https://api.x.ai/v1/chat/completions');
    for (const id of ['deepseek', 'mistral', 'grok']) {
      expect(AI_PROVIDERS[id].parse(OPENAI_OK).inputTokens).toBe(12);
    }
  });

  it('cloudflare : URL par compte, erreur sans compte', () => {
    const req = AI_PROVIDERS.cloudflare.buildRequest({
      credentials: { apiKey: 'cf-token', accountId: 'acct-123' },
      model: '@cf/qwen/qwen3.8-27b', messages,
    });
    expect(req.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1/chat');
    expect(req.headers.Authorization).toBe('Bearer cf-token');
    expect(() => AI_PROVIDERS.cloudflare.buildRequest({
      credentials: { apiKey: 'cf-token', accountId: null },
      model: '@cf/qwen/qwen3.8-27b', messages,
    })).toThrow(AiProviderError);
  });

  it('openrouter (agrégateur) : en-têtes d’attribution obligatoires', () => {
    const req = AI_PROVIDERS.openrouter.buildRequest({ credentials: creds, model: 'openai/gpt-oss-20b', messages });
    expect(req.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(req.headers['HTTP-Referer']).toBeTruthy();
    expect(req.headers['X-Title']).toBe('VYORA');
    expect(req.headers.Authorization).toBe('Bearer test-key');
  });

  it('tout adaptateur refuse un appel non configuré ou un contexte vide', () => {
    for (const adapter of Object.values(AI_PROVIDERS)) {
      expect(() => adapter.buildRequest({ credentials: { apiKey: null }, model: 'm', messages }))
        .toThrow(AiProviderError);
      expect(() => adapter.buildRequest({ credentials: creds, model: 'm', messages: [] }))
        .toThrow(AiProviderError);
    }
    expect(() => AI_PROVIDERS.groq.parse({ choices: [] })).toThrow(AiProviderError);
  });

  it('nom de base normalisé (déduplication agrégateur/direct)', () => {
    expect(modelBaseKey('google/gemini-4-hydrogen')).toBe('gemini-4-hydrogen');
    expect(modelBaseKey('gemini-4-hydrogen')).toBe('gemini-4-hydrogen');
    expect(modelBaseKey('openai/gpt-oss-20b')).toBe('gpt-oss-20b');
    expect(modelBaseKey('@cf/qwen/qwen3.8-27b')).toBe('qwen3.8-27b');
  });
});

// ---------------------------------------------------------------------------
// Registre — parsing défensif
// ---------------------------------------------------------------------------

describe('registre — parsing du snapshot', () => {
  it('accepte un snapshot valide (format SQL bg_ai_registry_snapshot)', () => {
    const snap = parseRegistrySnapshot({
      version: 2,
      providers: [{ key: 'groq', name: 'Groq', status: 'available', aggregator: false }],
      models: [{
        provider: 'groq', key: 'm1', provider_model: 'openai/gpt-oss-20b', name: 'GPT',
        verified: true, tier: 'fast', capabilities: { writing: true, docs: false },
        context_in: 128_000, max_out: 8_000, cost_in: 0.075, cost_out: 0.3, rpm: 30_000, tpm: null,
      }],
      roles: [{ key: 'business_advisor', capabilities: {}, enabled: true }],
      rules: [{ role: 'business_advisor', provider: 'groq', model: 'm1', priority: 1 }],
      budget: { monthly: 100, alert: 80, daily: null },
      monthly_spend_usd: 12.5,
    });
    expect(snap).not.toBeNull();
    expect(snap?.models[0].costIn).toBe(0.075);
    expect(snap?.models[0].capabilities.writing).toBe(true);
    expect(snap?.models[0].capabilities.docs).toBeUndefined();
    expect(snap?.monthlySpendUsd).toBe(12.5);
  });

  it('écarte les entrées invalides sans planter', () => {
    const snap = parseRegistrySnapshot({
      providers: [{ key: 'groq' }, { name: 'sans clé' }],
      models: [
        { provider: 'groq', key: 'm1', provider_model: 'x', verified: true, tier: 'fast', capabilities: {} },
        { provider: 'groq' },
        null,
      ],
      rules: [{ role: 'r', provider: 'p', priority: 1 }],
      budget: 'non-objet',
    });
    expect(snap?.providers).toHaveLength(1);
    expect(snap?.models).toHaveLength(1);
    expect(snap?.rules).toHaveLength(0);
    expect(snap?.budget.monthly).toBeNull();
  });

  it('rejette un payload qui n’est pas un objet', () => {
    expect(parseRegistrySnapshot(null)).toBeNull();
    expect(parseRegistrySnapshot([])).toBeNull();
    expect(parseRegistrySnapshot('x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Routage intelligent
// ---------------------------------------------------------------------------

describe('routage — règles, niveaux, capacités, budget, anti-doublon', () => {
  const configured = new Set(['groq', 'deepseek', 'openrouter', 'mistral']);

  it('suit les priorités des règles du rôle (fournisseur configuré + modèle vérifié)', () => {
    const { steps, skipReason } = buildAiChain(makeSnapshot(), { role: 'business_advisor' }, configured);
    expect(skipReason).toBeNull();
    expect(steps.map((s) => s.providerKey)).toEqual(['groq', 'deepseek']);
    expect(steps[0].providerModelKey).toBe('openai/gpt-oss-20b');
  });

  it('exclut les modèles non vérifiés (jamais testés en réel)', () => {
    const snap = makeSnapshot();
    snap.rules.push({ role: 'business_advisor', provider: 'mistral', model: 'small', priority: 3 });
    const { steps } = buildAiChain(snap, { role: 'business_advisor' }, configured);
    expect(steps.map((s) => s.providerKey)).not.toContain('mistral');
  });

  it('exclut un fournisseur sans clé configurée', () => {
    const { steps } = buildAiChain(makeSnapshot(), { role: 'business_advisor' }, new Set(['groq']));
    expect(steps.map((s) => s.providerKey)).toEqual(['groq']);
  });

  it('respecte les capacités requises du rôle', () => {
    // business_analysis exige "reasoning" : deepseek-v4-pro l'a.
    const { steps } = buildAiChain(makeSnapshot(), { role: 'business_analysis' }, configured);
    expect(steps).toHaveLength(1);
    expect(steps[0].providerKey).toBe('deepseek');
    expect(steps[0].modelKey).toBe('v4-pro');
  });

  it('filtre par niveau demandé (et repli tolérant si vide)', () => {
    const snap = makeSnapshot();
    const { steps } = buildAiChain(snap, { level: 'advanced' }, configured);
    // Seuls deepseek-v4-pro (advanced) et… rien d'autre au niveau advanced.
    expect(steps.every((s) => s.tier === 'advanced')).toBe(true);
    expect(steps.map((s) => s.modelKey)).toContain('v4-pro');
    // Niveau inexistant → repli tolérant (chaîne non vide).
    const { steps: relaxed } = buildAiChain(snap, { level: 'specialized' }, configured);
    expect(relaxed.length).toBeGreaterThan(0);
  });

  it('budget épuisé : seuls les modèles gratuits restent ; sinon BUDGET_EXHAUSTED', () => {
    const snap = makeSnapshot({ budget: { monthly: 100, alert: 80, daily: null }, monthlySpendUsd: 120 });
    const { steps, skipReason } = buildAiChain(snap, {}, configured);
    // Le seul modèle gratuit est l'agrégateur "flash-free" (0/0).
    expect(skipReason).toBeNull();
    expect(steps.every((s) => s.costIn === 0 && s.costOut === 0)).toBe(true);
    // Sans modèle gratuit → code explicite.
    const snap2 = makeSnapshot({ budget: { monthly: 100, alert: 80, daily: null }, monthlySpendUsd: 120 });
    snap2.models = snap2.models.filter((m) => m.key !== 'free-flash');
    const { skipReason: r2 } = buildAiChain(snap2, {}, configured);
    expect(r2).toBe('BUDGET_EXHAUSTED');
  });

  it('anti-double-routage : l’agrégateur ne duplique jamais un modèle direct', () => {
    const { steps } = buildAiChain(makeSnapshot(), {}, configured);
    const bases = steps.map((s) => modelBaseKey(s.providerModelKey));
    expect(new Set(bases).size).toBe(bases.length);
    // gpt-oss-20b existe en direct (groq) ET en agrégateur (openrouter) :
    // seul le direct doit être présent.
    expect(steps.find((s) => s.providerModelKey === 'openai/gpt-oss-20b')?.providerKey).toBe('groq');
  });

  it('préférence fournisseur : mise en tête de chaîne, secours conservé', () => {
    const { steps } = buildAiChain(makeSnapshot(), { role: 'business_advisor', preferProvider: 'deepseek' }, configured);
    expect(steps[0].providerKey).toBe('deepseek');
    expect(steps.length).toBeGreaterThanOrEqual(2);
  });

  it('plafonne la longueur de chaîne (anti-boucle)', () => {
    const snap = makeSnapshot();
    snap.rules = [];
    const { steps } = buildAiChain(snap, { maxChainLength: 2 }, configured);
    expect(steps.length).toBeLessThanOrEqual(2);
  });

  it('codes explicites : aucun configuré / aucun modèle', () => {
    expect(buildAiChain(makeSnapshot(), {}, new Set()).skipReason).toBe('NO_CONFIGURED_PROVIDER');
    const snap = makeSnapshot();
    snap.rules = [];
    const { skipReason } = buildAiChain(snap, { requireCapabilities: ['inexistante'] }, configured);
    expect(skipReason).toBe('NO_MATCHING_MODEL');
  });

  it('estime le coût uniquement à partir de prix connus (jamais inventés)', () => {
    expect(estimateCostUsd(0.075, 0.3, 1_000_000, 1_000_000)).toBe(0.375);
    expect(estimateCostUsd(null, 0.3, 100, 100)).toBeNull();
    expect(estimateCostUsd(0.1, null, 100, 100)).toBeNull();
    expect(estimateCostUsd(0.1, 0.2, null, 100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Moteur d'exécution — secours plafonné + journalisation
// ---------------------------------------------------------------------------

function makeEngineDeps(
  snapshot: AiRegistrySnapshot | null,
  fetcher: typeof fetch,
  configured = new Set(['groq', 'deepseek', 'openrouter', 'mistral']),
): AiEngineDeps & { logs: AiCallLogEntry[] } {
  const creds = { apiKey: 'test-key', accountId: 'acct' };
  const logs: AiCallLogEntry[] = [];
  return {
    loadRegistry: async () => snapshot,
    configuredProviders: () => configured,
    credentials: () => creds,
    fetcher,
    logCall: async (entry: AiCallLogEntry) => { logs.push(entry); },
    maxAttempts: 3,
    requestTimeoutMs: 8_000,
    logs,
  };
}

describe('moteur — appels unifiés et secours plafonné', () => {
  const messages: AiChatMessage[] = [{ role: 'user', content: 'Bonjour' }];

  it('réussite au premier essai : contenu, modèle, coût estimé, journal', async () => {
    const deps = makeEngineDeps(makeSnapshot(), okFetch(OPENAI_OK));
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe('Réponse du fournisseur.');
    expect(outcome.providerKey).toBe('groq');
    expect(outcome.providerModelKey).toBe('openai/gpt-oss-20b');
    expect(outcome.inputTokens).toBe(12);
    expect(outcome.outputTokens).toBe(34);
    expect(outcome.estimatedCostUsd).toBe(Math.round(((12 / 1e6) * 0.075 + (34 / 1e6) * 0.3) * 1e6) / 1e6);
    expect(outcome.attempts).toHaveLength(1);
    expect(deps.logs).toHaveLength(1);
    expect(deps.logs[0].attempts[0].status).toBe('success');
    expect(deps.logs[0].taskKey).toBe('business_advisor');
  });

  it('échec 429 puis secours : deux tentatives journalisées, succès final', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.groq.com')) {
        return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
      }
      return new Response(JSON.stringify(OPENAI_OK), { status: 200 });
    }) as unknown as typeof fetch;
    const deps = makeEngineDeps(makeSnapshot(), fetcher);
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor' });
    expect(outcome.ok).toBe(true);
    expect(outcome.providerKey).toBe('deepseek');
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0].errorCode).toBe('AI_RATE_LIMITED');
    expect(outcome.attempts[0].status).toBe('error');
    expect(outcome.attempts[1].status).toBe('success');
    expect(deps.logs).toHaveLength(1);
    expect(deps.logs[0].attempts).toHaveLength(2);
  });

  it('401 non réessayer à l’identique : bascule quand même de fournisseur, code explicite final', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'bad key' }), { status: 401 })) as unknown as typeof fetch;
    const deps = makeEngineDeps(makeSnapshot(), fetcher);
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor' });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('AI_AUTH_FAILED');
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.content).toBeNull();
  });

  it('plafonne le nombre de tentatives (anti-boucle)', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'down' }), { status: 503 })) as unknown as typeof fetch;
    const snap = makeSnapshot();
    snap.rules = [];
    const deps = makeEngineDeps(snap, fetcher);
    (deps as AiEngineDeps & { maxAttempts: number }).maxAttempts = 2;
    const outcome = await runAiCall(deps, { messages });
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('timeout réseau : tentative marquée « timeout », secours tenté', async () => {
    let first = true;
    const fetcher = vi.fn(async () => {
      if (first) {
        first = false;
        throw new Error('timeout');
      }
      return new Response(JSON.stringify(OPENAI_OK), { status: 200 });
    }) as unknown as typeof fetch;
    // Simule un AbortError (name TimeoutError).
    const origFetch = fetcher;
    const fetcher2 = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (first) {
        first = false;
        const err = new Error('The operation was aborted');
        err.name = 'TimeoutError';
        throw err;
      }
      return origFetch(input, init);
    }) as unknown as typeof fetch;
    const deps = makeEngineDeps(makeSnapshot(), fetcher2);
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor' });
    expect(outcome.ok).toBe(true);
    expect(outcome.attempts[0].status).toBe('timeout');
    expect(outcome.attempts[0].errorCode).toBe('AI_TIMEOUT');
    expect(outcome.attempts[1].status).toBe('success');
  });

  it('registre indisponible : code explicite, aucun appel fournisseur', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const deps = makeEngineDeps(null, fetcher);
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor' });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('REGISTRY_UNAVAILABLE');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('budget épuisé : code explicite, aucun appel', async () => {
    const snap = makeSnapshot({ budget: { monthly: 10, alert: 80, daily: null }, monthlySpendUsd: 50 });
    snap.models = snap.models.filter((m) => m.costIn !== 0);
    const fetcher = vi.fn() as unknown as typeof fetch;
    const deps = makeEngineDeps(snap, fetcher);
    const outcome = await runAiCall(deps, { messages });
    expect(outcome.code).toBe('BUDGET_EXHAUSTED');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('journalisation non bloquante : un échec de log n’échoue pas l’appel', async () => {
    const deps = makeEngineDeps(makeSnapshot(), okFetch(OPENAI_OK));
    deps.logCall = async () => { throw new Error('log down'); };
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor' });
    expect(outcome.ok).toBe(true);
  });
});
