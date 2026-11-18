/**
 * VYORA Meta Integrations — relais navigateur → fonction Edge `meta-connect`.
 *
 * ## Rôle
 *
 * Poser les appels, et rien de plus. Aucune décision d'état, aucun jeton, aucun
 * secret : le serveur seul sait ce qui est connecté.
 *
 * ## Ce que ce module ne fera jamais
 *
 * - envoyer au serveur autre chose que des identifiants Meta publics (WABA,
 *   numéro, page) et le `code` d'autorisation à usage unique ;
 * - stocker un jeton, même en mémoire ;
 * - afficher un état « Connecté » : il rend la réponse du serveur, qui vient
 *   d'un échange OAuth réel.
 */
import { invokeEdge } from '../../lib/api';
import { AppError } from '../../lib/errors';
import type { MetaProduct } from '../../business/meta/products';

export type { MetaProduct };

/** Connexion telle que la rend `meta-connect` (action `status`). */
export interface MetaConnectionView {
  id: string;
  product: MetaProduct;
  status: 'connected' | 'expired' | 'revoked' | 'error' | 'disconnected';
  external_account_id: string;
  display_name: string | null;
  granted_scopes: string[];
  token_expires_at: string | null;
  has_token: boolean;
  metadata: Record<string, unknown>;
  last_error: string | null;
  last_verified_at: string | null;
  updated_at: string;
  pages: MetaPageView[];
}

export interface MetaPageView {
  page_id: string;
  name: string;
  category: string | null;
  tasks: string[];
  instagram_business_account_id: string | null;
  instagram_username: string | null;
  webhook_subscribed: boolean;
  has_token: boolean;
}

export interface MetaStatus {
  configured: boolean;
  configIds: Record<MetaProduct, boolean>;
  connections: MetaConnectionView[];
}

/** Lancement d'un parcours serveur : soit Embedded Signup, soit redirection. */
export type MetaStartResult =
  | {
      mode: 'embedded-signup';
      appId: string;
      configId: string;
      state: string;
      graphVersion: string;
      /** Version Embedded Signup à transmettre dans `extras.version`. */
      embeddedSignupVersion: string;
      scopes: string[];
    }
  | { mode: 'redirect'; url: string; scopes: string[] };

export interface MetaPageOption {
  page_id: string;
  name: string;
  category: string | null;
  tasks: string[];
  instagram_business_account_id: string | null;
  can_manage: boolean;
  has_token: boolean;
  selected: boolean;
}

export interface MetaMessage {
  id: string;
  channel: 'whatsapp' | 'messenger' | 'instagram';
  account_ref: string;
  conversation_ref: string;
  external_message_id: string;
  direction: 'in' | 'out';
  message_type: string;
  body: string | null;
  status: string;
  error_code: number | null;
  error_message: string | null;
  sent_at: string;
}

export interface MetaConversation {
  account_ref: string;
  conversation_ref: string;
  last_body: string | null;
  last_direction: 'in' | 'out';
  last_status: string;
  last_at: string;
}

type Call = Record<string, unknown> & { workspaceId: string };

async function call<T>(action: string, payload: Call): Promise<T> {
  const resultat = await invokeEdge<{ data?: T }>('meta-connect', { action, ...payload });
  if (!resultat || typeof resultat !== 'object' || !('data' in resultat)) {
    throw new AppError('Réponse du service de connexion Meta illisible.', 'META_CONNECT_INVALID_RESPONSE');
  }
  return resultat.data as T;
}

/**
 * Démarre un parcours. En mode `redirect`, l'appelant DOIT naviguer vers
 * `url` ; rien n'est connecté tant que Meta n'a pas rappelé `/callback`.
 */
export function startMetaConnect(workspaceId: string, product: MetaProduct): Promise<MetaStartResult> {
  return call<MetaStartResult>('start', { workspaceId, product });
}

/**
 * Fin du parcours WhatsApp Embedded Signup : le SDK a rendu un `code` et les
 * identifiants choisis. Le serveur échange le code, VÉRIFIE que le jeton voit
 * bien ce WABA et ce numéro, puis enregistre. Un `wabaId` ou `phoneNumberId`
 * non vérifiés sont refusés côté serveur — on ne peut pas les inventer ici.
 */
export function finishEmbeddedSignup(
  workspaceId: string,
  input: { state: string; code: string; wabaId: string; phoneNumberId: string },
): Promise<{ connected: boolean; connections: MetaConnectionView[] }> {
  return call('finish-embedded', { workspaceId, ...input });
}

export function readMetaStatus(workspaceId: string, product?: MetaProduct): Promise<MetaStatus> {
  return call<MetaStatus>('status', { workspaceId, product });
}

export function verifyMetaConnection(workspaceId: string, product: MetaProduct) {
  return call<{ valid: boolean; scopes?: string[]; connections: MetaConnectionView[] }>('verify', { workspaceId, product });
}

export function refreshMetaToken(workspaceId: string, product: MetaProduct) {
  return call<{ refreshed: boolean; token_expires_at?: string | null; reason?: string; message?: string }>(
    'refresh',
    { workspaceId, product },
  );
}

export function disconnectMeta(workspaceId: string, product: MetaProduct) {
  return call<{ disconnected: boolean; remoteRevoked: boolean; connections: MetaConnectionView[] }>(
    'disconnect',
    { workspaceId, product },
  );
}

export function listMetaPages(workspaceId: string, product: MetaProduct) {
  return call<{ pages: MetaPageOption[] }>('pages.list', { workspaceId, product });
}

export function selectMetaPages(workspaceId: string, product: MetaProduct, pageIds: string[]) {
  return call<{ selected: number; refused: Array<{ page_id: string; code: string }>; connections: MetaConnectionView[] }>(
    'pages.select',
    { workspaceId, product, pageIds },
  );
}

/* --------------------------------- WhatsApp -------------------------------- */

export function sendWhatsApp(
  workspaceId: string,
  input: { to: string; text?: string; template?: { name: string; language: string } },
) {
  return call<{ messageId: string; to: string }>('whatsapp.send', { workspaceId, ...input });
}

export function listWhatsAppTemplates(workspaceId: string) {
  return call<{ templates: Array<{ id: string; name: string; language: string; status: string; category?: string }> }>(
    'whatsapp.templates',
    { workspaceId },
  );
}

export function createWhatsAppTemplate(
  workspaceId: string,
  input: { name: string; language: string; category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'; body: string },
) {
  return call<{ id: string; status: string }>('whatsapp.template.create', {
    workspaceId,
    name: input.name,
    language: input.language,
    category: input.category,
    components: [{ type: 'BODY', text: input.body }],
  });
}

export function deleteWhatsAppTemplate(workspaceId: string, name: string) {
  return call<{ deleted: boolean }>('whatsapp.template.delete', { workspaceId, name });
}

/* ---------------------------- parcours de test ----------------------------- */

/**
 * État du parcours WhatsApp de test, tel que le serveur le rend.
 *
 * Aucun secret ici : uniquement des identifiants Meta publics (WABA, numéro),
 * un booléen de disponibilité et la connexion éventuelle.
 */
export interface MetaTestFlowState {
  available: boolean;
  reason: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
}

export interface MetaTestFlowStatus {
  testFlow: MetaTestFlowState;
  connection: {
    status: string;
    flow: string | null;
    wabaId: string | null;
    phoneNumberId: string | null;
    displayPhoneNumber: string | null;
    webhookSubscribed: boolean | null;
    lastError: string | null;
  } | null;
}

/**
 * Le serveur décide, le navigateur affiche.
 *
 * Ces trois appels n'envoient AUCUN identifiant Meta : même en modifiant le
 * corps de la requête, le serveur utilise sa propre configuration. Un client
 * non administrateur reçoit 404 et la fiche n'affiche rien de plus.
 */
export function readMetaTestFlow(workspaceId: string) {
  return call<MetaTestFlowStatus>('whatsapp.test.status', { workspaceId });
}

export function connectMetaTestFlow(workspaceId: string) {
  return call<{
    connected: boolean;
    wabaId: string;
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    webhookSubscribed: boolean;
    warning: string | null;
    connections: MetaConnectionView[];
  }>('whatsapp.test.connect', { workspaceId });
}

export function disconnectMetaTestFlow(workspaceId: string) {
  return call<{ disconnected: boolean; connections: MetaConnectionView[] }>(
    'whatsapp.test.disconnect',
    { workspaceId },
  );
}

/* -------------------------------- Messenger -------------------------------- */

export function sendMessenger(workspaceId: string, input: { pageId: string; recipientId: string; text: string }) {
  return call<{ messageId: string }>('messenger.send', { workspaceId, ...input });
}

export function listMetaConversations(
  workspaceId: string,
  channel: 'whatsapp' | 'messenger' | 'instagram',
  accountRef?: string,
) {
  return call<{ conversations: MetaConversation[] }>('conversations.list', { workspaceId, channel, accountRef });
}

export function listMetaMessages(
  workspaceId: string,
  channel: 'whatsapp' | 'messenger' | 'instagram',
  conversationRef: string,
  accountRef?: string,
) {
  return call<{ messages: MetaMessage[] }>('messages.list', { workspaceId, channel, conversationRef, accountRef });
}

/* --------------------------------- Facebook -------------------------------- */

export function publishFacebookPost(workspaceId: string, input: { pageId: string; message: string; link?: string }) {
  return call<{ id: string }>('facebook.publish', { workspaceId, ...input });
}

export function listFacebookPosts(workspaceId: string, pageId: string) {
  return call<{ posts: Array<{ id: string; message?: string; created_time?: string; permalink_url?: string }> }>(
    'facebook.posts',
    { workspaceId, pageId },
  );
}

export function deleteFacebookPost(workspaceId: string, pageId: string, postId: string) {
  return call<{ deleted: boolean }>('facebook.post.delete', { workspaceId, pageId, postId });
}

export function readFacebookInsights(workspaceId: string, pageId: string) {
  return call<{ insights: Array<{ name: string; period: string; values: Array<{ value: unknown }> }> }>(
    'facebook.insights',
    { workspaceId, pageId },
  );
}

export function listFacebookComments(workspaceId: string, pageId: string, postId: string) {
  return call<{ comments: Array<{ id: string; message?: string; created_time?: string; from?: { id: string; name?: string } }> }>(
    'facebook.comments',
    { workspaceId, pageId, postId },
  );
}

export function listMetaPageEvents(workspaceId: string, channel: 'facebook' | 'instagram', pageId?: string) {
  return call<{ events: Array<{ id: number; page_id: string; item: string | null; message: string | null; occurred_at: string }> }>(
    'page.events',
    { workspaceId, channel, pageId },
  );
}

/* -------------------------------- Instagram -------------------------------- */

export function readInstagramAccount(workspaceId: string, pageId: string) {
  return call<{ account: { id: string; username?: string; followers_count?: number; media_count?: number } }>(
    'instagram.account',
    { workspaceId, pageId },
  );
}

export function publishInstagram(workspaceId: string, input: { pageId: string; imageUrl: string; caption?: string }) {
  return call<{ mediaId: string }>('instagram.publish', { workspaceId, ...input });
}

export function readInstagramInsights(workspaceId: string, pageId: string) {
  return call<{ insights: Array<{ name: string; period: string; values: Array<{ value: unknown }> }> }>(
    'instagram.insights',
    { workspaceId, pageId },
  );
}

/** Produit Meta d'une fiche du catalogue (les quatre clés sont identiques). */
export const META_CATALOG_KEYS: readonly MetaProduct[] = ['whatsapp', 'facebook', 'messenger', 'instagram'];

export function isMetaCatalogKey(id: string): id is MetaProduct {
  return (META_CATALOG_KEYS as readonly string[]).includes(id);
}
