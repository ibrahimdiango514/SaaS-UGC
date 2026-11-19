/**
 * VYORA Meta Integrations — client Graph API minimal et vérifiable.
 *
 * Règles :
 * - Hôte fixe (`graph.facebook.com`), version fixe : aucune URL ne vient de
 *   l'utilisateur, la surface SSRF est nulle.
 * - Le jeton part en en-tête `Authorization: Bearer`, jamais en paramètre
 *   d'URL : il n'apparaît donc ni dans un journal d'accès ni dans un message
 *   d'erreur construit depuis l'URL.
 * - Les erreurs Meta sont classées en codes stables (`auth_invalid`,
 *   `permission_denied`, `rate_limited`…) avec le message Meta d'origine
 *   expurgé de tout jeton. L'interface affiche ces codes, pas une pile.
 * - Aucune donnée n'est inventée : chaque fonction rend ce que Meta a répondu
 *   ou lève une `MetaError`.
 */
import { META_GRAPH_VERSION } from './products.ts';

export const GRAPH_HOST = 'https://graph.facebook.com';

export type MetaErrorCode =
  | 'auth_invalid'
  | 'auth_expired'
  | 'permission_denied'
  | 'rate_limited'
  | 'not_found'
  | 'invalid_request'
  | 'bad_response'
  | 'network_failed'
  | 'timeout'
  | 'server_error';

export class MetaError extends Error {
  readonly code: MetaErrorCode;
  readonly httpStatus: number;
  readonly metaCode: number | null;
  readonly metaSubcode: number | null;
  readonly fbtraceId: string | null;

  constructor(code: MetaErrorCode, message: string, detail: {
    httpStatus?: number; metaCode?: number | null; metaSubcode?: number | null; fbtraceId?: string | null;
  } = {}) {
    super(redactTokens(message));
    this.name = 'MetaError';
    this.code = code;
    this.httpStatus = detail.httpStatus ?? 0;
    this.metaCode = detail.metaCode ?? null;
    this.metaSubcode = detail.metaSubcode ?? null;
    this.fbtraceId = detail.fbtraceId ?? null;
  }
}

/** Retire toute séquence ressemblant à un jeton Meta (`EAA…`) ou à un secret. */
export function redactTokens(text: string): string {
  return text
    .replace(/EAA[0-9A-Za-z]{8,}/g, 'EAA…[expurgé]')
    .replace(/(access_token|client_secret|appsecret_proof)=([^&\s"']+)/gi, '$1=[expurgé]');
}

/** Statut HTTP conseillé pour relayer une erreur Meta au navigateur. */
export function httpStatusFor(code: MetaErrorCode): number {
  switch (code) {
    case 'auth_invalid':
    case 'auth_expired':
      return 401;
    case 'permission_denied':
      return 403;
    case 'not_found':
      return 404;
    case 'rate_limited':
      return 429;
    case 'invalid_request':
      return 400;
    case 'timeout':
      return 504;
    case 'network_failed':
    case 'bad_response':
    case 'server_error':
      return 502;
  }
}

/**
 * Classe une erreur Graph selon les codes documentés par Meta :
 * 190 jeton invalide/expiré (sous-codes 458–467 : révocation, expiration,
 * mot de passe changé), 10/200–299 permission manquante, 4/17/32/613 limites,
 * 100 requête invalide, 803/803 objet introuvable.
 */
export function classifyGraphError(httpStatus: number, body: unknown): MetaError {
  const err = (body && typeof body === 'object' && 'error' in body)
    ? (body as { error: Record<string, unknown> }).error
    : null;
  const metaCode = typeof err?.code === 'number' ? err.code : null;
  const metaSubcode = typeof err?.error_subcode === 'number' ? err.error_subcode : null;
  const fbtraceId = typeof err?.fbtrace_id === 'string' ? err.fbtrace_id : null;
  const message = typeof err?.message === 'string' && err.message ? err.message : `Réponse Meta inattendue (HTTP ${httpStatus}).`;
  const detail = { httpStatus, metaCode, metaSubcode, fbtraceId };

  if (metaCode === 190) {
    const expired = metaSubcode === 463 || metaSubcode === 464 || metaSubcode === 467;
    return new MetaError(expired ? 'auth_expired' : 'auth_invalid', message, detail);
  }
  if (metaCode === 102) return new MetaError('auth_invalid', message, detail);
  if (metaCode === 10 || (metaCode !== null && metaCode >= 200 && metaCode <= 299)) {
    return new MetaError('permission_denied', message, detail);
  }
  if (metaCode === 4 || metaCode === 17 || metaCode === 32 || metaCode === 613 || metaCode === 80007 || metaCode === 130429) {
    return new MetaError('rate_limited', message, detail);
  }
  if (metaCode === 803 || httpStatus === 404) return new MetaError('not_found', message, detail);
  if (metaCode === 100 || metaCode === 131000 || metaCode === 131026 || metaCode === 131047 || metaCode === 131051 || metaCode === 132000 || metaCode === 132001 || metaCode === 133010) {
    return new MetaError('invalid_request', message, detail);
  }
  if (httpStatus === 401 || httpStatus === 403) return new MetaError('permission_denied', message, detail);
  if (httpStatus >= 500) return new MetaError('server_error', message, detail);
  if (httpStatus >= 400) return new MetaError('invalid_request', message, detail);
  return new MetaError('bad_response', message, detail);
}

export interface GraphDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  version?: string;
}

export interface GraphRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown> | URLSearchParams;
  /** Jeton d'accès (utilisateur, page, système). Optionnel pour l'échange de code. */
  token?: string;
}

/** Requête Graph brute. Rend le JSON décodé ou lève une `MetaError`. */
export async function graphFetch<T = Record<string, unknown>>(request: GraphRequest, deps: GraphDeps = {}): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const version = deps.version ?? META_GRAPH_VERSION;
  const chemin = request.path.replace(/^\/+/, '');
  const url = new URL(`${GRAPH_HOST}/${version}/${chemin}`);
  for (const [k, v] of Object.entries(request.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.token) headers.authorization = `Bearer ${request.token}`;
  let body: string | URLSearchParams | undefined;
  if (request.body instanceof URLSearchParams) {
    body = request.body;
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (request.body) {
    body = JSON.stringify(request.body);
    headers['content-type'] = 'application/json';
  }

  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), deps.timeoutMs ?? 15_000);
  let reponse: Response;
  try {
    reponse = await fetchImpl(url.toString(), {
      method: request.method ?? 'GET',
      headers,
      body,
      signal: controleur.signal,
      redirect: 'error',
    });
  } catch (erreur) {
    const abandon = erreur instanceof Error && erreur.name === 'AbortError';
    throw new MetaError(abandon ? 'timeout' : 'network_failed', abandon ? 'Meta n’a pas répondu à temps.' : 'Meta est injoignable.');
  } finally {
    clearTimeout(minuteur);
  }

  const texte = await reponse.text();
  let json: unknown = null;
  if (texte) {
    try {
      json = JSON.parse(texte);
    } catch {
      throw new MetaError('bad_response', `Réponse Meta illisible (HTTP ${reponse.status}).`, { httpStatus: reponse.status });
    }
  }
  if (!reponse.ok || (json && typeof json === 'object' && 'error' in (json as Record<string, unknown>))) {
    throw classifyGraphError(reponse.status, json);
  }
  return (json ?? {}) as T;
}

/* ------------------------------- OAuth ---------------------------------- */

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  /** Secondes. Absent pour certains jetons (système, page). */
  expires_in?: number;
}

/**
 * Échange un code d'autorisation contre un jeton utilisateur.
 *
 * `redirectUri` est obligatoire pour la boîte de dialogue par redirection et
 * DOIT être identique à celle de la demande. Pour Embedded Signup (SDK),
 * Meta exige une valeur vide : on l'omet.
 */
export async function exchangeCode(
  input: { appId: string; appSecret: string; code: string; redirectUri?: string },
  deps: GraphDeps = {},
): Promise<TokenResponse> {
  const query: Record<string, string> = {
    client_id: input.appId,
    client_secret: input.appSecret,
    code: input.code,
  };
  if (input.redirectUri !== undefined) query.redirect_uri = input.redirectUri;
  const r = await graphFetch<TokenResponse>({ path: 'oauth/access_token', query }, deps);
  if (!r.access_token) throw new MetaError('bad_response', 'Meta n’a pas rendu de jeton.');
  return r;
}

/** Jeton court (≈ 1 h) → jeton long (≈ 60 jours). */
export async function exchangeLongLived(
  input: { appId: string; appSecret: string; token: string },
  deps: GraphDeps = {},
): Promise<TokenResponse> {
  const r = await graphFetch<TokenResponse>({
    path: 'oauth/access_token',
    query: {
      grant_type: 'fb_exchange_token',
      client_id: input.appId,
      client_secret: input.appSecret,
      fb_exchange_token: input.token,
    },
  }, deps);
  if (!r.access_token) throw new MetaError('bad_response', 'Meta n’a pas rendu de jeton long.');
  return r;
}

export interface DebugTokenData {
  app_id?: string;
  is_valid?: boolean;
  expires_at?: number;
  data_access_expires_at?: number;
  scopes?: string[];
  granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
  user_id?: string;
  type?: string;
}

/** Inspecte un jeton avec le jeton d'application (`app_id|app_secret`). */
export async function debugToken(
  input: { appId: string; appSecret: string; token: string },
  deps: GraphDeps = {},
): Promise<DebugTokenData> {
  const r = await graphFetch<{ data?: DebugTokenData }>({
    path: 'debug_token',
    query: { input_token: input.token },
    token: `${input.appId}|${input.appSecret}`,
  }, deps);
  return r.data ?? {};
}

/** Révoque toutes les autorisations accordées à l'application par cet utilisateur. */
export async function revokePermissions(token: string, deps: GraphDeps = {}): Promise<boolean> {
  const r = await graphFetch<{ success?: boolean }>({ method: 'DELETE', path: 'me/permissions', token }, deps);
  return r.success === true;
}

/* ------------------------------ Facebook --------------------------------- */

export interface GraphPage {
  id: string;
  name: string;
  category?: string;
  access_token?: string;
  tasks?: string[];
  instagram_business_account?: { id: string };
}

export async function listPages(userToken: string, deps: GraphDeps = {}): Promise<GraphPage[]> {
  const pages: GraphPage[] = [];
  let after: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const r = await graphFetch<{ data?: GraphPage[]; paging?: { cursors?: { after?: string }; next?: string } }>({
      path: 'me/accounts',
      query: { fields: 'id,name,category,access_token,tasks,instagram_business_account', limit: 100, after },
      token: userToken,
    }, deps);
    pages.push(...(r.data ?? []));
    if (!r.paging?.next || !r.paging.cursors?.after) break;
    after = r.paging.cursors.after;
  }
  return pages;
}

export async function me(token: string, deps: GraphDeps = {}): Promise<{ id: string; name?: string }> {
  return graphFetch<{ id: string; name?: string }>({ path: 'me', query: { fields: 'id,name' }, token }, deps);
}

/** Abonne l'application aux champs Webhook d'une page (jeton de page requis). */
export async function subscribePage(pageId: string, pageToken: string, fields: readonly string[], deps: GraphDeps = {}): Promise<boolean> {
  const r = await graphFetch<{ success?: boolean }>({
    method: 'POST',
    path: `${pageId}/subscribed_apps`,
    query: { subscribed_fields: fields.join(',') },
    token: pageToken,
  }, deps);
  return r.success === true;
}

export async function publishPagePost(
  pageId: string,
  pageToken: string,
  post: { message: string; link?: string; published?: boolean; scheduledPublishTime?: number },
  deps: GraphDeps = {},
): Promise<{ id: string }> {
  const body: Record<string, unknown> = { message: post.message };
  if (post.link) body.link = post.link;
  if (post.published === false) body.published = false;
  if (post.scheduledPublishTime) {
    body.published = false;
    body.scheduled_publish_time = post.scheduledPublishTime;
  }
  const r = await graphFetch<{ id?: string; post_id?: string }>({ method: 'POST', path: `${pageId}/feed`, body, token: pageToken }, deps);
  const id = r.id ?? r.post_id;
  if (!id) throw new MetaError('bad_response', 'Meta n’a pas confirmé la publication.');
  return { id };
}

export interface GraphPost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  is_published?: boolean;
}

export async function listPagePosts(pageId: string, pageToken: string, limit = 25, deps: GraphDeps = {}): Promise<GraphPost[]> {
  const r = await graphFetch<{ data?: GraphPost[] }>({
    path: `${pageId}/posts`,
    query: { fields: 'id,message,created_time,permalink_url,is_published', limit },
    token: pageToken,
  }, deps);
  return r.data ?? [];
}

export async function deletePagePost(postId: string, pageToken: string, deps: GraphDeps = {}): Promise<boolean> {
  const r = await graphFetch<{ success?: boolean }>({ method: 'DELETE', path: postId, token: pageToken }, deps);
  return r.success === true;
}

export interface GraphInsight {
  name: string;
  period: string;
  values: Array<{ value: number | Record<string, number>; end_time?: string }>;
  title?: string;
}

export async function pageInsights(pageId: string, pageToken: string, deps: GraphDeps = {}): Promise<GraphInsight[]> {
  const r = await graphFetch<{ data?: GraphInsight[] }>({
    path: `${pageId}/insights`,
    query: { metric: 'page_impressions,page_post_engagements,page_fans', period: 'day' },
    token: pageToken,
  }, deps);
  return r.data ?? [];
}

export interface GraphComment {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id: string; name?: string };
}

export async function listPostComments(postId: string, pageToken: string, deps: GraphDeps = {}): Promise<GraphComment[]> {
  const r = await graphFetch<{ data?: GraphComment[] }>({
    path: `${postId}/comments`,
    query: { fields: 'id,message,created_time,from', limit: 50 },
    token: pageToken,
  }, deps);
  return r.data ?? [];
}

/* ------------------------------ Messenger -------------------------------- */

export async function sendMessengerText(
  pageId: string,
  pageToken: string,
  input: { recipientId: string; text: string },
  deps: GraphDeps = {},
): Promise<{ messageId: string }> {
  const r = await graphFetch<{ message_id?: string }>({
    method: 'POST',
    path: `${pageId}/messages`,
    body: { recipient: { id: input.recipientId }, messaging_type: 'RESPONSE', message: { text: input.text } },
    token: pageToken,
  }, deps);
  if (!r.message_id) throw new MetaError('bad_response', 'Meta n’a pas confirmé l’envoi.');
  return { messageId: r.message_id };
}

/* ------------------------------ WhatsApp --------------------------------- */

export interface WabaInfo {
  id: string;
  name?: string;
  currency?: string;
  timezone_id?: string;
  message_template_namespace?: string;
  account_review_status?: string;
}

export async function getWaba(wabaId: string, token: string, deps: GraphDeps = {}): Promise<WabaInfo> {
  return graphFetch<WabaInfo>({
    path: wabaId,
    query: { fields: 'id,name,currency,timezone_id,message_template_namespace,account_review_status' },
    token,
  }, deps);
}

export interface WabaPhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  platform_type?: string;
}

export async function listPhoneNumbers(wabaId: string, token: string, deps: GraphDeps = {}): Promise<WabaPhoneNumber[]> {
  const r = await graphFetch<{ data?: WabaPhoneNumber[] }>({
    path: `${wabaId}/phone_numbers`,
    query: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type' },
    token,
  }, deps);
  return r.data ?? [];
}

/** Abonne l'application aux Webhooks du compte WhatsApp Business. */
export async function subscribeWaba(wabaId: string, token: string, deps: GraphDeps = {}): Promise<boolean> {
  const r = await graphFetch<{ success?: boolean }>({ method: 'POST', path: `${wabaId}/subscribed_apps`, token }, deps);
  return r.success === true;
}

/**
 * Enregistre le numéro pour l'API Cloud. Le code PIN à 6 chiffres active la
 * vérification en deux étapes : il est généré côté serveur et conservé dans
 * Vault, jamais affiché.
 */
export async function registerPhoneNumber(phoneNumberId: string, token: string, pin: string, deps: GraphDeps = {}): Promise<boolean> {
  const r = await graphFetch<{ success?: boolean }>({
    method: 'POST',
    path: `${phoneNumberId}/register`,
    body: { messaging_product: 'whatsapp', pin },
    token,
  }, deps);
  return r.success === true;
}

export interface WhatsAppSendInput {
  to: string;
  text?: string;
  template?: { name: string; language: string; components?: unknown[] };
}

export async function sendWhatsAppMessage(
  phoneNumberId: string,
  token: string,
  input: WhatsAppSendInput,
  deps: GraphDeps = {},
): Promise<{ messageId: string; waId: string | null }> {
  const body: Record<string, unknown> = { messaging_product: 'whatsapp', recipient_type: 'individual', to: input.to };
  if (input.template) {
    body.type = 'template';
    body.template = {
      name: input.template.name,
      language: { code: input.template.language },
      ...(input.template.components ? { components: input.template.components } : {}),
    };
  } else {
    body.type = 'text';
    body.text = { preview_url: false, body: input.text ?? '' };
  }
  const r = await graphFetch<{ messages?: Array<{ id: string }>; contacts?: Array<{ wa_id?: string }> }>({
    method: 'POST',
    path: `${phoneNumberId}/messages`,
    body,
    token,
  }, deps);
  const id = r.messages?.[0]?.id;
  if (!id) throw new MetaError('bad_response', 'Meta n’a pas confirmé l’envoi WhatsApp.');
  return { messageId: id, waId: r.contacts?.[0]?.wa_id ?? null };
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: unknown[];
}

export async function listTemplates(wabaId: string, token: string, deps: GraphDeps = {}): Promise<WhatsAppTemplate[]> {
  const r = await graphFetch<{ data?: WhatsAppTemplate[] }>({
    path: `${wabaId}/message_templates`,
    query: { fields: 'id,name,language,status,category,components', limit: 100 },
    token,
  }, deps);
  return r.data ?? [];
}

export async function createTemplate(
  wabaId: string,
  token: string,
  template: { name: string; language: string; category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'; components: unknown[] },
  deps: GraphDeps = {},
): Promise<{ id: string; status: string }> {
  const r = await graphFetch<{ id?: string; status?: string }>({
    method: 'POST',
    path: `${wabaId}/message_templates`,
    body: template,
    token,
  }, deps);
  if (!r.id) throw new MetaError('bad_response', 'Meta n’a pas confirmé la création du modèle.');
  return { id: r.id, status: r.status ?? 'PENDING' };
}

export async function deleteTemplate(wabaId: string, token: string, name: string, deps: GraphDeps = {}): Promise<boolean> {
  const r = await graphFetch<{ success?: boolean }>({ method: 'DELETE', path: `${wabaId}/message_templates`, query: { name }, token }, deps);
  return r.success === true;
}

/* ------------------------------ Instagram -------------------------------- */

export interface InstagramAccount {
  id: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
  followers_count?: number;
  media_count?: number;
}

export async function getInstagramAccount(igId: string, pageToken: string, deps: GraphDeps = {}): Promise<InstagramAccount> {
  return graphFetch<InstagramAccount>({
    path: igId,
    query: { fields: 'id,username,name,profile_picture_url,followers_count,media_count' },
    token: pageToken,
  }, deps);
}

/** Publication image en deux temps : conteneur puis publication. */
export async function publishInstagramImage(
  igId: string,
  pageToken: string,
  input: { imageUrl: string; caption?: string },
  deps: GraphDeps = {},
): Promise<{ mediaId: string }> {
  const conteneur = await graphFetch<{ id?: string }>({
    method: 'POST',
    path: `${igId}/media`,
    body: { image_url: input.imageUrl, caption: input.caption ?? '' },
    token: pageToken,
  }, deps);
  if (!conteneur.id) throw new MetaError('bad_response', 'Meta n’a pas créé le conteneur média.');
  const publie = await graphFetch<{ id?: string }>({
    method: 'POST',
    path: `${igId}/media_publish`,
    body: { creation_id: conteneur.id },
    token: pageToken,
  }, deps);
  if (!publie.id) throw new MetaError('bad_response', 'Meta n’a pas confirmé la publication Instagram.');
  return { mediaId: publie.id };
}

export async function instagramInsights(igId: string, pageToken: string, deps: GraphDeps = {}): Promise<GraphInsight[]> {
  const r = await graphFetch<{ data?: GraphInsight[] }>({
    path: `${igId}/insights`,
    query: { metric: 'impressions,reach,profile_views', period: 'day' },
    token: pageToken,
  }, deps);
  return r.data ?? [];
}
