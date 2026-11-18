/**
 * VYORA Meta Integrations — fonction Edge `meta-connect`.
 *
 * Un seul point d'entrée pour WhatsApp Business, Facebook Pages, Messenger et
 * Instagram Business. Toute la logique est ici, avec ses dépendances
 * injectées (`MetaDeps`) : les tests l'exercent sans réseau ni base.
 *
 * ## Chaîne de contrôle (POST, navigateur)
 *
 * 1. Authentification : JWT utilisateur validé auprès de GoTrue.
 * 2. Abonnement Business Grow actif (`bg_import_access`) — avant toute lecture.
 * 3. Droits sur l'entreprise (`bg_can_workspace`), lecture ou écriture selon
 *    l'action.
 * 4. Action. Les jetons sont relus depuis Vault à chaque usage et ne quittent
 *    jamais la fonction : aucune réponse, aucun journal n'en contient.
 *
 * ## Retour Meta (GET …/callback)
 *
 * Meta redirige le navigateur sans JWT. La protection est le `state` : créé
 * côté serveur pour (utilisateur, entreprise, produit) après les contrôles
 * ci-dessus, à usage unique, périmé en 10 minutes. Sans `state` valide, le
 * code n'est même pas échangé. L'échange se fait ici, avec l'App Secret,
 * jamais dans le navigateur.
 *
 * ## WhatsApp Embedded Signup
 *
 * Le SDK Meta remet au navigateur un `code` (pas de jeton) plus les
 * identifiants WABA / numéro choisis. Le navigateur transmet le tout avec le
 * `state` reçu de `start` ; le serveur échange le code, puis VÉRIFIE que le
 * jeton obtenu voit bien ce WABA et ce numéro avant d'enregistrer quoi que
 * ce soit — les identifiants envoyés par le navigateur ne sont pas crus.
 */
import {
  MetaError,
  type GraphDeps,
  type GraphPage,
  debugToken,
  deletePagePost,
  deleteTemplate,
  createTemplate,
  exchangeCode,
  exchangeLongLived,
  getInstagramAccount,
  getWaba,
  httpStatusFor,
  instagramInsights,
  listPagePosts,
  listPages,
  listPhoneNumbers,
  listPostComments,
  listTemplates,
  me as graphMe,
  pageInsights,
  publishInstagramImage,
  publishPagePost,
  redactTokens,
  registerPhoneNumber,
  revokePermissions,
  sendMessengerText,
  sendWhatsAppMessage,
  subscribePage,
  subscribeWaba,
} from '../../../src/business/meta/graph.ts';
import {
  META_PRODUCT_DEFINITIONS,
  type MetaProduct,
  isMetaProduct,
  missingScopes,
} from '../../../src/business/meta/products.ts';
import {
  buildLoginForBusinessUrl,
  callbackUri,
  embeddedSignupLaunch,
  expiresAtFrom,
  isWellFormedState,
  randomPin,
  randomState,
  returnUrl,
} from '../../../src/business/meta/oauth.ts';
import { resolveCorsOrigin } from '../../../src/lib/origin-allowlist.ts';

/* --------------------------------- Types --------------------------------- */

export interface MetaConfig {
  appId: string;
  appSecret: string;
  /** Racine publique du SaaS (retour après autorisation). */
  appUrl: string;
  /** URL du projet Supabase : sert à dériver l'URI de redirection. */
  supabaseUrl: string;
  configIds: Partial<Record<MetaProduct, string>>;
}

export interface ConnectionRow {
  id: string;
  user_id: string;
  workspace_id: string;
  product: MetaProduct;
  status: string;
  external_account_id: string;
  display_name: string | null;
  granted_scopes: string[];
  token_ref: string | null;
  token_expires_at: string | null;
  metadata: Record<string, unknown>;
  last_error: string | null;
}

export interface PageRow {
  id: string;
  connection_id: string;
  page_id: string;
  name: string;
  token_ref: string | null;
  instagram_business_account_id: string | null;
  tasks: string[];
}

export interface MetaDeps {
  config: MetaConfig;
  getUserId(authorization: string): Promise<string | null>;
  checkImportAccess(userId: string): Promise<{ allowed: boolean; reason: string; message: string }>;
  grantWorkspace(userId: string, workspaceId: string): Promise<{ canRead: boolean; canWrite: boolean }>;

  stateCreate(state: string, userId: string, workspaceId: string, product: MetaProduct): Promise<void>;
  stateConsume(state: string): Promise<{ userId: string; workspaceId: string; product: MetaProduct } | null>;

  storeSecret(name: string, value: string): Promise<void>;
  readSecret(name: string): Promise<string | null>;
  deleteSecret(name: string): Promise<void>;

  connectionUpsert(payload: Record<string, unknown>): Promise<string>;
  connectionInternal(userId: string, workspaceId: string, product: MetaProduct): Promise<ConnectionRow | null>;
  connectionsList(userId: string, workspaceId: string, product?: MetaProduct): Promise<unknown[]>;
  connectionSetStatus(userId: string, workspaceId: string, product: MetaProduct, status: string, error?: string | null): Promise<void>;
  connectionMergeMetadata(userId: string, workspaceId: string, product: MetaProduct, metadata: Record<string, unknown>): Promise<void>;
  connectionDelete(userId: string, workspaceId: string, product: MetaProduct): Promise<{ tokenRefs: string[] }>;

  pagesReplace(userId: string, workspaceId: string, product: MetaProduct, pages: Record<string, unknown>[]): Promise<{ removedTokenRefs: string[] }>;
  pageInternal(userId: string, workspaceId: string, product: MetaProduct, pageId: string): Promise<PageRow | null>;

  /** `bg_connect_integration` : trace dans le socle Business Grow (fiche « Connecté »). */
  recordIntegration(userId: string, workspaceId: string, connectorKey: string, credentialRef: string, externalRef: string): Promise<void>;
  disconnectIntegration(userId: string, workspaceId: string, connectorKey: string): Promise<void>;

  messageRecord(payload: Record<string, unknown>): Promise<void>;
  messagesList(userId: string, workspaceId: string, channel: string, accountRef: string | null, conversationRef: string | null, limit: number): Promise<unknown[]>;
  conversationsList(userId: string, workspaceId: string, channel: string, accountRef: string | null, limit: number): Promise<unknown[]>;
  pageEventsList(userId: string, workspaceId: string, channel: string, pageId: string | null, limit: number): Promise<unknown[]>;

  fetchImpl?: typeof fetch;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  now?: () => Date;
}

export class MetaConnectError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'MetaConnectError';
  }
}

/* -------------------------------- Helpers -------------------------------- */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function failure(code: string, message: string) {
  return { error: { code, message: redactTokens(message) } };
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function uuid(value: unknown): string | null {
  const v = text(value, 40);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : null;
}

/** Identifiant Meta : numérique, longueur bornée. */
function metaId(value: unknown): string | null {
  const v = text(value, 40);
  return /^\d{3,40}$/.test(v) ? v : null;
}

export function tokenSecretName(product: MetaProduct, userId: string, workspaceId: string): string {
  return `vyora_meta_${product}_${userId}_${workspaceId}`;
}

export function pageSecretName(product: MetaProduct, pageId: string, userId: string, workspaceId: string): string {
  return `vyora_meta_page_${product}_${pageId}_${userId}_${workspaceId}`;
}

export function pinSecretName(userId: string, workspaceId: string): string {
  return `vyora_meta_wa_pin_${userId}_${workspaceId}`;
}

function graphDeps(deps: MetaDeps): GraphDeps {
  return { fetchImpl: deps.fetchImpl };
}

/** Message d'erreur Meta lisible par le client, sans jeton. */
export function explainMetaError(erreur: MetaError): string {
  switch (erreur.code) {
    case 'auth_expired':
      return 'L’autorisation Meta a expiré : reconnectez le compte.';
    case 'auth_invalid':
      return 'L’autorisation Meta n’est plus valide (révoquée ou mot de passe modifié) : reconnectez le compte.';
    case 'permission_denied':
      return `Meta refuse l’opération : permission manquante ou non approuvée (${erreur.message}).`;
    case 'rate_limited':
      return 'Meta limite temporairement les appels : réessayez dans quelques minutes.';
    case 'not_found':
      return 'Ressource Meta introuvable ou inaccessible avec cette autorisation.';
    case 'invalid_request':
      return `Meta a rejeté la demande : ${erreur.message}`;
    case 'timeout':
      return 'Meta n’a pas répondu à temps.';
    case 'network_failed':
      return 'Meta est injoignable pour le moment.';
    case 'server_error':
      return 'Meta rencontre une erreur interne : réessayez plus tard.';
    default:
      return `Réponse Meta inattendue : ${erreur.message}`;
  }
}

function fromMetaError(erreur: MetaError): MetaConnectError {
  return new MetaConnectError(`META_${erreur.code.toUpperCase()}`, explainMetaError(erreur), httpStatusFor(erreur.code));
}

/* --------------------------------- Entrée -------------------------------- */

export async function handleMetaConnect(
  request: Request,
  deps: MetaDeps,
  options: { allowedOrigins: string[] } = { allowedOrigins: [] },
): Promise<Response> {
  const origin = request.headers.get('origin');
  const corsOrigin = resolveCorsOrigin(options.allowedOrigins, origin);
  const corsHeaders = {
    'access-control-allow-origin': corsOrigin,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'vary': 'origin',
  };
  const json = (payload: unknown, status: number) =>
    new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...corsHeaders } });

  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(request.url);
  if (request.method === 'GET' && /\/callback\/?$/.test(url.pathname)) {
    return handleCallback(url, deps);
  }
  if (request.method !== 'POST') {
    return json(failure('METHOD_NOT_ALLOWED', 'Méthode non autorisée.'), 405);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(failure('INVALID_JSON', 'Corps de requête illisible.'), 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(failure('INVALID_JSON', 'Corps de requête illisible.'), 400);
  }

  const action = text(body.action, 40);
  if (!ACTIONS.has(action)) return json(failure('UNKNOWN_ACTION', 'Opération inconnue.'), 400);

  try {
    const userId = await deps.getUserId(request.headers.get('authorization') ?? '');
    if (!userId) return json(failure('UNAUTHENTICATED', 'Session VYORA invalide ou expirée.'), 401);

    const workspaceId = uuid(body.workspaceId);
    if (!workspaceId) return json(failure('INVALID_WORKSPACE', 'Entreprise requise.'), 400);

    const acces = await deps.checkImportAccess(userId);
    if (!acces.allowed) {
      const motif = acces.reason || 'SUBSCRIPTION_REQUIRED';
      // 402 : c'est une condition d'abonnement, pas un droit d'accès manquant.
      // Le client doit proposer l'abonnement Business Grow, pas « demander un
      // accès ».
      const statut = /SUBSCRIPTION|NO_PLAN|TRIAL/.test(motif) ? 402 : 403;
      return json(failure(motif, acces.message || 'Un abonnement Business Grow actif est requis.'), statut);
    }

    const grant = await deps.grantWorkspace(userId, workspaceId);
    const ecriture = WRITE_ACTIONS.has(action);
    if (ecriture ? !grant.canWrite : !grant.canRead) {
      return json(failure('WORKSPACE_ACCESS_DENIED', 'Droits insuffisants sur cette entreprise.'), 403);
    }

    const ctx: Ctx = { userId, workspaceId, deps, body };
    const data = await dispatch(action, ctx);
    return json({ data }, 200);
  } catch (erreur) {
    if (erreur instanceof MetaConnectError) return json(failure(erreur.code, erreur.message), erreur.status);
    if (erreur instanceof MetaError) {
      const e = fromMetaError(erreur);
      return json(failure(e.code, e.message), e.status);
    }
    deps.log?.('meta-connect: erreur interne', { erreur: erreur instanceof Error ? redactTokens(erreur.message) : 'inconnue' });
    return json(failure('META_CONNECT_BACKEND_ERROR', 'Le service de connexion Meta est temporairement indisponible.'), 500);
  }
}

const ACTIONS = new Set([
  'start', 'finish-embedded', 'status', 'verify', 'refresh', 'disconnect',
  'pages.list', 'pages.select',
  'whatsapp.send', 'whatsapp.templates', 'whatsapp.template.create', 'whatsapp.template.delete',
  'messenger.send', 'messages.list', 'conversations.list',
  'facebook.publish', 'facebook.posts', 'facebook.post.delete', 'facebook.insights', 'facebook.comments', 'page.events',
  'instagram.account', 'instagram.publish', 'instagram.insights',
]);

const WRITE_ACTIONS = new Set([
  'start', 'finish-embedded', 'refresh', 'disconnect', 'pages.select',
  'whatsapp.send', 'whatsapp.template.create', 'whatsapp.template.delete',
  'messenger.send', 'facebook.publish', 'facebook.post.delete', 'instagram.publish',
]);

interface Ctx {
  userId: string;
  workspaceId: string;
  deps: MetaDeps;
  body: Record<string, unknown>;
}

function productOf(body: Record<string, unknown>): MetaProduct {
  const p = text(body.product, 20);
  if (!isMetaProduct(p)) throw new MetaConnectError('INVALID_PRODUCT', 'Produit Meta inconnu.', 400);
  return p;
}

async function dispatch(action: string, ctx: Ctx): Promise<unknown> {
  switch (action) {
    case 'start': return start(ctx);
    case 'finish-embedded': return finishEmbedded(ctx);
    case 'status': return status(ctx);
    case 'verify': return verify(ctx);
    case 'refresh': return refresh(ctx);
    case 'disconnect': return disconnect(ctx);
    case 'pages.list': return pagesList(ctx);
    case 'pages.select': return pagesSelect(ctx);
    case 'whatsapp.send': return whatsappSend(ctx);
    case 'whatsapp.templates': return whatsappTemplates(ctx);
    case 'whatsapp.template.create': return whatsappTemplateCreate(ctx);
    case 'whatsapp.template.delete': return whatsappTemplateDelete(ctx);
    case 'messenger.send': return messengerSend(ctx);
    case 'messages.list': return messagesList(ctx);
    case 'conversations.list': return conversationsList(ctx);
    case 'facebook.publish': return facebookPublish(ctx);
    case 'facebook.posts': return facebookPosts(ctx);
    case 'facebook.post.delete': return facebookPostDelete(ctx);
    case 'facebook.insights': return facebookInsights(ctx);
    case 'facebook.comments': return facebookComments(ctx);
    case 'page.events': return pageEvents(ctx);
    case 'instagram.account': return instagramAccount(ctx);
    case 'instagram.publish': return instagramPublish(ctx);
    case 'instagram.insights': return instagramInsightsAction(ctx);
    default: throw new MetaConnectError('UNKNOWN_ACTION', 'Opération inconnue.', 400);
  }
}

/* --------------------------------- start --------------------------------- */

async function start(ctx: Ctx) {
  const { deps } = ctx;
  const product = productOf(ctx.body);
  const def = META_PRODUCT_DEFINITIONS[product];
  if (!deps.config.appId || !deps.config.appSecret) {
    throw new MetaConnectError('META_NOT_CONFIGURED', 'L’application Meta n’est pas configurée côté serveur (META_APP_ID / META_APP_SECRET).', 503);
  }
  const configId = deps.config.configIds[product] ?? '';
  if (!configId) {
    throw new MetaConnectError('META_CONFIG_ID_MISSING', `La configuration Meta de ${def.label} (${def.configIdEnv}) n’est pas renseignée côté serveur.`, 503);
  }
  const state = randomState();
  await deps.stateCreate(state, ctx.userId, ctx.workspaceId, product);

  if (def.flow === 'embedded-signup') {
    return embeddedSignupLaunch({ appId: deps.config.appId, configId, state });
  }
  return {
    mode: 'redirect',
    url: buildLoginForBusinessUrl({
      appId: deps.config.appId,
      product,
      configId,
      redirectUri: callbackUri(deps.config.supabaseUrl),
      state,
    }),
    scopes: [...def.scopes],
  };
}

/* ------------------------------- callback -------------------------------- */

async function handleCallback(url: URL, deps: MetaDeps): Promise<Response> {
  const redirect = (product: MetaProduct, ok: boolean, code?: string) =>
    new Response(null, { status: 303, headers: { location: returnUrl(deps.config.appUrl, { product, ok, code }), 'cache-control': 'no-store' } });

  const state = url.searchParams.get('state');
  if (!isWellFormedState(state)) return redirect('facebook', false, 'STATE_INVALID');

  const consomme = await deps.stateConsume(state);
  if (!consomme) return redirect('facebook', false, 'STATE_INVALID');
  const { userId, workspaceId, product } = consomme;

  // Refus ou annulation côté Meta : rien à échanger.
  const erreurMeta = url.searchParams.get('error') ?? url.searchParams.get('error_reason');
  const code = url.searchParams.get('code');
  if (erreurMeta || !code) {
    deps.log?.('meta-connect: autorisation refusée', { product, reason: text(erreurMeta, 60) || 'no_code' });
    return redirect(product, false, erreurMeta === 'access_denied' || url.searchParams.get('error_reason') === 'user_denied' ? 'USER_DENIED' : 'NO_CODE');
  }

  try {
    const g = graphDeps(deps);
    const court = await exchangeCode({
      appId: deps.config.appId,
      appSecret: deps.config.appSecret,
      code,
      redirectUri: callbackUri(deps.config.supabaseUrl),
    }, g);
    const long = await exchangeLongLived({ appId: deps.config.appId, appSecret: deps.config.appSecret, token: court.access_token }, g);
    const info = await debugToken({ appId: deps.config.appId, appSecret: deps.config.appSecret, token: long.access_token }, g);
    if (info.app_id && info.app_id !== deps.config.appId) {
      throw new MetaConnectError('META_TOKEN_MISMATCH', 'Le jeton rendu par Meta n’appartient pas à l’application VYORA.', 502);
    }
    const identite = await graphMe(long.access_token, g);
    const scopes = Array.isArray(info.scopes) ? info.scopes : [];
    const manquantes = missingScopes(product, scopes);

    const tokenRef = tokenSecretName(product, userId, workspaceId);
    await deps.storeSecret(tokenRef, long.access_token);
    const expiresAt = info.expires_at && info.expires_at > 0
      ? new Date(info.expires_at * 1000)
      : expiresAtFrom(long.expires_in, deps.now?.() ?? new Date());

    await deps.connectionUpsert({
      user_id: userId,
      workspace_id: workspaceId,
      product,
      status: 'connected',
      external_account_id: identite.id,
      display_name: identite.name ?? null,
      granted_scopes: scopes,
      token_ref: tokenRef,
      token_expires_at: expiresAt ? expiresAt.toISOString() : null,
      metadata: { flow: 'login-for-business', missing_scopes: manquantes, data_access_expires_at: info.data_access_expires_at ?? null },
    });
    try {
      await deps.recordIntegration(userId, workspaceId, product, tokenRef, identite.id);
    } catch (erreur) {
      deps.log?.('meta-connect: trace socle impossible', { product, erreur: erreur instanceof Error ? redactTokens(erreur.message) : 'inconnue' });
    }
    return redirect(product, true);
  } catch (erreur) {
    const code = erreur instanceof MetaError ? `META_${erreur.code.toUpperCase()}`
      : erreur instanceof MetaConnectError ? erreur.code : 'EXCHANGE_FAILED';
    deps.log?.('meta-connect: échange de code échoué', { product, code });
    return redirect(product, false, code);
  }
}

/* ---------------------------- finish-embedded ---------------------------- */

async function finishEmbedded(ctx: Ctx) {
  const { deps, body } = ctx;
  const state = body.state;
  if (!isWellFormedState(state)) throw new MetaConnectError('STATE_INVALID', 'Parcours Meta invalide ou expiré : relancez la connexion.', 400);
  const code = text(body.code, 2000);
  if (!code) throw new MetaConnectError('NO_CODE', 'Meta n’a pas rendu de code d’autorisation.', 400);
  const wabaId = metaId(body.wabaId);
  const phoneNumberId = metaId(body.phoneNumberId);
  // Un identifiant fourni mais illisible ne doit JAMAIS retomber sur « le
  // premier numéro du WABA » : ce repli connecterait un autre numéro que celui
  // choisi par l'utilisateur.
  if (text(body.phoneNumberId, 40) && !phoneNumberId) {
    throw new MetaConnectError('PHONE_INVALID_ID', 'Identifiant de numéro WhatsApp invalide.', 400);
  }
  if (text(body.wabaId, 40) && !wabaId) {
    throw new MetaConnectError('WABA_INVALID_ID', 'Identifiant de compte WhatsApp Business invalide.', 400);
  }

  const consomme = await deps.stateConsume(state);
  if (!consomme || consomme.userId !== ctx.userId || consomme.workspaceId !== ctx.workspaceId || consomme.product !== 'whatsapp') {
    throw new MetaConnectError('STATE_INVALID', 'Parcours Meta invalide ou expiré : relancez la connexion.', 400);
  }

  const g = graphDeps(deps);
  // Embedded Signup : échange SANS redirect_uri (exigence Meta pour le SDK).
  const jeton = await exchangeCode({ appId: deps.config.appId, appSecret: deps.config.appSecret, code }, g);
  const info = await debugToken({ appId: deps.config.appId, appSecret: deps.config.appSecret, token: jeton.access_token }, g);
  if (info.app_id && info.app_id !== deps.config.appId) {
    throw new MetaConnectError('META_TOKEN_MISMATCH', 'Le jeton rendu par Meta n’appartient pas à l’application VYORA.', 502);
  }
  const scopes = Array.isArray(info.scopes) ? info.scopes : [];

  // Les identifiants viennent du navigateur : on les confronte au jeton.
  let wabaCible = wabaId;
  if (!wabaCible) {
    const granulaires = (info.granular_scopes ?? []).find((s) => s.scope === 'whatsapp_business_management');
    wabaCible = granulaires?.target_ids?.[0] ?? null;
  }
  if (!wabaCible) throw new MetaConnectError('WABA_REQUIRED', 'Aucun compte WhatsApp Business n’a été sélectionné dans le parcours Meta.', 400);
  const waba = await getWaba(wabaCible, jeton.access_token, g);
  const numeros = await listPhoneNumbers(wabaCible, jeton.access_token, g);
  const numero = phoneNumberId ? numeros.find((n) => n.id === phoneNumberId) : numeros[0];
  if (!numero) {
    throw new MetaConnectError('PHONE_NOT_IN_WABA', 'Le numéro sélectionné n’appartient pas au compte WhatsApp Business autorisé.', 400);
  }

  let webhookSubscribed = false;
  try {
    webhookSubscribed = await subscribeWaba(wabaCible, jeton.access_token, g);
  } catch (erreur) {
    deps.log?.('meta-connect: abonnement webhook WABA échoué', { code: erreur instanceof MetaError ? erreur.code : 'inconnu' });
  }

  /*
   * Enregistrement du numéro pour l'API Cloud (PIN conservé dans Vault).
   *
   * Deux cas ne doivent PAS être enregistrés :
   * - un numéro déjà sur Cloud API (`platform_type === 'CLOUD_API'`) : c'est
   *   typiquement un numéro repris de l'application WhatsApp Business
   *   (« coexistence »). Meta indique explicitement de sauter l'enregistrement,
   *   et le refaire échouerait sur le PIN déjà défini.
   * - rien : l'échec est mémorisé et affiché, sans empêcher la connexion.
   */
  const dejaSurCloudApi = numero.platform_type === 'CLOUD_API';
  let registered = dejaSurCloudApi;
  let registerError: string | null = null;
  const pinRef = pinSecretName(ctx.userId, ctx.workspaceId);
  if (!dejaSurCloudApi) {
    try {
      let pin = await deps.readSecret(pinRef);
      if (!pin) {
        pin = randomPin();
        await deps.storeSecret(pinRef, pin);
      }
      registered = await registerPhoneNumber(numero.id, jeton.access_token, pin, g);
    } catch (erreur) {
      registerError = erreur instanceof MetaError ? `${erreur.code}: ${erreur.message}` : 'register_failed';
      deps.log?.('meta-connect: enregistrement du numéro échoué', { code: erreur instanceof MetaError ? erreur.code : 'inconnu' });
    }
  }

  const tokenRef = tokenSecretName('whatsapp', ctx.userId, ctx.workspaceId);
  await deps.storeSecret(tokenRef, jeton.access_token);
  /*
   * Jeton d'intégration métier : pas d'expiration (Meta ne renvoie ni
   * `expires_in` ni `expires_at`). Écrire une date déduite ferait basculer la
   * fiche en « Jeton expiré » alors que le jeton est permanent — exactement le
   * faux état que l'on veut éviter. On ne garde une date que si Meta en donne
   * une.
   */
  const expiresAt = info.expires_at && info.expires_at > 0
    ? new Date(info.expires_at * 1000)
    : expiresAtFrom(jeton.expires_in, deps.now?.() ?? new Date());
  const jetonPermanent = !expiresAt;

  await deps.connectionUpsert({
    user_id: ctx.userId,
    workspace_id: ctx.workspaceId,
    product: 'whatsapp',
    status: 'connected',
    external_account_id: waba.id,
    display_name: numero.verified_name ?? waba.name ?? null,
    granted_scopes: scopes,
    token_ref: tokenRef,
    token_expires_at: expiresAt ? expiresAt.toISOString() : null,
    metadata: {
      flow: 'embedded-signup',
      waba_id: waba.id,
      waba_name: waba.name ?? null,
      account_review_status: waba.account_review_status ?? null,
      phone_number_id: numero.id,
      display_phone_number: numero.display_phone_number ?? null,
      verified_name: numero.verified_name ?? null,
      quality_rating: numero.quality_rating ?? null,
      code_verification_status: numero.code_verification_status ?? null,
      webhook_subscribed: webhookSubscribed,
      registered,
      register_error: registerError,
      register_skipped_already_cloud_api: dejaSurCloudApi,
      permanent_token: jetonPermanent,
      missing_scopes: missingScopes('whatsapp', scopes),
    },
  });
  try {
    await deps.recordIntegration(ctx.userId, ctx.workspaceId, 'whatsapp', tokenRef, waba.id);
  } catch (erreur) {
    deps.log?.('meta-connect: trace socle impossible', { product: 'whatsapp', erreur: erreur instanceof Error ? redactTokens(erreur.message) : 'inconnue' });
  }
  return { connected: true, connections: await deps.connectionsList(ctx.userId, ctx.workspaceId, 'whatsapp') };
}

/* --------------------------- status / verify ----------------------------- */

async function status(ctx: Ctx) {
  const product = text(ctx.body.product, 20);
  const connections = await ctx.deps.connectionsList(ctx.userId, ctx.workspaceId, isMetaProduct(product) ? product : undefined);
  return {
    configured: Boolean(ctx.deps.config.appId && ctx.deps.config.appSecret),
    configIds: Object.fromEntries((Object.keys(META_PRODUCT_DEFINITIONS) as MetaProduct[]).map((p) => [p, Boolean(ctx.deps.config.configIds[p])])),
    connections,
  };
}

async function requireConnection(ctx: Ctx, product: MetaProduct): Promise<{ row: ConnectionRow; token: string }> {
  const row = await ctx.deps.connectionInternal(ctx.userId, ctx.workspaceId, product);
  if (!row || row.status === 'disconnected') {
    throw new MetaConnectError('CONNECTION_REQUIRED', `${META_PRODUCT_DEFINITIONS[product].label} n’est pas connecté à cette entreprise.`, 409);
  }
  if (!row.token_ref) throw new MetaConnectError('TOKEN_MISSING', 'Aucune autorisation enregistrée : reconnectez le compte.', 409);
  if (row.token_expires_at && new Date(row.token_expires_at).getTime() < (ctx.deps.now?.() ?? new Date()).getTime()) {
    await ctx.deps.connectionSetStatus(ctx.userId, ctx.workspaceId, product, 'expired', 'Jeton expiré.');
    throw new MetaConnectError('TOKEN_EXPIRED', 'L’autorisation Meta a expiré : reconnectez le compte.', 401);
  }
  const token = await ctx.deps.readSecret(row.token_ref);
  if (!token) throw new MetaConnectError('TOKEN_MISSING', 'Le jeton n’est plus disponible : reconnectez le compte.', 409);
  return { row, token };
}

/** Transforme une erreur Meta d'autorisation en état persistant, puis la relance. */
async function withAuthState<T>(ctx: Ctx, product: MetaProduct, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (erreur) {
    if (erreur instanceof MetaError && (erreur.code === 'auth_invalid' || erreur.code === 'auth_expired')) {
      await ctx.deps.connectionSetStatus(ctx.userId, ctx.workspaceId, product, erreur.code === 'auth_expired' ? 'expired' : 'revoked', explainMetaError(erreur));
    }
    throw erreur;
  }
}

async function verify(ctx: Ctx) {
  const product = productOf(ctx.body);
  const { token } = await requireConnection(ctx, product);
  const info = await debugToken({ appId: ctx.deps.config.appId, appSecret: ctx.deps.config.appSecret, token }, graphDeps(ctx.deps));
  if (info.is_valid === false) {
    await ctx.deps.connectionSetStatus(ctx.userId, ctx.workspaceId, product, 'revoked', 'Jeton invalidé par Meta.');
    return { valid: false, connections: await ctx.deps.connectionsList(ctx.userId, ctx.workspaceId, product) };
  }
  await ctx.deps.connectionSetStatus(ctx.userId, ctx.workspaceId, product, 'connected', null);
  await ctx.deps.connectionMergeMetadata(ctx.userId, ctx.workspaceId, product, {
    missing_scopes: missingScopes(product, info.scopes ?? []),
    verified_scopes: info.scopes ?? [],
  });
  return { valid: true, scopes: info.scopes ?? [], connections: await ctx.deps.connectionsList(ctx.userId, ctx.workspaceId, product) };
}

/**
 * Renouvellement : un jeton utilisateur long encore valide peut être
 * ré-échangé (`fb_exchange_token`) pour repartir sur 60 jours. Un jeton déjà
 * expiré ne se renouvelle pas : seule une reconnexion le remplace.
 */
async function refresh(ctx: Ctx) {
  const product = productOf(ctx.body);
  const { row, token } = await requireConnection(ctx, product);
  if (row.metadata?.flow === 'embedded-signup') {
    /*
     * Le jeton WhatsApp n'est pas rafraîchissable : celui rendu par Embedded
     * Signup est un jeton de système d'intégration métier (« business token »)
     * lié au client, sans `expires_in`. Il reste valable jusqu'à révocation
     * côté Meta ; `exchangeLongLived` n'a donc rien à échanger. On le vérifie
     * plutôt, pour prouver qu'il fonctionne encore.
     */
    try {
      const info = await debugToken({ appId: ctx.deps.config.appId, appSecret: ctx.deps.config.appSecret, token }, graphDeps(ctx.deps));
      if (info.is_valid === false) {
        await ctx.deps.connectionSetStatus(ctx.userId, ctx.workspaceId, product, 'expired', 'Jeton WhatsApp révoqué chez Meta.');
        throw new MetaConnectError('TOKEN_EXPIRED', 'L’autorisation WhatsApp a été révoquée chez Meta : reconnectez le compte.', 401);
      }
      await ctx.deps.connectionMergeMetadata(ctx.userId, ctx.workspaceId, product, {
        token_checked_at: (ctx.deps.now?.() ?? new Date()).toISOString(),
        scopes: info.scopes ?? row.granted_scopes,
      });
    } catch (erreur) {
      if (erreur instanceof MetaConnectError) throw erreur;
      ctx.deps.log?.('meta-connect: vérification du jeton WhatsApp échouée', { code: erreur instanceof MetaError ? erreur.code : 'inconnu' });
    }
    return {
      refreshed: false,
      reason: 'PERMANENT_TOKEN',
      message:
        'Le jeton WhatsApp Business est un jeton de système d’intégration sans date d’expiration : il n’y a rien à renouveler. Il reste valable jusqu’à ce qu’il soit révoqué chez Meta ; « Vérifier » confirme qu’il fonctionne encore.',
    };
  }
  return withAuthState(ctx, product, async () => {
    const g = graphDeps(ctx.deps);
    const long = await exchangeLongLived({ appId: ctx.deps.config.appId, appSecret: ctx.deps.config.appSecret, token }, g);
    const info = await debugToken({ appId: ctx.deps.config.appId, appSecret: ctx.deps.config.appSecret, token: long.access_token }, g);
    await ctx.deps.storeSecret(row.token_ref as string, long.access_token);
    const expiresAt = info.expires_at && info.expires_at > 0 ? new Date(info.expires_at * 1000) : expiresAtFrom(long.expires_in, ctx.deps.now?.() ?? new Date());
    await ctx.deps.connectionUpsert({
      user_id: ctx.userId,
      workspace_id: ctx.workspaceId,
      product,
      status: 'connected',
      external_account_id: row.external_account_id,
      display_name: row.display_name,
      granted_scopes: info.scopes ?? row.granted_scopes,
      token_ref: row.token_ref,
      token_expires_at: expiresAt ? expiresAt.toISOString() : null,
      metadata: {},
    });
    return { refreshed: true, token_expires_at: expiresAt ? expiresAt.toISOString() : null };
  });
}

/* ------------------------------- disconnect ------------------------------ */

async function disconnect(ctx: Ctx) {
  const product = productOf(ctx.body);
  const row = await ctx.deps.connectionInternal(ctx.userId, ctx.workspaceId, product);
  let remoteRevoked = false;
  if (row?.token_ref) {
    const token = await ctx.deps.readSecret(row.token_ref);
    if (token && row.metadata?.flow !== 'embedded-signup') {
      try {
        remoteRevoked = await revokePermissions(token, graphDeps(ctx.deps));
      } catch (erreur) {
        ctx.deps.log?.('meta-connect: révocation distante impossible', { code: erreur instanceof MetaError ? erreur.code : 'inconnu' });
      }
    }
  }
  // Ordre : état en base d'abord, secrets ensuite (cf. store-connect).
  const { tokenRefs } = await ctx.deps.connectionDelete(ctx.userId, ctx.workspaceId, product);
  for (const ref of new Set([...tokenRefs, ...(product === 'whatsapp' ? [pinSecretName(ctx.userId, ctx.workspaceId)] : [])])) {
    if (ref) await ctx.deps.deleteSecret(ref).catch(() => {});
  }
  try {
    await ctx.deps.disconnectIntegration(ctx.userId, ctx.workspaceId, product);
  } catch (erreur) {
    ctx.deps.log?.('meta-connect: trace socle (déconnexion) impossible', { erreur: erreur instanceof Error ? redactTokens(erreur.message) : 'inconnue' });
  }
  return { disconnected: true, remoteRevoked, connections: await ctx.deps.connectionsList(ctx.userId, ctx.workspaceId, product) };
}

/* --------------------------------- pages --------------------------------- */

function pageProductOf(body: Record<string, unknown>): MetaProduct {
  const p = productOf(body);
  if (p === 'whatsapp') throw new MetaConnectError('INVALID_PRODUCT', 'WhatsApp n’a pas de pages.', 400);
  return p;
}

async function pagesList(ctx: Ctx) {
  const product = pageProductOf(ctx.body);
  const { token } = await requireConnection(ctx, product);
  return withAuthState(ctx, product, async () => {
    const pages = await listPages(token, graphDeps(ctx.deps));
    const existantes = (await ctx.deps.connectionsList(ctx.userId, ctx.workspaceId, product)) as Array<{ pages?: Array<{ page_id: string }> }>;
    const selection = new Set((existantes[0]?.pages ?? []).map((p) => p.page_id));
    return {
      pages: pages.map((p) => ({
        page_id: p.id,
        name: p.name,
        category: p.category ?? null,
        tasks: p.tasks ?? [],
        instagram_business_account_id: p.instagram_business_account?.id ?? null,
        can_manage: (p.tasks ?? []).includes('MANAGE') || (p.tasks ?? []).includes('CREATE_CONTENT'),
        has_token: Boolean(p.access_token),
        selected: selection.has(p.id),
      })),
    };
  });
}

async function pagesSelect(ctx: Ctx) {
  const product = pageProductOf(ctx.body);
  const voulues = Array.isArray(ctx.body.pageIds) ? ctx.body.pageIds.map((v) => metaId(v)).filter((v): v is string => Boolean(v)) : [];
  if (voulues.length > 50) throw new MetaConnectError('TOO_MANY_PAGES', 'Au plus 50 pages par connexion.', 400);
  const { token } = await requireConnection(ctx, product);
  return withAuthState(ctx, product, async () => {
    const g = graphDeps(ctx.deps);
    const disponibles = await listPages(token, g);
    const parId = new Map(disponibles.map((p) => [p.id, p] as const));
    const champs = META_PRODUCT_DEFINITIONS[product].webhook.fields;
    const lignes: Record<string, unknown>[] = [];
    const refus: Array<{ page_id: string; code: string }> = [];
    for (const id of voulues) {
      const page: GraphPage | undefined = parId.get(id);
      // Propriété vérifiée : une page absente de `/me/accounts` n'est pas à l'utilisateur.
      if (!page || !page.access_token) {
        refus.push({ page_id: id, code: 'NOT_OWNED' });
        continue;
      }
      const ref = pageSecretName(product, page.id, ctx.userId, ctx.workspaceId);
      await ctx.deps.storeSecret(ref, page.access_token);
      let abonnee = false;
      if (product !== 'instagram') {
        try {
          abonnee = await subscribePage(page.id, page.access_token, champs, g);
        } catch (erreur) {
          ctx.deps.log?.('meta-connect: abonnement webhook page échoué', { code: erreur instanceof MetaError ? erreur.code : 'inconnu' });
        }
      }
      let igUsername: string | null = null;
      if (product === 'instagram' && page.instagram_business_account?.id) {
        try {
          const ig = await getInstagramAccount(page.instagram_business_account.id, page.access_token, g);
          igUsername = ig.username ?? null;
          abonnee = await subscribePage(page.id, page.access_token, ['feed'], g).catch(() => false);
        } catch (erreur) {
          ctx.deps.log?.('meta-connect: lecture compte Instagram échouée', { code: erreur instanceof MetaError ? erreur.code : 'inconnu' });
        }
      }
      lignes.push({
        page_id: page.id,
        name: page.name,
        category: page.category ?? null,
        tasks: page.tasks ?? [],
        token_ref: ref,
        instagram_business_account_id: page.instagram_business_account?.id ?? null,
        instagram_username: igUsername,
        webhook_subscribed: abonnee,
      });
    }
    const { removedTokenRefs } = await ctx.deps.pagesReplace(ctx.userId, ctx.workspaceId, product, lignes);
    for (const ref of removedTokenRefs) await ctx.deps.deleteSecret(ref).catch(() => {});
    return { selected: lignes.length, refused: refus, connections: await ctx.deps.connectionsList(ctx.userId, ctx.workspaceId, product) };
  });
}

async function requirePage(ctx: Ctx, product: MetaProduct): Promise<{ page: PageRow; token: string }> {
  await requireConnection(ctx, product);
  const pageId = metaId(ctx.body.pageId);
  if (!pageId) throw new MetaConnectError('PAGE_REQUIRED', 'Page requise.', 400);
  const page = await ctx.deps.pageInternal(ctx.userId, ctx.workspaceId, product, pageId);
  if (!page) throw new MetaConnectError('PAGE_NOT_SELECTED', 'Cette page n’est pas rattachée à l’entreprise.', 404);
  if (!page.token_ref) throw new MetaConnectError('TOKEN_MISSING', 'Aucune autorisation de page : resélectionnez la page.', 409);
  const token = await ctx.deps.readSecret(page.token_ref);
  if (!token) throw new MetaConnectError('TOKEN_MISSING', 'Le jeton de page n’est plus disponible : resélectionnez la page.', 409);
  return { page, token };
}

/* -------------------------------- WhatsApp ------------------------------- */

function phoneOf(row: ConnectionRow): string {
  const id = typeof row.metadata?.phone_number_id === 'string' ? row.metadata.phone_number_id : '';
  if (!id) throw new MetaConnectError('PHONE_MISSING', 'Aucun numéro WhatsApp enregistré : reconnectez le compte.', 409);
  return id;
}

async function whatsappSend(ctx: Ctx) {
  const { row, token } = await requireConnection(ctx, 'whatsapp');
  const phoneNumberId = phoneOf(row);
  const to = text(ctx.body.to, 20).replace(/[^\d]/g, '');
  if (to.length < 8) throw new MetaConnectError('RECIPIENT_INVALID', 'Numéro destinataire invalide (format international, chiffres uniquement).', 400);
  const corps = text(ctx.body.text, 4096);
  const tpl = ctx.body.template && typeof ctx.body.template === 'object' ? ctx.body.template as Record<string, unknown> : null;
  const template = tpl ? { name: text(tpl.name, 512), language: text(tpl.language, 16) || 'fr', components: Array.isArray(tpl.components) ? tpl.components : undefined } : undefined;
  if (!template && !corps) throw new MetaConnectError('MESSAGE_EMPTY', 'Message vide.', 400);
  if (template && !template.name) throw new MetaConnectError('TEMPLATE_INVALID', 'Nom de modèle requis.', 400);

  return withAuthState(ctx, 'whatsapp', async () => {
    const envoi = await sendWhatsAppMessage(phoneNumberId, token, { to, text: corps || undefined, template }, graphDeps(ctx.deps));
    await ctx.deps.messageRecord({
      user_id: ctx.userId,
      workspace_id: ctx.workspaceId,
      connection_id: row.id,
      channel: 'whatsapp',
      account_ref: phoneNumberId,
      conversation_ref: envoi.waId ?? to,
      external_message_id: envoi.messageId,
      direction: 'out',
      message_type: template ? 'template' : 'text',
      body: template ? `[modèle ${template.name}]` : corps,
      status: 'sent',
    });
    return { messageId: envoi.messageId, to: envoi.waId ?? to };
  });
}

async function whatsappTemplates(ctx: Ctx) {
  const { row, token } = await requireConnection(ctx, 'whatsapp');
  return withAuthState(ctx, 'whatsapp', async () => ({
    templates: await listTemplates(row.external_account_id, token, graphDeps(ctx.deps)),
  }));
}

async function whatsappTemplateCreate(ctx: Ctx) {
  const { row, token } = await requireConnection(ctx, 'whatsapp');
  const name = text(ctx.body.name, 512).toLowerCase();
  const language = text(ctx.body.language, 16) || 'fr';
  const category = text(ctx.body.category, 20).toUpperCase();
  const components = Array.isArray(ctx.body.components) ? ctx.body.components : null;
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new MetaConnectError('TEMPLATE_INVALID', 'Nom de modèle : minuscules, chiffres et tirets bas uniquement.', 400);
  if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) throw new MetaConnectError('TEMPLATE_INVALID', 'Catégorie : MARKETING, UTILITY ou AUTHENTICATION.', 400);
  if (!components || components.length === 0) throw new MetaConnectError('TEMPLATE_INVALID', 'Au moins un composant (BODY) est requis.', 400);
  return withAuthState(ctx, 'whatsapp', async () =>
    createTemplate(row.external_account_id, token, { name, language, category: category as 'MARKETING' | 'UTILITY' | 'AUTHENTICATION', components }, graphDeps(ctx.deps)));
}

async function whatsappTemplateDelete(ctx: Ctx) {
  const { row, token } = await requireConnection(ctx, 'whatsapp');
  const name = text(ctx.body.name, 512);
  if (!name) throw new MetaConnectError('TEMPLATE_INVALID', 'Nom de modèle requis.', 400);
  return withAuthState(ctx, 'whatsapp', async () => ({ deleted: await deleteTemplate(row.external_account_id, token, name, graphDeps(ctx.deps)) }));
}

/* -------------------------------- Messenger ------------------------------ */

async function messengerSend(ctx: Ctx) {
  const { page, token } = await requirePage(ctx, 'messenger');
  const recipientId = metaId(ctx.body.recipientId);
  const corps = text(ctx.body.text, 2000);
  if (!recipientId) throw new MetaConnectError('RECIPIENT_INVALID', 'Destinataire invalide.', 400);
  if (!corps) throw new MetaConnectError('MESSAGE_EMPTY', 'Message vide.', 400);
  return withAuthState(ctx, 'messenger', async () => {
    const envoi = await sendMessengerText(page.page_id, token, { recipientId, text: corps }, graphDeps(ctx.deps));
    await ctx.deps.messageRecord({
      user_id: ctx.userId,
      workspace_id: ctx.workspaceId,
      connection_id: page.connection_id,
      channel: 'messenger',
      account_ref: page.page_id,
      conversation_ref: recipientId,
      external_message_id: envoi.messageId,
      direction: 'out',
      message_type: 'text',
      body: corps,
      status: 'sent',
    });
    return { messageId: envoi.messageId };
  });
}

async function messagesList(ctx: Ctx) {
  const channel = text(ctx.body.channel, 20);
  if (!['whatsapp', 'messenger', 'instagram'].includes(channel)) throw new MetaConnectError('INVALID_CHANNEL', 'Canal inconnu.', 400);
  const accountRef = text(ctx.body.accountRef, 64) || null;
  const conversationRef = text(ctx.body.conversationRef, 64) || null;
  const limit = Math.min(200, Math.max(1, Number(ctx.body.limit) || 50));
  return { messages: await ctx.deps.messagesList(ctx.userId, ctx.workspaceId, channel, accountRef, conversationRef, limit) };
}

async function conversationsList(ctx: Ctx) {
  const channel = text(ctx.body.channel, 20);
  if (!['whatsapp', 'messenger', 'instagram'].includes(channel)) throw new MetaConnectError('INVALID_CHANNEL', 'Canal inconnu.', 400);
  const accountRef = text(ctx.body.accountRef, 64) || null;
  const limit = Math.min(200, Math.max(1, Number(ctx.body.limit) || 50));
  return { conversations: await ctx.deps.conversationsList(ctx.userId, ctx.workspaceId, channel, accountRef, limit) };
}

/* -------------------------------- Facebook ------------------------------- */

async function facebookPublish(ctx: Ctx) {
  const { page, token } = await requirePage(ctx, 'facebook');
  const message = text(ctx.body.message, 10_000);
  const link = text(ctx.body.link, 2000);
  if (!message && !link) throw new MetaConnectError('MESSAGE_EMPTY', 'Texte ou lien requis.', 400);
  if (link && !/^https?:\/\//i.test(link)) throw new MetaConnectError('LINK_INVALID', 'Lien invalide.', 400);
  const scheduled = Number(ctx.body.scheduledPublishTime) || undefined;
  return withAuthState(ctx, 'facebook', async () =>
    publishPagePost(page.page_id, token, { message, link: link || undefined, scheduledPublishTime: scheduled }, graphDeps(ctx.deps)));
}

async function facebookPosts(ctx: Ctx) {
  const { page, token } = await requirePage(ctx, 'facebook');
  return withAuthState(ctx, 'facebook', async () => ({ posts: await listPagePosts(page.page_id, token, 25, graphDeps(ctx.deps)) }));
}

async function facebookPostDelete(ctx: Ctx) {
  const { page, token } = await requirePage(ctx, 'facebook');
  const postId = text(ctx.body.postId, 80);
  if (!/^\d+_\d+$/.test(postId) || !postId.startsWith(`${page.page_id}_`)) {
    throw new MetaConnectError('POST_INVALID', 'Identifiant de publication invalide pour cette page.', 400);
  }
  return withAuthState(ctx, 'facebook', async () => ({ deleted: await deletePagePost(postId, token, graphDeps(ctx.deps)) }));
}

async function facebookInsights(ctx: Ctx) {
  const { page, token } = await requirePage(ctx, 'facebook');
  return withAuthState(ctx, 'facebook', async () => ({ insights: await pageInsights(page.page_id, token, graphDeps(ctx.deps)) }));
}

async function facebookComments(ctx: Ctx) {
  const { page, token } = await requirePage(ctx, 'facebook');
  const postId = text(ctx.body.postId, 80);
  if (!/^\d+_\d+$/.test(postId) || !postId.startsWith(`${page.page_id}_`)) {
    throw new MetaConnectError('POST_INVALID', 'Identifiant de publication invalide pour cette page.', 400);
  }
  return withAuthState(ctx, 'facebook', async () => ({ comments: await listPostComments(postId, token, graphDeps(ctx.deps)) }));
}

async function pageEvents(ctx: Ctx) {
  const channel = text(ctx.body.channel, 20);
  if (!['facebook', 'instagram'].includes(channel)) throw new MetaConnectError('INVALID_CHANNEL', 'Canal inconnu.', 400);
  const pageId = metaId(ctx.body.pageId);
  const limit = Math.min(200, Math.max(1, Number(ctx.body.limit) || 50));
  return { events: await ctx.deps.pageEventsList(ctx.userId, ctx.workspaceId, channel, pageId, limit) };
}

/* -------------------------------- Instagram ------------------------------ */

async function requireInstagram(ctx: Ctx) {
  const { page, token } = await requirePage(ctx, 'instagram');
  if (!page.instagram_business_account_id) {
    throw new MetaConnectError('INSTAGRAM_NOT_LINKED', 'Aucun compte Instagram professionnel n’est relié à cette page.', 409);
  }
  return { page, token, igId: page.instagram_business_account_id };
}

async function instagramAccount(ctx: Ctx) {
  const { igId, token } = await requireInstagram(ctx);
  return withAuthState(ctx, 'instagram', async () => ({ account: await getInstagramAccount(igId, token, graphDeps(ctx.deps)) }));
}

async function instagramPublish(ctx: Ctx) {
  const { igId, token } = await requireInstagram(ctx);
  const imageUrl = text(ctx.body.imageUrl, 2000);
  const caption = text(ctx.body.caption, 2200);
  if (!/^https:\/\//i.test(imageUrl)) throw new MetaConnectError('IMAGE_INVALID', 'URL d’image HTTPS publique requise (JPEG).', 400);
  return withAuthState(ctx, 'instagram', async () => publishInstagramImage(igId, token, { imageUrl, caption }, graphDeps(ctx.deps)));
}

async function instagramInsightsAction(ctx: Ctx) {
  const { igId, token } = await requireInstagram(ctx);
  return withAuthState(ctx, 'instagram', async () => ({ insights: await instagramInsights(igId, token, graphDeps(ctx.deps)) }));
}
