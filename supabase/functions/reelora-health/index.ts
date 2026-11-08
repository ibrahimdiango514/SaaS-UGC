// Reelora health probe — never exposes secret values, only their configuration state.
const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const configured = {
    groq: Boolean(Deno.env.get("GROQ_API_KEY")),
    heygen: Boolean(Deno.env.get("HEYGEN_API_KEY")),
    fal: Boolean(Deno.env.get("FAL_KEY")),
    supabase: Boolean(Deno.env.get("SUPABASE_URL") && Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
  };
  return new Response(
    JSON.stringify({ service: "reelora-health", status: "ok", time: new Date().toISOString(), configured }),
    { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
  );
});
