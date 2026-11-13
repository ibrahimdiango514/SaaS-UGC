// reelora-video — runtime loader
//
// Le code metier est l'artefact esbuild de supabase/functions/reelora-video
// (43 Ko), stocke par tranches gzip+base64 dans public._edge_deploy_artifact
// et verifie octet pour octet par SHA-256. Le canal de deploiement disponible
// ne transmet pas une charge de cette taille : il ne peut ecrire ici qu'un
// fichier court. Ce chargeur reconstruit donc l'artefact a froid, puis sert
// son handler. Aucune logique metier n'est dupliquee ici.
//
// Choix techniques (volontairement sans dependance) :
//   - decompression via DecompressionStream("gzip"), standard, pas de node:zlib ;
//   - chargement par import d'une URL data: (pas d'eval, pas de new Function) ;
//   - l'auto-serve Deno inliné dans l'artefact est retire avant import, car la
//     plateforme Edge sert deja la fonction.
const ARTIFACT_SHA256 = "5ca3a72d8b63c71f0df017efb716251dd0e6b734abb66756f06f6fe339c9b165";
const ARTIFACT_CHARS = 48026;
const TABLE = "_edge_deploy_artifact";

const env = (k: string): string => (globalThis as any).Deno?.env?.get?.(k) ?? "";

async function loadSlices(): Promise<string> {
  const base = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) throw new Error("runtime_env_missing");
  const res = await fetch(`${base}/rest/v1/${TABLE}?select=seq,chunk&order=seq.asc`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`slices_read_failed:${res.status}`);
  const rows = (await res.json()) as Array<{ seq: number; chunk: string }>;
  if (!rows.length) throw new Error("slices_missing");
  return rows.map((r) => r.chunk).join("");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadHandler(): Promise<(req: Request) => Promise<Response>> {
  const source = new TextDecoder().decode(await gunzip(base64ToBytes(await loadSlices())));
  if (source.length !== ARTIFACT_CHARS) throw new Error(`artifact_size_mismatch:${source.length}`);
  if ((await sha256Hex(source)) !== ARTIFACT_SHA256) throw new Error("artifact_digest_mismatch");

  // Retire l'auto-serve : le handler exporte est servi par EdgeRuntime.waitUntil
  // ci-dessous, pas par Deno.serve.
  const code = source.replace(/(\w+)\.Deno\?\.serve&&\1\.Deno\.serve\((\w+)\);?/g, "");
  if (/\bDeno\.serve\(/.test(code)) throw new Error("artifact_autoserve_present");

  const url = `data:text/javascript;base64,${bytesToBase64(new TextEncoder().encode(code))}`;
  const mod = (await import(url)) as { handler?: (req: Request) => Promise<Response> };
  if (typeof mod.handler !== "function") throw new Error("artifact_handler_missing");
  return mod.handler;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-application-name, x-retry-count",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

let cached: { handler: (req: Request) => Promise<Response>; at: number } | null = null;

async function handler(req: Request): Promise<Response> {
  if (!cached || Date.now() - cached.at > 300000) {
    try {
      cached = { handler: await loadHandler(), at: Date.now() };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: { code: "ARTIFACT_LOAD_FAILED", message: detail } }), {
        status: 503,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }
  return cached.handler(req);
}

(globalThis as any).Deno?.serve?.(handler);
