// VYORA AI CORE — clients fournisseurs de Business Grow.
//
// AUCUNE liste de fournisseurs ici : un fournisseur est une CLÉ (chaîne) dont
// le registre central (`saas_business.ai_providers`) décrit le protocole —
// `adapter_kind`, `default_base_url`, `models_url`, `default_headers` — et
// dont la clé API vit dans les secrets Edge (`api_key_env`). Ajouter un
// fournisseur = une ligne de registre + un secret, sans toucher à ce fichier.
//
// Le module ne connaît donc que des GABARITS de protocole (`openai`, `gemini`,
// `cloudflare`, `none`), exactement comme le moteur central, dont il réutilise
// l'implémentation (`_shared/ai-core`).
export type BusinessProvider = string;
export type ExtensibleProviderId = string;
export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
  /** Cloudflare Workers AI : identifiant de compte (nécessaire à l'URL d'appel). */
  accountId?: string | null;
  /** Gabarit de protocole fourni par le registre. */
  adapterKind?: 'openai' | 'gemini' | 'cloudflare' | 'none';
  /** URL de base fournie par le registre (jamais écrite en dur). */
  baseUrl?: string | null;
  /** URL de la liste des modèles (facultative). */
  modelsUrl?: string | null;
  /** En-têtes supplémentaires déclarés au registre (attribution, version). */
  headers?: Record<string, string>;
}

export interface ProviderCompletionOptions {
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ProviderReply {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Fournisseur qui a réellement répondu (le moteur central peut basculer). */
  provider?: ExtensibleProviderId;
  /** Modèle réellement utilisé côté moteur central. */
  model?: string;
}

export interface ProviderProbeResult {
  providerKey: ExtensibleProviderId;
  modelKey: string;
  status: 'healthy' | 'failed';
  latencyMs: number;
  errorCode: string | null;
  availableModels: string[];
}

export interface BusinessProviderAdapter {
  readonly id: ExtensibleProviderId;
  readonly displayName: string;
  readonly envKeyVar: string;
  readonly envModelVar: string;
  readonly implemented: boolean;
  complete(
    config: ProviderConfig,
    messages: ChatMessage[],
    fetcher?: typeof fetch,
    options?: ProviderCompletionOptions,
  ): Promise<ProviderReply>;
  listModels(config: ProviderConfig, fetcher?: typeof fetch): Promise<string[]>;
  probe(config: ProviderConfig, fetcher?: typeof fetch): Promise<ProviderProbeResult>;
}

export class ProviderCallError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'ProviderCallError';
  }
}

const requestTimeoutMs = 25_000;
const probeTimeoutMs = 15_000;

function providerError(status: number): ProviderCallError {
  if (status === 401 || status === 403) return new ProviderCallError('PROVIDER_AUTH_FAILED', false);
  if (status === 429) return new ProviderCallError('PROVIDER_RATE_LIMITED', true);
  if (status >= 500) return new ProviderCallError('PROVIDER_UNAVAILABLE', true);
  return new ProviderCallError('PROVIDER_REQUEST_REJECTED', false);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Résolution du protocole — PAR LE REGISTRE, jamais par une liste en dur
// ---------------------------------------------------------------------------

function envValue(name: string): string {
  const g = globalThis as unknown as {
    Deno?: { env?: { get?: (k: string) => string } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(name) ?? g.process?.env?.[name] ?? '';
}

/** Nom de variable porteuse d'un descripteur, par convention, jamais figé. */
function envName(base: string, providerId: string, suffix: string): string {
  return `${base}_${providerId.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}_${suffix}`;
}

/** Préfixe de convention pour une clé de fournisseur (aucun nom figé). */
function envPrefix(providerId: string): string {
  return providerId.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
}

/**
 * Descripteur de protocole d'un fournisseur.
 *
 * La configuration effective (registre → environnement → appelant) est lue
 * avant d'arriver ici : gabarit, URL de base, en-têtes et identifiant de
 * compte viennent du registre. Sans URL, aucun adaptateur n'est fabriqué : le
 * moteur renvoie un code explicite plutôt que d'inventer un point d'entrée.
 */
function descriptorFor(providerId: string, config?: ProviderConfig | null): AiProviderDescriptor {
  const prefix = envPrefix(providerId);
  const kindRaw = (config?.adapterKind ?? envValue(`BUSINESS_GROW_${prefix}_ADAPTER_KIND`) ?? '').toLowerCase();
  const kind = (['openai', 'gemini', 'cloudflare', 'none'] as const).includes(kindRaw as never)
    ? (kindRaw as AiAdapterKind)
    : 'openai';
  const baseUrl = (config?.baseUrl ?? envValue(`BUSINESS_GROW_${prefix}_BASE_URL`) ?? '').trim();
  const modelsUrl = (config?.modelsUrl ?? envValue(`BUSINESS_GROW_${prefix}_MODELS_URL`) ?? '').trim();
  return {
    key: providerId,
    kind,
    baseUrl,
    apiKeyEnv: `BUSINESS_GROW_${prefix}_API_KEY`,
    accountIdEnv: `BUSINESS_GROW_${prefix}_ACCOUNT_ID`,
    modelsUrl: modelsUrl || null,
    headers: config?.headers ?? {},
  };
}

/** Clé API d'un fournisseur : configuration d'abord, environnement ensuite. */
function apiKeyFor(providerId: string, config?: ProviderConfig | null): string {
  return config?.apiKey || envValue(envName('BUSINESS_GROW', providerId, 'API_KEY'))
    || envValue(envName('BUSINESS_GROW', providerId, 'API_TOKEN'))
    || envValue(`${envPrefix(providerId)}_API_KEY`);
}

/** Modèle configuré d'un fournisseur (registre, puis environnement). */
function modelFor(providerId: string, config?: ProviderConfig | null): string {
  return config?.model || envValue(envName('BUSINESS_GROW', providerId, 'MODEL'))
    || envValue(`${envPrefix(providerId)}_MODEL`);
}

/**
 * Métadonnées du registre, lues une fois et mises en cache : nom lisible,
 * URL de base, gabarit de protocole, identifiant de compte requis.
 * Aucune écriture, aucun secret lu ici.
 */
type RegistryRow = {
  name: string;
  kind: AiAdapterKind;
  baseUrl: string | null;
  modelsUrl: string | null;
  headers: Record<string, string>;
  accountIdEnv: string | null;
  aggregator: boolean;
};

let registryCache: { at: number; rows: Map<string, RegistryRow> } = { at: 0, rows: new Map() };
const REGISTRY_TTL_MS = 60_000;

function registryRow(providerId: string): RegistryRow | null {
  if (Date.now() - registryCache.at > REGISTRY_TTL_MS) return null;
  return registryCache.rows.get(providerId) ?? null;
}

export function primeProviderRegistry(rows: unknown[]): void {
  const next = new Map<string, RegistryRow>();
  for (const raw of rows) {
    const row = asRecord(raw);
    const key = typeof row.provider_key === 'string' ? row.provider_key : '';
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(key)) continue;
    const kindRaw = String(row.adapter_kind ?? 'openai').toLowerCase();
    const headers = asRecord(row.default_headers);
    next.set(key, {
      name: typeof row.display_name === 'string' && row.display_name ? row.display_name : key,
      kind: (['openai', 'gemini', 'cloudflare', 'none'] as const).includes(kindRaw as never)
        ? (kindRaw as AiAdapterKind)
        : 'openai',
      baseUrl: typeof row.default_base_url === 'string' && row.default_base_url ? row.default_base_url : null,
      modelsUrl: typeof row.models_url === 'string' && row.models_url ? row.models_url : null,
      headers: Object.fromEntries(
        Object.entries(headers).filter(([, value]) => typeof value === 'string'),
      ) as Record<string, string>,
      accountIdEnv: typeof row.account_id_env === 'string' && row.account_id_env ? row.account_id_env : null,
      aggregator: row.is_aggregator === true,
    });
  }
  registryCache = { at: Date.now(), rows: next };
}

/**
 * Configuration effective d'un fournisseur : registre, puis variables
 * d'environnement, puis valeurs de l'appelant. Aucune URL ni aucun modèle
 * n'est inventé : absence = `null`, et l'appel échoue avec un code explicite.
 */
export function providerConfigFor(providerId: string, provided?: Partial<ProviderConfig> | null): ProviderConfig | null {
  const row = registryRow(providerId);
  const apiKey = apiKeyFor(providerId, provided as ProviderConfig | undefined);
  const model = modelFor(providerId, provided as ProviderConfig | undefined);
  const accountId = provided?.accountId
    ?? (row?.accountIdEnv ? envValue(row.accountIdEnv) : null)
    ?? envValue(envName('BUSINESS_GROW', providerId, 'ACCOUNT_ID'));
  const baseUrl = provided?.baseUrl ?? row?.baseUrl ?? envValue(envName('BUSINESS_GROW', providerId, 'BASE_URL'));
  if (!apiKey && !model && !baseUrl) return null;
  return {
    apiKey,
    model,
    accountId: accountId || null,
    ...(row ? { adapterKind: row.kind } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(row?.modelsUrl || provided?.modelsUrl ? { modelsUrl: row?.modelsUrl ?? provided?.modelsUrl } : {}),
    ...(row || provided?.headers ? { headers: { ...(row?.headers ?? {}), ...(provided?.headers ?? {}) } } : {}),
  };
}

/** Fournisseurs déclarés au registre (source unique de la liste servie). */
export function registeredProviderKeys(): string[] {
  return [...registryCache.rows.keys()].sort();
}

/** Le registre marque-t-il ce fournisseur comme agrégateur ? */
export function isAggregatorProvider(providerId: string): boolean {
  return registryRow(providerId)?.aggregator === true;
}


/** Adaptateur réel d'un fournisseur, construit depuis son descripteur. */
function adapterFor(providerId: string, config?: ProviderConfig | null): AiProviderAdapter | null {
  return resolveAiAdapter(descriptorFor(providerId, providerConfigFor(providerId, config)));
}

// ---------------------------------------------------------------------------
// VYORA AI CORE — adaptateurs locaux de secours.
// Les appels de production passent par le moteur central ; ces adaptateurs
// couvrent les diagnostics, les sondes et les tests. Ils réutilisent l'AI CORE
// partagé : même contrat, mêmes normalisations d'erreurs, même lecture des
// tokens — et donc aucun protocole fournisseur écrit deux fois.
// ---------------------------------------------------------------------------
// Import direct (pas le barrel index.ts) : le bundle Business Grow embarque
// UNIQUEMENT les adaptateurs — le routeur/moteur du registre vit dans le
// moteur central (vyora-ai) et reste hors de cet artefact (limite de
// troncature du canal de déploiement : contenu lisible < 20 000 caractères).
import {
  resolveAiAdapter,
} from '../_shared/ai-core/adapters.ts';
import type { AiProviderAdapter } from '../_shared/ai-core/types.ts';
import type { AiAdapterKind, AiProviderDescriptor } from '../_shared/ai-core/types.ts';

function mapAiCoreError(error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'PROVIDER_UNAVAILABLE';
  const map: Record<string, [string, boolean]> = {
    AI_NOT_CONFIGURED: ['PROVIDER_NOT_CONFIGURED', false],
    // Identifiant de compte/passerelle manquant (Cloudflare) : le fournisseur
    // n'est pas configuré, ce n'est pas une panne passagère.
    AI_ACCOUNT_NOT_CONFIGURED: ['PROVIDER_NOT_CONFIGURED', false],
    AI_AUTH_FAILED: ['PROVIDER_AUTH_FAILED', false],
    AI_RATE_LIMITED: ['PROVIDER_RATE_LIMITED', true],
    AI_TIMEOUT: ['PROVIDER_TIMEOUT', true],
    AI_UNAVAILABLE: ['PROVIDER_UNAVAILABLE', true],
    AI_INVALID_RESPONSE: ['PROVIDER_INVALID_RESPONSE', true],
    AI_EMPTY_RESPONSE: ['PROVIDER_EMPTY_RESPONSE', true],
  };
  const [mappedCode, retryable] = map[code] ?? ['PROVIDER_UNAVAILABLE', true];
  return new ProviderCallError(mappedCode, retryable);
}

async function aiCoreComplete(
  providerId: string,
  config: ProviderConfig,
  messages: ChatMessage[],
  fetcher: typeof fetch = fetch,
  options?: ProviderCompletionOptions,
): Promise<ProviderReply> {
  const adapter = adapterFor(providerId, config);
  if (!adapter) {
    // Fournisseur déclaré mais protocole non résoluble : soit la clé manque
    // (cas nominal d'un fournisseur dormant), soit l'URL n'est pas connue.
    if (!config.apiKey) throw new ProviderCallError('PROVIDER_NOT_CONFIGURED', false);
    throw new ProviderCallError('PROVIDER_ADAPTER_NOT_IMPLEMENTED', false);
  }
  let transport: ReturnType<AiProviderAdapter['buildRequest']>;
  try {
    transport = adapter.buildRequest({
      credentials: {
        apiKey: config.apiKey || null,
        accountId: config.accountId ?? null,
      },
      model: config.model,
      messages,
      options,
    });
  } catch (error) {
    throw mapAiCoreError(error);
  }
  let response: Response;
  try {
    response = await fetcher(transport.url, {
      method: 'POST',
      headers: transport.headers,
      body: JSON.stringify(transport.body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    throw new ProviderCallError(name === 'TimeoutError' || name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR', true);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw providerError(response.status);
    throw new ProviderCallError('PROVIDER_INVALID_RESPONSE', true);
  }
  if (!response.ok) throw providerError(response.status);
  try {
    const parsed = adapter.parse(payload);
    return {
      content: parsed.content,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
    };
  } catch (error) {
    throw mapAiCoreError(error);
  }
}

async function aiCoreListModels(providerId: string, config: ProviderConfig, fetcher: typeof fetch = fetch): Promise<string[]> {
  const adapter = adapterFor(providerId, config);
  if (!adapter) return [];
  const url = adapter.modelsUrl({ apiKey: config.apiKey || null, accountId: config.accountId ?? null });
  if (!url) return [];
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  try {
    return adapter.parseModelList(await response.json());
  } catch {
    return [];
  }
}

function createRegistryAdapter(id: string): BusinessProviderAdapter {
  const prefix = id.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
  return {
    id,
    // Le nom lisible vient du registre (display_name) quand il est fourni ;
    // jamais d'un catalogue en dur.
    get displayName() { return registryRow(id)?.name ?? id; },
    envKeyVar: `BUSINESS_GROW_${prefix}_API_KEY`,
    envModelVar: `BUSINESS_GROW_${prefix}_MODEL`,
    implemented: true,
    async complete(config, messages, fetcher, options) {
      return await aiCoreComplete(id, config, messages, fetcher, options);
    },
    async listModels(config, fetcher) {
      return await aiCoreListModels(id, config, fetcher);
    },
    async probe(config, fetcher) {
      const startedAt = Date.now();
      if (!config.apiKey || !config.model) {
        return {
          providerKey: id,
          modelKey: config.model || '',
          status: 'failed',
          latencyMs: 0,
          errorCode: 'PROVIDER_NOT_CONFIGURED',
          availableModels: [],
        };
      }
      try {
        const availableModels = await aiCoreListModels(id, config, fetcher);
        await aiCoreComplete(
          id,
          config,
          [{ role: 'user', content: 'Réponds uniquement OK.' }],
          fetcher,
          { maxOutputTokens: 256, temperature: 0 },
        );
        return {
          providerKey: id,
          modelKey: config.model,
          status: 'healthy',
          latencyMs: Date.now() - startedAt,
          errorCode: null,
          availableModels,
        };
      } catch (error) {
        const code = error instanceof ProviderCallError ? error.code : 'PROVIDER_UNAVAILABLE';
        return {
          providerKey: id,
          modelKey: config.model,
          status: 'failed',
          latencyMs: Date.now() - startedAt,
          errorCode: code,
          availableModels: [],
        };
      }
    },
  };
}

/**
 * Adaptateur d'un fournisseur.
 *
 * Créé à la demande : aucun catalogue de fournisseurs n'est maintenu ici. Un
 * identifiant valide obtient toujours un adaptateur ; c'est le descripteur de
 * protocole (registre ou variables d'environnement) qui décide si l'appel est
 * réellement possible.
 */
const adapterCache = new Map<string, BusinessProviderAdapter>();

export function getProviderAdapter(provider: string): BusinessProviderAdapter | null {
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(provider)) return null;
  const cached = adapterCache.get(provider);
  if (cached) return cached;
  const created = createRegistryAdapter(provider);
  adapterCache.set(provider, created);
  return created;
}

/** Moteur IA central VYORA : une seule pile fournisseur pour tout le produit. */
function centralEngineUrl(): string {
  const url = (env('SUPABASE_URL') ?? '').replace(/\/$/, '');
  return url ? `${url}/functions/v1/vyora-ai` : '';
}

/** Route choisi par Business Grow (registre) : le moteur central l'exécute
 *  en tête de chaîne et reste libre de basculer sur un secours compatible. */
export interface CentralRouteMeta {
  model?: string | null;
  roleKey?: string | null;
}

export function buildCentralRequest(
  provider: BusinessProvider,
  messages: ChatMessage[],
  options?: ProviderCompletionOptions,
  meta?: CentralRouteMeta,
): Record<string, unknown> {
  return {
    action: 'complete',
    prefer: provider,
    messages: messages.map(({ role, content }) => ({ role, content })),
    ...(meta?.model ? { model: meta.model } : {}),
    ...(meta?.roleKey ? { role_key: meta.roleKey } : {}),
    ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {}),
    ...(typeof options?.maxOutputTokens === 'number' ? { max_tokens: options.maxOutputTokens } : {}),
  };
}

async function callCentralEngine(
  provider: BusinessProvider,
  messages: ChatMessage[],
  options?: ProviderCompletionOptions,
  meta?: CentralRouteMeta,
): Promise<ProviderReply | null> {
  const url = centralEngineUrl();
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !serviceKey) return null;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCentralRequest(provider, messages, options, meta)),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    return null; // moteur central injoignable : adapter local en secours
  }
  if (res.status === 404 || res.status === 401 || res.status === 403) return null;
  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try { payload = asRecord(JSON.parse(text || '{}')); } catch { payload = {}; }
  if (!res.ok) {
    const error = asRecord(payload.error);
    const code = typeof error.code === 'string' ? error.code : 'PROVIDER_UNAVAILABLE';
    throw new ProviderCallError(code === 'AI_TIMEOUT' ? 'PROVIDER_TIMEOUT' : code, true);
  }
  const content = typeof payload.content === 'string' ? payload.content.trim() : '';
  if (!content) throw new ProviderCallError('PROVIDER_EMPTY_RESPONSE', true);
  const tokenUsage = asRecord(payload.token_usage);
  const usage = asRecord(payload.usage);
  return {
    content,
    inputTokens: tokenCount(tokenUsage.input_tokens ?? usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: tokenCount(tokenUsage.output_tokens ?? usage.output_tokens ?? usage.completion_tokens),
    provider: typeof payload.provider === 'string' ? payload.provider as ExtensibleProviderId : provider,
    model: typeof payload.model === 'string' ? payload.model : provider,
  };
}

function env(key: string): string | undefined {
  const g = globalThis as unknown as {
    Deno?: { env?: { get?: (k: string) => string } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(key) ?? g.process?.env?.[key];
}

export async function callProvider(
  provider: BusinessProvider,
  config: Partial<ProviderConfig> | null,
  messages: ChatMessage[],
  fetcher: typeof fetch = fetch,
  options?: ProviderCompletionOptions,
  meta?: CentralRouteMeta,
): Promise<ProviderReply> {
  const adapter = getProviderAdapter(provider);
  if (!adapter) throw new ProviderCallError('UNSUPPORTED_PROVIDER', false);
  // Les appels réels passent par le moteur central ; un fetcher injecté (tests,
  // diagnostics) continue d'utiliser l'adaptateur du fournisseur.
  if (fetcher === fetch) {
    const central = await callCentralEngine(provider, messages, options, meta);
    if (central) return central;
  }
  const effective = providerConfigFor(provider, config);
  if (!effective) throw new ProviderCallError('PROVIDER_NOT_CONFIGURED', false);
  return await adapter.complete(effective, messages, fetcher, options);
}

export async function probeProvider(
  provider: BusinessProvider,
  config: Partial<ProviderConfig> | null,
  fetcher: typeof fetch = fetch,
): Promise<ProviderProbeResult> {
  const adapter = getProviderAdapter(provider);
  const effective = providerConfigFor(provider, config);
  if (!adapter || !effective) {
    return {
      providerKey: provider,
      modelKey: effective?.model ?? config?.model ?? '',
      status: 'failed',
      latencyMs: 0,
      errorCode: adapter ? 'PROVIDER_NOT_CONFIGURED' : 'UNSUPPORTED_PROVIDER',
      availableModels: [],
    };
  }
  return await adapter.probe(effective, fetcher);
}

export async function listRemoteModels(
  provider: BusinessProvider,
  config: Partial<ProviderConfig> | null,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const adapter = getProviderAdapter(provider);
  const effective = providerConfigFor(provider, config);
  if (!adapter || !effective || !effective.apiKey) return [];
  return await adapter.listModels(effective, fetcher);
}

/**
 * Adaptateurs réellement résolubles : ceux dont l'environnement porte une clé
 * ET une URL de base. Rien n'est annoncé qui ne puisse être appelé.
 */
export function listAdapterDescriptors(): Array<{
  id: ExtensibleProviderId;
  displayName: string;
  envKeyVar: string;
  envModelVar: string;
  implemented: boolean;
}> {
  const keys = new Set<string>();
  const scan = (source: Record<string, string | undefined> | undefined) => {
    for (const name of Object.keys(source ?? {})) {
      const match = name.match(/^BUSINESS_GROW_([A-Z0-9_]+?)_(?:API_KEY|API_TOKEN)$/);
      if (match) keys.add(match[1].toLowerCase());
    }
  };
  const g = globalThis as unknown as {
    Deno?: { env?: { toObject?: () => Record<string, string> } };
    process?: { env?: Record<string, string | undefined> };
  };
  scan(g.Deno?.env?.toObject?.());
  scan(g.process?.env);
  return [...keys].sort().map((key) => {
    const adapter = getProviderAdapter(key)!;
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      envKeyVar: adapter.envKeyVar,
      envModelVar: adapter.envModelVar,
      implemented: adapter.implemented,
    };
  });
}

export function providerOrder(value: string): BusinessProvider[] {
  // Aucune liste d'autorisation figée : on valide la FORME de l'identifiant et
  // on laisse le registre décider quels fournisseurs sont réellement servis.
  const parsed = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z][a-z0-9_-]{1,39}$/.test(item));
  return [...new Set(parsed)];
}
