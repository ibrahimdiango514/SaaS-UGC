// Banc PostgREST — faux fournisseurs IA LOCAUX (aucun appel sortant).
//
// Émule les deux endpoints utilisés par l'Edge Function business-grow
// (supabase/functions/business-grow/providers.ts) :
//   Groq   : POST /openai/v1/chat/completions, GET /openai/v1/models
//   Gemini : POST /v1beta/models/<model>:generateContent, GET /v1beta/models
//
// Les clés attendues sont des clés de TEST définies par le banc (jamais une
// clé réelle). Les réponses sont déterministes et portent un marqueur
// `[mock-<provider>]` pour prouver que l'appel IA a vraiment transité par le
// code de l'Edge Function (callProvider → fetch → HTTP → ce serveur).
import http from 'node:http';

export function startMockAi({ port, groqKey, geminiKey, log = () => {} }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        handle(req, res, body);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
  });

  function send(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  function lastUserText(parsed) {
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user' && typeof messages[i].content === 'string') return messages[i].content;
    }
    return '';
  }

  function handle(req, res, raw) {
    const url = new URL(req.url, 'http://bench');
    const auth = req.headers.authorization ?? '';
    const logCall = (provider, method, path) => { calls.push({ provider, method, path: url.pathname, at: new Date().toISOString() }); log(`mock-ai ${provider} ${method} ${url.pathname}`); };

    // --- Groq (format OpenAI) -------------------------------------------
    if (url.pathname === '/openai/v1/chat/completions') {
      if (auth !== `Bearer ${groqKey}`) return send(res, 401, { error: { message: 'invalid api key' } });
      const parsed = JSON.parse(raw || '{}');
      logCall('groq', req.method, url.pathname);
      const userText = lastUserText(parsed);
      const content = `[mock-groq:${parsed.model ?? 'unknown'}] Réponse déterministe du fournisseur local. Dernier message : « ${userText.slice(0, 120)} »`;
      return send(res, 200, {
        id: `chatcmpl-bench-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: parsed.model ?? 'llama-3.3-70b-versatile',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
      });
    }
    if (url.pathname === '/openai/v1/models') {
      if (auth !== `Bearer ${groqKey}`) return send(res, 401, { error: { message: 'invalid api key' } });
      logCall('groq', 'GET', url.pathname);
      return send(res, 200, { object: 'list', data: [
        { id: 'llama-3.3-70b-versatile', object: 'model' },
        { id: 'llama-3.1-8b-instant', object: 'model' },
      ] });
    }

    // --- Gemini -----------------------------------------------------------
    let m = url.pathname.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
    if (m) {
      // L'adaptateur réel envoie la clé dans l'en-tête x-goog-api-key ; on
      // accepte aussi ?key= (format alternatif de l'API Gemini).
      const key = req.headers['x-goog-api-key'] ?? new URL(raw || '', 'http://bench').searchParams.get('key') ?? '';
      if (key !== geminiKey) return send(res, 401, { error: { message: 'API key not valid' } });
      logCall('gemini', 'POST', url.pathname);
      const parsed = JSON.parse(raw || '{}');
      const last = Array.isArray(parsed.contents) ? parsed.contents[parsed.contents.length - 1] : null;
      const text = last?.parts?.map((p) => p.text ?? '').join('') ?? '';
      return send(res, 200, {
        candidates: [{ content: { role: 'model', parts: [{ text: `[mock-gemini] Réponse déterministe du fournisseur local. Dernier message : « ${text.slice(0, 120)} »` }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 38, candidatesTokenCount: 15, totalTokenCount: 53 },
        modelVersion: m[1],
      });
    }
    if (url.pathname === '/v1beta/models') {
      const key = req.headers['x-goog-api-key'] ?? url.searchParams.get('key') ?? '';
      if (key !== geminiKey) return send(res, 401, { error: { message: 'API key not valid' } });
      logCall('gemini', 'GET', url.pathname);
      return send(res, 200, { models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
      ] });
    }
    send(res, 404, { error: { message: `mock-ai : inconnu ${req.method} ${url.pathname}` } });
  }

  server.listen(port, '127.0.0.1');
  return { server, calls, close: async () => new Promise((r) => server.close(r)) };
}
