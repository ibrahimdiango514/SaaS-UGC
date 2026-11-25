/**
 * Relais Netlify → Edge Function `reelora-video`.
 *
 * ## Pourquoi ce relais existe
 * Le Studio appelle la génération vidéo depuis le navigateur. Passer par cette
 * origine plutôt que directement par `*.supabase.co` :
 *   - évite toute clé d'API dans le bundle (aucun secret côté client) ;
 *   - garde le même comportement de session que le reste de l'application ;
 *   - permet de borner la taille et le délai de la requête à un seul endroit.
 *
 * ## Ce que le relais NE fait PAS
 * Il n'authentifie pas à la place de l'utilisateur : `Authorization` et `apikey`
 * sont transmis tels quels, et la fonction Supabase (`verify_jwt = true`) reste
 * l'arbitre. Sans session, l'appel échoue en 401 — ce n'est pas un
 * contournement.
 *
 * ## Limite
 * Le corps porte des CHEMINS Storage et des URL signées, pas les binaires : les
 * fichiers sont téléversés directement vers Storage par le navigateur. La borne
 * de taille ci-dessous est donc large mais finie.
 */

const TARGET_URL = 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/reelora-video';

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
  path: '/api/reelora-video',
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
      // Une génération peut être lente à démarrer : la marge est plus large
      // que pour Business Grow, mais reste bornée.
      signal: AbortSignal.timeout(55_000),
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
      return jsonError(504, 'REELORA_VIDEO_TIMEOUT', 'Le service vidéo a dépassé le délai de réponse.');
    }
    return jsonError(
      502,
      'REELORA_VIDEO_UNAVAILABLE',
      'Le relais Netlify vers le service vidéo est momentanément indisponible.',
    );
  }
};
