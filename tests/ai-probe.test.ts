// VYORA AI CORE — tests des sondes de fournisseurs et du catalogue.
//
// Objectif : garantir qu'une sonde ne DÉPENSE jamais pour rien et ne déclare
// jamais un fournisseur opérationnel sans preuve.
//   * catalogue en échec → aucune complétion (donc aucune facture) ;
//   * complétion non testée → `completionOk = null` (jamais `true`) ;
//   * secret absent → `PROVIDER_NOT_CONFIGURED` sans aucun appel réseau ;
//   * 401 / 404 / 429 → codes explicites distincts ;
//   * passerelle : le jeton part en `cf-aig-authorization`, jamais en
//     `Authorization`, et l'identifiant de passerelle manquant bloque l'appel ;
//   * catalogue : prix inconnu = `null` (jamais 0), capacités jamais devinées.
import { describe, expect, it, vi } from 'vitest';
import {
  catalogHeaders,
  catalogUrl,
  normalizeCatalog,
  pickProbeModel,
  probeProvider,
  redactSecrets,
  errorDetailOf,
  conversationalModels,
  probeModelCandidates,
  type AiProbeDescriptor,
} from '../supabase/functions/_shared/ai-core/index.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const openAiDescriptor: AiProbeDescriptor = {
  key: 'openrouter',
  kind: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  modelsUrl: 'https://openrouter.ai/api/v1/models',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  accountIdEnv: null,
  headers: { 'X-Title': 'VYORA' },
};

const geminiDescriptor: AiProbeDescriptor = {
  key: 'gemini',
  kind: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  modelsUrl: null,
  apiKeyEnv: 'GEMINI_API_KEY',
  accountIdEnv: null,
  headers: {},
};

const cloudflareDescriptor: AiProbeDescriptor = {
  key: 'cloudflare',
  kind: 'cloudflare',
  baseUrl: 'https://api.cloudflare.com/client/v4',
  modelsUrl: null,
  apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
  accountIdEnv: 'CLOUDFLARE_ACCOUNT_ID',
  headers: {},
};

const OPENAI_CATALOG = {
  data: [
    {
      id: 'some-vendor/fast-model',
      name: 'Fast Model',
      context_length: 128000,
      pricing: { prompt: '0.000000075', completion: '0.0000003' },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'response_format'],
    },
    {
      id: 'some-vendor/no-price',
      name: 'No Price',
      context_length: 32000,
    },
  ],
};

const OPENAI_OK = {
  choices: [{ message: { role: 'assistant', content: 'OK' } }],
  usage: { prompt_tokens: 5, completion_tokens: 2 },
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

/** fetch simulé : renvoie la réponse associée au motif d'URL. */
function routedFetch(routes: Array<{ match: string; response: () => Response }>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    for (const route of routes) {
      if (url.includes(route.match)) return route.response();
    }
    return jsonResponse({ error: 'unexpected url', url, method }, 599);
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Catalogue — normalisation sans invention
// ---------------------------------------------------------------------------

describe('catalogue — normalisation des gabarits', () => {
  it('gabarit OpenAI : prix par jeton converti, capacités publiées reprises', () => {
    const { models, warning } = normalizeCatalog('openai', OPENAI_CATALOG);
    expect(warning).toBeNull();
    expect(models).toHaveLength(2);
    const fast = models.find((m) => m.providerModel === 'some-vendor/fast-model')!;
    expect(fast.costIn).toBe(0.075);
    expect(fast.costOut).toBe(0.3);
    expect(fast.contextIn).toBe(128000);
    expect(fast.capabilities).toMatchObject({ writing: true, tools: true, structured_output: true });
    // Aucune capacité non publiée n'est devinée.
    expect(fast.capabilities.vision).toBeUndefined();
    expect(fast.capabilities.reasoning).toBeUndefined();
  });

  it('gabarit OpenAI : prix absent = null (jamais 0) et note explicite', () => {
    const { models } = normalizeCatalog('openai', OPENAI_CATALOG);
    const noPrice = models.find((m) => m.providerModel === 'some-vendor/no-price')!;
    expect(noPrice.costIn).toBeNull();
    expect(noPrice.costOut).toBeNull();
    expect(noPrice.note).toBeTruthy();
  });

  it('gabarit OpenAI : prix nul publié = modèle gratuit (0, pas null)', () => {
    const { models } = normalizeCatalog('openai', {
      data: [{ id: 'free/model', pricing: { prompt: '0', completion: '0' } }],
    });
    expect(models[0].costIn).toBe(0);
    expect(models[0].costOut).toBe(0);
  });

  it('gabarit OpenAI : un modèle d’embeddings n’est jamais routé en conversation', () => {
    const { models } = normalizeCatalog('openai', {
      data: [{ id: 'BAAI/bge-m3', pricing: { prompt: '0.00000001' } }],
    });
    expect(models[0].capabilities).toEqual({ embeddings: true });
    expect(models[0].capabilities.writing).toBeUndefined();
    expect(models[0].tier).toBe('specialized');
  });

  it('gabarit Gemini : seuls les modèles de génération sont retenus', () => {
    const { models } = normalizeCatalog('gemini', {
      models: [
        { name: 'models/gemini-flash', displayName: 'Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000 },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/legacy', supportedGenerationMethods: ['countTokens'] },
      ],
    });
    expect(models.map((m) => m.providerModel)).toContain('gemini-flash');
    expect(models.map((m) => m.providerModel)).not.toContain('legacy');
    // Gemini ne publie pas de prix par API : coût inconnu, jamais estimé.
    expect(models.find((m) => m.providerModel === 'gemini-flash')!.costIn).toBeNull();
  });

  it('gabarit Cloudflare : `result[]` lu, capacités non inventées', () => {
    const { models } = normalizeCatalog('cloudflare', {
      result: [{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3' }],
    });
    expect(models).toHaveLength(1);
    expect(models[0].providerModel).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(models[0].costIn).toBeNull();
  });

  it('gabarit Ollama natif : `models[].name` lu', () => {
    const { models } = normalizeCatalog('openai', { models: [{ name: 'gpt-oss:120b', context_length: 131072 }] });
    expect(models[0].providerModel).toBe('gpt-oss:120b');
    expect(models[0].contextIn).toBe(131072);
    expect(models[0].costIn).toBeNull();
  });

  it('réponse vide ou de forme inconnue : aucun modèle inventé', () => {
    expect(normalizeCatalog('openai', null).models).toEqual([]);
    expect(normalizeCatalog('openai', null).warning).toBe('réponse vide');
    const unknown = normalizeCatalog('openai', { weird: true });
    expect(unknown.models).toEqual([]);
    expect(unknown.warning).toBe('forme de catalogue inconnue');
    expect(normalizeCatalog('openai', { data: [] }).warning).toBe('catalogue vide');
  });

  it('déduplique les identifiants de modèles', () => {
    const { models } = normalizeCatalog('openai', {
      data: [{ id: 'a/model' }, { id: 'a/model' }],
    });
    expect(models).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// URL et en-têtes de catalogue — aucune valeur de clé exposée
// ---------------------------------------------------------------------------

describe('sonde — URL et en-têtes de catalogue', () => {
  it('URL publiée par le registre prioritaire', () => {
    expect(catalogUrl(openAiDescriptor, { apiKey: 'k' })).toBe('https://openrouter.ai/api/v1/models');
  });

  it('URL déduite du gabarit quand le registre n’en publie pas', () => {
    expect(catalogUrl(geminiDescriptor, { apiKey: 'k' })).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models',
    );
  });

  it('Cloudflare sans identifiant de compte : pas d’URL de catalogue', () => {
    expect(catalogUrl(cloudflareDescriptor, { apiKey: 'k', accountId: null })).toBeNull();
    expect(catalogUrl(cloudflareDescriptor, { apiKey: 'k', accountId: 'acct' })).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct/ai/models',
    );
  });

  it('authentification : Bearer pour OpenAI, x-goog-api-key pour Gemini', () => {
    expect(catalogHeaders(openAiDescriptor, { apiKey: 'secret' }).Authorization).toBe('Bearer secret');
    expect(catalogHeaders(geminiDescriptor, { apiKey: 'secret' })['x-goog-api-key']).toBe('secret');
    expect(catalogHeaders(geminiDescriptor, { apiKey: 'secret' }).Authorization).toBeUndefined();
  });

  it('attribution du registre conservée dans les en-têtes', () => {
    expect(catalogHeaders(openAiDescriptor, { apiKey: 'secret' })['X-Title']).toBe('VYORA');
  });
});

// ---------------------------------------------------------------------------
// Sonde — respect de la dépense
// ---------------------------------------------------------------------------

describe('sonde — aucune dépense sans preuve', () => {
  it('secret absent : PROVIDER_NOT_CONFIGURED, zéro appel réseau', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const result = await probeProvider(openAiDescriptor, { apiKey: null }, 'some-vendor/fast-model', { fetcher });
    expect(result.configured).toBe(false);
    expect(result.catalogErrorCode).toBe('PROVIDER_NOT_CONFIGURED');
    expect(result.completionOk).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('catalogue en 401 : aucune complétion tentée, code explicite', async () => {
    const fetcher = routedFetch([{ match: '/models', response: () => jsonResponse({ error: 'bad key' }, 401) }]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'bad' }, 'some-vendor/fast-model', { fetcher });
    expect(result.reached).toBe('catalog');
    expect(result.catalogOk).toBe(false);
    expect(result.catalogHttpStatus).toBe(401);
    expect(result.catalogErrorCode).toBe('PROVIDER_AUTH_FAILED');
    // Preuve de non-dépense : une seule requête, en lecture.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.completionOk).toBeNull();
  });

  it('catalogue en 404 : endpoint de catalogue absent, aucune complétion', async () => {
    const fetcher = routedFetch([{ match: '/models', response: () => jsonResponse({}, 404) }]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'some-vendor/fast-model', { fetcher });
    expect(result.catalogErrorCode).toBe('PROVIDER_MODELS_ENDPOINT_MISSING');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.completionOk).toBeNull();
  });

  it('catalogue en 429 : quota fournisseur, aucune complétion', async () => {
    const fetcher = routedFetch([{ match: '/models', response: () => jsonResponse({}, 429) }]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'some-vendor/fast-model', { fetcher });
    expect(result.catalogErrorCode).toBe('PROVIDER_RATE_LIMITED');
    expect(result.completionOk).toBeNull();
  });

  it('catalogue OK + complétion OK : fournisseur réellement joignable', async () => {
    const fetcher = routedFetch([
      { match: '/models', response: () => jsonResponse(OPENAI_CATALOG) },
      { match: '/chat/completions', response: () => jsonResponse(OPENAI_OK) },
    ]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'some-vendor/fast-model', { fetcher });
    expect(result.catalogOk).toBe(true);
    expect(result.reached).toBe('completion');
    expect(result.completionOk).toBe(true);
    expect(result.completionErrorCode).toBeNull();
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.probeModel).toBe('some-vendor/fast-model');
  });

  it('complétion non demandée : completionOk reste null (jamais true)', async () => {
    const fetcher = routedFetch([{ match: '/models', response: () => jsonResponse(OPENAI_CATALOG) }]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, null, { fetcher });
    expect(result.catalogOk).toBe(true);
    expect(result.reached).toBe('catalog');
    expect(result.completionOk).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('catalogue seulement (catalog_only) : aucune complétion même avec un modèle', async () => {
    const fetcher = routedFetch([{ match: '/models', response: () => jsonResponse(OPENAI_CATALOG) }]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'some-vendor/fast-model', {
      fetcher, probeCompletion: false,
    });
    expect(result.completionOk).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('complétion refusée (401) : catalogue reste valide, échec de complétion explicite', async () => {
    const fetcher = routedFetch([
      { match: '/models', response: () => jsonResponse(OPENAI_CATALOG) },
      { match: '/chat/completions', response: () => jsonResponse({ error: 'denied' }, 401) },
    ]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'some-vendor/fast-model', { fetcher });
    expect(result.catalogOk).toBe(true);
    expect(result.completionOk).toBe(false);
    expect(result.completionErrorCode).toBe('PROVIDER_AUTH_FAILED');
  });

  it('réseau coupé : PROVIDER_NETWORK_ERROR, aucun faux positif', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'some-vendor/fast-model', { fetcher });
    expect(result.catalogOk).toBe(false);
    expect(result.catalogErrorCode).toBe('PROVIDER_NETWORK_ERROR');
    expect(result.completionOk).toBeNull();
  });

  it('timeout : PROVIDER_TIMEOUT', async () => {
    const fetcher = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch;
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'some-vendor/fast-model', { fetcher });
    expect(result.catalogErrorCode).toBe('PROVIDER_TIMEOUT');
  });

  it('Cloudflare sans ACCOUNT_ID : PROVIDER_ACCOUNT_ID_MISSING, zéro appel réseau', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const result = await probeProvider(cloudflareDescriptor, { apiKey: 'cfut', accountId: null }, null, { fetcher });
    expect(result.catalogErrorCode).toBe('PROVIDER_ACCOUNT_ID_MISSING');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('modèle « auto » : choisi dans le catalogue réel, jamais écrit en dur', async () => {
    const fetcher = routedFetch([
      { match: '/models', response: () => jsonResponse(OPENAI_CATALOG) },
      { match: '/chat/completions', response: () => jsonResponse(OPENAI_OK) },
    ]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'auto', { fetcher });
    expect(result.completionOk).toBe(true);
    // Le moins cher du catalogue publié (pas un identifiant inventé).
    expect(result.probeModel).toBe('some-vendor/fast-model');
  });

  it('modèle « auto » sur catalogue vide : aucune complétion tentée', async () => {
    const fetcher = routedFetch([{ match: '/models', response: () => jsonResponse({ data: [] }) }]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'auto', { fetcher });
    expect(result.catalogOk).toBe(false);
    expect(result.completionOk).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('le résultat de sonde ne contient jamais la valeur d’une clé', async () => {
    const fetcher = routedFetch([
      { match: '/models', response: () => jsonResponse(OPENAI_CATALOG) },
      { match: '/chat/completions', response: () => jsonResponse(OPENAI_OK) },
    ]);
    const secret = 'sk-or-v1-TRES-SECRET-0123456789';
    const result = await probeProvider(openAiDescriptor, { apiKey: secret }, 'some-vendor/fast-model', { fetcher });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('TRES-SECRET');
  });
});

// ---------------------------------------------------------------------------
// Sonde — passerelle Cloudflare
// ---------------------------------------------------------------------------

describe('sonde — voie passerelle', () => {
  it('transport « gateway » : URL de passerelle + jeton de passerelle, jamais Authorization', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
      calls.push({ url, headers });
      if (url.endsWith('/ai/models')) {
        return jsonResponse({ result: [{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }] });
      }
      return jsonResponse({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as unknown as typeof fetch;

    // Le registre déclare l'API REST (`base_url`) ; l'URL de passerelle est
    // dérivée de sa racine documentée, avec les deux identifiants.
    const gatewayDescriptor: AiProbeDescriptor = {
      ...cloudflareDescriptor,
      transport: 'gateway',
    };
    const result = await probeProvider(
      gatewayDescriptor,
      { apiKey: 'cfut-gateway', accountId: 'acct123', gatewayId: 'vyora-gw' },
      'auto',
      { fetcher },
    );
    expect(result.catalogOk).toBe(true);
    expect(result.completionOk).toBe(true);
    const completionCall = calls.find((call) => call.url.includes('/workers-ai/'))!;
    expect(completionCall.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct123/vyora-gw/workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    );
    expect(completionCall.headers['cf-aig-authorization']).toBe('Bearer cfut-gateway');
    expect(completionCall.headers.Authorization).toBeUndefined();
  });

  it('transport « gateway » sans GATEWAY_ID : erreur explicite, aucune requête', async () => {
    // Le catalogue est ici fourni par la voie REST (le seul endpoint de liste
    // existant) ; la complétion, elle, est refusée avant tout envoi.
    const fetcher = vi.fn(async () => jsonResponse({
      result: [{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }],
    })) as unknown as typeof fetch;
    const gatewayDescriptor: AiProbeDescriptor = {
      ...cloudflareDescriptor,
      transport: 'gateway',
    };
    const result = await probeProvider(
      gatewayDescriptor,
      { apiKey: 'cfut-gateway', accountId: 'acct123', gatewayId: null },
      'auto',
      { fetcher },
    );
    // Le catalogue est lu (c'est la seule ressource réellement disponible),
    // puis la complétion est refusée AVANT toute requête : identifiant de
    // passerelle manquant. Aucune requête mal formée n'est envoyée.
    expect(result.catalogOk).toBe(true);
    expect(result.completionOk).toBe(false);
    expect(result.completionErrorCode).toBe('AI_ACCOUNT_NOT_CONFIGURED');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const urls = (fetcher as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls.map((call) => String(call[0]));
    expect(urls).toHaveLength(1);
    expect(urls.some((url) => url.includes('/workers-ai/'))).toBe(false);
    expect(urls.some((url) => url.includes('gateway.ai.cloudflare.com'))).toBe(false);
  });

  it('les en-têtes de catalogue ne mélangent jamais les deux jetons Cloudflare', () => {
    const headers = catalogHeaders(cloudflareDescriptor, { apiKey: 'cfut-user-token', accountId: 'acct' });
    // Le catalogue REST s'authentifie avec le jeton utilisateur.
    expect(headers.Authorization).toBe('Bearer cfut-user-token');
    expect(headers['cf-aig-authorization']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Choix du modèle de sonde
// ---------------------------------------------------------------------------

describe('sonde — choix du modèle', () => {
  const models = normalizeCatalog('openai', {
    data: [
      { id: 'vendor/pricey', pricing: { prompt: '0.00001', completion: '0.00003' } },
      { id: 'vendor/cheap', pricing: { prompt: '0.0000001', completion: '0.0000004' } },
      { id: 'BAAI/bge-m3', pricing: { prompt: '0.00000001' } },
    ],
  }).models;

  it('préférence explicite respectée si le catalogue la contient', () => {
    expect(pickProbeModel(models, 'vendor/pricey')).toBe('vendor/pricey');
  });

  it('préférence absente du catalogue : ignorée, jamais inventée', () => {
    expect(pickProbeModel(models, 'vendor/inexistant')).not.toBe('vendor/inexistant');
  });

  it('sans préférence : le moins cher en sortie, embeddings exclus', () => {
    expect(pickProbeModel(models, null)).toBe('vendor/cheap');
  });

  it('catalogue vide : aucun modèle', () => {
    expect(pickProbeModel([], 'vendor/x')).toBeNull();
  });

  // Cas réel (LLM7, 2026-11-15) : le catalogue mélange chat, image et
  // transcription. Sonder `jev-latest` a renvoyé « Model 'jev-latest' does not
  // support chat endpoints » — un faux négatif imputé au fournisseur.
  it('écarte les familles non conversationnelles (image, vidéo, audio)', () => {
    const mixed = normalizeCatalog('openai', {
      data: [
        { id: 'gpt-image-2', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
        { id: 'seedance-2.0', architecture: { input_modalities: ['text'], output_modalities: ['video'] } },
        { id: 'whisper-large-v3', architecture: { input_modalities: ['audio'], output_modalities: ['text'] } },
        { id: 'chat-vendor/solid', pricing: { prompt: '0.000001', completion: '0.000002' } },
      ],
    }).models;
    expect(pickProbeModel(mixed, 'gpt-image-2')).not.toBe('gpt-image-2');
    expect(pickProbeModel(mixed, 'whisper-large-v3')).not.toBe('whisper-large-v3');
    expect(pickProbeModel(mixed, null)).toBe('chat-vendor/solid');
  });

  // Cas réel (LLM7) : `claude-sonnet-5` est publié à 450 000 $/Mtok. Trier sur
  // ce prix ferait désigner le modèle le plus aberrant du catalogue.
  it('ignore les prix publiés invraisemblables lors du tri', () => {
    const absurd = normalizeCatalog('openai', {
      data: [
        // Valeur réellement publiée par LLM7 en entrée (450 000 $/Mtok).
        { id: 'claude-sonnet-5', pricing: { prompt: '450000', completion: '0.00000225' } },
        { id: 'vendor/normal', pricing: { prompt: '0.000003', completion: '0.000015' } },
      ],
    }).models;
    expect(pickProbeModel(absurd, null)).toBe('vendor/normal');
  });

  it('un prix inconnu n’exclut pas un modèle conversationnel', () => {
    const unpriced = normalizeCatalog('openai', { data: [{ id: 'vendor/unpriced' }] }).models;
    expect(pickProbeModel(unpriced, null)).toBe('vendor/unpriced');
  });
});

// ---------------------------------------------------------------------------
// Diagnostic des échecs : le corps du fournisseur doit survivre
// ---------------------------------------------------------------------------
//
// Sans ces garanties, un 400 reste `PROVIDER_REQUEST_REJECTED` et la cause
// (« modèle inexistant » vs « paramètre refusé ») est indiscernable — c'est
// exactement le blocage rencontré sur LLM7 et Ollama.

describe('probeProvider — capture du diagnostic fournisseur', () => {
  it('400 : statut HTTP réel et message du fournisseur conservés', async () => {
    const fetcher = routedFetch([
      { match: '/models', response: () => jsonResponse(OPENAI_CATALOG) },
      {
        match: '/chat/completions',
        response: () => jsonResponse({ error: { message: 'model "beam" not found' } }, 400),
      },
    ]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'beam', { fetcher });
    expect(result.completionOk).toBe(false);
    expect(result.completionErrorCode).toBe('PROVIDER_REQUEST_REJECTED');
    expect(result.completionHttpStatus).toBe(400);
    expect(result.completionDetail).toBe('model "beam" not found');
  });

  it('422 : le corps non-JSON est conservé brut (tronqué)', async () => {
    const fetcher = routedFetch([
      { match: '/models', response: () => jsonResponse(OPENAI_CATALOG) },
      { match: '/chat/completions', response: () => new Response('Unprocessable: temperature must be > 0', { status: 422 }) },
    ]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'x', { fetcher });
    expect(result.completionHttpStatus).toBe(422);
    expect(result.completionDetail).toContain('temperature');
  });

  it('succès : aucun diagnostic parasite', async () => {
    const fetcher = routedFetch([
      { match: '/models', response: () => jsonResponse(OPENAI_CATALOG) },
      { match: '/chat/completions', response: () => jsonResponse(OPENAI_OK) },
    ]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'some-vendor/fast-model', { fetcher });
    expect(result.completionHttpStatus).toBeNull();
    expect(result.completionDetail).toBeNull();
  });

  it('complétion jamais tentée : statut et détail restent null', async () => {
    const fetcher = routedFetch([{ match: '/models', response: () => jsonResponse(OPENAI_CATALOG) }]);
    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, null, { fetcher });
    expect(result.completionHttpStatus).toBeNull();
    expect(result.completionDetail).toBeNull();
  });

  it('redactSecrets retire un jeton recopié et borne la longueur', () => {
    expect(redactSecrets('invalid key Bearer sk-live-abcdef123456 for project')).toBe(
      'invalid key Bearer [redacted] for project',
    );
    expect(redactSecrets('x'.repeat(1000)).length).toBe(400);
  });

  it('errorDetailOf privilégie le message, retombe sur le brut', () => {
    expect(errorDetailOf({ error: { message: 'bad model' } }, '{"error":{}}')).toBe('bad model');
    expect(errorDetailOf({ detail: 'quota' }, null)).toBe('quota');
    expect(errorDetailOf(null, 'plain text failure')).toBe('plain text failure');
    expect(errorDetailOf({}, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Repli borné : un refus qui met en cause le MODÈLE ne condamne pas le compte
// ---------------------------------------------------------------------------
//
// Cas réel (LLM7, 2026-11-15) : le catalogue mélange chat et image. La sonde a
// reçu `400 Model 'jev-latest' does not support chat endpoints` et en a conclu
// « fournisseur dégradé ». La bonne conclusion était « ce modèle-là refuse le
// chat ». Ces tests garantissent que la sonde insiste sans jamais dériver en
// dépense illimitée.

describe('probeProvider — repli borné sur refus lié au modèle', () => {
  const catalog = normalizeCatalog('openai', {
    data: [
      { id: 'image-forge', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
      { id: 'chat-cheap', pricing: { prompt: '0.0000001', completion: '0.0000002' } },
      { id: 'chat-solid', pricing: { prompt: '0.000001', completion: '0.000002' } },
    ],
  }).models;

  it('400 sur le premier modèle : la sonde essaie le suivant et réussit', async () => {
    const posts: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        // Catalogue réel : une famille image (écartée) et deux modèles de chat,
        // le moins cher d'abord — exactement la topologie LLM7.
        return jsonResponse({
          data: [
            { id: 'image-forge', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
            { id: 'chat-cheap', pricing: { prompt: '0.0000001', completion: '0.0000002' } },
            { id: 'chat-solid', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      posts.push(String(body.model));
      if (body.model === 'chat-cheap') {
        return jsonResponse({ error: { message: 'does not support chat endpoints' } }, 400);
      }
      return jsonResponse(OPENAI_OK);
    }) as unknown as typeof fetch;

    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'auto', { fetcher });

    expect(posts).toEqual(['chat-cheap', 'chat-solid']);
    expect(result.completionOk).toBe(true);
    expect(result.probeModel).toBe('chat-solid');
    expect(result.completionDetail).toBeNull();
  });

  it('trois refus liés au modèle : la sonde s’arrête à trois essais, jamais plus', async () => {
    let posts = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse({
          data: Array.from({ length: 8 }, (_, i) => ({ id: `chat-${i}` })),
        });
      }
      posts += 1;
      return jsonResponse({ error: { message: 'unsupported' } }, 400);
    }) as unknown as typeof fetch;

    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'auto', { fetcher });
    expect(posts).toBe(3);
    expect(result.completionOk).toBe(false);
    expect(result.completionHttpStatus).toBe(400);
  });

  it('un 401 n’est JAMAIS réessayé : le verdict porte sur le compte', async () => {
    let posts = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/models')) return jsonResponse(OPENAI_CATALOG);
      posts += 1;
      return jsonResponse({ error: { message: 'invalid key' } }, 401);
    }) as unknown as typeof fetch;

    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'some-vendor/fast-model', { fetcher });
    expect(posts).toBe(1);
    expect(result.completionErrorCode).toBe('PROVIDER_AUTH_FAILED');
  });

  it('un 402 est classé PROVIDER_PAYMENT_REQUIRED, jamais « requête rejetée »', async () => {
    let posts = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/models')) return jsonResponse(OPENAI_CATALOG);
      posts += 1;
      return jsonResponse({ error: 'Add usage credits or subscribe' }, 402);
    }) as unknown as typeof fetch;

    const result = await probeProvider(openAiDescriptor, { apiKey: 'k' }, 'some-vendor/fast-model', { fetcher });
    expect(posts).toBe(1);
    expect(result.completionHttpStatus).toBe(402);
    // Cas réel LLM7 + Ollama (2026-11-15) : le solde est vide. Ce n'est ni une
    // mauvaise configuration ni une panne — c'est la facturation.
    expect(result.completionErrorCode).toBe('PROVIDER_PAYMENT_REQUIRED');
    expect(result.completionDetail).toContain('credits');
  });

  it('catalogue mixte : les candidats excluent les familles image/audio', () => {
    expect(conversationalModels(catalog).map((m) => m.providerModel)).toEqual(['chat-cheap', 'chat-solid']);
  });

  it('probeModelCandidates borne le nombre d’essais', () => {
    const many = normalizeCatalog('openai', {
      data: Array.from({ length: 10 }, (_, i) => ({
        id: `chat-${i}`,
        pricing: { prompt: `0.00000${i + 1}`, completion: `0.00000${i + 1}` },
      })),
    }).models;
    expect(probeModelCandidates(many, null, 3)).toHaveLength(3);
    expect(probeModelCandidates(many, null, 0)).toHaveLength(1);
  });

  it('la préférence explicite passe en premier, sans doublon', () => {
    const ranked = probeModelCandidates(catalog, 'chat-solid', 3);
    expect(ranked[0]).toBe('chat-solid');
    expect(new Set(ranked).size).toBe(ranked.length);
  });
});
