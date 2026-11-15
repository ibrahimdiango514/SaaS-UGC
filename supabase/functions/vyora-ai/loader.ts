// vyora-ai — chargeur de production (seule source déployée).
// Généré par scripts/build-edge-loader.mjs : ne pas éditer.
//
// Le canal de déploiement altère les sources longues : ce fichier reste court.
// Le code métier est lu dans public._edge_function_artifact_slices (nom + SHA-256), recomposé,
// puis vérifié AVANT exécution : un artefact absent ou modifié n'est jamais exécuté.
const NAME = "vyora-ai";
const SHA256 = "8410669e2d41005be5885664cc91d0c23703bab79a9c29a5c1587701365d4496";
const CHARS = 36156;

function env(name: string): string {
  const g = globalThis as unknown as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(name) ?? g.process?.env?.[name] ?? "";
}

async function readArtifact(): Promise<string> {
  const base = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) throw new Error("runtime_env_missing");
  const res = await fetch(
    base + "/rest/v1/_edge_function_artifact_slices?select=part,chunk&name=eq." + NAME + "&order=part.asc",
    { headers: { apikey: key, Authorization: "Bearer " + key }, signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error("artifact_read_failed:" + res.status);
  const rows = (await res.json()) as Array<{ part?: unknown; chunk?: unknown }>;
  const base64 = rows.map((row) => (typeof row.chunk === "string" ? row.chunk : "")).join("");
  if (!base64) throw new Error("artifact_missing");
  const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const stream = new Blob([binary]).stream().pipeThrough(new DecompressionStream("gzip"));
  const source = await new Response(stream).text();
  if (source.length !== CHARS) throw new Error("artifact_size_mismatch:" + source.length);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== SHA256) throw new Error("artifact_digest_mismatch");
  return source;
}

const failures: string[] = [];
let CODE = "";
// Trois essais : une lecture ratée à froid ne doit pas figer l'instance.
for (let attempt = 1; attempt <= 3 && !CODE; attempt += 1) {
  try {
    CODE = await readArtifact();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
}

if (CODE) {
  // Le bundle s'exécute hors module : il enregistre lui-même Deno.serve.
  new Function(CODE)();
} else {
  const failure = failures[failures.length - 1] ?? "unknown";
  console.error(NAME + " artifact load failed: " + failure);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const body = JSON.stringify({
    error: {
      code: "EDGE_ARTIFACT_UNAVAILABLE",
      message: "Le service " + NAME + " n'a pas pu charger son code (" + failure + ").",
    },
  });
  const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (r: Request) => Response) => void } };
  runtime.Deno?.serve?.((request: Request) =>
    request.method === "OPTIONS" ? new Response("ok", { headers }) : new Response(body, { status: 503, headers }),
  );
}
