// store-import — chargeur de production (seule source déployée).
// Généré par scripts/build-edge-artifact.mjs : ne pas éditer.
//
// Le code métier (bundle esbuild) est lu dans
// public._edge_function_artifact par nom + SHA-256, puis vérifié avant exécution :
// un artefact absent ou modifié n'est jamais exécuté.
import postgres from "npm:postgres@3.4.5";

const ARTIFACT_NAME = "store-import";
const ARTIFACT_SHA256 = "d002522d643d8b72ff5bbafe918f86c9ce1ff386d44bdf72eea67f05ad4c4fb5";
const ARTIFACT_CHARS = 36292;

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
  // Le bundle s'exécute hors module : il reçoit postgres ici, avant exécution.
  (globalThis as { __edgePostgres?: typeof postgres }).__edgePostgres = postgres;
  new Function(CODE)();
} else {
  // Panne explicite et lisible, au lieu d'un 500 opaque pris pour une absence de backend.
  console.error("store-import artifact load failed: " + failure);
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const body = JSON.stringify({
    error: {
      code: "STORE_IMPORT_ARTIFACT_UNAVAILABLE",
      message: "Le service store-import n'a pas pu charger son code (" + failure + ").",
    },
  });
  Deno.serve((request: Request) =>
    request.method === "OPTIONS"
      ? new Response("ok", { headers })
      : new Response(body, { status: 503, headers })
  );
}
