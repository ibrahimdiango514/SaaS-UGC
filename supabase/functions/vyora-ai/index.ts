// VYORA — moteur IA central (Groq + Gemini) pour tous les espaces.
//
// Un seul endpoint serveur, une interface de fournisseur unifiée, un routage
// explicite et un secours automatique. Les clés restent des secrets Edge :
//   BUSINESS_GROW_GROQ_API_KEY / BUSINESS_GROW_GROQ_MODEL
//   BUSINESS_GROW_GEMINI_API_KEY / BUSINESS_GROW_GEMINI_MODEL
//   (repli : GROQ_API_KEY / GROQ_MODEL, GEMINI_API_KEY / GEMINI_MODEL)
//
// Actions : health | generate_script | improve_prompt | generate_hooks |
//           generate_visual | generate_scenes | complete
// `complete` accepte `messages` (system/user/assistant) pour les espaces qui
// mènent une conversation (Business Growth) ou `system` + `prompt`.
//
// Appels internes serveur à serveur : un appel portant exactement la clé
// service comme jeton n'est pas facturé en quota (l'espace appelant gère déjà
// ses propres limites) ; un appel utilisateur consomme une unité de quota et
// est restitué si le fournisseur échoue.
//
// Aucune réponse n'est fabriquée localement : un échec fournisseur est renvoyé
// tel quel (code + message).

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
const GROQ_KEY = () => env("BUSINESS_GROW_GROQ_API_KEY") || env("GROQ_API_KEY");
const GEMINI_KEY = () => env("BUSINESS_GROW_GEMINI_API_KEY") || env("GEMINI_API_KEY");
const GROQ_MODEL = () => env("BUSINESS_GROW_GROQ_MODEL") || env("GROQ_MODEL") || "llama-3.3-70b-versatile";
const GEMINI_MODEL = () => env("BUSINESS_GROW_GEMINI_MODEL") || env("GEMINI_MODEL") || "gemini-2.0-flash";

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
function redact(text: string): string {
  let out = text;
  for (const key of [GROQ_KEY(), GEMINI_KEY(), SERVICE_KEY()]) if (key) out = out.split(key).join("[REDACTED]");
  return out;
}

/** Prompts système centralisés : toutes les fonctionnalités partagent la même voix. */
const SYSTEM = {
  brand: "Tu es VYORA, l'assistant de création et de croissance des entreprises francophones. Tu réponds en français, avec des conseils concrets, sans jargon inutile.",
  honesty: "N'invente jamais de chiffres, de prix, de clients, de résultats ou de citations. Si une information manque, dis-le. Ne prétends pas avoir consulté le web ou le compte du client.",
  script: "Tu es VYORA, expert en contenus UGC courts et crédibles. Tu produis des scripts structurés (accroche, scènes, texte dit, texte à l'écran, appel à l'action), sans allégation chiffrée inventée, sans promesse médicale, sans mention de concurrent. Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour.",
  prompt: "Tu es ingénieur prompt pour VYORA. Réécris la demande de l'utilisateur en un prompt de génération vidéo clair, visuel et exploitable. Réponds uniquement en JSON valide.",
  hooks: "Tu es copywriter UGC. Réponds en JSON valide avec une liste d'accroches courtes.",
  scenes: "Tu es réalisateur UGC. Décris des scènes tournables, cohérentes et sobres. Réponds en JSON valide.",
};

export type ProviderName = "groq" | "gemini";
export type MessageRole = "system" | "user" | "assistant";

type ProviderMessage = { role: MessageRole; content: string };

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

function joinSystem(messages: ProviderMessage[]): string {
  return messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
}

async function callGroq(messages: ProviderMessage[], options: CompleteOptions): Promise<ProviderResult> {
  const key = GROQ_KEY();
  if (!key) throw new Error("GROQ_NOT_CONFIGURED");
  const payload: Json = {
    model: GROQ_MODEL(),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: options.maxTokens ?? 2400,
    temperature: options.temperature ?? 0.7,
  };
  if (options.jsonMode) payload.response_format = { type: "json_object" };
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GROQ_ERROR: ${text.slice(0, 300)}`);
  const data = rec(JSON.parse(text || "{}"));
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const content = str(rec(rec(choices[0]).message).content, 12000);
  if (!content) throw new Error("AI_EMPTY_RESPONSE");
  return { provider: "groq", model: GROQ_MODEL(), content };
}

async function callGemini(messages: ProviderMessage[], options: CompleteOptions): Promise<ProviderResult> {
  const key = GEMINI_KEY();
  if (!key) throw new Error("GEMINI_NOT_CONFIGURED");
  const model = GEMINI_MODEL();
  const system = joinSystem(messages);
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  if (!contents.length) throw new Error("AI_EMPTY_RESPONSE");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 2400,
        temperature: options.temperature ?? 0.7,
        ...(options.jsonMode ? { responseMimeType: "application/json" } : {}),
      },
    }),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GEMINI_ERROR: ${text.slice(0, 300)}`);
  const data = rec(JSON.parse(text || "{}"));
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const candidate = rec(candidates[0]);
  const finish = str(candidate.finishReason, 40);
  if (finish === "SAFETY" || finish === "RECITATION") throw new Error("PROVIDER_SAFETY_BLOCKED");
  const parts = rec(candidate.content).parts;
  const content = Array.isArray(parts)
    ? parts.map((part) => str(rec(part).text, 12000)).filter(Boolean).join("\n").trim()
    : "";
  if (!content) throw new Error("AI_EMPTY_RESPONSE");
  return { provider: "gemini", model, content };
}

/**
 * Routage : fournisseur demandé s'il est configuré, sinon Groq puis Gemini.
 * Le second fournisseur sert de secours sur erreur/timeout, jamais de simulation.
 */
export async function complete(messages: ProviderMessage[], options: CompleteOptions = {}): Promise<ProviderResult> {
  const order: ProviderName[] = options.prefer === "gemini"
    ? ["gemini", "groq"]
    : options.prefer === "groq"
      ? ["groq", "gemini"]
      : GEMINI_KEY() && !GROQ_KEY() ? ["gemini", "groq"] : ["groq", "gemini"];
  const errors: string[] = [];
  for (const provider of order) {
    if (provider === "groq" && !GROQ_KEY()) { errors.push("GROQ_NOT_CONFIGURED"); continue; }
    if (provider === "gemini" && !GEMINI_KEY()) { errors.push("GEMINI_NOT_CONFIGURED"); continue; }
    try {
      return provider === "groq" ? await callGroq(messages, options) : await callGemini(messages, options);
    } catch (error) {
      const raw = redact(error instanceof Error ? error.message : String(error));
      errors.push(/abort|timeout|timed out/i.test(raw) ? "PROVIDER_TIMEOUT" : raw);
    }
  }
  throw new Error(errors.join(" · ") || "AI_PROVIDERS_UNAVAILABLE");
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
  if (raw.includes("not_vyora_customer")) return { code: "NOT_A_CUSTOMER", message: "Ce compte n’a pas encore d’espace client VYORA. Terminez votre inscription pour utiliser l’IA.", status: 403 };
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
    if (!content) continue;
    if (role !== "system" && role !== "user" && role !== "assistant") continue;
    history.push({ role, content });
  }
  return history;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", "Méthode non autorisée.", 405);
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return fail("UNAUTHENTICATED", "Authentification requise.", 401);
  if (!SUPABASE_URL() || !SERVICE_KEY() || !ANON_KEY()) return fail("SERVER_NOT_CONFIGURED", "Configuration Supabase absente côté serveur.", 500);

  // Appel interne (Business Growth, workers) : jeton service exact, jamais exposé au client.
  const internal = authorization.trim() === `Bearer ${SERVICE_KEY()}`;

  let body: Json;
  try { body = rec(await req.json()); } catch { return fail("INVALID_BODY", "Corps de requête JSON invalide.", 400); }
  const action = str(body.action, 40) || "complete";
  const prefer = str(body.prefer, 20) === "gemini" ? "gemini" : str(body.prefer, 20) === "groq" ? "groq" : undefined;
  const projectId = str(body.project_id, 80) || null;
  const temperature = Number.isFinite(Number(body.temperature)) ? clamp(body.temperature, 0, 2, 0.7) : undefined;

  if (action === "health") {
    return json({
      service: "vyora-ai",
      status: "ok",
      internal,
      providers: {
        groq: { configured: Boolean(GROQ_KEY()), model: GROQ_MODEL() },
        gemini: { configured: Boolean(GEMINI_KEY()), model: GEMINI_MODEL() },
      },
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
      const result = await complete(messages, {
        prefer,
        maxTokens: clamp(body.max_tokens, 64, 4096, 2400),
        jsonMode: body.json === true,
        ...(temperature === undefined ? {} : { temperature }),
      });
      return json({ action, provider: result.provider, model: result.model, content: result.content, usage });
    }

    return fail("UNKNOWN_ACTION", "Action IA inconnue.", 400);
  } catch (error) {
    if (!internal) await refund(quotaKind, projectId, userId);
    const message = redact(error instanceof Error ? error.message : String(error));
    const code = message.includes("NOT_CONFIGURED") ? "AI_NOT_CONFIGURED"
      : message.includes("TIMEOUT") ? "AI_TIMEOUT"
        : message.includes("SAFETY") ? "AI_SAFETY_BLOCKED"
          : "AI_PROVIDER_ERROR";
    return fail(code, `Le fournisseur IA n’a pas pu répondre : ${message}. Aucun texte n’a été inventé.`, 502);
  }
}

const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (req: Request) => Promise<Response>) => void } };
if (runtime.Deno?.serve) runtime.Deno.serve(handler);
