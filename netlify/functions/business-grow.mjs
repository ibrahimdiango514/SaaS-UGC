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
    return jsonError(401, 'UNAUTHENTICATED', 'Session Reelora ou clé publique manquante.');
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
      return jsonError(504, 'BUSINESS_GROW_TIMEOUT', 'Le serveur Business Grow a dépassé le délai de réponse.');
    }
    return jsonError(
      502,
      'BUSINESS_GROW_UNAVAILABLE',
      'Le relais Netlify vers Business Grow est momentanément indisponible.',
    );
  }
};
