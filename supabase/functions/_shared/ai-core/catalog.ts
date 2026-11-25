// SORAHNEX AI CORE — normalisation des catalogues de modèles des fournisseurs.
//
// Le moteur ne tient AUCUN catalogue en dur : il lit le catalogue que chaque
// fournisseur publie, le normalise, puis l'écrit au registre central
// (`saas_business.ai_models`). Conséquences :
//   * un modèle qui apparaît chez un fournisseur devient routable sans
//     modification de code ;
//   * un modèle retiré par le fournisseur n'est plus proposé ;
//   * les capacités et les prix ne sont repris QUE s'ils sont publiés — sinon
//     `null` (prix inconnu) et capacité absente (jamais supposée).
//
// Aucune I/O ici : `fetch` est injecté par l'hôte (`engine`, Edge, tests).

import { AiAdapterKind } from './types.ts';

/** Modèle normalisé, tel qu'il sera écrit au registre. */
export interface AiCatalogModel {
  /** Identifiant interne stable (slug) — unique par fournisseur. */
  modelKey: string;
  /** Identifiant exact attendu par l'API du fournisseur. */
  providerModel: string;
  displayName: string;
  /** Capacités PUBLIÉES par le fournisseur (jamais devinées). */
  capabilities: Record<string, boolean>;
  contextIn: number | null;
  maxOut: number | null;
  /** Prix par million de jetons (USD) — `null` si le fournisseur ne publie pas. */
  costIn: number | null;
  costOut: number | null;
  /** Niveau de service déduit des prix publiés uniquement. */
  tier: 'fast' | 'economy' | 'standard' | 'advanced' | 'specialized' | 'fallback';
  /** Note lisible sur l'origine des valeurs. */
  note: string | null;
}

export interface AiCatalogResult {
  models: AiCatalogModel[];
  /** Problème de forme éventuel (le catalogue reste exploitable). */
  warning: string | null;
}

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Prix par million de jetons.
 *
 * Les fournisseurs publient soit un prix par million, soit un prix par jeton
 * (OpenRouter : `pricing.prompt = "0.000003"`). Une valeur à 0 est un prix
 * publié (modèle gratuit), une absence n'est pas un prix : `null`.
 */
function pricePerMillion(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  // Un prix par jeton est toujours < 1 (1 $/M = 0,000001). Un prix par million
  // est presque toujours >= 0,001 ; la bascule évite d'inventer un facteur.
  const perMillion = n > 0 && n < 1 ? n * 1_000_000 : n;
  return Math.round(perMillion * 1e6) / 1e6;
}

/** Slug stable et valide (`^[a-z0-9][a-z0-9._-]{0,79}$`). */
export function catalogModelKey(providerModel: string): string {
  return providerModel
    .toLowerCase()
    .replace(/[:/@]+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
}

/** Niveau déduit du prix publié — aucun jugement de qualité n'est inventé. */
function tierFromPrice(costIn: number | null, costOut: number | null): AiCatalogModel['tier'] {
  if (costIn === null && costOut === null) return 'standard';
  const reference = costOut ?? costIn ?? 0;
  if (costIn === 0 && (costOut === 0 || costOut === null)) return 'fallback';
  if (reference <= 1) return 'economy';
  if (reference <= 3) return 'fast';
  if (reference <= 12) return 'standard';
  return 'advanced';
}

/**
 * Capacités publiées, traduites dans le vocabulaire de SORAHNEX.
 *
 * On ne devine rien : une capacité n'est posée que si la réponse du fournisseur
 * la déclare explicitement. `writing` (texte) est la seule capacité posée par
 * défaut pour un modèle de conversation — c'est la nature même de l'endpoint.
 */
function capabilitiesFromModalities(
  input: unknown,
  output: unknown,
  supportedParameters: unknown,
): Record<string, boolean> {
  const caps: Record<string, boolean> = { writing: true };
  const ins = Array.isArray(input) ? input.map((v) => String(v)) : [];
  const outs = Array.isArray(output) ? output.map((v) => String(v)) : [];
  if (ins.includes('image')) caps.vision = true;
  if (ins.includes('audio')) caps.audio_input = true;
  if (ins.includes('file') || ins.includes('pdf')) caps.documents = true;
  if (ins.includes('video')) caps.video_input = true;
  if (outs.includes('image')) caps.images = true;
  if (outs.includes('audio')) caps.audio = true;
  if (outs.includes('video')) caps.video = true;
  if (outs.includes('embedding') || outs.includes('embeddings')) caps.embeddings = true;
  const params = Array.isArray(supportedParameters) ? supportedParameters.map((v) => String(v)) : [];
  if (params.includes('tools') || params.includes('tool_choice')) caps.tools = true;
  if (params.includes('structured_outputs') || params.includes('response_format')) caps.structured_output = true;
  return caps;
}

/** Un identifiant de modèle d'embedding n'est pas un modèle de conversation. */
function isEmbeddingId(id: string): boolean {
  return /embed|bge|gte-|e5-|voyage|rerank/i.test(id);
}

/** Gabarit OpenAI (OpenRouter, LLM7, Gonka, Ollama, Groq…) : `data[]`. */
function fromOpenAiStyle(payload: unknown): AiCatalogResult {
  const rows = Array.isArray(rec(payload).data) ? (rec(payload).data as unknown[]) : [];
  const models: AiCatalogModel[] = [];
  for (const raw of rows) {
    const item = rec(raw);
    const id = str(item.id);
    if (!id) continue;
    const architecture = rec(item.architecture);
    const pricing = rec(item.pricing);
    const costIn = pricePerMillion(pricing.prompt ?? pricing.input);
    const costOut = pricePerMillion(pricing.completion ?? pricing.output);
    const embedding = isEmbeddingId(id);
    const capabilities = embedding
      ? { embeddings: true }
      : capabilitiesFromModalities(
          architecture.input_modalities,
          architecture.output_modalities,
          item.supported_parameters,
        );
    if (!embedding && positiveInt(item.context_length) === null) {
      // OpenRouter publie `context_length` ; les autres passerelles parfois non.
    }
    const contextIn = positiveInt(item.context_length) ?? positiveInt(item.context_window);
    const maxOut = positiveInt(rec(item.top_provider).max_completion_tokens)
      ?? positiveInt(item.max_completion_tokens);
    models.push({
      modelKey: catalogModelKey(id),
      providerModel: id,
      displayName: str(item.name) ?? id,
      capabilities,
      contextIn,
      maxOut,
      costIn,
      costOut,
      tier: embedding ? 'specialized' : tierFromPrice(costIn, costOut),
      note: embedding
        ? 'Modèle d’embeddings : jamais routé pour une conversation.'
        : costIn === null && costOut === null
          ? 'Prix non publié par le fournisseur : coût inconnu (jamais estimé).'
          : null,
    });
  }
  return {
    models: dedupe(models),
    warning: rows.length === 0 ? 'catalogue vide' : null,
  };
}

/** Gabarit Google : `models[]` avec `supportedGenerationMethods`. */
function fromGeminiStyle(payload: unknown): AiCatalogResult {
  const rows = Array.isArray(rec(payload).models) ? (rec(payload).models as unknown[]) : [];
  const models: AiCatalogModel[] = [];
  for (const raw of rows) {
    const item = rec(raw);
    const name = str(item.name);
    if (!name) continue;
    const methods = Array.isArray(item.supportedGenerationMethods)
      ? item.supportedGenerationMethods.map((v) => String(v))
      : [];
    if (methods.length > 0 && !methods.includes('generateContent')) continue;
    const id = name.replace(/^models\//, '');
    if (isEmbeddingId(id) && !methods.includes('embedContent')) continue;
    const caps: Record<string, boolean> = { writing: true, reasoning: true };
    if (methods.includes('embedContent')) caps.embeddings = true;
    models.push({
      modelKey: catalogModelKey(id),
      providerModel: id,
      displayName: str(item.displayName) ?? id,
      capabilities: caps,
      contextIn: positiveInt(item.inputTokenLimit),
      maxOut: positiveInt(item.outputTokenLimit),
      costIn: null,
      costOut: null,
      tier: 'standard',
      note: 'Prix non publié par l’API : coût inconnu (jamais estimé).',
    });
  }
  return { models: dedupe(models), warning: rows.length === 0 ? 'catalogue vide' : null };
}

/** Gabarit Workers AI : `result[]` de modèles `@cf/...`. */
function fromCloudflareStyle(payload: unknown): AiCatalogResult {
  const root = rec(payload);
  const container = rec(root.result);
  const rows = Array.isArray(root.result)
    ? (root.result as unknown[])
    : Array.isArray(container.models)
      ? (container.models as unknown[])
      : [];
  const models: AiCatalogModel[] = [];
  for (const raw of rows) {
    const item = rec(raw);
    const id = str(item.id) ?? str(item.name);
    if (!id) continue;
    const embedding = isEmbeddingId(id);
    models.push({
      modelKey: catalogModelKey(id),
      providerModel: id,
      displayName: str(item.name) ?? str(item.id) ?? id,
      capabilities: embedding ? { embeddings: true } : { writing: true },
      contextIn: null,
      maxOut: null,
      costIn: null,
      costOut: null,
      tier: embedding ? 'specialized' : 'standard',
      note: 'Catalogue Cloudflare : capacités par modèle non publiées dans la liste — à confirmer modèle par modèle.',
    });
  }
  return { models: dedupe(models), warning: rows.length === 0 ? 'catalogue vide' : null };
}

/** Gabarit Ollama natif : `models[]` avec `name` / `details`. */
function fromOllamaStyle(payload: unknown): AiCatalogResult {
  const rows = Array.isArray(rec(payload).models) ? (rec(payload).models as unknown[]) : [];
  const models: AiCatalogModel[] = [];
  for (const raw of rows) {
    const item = rec(raw);
    const name = str(item.name) ?? str(item.model);
    if (!name) continue;
    models.push({
      modelKey: catalogModelKey(name),
      providerModel: name,
      displayName: str(item.name) ?? name,
      capabilities: { writing: true },
      contextIn: positiveInt(item.context_length),
      maxOut: null,
      costIn: null,
      costOut: null,
      tier: 'standard',
      note: 'Prix, capacités et quotas cloud non publiés par l’API : à confirmer par sonde.',
    });
  }
  return { models: dedupe(models), warning: rows.length === 0 ? 'catalogue vide' : null };
}

function dedupe(models: AiCatalogModel[]): AiCatalogModel[] {
  const seen = new Map<string, AiCatalogModel>();
  for (const model of models) {
    if (!seen.has(model.modelKey)) seen.set(model.modelKey, model);
  }
  return [...seen.values()].sort((a, b) => a.modelKey.localeCompare(b.modelKey));
}

/**
 * Normalise le catalogue d'un fournisseur selon son gabarit de protocole.
 *
 * Le gabarit vient du registre (`adapter_kind`) : aucun fournisseur n'est nommé
 * ici. Un gabarit inconnu produit un catalogue vide et un avertissement — jamais
 * des modèles inventés.
 */
export function normalizeCatalog(kind: AiAdapterKind, payload: unknown): AiCatalogResult {
  if (payload === null || payload === undefined) {
    return { models: [], warning: 'réponse vide' };
  }
  if (kind === 'gemini') return fromGeminiStyle(payload);
  if (kind === 'cloudflare') return fromCloudflareStyle(payload);
  const root = rec(payload);
  // Ollama natif (`/api/tags`) et gabarit OpenAI se distinguent par la forme.
  if (Array.isArray(root.models) && !Array.isArray(root.data)) return fromOllamaStyle(payload);
  if (Array.isArray(root.data)) return fromOpenAiStyle(payload);
  return { models: [], warning: 'forme de catalogue inconnue' };
}
