// business-grow — chargeur de production (source réellement déployée).
//
// ## Pourquoi un chargeur et pas directement le handler
// Le canal de déploiement n'achemine pas fidèlement une source longue : une
// source multi-fichiers produit `BOOT_ERROR`, et un corps inline de ~17 Ko peut
// arriver altéré (instruction `import` refusée par `new Function`, ou SHA-256
// qui ne correspond plus). Cette source déployée est **courte** (~1,5 Ko) : elle
// ne peut pas être tronquée.
//
// Le bundle exécuté est publié en statique (`public/edge-artifacts/`) et
// versionné dans le dépôt ; son intégrité est vérifiée par SHA-256 avant
// exécution. Le code exécuté reste exactement celui du dépôt.
//
// ## Contrat d'erreur
// - 500 `BUSINESS_GROW_ARTIFACT_UNAVAILABLE` : artefact non récupérable.
// - 500 `BUSINESS_GROW_ARTIFACT_INTEGRITY` : taille ou SHA-256 différent.
// Jamais de 503 muet : le client reçoit un code métier et un message, donc
// jamais « backend absent ou injoignable ».
//
// Les deux constantes miroir de `business-grow.meta.json` sont vérifiées par
// `tests/business-grow-artifact.test.ts`.

import postgres from "npm:postgres@3.4.5";

const ARTIFACT_URL = "https://vyora-ugc.netlify.app/edge-artifacts/business-grow.bundle.js";
const ARTIFACT_SHA256 = "4f7b9f037aac61569278ffbbd5a29078c5dd4708dba21f4cf6bfd940292faeb9";
const ARTIFACT_CHARS = 39323;

const ALLOWED = [
  "https://vyora-ugc.netlify.app",
  "https://saas-ugc-growth.netlify.app",
  "https://*.netlify.app",
  "https://*.e2b.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

function originAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED.some((pattern) => {
    if (pattern === origin) return true;
    if (!pattern.includes("*")) return false;
    const rx = new RegExp(
      "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+") + "$",
      "i",
    );
    return rx.test(origin);
  });
}

function cors(origin: string | null): Record<string, string> {
  // Une origine inconnue n'obtient pas d'en-tête CORS : le navigateur bloque,
  // mais la requête n'est jamais acceptée silencieusement à sa place.
  return {
    ...(origin && originAllowed(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function failure(code: string, detail: string, origin: string | null): Response {
  return new Response(JSON.stringify({ error: { code, message: detail } }), {
    status: 500,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

let booting: Promise<void> | null = null;

async function load(): Promise<void> {
  let text: string;
  try {
    const res = await fetch(ARTIFACT_URL, { headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`http_${res.status}`);
    text = await res.text();
  } catch (error) {
    throw new Error(`BUSINESS_GROW_ARTIFACT_UNAVAILABLE: ${String(error)}`);
  }
  if (text.length !== ARTIFACT_CHARS) {
    throw new Error(`BUSINESS_GROW_ARTIFACT_INTEGRITY: taille ${text.length} ≠ ${ARTIFACT_CHARS}`);
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== ARTIFACT_SHA256) {
    throw new Error("BUSINESS_GROW_ARTIFACT_INTEGRITY: sha256 différent");
  }
  // Le bundle ne contient aucune instruction `import` : il s'exécute hors
  // module et reçoit `postgres` par ce point d'injection. Il enregistre
  // lui-même son `Deno.serve`.
  (globalThis as { __bgPostgres?: typeof postgres }).__bgPostgres = postgres;
  new Function(text)();
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (!originAllowed(origin)) {
    return new Response(
      JSON.stringify({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Origine non autorisée." } }),
      { status: 403, headers: { "Content-Type": "application/json", ...cors(origin) } },
    );
  }
  if (!booting) {
    booting = load().catch((error) => {
      // La promesse rejetée est conservée : une relance par requête
      // masquerait la panne derrière de la latence.
      console.error("business-grow boot failed", String(error));
      throw error;
    });
  }
  try {
    await booting;
  } catch (error) {
    const message = String(error);
    const code = message.includes("INTEGRITY")
      ? "BUSINESS_GROW_ARTIFACT_INTEGRITY"
      : "BUSINESS_GROW_ARTIFACT_UNAVAILABLE";
    return failure(code, message, origin);
  }
  // Le handler du bundle a pris le relais via son propre `Deno.serve` : cette
  // branche n'est atteinte qu'en cas de double enregistrement.
  return new Response("business-grow ready", { status: 204, headers: cors(origin) });
});
