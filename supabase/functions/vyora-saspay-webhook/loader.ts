// vyora-saspay-webhook — chargeur de production (seule source déployée).
// Généré par scripts/build-saspay-artifact.mjs : ne pas éditer.
//
// Le code métier (bundle de supabase/functions/_shared/saspay) est lu dans
// public._edge_function_artifact par nom + SHA-256, puis vérifié avant exécution :
// un artefact absent ou modifié n'est jamais exécuté.
const FUNCTION_NAME = "vyora-saspay-webhook";
const ARTIFACT_NAME = "vyora-saspay";
const ARTIFACT_SHA256 = "acefd46793cea029a67edc9b84768653286e9d08f2db107ea0a4cb8b753dd690";
const ARTIFACT_CHARS = 56709;

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
  // Le bundle ne contient aucun import ; il lit ce nom et enregistre lui-même
  // Deno.serve avec le gestionnaire correspondant.
  (globalThis as { __vyoraSaspayFunction?: string }).__vyoraSaspayFunction = FUNCTION_NAME;
  new Function(CODE)();
} else {
  // Panne explicite : 503, jamais un succès. SasPay et la réconciliation
  // réessaient ; le navigateur reçoit un code lisible. Le motif reste dans
  // les journaux, pas dans la réponse.
  console.error(FUNCTION_NAME + " artifact load failed: " + failure);
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const body = JSON.stringify({
    error: {
      code: "PAYMENT_ARTIFACT_UNAVAILABLE",
      message: "Le service de paiement est momentanément indisponible.",
    },
  });
  Deno.serve((request: Request) =>
    request.method === "OPTIONS"
      ? new Response("ok", { headers })
      : new Response(body, { status: 503, headers })
  );
}
