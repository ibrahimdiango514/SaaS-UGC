/**
 * Relais Netlify → Edge Function Supabase `business-grow`.
 *
 * ## Ce que ce fichier corrige
 * Cette fonction existait en double : une version Edge (`edge-functions/`) et une
 * version « Functions » (`functions/`). Les deux déclaraient le même en-tête
 * `export const config = { path: '/api/business-grow' }`, mais une Netlify
 * Function classique n'accepte pas cette forme — elle attend un
 * `export default async (req, context) => …` et un routage par nom de fichier. Le
 * déploiement échouait donc à l'étape d'empaquetage, avec un message qui ne
 * désignait pas le fichier fautif.
 *
 * Le doublon n'avait aucune utilité : `netlify.toml` ne déclare que des
 * `[[edge_functions]]`, et l'interface appelle `/api/business-grow` puis
 * `/.netlify/functions/business-grow` — le second n'était qu'un repli jamais
 * servi. Il est supprimé, pas déplacé.
 *
 * ## Rôle
 * Le navigateur n'appelle jamais `*.supabase.co` : il passe par cette origine.
 * Le relais transmet `Authorization` et `apikey` tels quels ; la fonction
 * Supabase (`verify_jwt = true`) reste l'arbitre. Aucun secret ici, aucune
 * substitution de jeton : sans session, l'appel échoue en 401 — ce n'est pas un
 * contournement.
 */

const TARGET_URL = 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/business-grow';

function jsonError(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export const config = {
  path: '/api/business-grow',
};

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'POST') {
    return jsonError(405, 'METHOD_NOT_ALLOWED', 'Méthode non autorisée.');
  }

  const authorization = request.headers.get('authorization') ?? '';
  const apikey = request.headers.get('apikey') ?? '';
  if (!authorization.startsWith('Bearer ') || !apikey) {
    return jsonError(401, 'UNAUTHENTICATED', 'Session SORAHNEX ou clé publique manquante.');
  }

  const body = await request.text();
  if (!body || body.length > 262_144) {
    return jsonError(400, 'INVALID_BODY', 'Corps de requête invalide ou trop volumineux.');
  }

  try {
    const upstream = await fetch(TARGET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
        apikey,
      },
      body,
      signal: AbortSignal.timeout(25_000),
    });
    const payload = await upstream.text();
    return new Response(payload, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return jsonError(504, 'BUSINESS_GROW_TIMEOUT', 'Le service Grow a dépassé le délai de réponse.');
    }
    return jsonError(
      502,
      'BUSINESS_GROW_UNAVAILABLE',
      'Le relais Netlify vers le service Grow est momentanément indisponible.',
    );
  }
};
