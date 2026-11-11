type BootstrapConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  ownerEmail: string;
};

type Json = Record<string, unknown>;

const allowedOrigins = new Set([
  'https://vyora-ugc.netlify.app',
  'http://localhost:5173',
  'http://localhost:4173',
]);

function response(
  request: Request,
  body: Json,
  status = 200,
): Response {
  const origin = request.headers.get('origin') ?? '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
  if (allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function failure(request: Request, code: string, message: string, status: number): Response {
  return response(request, { error: { code, message } }, status);
}

async function callRpc<T>(
  config: BootstrapConfig,
  fetcher: typeof fetch,
  name: string,
  body: Json = {},
): Promise<T> {
  const result = await fetcher(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!result.ok) throw new Error(`rpc_${name}_${result.status}`);
  return await result.json() as T;
}

export function createOwnerBootstrapHandler(config: BootstrapConfig, fetcher: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin') ?? '';
    if (request.method === 'OPTIONS') {
      if (origin && !allowedOrigins.has(origin)) return failure(request, 'origin_not_allowed', 'Origine non autorisée.', 403);
      return response(request, {}, 200);
    }
    if (origin && !allowedOrigins.has(origin)) return failure(request, 'origin_not_allowed', 'Origine non autorisée.', 403);
    if (!config.supabaseUrl || !config.serviceRoleKey) {
      return failure(request, 'server_not_configured', 'Le service de bootstrap n’est pas configuré.', 503);
    }

    if (request.method === 'GET') {
      try {
        const available = await callRpc<boolean>(config, fetcher, 'reelora_first_admin_bootstrap_available');
        return response(request, {
          available,
          initialized: !available,
          configured: Boolean(config.ownerEmail),
        });
      } catch {
        return failure(request, 'status_unavailable', 'Impossible de vérifier l’état du bootstrap administrateur.', 503);
      }
    }

    if (request.method !== 'POST') {
      return failure(request, 'method_not_allowed', 'Méthode non autorisée.', 405);
    }
    if (!config.ownerEmail) {
      return failure(request, 'owner_not_configured', 'Le propriétaire autorisé n’est pas configuré côté serveur.', 503);
    }

    const authorization = request.headers.get('authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) {
      return failure(request, 'authentication_required', 'Une session confirmée est requise.', 401);
    }

    try {
      const authResponse = await fetcher(`${config.supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: authorization,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!authResponse.ok) return failure(request, 'authentication_required', 'Session invalide ou expirée.', 401);
      const user = await authResponse.json() as Json;
      const userEmail = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
      const confirmed = Boolean(user.email_confirmed_at || user.confirmed_at);
      if (!userEmail || !confirmed) {
        return failure(request, 'email_confirmation_required', 'Confirmez votre adresse e-mail avant de continuer.', 403);
      }
      if (userEmail !== config.ownerEmail.trim().toLowerCase()) {
        return failure(request, 'owner_email_not_authorized', 'Cette adresse n’est pas autorisée à initialiser le compte propriétaire.', 403);
      }

      const available = await callRpc<boolean>(config, fetcher, 'reelora_first_admin_bootstrap_available');
      if (!available) {
        return failure(request, 'admin_already_initialized', 'Le premier administrateur est déjà initialisé.', 409);
      }

      const userId = await callRpc<string>(config, fetcher, 'reelora_bootstrap_first_admin', {
        p_email: userEmail,
      });
      if (userId !== user.id) {
        return failure(request, 'bootstrap_identity_mismatch', 'Le serveur n’a pas confirmé le compte propriétaire attendu.', 502);
      }
      return response(request, { user_id: userId });
    } catch {
      return failure(request, 'bootstrap_failed', 'Le bootstrap administrateur a échoué. Vérifiez la session puis réessayez.', 502);
    }
  };
}

const runtime = globalThis as typeof globalThis & {
  Deno?: {
    env: { get(name: string): string | undefined };
    serve(handler: (request: Request) => Response | Promise<Response>): void;
  };
};

if (runtime.Deno?.serve) {
  const env = runtime.Deno.env;
  runtime.Deno.serve(createOwnerBootstrapHandler({
    supabaseUrl: env.get('SUPABASE_URL') ?? '',
    serviceRoleKey: env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    ownerEmail: env.get('VYORA_OWNER_ADMIN_EMAIL') ?? '',
  }));
}
