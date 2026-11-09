// Reelora AI — Groq-powered script, prompt, hook and scene generation.
// The GROQ_API_KEY is read only here, server-side. No key is ever sent to the browser.
// Every call consumes a plan quota through a SECURITY DEFINER RPC executed with the
// caller's JWT; credits are never handled by this function.
//
// NO SIMULATED AI RESPONSES: when Groq is absent, errors, or returns an empty
// payload, this function fails explicitly (GROQ_NOT_CONFIGURED / AI_PROVIDER_ERROR /
// AI_EMPTY_RESPONSE) and refunds the consumed quota unit. It never invents a
// script, a prompt, a hook or a scene locally. See tests/groq.test.ts.

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-application-name, x-retry-count",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

type Json = Record<string, unknown>;

// Works in Deno (Supabase Edge) and in Node (Vitest with injected process.env),
// so the unavailability states can be unit-tested without a live Groq key.
function env(key: string): string {
  const g = globalThis as unknown as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(key) ?? g.process?.env?.[key] ?? "";
}

const AI_EMPTY_MESSAGE = "Le service IA n’a renvoyé aucun contenu exploitable. Aucun texte n’est généré ni simulé ; réessayez ou saisissez votre texte manuellement.";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function fail(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}

function str(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback;
}

const SUPABASE_URL = () => env("SUPABASE_URL");
const ANON_KEY = () => env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
const SERVICE_KEY = () => env("SUPABASE_SERVICE_ROLE_KEY");
const GROQ_KEY = () => env("GROQ_API_KEY");

function rpcHeaders(userJwt: string): Record<string, string> {
  return { apikey: ANON_KEY(), Authorization: userJwt, "Content-Type": "application/json" };
}

async function rpc(name: string, args: Json, userJwt: string): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { ...rpcHeaders(userJwt), Prefer: "return=representation" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === "object" && data !== null && "message" in data
      ? String((data as Json).message) : text || `HTTP ${res.status}`;
    return { ok: false, data: null, error: msg };
  }
  return { ok: true, data };
}

// Service-role-only RPC: gives back a quota unit when Groq fails. Clients must
// never be able to execute this function (see migration reelora_v1_secure_refund).
async function rpcService(name: string, args: Json): Promise<void> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY(), Authorization: `Bearer ${SERVICE_KEY()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) console.error("service rpc failed", name, await res.text());
}

// Validate the caller JWT with GoTrue instead of decoding it locally: the user id
// used for quota refunds comes from a verified token, not from an unsigned payload.
async function authUserId(userJwt: string): Promise<string | null> {
  try {
    const res = await fetch(`${SUPABASE_URL()}/auth/v1/user`, {
      headers: { apikey: ANON_KEY(), Authorization: userJwt },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const u = await res.json() as Json;
    return typeof u.id === "string" ? u.id : null;
  } catch { return null; }
}

async function restGet(path: string, userJwt: string): Promise<unknown[]> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${path}`, {
    headers: { ...rpcHeaders(userJwt) },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function quotaError(raw: string): { code: string; message: string; status: number } {
  if (raw.includes("account_not_active")) return { code: "ACCOUNT_SUSPENDED", message: "Votre compte est suspendu. Contactez l'administration.", status: 403 };
  if (raw.includes("not_authenticated")) return { code: "UNAUTHENTICATED", message: "Session expirée, veuillez vous reconnecter.", status: 401 };
  if (raw.includes("quota_exceeded")) {
    const parts = raw.split("quota_exceeded:")[1]?.split(":") ?? [];
    const labels: Record<string, string> = { script: "scripts", prompt: "prompts", video: "vidéos", image: "images", export: "exports" };
    const kind = parts[0] ?? "opération";
    return {
      code: "QUOTA_EXCEEDED",
      message: `Limite mensuelle de ${labels[kind] ?? kind} atteinte (${parts[1] ?? "?"}/${parts[2] ?? "?"}). Passez à une formule supérieure depuis l'abonnement.`,
      status: 429,
    };
  }
  return { code: "QUOTA_ERROR", message: `Impossible de vérifier vos limites : ${raw}`, status: 400 };
}

async function takeQuota(kind: string, referenceId: string | null, userJwt: string, metadata: Json = {}) {
  const result = await rpc("reelora_consume_quota", {
    p_kind: kind,
    p_reference_id: referenceId,
    p_metadata: metadata,
  }, userJwt);
  if (!result.ok) return { error: quotaError(result.error ?? "quota") };
  return { usage: result.data };
}

async function refundQuota(kind: string, referenceId: string | null, userId: string) {
  if (!SERVICE_KEY()) return;
  await rpcService("reelora_refund_quota", {
    p_kind: kind, p_reference_id: referenceId, p_user_id: userId,
  });
}

const MODEL = () => env("GROQ_MODEL") || "llama-3.3-70b-versatile";

// Groq's answer is returned verbatim (trimmed). An empty / unparsable answer is
// an explicit failure: Reelora NEVER manufactures an AI response locally.
async function groq(system: string, user: string, jsonMode: boolean, maxTokens = 2400): Promise<string> {
  const key = GROQ_KEY();
  if (!key) throw new Error("GROQ_NOT_CONFIGURED");
  const body: Json = {
    model: MODEL(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.7,
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await res.text();
  if (!res.ok) {
    let detail = `Groq HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(raw) as Json;
      const err = parsed.error as Json | undefined;
      if (err?.message) detail = String(err.message).slice(0, 400);
    } catch { /* keep generic */ }
    throw new Error(`GROQ_ERROR: ${detail}`);
  }
  let parsed: Json;
  try { parsed = JSON.parse(raw) as Json; } catch { throw new Error("AI_EMPTY_RESPONSE"); }
  const choices = parsed.choices as Json[] | undefined;
  const content = choices?.[0]?.message as Json | undefined;
  const text = typeof content?.content === "string" ? content.content.trim() : "";
  if (!text) throw new Error("AI_EMPTY_RESPONSE");
  return text;
}

function parseJsonLoose(raw: string): Json {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(cleaned) as Json; } catch { /* continue */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)) as Json; } catch { /* continue */ }
  }
  return {};
}

const SCENE_TYPES = ["hook", "ugc", "product_demo", "cutaway", "testimonial_style", "cta", "other"];

// Strict normalisation of Groq's own scenes. No scene, prompt, duration or
// semantic type is ever invented here: an incomplete answer is a failure.
function normalizeScenes(value: unknown, required = true): Json[] {
  const raw = Array.isArray(value) ? value.slice(0, 12) : [];
  const scenes = raw.map((item) => {
    const s = (item ?? {}) as Json;
    const type = str(s.scene_type ?? s.sceneType, 40);
    const visual = str(s.visual_prompt ?? s.visualPrompt, 800);
    if (!visual) throw new Error("AI_EMPTY_RESPONSE");
    return {
      scene_type: SCENE_TYPES.includes(type) ? type : "ugc",
      duration_seconds: clamp(s.duration_seconds ?? s.durationSeconds, 1, 120, 3),
      visual_prompt: visual,
      spoken_text: str(s.spoken_text ?? s.spokenText, 700),
      subtitle_text: str(s.subtitle_text ?? s.subtitleText, 300),
      scene_settings: {},
    };
  });
  if (scenes.length === 0 && required) throw new Error("AI_EMPTY_RESPONSE");
  return scenes;
}

// Any action that consumed a quota unit and then fails must give it back once.
// The outer catch reads this holder, so no action can double-refund or leak a unit.
type QuotaTaken = { kind: string; referenceId: string | null };

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_m, key: string) => values[key] ?? "");
}

async function loadTemplate(id: string | null, category: string, userJwt: string): Promise<string> {
  const path = id
    ? `reelora_prompt_templates?id=eq.${encodeURIComponent(id)}&select=content&limit=1`
    : `reelora_prompt_templates?is_system=eq.true&category=eq.${encodeURIComponent(category)}&select=content&order=id.asc&limit=1`;
  const rows = await restGet(path, userJwt);
  const content = str((rows[0] as Json | undefined)?.content, 8000);
  return content || "Tu es un créateur UGC francophone. Réponds uniquement en JSON valide avec les clés hook, script_text, call_to_action, marketing_angle, claims_to_avoid, scenes.";
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", "Méthode non autorisée.", 405);

  const userJwt = req.headers.get("Authorization") ?? "";
  if (!userJwt.startsWith("Bearer ")) return fail("UNAUTHENTICATED", "Authentification requise.", 401);
  const userId = await authUserId(userJwt);
  if (!userId) return fail("UNAUTHENTICATED", "Jeton utilisateur invalide.", 401);
  // Checked BEFORE taking any quota: an unconfigured provider is an explicit,
  // non-simulated 503 and must not consume a unit.
  if (!GROQ_KEY()) {
    return fail("GROQ_NOT_CONFIGURED", "Le service IA n’est pas configuré : ajoutez le secret serveur GROQ_API_KEY dans Supabase Edge Functions. Aucun texte n’est généré ni simulé ; vous pouvez saisir votre script ou votre prompt manuellement.", 503);
  }

  let body: Json;
  try { body = await req.json() as Json; } catch { return fail("INVALID_BODY", "Corps de requête JSON invalide.", 400); }
  const action = str(body.action, 40);
  const projectId = str(body.project_id, 80) || null;
  let quotaTaken: QuotaTaken | null = null;

  try {
    if (action === "generate_script") {
      const product = str(body.product, 300) || str(body.brief, 500) || "le produit";
      const audience = str(body.audience, 300) || "grand public francophone";
      const platform = str(body.platform, 60) || "TikTok";
      const tone = str(body.tone, 80) || "authentique et naturel";
      const duration = clamp(body.duration, 5, 90, 15);
      const objective = str(body.objective, 300);
      const market = str(body.market, 120);
      const templateId = str(body.template_id, 80) || null;

      const quota = await takeQuota("script", projectId, userJwt, { action, platform });
      if (quota.error) return fail(quota.error.code, quota.error.message, quota.error.status);
      quotaTaken = { kind: "script", referenceId: projectId };

      const template = await loadTemplate(templateId, "script", userJwt);
      const system = "Tu es Reelora, expert en création de contenus UGC francophones. Tu produis des scripts courts, crédibles et conformes : aucune allégation chiffrée inventée, aucune promesse médicale, aucune mention de marque concurrente. Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour.";
      const user = interpolate(template, {
        duree: String(duration), produit: product, audience, plateforme: platform, ton: tone,
      }) + `\n\nBrief complémentaire :\n- Produit : ${product}\n- Audience : ${audience}\n- Plateforme : ${platform}\n- Ton : ${tone}\n- Durée cible : ${duration} secondes\n- Objectif : ${objective || "non précisé"}\n- Marché : ${market || "non précisé"}\n- Langue : français\n- Contraintes : pas de chiffre inventé, pas de promesse irréaliste, 3 à 6 scènes maximum.`;

      // Groq's own text only. No local fallback: an empty answer is an explicit
      // failure with a quota refund (handled once by the outer catch).
      const content = await groq(system, user, true);
      const parsed = parseJsonLoose(content);
      const scriptText = str(parsed.script_text ?? parsed.script ?? parsed.content, 4000);
      if (!scriptText) throw new Error("AI_EMPTY_RESPONSE");
      const result = {
        hook: str(parsed.hook, 300),
        script_text: scriptText,
        call_to_action: str(parsed.call_to_action ?? parsed.cta, 300),
        marketing_angle: str(parsed.marketing_angle ?? parsed.angle, 200),
        claims_to_avoid: Array.isArray(parsed.claims_to_avoid) ? parsed.claims_to_avoid.slice(0, 20).map(String) : [],
      };
      // Scenes are optional for a script response: absent means an empty list,
      // never three invented scenes derived from the user's own text.
      const scenes = normalizeScenes(parsed.scenes, false);

      let scriptId: string | null = null;
      let scenesSaved = 0;
      if (projectId) {
        const saved = await rpc("reelora_save_script", {
          p_project_id: projectId,
          p_script_text: result.script_text,
          p_hook: result.hook,
          p_call_to_action: result.call_to_action,
          p_marketing_angle: result.marketing_angle || null,
          p_language: str(body.language, 10) || "fr",
          p_claims_to_avoid: result.claims_to_avoid,
        }, userJwt);
        if (saved.ok) {
          scriptId = typeof saved.data === "string" ? saved.data : null;
          const scenesResult = await rpc("reelora_save_scenes", {
            p_project_id: projectId, p_script_id: scriptId, p_scenes: scenes,
          }, userJwt);
          scenesSaved = typeof scenesResult.data === "number" ? scenesResult.data : 0;
        }
      }
      return json({ action, ...result, scenes, script_id: scriptId, scenes_saved: scenesSaved, usage: quota.usage });
    }

    if (action === "improve_prompt") {
      const content = str(body.content, 8000);
      if (content.length < 10) return fail("INVALID_INPUT", "Le prompt doit contenir au moins 10 caractères.", 400);
      const quota = await takeQuota("prompt", null, userJwt, { action });
      if (quota.error) return fail(quota.error.code, quota.error.message, quota.error.status);
      quotaTaken = { kind: "prompt", referenceId: null };
      const raw = await groq("Tu es un ingénieur prompt francophone. Réponds uniquement en JSON valide.", interpolate(await loadTemplate(null, "system", userJwt), { prompt: content }), true, 1200);
      const parsed = parseJsonLoose(raw);
      const improved = str(parsed.content, 8000);
      // Never echo the user's own prompt back as if Groq had improved it.
      if (!improved) throw new Error("AI_EMPTY_RESPONSE");
      return json({ action, content: improved, variables: Array.isArray(parsed.variables) ? parsed.variables.slice(0, 20).map(String) : [], usage: quota.usage });
    }

    if (action === "generate_hooks") {
      const product = str(body.product, 300) || "le produit";
      const audience = str(body.audience, 300) || "grand public";
      const quota = await takeQuota("prompt", null, userJwt, { action });
      if (quota.error) return fail(quota.error.code, quota.error.message, quota.error.status);
      quotaTaken = { kind: "prompt", referenceId: null };
      const raw = await groq("Tu es un créateur UGC francophone. Réponds uniquement en JSON valide.", interpolate(await loadTemplate(null, "hook", userJwt), { produit: product, audience }), true, 800);
      const parsed = parseJsonLoose(raw);
      const hooks = Array.isArray(parsed.hooks) ? parsed.hooks.slice(0, 10).map((h) => str(h, 160)).filter(Boolean) : [];
      if (hooks.length === 0) throw new Error("AI_EMPTY_RESPONSE");
      return json({ action, hooks, usage: quota.usage });
    }

    if (action === "generate_visual") {
      const product = str(body.product, 300) || "le produit";
      const actionText = str(body.scene_action, 300) || "présentation face caméra";
      const ambiance = str(body.ambiance, 200) || "lumière naturelle, style spontané";
      const quota = await takeQuota("prompt", null, userJwt, { action });
      if (quota.error) return fail(quota.error.code, quota.error.message, quota.error.status);
      quotaTaken = { kind: "prompt", referenceId: null };
      const raw = await groq("Tu es un directeur artistique UGC. Réponds en une seule phrase, en français, sans mise en forme.", interpolate(await loadTemplate(null, "visual", userJwt), { produit: product, action: actionText, ambiance }), false, 400);
      return json({ action, text: raw.trim(), usage: quota.usage });
    }

    if (action === "generate_scenes") {
      const scriptText = str(body.script_text, 6000);
      if (!scriptText) return fail("INVALID_INPUT", "Le texte du script est requis.", 400);
      const quota = await takeQuota("prompt", projectId, userJwt, { action });
      if (quota.error) return fail(quota.error.code, quota.error.message, quota.error.status);
      quotaTaken = { kind: "prompt", referenceId: projectId };
      const system = "Tu es un monteur UGC. Réponds uniquement en JSON valide : {\"scenes\":[{\"scene_type\":\"hook|ugc|product_demo|cutaway|testimonial_style|cta|other\",\"duration_seconds\":3,\"visual_prompt\":\"...\",\"spoken_text\":\"...\",\"subtitle_text\":\"...\"}]}. 3 à 6 scènes, français, aucune marque tierce.";
      const raw = await groq(system, `Découpe ce script en scènes pour une vidéo verticale de ${clamp(body.duration, 5, 90, 15)} secondes :\n${scriptText}`, true, 1800);
      const scenes = normalizeScenes(parseJsonLoose(raw).scenes, true);
      let scenesSaved = 0;
      if (projectId) {
        const r = await rpc("reelora_save_scenes", { p_project_id: projectId, p_script_id: null, p_scenes: scenes }, userJwt);
        scenesSaved = typeof r.data === "number" ? r.data : 0;
      }
      return json({ action, scenes, scenes_saved: scenesSaved, usage: quota.usage });
    }

    return fail("UNKNOWN_ACTION", "Action IA inconnue.", 400);
  } catch (error) {
    // One refund, whatever the failure: missing key, Groq error, empty answer,
    // network timeout or unexpected exception. No unit is consumed without a
    // real AI answer being returned.
    if (quotaTaken) await refundQuota(quotaTaken.kind, quotaTaken.referenceId, userId);
    const message = error instanceof Error ? error.message : String(error);
    if (message === "GROQ_NOT_CONFIGURED") return fail("GROQ_NOT_CONFIGURED", "Le secret serveur GROQ_API_KEY est absent. Aucun texte n’est généré ni simulé.", 503);
    if (message === "AI_EMPTY_RESPONSE") return fail("AI_EMPTY_RESPONSE", AI_EMPTY_MESSAGE, 502);
    if (message.startsWith("GROQ_ERROR:")) return fail("AI_PROVIDER_ERROR", `Le fournisseur IA a renvoyé une erreur : ${message.replace("GROQ_ERROR: ", "")}. Aucun texte n’est simulé.`, 502);
    console.error("reelora-ai", message);
    return fail("AI_INTERNAL_ERROR", "Une erreur inattendue est survenue lors de la génération. Aucun texte n’est simulé.", 500);
  }
}

// Deno-only bootstrap: exporting `handler` lets Vitest import this module in
// Node without a Deno global (same pattern as the video/worker functions).
const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (r: Request) => Promise<Response>) => void } };
if (runtime.Deno?.serve) runtime.Deno.serve(handler);
