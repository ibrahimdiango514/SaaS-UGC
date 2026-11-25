// SORAHNEX health probe — reports ONLY the presence of server-side secrets,
// never their values. The browser uses it to explain why a feature is disabled.
const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-application-name, x-retry-count",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const configured = {
    // Génération de texte (scripts, accroches, dialogues, copy). Une seule
    // passerelle : `vyora-ai` → FreeLLMAPI. La clé est un secret Edge, jamais
    // une variable VITE_*, jamais envoyée au navigateur.
    ai: Boolean(Deno.env.get("FREE_LLM_API_KEY")),
    // PRIMARY video generation. MUAPI_API_KEY is a Supabase Edge secret; it is
    // never a VITE_* variable and is never sent to the browser.
    muapi: Boolean(Deno.env.get("MUAPI_API_KEY")),
    supabase: Boolean(Deno.env.get("SUPABASE_URL") && Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
    worker: Boolean(Deno.env.get("SUPABASE_URL")),
  };
  return new Response(
    JSON.stringify({ service: "reelora-health", status: "ok", time: new Date().toISOString(), configured }),
    { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
  );
});
