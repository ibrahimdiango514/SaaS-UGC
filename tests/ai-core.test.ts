// VYORA AI CORE — tests unitaires : adaptateurs (7 fournisseurs), registre,
// routage intelligent, moteur d'exécution (secours plafonné, journalisation).
//
// Aucune clé réelle : chaque appel réseau est un fetch simulé ; on vérifie le
// contrat de chaque fournisseur (URL, en-têtes, corps, parsing des tokens) et
// les règles de routage/budget/anti-boucle du moteur.
import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_ADAPTERS,
  resolveAiAdapter,
  type AiProviderDescriptor,
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

/**
 * Descripteur de fournisseur tel que le registre le fournit : c'est LUI qui
 * décrit le protocole. Le code ne contient plus de liste fermée de fournisseurs.
 */
const DESCRIPTORS: Record<string, { kind: AiProviderDescriptor['kind']; baseUrl: string; modelsUrl: string | null; headers?: Record<string, string> }> = {
  groq: { kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', modelsUrl: null },
  gemini: { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelsUrl: null },
  deepseek: { kind: 'openai', baseUrl: 'https://api.deepseek.com', modelsUrl: 'https://api.deepseek.com/models' },
  mistral: { kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', modelsUrl: null },
  grok: { kind: 'openai', baseUrl: 'https://api.x.ai/v1', modelsUrl: null },
  cloudflare: { kind: 'cloudflare', baseUrl: 'https://api.cloudflare.com/client/v4', modelsUrl: null },
  openrouter: {
    kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', modelsUrl: null,
    headers: { 'HTTP-Referer': 'https://vyora-ugc.netlify.app', 'X-Title': 'VYORA' },
  },
};

function descriptor(overrides: Partial<AiRegistrySnapshot['providers'][number]> & { key: string }) {
  const base = DESCRIPTORS[overrides.key] ?? { kind: 'openai' as const, baseUrl: 'https://example.test/v1', modelsUrl: null };
  return {
    name: overrides.key,
    status: 'available',
    aggregator: false,
    adapterKind: base.kind,
    baseUrl: base.baseUrl,
    modelsUrl: base.modelsUrl,
    apiKeyEnv: `${overrides.key.toUpperCase().replace(/-/g, '_')}_API_KEY`,
    accountIdEnv: null,
    gatewayIdEnv: null,
    transport: 'rest' as const,
    headers: base.headers ?? {},
    ...overrides,
  };
}

/** Adaptateur d'un fournisseur, tel que le moteur le construit depuis le registre. */
function adapterFor(key: string) {
  const row = descriptor({ key });
  return resolveAiAdapter({
    key: row.key,
    kind: row.adapterKind,
    baseUrl: row.baseUrl ?? '',
    apiKeyEnv: row.apiKeyEnv,
    modelsUrl: row.modelsUrl,
    headers: row.headers,
  });
}

function makeSnapshot(overrides: Partial<AiRegistrySnapshot> = {}): AiRegistrySnapshot {
  return {
    version: 2,
    providers: [
      descriptor({ key: 'groq', status: 'available' }),
      descriptor({ key: 'deepseek', status: 'available' }),
      descriptor({ key: 'openrouter', status: 'available', aggregator: true }),
      descriptor({ key: 'mistral', status: 'available' }),
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

  it('construit un adaptateur OpenAI-compatible depuis le registre (aucune liste en dur)', () => {
    const adapter = adapterFor('un-fournisseur-inconnu');
    const req = adapter!.buildRequest({ credentials: creds, model: 'modele-x', messages, options: { temperature: 0.4, maxOutputTokens: 512 } });
    expect(req.url).toBe('https://example.test/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer test-key');
    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe('modele-x');
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(0.4);
    expect(adapter!.parse(OPENAI_OK).inputTokens).toBe(12);
  });

  it('groq : protocole historique inchangé (URL, Bearer, corps, tokens)', () => {
    const adapter = adapterFor('groq')!;
    const req = adapter.buildRequest({ credentials: creds, model: 'openai/gpt-oss-20b', messages, options: { temperature: 0.7, maxOutputTokens: 1000 } });
    expect(req.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer test-key');
    expect((req.body as Record<string, unknown>).max_tokens).toBe(1000);
    expect(adapter.parse(OPENAI_OK).content).toBe('Réponse du fournisseur.');
  });

  it('gemini : adaptateur natif (URL du modèle, x-goog-api-key, systemInstruction)', () => {
    const adapter = adapterFor('gemini')!;
    const req = adapter.buildRequest({ credentials: creds, model: 'gemini-2.5-flash', messages });
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(req.headers['x-goog-api-key']).toBe('test-key');
    const body = req.body as Record<string, unknown>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Système.' }] });
    expect((body.contents as unknown[]).map((c) => (c as { role: string }).role)).toEqual(['user']);
    const parsed = adapter.parse({
      candidates: [{ content: { parts: [{ text: '  Bonjour !  ' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 21 },
    });
    expect(parsed.content).toBe('Bonjour !');
    expect(parsed.outputTokens).toBe(21);
  });

  it('deepseek / mistral / grok : URLs fournies par le registre, protocole OpenAI', () => {
    expect(adapterFor('deepseek')!.buildRequest({ credentials: creds, model: 'deepseek-chat', messages }).url)
      .toBe('https://api.deepseek.com/chat/completions');
    expect(adapterFor('mistral')!.buildRequest({ credentials: creds, model: 'mistral-small-latest', messages }).url)
      .toBe('https://api.mistral.ai/v1/chat/completions');
    expect(adapterFor('grok')!.buildRequest({ credentials: creds, model: 'grok-4.7', messages }).url)
      .toBe('https://api.x.ai/v1/chat/completions');
  });

  it('cloudflare (voie REST) : endpoint officiel par compte, erreur sans compte', () => {
    const adapter = adapterFor('cloudflare')!;
    const req = adapter.buildRequest({
      credentials: { apiKey: 'cf-token', accountId: 'acct-123' },
      model: '@cf/qwen/qwen3.8-27b', messages,
    });
    // Endpoint OpenAI-compatible documenté par Cloudflare (REST API).
    expect(req.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer cf-token');
    expect(() => adapter.buildRequest({
      credentials: { apiKey: 'cf-token', accountId: null },
      model: '@cf/qwen/qwen3.8-27b', messages,
    })).toThrow(AiProviderError);
  });

  it('cloudflare (voie PASSELLE) : jeton dédié, passerelle exigée, URL exacte', () => {
    const adapter = resolveAiAdapter({
      key: 'cloudflare', kind: 'cloudflare',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1',
      apiKeyEnv: 'CF_TOKEN', modelsUrl: null, headers: {},
      transport: 'gateway',
    })!;
    const req = adapter.buildRequest({
      credentials: { apiKey: 'cfut-token', accountId: 'acct123', gatewayId: 'vyora' },
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages,
    });
    expect(req.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct123/vyora/workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    );
    // Le jeton de passerelle se présente en `cf-aig-authorization`, jamais en
    // `Authorization` : les deux jetons Cloudflare ne sont pas interchangeables.
    expect(req.headers['cf-aig-authorization']).toBe('Bearer cfut-token');
    expect(req.headers.Authorization).toBeUndefined();
    // Sans identifiant de passerelle : erreur explicite, aucune requête.
    expect(() => adapter.buildRequest({
      credentials: { apiKey: 'cfut-token', accountId: 'acct123', gatewayId: null },
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages,
    })).toThrow(/AI_ACCOUNT_NOT_CONFIGURED/);
  });

  it('openrouter (agrégateur) : en-têtes d’attribution portés par le registre', () => {
    const req = adapterFor('openrouter')!.buildRequest({ credentials: creds, model: 'openai/gpt-oss-20b', messages });
    expect(req.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(req.headers['HTTP-Referer']).toBeTruthy();
    expect(req.headers['X-Title']).toBe('VYORA');
    expect(req.headers.Authorization).toBe('Bearer test-key');
  });

  it('refuse un appel non configuré, un contexte vide ou un protocole non supporté', () => {
    for (const key of Object.keys(DESCRIPTORS)) {
      const adapter = adapterFor(key)!;
      // Le token d'accès est porté par les credentials du fournisseur, jamais
      // par une constante du code : sans lui, aucun appel ne part.
      expect(() => adapter.buildRequest({ credentials: { apiKey: null }, model: 'm', messages }))
        .toThrow(/configur|clé|token|API_KEY|AI_NOT_CONFIGURED/i);
      expect(() => adapter.buildRequest({ credentials: creds, model: 'm', messages: [] }))
        .toThrow(AiProviderError);
    }
    // Protocole non supporté : le moteur refuse proprement au lieu d'envoyer
    // une requête mal formée (le fournisseur est listé, jamais appelé).
    expect(resolveAiAdapter({ key: 'exotique', kind: 'none', baseUrl: 'https://exotique.test', apiKeyEnv: null })).toBeNull();
    expect(resolveAiAdapter({ key: 'sans-url', kind: 'openai', baseUrl: '', apiKeyEnv: null })).toBeNull();
    expect(() => NATIVE_ADAPTERS.groq.parse({ choices: [] })).toThrow(AiProviderError);
  });

  it('nom de base normalisé (déduplication agrégateur/direct)', () => {
    expect(modelBaseKey('google/gemini-4-hydrogen')).toBe('gemini-4-hydrogen');
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

  it('suit les priorités des règles du rôle, puis complète par le catalogue vérifié', () => {
    const { steps, skipReason } = buildAiChain(makeSnapshot(), { role: 'business_advisor' }, configured);
    expect(skipReason).toBeNull();
    // Les règles du rôle passent devant : groq (priorité 1) puis deepseek (2).
    expect(steps.slice(0, 2).map((s) => s.providerKey)).toEqual(['groq', 'deepseek']);
    expect(steps[0].providerModelKey).toBe('openai/gpt-oss-20b');
    expect(steps[0].reason).toBe('role_rule');
    // Au-delà des règles, le moteur complète avec le CATALOGUE vérifié : un rôle
    // dont les règles sont indisponibles conserve un secours réel.
    expect(steps.some((s) => s.reason === 'catalog')).toBe(true);
    expect(steps.every((s) => configured.has(s.providerKey))).toBe(true);
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
    // business_analysis exige "reasoning" : tous les modèles de la chaîne l'ont,
    // et la règle du rôle (deepseek-v4-pro) reste en tête.
    const { steps } = buildAiChain(makeSnapshot(), { role: 'business_analysis' }, configured);
    expect(steps[0].providerKey).toBe('deepseek');
    expect(steps[0].modelKey).toBe('v4-pro');
    const snapshot = makeSnapshot();
    for (const step of steps) {
      const model = snapshot.models.find((m) => m.provider === step.providerKey && m.key === step.modelKey);
      expect(model?.capabilities.reasoning, `${step.providerKey}/${step.modelKey}`).toBe(true);
    }
  });

  it('écarte un modèle dont le contexte publié est trop court pour la demande', () => {
    const { steps } = buildAiChain(makeSnapshot(), { minContextTokens: 200_000 }, configured);
    // Seul deepseek-v4-pro publie 1M de contexte dans la fixture.
    expect(steps.map((s) => s.modelKey)).toEqual(['v4-pro']);
    // Demande impossible → aucun modèle, code explicite (jamais un dépassement silencieux).
    const { steps: none, skipReason } = buildAiChain(makeSnapshot(), { minContextTokens: 5_000_000 }, configured);
    expect(none).toHaveLength(0);
    expect(skipReason).toBe('NO_MATCHING_MODEL');
  });

  it('applique un plafond de coût publié (prix inconnu écarté)', () => {
    const { steps } = buildAiChain(makeSnapshot(), { maxCostInPerMtok: 0.1 }, configured);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.costIn !== null && s.costIn <= 0.1)).toBe(true);
  });

  it('privilégie le niveau demandé sans jamais laisser la chaîne vide', () => {
    const snap = makeSnapshot();
    const { steps } = buildAiChain(snap, { level: 'advanced' }, configured);
    // Le niveau est un critère d'ORDONNANCEMENT : le modèle avancé passe devant,
    // les autres niveaux restent en secours (une panne ne doit pas bloquer l'appel).
    expect(steps[0].tier).toBe('advanced');
    expect(steps.map((s) => s.modelKey)).toContain('v4-pro');
    // Niveau inexistant → aucun modèle de ce niveau, chaîne non vide malgré tout.
    const { steps: relaxed } = buildAiChain(snap, { level: 'specialized' }, configured);
    expect(relaxed.length).toBeGreaterThan(0);
  });

  it('diversifie le secours : un modèle par fournisseur avant un second du même', () => {
    const { steps } = buildAiChain(makeSnapshot(), { maxChainLength: 6 }, configured);
    const providers = steps.map((s) => s.providerKey);
    // Les premiers essais couvrent des fournisseurs DIFFÉRENTS : un incident
    // fournisseur ne consomme qu'une tentative avant la bascule.
    const firstRepeat = providers.findIndex((key, index) => providers.indexOf(key) !== index);
    const distinctBeforeRepeat = firstRepeat === -1 ? providers.length : firstRepeat;
    expect(distinctBeforeRepeat).toBeGreaterThanOrEqual(3);
    expect(steps.length).toBeGreaterThan(distinctBeforeRepeat);
  });

  it('relègue un fournisseur marqué comme venant d’échouer', () => {
    const { steps } = buildAiChain(
      makeSnapshot(),
      { role: 'business_advisor', avoidProviders: ['groq'] },
      configured,
    );
    expect(steps[0].providerKey).not.toBe('groq');
    expect(steps.map((s) => s.providerKey)).toContain('groq');
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
    // Une clé refusée n'est jamais réessayée à l'identique : le moteur bascule
    // sur les autres fournisseurs de la chaîne, dans la limite des tentatives.
    expect(outcome.attempts).toHaveLength(3);
    expect(new Set(outcome.attempts.map((a) => a.providerKey)).size).toBe(3);
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

  it('idempotence — appel déjà en cours : aucun appel fournisseur, aucun coût', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const deps = makeEngineDeps(makeSnapshot(), fetcher);
    const released: unknown[] = [];
    deps.claimCall = async () => ({ claimed: false, status: 'in_flight', providerKey: 'groq', modelKey: 'gpt-oss-20b', outcomeCode: null });
    deps.releaseCall = (params) => { released.push(params); };
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor', requestKey: 'req-1' });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('AI_DUPLICATE_IN_FLIGHT');
    expect(outcome.duplicate).toBe(true);
    expect(outcome.attempts).toHaveLength(0);
    // Le verrou appartient à l'appel en cours : il ne doit pas être libéré.
    expect(released).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(deps.logs).toHaveLength(0);
  });

  it('idempotence — verrou obtenu : appel réel puis libération en succès', async () => {
    const deps = makeEngineDeps(makeSnapshot(), okFetch(OPENAI_OK));
    const released: Array<Record<string, unknown>> = [];
    deps.claimCall = async () => ({ claimed: true, status: 'in_flight', providerKey: null, modelKey: null, outcomeCode: null });
    deps.releaseCall = async (params) => { released.push(params as unknown as Record<string, unknown>); };
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor', requestKey: 'req-2' });
    expect(outcome.ok).toBe(true);
    expect(released).toHaveLength(1);
    expect(released[0].status).toBe('succeeded');
    expect(released[0].providerKey).toBe('groq');
    expect(released[0].contentChars).toBe('Réponse du fournisseur.'.length);
  });

  it('idempotence — échec total : libération en échec avec le dernier code', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'down' }), { status: 503 })) as unknown as typeof fetch;
    const deps = makeEngineDeps(makeSnapshot(), fetcher);
    const released: Array<Record<string, unknown>> = [];
    deps.claimCall = async () => ({ claimed: true, status: 'in_flight', providerKey: null, modelKey: null, outcomeCode: null });
    deps.releaseCall = async (params) => { released.push(params as unknown as Record<string, unknown>); };
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor', requestKey: 'req-3' });
    expect(outcome.ok).toBe(false);
    expect(released).toHaveLength(1);
    expect(released[0].status).toBe('failed');
    expect(released[0].outcomeCode).toBe('AI_UNAVAILABLE');
  });

  it('idempotence — verrou indisponible : l’appel continue normalement', async () => {
    const deps = makeEngineDeps(makeSnapshot(), okFetch(OPENAI_OK));
    deps.claimCall = async () => { throw new Error('lease down'); };
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor', requestKey: 'req-4' });
    expect(outcome.ok).toBe(true);
  });

  it('traçabilité — journal de routage : chaîne, score, coût, décision', async () => {
    const deps = makeEngineDeps(makeSnapshot(), okFetch(OPENAI_OK));
    const routing: Array<Record<string, unknown>> = [];
    deps.logRouting = async (entry) => { routing.push(entry as unknown as Record<string, unknown>); };
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor', space: 'business', taskKey: 'advice' });
    expect(outcome.ok).toBe(true);
    expect(routing).toHaveLength(1);
    const entry = routing[0] as { chain: Array<{ provider: string; score: number; reason: string }>; chosenProvider: string; skipReason: null; space: string };
    expect(entry.chosenProvider).toBe('groq');
    expect(entry.skipReason).toBeNull();
    expect(entry.space).toBe('business');
    expect(entry.chain[0].provider).toBe('groq');
    expect(entry.chain[0].reason).toBe('role_rule');
    expect(typeof entry.chain[0].score).toBe('number');
    // Le score est aussi journalisé dans la tentative réellement facturée.
    expect(outcome.attempts[0].routedBy).toBe('role_rule');
    expect(outcome.attempts[0].score).toBe(entry.chain[0].score);
  });

  it('traçabilité — échec total : décision journalisée avec le code de rejet', async () => {
    const deps = makeEngineDeps(makeSnapshot(), vi.fn() as unknown as typeof fetch);
    const routing: Array<Record<string, unknown>> = [];
    deps.logRouting = async (entry) => { routing.push(entry as unknown as Record<string, unknown>); };
    const outcome = await runAiCall(deps, { messages, requireCapabilities: ['inexistante'] });
    expect(outcome.ok).toBe(false);
    expect(routing).toHaveLength(1);
    expect(routing[0].skipReason).toBe('NO_MATCHING_MODEL');
    expect(routing[0].chosenProvider).toBeNull();
  });

  it('traçabilité — un journal de routage en panne ne casse pas l’appel', async () => {
    const deps = makeEngineDeps(makeSnapshot(), okFetch(OPENAI_OK));
    deps.logRouting = async () => { throw new Error('routing log down'); };
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor' });
    expect(outcome.ok).toBe(true);
  });

  it('descripteur gateway sans GATEWAY_ID : fournisseur écarté, aucun appel incomplet', async () => {
    // Le fournisseur est déclaré côté passerelle mais l'identifiant de
    // passerelle n'est pas fourni : il ne doit pas être tenté du tout.
    const snap = makeSnapshot({
      providers: [
        descriptor({
          key: 'cloudflare', status: 'available', adapterKind: 'cloudflare',
          baseUrl: 'https://gateway.ai.cloudflare.com/v1',
          apiKeyEnv: 'CLOUDFLARE_API_TOKEN', accountIdEnv: 'CLOUDFLARE_ACCOUNT_ID',
          gatewayIdEnv: 'CLOUDFLARE_GATEWAY_ID', transport: 'gateway',
        }),
        descriptor({ key: 'groq', status: 'available' }),
      ],
    });
    snap.rules = [];
    const called: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      called.push(String(input));
      return new Response(JSON.stringify(OPENAI_OK), { status: 200 });
    }) as unknown as typeof fetch;
    const deps = makeEngineDeps(snap, fetcher, new Set());
    deps.env = (name) => {
      if (name === 'CLOUDFLARE_API_TOKEN') return 'cfut-token';
      if (name === 'CLOUDFLARE_ACCOUNT_ID') return 'acct123';
      return null; // CLOUDFLARE_GATEWAY_ID absent
    };
    const outcome = await runAiCall(deps, { messages });
    expect(outcome.ok).toBe(true);
    expect(outcome.providerKey).toBe('groq');
    expect(called.every((url) => !url.includes('gateway.ai.cloudflare.com'))).toBe(true);
    expect(outcome.attempts.some((a) => a.providerKey === 'cloudflare')).toBe(false);
  });

  it('descripteur gateway avec GATEWAY_ID : le fournisseur redevient éligible', async () => {
    const snap = makeSnapshot({
      providers: [
        descriptor({
          key: 'cloudflare', status: 'available', adapterKind: 'cloudflare',
          baseUrl: 'https://gateway.ai.cloudflare.com/v1',
          apiKeyEnv: 'CLOUDFLARE_API_TOKEN', accountIdEnv: 'CLOUDFLARE_ACCOUNT_ID',
          gatewayIdEnv: 'CLOUDFLARE_GATEWAY_ID', transport: 'gateway',
        }),
      ],
    });
    snap.models = [
      {
        provider: 'cloudflare', key: 'llama-fast', providerModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        name: 'Llama 3.3 70B (Workers AI)', verified: true, tier: 'fast',
        capabilities: { writing: true }, contextIn: 128_000, maxOut: 8_000,
        costIn: null, costOut: null, rpm: null, tpm: null,
      },
    ];
    snap.rules = [];
    const deps = makeEngineDeps(snap, okFetch(OPENAI_OK), new Set());
    deps.env = (name) => {
      if (name === 'CLOUDFLARE_API_TOKEN') return 'cfut-token';
      if (name === 'CLOUDFLARE_ACCOUNT_ID') return 'acct123';
      if (name === 'CLOUDFLARE_GATEWAY_ID') return 'vyora-gw';
      return null;
    };
    const outcome = await runAiCall(deps, { messages });
    expect(outcome.ok).toBe(true);
    expect(outcome.providerKey).toBe('cloudflare');
    expect(outcome.providerModelKey).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });

  it('journalisation non bloquante : un échec de log n’échoue pas l’appel', async () => {
    const deps = makeEngineDeps(makeSnapshot(), okFetch(OPENAI_OK));
    deps.logCall = async () => { throw new Error('log down'); };
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor' });
    expect(outcome.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fournisseurs DYNAMIQUES — aucune liste fermée dans le code
// ---------------------------------------------------------------------------

describe('moteur — fournisseurs déclarés par le registre uniquement', () => {
  const messages: AiChatMessage[] = [{ role: 'user', content: 'Bonjour' }];

  /** Snapshot minimal : un fournisseur qui n'existe NULLE PART dans le code. */
  function snapshotWithFictionalProvider(): AiRegistrySnapshot {
    return {
      version: 3,
      providers: [{
        key: 'fournisseur-nouveau',
        name: 'Fournisseur Nouveau',
        status: 'available',
        aggregator: false,
        adapterKind: 'openai',
        baseUrl: 'https://api.fournisseur-nouveau.test/v1',
        modelsUrl: null,
        apiKeyEnv: 'FOURNISSEUR_NOUVEAU_API_KEY',
        accountIdEnv: null,
        gatewayIdEnv: null,
        transport: 'rest',
        headers: {},
      }],
      models: [{
        provider: 'fournisseur-nouveau', key: 'modele-1', providerModel: 'modele-1',
        name: 'Modèle 1', verified: true, tier: 'fast',
        capabilities: { writing: true }, contextIn: 8_000, maxOut: 2_000,
        costIn: null, costOut: null, rpm: null, tpm: null,
      }],
      roles: [{ key: 'business_advisor', capabilities: {}, enabled: true }],
      rules: [{ role: 'business_advisor', provider: 'fournisseur-nouveau', model: 'modele-1', priority: 1 }],
      budget: { monthly: null, alert: 80, daily: null },
      monthlySpendUsd: 0,
    };
  }

  it('sert un fournisseur inconnu du code : clé résolue via api_key_env du registre', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(OPENAI_OK), { status: 200 })) as unknown as typeof fetch;
    const deps = makeEngineDeps(snapshotWithFictionalProvider(), fetcher, new Set());
    // Seule source de vérité : la variable d'environnement NOMMÉE par le registre.
    deps.env = (name) => (name === 'FOURNISSEUR_NOUVEAU_API_KEY' ? 'cle-du-fournisseur-nouveau' : null);

    const outcome = await runAiCall(deps, { messages, role: 'business_advisor' });

    expect(outcome.ok).toBe(true);
    expect(outcome.providerKey).toBe('fournisseur-nouveau');
    expect(outcome.providerModelKey).toBe('modele-1');
    const [url, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('https://api.fournisseur-nouveau.test/v1/chat/completions');
    expect(new Headers(init.headers as Record<string, string>).get('Authorization'))
      .toBe('Bearer cle-du-fournisseur-nouveau');
  });

  it('ne sert jamais un fournisseur sans clé, même déclaré et vérifié', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const deps = makeEngineDeps(snapshotWithFictionalProvider(), fetcher, new Set());
    deps.env = () => null;
    // Aucune intégration historique ne couvre ce fournisseur : aucun repli.
    deps.credentials = () => ({ apiKey: null, accountId: null });
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor' });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('NO_CONFIGURED_PROVIDER');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('protocole « none » : le fournisseur est listé mais jamais appelé', async () => {
    const snapshot = snapshotWithFictionalProvider();
    snapshot.providers[0].adapterKind = 'none';
    const fetcher = vi.fn() as unknown as typeof fetch;
    const deps = makeEngineDeps(snapshot, fetcher, new Set());
    deps.env = () => 'une-cle-quelconque';
    const outcome = await runAiCall(deps, { messages, role: 'business_advisor' });
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts[0].errorCode).toBe('UNSUPPORTED_PROVIDER');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('parsing du snapshot : descripteur de protocole conservé, valeurs invalides écartées', () => {
    const parsed = parseRegistrySnapshot({
      version: 3,
      providers: [
        { key: 'x1', name: 'X1', adapter_kind: 'gemini', base_url: 'https://x1.test/v1', api_key_env: 'X1_API_KEY', account_id_env: null, headers: { 'X-Title': 'VYORA', ignore: 42 } },
        { key: 'x2', adapter_kind: 'protocole-inconnu' },
        { key: 'X3!' },
      ],
    });
    expect(parsed?.providers).toHaveLength(2);
    expect(parsed?.providers[0]).toMatchObject({
      key: 'x1', adapterKind: 'gemini', baseUrl: 'https://x1.test/v1', apiKeyEnv: 'X1_API_KEY', headers: { 'X-Title': 'VYORA' },
    });
    // Gabarit inconnu → repli sur le protocole majoritaire, jamais une erreur.
    expect(parsed?.providers[1]).toMatchObject({ key: 'x2', adapterKind: 'openai', baseUrl: null, headers: {} });
  });
});
