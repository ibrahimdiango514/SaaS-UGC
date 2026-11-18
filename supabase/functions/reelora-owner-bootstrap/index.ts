type BootstrapConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  ownerEmail: string;
  /** Origines acceptées ; à défaut, la liste par défaut seule. */
  allowedOrigins?: readonly string[];
};

type Json = Record<string, unknown>;

/**
 * Origines acceptées : liste par défaut + secret `VYORA_ALLOWED_ORIGINS`
 * (séparé par des virgules, jokers `*` admis sur l'hôte, comme pour
 * `store-connect`, `store-import` et `mcp-client`).
 *
 * Avant le 2026-11-18, seule une liste figée (ancien domaine Netlify +
 * localhost) était acceptée, sans aucun réglage possible : sur tout nouveau
 * domaine, la page « Propriétaire » recevait `403 origin_not_allowed` et le
 * premier administrateur ne pouvait pas être créé. Le fichier reste autonome
 * (aucun import) pour rester déployable tel quel.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  'https://vyora-ugc.netlify.app',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
];

export function parseAllowedOrigins(extra: string | undefined): string[] {
  const merged = [...DEFAULT_ALLOWED_ORIGINS, ...(extra ?? '').split(',')]
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return merged.filter((value, index) => merged.indexOf(value) === index);
}

export function isOriginAllowed(origin: string, patterns: readonly string[]): boolean {
  if (!origin) return false;
  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      if (pattern === origin) return true;
      continue;
    }
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^./]+');
    if (new RegExp(`^${escaped}$`).test(origin)) return true;
  }
  return false;
}

function response(
  request: Request,
  body: Json,
  status = 200,
  allowedOrigins: readonly string[] = DEFAULT_ALLOWED_ORIGINS,
): Response {
  const origin = request.headers.get('origin') ?? '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
  if (isOriginAllowed(origin, allowedOrigins)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function failure(
  request: Request,
  code: string,
  message: string,
  status: number,
  allowedOrigins: readonly string[] = DEFAULT_ALLOWED_ORIGINS,
): Response {
  return response(request, { error: { code, message } }, status, allowedOrigins);
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
  const allowedOrigins = config.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
  const reply = (request: Request, body: Json, status = 200) => response(request, body, status, allowedOrigins);
  const refuse = (request: Request, code: string, message: string, status: number) =>
    failure(request, code, message, status, allowedOrigins);
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin') ?? '';
    if (request.method === 'OPTIONS') {
      if (origin && !isOriginAllowed(origin, allowedOrigins)) return refuse(request, 'origin_not_allowed', 'Origine non autorisée.', 403);
      return reply(request, {}, 200);
    }
    if (origin && !isOriginAllowed(origin, allowedOrigins)) return refuse(request, 'origin_not_allowed', 'Origine non autorisée.', 403);
    if (!config.supabaseUrl || !config.serviceRoleKey) {
      return refuse(request, 'server_not_configured', 'Le service de bootstrap n’est pas configuré.', 503);
    }

    if (request.method === 'GET') {
      try {
        const available = await callRpc<boolean>(config, fetcher, 'reelora_first_admin_bootstrap_available');
        return reply(request, {
          available,
          initialized: !available,
          configured: Boolean(config.ownerEmail),
        });
      } catch {
        return refuse(request, 'status_unavailable', 'Impossible de vérifier l’état du bootstrap administrateur.', 503);
      }
    }

    if (request.method !== 'POST') {
      return refuse(request, 'method_not_allowed', 'Méthode non autorisée.', 405);
    }
    if (!config.ownerEmail) {
      return refuse(request, 'owner_not_configured', 'Le propriétaire autorisé n’est pas configuré côté serveur.', 503);
    }

    const authorization = request.headers.get('authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) {
      return refuse(request, 'authentication_required', 'Une session confirmée est requise.', 401);
    }

    try {
      const authResponse = await fetcher(`${config.supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: authorization,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!authResponse.ok) return refuse(request, 'authentication_required', 'Session invalide ou expirée.', 401);
      const user = await authResponse.json() as Json;
      const userEmail = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
      const confirmed = Boolean(user.email_confirmed_at || user.confirmed_at);
      if (!userEmail || !confirmed) {
        return refuse(request, 'email_confirmation_required', 'Confirmez votre adresse e-mail avant de continuer.', 403);
      }
      if (userEmail !== config.ownerEmail.trim().toLowerCase()) {
        return refuse(request, 'owner_email_not_authorized', 'Cette adresse n’est pas autorisée à initialiser le compte propriétaire.', 403);
      }

      const available = await callRpc<boolean>(config, fetcher, 'reelora_first_admin_bootstrap_available');
      if (!available) {
        return refuse(request, 'admin_already_initialized', 'Le premier administrateur est déjà initialisé.', 409);
      }

      const userId = await callRpc<string>(config, fetcher, 'reelora_bootstrap_first_admin', {
        p_email: userEmail,
      });
      if (userId !== user.id) {
        return refuse(request, 'bootstrap_identity_mismatch', 'Le serveur n’a pas confirmé le compte propriétaire attendu.', 502);
      }
      return reply(request, { user_id: userId });
    } catch {
      return refuse(request, 'bootstrap_failed', 'Le bootstrap administrateur a échoué. Vérifiez la session puis réessayez.', 502);
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
    allowedOrigins: parseAllowedOrigins(env.get('VYORA_ALLOWED_ORIGINS')),
  }));
}
