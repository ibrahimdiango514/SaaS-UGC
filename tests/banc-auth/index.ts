// @ts-nocheck
// Fichier destiné au runtime Deno d'une fonction Edge (jetable), pas au
// typecheck Node du dépôt : `Deno` n'y existe pas.
/**
 * BANC D'AUTHENTIFICATION — serveur MCP réel, jetable.
 *
 * ## Ce que c'est
 *
 * Un vrai serveur MCP (HTTP + JSON-RPC) déployé temporairement pour prouver les
 * trois modes d'authentification de VYORA de bout en bout : `bearer`,
 * `api_key` et `oauth`. Ce n'est PAS un bouchon de test unitaire : c'est un
 * service joignable sur Internet, avec TLS, qui refuse les mauvais identifiants
 * exactement comme un serveur distant réel.
 *
 * ## Pourquoi il existe
 *
 * Aucun serveur MCP public ne fournit d'identifiants temporaires pour les trois
 * modes simultanément. Sans ce banc, les modes `bearer`/`api_key`/`oauth`
 * n'auraient été couverts que par des tests unitaires — et un test unitaire ne
 * prouve pas qu'un vrai serveur accepte ou refuse un en-tête.
 *
 * ## Sécurité
 *
 * - jetons aléatoires de 144 bits, non devinables ;
 * - chaque mode exige SON jeton : présenter celui d'un autre mode échoue ;
 * - aucune écriture de données, aucun stockage, aucune journalisation de jeton ;
 * - fonction supprimée après la campagne de validation.
 *
 * ## Ne pas déployer en dehors d'une campagne de test
 *
 * Ce fichier vit sous `tests/` volontairement : ce n'est pas un chemin de
 * déploiement de fonction Edge.
 */

const JETON_BEARER = '9efe999491bf8429fd30a3fe359828ca1294';
const JETON_APIKEY = '719d22cf09e4a674373c8e130e4a48d693cf';
const JETON_OAUTH = '74037f79c560a60102919df2382da22f8438';

type Mode = 'bearer' | 'apikey' | 'oauth' | 'lent';

function modeDuChemin(chemin: string): Mode | null {
  const m = /\/(bearer|apikey|oauth|lent)\/mcp\/?$/.exec(chemin);
  return m ? (m[1] as Mode) : null;
}

function jetonAttendu(mode: Mode): string {
  if (mode === 'bearer') return JETON_BEARER;
  if (mode === 'apikey') return JETON_APIKEY;
  return JETON_OAUTH;
}

/**
 * Mode `lent` : même jeton que `bearer`, mais la réponse à `initialize` est
 * retardée de 25 s. Sert à prouver qu'un serveur qui ne répond pas est
 * interrompu par le délai de VYORA (et non attendu indéfiniment).
 */
const DELAI_LENT_MS = 25_000;

/**
 * Vérifie les identifiants du mode demandé.
 *
 * Comparaison à temps constant : un banc d'authentification qui compare avec
 * `===` enseignerait une mauvaise pratique, et serait lui-même un oracle.
 */
function identifiantsValides(mode: Mode, entetes: Headers): boolean {
  const attendu = jetonAttendu(mode);
  const fourni = mode === 'apikey'
    ? (entetes.get('x-api-key') ?? '')
    : (/^Bearer\s+(.+)$/i.exec(entetes.get('authorization') ?? '')?.[1] ?? '');
  if (fourni.length !== attendu.length) return false;
  let difference = 0;
  for (let i = 0; i < attendu.length; i++) difference |= attendu.charCodeAt(i) ^ fourni.charCodeAt(i);
  return difference === 0;
}

const OUTILS = [
  {
    name: 'list_items',
    description: 'Liste les éléments disponibles. Lecture seule.',
    inputSchema: { type: 'object', properties: { limite: { type: 'number' } } },
  },
  {
    name: 'create_item',
    description: 'Crée un élément. Écriture.',
    inputSchema: { type: 'object', properties: { nom: { type: 'string' } } },
  },
];

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-api-key, content-type, mcp-session-id, mcp-protocol-version',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function json(charge: unknown, statut = 200, entetes: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(charge), {
    status: statut,
    headers: { 'content-type': 'application/json', ...cors, ...entetes },
  });
}

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const mode = modeDuChemin(url.pathname);
  if (!mode) return json({ error: 'not_found' }, 404);

  if (!identifiantsValides(mode, request.headers)) {
    // 401 + WWW-Authenticate : c'est ce qu'un serveur MCP conforme renvoie, et
    // c'est ce que VYORA doit traduire en « identifiants refusés ».
    return json(
      { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'invalid_token' } },
      401,
      { 'www-authenticate': mode === 'oauth' ? 'Bearer error="invalid_token"' : 'Bearer' },
    );
  }

  let message: { id?: number | null; method?: string; params?: Record<string, unknown> };
  try {
    message = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (message.method === 'notifications/initialized') {
    return new Response(null, { status: 202, headers: cors });
  }

  if (mode === 'lent') await new Promise((r) => setTimeout(r, DELAI_LENT_MS));

  if (message.method === 'initialize') {
    return json({
      jsonrpc: '2.0',
      id: message.id ?? null,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: `banc-auth-${mode}`, version: '1.0.0' },
      },
    }, 200, { 'mcp-session-id': `sess-${mode}` });
  }

  if (message.method === 'tools/list') {
    return json({ jsonrpc: '2.0', id: message.id ?? null, result: { tools: OUTILS } });
  }

  if (message.method === 'tools/call') {
    const nom = String(message.params?.name ?? '');
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    if (nom === 'create_item') {
      // Jamais atteint : VYORA refuse les écritures avant l'appel. S'il l'était,
      // le fait serait visible dans la réponse.
      return json({
        jsonrpc: '2.0', id: message.id ?? null,
        result: { content: [{ type: 'text', text: 'ECRITURE_EFFECTUEE' }] },
      });
    }
    return json({
      jsonrpc: '2.0',
      id: message.id ?? null,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            source: `banc-auth-${mode}`,
            mode,
            argumentsRecus: args,
            elements: ['alpha', 'beta', 'gamma'],
          }),
        }],
      },
    });
  }

  return json({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: 'method_not_found' } });
});
