// store-import — chargeur de démarrage (canal de déploiement direct).
//
// Le connecteur de déploiement ne transmet qu'UN fichier, et seulement s'il est
// court : les imports relatifs produiraient un BOOT_ERROR et un corps long est
// altéré. Ce fichier reste donc volontairement petit.
//
// Le code métier est le bundle esbuild du dépôt, publié dans un commit ÉPINGLÉ
// du dépôt public. L'URL contient ce commit, donc elle ne peut pas changer de
// contenu ; la taille et le SHA-256 sont vérifiés avant exécution : un bundle
// absent, tronqué, reformaté ou modifié n'est JAMAIS exécuté.
//
// Régénérer avec : node scripts/build-edge-artifact.mjs store-import
import postgres from "npm:postgres@3.4.5";

const FALLBACK_REPO = "ibrahimdiango514/SaaS-UGC";
const ARTIFACT_REF = "__GIT_SHA__";
const ARTIFACT_SHA256 = "__BUNDLE_SHA__";
const ARTIFACT_CHARS = __BUNDLE_CHARS__;

function candidateUrls(): string[] {
  const ref = Deno.env.get("STORE_IMPORT_ARTIFACT_REF") || ARTIFACT_REF;
  const repo = Deno.env.get("STORE_IMPORT_ARTIFACT_REPO") || FALLBACK_REPO;
  return [
    "https://raw.githubusercontent.com/" + repo + "/" + ref + "/supabase/functions/_artifacts/store-import.js",
    // Miroir : api.github.com sert le même contenu en base64 quand le CDN brut
    // est filtré par le réseau d'exécution.
    "https://api.github.com/repos/" + repo + "/contents/supabase/functions/_artifacts/store-import.js?ref=" + ref,
  ];
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readArtifact(): Promise<string> {
  const failures: string[] = [];
  for (const url of candidateUrls()) {
    try {
      const res = await fetch(url, {
        headers: url.startsWith("https://api.github.com")
          ? { accept: "application/vnd.github.raw+json" }
          : {},
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { failures.push("http_" + res.status); continue; }
      const raw = await res.text();
      // Le fichier est publié avec un saut de ligne final : on tolère un seul
      // caractère de fin, jamais davantage — sinon le contenu serait autre.
      const source = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
      if (source.length !== ARTIFACT_CHARS) { failures.push("size_" + source.length); continue; }
      if ((await sha256Hex(source)) !== ARTIFACT_SHA256) { failures.push("digest"); continue; }
      return source;
    } catch (error) {
      failures.push(error instanceof Error ? error.name : "fetch_error");
    }
  }
  throw new Error(failures.join(","));
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
  // Aucun détail interne (URL, empreinte) n'est renvoyé au navigateur.
  console.error("store-import artifact load failed: " + failure);
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  const body = JSON.stringify({
    error: {
      code: "STORE_IMPORT_ARTIFACT_UNAVAILABLE",
      message: "Le service d'import n'a pas pu démarrer son code (artifact_load_failed). Réessayez dans un instant.",
    },
  });
  Deno.serve((request: Request) =>
    request.method === "OPTIONS"
      ? new Response("ok", { headers })
      : new Response(body, { status: 503, headers })
  );
}
