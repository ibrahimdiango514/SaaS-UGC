// store-import — chargeur épinglé sur un commit du dépôt public.
//
// Le code métier est le bundle du dépôt, lu à un commit PRÉCIS (jamais `main`
// ni une branche mouvante) : une URL contenant un SHA de commit ne peut pas
// changer de contenu, et la taille + l'empreinte SHA-256 sont vérifiées avant
// toute exécution. Un bundle absent, tronqué, reformaté ou modifié n'est
// JAMAIS exécuté.
//
// Épinglé sur store-import.js (113906 caractères).
//
// Généré par scripts/edge-github-loader.mjs : ne pas éditer à la main.
import postgres from "npm:postgres@3.4.5";

const REPO = "ibrahimdiango514/SaaS-UGC";
const COMMIT = "a5545a65353378d423cc7db4c5e3d8bd49d99757";
const PATH = "supabase/functions/_artifacts/store-import.js";
const ARTIFACT_SHA256 = "e23ed55a950d16d482b7c93867b8272bb98ae34b6ceda22f7bdd6cbb4fb39954";
const ARTIFACT_CHARS = 113906;

// Le fichier est comparé TEL QUEL, saut de ligne final compris : l'empreinte
// porte sur le fichier tel qu'il est committé.
async function charger(): Promise<string> {
  const urls = [
    "https://raw.githubusercontent.com/" + REPO + "/" + COMMIT + "/" + PATH,
    "https://api.github.com/repos/" + REPO + "/contents/" + PATH + "?ref=" + COMMIT,
  ];
  const echecs: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: url.startsWith("https://api.github.com/")
          ? { accept: "application/vnd.github.raw+json" }
          : {},
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { echecs.push("http_" + res.status); continue; }
      const source = await res.text();
      if (source.length !== ARTIFACT_CHARS) { echecs.push("taille_" + source.length); continue; }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hex !== ARTIFACT_SHA256) { echecs.push("empreinte_" + hex.slice(0, 8)); continue; }
      return source;
    } catch (error) {
      echecs.push(error instanceof Error ? error.name : "reseau");
    }
  }
  throw new Error(echecs.join(","));
}

let CODE = "";
let failure = "";
// Trois tentatives : une lecture ratée à froid ne doit pas figer l'instance.
for (let essai = 1; essai <= 3 && !CODE; essai++) {
  try {
    CODE = await charger();
    failure = "";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (essai < 3) await new Promise((r) => setTimeout(r, 400 * essai));
  }
}

if (CODE) {
  (globalThis as { __edgePostgres?: typeof postgres }).__edgePostgres = postgres;
  new Function(CODE)();
} else {
  // Panne explicite et lisible, jamais un accès ouvert ni un 500 opaque.
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
      message: "Le service d'import n'a pas pu démarrer son code (artifact_load_failed). Réessayez dans un instant.",
    },
  });
  Deno.serve((request: Request) =>
    request.method === "OPTIONS"
      ? new Response("ok", { headers })
      : new Response(body, { status: 503, headers })
  );
}
