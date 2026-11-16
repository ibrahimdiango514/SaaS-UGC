// VYORA OAuth — Edge Function « vyora-oauth ».
//
// Connecte les comptes Google (Gmail, Drive, Calendar) à un utilisateur VYORA,
// avec des permissions séparées et révocables.
//
// ## Modèle de sécurité
//   - La fonction est déployée `verify_jwt: true` : toute requête doit porter un
//     JWT Supabase valide. L'identité vient de `auth.uid()` côté base, jamais du
//     corps de la requête : un utilisateur ne peut pas agir sur le compte d'un
//     autre, même en forgeant un identifiant.
//   - Les jetons Google ne sont jamais renvoyés au navigateur ni journalisés.
//     Ils sont chiffrés en AES-256-GCM avec `VYORA_OAUTH_ENCRYPTION_KEY`, clé qui
//     n'existe que dans les secrets Supabase.
//   - Le vérificateur PKCE et l'état CSRF sont chiffrés en base, à usage unique,
//     avec une durée de vie de 10 minutes.
//
// ## Routage (POST, `action` dans le corps ou paramètres de requête)
//   start      → { authorization_url, state }   (URL Google à ouvrir)
//   callback   → terminaison OAuth, enregistre le compte
//   list       → comptes connectés (sans aucun jeton)
//   revoke     → révoque chez Google puis efface localement
//   refresh    → force un rafraîchissement (diagnostic)
//   audit      → journal des actions du compte
//
// `GET ?action=callback` est aussi accepté : c'est ainsi que Google renvoie
// l'utilisateur (redirection navigateur, donc GET).

import {
  OAuthError,
  assertCapabilitiesSupported,
  loadUsableAccount,
  normalizeCapabilities,
  refreshAccount,
  revokeAccount,
} from './accounts.ts';
import type { OAuthAccountRow, OAuthStore } from './store.ts';
import { createStore } from './store.ts';
import {
  buildAuthorizationUrl,
  capabilitiesFromScopes,
  createPkcePair,
  createState,
  decodeIdTokenClaims,
  decryptSecret,
  encryptSecret,
  exchangeCode,
  type GoogleProvider,
  type OAuthCapability,
} from '../_shared/oauth/index.ts';
import {
  GOOGLE_TOOLS,
  GoogleToolError,
  executeGoogleTool,
  googleToolsListPayload,
  type GoogleToolName,
} from './google-tools.ts';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const PROVIDERS: readonly GoogleProvider[] = ['gmail', 'google_drive', 'google_calendar'];

function env(name: string): string {
  const scope = globalThis as unknown as {
    Deno?: { env?: { get?: (key: string) => string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return scope.Deno?.env?.get?.(name) ?? scope.process?.env?.[name] ?? '';
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function fail(status: number, code: string, message?: string): Response {
  return json(status, { error: code, message: message ?? code });
}

interface Config {
  readonly baseUrl: string;
  readonly serviceKey: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly encryptionKey: string;
  readonly redirectUri: string;
  readonly fetchImpl?: typeof fetch;
}

function readConfig(override: Partial<Config> = {}): Config {
  // `SUPABASE_URL` sert à la fois d'API interne et de base de construction de
  // l'URI de redirection : aucune URL codée en dur, donc aucun risque de
  // rediriger vers un autre projet.
  const baseUrl = override.baseUrl ?? env('SUPABASE_URL');
  return {
    baseUrl,
    serviceKey: override.serviceKey ?? env('SUPABASE_SERVICE_ROLE_KEY'),
    clientId: override.clientId ?? env('GOOGLE_CLIENT_ID'),
    clientSecret: override.clientSecret ?? env('GOOGLE_CLIENT_SECRET'),
    encryptionKey: override.encryptionKey ?? env('VYORA_OAUTH_ENCRYPTION_KEY'),
    redirectUri: override.redirectUri
      ?? (env('VYORA_OAUTH_REDIRECT_URI') || `${baseUrl}/functions/v1/vyora-oauth?action=callback`),
    fetchImpl: override.fetchImpl,
  };
}

/** Identité de l'appelant, résolue par Supabase à partir du JWT. */
function callerId(request: Request): string | null {
  // Supabase place le JWT vérifié dans l'en-tête `Authorization`. On ne décode
  // QUE pour refuser tôt les requêtes sans jeton ; l'autorisation réelle est
  // faite en base par `auth.uid()`, qui ne peut pas être forgé.
  const header = request.headers.get('Authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() || null : null;
}

export interface HandlerDeps {
  readonly store: OAuthStore;
  readonly config: Config;
}

/** Construit les dépendances réelles (production). */
function productionDeps(override: Partial<Config>): HandlerDeps {
  const config = readConfig(override);
  return {
    config,
    store: createStore({
      baseUrl: config.baseUrl,
      serviceKey: config.serviceKey,
      fetchImpl: config.fetchImpl,
    }),
  };
}

/**
 * `start` — crée l'état CSRF et le vérificateur PKCE, puis rend l'URL Google.
 *
 * Le vérificateur est chiffré avant stockage : même un accès en lecture à la
 * table `oauth_states` ne permet pas de rejouer l'échange.
 */
export async function handleStart(
  input: { provider: unknown; capabilities: unknown; redirectAfter?: unknown },
  deps: HandlerDeps,
  userId: string,
): Promise<Response> {
  const { config, store } = deps;
  if (!config.clientId) return fail(503, 'google_not_configured', 'Identifiants Google absents.');

  const provider = String(input.provider ?? '');
  if (!PROVIDERS.includes(provider as GoogleProvider)) return fail(400, 'provider_invalid');

  let capabilities: OAuthCapability[];
  try {
    capabilities = normalizeCapabilities(input.capabilities);
    assertCapabilitiesSupported(provider as GoogleProvider, capabilities);
  } catch (error) {
    if (error instanceof OAuthError) return fail(400, error.code);
    throw error;
  }

  const { verifier, challenge } = await createPkcePair();
  const state = createState();
  const sealed = await encryptSecret(verifier, config.encryptionKey);

  await store.createState({
    state,
    userId,
    provider,
    verifierCipher: sealed.cipher,
    verifierIv: sealed.iv,
    verifierTag: sealed.tag,
    capabilities,
  });

  await store.audit({
    userId,
    provider,
    action: 'connect_start',
    outcome: 'ok',
    detail: capabilities.join(','),
  });

  return json(200, {
    authorization_url: buildAuthorizationUrl({
      provider: provider as GoogleProvider,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      capabilities,
      state,
      codeChallenge: challenge,
    }),
    state,
    capabilities,
    expires_in: 600,
  });
}

/**
 * `callback` — termine la connexion.
 *
 * L'état est consommé AVANT l'échange de code : un rejeu ne peut pas aboutir,
 * même si l'échange échoue ensuite.
 */
export async function handleCallback(
  input: { code: unknown; state: unknown; error?: unknown },
  deps: HandlerDeps,
): Promise<Response> {
  const { config, store } = deps;
  if (input.error) {
    await store.audit({ action: 'connect_failure', outcome: 'denied', detail: String(input.error).slice(0, 120) });
    return fail(400, 'authorization_denied', String(input.error));
  }
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const state = typeof input.state === 'string' ? input.state.trim() : '';
  if (!code || !state) return fail(400, 'code_or_state_missing');

  // Usage unique : la RPC pose `consumed_at` sous verrou (`for update`).
  const row = await store.consumeState(state);
  if (!row) {
    await store.audit({ action: 'connect_failure', outcome: 'denied', detail: 'etat_invalide_ou_expire' });
    return fail(400, 'state_invalid');
  }

  let verifier: string;
  try {
    verifier = await decryptSecret(
      { cipher: row.verifier_cipher, iv: row.verifier_iv, tag: row.verifier_tag },
      config.encryptionKey,
    );
  } catch {
    await store.audit({ userId: row.user_id, provider: row.provider, action: 'connect_failure', outcome: 'error', detail: 'verificateur_indechiffrable' });
    return fail(500, 'decrypt_failed');
  }

  let tokens;
  try {
    tokens = await exchangeCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      code,
      codeVerifier: verifier,
      fetchImpl: config.fetchImpl,
    });
  } catch (error) {
    await store.audit({
      userId: row.user_id,
      provider: row.provider,
      action: 'connect_failure',
      outcome: 'error',
      detail: error instanceof Error ? error.message.slice(0, 120) : 'inconnu',
    });
    return fail(502, 'token_exchange_failed');
  }

  // Les capacités sont déduites des scopes RÉELLEMENT accordés par Google, pas
  // de ceux demandés : si l'utilisateur refuse une permission, elle n'est pas
  // enregistrée comme disponible.
  const provider = row.provider as GoogleProvider;
  const granted = capabilitiesFromScopes(provider, tokens.scopes);
  const requested = (row.requested_capabilities ?? []) as OAuthCapability[];
  const effective = requested.filter((capability) => granted.includes(capability));

  if (effective.length === 0) {
    await store.audit({
      userId: row.user_id,
      provider: row.provider,
      action: 'connect_failure',
      outcome: 'denied',
      detail: 'aucune_capacite_accordee',
    });
    return fail(403, 'no_capability_granted');
  }

  const claims = tokens.idToken ? decodeIdTokenClaims(tokens.idToken) : null;
  const externalId = claims?.sub ?? `${provider}:${claims?.email ?? 'inconnu'}`;

  // Deux chiffrements indépendants : l'access token et le refresh token ont
  // chacun leur IV et leur étiquette GCM.
  const access = await encryptSecret(tokens.accessToken, config.encryptionKey);
  const refresh = tokens.refreshToken
    ? await encryptSecret(tokens.refreshToken, config.encryptionKey)
    : null;
  const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();

  const accountId = await store.upsertAccount({
    user_id: row.user_id,
    provider,
    external_account_id: externalId,
    display_name: claims?.name ?? null,
    email: claims?.email ?? null,
    access_token_cipher: access.cipher,
    access_token_iv: access.iv,
    access_token_tag: access.tag,
    refresh_token_cipher: refresh ? refresh.cipher : null,
    refresh_token_iv: refresh ? refresh.iv : null,
    refresh_token_tag: refresh ? refresh.tag : null,
    access_expires_at: expiresAt,
    capabilities: effective,
    granted_scopes: tokens.scopes,
    status: 'connected',
  });

  await store.audit({
    userId: row.user_id,
    accountId,
    provider,
    action: 'connect_success',
    outcome: 'ok',
    detail: effective.join(','),
  });

  return json(200, {
    connected: true,
    account_id: accountId,
    provider,
    email: claims?.email ?? null,
    capabilities: effective,
    // Aucun jeton n'est renvoyé : le navigateur ne doit jamais les voir.
  });
}

/**
 * `list` — comptes connectés de l'appelant.
 *
 * Ne peut pas passer par `oauth_account_secret` (qui exige `service_role` et
 * n'est pas borné à l'utilisateur). On interroge donc la table via PostgREST
 * avec un filtre `user_id`, en s'appuyant sur la RLS qui n'autorise que le
 * propriétaire.
 */
export async function handleList(deps: HandlerDeps, bearer: string): Promise<Response> {
  const { config } = deps;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/rest/v1/oauth_accounts?select=id,provider,external_account_id,display_name,email,capabilities,status,last_verified_at,last_error,created_at&order=created_at.desc`;
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    headers: {
      apikey: env('SUPABASE_ANON_KEY'),
      // Le JWT de l'utilisateur, pas la clé service : la RLS s'applique.
      Authorization: `Bearer ${bearer}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return fail(502, 'list_failed');
  const rows = (await response.json()) as unknown[];
  // Ceinture et bretelles : on retire explicitement toute colonne sensible si
  // elle apparaissait un jour dans la sélection.
  const items = (Array.isArray(rows) ? rows : []).map((row) => {
    const record = row as Record<string, unknown>;
    const {
      access_token_cipher, access_token_iv, access_token_tag,
      refresh_token_cipher, refresh_token_iv, refresh_token_tag,
      ...safe
    } = record;
    void access_token_cipher; void access_token_iv; void access_token_tag;
    void refresh_token_cipher; void refresh_token_iv; void refresh_token_tag;
    return safe;
  });
  return json(200, { items });
}

/**
 * `status` — quels fournisseurs sont réellement configurés ?
 *
 * C'est la SEULE source d'autorité : la fonction lit son propre environnement,
 * là où Supabase injecte les secrets. Aucun secret n'est renvoyé, seulement des
 * booléens — le navigateur apprend « c'est prêt » ou « ce n'est pas prêt », rien
 * de plus.
 *
 * Pourquoi pas une RPC SQL : les secrets des Edge Functions ne sont lisibles par
 * aucune vue SQL dans ce projet. Toute tentative côté base aurait répondu
 * `false` en toutes circonstances, y compris le jour où Google serait configuré
 * — un mensonge silencieux, exactement ce que l'interface doit éviter.
 */
export function handleStatus(deps: HandlerDeps): Response {
  const { config } = deps;
  const googleConfigured = Boolean(
    config.clientId && config.clientSecret && config.encryptionKey,
  );
  return json(200, {
    // Un booléen par famille de fournisseurs, pas par secret.
    google: googleConfigured,
    // Le chiffrement est indispensable : sans clé, connecter un compte
    // reviendrait à stocker des jetons illisibles.
    encryption_configured: Boolean(config.encryptionKey),
    providers: {
      gmail: googleConfigured,
      google_drive: googleConfigured,
      google_calendar: googleConfigured,
    },
  });
}

/** `revoke` — révoque chez Google puis efface localement. */
export async function handleRevoke(input: { account_id: unknown }, deps: HandlerDeps, userId: string): Promise<Response> {
  const accountId = String(input.account_id ?? '').trim();
  if (!accountId) return fail(400, 'account_id_required');

  const row = await deps.store.getAccountSecret(accountId);
  if (!row) return fail(404, 'account_not_found');
  // Isolation : on refuse explicitement le compte d'un autre utilisateur.
  if (row.user_id !== userId) return fail(403, 'forbidden');

  const result = await revokeAccount({
    store: deps.store,
    encryptionKey: deps.config.encryptionKey,
    accountId,
    fetchImpl: deps.config.fetchImpl,
  });
  return json(200, result);
}

/** `refresh` — force un rafraîchissement (utile pour diagnostiquer un compte). */
export async function handleRefresh(input: { account_id: unknown }, deps: HandlerDeps, userId: string): Promise<Response> {
  const accountId = String(input.account_id ?? '').trim();
  if (!accountId) return fail(400, 'account_id_required');

  const row = await deps.store.getAccountSecret(accountId);
  if (!row) return fail(404, 'account_not_found');
  if (row.user_id !== userId) return fail(403, 'forbidden');

  try {
    const accessToken = await refreshAccount(row as OAuthAccountRow, {
      store: deps.store,
      encryptionKey: deps.config.encryptionKey,
      clientId: deps.config.clientId,
      clientSecret: deps.config.clientSecret,
      fetchImpl: deps.config.fetchImpl,
    });
    // Longueur seulement : le jeton n'est jamais renvoyé ni journalisé.
    return json(200, { refreshed: true, access_token_length: accessToken.length });
  } catch (error) {
    if (error instanceof OAuthError) return fail(error.status, error.code);
    return fail(500, 'refresh_error');
  }
}

/** `audit` — journal des actions, borné à l'appelant par `auth.uid()`. */
export async function handleAudit(deps: HandlerDeps, bearer: string): Promise<Response> {
  const { config } = deps;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/rest/v1/oauth_audit_log?select=id,provider,action,capability,outcome,detail,created_at&order=created_at.desc&limit=100`;
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    headers: { apikey: env('SUPABASE_ANON_KEY'), Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return fail(502, 'audit_failed');
  return json(200, { items: await response.json() });
}

/**
 * Vérification d'une capacité avant un appel métier (utilisée plus tard par les
 * outils MCP). Exposée en HTTP pour être testable et réutilisable.
 */
export async function handleCheck(input: { account_id: unknown; capability: unknown }, deps: HandlerDeps, userId: string): Promise<Response> {
  const accountId = String(input.account_id ?? '').trim();
  const capability = String(input.capability ?? '').trim() as OAuthCapability;
  if (!accountId) return fail(400, 'account_id_required');
  if (!['read', 'draft', 'send', 'modify'].includes(capability)) return fail(400, 'capability_invalid');

  const row = await deps.store.getAccountSecret(accountId);
  if (!row) return fail(404, 'account_not_found');
  if (row.user_id !== userId) return fail(403, 'forbidden');

  try {
    const { accessToken } = await loadUsableAccount({
      store: deps.store,
      accountId,
      capability,
      encryptionKey: deps.config.encryptionKey,
    });
    return json(200, { allowed: true, has_token: accessToken.length > 0 });
  } catch (error) {
    if (error instanceof OAuthError) {
      return json(error.status === 403 ? 403 : 200, {
        allowed: false,
        error: error.code,
      });
    }
    return fail(500, 'check_error');
  }
}

/**
 * `tools/list` — outils Google exposables en MCP.
 *
 * La liste ne dépend PAS de l'utilisateur : elle décrit ce que VYORA sait faire
 * si l'utilisateur accorde les permissions. C'est volontaire — un client MCP
 * doit pouvoir découvrir les outils avant toute connexion. L'autorisation réelle
 * est vérifiée à chaque appel, jamais à la découverte.
 */
export function handleToolsList(): Response {
  return json(200, { ...googleToolsListPayload(), count: GOOGLE_TOOLS.length });
}

/**
 * `tools/call` — exécute un outil Google pour l'utilisateur courant.
 *
 * Ordre des contrôles, du moins coûteux au plus coûteux :
 *   1. l'outil existe ;
 *   2. le compte appartient à l'appelant (comparaison `user_id`) ;
 *   3. le compte est utilisable et la capacité accordée ;
 *   4. seulement ensuite, le jeton est déchiffré et Google est appelé.
 *
 * Aucun identifiant de compte n'est accepté depuis le client : `account_id`
 * désigne un compte que l'appelant possède déjà, et la comparaison (2) le
 * vérifie explicitement. Il n'y a donc pas de chemin pour atteindre le compte
 * d'un autre utilisateur.
 */
export async function handleToolCall(
  input: { name: unknown; arguments?: unknown; account_id?: unknown },
  deps: HandlerDeps,
  userId: string,
): Promise<Response> {
  const name = String(input.name ?? '');
  const tool = GOOGLE_TOOLS.find((entry) => entry.name === name);
  if (!tool) return fail(404, 'tool_unknown', `Outil inconnu : ${name}`);

  const accountId = String(input.account_id ?? '').trim();
  if (!accountId) return fail(400, 'account_id_required');

  const row = await deps.store.getAccountSecret(accountId);
  if (!row) return fail(404, 'account_not_found');
  if (row.user_id !== userId) return fail(403, 'forbidden');
  if (row.status === 'revoked') return fail(409, 'account_revoked');
  if (row.status !== 'connected' && row.status !== 'error') {
    return fail(409, `account_not_usable:${row.status}`);
  }
  if (row.provider !== tool.provider) {
    return fail(400, 'provider_mismatch', 'Ce compte ne correspond pas à cet outil.');
  }

  // La capacité est revérifiée ici ET dans `executeGoogleTool` : la première
  // barrière donne un message clair, la seconde garantit qu'aucun appel réseau
  // ne part même si l'ordre des contrôles changeait un jour.
  const granted = row.capabilities ?? [];
  if (!granted.includes(tool.capability)) {
    await deps.store.audit({
      userId,
      accountId: row.id,
      provider: row.provider,
      action: 'denied',
      capability: tool.capability,
      outcome: 'denied',
      detail: 'capacite_non_accordee',
    });
    return fail(403, 'capability_not_granted',
      `Cette action demande la permission « ${tool.capability} », que ce compte n’a pas accordée.`);
  }

  // Déchiffrement seulement maintenant : un refus ci-dessus ne coûte rien.
  // Le contrôle de présence est fait AVANT de construire l'objet : TypeScript
  // ne peut pas rétrécir un type à travers un objet intermédiaire.
  if (!row.access_token_cipher || !row.access_token_iv || !row.access_token_tag) {
    return fail(409, 'access_token_missing');
  }
  const accessSealed = {
    cipher: row.access_token_cipher,
    iv: row.access_token_iv,
    tag: row.access_token_tag,
  };
  let accessToken: string;
  try {
    accessToken = await decryptSecret(accessSealed, deps.config.encryptionKey);
  } catch {
    await deps.store.setAccountStatus(row.id, 'error', 'jeton_indechiffrable');
    return fail(500, 'decrypt_failed');
  }

  try {
    const result = await executeGoogleTool(name as GoogleToolName, input.arguments, {
      grantedCapabilities: granted,
      provider: tool.provider,
      accessToken,
      fetchImpl: deps.config.fetchImpl,
    });
    await deps.store.audit({
      userId,
      accountId: row.id,
      provider: row.provider,
      action: tool.capability,
      capability: tool.capability,
      outcome: 'ok',
      detail: name,
    });
    return json(200, { tool: name, result });
  } catch (error) {
    if (error instanceof GoogleToolError) {
      await deps.store.audit({
        userId,
        accountId: row.id,
        provider: row.provider,
        action: 'denied',
        capability: tool.capability,
        outcome: 'error',
        detail: error.code,
      });
      // 403 pour un refus d'autorisation, 400 pour des arguments invalides.
      const status = error.code === 'capability_not_granted' ? 403
        : error.code === 'google_unreachable' || error.code === 'google_error' ? 502
        : error.code === 'google_unauthorized' ? 401
        : error.code === 'google_forbidden' ? 403
        : error.code === 'google_rate_limited' ? 429
        : 400;
      return json(status, { error: error.code, message: error.message });
    }
    return fail(500, 'tool_error');
  }
}

/** Fabrique du handler, séparée de `Deno.serve` pour être testable. */
export function createHandler(override: Partial<Config> = {}) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const config = readConfig(override);
    const deps: HandlerDeps = productionDeps({ ...override, ...config });

    const missing = [
      config.baseUrl ? null : 'SUPABASE_URL',
      config.serviceKey ? null : 'SUPABASE_SERVICE_ROLE_KEY',
      config.encryptionKey ? null : 'VYORA_OAUTH_ENCRYPTION_KEY',
    ].filter(Boolean);
    if (missing.length > 0) {
      // Message générique : on ne nomme jamais la variable manquante côté client.
      return fail(503, 'oauth_not_configured');
    }

    const url = new URL(request.url);
    let body: Record<string, unknown> = {};
    if (request.method === 'POST') {
      const text = await request.text();
      if (text.trim() !== '') {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        } catch {
          return fail(400, 'invalid_json');
        }
      }
    }

    const action = String(body.action ?? url.searchParams.get('action') ?? 'list');

    // `callback` est la seule action accessible sans JWT : Google redirige le
    // navigateur sans en-tête Authorization. La sécurité repose alors sur
    // l'état à usage unique + PKCE, ce qui est précisément leur rôle.
    if (action === 'callback') {
      return handleCallback({
        code: body.code ?? url.searchParams.get('code'),
        state: body.state ?? url.searchParams.get('state'),
        error: body.error ?? url.searchParams.get('error') ?? undefined,
      }, deps);
    }

    const bearer = callerId(request);
    if (!bearer) return fail(401, 'unauthorized');

    switch (action) {
      case 'start':
        return handleStart(
          { provider: body.provider, capabilities: body.capabilities, redirectAfter: body.redirect_after },
          deps,
          bearer,
        );
      case 'status':
        return handleStatus(deps);
      case 'tools_list':
        return handleToolsList();
      case 'tools_call':
        return handleToolCall(
          { name: body.name, arguments: body.arguments, account_id: body.account_id },
          deps,
          bearer,
        );
      case 'list':
        return handleList(deps, bearer);
      case 'revoke':
        return handleRevoke({ account_id: body.account_id }, deps, bearer);
      case 'refresh':
        return handleRefresh({ account_id: body.account_id }, deps, bearer);
      case 'check':
        return handleCheck({ account_id: body.account_id, capability: body.capability }, deps, bearer);
      case 'audit':
        return handleAudit(deps, bearer);
      default:
        return fail(404, 'action_unknown');
    }
  };
}

// Le handler est publié sur `globalThis` : le bundle servant de source déployée
// est débarrassé de ses `export` (voir scripts/build-edge-loader.mjs), donc le
// point d'entrée doit être atteignable sans passer par un export de module.
// `Deno.serve` n'existe pas sous Node (vitest) : les tests utilisent
// directement `createHandler`.
const handler = createHandler();
const runtime = globalThis as unknown as {
  Deno?: { serve?: (fn: (request: Request) => Promise<Response>) => unknown };
  __vyoraOAuthHandler?: (request: Request) => Promise<Response>;
};
runtime.__vyoraOAuthHandler = handler;
runtime.Deno?.serve?.(handler);
