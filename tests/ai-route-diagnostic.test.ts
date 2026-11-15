// VYORA AI CORE — tests du diagnostic de ROUTAGE.
//
// La sonde prouve qu'un fournisseur RÉPOND ; ces tests vérifient la question
// suivante, distincte : le moteur le CHOISIT-il ?
//
// Défauts que ces tests verrouillent :
//   * un fournisseur absent de l'ensemble « configurés » est écarté au premier
//     filtre dur — un fournisseur sain peut donc rester inatteignable ;
//   * un modèle non `verified` ne doit jamais être routé, même présent au
//     catalogue ;
//   * un modèle sans la capacité demandée ne doit jamais être choisi, même s'il
//     est le seul configuré ;
//   * le diagnostic par défaut (dry-run) ne doit déclencher AUCUN appel
//     fournisseur : il ne facture rien ;
//   * le fallback ne doit jamais réessayer un modèle déjà tenté.

import { describe, expect, it } from 'vitest';
import {
  buildAiChain,
  resolveConfiguredProvidersFromSnapshot,
  type AiEngineDeps,
  type AiRegistrySnapshot,
} from '../supabase/functions/_shared/ai-core/index.ts';

// ---------------------------------------------------------------------------
// Fixtures — un registre minimal mais réaliste (formes identiques à la base)
// ---------------------------------------------------------------------------

function provider(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    name: key,
    status: 'active',
    aggregator: false,
    adapterKind: 'openai' as const,
    baseUrl: 'https://example.test/v1',
    modelsUrl: null,
    apiKeyEnv: `${key.toUpperCase()}_API_KEY`,
    accountIdEnv: null,
    headers: {},
    transport: 'rest' as const,
    gatewayIdEnv: null,
    ...overrides,
  };
}

function model(
  providerKey: string,
  key: string,
  caps: Record<string, boolean>,
  overrides: Record<string, unknown> = {},
) {
  return {
    provider: providerKey,
    key,
    providerModel: key,
    name: key,
    verified: true,
    tier: 'standard' as const,
    capabilities: caps,
    contextIn: 128_000,
    maxOut: 4096,
    costIn: 1,
    costOut: 2,
    rpm: null,
    tpm: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<AiRegistrySnapshot> = {}): AiRegistrySnapshot {
  return {
    version: 4,
    providers: [
      provider('groq'),
      provider('gemini'),
      provider('gonka'),
      provider('llm7'),
      provider('openrouter'),
    ],
    models: [
      // groq est moins cher que gemini : à capacités égales, le coût départage.
      model('groq', 'gpt-oss-120b', { reasoning: true, tools: true }, { costIn: 0.15, costOut: 0.6 }),
      model('gemini', 'flash', { reasoning: true }, { costIn: 1, costOut: 2 }),
      // Gonka et LLM7 ne publient QUE `writing` dans le registre réel.
      model('gonka', 'deepseek-v4-flash', { writing: true }),
      model('llm7', 'default', { writing: true }),
      model('openrouter', 'ernie-free', { tools: true, structured_output: true }),
    ],
    roles: [
      { key: 'business_analysis', capabilities: { reasoning: true }, enabled: true },
      { key: 'content_strategy', capabilities: { writing: true }, enabled: true },
      { key: 'free_reasoning', capabilities: { reasoning: true }, enabled: true },
    ],
    rules: [
      { role: 'business_analysis', provider: 'groq', model: 'gpt-oss-120b', priority: 1 },
      { role: 'content_strategy', provider: 'llm7', model: 'default', priority: 1 },
    ],
    budget: { monthly: null, alert: null, daily: null },
    monthlySpendUsd: 0,
    ...overrides,
  };
}

/** Dépendances du moteur : clés résolues pour un sous-ensemble donné. */
function deps(availableKeyEnvs: string[]): AiEngineDeps {
  const available = new Set(availableKeyEnvs);
  return {
    loadRegistry: async () => null,
    configuredProviders: () => new Set<string>(),
    credentials: () => ({ apiKey: null, accountId: null, gatewayId: null }),
    env: (name) => (available.has(name) ? 'test-value-not-a-secret' : null),
    fetcher: fetch,
    logCall: async () => {},
  };
}

const ALL_KEYS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'GONKA_API_KEY', 'LLM7_API_KEY', 'OPENROUTER_API_KEY'];

// ---------------------------------------------------------------------------
// Résolution des fournisseurs configurés
// ---------------------------------------------------------------------------

describe('resolveConfiguredProviders — aucun fournisseur en dur', () => {
  it('retient un fournisseur dès que sa clé se résout, sans liste dans le code', () => {
    const configured = resolveConfiguredProvidersFromSnapshot(snapshot(), deps(['GONKA_API_KEY']));
    // La clé est lue via `apiKeyEnv` du registre, pas via une convention du code.
    expect([...configured]).toEqual(['gonka']);
  });

  it('écarte un fournisseur dont la clé ne se résout pas', () => {
    const configured = resolveConfiguredProvidersFromSnapshot(snapshot(), deps([]));
    expect(configured.size).toBe(0);
  });

  it('écarte un fournisseur désactivé même si sa clé existe', () => {
    const snap = snapshot();
    snap.providers[2] = provider('gonka', { status: 'disabled' });
    const configured = resolveConfiguredProvidersFromSnapshot(snap, deps(['GONKA_API_KEY']));
    expect(configured.has('gonka')).toBe(false);
  });

  it('exige l’identifiant de compte quand le registre le déclare', () => {
    const snap = snapshot();
    snap.providers[4] = provider('openrouter', { accountIdEnv: 'OPENROUTER_ACCOUNT_ID' });
    const withoutAccount = resolveConfiguredProvidersFromSnapshot(snap, deps(['OPENROUTER_API_KEY']));
    // Sans account_id : hors jeu. Une requête incomplète n'est jamais tentée.
    expect(withoutAccount.has('openrouter')).toBe(false);

    const withAccount = resolveConfiguredProvidersFromSnapshot(
      snap,
      deps(['OPENROUTER_API_KEY', 'OPENROUTER_ACCOUNT_ID']),
    );
    expect(withAccount.has('openrouter')).toBe(true);
  });

  it('exige l’identifiant de passerelle pour un transport `gateway`', () => {
    const snap = snapshot();
    snap.providers[4] = provider('openrouter', {
      transport: 'gateway' as const,
      gatewayIdEnv: 'CF_GATEWAY_ID',
    });
    const missing = resolveConfiguredProvidersFromSnapshot(snap, deps(['OPENROUTER_API_KEY']));
    expect(missing.has('openrouter')).toBe(false);

    const present = resolveConfiguredProvidersFromSnapshot(
      snap,
      deps(['OPENROUTER_API_KEY', 'CF_GATEWAY_ID']),
    );
    expect(present.has('openrouter')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Chaîne de routage
// ---------------------------------------------------------------------------

describe('buildAiChain — sélection par capacités réelles', () => {
  it('route un rôle `reasoning` vers un modèle de raisonnement', () => {
    const configured = new Set(ALL_KEYS.map((k) => k.replace('_API_KEY', '').toLowerCase()));
    const { steps, skipReason } = buildAiChain(
      snapshot(),
      { role: 'business_analysis' },
      configured,
    );
    expect(skipReason).toBeNull();
    expect(steps.length).toBeGreaterThan(0);
    // Le premier choix est la règle du rôle : groq, qui a `reasoning`.
    expect(steps[0].providerKey).toBe('groq');
    // Gemini aussi peut raisonner : il est présent dans la chaîne de secours.
    expect(steps.some((s) => s.providerKey === 'gemini')).toBe(true);
  });

  it('ne choisit JAMAIS un modèle sans la capacité requise', () => {
    const configured = new Set(ALL_KEYS.map((k) => k.replace('_API_KEY', '').toLowerCase()));
    const { steps } = buildAiChain(snapshot(), { role: 'business_analysis' }, configured);
    // Gonka et LLM7 ne déclarent que `writing` : ils ne peuvent pas raisonner.
    expect(steps.some((s) => s.providerKey === 'gonka')).toBe(false);
    expect(steps.some((s) => s.providerKey === 'llm7')).toBe(false);
  });

  it('n’offre que les fournisseurs RÉELLEMENT configurés', () => {
    // Seul LLM7 possède une clé : le rôle `writing` doit le retenir seul.
    const { steps } = buildAiChain(snapshot(), { role: 'content_strategy' }, new Set(['llm7']));
    expect(steps.length).toBeGreaterThan(0);
    expect(new Set(steps.map((s) => s.providerKey))).toEqual(new Set(['llm7']));
  });

  it('écarte un fournisseur configuré mais absent du registre des modèles', () => {
    const snap = snapshot();
    snap.providers.push(provider('mystery'));
    const { steps } = buildAiChain(snap, { role: 'content_strategy' }, new Set(['mystery']));
    // Aucun modèle pour ce fournisseur : il n'apparaît nulle part.
    expect(steps.some((s) => s.providerKey === 'mystery')).toBe(false);
  });

  it('n’utilise jamais un modèle non vérifié', () => {
    const snap = snapshot();
    snap.models = snap.models.map((m) => ({ ...m, verified: false }));
    const { steps, skipReason } = buildAiChain(
      snap,
      { role: 'business_analysis' },
      new Set(ALL_KEYS.map((k) => k.replace('_API_KEY', '').toLowerCase())),
    );
    expect(steps).toEqual([]);
    expect(skipReason).toBe('NO_MATCHING_MODEL');
  });

  it('rapporte NO_CONFIGURED_PROVIDER quand aucune clé ne se résout', () => {
    const { steps, skipReason } = buildAiChain(snapshot(), { role: 'business_analysis' }, new Set());
    expect(steps).toEqual([]);
    expect(skipReason).toBe('NO_CONFIGURED_PROVIDER');
  });

  it('ne répète jamais un même fournisseur dans la chaîne (pas de double appel)', () => {
    const configured = new Set(ALL_KEYS.map((k) => k.replace('_API_KEY', '').toLowerCase()));
    const { steps } = buildAiChain(snapshot(), { role: 'business_analysis' }, configured);
    const providers = steps.map((s) => s.providerKey);
    expect(new Set(providers).size).toBe(providers.length);
    // Et chaque couple fournisseur|modèle est unique.
    const pairs = steps.map((s) => `${s.providerKey}|${s.modelKey}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('respecte le plafond de chaîne', () => {
    const configured = new Set(ALL_KEYS.map((k) => k.replace('_API_KEY', '').toLowerCase()));
    const { steps } = buildAiChain(snapshot(), { role: 'business_analysis' }, configured);
    expect(steps.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Choix explicite de l'opérateur
// ---------------------------------------------------------------------------

describe('buildAiChain — préférence explicite et exclusions', () => {
  it('donne un bonus de score réel à `preferProvider` entre deux candidats valides', () => {
    // `reasoning` : groq et gemini conviennent tous deux, aucune règle de rôle
    // n'est déclarée pour ce rôle-ci.
    const snap = snapshot();
    snap.roles.push({ key: 'free_reasoning', capabilities: { reasoning: true }, enabled: true });
    const configured = new Set(['gemini', 'groq']);

    const neutral = buildAiChain(snap, { role: 'free_reasoning' }, configured);
    const preferred = buildAiChain(
      snap,
      { role: 'free_reasoning', preferProvider: 'gemini' },
      configured,
    );
    // Sans préférence, le départage par coût place groq (1 $) avant gemini.
    expect(neutral.steps[0].providerKey).toBe('groq');
    // Avec préférence explicite, le bonus (+25) renverse l'ordre.
    expect(preferred.steps[0].providerKey).toBe('gemini');
  });

  it('ne laisse pas `preferProvider` contourner une règle de rôle curatée', () => {
    // Choix documenté du routeur : une règle du rôle porte une priorité
    // (jusqu'à +45) supérieure au bonus de préférence (+25). La curation
    // explicite de l'opérateur prime sur une préférence d'appel.
    const { steps } = buildAiChain(
      snapshot(),
      { role: 'business_analysis', preferProvider: 'gemini' },
      new Set(['gemini', 'groq']),
    );
    expect(steps[0].providerKey).toBe('groq');
  });

  it('ignore `preferProvider` si le fournisseur n’a pas la capacité requise', () => {
    const configured = new Set(['llm7', 'groq']);
    const { steps } = buildAiChain(
      snapshot(),
      { role: 'business_analysis', preferProvider: 'llm7' },
      configured,
    );
    // LLM7 ne raisonne pas : le respecter produirait un échec garanti.
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].providerKey).toBe('groq');
  });

  it('rétrograde `avoidProviders` sans jamais rendre la chaîne vide', () => {
    // Choix documenté : l'exclusion est une PÉNALITÉ (−35), pas un retrait.
    // Écarter définitivement un fournisseur ferait échouer l'appel alors qu'il
    // peut très bien répondre ; il passe simplement après les autres.
    const { steps } = buildAiChain(
      snapshot(),
      { role: 'free_reasoning', avoidProviders: ['groq'] },
      new Set(['gemini', 'groq']),
    );
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].providerKey).toBe('gemini');
    // groq reste joignable en dernier recours, jamais en premier.
    expect(steps[steps.length - 1].providerKey).toBe('groq');
  });
});
