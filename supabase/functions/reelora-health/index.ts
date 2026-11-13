// VYORA health probe — reports ONLY the presence of server-side secrets,
// never their values. The browser uses it to explain why a feature is disabled.
const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-application-name, x-retry-count",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const configured = {
    // Text generation (scripts, hooks, dialogues, ad copy). The browser talks to
    // `vyora-ai`, whose Groq key is the BUSINESS_GROW_* secret with a GROQ_*
    // fallback: a probe that only checked GROQ_API_KEY reported `groq:false`
    // while the AI engine was actually serving text.
    groq: Boolean(Deno.env.get("BUSINESS_GROW_GROQ_API_KEY") || Deno.env.get("GROQ_API_KEY")),
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
