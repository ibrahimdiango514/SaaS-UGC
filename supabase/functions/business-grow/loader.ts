// business-grow — chargeur de production (seule source déployée).
// Généré par scripts/build-business-grow-artifact.mjs : ne pas éditer.
//
// Le canal de déploiement altère les sources longues : ce fichier reste court.
// Le code métier (bundle esbuild de ce dossier) est lu dans
// public._edge_function_artifact par nom + SHA-256, puis vérifié avant exécution :
// un artefact absent ou modifié n'est jamais exécuté.
import postgres from "npm:postgres@3.4.5";

const ARTIFACT_NAME = "business-grow";
const ARTIFACT_SHA256 = "6093711eabe0b413c4c51e6efdab12849cef3b56b8371980ab98a246bf032aac";
const ARTIFACT_CHARS = 47882;

async function readArtifact(): Promise<string> {
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!base || !key) throw new Error("runtime_env_missing");
  const url = base + "/rest/v1/_edge_function_artifact?select=source&name=eq." + ARTIFACT_NAME +
    "&sha256=eq." + ARTIFACT_SHA256;
  const res = await fetch(url, {
    headers: { apikey: key, Authorization: "Bearer " + key },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("artifact_read_failed:" + res.status);
  const rows = (await res.json()) as Array<{ source?: unknown }>;
  const source = rows[0]?.source;
  if (typeof source !== "string") throw new Error("artifact_missing");
  if (source.length !== ARTIFACT_CHARS) throw new Error("artifact_size_mismatch:" + source.length);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== ARTIFACT_SHA256) throw new Error("artifact_digest_mismatch");
  return source;
}

let CODE = "";
let failure = "";
// Trois essais : une lecture ratée à froid ne doit pas figer l'instance en panne.
for (let attempt = 1; attempt <= 3 && !CODE; attempt++) {
  try {
    CODE = await readArtifact();
    failure = "";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
}

if (CODE) {
  // Le bundle s'exécute hors module : il ne contient aucun import et reçoit
  // postgres ici, AVANT son exécution. Il enregistre lui-même Deno.serve.
  (globalThis as { __bgPostgres?: typeof postgres }).__bgPostgres = postgres;
  new Function(CODE)();
} else {
  // Panne explicite et lisible par le navigateur (CORS ouvert : la réponse ne
  // contient qu'un code d'erreur), au lieu d'un 500 opaque pris pour une
  // absence de backend.
  console.error("business-grow artifact load failed: " + failure);
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const body = JSON.stringify({
    error: {
      code: "BUSINESS_GROW_ARTIFACT_UNAVAILABLE",
      message: "Le service Business Grow n'a pas pu charger son code (" + failure + ").",
    },
  });
  Deno.serve((request: Request) =>
    request.method === "OPTIONS"
      ? new Response("ok", { headers })
      : new Response(body, { status: 503, headers })
  );
}
