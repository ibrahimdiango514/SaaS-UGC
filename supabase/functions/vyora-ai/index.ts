// SORAHNEX — moteur IA central (SORAHNEX AI GATEWAY → FreeLLMAPI).
//
// Un seul endpoint serveur, un seul fournisseur central (FreeLLMAPI) déclaré
// dans le registre : le routeur choisit le modèle compatible, le moteur applique
// le secours plafonné et journalise chaque tentative. Aucun fournisseur n'est
// nommé dans le code — seule la ligne de registre décrit protocole et secret :
//   FREE_LLM_API_KEY      (secret Edge, jamais exposé)
//   FREE_LLM_API_BASE_URL (URL de l'instance FreeLLMAPI)
//
// Actions : health | generate_script | improve_prompt | generate_hooks |
//           generate_visual | generate_scenes | complete
// `complete` accepte `messages` (system/user/assistant) pour les espaces qui
// mènent une conversation (Grow) ou `system` + `prompt`.
//
// Appels internes serveur à serveur : un appel portant exactement la clé
// service comme jeton n'est pas facturé en quota (l'espace appelant gère déjà
// ses propres limites) ; un appel utilisateur consomme une unité de quota et
// est restitué si le fournisseur échoue.
//
// Aucune réponse n'est fabriquée localement : un échec fournisseur est renvoyé
// tel quel (code + message).

import { parseImageInputs } from "../_shared/ai-core/images.ts";
import {
  parseRegistrySnapshot,
  runAiCall,
  routingLogPayload,
  type AiCallLogEntry,
  type AiEngineDeps,
  type AiRegistrySnapshot,
  type AiRoutingLogEntry,
} from "../_shared/ai-core/index.ts";

type Json = Record<string, unknown>;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function env(key: string): string {
  const g = globalThis as unknown as { Deno?: { env?: { get?: (k: string) => string } }; process?: { env?: Record<string, string | undefined> } };
  return g.Deno?.env?.get?.(key) ?? g.process?.env?.[key] ?? "";
}
const SUPABASE_URL = () => env("SUPABASE_URL");
const SERVICE_KEY = () => env("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = () => env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
// SORAHNEX AI CORE — fournisseurs additionnels : AUCUNE liste en dur ici.
// Le registre central (`saas_business.ai_providers`) déclare, pour chaque
// fournisseur, le NOM de la variable d'environnement de sa clé
// (`api_key_env`) et, si nécessaire, celle de son identifiant de compte
// (`account_id_env`). Les conventions ci-dessous ne servent qu'au repli
// historique des intégrations déjà en production — elles ne nomment aucun
// fournisseur. Un fournisseur reste inactif tant que sa clé est absente ET
// que son modèle n'a pas passé un test API réel : aucun modèle non vérifié
// n'est jamais servi.
const MODEL_ENV_SUFFIX = "_MODEL";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}
function fail(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}
function str(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function rec(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}
/** Noms de variables de repli (conventions, aucun fournisseur nommé). */
function legacyEnvNames(providerKey: string): { apiKey: string[]; accountId: string[] } {
  const upper = providerKey.replace(/[^a-z0-9]+/gi, "_").toUpperCase();
  return {
    apiKey: [
      `BUSINESS_GROW_${upper}_API_KEY`,
      `BUSINESS_GROW_${upper}_API_TOKEN`,
      `${upper}_API_KEY`,
      `${upper}_API_TOKEN`,
    ],
    accountId: [`BUSINESS_GROW_${upper}_ACCOUNT_ID`, `${upper}_ACCOUNT_ID`],
  };
}

function firstEnv(names: string[]): string | null {
  for (const name of names) {
    const value = env(name);
    if (value) return value;
  }
  return null;
}

/**
 * Credentials d'un fournisseur, SANS liste de fournisseurs dans le code.
 *
 * L'ordre est celui du moteur : le registre d'abord (via `deps.env`), puis les
 * conventions historiques ci-dessus. Un fournisseur inconnu du code mais
 * déclaré au registre fonctionne donc immédiatement.
 */
function credentialsForProvider(providerKey: string): { apiKey: string | null; accountId: string | null } {
  const names = legacyEnvNames(providerKey);
  return { apiKey: firstEnv(names.apiKey), accountId: firstEnv(names.accountId) };
}

/** Rédaction : toute valeur de secret réellement présente côté Edge. */
function redact(text: string): string {
  let out = text;
  const secrets = new Set<string>();
  const serviceKey = SERVICE_KEY();
  if (serviceKey) secrets.add(serviceKey);
  // Les secrets connus sont collectés par NOM, jamais par fournisseur :
  // on parcourt l'environnement à la recherche des variables de credentials.
  const g = globalThis as unknown as { Deno?: { env?: { toObject?: () => Record<string, string> } } };
  const all = g.Deno?.env?.toObject?.() ?? {};
  for (const [name, value] of Object.entries(all)) {
    if (!value || value.length < 12) continue;
    if (/(_API_KEY|_API_TOKEN|_SECRET_KEY|SERVICE_ROLE_KEY)$/.test(name)) secrets.add(value);
  }
  for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
  return out;
}

/** Prompts système centralisés : toutes les fonctionnalités partagent la même voix. */
const SYSTEM = {
  brand: "Tu es SORAHNEX, l'assistant de création et de croissance des entreprises francophones. Tu réponds en français, avec des conseils concrets, sans jargon inutile.",
  honesty: "N'invente jamais de chiffres, de prix, de clients, de résultats ou de citations. Si une information manque, dis-le. Ne prétends pas avoir consulté le web ou le compte du client.",
  script: "Tu es SORAHNEX, expert en contenus UGC courts et crédibles. Tu produis des scripts structurés (accroche, scènes, texte dit, texte à l'écran, appel à l'action), sans allégation chiffrée inventée, sans promesse médicale, sans mention de concurrent. Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour.",
  prompt: "Tu es ingénieur prompt pour SORAHNEX. Réécris la demande de l'utilisateur en un prompt de génération vidéo clair, visuel et exploitable. Réponds uniquement en JSON valide.",
  hooks: "Tu es copywriter UGC. Réponds en JSON valide avec une liste d'accroches courtes.",
  scenes: "Tu es réalisateur UGC. Décris des scènes tournables, cohérentes et sobres. Réponds en JSON valide.",
};

/**
 * Identifiant de fournisseur : une CHAÎNE, pas une union fermée.
 *
 * La liste des fournisseurs servis vient du registre (`ai_providers`), jamais
 * de ce fichier : un fournisseur ajouté au registre est immédiatement
 * acceptable ici, sans modification de code.
 */
export type ProviderName = string;
export type MessageRole = "system" | "user" | "assistant";

type ProviderMessage = {
  role: MessageRole;
  content: string;
  images?: Array<{ mimeType: string; dataBase64: string }>;
};

interface ProviderResult {
  provider: ProviderName;
  model: string;
  content: string;
}

interface CompleteOptions {
  prefer?: ProviderName;
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Complétion via le routeur central (SORAHNEX AI GATEWAY → FreeLLMAPI).
 *
 * Aucun fournisseur n'est nommé ici : le registre décide de la chaîne, le
 * moteur applique le secours plafonné et journalise chaque tentative. Un échec
 * remonte tel quel — aucune réponse n'est fabriquée localement.
 */
export async function complete(messages: ProviderMessage[], options: CompleteOptions = {}): Promise<ProviderResult> {
  const routed: ProviderMessage[] = options.jsonMode
    ? messages.map((m) => m.role === "system"
        ? { ...m, content: `${m.content}\n\nRéponds uniquement avec un objet JSON valide, sans texte autour.` }
        : m)
    : messages;
  const outcome = await runAiCall(aiEngineDeps(), {
    messages: routed,
    options: {
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      ...(typeof options.maxTokens === "number" ? { maxOutputTokens: options.maxTokens } : {}),
    },
    preferProvider: options.prefer ?? null,
    space: "business",
    userId: null,
    taskKey: "central_complete",
  });
  if (outcome.ok && outcome.content && outcome.providerKey && outcome.providerModelKey) {
    return { provider: outcome.providerKey, model: outcome.providerModelKey, content: outcome.content };
  }
  const codes = outcome.attempts.map((a) => `${a.providerKey}:${a.errorCode ?? "?"}`).join(" · ");
  throw new Error(codes || outcome.code || "AI_PROVIDERS_UNAVAILABLE");
}

function parseJsonLoose(raw: string): Json {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return rec(JSON.parse(trimmed)); } catch { /* continue */ }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return rec(JSON.parse(trimmed.slice(start, end + 1))); } catch { /* continue */ }
  }
  return {};
}

/* -------------------------------------------------------------------------- */
/* Quotas (mêmes RPC que la passerelle IA historique)                          */
/* -------------------------------------------------------------------------- */

async function rpc(name: string, args: Json, userJwt: string): Promise<{ ok: boolean; data: unknown; error: string }> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: ANON_KEY(), Authorization: userJwt, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) return { ok: false, data: null, error: typeof data === "object" && data && "message" in data ? String((data as Json).message) : text };
  return { ok: true, data, error: "" };
}
async function refund(kind: string, referenceId: string | null, userId: string): Promise<void> {
  if (!SERVICE_KEY()) return;
  await fetch(`${SUPABASE_URL()}/rest/v1/rpc/reelora_refund_quota`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY(), Authorization: `Bearer ${SERVICE_KEY()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_kind: kind, p_reference_id: referenceId, p_user_id: userId }),
  }).catch(() => undefined);
}
function quotaFailure(raw: string): { code: string; message: string; status: number } {
  if (raw.includes("account_not_active")) return { code: "ACCOUNT_SUSPENDED", message: "Votre compte est suspendu. Contactez l’administration.", status: 403 };
  if (raw.includes("not_vyora_customer")) return { code: "NOT_A_CUSTOMER", message: "Ce compte n’a pas encore d’espace client SORAHNEX. Terminez votre inscription pour utiliser l’IA.", status: 403 };
  if (raw.includes("not_authenticated")) return { code: "UNAUTHENTICATED", message: "Session expirée, reconnectez-vous.", status: 401 };
  if (raw.includes("quota_exceeded")) return { code: "QUOTA_EXCEEDED", message: "Votre limite mensuelle est atteinte. Passez à une formule supérieure depuis l’abonnement.", status: 429 };
  return { code: "QUOTA_ERROR", message: redact(`Limites indisponibles : ${raw}`), status: 400 };
}

async function authUserId(jwt: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL()}/auth/v1/user`, {
    headers: { apikey: ANON_KEY(), Authorization: jwt },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return str(rec(data).id, 80) || null;
}

function scriptPrompt(body: Json): string {
  const product = str(body.product, 300) || str(body.brief, 500) || "le produit";
  const audience = str(body.audience, 300) || "grand public francophone";
  const platform = str(body.platform, 60) || "TikTok";
  const tone = str(body.tone, 80) || "authentique et naturel";
  const duration = clamp(body.duration, 5, 90, 15);
  const objective = str(body.objective, 300) || "non précisé";
  const market = str(body.market, 120) || "non précisé";
  return [
    `Produit : ${product}`,
    `Audience : ${audience}`,
    `Plateforme : ${platform}`,
    `Ton : ${tone}`,
    `Durée cible : ${duration} secondes`,
    `Objectif marketing : ${objective}`,
    `Marché : ${market}`,
    `Brief : ${str(body.brief, 1500) || "aucun"}`,
    "Contraintes : 3 à 6 scènes maximum, pas de chiffre inventé, pas de promesse irréaliste.",
    "Format JSON attendu : {\"hook\":string,\"script_text\":string,\"call_to_action\":string,\"marketing_angle\":string,\"claims_to_avoid\":string[],\"scenes\":[{\"scene_number\":number,\"visual_prompt\":string,\"spoken_text\":string,\"subtitle\":string}]}",
  ].join("\n");
}

function parseScenes(parsed: Json): Json[] {
  if (!Array.isArray(parsed.scenes)) return [];
  return (parsed.scenes as unknown[]).slice(0, 8).map((scene, index) => {
    const item = rec(scene);
    return {
      scene_number: Number(item.scene_number) || index + 1,
      visual_prompt: str(item.visual_prompt ?? item.visual, 800),
      spoken_text: str(item.spoken_text ?? item.text, 800),
      subtitle: str(item.subtitle, 300),
    };
  });
}

function readHistory(body: Json): ProviderMessage[] {
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const history: ProviderMessage[] = [];
  for (const entry of raw.slice(-24)) {
    const item = rec(entry);
    const content = str(item.content, 8000);
    const role = str(item.role, 12);
    const parsedImages = parseImageInputs(item.images);
    // Une image invalide ne doit pas faire croire qu'elle a été vue : on
    // l'écarte et le texte du message reste la seule entrée transmise.
    const images = parsedImages.ok ? parsedImages.images : [];
    if (!content && images.length === 0) continue;
    if (role !== "system" && role !== "user" && role !== "assistant") continue;
    history.push({ role, content, ...(images.length ? { images } : {}) });
  }
  return history;
}

/* -------------------------------------------------------------------------- */
/* SORAHNEX AI CORE — hôte du moteur central                                     */
/*                                                                             */
/* Le moteur central est le SEUL point d'appel IA du produit : Grow  */
/* et Studio UGC y convergent. Il s'appuie sur le registre Supabase (fournis- */
/* seurs, modèles vérifiés, règles, budgets) et sur les 7 adaptateurs de la   */
/* pile partagée. Les secrets restent ici (Edge) : le navigateur ne voit       */
/* jamais de clé. Un appel interne (moteur BG) n'est pas double-facturé.       */
/* -------------------------------------------------------------------------- */

/**
 * Fournisseurs configurables : liste construite À L'EXÉCUTION.
 *
 * Le moteur complète lui-même cet ensemble avec les fournisseurs du registre
 * dont la clé se résout (`api_key_env`), y compris ceux que ce fichier ne
 * connaît pas. On n'énumère donc ici aucun fournisseur.
 */
function aiCoreConfiguredProviders(): ReadonlySet<string> {
  return new Set<string>();
}

// Cache court du registre : la base n'est pas relue à chaque appel.
let registryCache: { at: number; value: AiRegistrySnapshot | null } = { at: 0, value: null };
const REGISTRY_TTL_MS = 60_000;

async function loadRegistrySnapshot(): Promise<AiRegistrySnapshot | null> {
  const now = Date.now();
  if (registryCache.value !== null && now - registryCache.at < REGISTRY_TTL_MS) return registryCache.value;
  const url = SUPABASE_URL();
  const key = SERVICE_KEY();
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/vyora_ai_registry_snapshot`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const parsed = parseRegistrySnapshot(await res.json());
    if (parsed) {
      // L'URL de base peut venir d'un secret (FREE_LLM_API_BASE_URL) : elle est
      // alors prioritaire sur la valeur figée au registre, sans redéploiement.
      for (const provider of parsed.providers) {
        const override = provider.baseUrlEnv ? env(provider.baseUrlEnv) : "";
        if (override) provider.baseUrl = override.replace(/\/+$/, "");
      }
      registryCache = { at: now, value: parsed };
    }
    return parsed;
  } catch {
    return null;
  }
}

// Journalisation : UNE ligne par tentative réelle (ai_calls_log), jamais
// bloquante pour l'appel IA, jamais de secret.
async function logAiCall(entry: AiCallLogEntry): Promise<void> {
  const url = SUPABASE_URL();
  const key = SERVICE_KEY();
  if (!url || !key || !entry.attempts.length) return;
  const lastSuccess = entry.attempts.length - 1;
  for (let i = 0; i < entry.attempts.length; i += 1) {
    const attempt = entry.attempts[i];
    const isFinalSuccess = attempt.status === "success" && i === lastSuccess;
    try {
      await fetch(`${url}/rest/v1/rpc/vyora_ai_log_call`, {
        method: "POST",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          p_space: entry.space,
          p_user_id: entry.userId && entry.userId !== "service" ? entry.userId : null,
          p_workspace_id: entry.workspaceId,
          p_task_key: entry.taskKey,
          p_provider_key: attempt.providerKey,
          p_model_key: attempt.modelKey,
          p_provider_model_key: attempt.providerModelKey,
          p_attempt_number: attempt.attempt,
          p_status: attempt.status,
          p_error_code: attempt.errorCode,
          p_input_tokens: attempt.inputTokens,
          p_output_tokens: attempt.outputTokens,
          p_latency_ms: attempt.latencyMs,
          p_cost_input_usd: isFinalSuccess ? entry.costInputUsd : null,
          p_cost_output_usd: isFinalSuccess ? entry.costOutputUsd : null,
          p_fallback_from: i > 0 ? entry.attempts[i - 1].providerKey : null,
        }),
        signal: AbortSignal.timeout(4_000),
      });
    } catch {
      // La journalisation ne doit jamais faire échouer l'appel IA.
    }
  }
}

/**
 * État de configuration, fournisseur par fournisseur, SANS liste en dur.
 *
 * La source est le registre : chaque ligne `ai_providers` donne le nom de la
 * variable de sa clé (`api_key_env`) et, si besoin, de son identifiant de
 * compte (`account_id_env`). Aucune valeur de secret ne sort d'ici — seulement
 * « configuré ou non » et, éventuellement, le nom du modèle configuré.
 */
async function providerHealth(): Promise<Record<string, { configured: boolean; model: string | null }>> {
  const snapshot = await loadRegistrySnapshot();
  const keys = new Set<string>((snapshot?.providers ?? []).map((p) => p.key));
  // Repli sans registre : les fournisseurs dont un secret existe déjà.
  const conventions = Object.keys(
    (globalThis as unknown as { Deno?: { env?: { toObject?: () => Record<string, string> } } })
      .Deno?.env?.toObject?.() ?? {},
  )
    .map((name) => name.match(/^([A-Z0-9]+)_(?:API_KEY|API_TOKEN|AUTH_TOKEN)$/)?.[1] ?? "")
    .filter((key) => key && key !== "SUPABASE" && key !== "ANON" && key !== "SERVICE");
  for (const key of conventions) keys.add(key.toLowerCase());

  const out: Record<string, { configured: boolean; model: string | null }> = {};
  for (const key of keys) {
    const credentials = credentialsForProvider(key);
    const model = firstEnv([
      ...legacyEnvNames(key).apiKey.map((name) => name.replace(/_API_KEY$|_API_TOKEN$/, MODEL_ENV_SUFFIX)),
      `${key.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}${MODEL_ENV_SUFFIX}`,
    ]);
    out[key] = { configured: Boolean(credentials.apiKey), model };
  }
  return out;
}

/** Appel d'une RPC PostgREST — jamais bloquant pour l'appel IA. */
async function callRpc(name: string, body: unknown, timeoutMs = 4_000): Promise<unknown> {
  const url = SUPABASE_URL();
  const key = SERVICE_KEY();
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  } catch {
    return null;
  }
}

/**
 * Idempotence : réserve la clé d'appel. Refus = l'appel ne part PAS chez le
 * fournisseur (anti-double-facturation). Si la RPC est indisponible, l'appel est bloqué.
 */
async function claimAiCall(
  requestKey: string,
  meta: { space: 'business' | 'studio' | 'system'; userId?: string | null; workspaceId?: string | null },
): Promise<{ claimed: boolean; status: string; providerKey: string | null; modelKey: string | null; outcomeCode: string | null }> {
  const body = {
    p_request_key: requestKey,
    p_space: meta.space,
    p_user_id: meta.userId && meta.userId !== "service" ? meta.userId : null,
    p_workspace_id: meta.workspaceId ?? null,
  };
  const payload = await callRpc("vyora_ai_claim_call", body, 5_000);
  if (payload && typeof payload === "object") {
    const row = rec(payload);
    if (typeof row.claimed === "boolean") {
      return {
        claimed: row.claimed,
        status: typeof row.status === "string" ? row.status : "in_flight",
        providerKey: typeof row.provider_key === "string" ? row.provider_key : null,
        modelKey: typeof row.model_key === "string" ? row.model_key : null,
        outcomeCode: typeof row.outcome_code === "string" ? row.outcome_code : null,
      };
    }
  }
  throw new Error("AI_IDEMPOTENCY_UNAVAILABLE");
}

async function releaseAiCall(params: {
  requestKey: string;
  status: 'succeeded' | 'failed';
  providerKey: string | null;
  modelKey: string | null;
  outcomeCode: string | null;
  contentChars: number | null;
}): Promise<void> {
  await callRpc("vyora_ai_release_call", {
    p_request_key: params.requestKey,
    p_status: params.status,
    p_provider_key: params.providerKey,
    p_model_key: params.modelKey,
    p_outcome_code: params.outcomeCode,
    p_content_chars: params.contentChars,
  });
}

/** Journal de la DÉCISION de routage : chaîne + scores + raison, aucun secret. */
async function logAiRouting(entry: AiRoutingLogEntry): Promise<void> {
  await callRpc("vyora_ai_log_routing", { p_payload: routingLogPayload(entry) });
}

function aiEngineDeps(): AiEngineDeps {
  return {
    loadRegistry: loadRegistrySnapshot,
    configuredProviders: aiCoreConfiguredProviders,
    credentials: (providerKey) => credentialsForProvider(providerKey),
    // Noms uniquement : le registre fournit `api_key_env` / `account_id_env`,
    // le moteur lit leur VALEUR ici, côté serveur, sans jamais la journaliser.
    env: (name) => env(name) || null,
    fetcher: fetch,
    logCall: logAiCall,
    logRouting: logAiRouting,
    claimCall: (requestKey, meta) => claimAiCall(requestKey, meta),
    releaseCall: releaseAiCall,
  };
}

interface CompleteResultEx extends ProviderResult {
  tokenUsage: { input_tokens: number | null; output_tokens: number | null } | null;
  costUsd: number | null;
}

/**
 * Exécute une complétion via le moteur central.
 * - Si une route (modèle et/ou rôle) est fournie, passe par le registre
 *   multi-fournisseurs avec secours plafonné (SORAHNEX AI CORE).
 * - Sinon, conserve le comportement historique (Groq → Gemini).
 */
async function completeViaCore(
  messages: ProviderMessage[],
  options: CompleteOptions,
  meta: { routeModel: string | null; roleKey: string | null; userId: string | null; requestKey: string | null },
): Promise<CompleteResultEx> {
  // Une image impose le registre (capacité vision) même sans rôle explicite.
  if (meta.routeModel || meta.roleKey || meta.requestKey || messages.some((m) => m.images?.length)) {
    const outcome = await runAiCall(aiEngineDeps(), {
      messages,
      options: {
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.maxTokens === "number" ? { maxOutputTokens: options.maxTokens } : {}),
      },
      role: meta.roleKey,
      preferProvider: options.prefer ?? null,
      space: "business",
      userId: meta.userId,
      taskKey: meta.roleKey,
      requestKey: meta.requestKey,
    });
    if (outcome.ok && outcome.content && outcome.providerKey && outcome.providerModelKey) {
      return {
        provider: outcome.providerKey as ProviderName,
        model: outcome.providerModelKey,
        content: outcome.content,
        tokenUsage: { input_tokens: outcome.inputTokens, output_tokens: outcome.outputTokens },
        costUsd: outcome.estimatedCostUsd,
      };
    }
    // A hard budget rejection must never escape through the legacy fallback.
    if (outcome.code === "BUDGET_EXHAUSTED") throw new Error("BUDGET_EXHAUSTED");
    // Rejeu d'un appel déjà en vol : aucune dépense, aucune seconde requête.
    if (outcome.code === "AI_DUPLICATE_IN_FLIGHT") {
      throw new Error("AI_DUPLICATE_IN_FLIGHT");
    }
    // Au moins UNE tentative réelle a échoué : on ne relance PAS le chemin
    // historique (les mêmes fournisseurs seraient double sollicités/facturés).
    if (outcome.attempts.length > 0) {
      const codes = outcome.attempts.map((a) => `${a.providerKey}:${a.errorCode ?? "?"}`).join(" · ");
      throw new Error(`${outcome.code ?? "AI_PROVIDER_ERROR"} · ${codes}`);
    }
    // Explicitly routed requests must not bypass registry, budget or idempotency.
    throw new Error(outcome.code ?? "AI_ROUTING_UNAVAILABLE");
  }
  const result = await complete(messages, options);
  return { ...result, tokenUsage: null, costUsd: null };
}

// Exposé pour le chargeur de production (`new Function`) : le bundle n'a pas
// d'exports ES, il publie donc le handler sur l'objet global avant Deno.serve.
const runtimeGlobal = globalThis as unknown as {
  __vyoraAiHandler?: (req: Request) => Promise<Response>;
  Deno?: { serve?: (fn: (req: Request) => Promise<Response>) => void };
};

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", "Méthode non autorisée.", 405);
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return fail("UNAUTHENTICATED", "Authentification requise.", 401);
  if (!SUPABASE_URL() || !SERVICE_KEY() || !ANON_KEY()) return fail("SERVER_NOT_CONFIGURED", "Configuration Supabase absente côté serveur.", 500);

  // Appel interne (Grow, workers) : jeton service exact, jamais exposé au client.
  const internal = authorization.trim() === `Bearer ${SERVICE_KEY()}`;

  let body: Json;
  try { body = rec(await req.json()); } catch { return fail("INVALID_BODY", "Corps de requête JSON invalide.", 400); }
  const action = str(body.action, 40) || "complete";
  // Aucune liste d'autorisation ici : un identifiant bien formé est accepté,
  // et le moteur ne sert que les fournisseurs réellement configurés.
  const preferRaw = str(body.prefer, 40).toLowerCase();
  const prefer: ProviderName | undefined = /^[a-z][a-z0-9_-]{1,39}$/.test(preferRaw) ? preferRaw : undefined;
  const projectId = str(body.project_id, 80) || null;
  const temperature = Number.isFinite(Number(body.temperature)) ? clamp(body.temperature, 0, 2, 0.7) : undefined;

  if (action === "health") {
    return json({
      service: "vyora-ai",
      status: "ok",
      internal,
      providers: await providerHealth(),
    });
  }

  let userId = "service";
  if (!internal) {
    const resolved = await authUserId(authorization);
    if (!resolved) return fail("UNAUTHENTICATED", "Jeton utilisateur invalide.", 401);
    userId = resolved;
  }

  const quotaKind = action === "generate_script" ? "script" : "prompt";
  let usage: unknown = null;
  if (!internal) {
    const quota = await rpc("reelora_consume_quota", { p_kind: quotaKind, p_reference_id: projectId, p_metadata: { action } }, authorization);
    if (!quota.ok) {
      const failure = quotaFailure(quota.error);
      return fail(failure.code, failure.message, failure.status);
    }
    usage = quota.data;
  }

  try {
    if (action === "generate_script") {
      const result = await complete([
        { role: "system", content: `${SYSTEM.script}\n${SYSTEM.honesty}` },
        { role: "user", content: scriptPrompt(body) },
      ], { prefer, jsonMode: true, maxTokens: 2400 });
      const parsed = parseJsonLoose(result.content);
      const scriptText = str(parsed.script_text ?? parsed.script ?? parsed.content, 4000);
      if (!scriptText) throw new Error("AI_EMPTY_RESPONSE");
      const scenes = parseScenes(parsed);
      let scriptId: string | null = null;
      if (projectId && !internal) {
        const saved = await rpc("reelora_save_script", {
          p_project_id: projectId,
          p_script_text: scriptText,
          p_hook: str(parsed.hook, 300),
          p_call_to_action: str(parsed.call_to_action ?? parsed.cta, 300),
          p_marketing_angle: str(parsed.marketing_angle ?? parsed.angle, 200) || null,
          p_language: str(body.language, 10) || "fr",
          p_claims_to_avoid: Array.isArray(parsed.claims_to_avoid) ? parsed.claims_to_avoid.slice(0, 20).map(String) : [],
        }, authorization);
        if (saved.ok && typeof saved.data === "string") scriptId = saved.data;
      }
      return json({
        action, provider: result.provider, model: result.model,
        hook: str(parsed.hook, 300),
        script_text: scriptText,
        call_to_action: str(parsed.call_to_action ?? parsed.cta, 300),
        marketing_angle: str(parsed.marketing_angle ?? parsed.angle, 200),
        claims_to_avoid: Array.isArray(parsed.claims_to_avoid) ? parsed.claims_to_avoid.slice(0, 20).map(String) : [],
        scenes, script_id: scriptId, usage,
      });
    }

    if (action === "improve_prompt") {
      const content = str(body.content, 8000);
      if (content.length < 10) return fail("INVALID_INPUT", "Le prompt doit contenir au moins 10 caractères.", 400);
      const result = await complete([
        { role: "system", content: `${SYSTEM.prompt}\nFormat JSON : {"content":string,"variables":string[]}` },
        { role: "user", content },
      ], { prefer, jsonMode: true, maxTokens: 1200 });
      const parsed = parseJsonLoose(result.content);
      const improved = str(parsed.content, 8000);
      if (!improved) throw new Error("AI_EMPTY_RESPONSE");
      return json({ action, provider: result.provider, content: improved, variables: Array.isArray(parsed.variables) ? parsed.variables.slice(0, 20).map(String) : [], usage });
    }

    if (action === "generate_hooks") {
      const result = await complete([
        { role: "system", content: `${SYSTEM.hooks}\nFormat JSON : {"hooks":string[]} (5 accroches maximum).` },
        { role: "user", content: `Produit : ${str(body.product, 300)}\nAudience : ${str(body.audience, 300)}\nPlateforme : ${str(body.platform, 60) || "TikTok"}` },
      ], { prefer, jsonMode: true, maxTokens: 800 });
      const parsedHooks = parseJsonLoose(result.content);
      const hooks = Array.isArray(parsedHooks.hooks)
        ? (parsedHooks.hooks as unknown[]).slice(0, 5).map((hook) => str(hook, 200)).filter(Boolean)
        : [];
      if (!hooks.length) throw new Error("AI_EMPTY_RESPONSE");
      return json({ action, provider: result.provider, hooks, usage });
    }

    if (action === "generate_visual") {
      const result = await complete([
        { role: "system", content: `${SYSTEM.scenes}\nFormat JSON : {"text":string}` },
        { role: "user", content: `Produit : ${str(body.product, 300)}\nAction : ${str(body.scene_action, 300)}\nAmbiance : ${str(body.ambiance, 200)}` },
      ], { prefer, jsonMode: true, maxTokens: 600 });
      const text = str(parseJsonLoose(result.content).text, 1200);
      if (!text) throw new Error("AI_EMPTY_RESPONSE");
      return json({ action, provider: result.provider, text, usage });
    }

    if (action === "generate_scenes") {
      const script = str(body.script_text, 6000);
      if (script.length < 10) return fail("INVALID_INPUT", "Le script est trop court.", 400);
      const duration = clamp(body.duration, 5, 120, 30);
      const result = await complete([
        { role: "system", content: `${SYSTEM.scenes}\nFormat JSON : {"scenes":[{"scene_number":number,"visual_prompt":string,"spoken_text":string,"subtitle":string}]}` },
        { role: "user", content: `Script :\n${script}\n\nDurée totale cible : ${duration} secondes.` },
      ], { prefer, jsonMode: true, maxTokens: 2000 });
      const scenes = parseScenes(parseJsonLoose(result.content));
      if (!scenes.length) throw new Error("AI_EMPTY_RESPONSE");
      return json({ action, provider: result.provider, scenes, usage });
    }

    if (action === "complete") {
      const history = readHistory(body);
      let messages: ProviderMessage[] = history;
      if (!messages.length) {
        const prompt = str(body.prompt, 8000);
        if (!prompt) return fail("INVALID_INPUT", "prompt ou messages requis.", 400);
        const system = str(body.system, 4000) || `${SYSTEM.brand}\n${SYSTEM.honesty}`;
        messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
      } else if (!messages.some((m) => m.role === "system")) {
        messages = [{ role: "system", content: `${SYSTEM.brand}\n${SYSTEM.honesty}` }, ...messages];
      }
      const result = await completeViaCore(
        messages,
        {
          prefer,
          maxTokens: clamp(body.max_tokens, 64, 4096, 2400),
          jsonMode: body.json === true,
          ...(temperature === undefined ? {} : { temperature }),
        },
        {
          routeModel: str(body.model, 120) || null,
          roleKey: str(body.role_key, 40) || null,
          userId: internal ? null : userId,
          // Clé d'idempotence fournie par l'appelant (rejeu réseau) : un même
          // appel ne repart jamais deux fois chez le fournisseur.
          requestKey: (() => {
            const raw = str(body.request_key, 120);
            return /^[A-Za-z0-9._:-]{8,120}$/.test(raw) ? raw : null;
          })(),
        },
      );
      return json({
        action,
        provider: result.provider,
        model: result.model,
        content: result.content,
        usage,
        ...(result.tokenUsage ? { token_usage: result.tokenUsage } : {}),
        ...(internal && result.costUsd !== null ? { cost_usd: result.costUsd } : {}),
      });
    }

    return fail("UNKNOWN_ACTION", "Action IA inconnue.", 400);
  } catch (error) {
    if (!internal) await refund(quotaKind, projectId, userId);
    const message = redact(error instanceof Error ? error.message : String(error));
    const status = message.includes("DUPLICATE") ? 409 : 502;
    const code = message.includes("DUPLICATE") ? "AI_DUPLICATE_IN_FLIGHT"
      : message.includes("NOT_CONFIGURED") ? "AI_NOT_CONFIGURED"
      : message.includes("BUDGET") ? "AI_BUDGET_EXHAUSTED"
        : message.includes("TIMEOUT") ? "AI_TIMEOUT"
          : message.includes("SAFETY") ? "AI_SAFETY_BLOCKED"
            : "AI_PROVIDER_ERROR";
    if (code === "AI_DUPLICATE_IN_FLIGHT") {
      return fail(code, "Cet appel IA est déjà en cours ou déjà terminé : aucune seconde requête n’a été envoyée au fournisseur.", status);
    }
    return fail(code, internal ? `Le fournisseur IA n’a pas pu répondre : ${message}. Aucun texte n’a été inventé.` : "Le service IA n’a pas pu répondre. Aucun texte n’a été inventé.", status);
  }
}

runtimeGlobal.__vyoraAiHandler = handler;
runtimeGlobal.Deno?.serve?.(handler);
