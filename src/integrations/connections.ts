/**
 * VYORA — état réel des connexions.
 *
 * ## Principe : l'état vient d'une source, il n'est pas déclaré
 *
 * Ce module ne décide jamais qu'une intégration est « connectée ». Il lit les
 * comptes OAuth réellement présents en base, via `oauth_list_accounts()`, qui
 * est une fonction `security definer` filtrant sur `auth.uid()` : un utilisateur
 * ne peut pas voir les comptes d'un autre, même en manipulant la requête.
 *
 * Si la lecture échoue, on rend une erreur — pas un état vide trompeur, et
 * surtout pas un « connecté » par défaut.
 *
 * ## Ce qui n'existe pas encore
 *
 * Aucun connecteur n'est écrit (Livraison 3). Les comptes lus ici proviennent
 * donc uniquement du socle Google déjà déployé. Les autres fournisseurs
 * apparaissent « Configuration requise » ou « Validation externe requise »,
 * jamais « connecté ».
 */
import { supabase } from '../lib/supabase';
import type { BusinessIntegrationConnection } from '../business/api';
import type { CatalogCategory, IntegrationEntry } from './catalog';

/** Statut affiché sur une fiche, dérivé — jamais saisi. */
export type IntegrationStatus =
  | 'connected'
  | 'expired'
  | 'revoked'
  | 'error'
  | 'not_connected'
  | 'needs_config'
  | 'needs_approval'
  | 'unavailable'
  /** Demande d'activation enregistrée, en attente de traitement. */
  | 'requested'
  /**
   * Une ligne `connected` existe dans `integration_connections`, mais aucun
   * compte OAuth vérifié ne la soutient : l'autorisation chez le fournisseur
   * n'a jamais été obtenue. C'est le cas le plus important à ne pas maquiller.
   */
  | 'authorization_missing';

export const STATUS_LABELS: Record<IntegrationStatus, string> = {
  connected: 'Connecté',
  expired: 'Connexion expirée',
  revoked: 'Accès révoqué',
  error: 'Erreur de connexion',
  not_connected: 'Non connecté',
  needs_config: 'Configuration requise',
  needs_approval: 'Validation externe requise',
  unavailable: 'Indisponible',
  requested: 'Activation demandée',
  authorization_missing: 'Autorisation manquante',
};

export const STATUS_TONE: Record<IntegrationStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  connected: 'success',
  expired: 'warning',
  revoked: 'danger',
  error: 'danger',
  not_connected: 'neutral',
  needs_config: 'warning',
  needs_approval: 'warning',
  unavailable: 'neutral',
  requested: 'warning',
  authorization_missing: 'danger',
};

/** Compte connecté, tel que le rend `oauth_list_accounts()`. */
export interface ConnectedAccount {
  id: string;
  provider: string;
  externalAccountId: string | null;
  displayName: string | null;
  email: string | null;
  capabilities: string[];
  status: string;
  lastVerifiedAt: string | null;
  lastError: string | null;
  createdAt: string | null;
}

/**
 * Demande d'activation, telle que la rend `integrations.list` du socle
 * Business Grow (`saas_business.bg_list_scoped_integration_connections`).
 *
 * `external_account_ref` vaut `null` pour une simple demande : aucune
 * autorisation fournisseur n'a été obtenue. C'est ce champ qui distingue une
 * demande d'une connexion réellement établie.
 */
export interface ActivationRequest {
  connectorKey: string;
  status: 'unconfigured' | 'pending' | 'connected' | 'disconnected' | 'error';
  externalAccountRef: string | null;
  updatedAt: string;
}

/**
 * Lit les demandes d'activation de l'entreprise active.
 *
 * Passe par `businessGrowApi` : la RLS et les fonctions `security definer`
 * filtrant sur `p_user_id` restent seules juges. Sans entreprise active, on
 * renvoie une liste vide — les demandes sont toujours scopées.
 */
export async function listActivationRequests(
  workspaceId: string | null,
  api: { listIntegrations: (workspaceId?: string | null) => Promise<{ connections: BusinessIntegrationConnection[] }> },
): Promise<BusinessIntegrationConnection[]> {
  if (!workspaceId) return [];
  const { connections } = await api.listIntegrations(workspaceId);
  return connections ?? [];
}

/**
 * Normalise des lignes brutes vers la forme lue par `deriveStatus`.
 *
 * La distinction essentielle est `externalAccountRef` : `null` signifie
 * qu'aucun compte externe n'est rattaché, donc qu'il n'existe aucune preuve
 * d'autorisation, même si `status` vaut `connected`.
 */
export function toActivationRequests(rows: BusinessIntegrationConnection[]): ActivationRequest[] {
  return rows.map((row) => ({
    connectorKey: String(row.connector_key ?? ''),
    status: row.status ?? 'unconfigured',
    externalAccountRef: row.external_account_ref ?? null,
    updatedAt: String(row.updated_at ?? ''),
  }));
}

/**
 * Fournisseurs pour lesquels le socle accepte une demande d'activation.
 *
 * Source de vérité : `saas_business.bg_validate_connector_key`, qui lève
 * `invalid connector key` pour toute autre valeur. Afficher un bouton de
 * demande sur un fournisseur absent de cette liste produirait une erreur
 * serveur garantie : on ne le propose donc pas.
 *
 * Cette liste s'élargira en même temps que les connecteurs réels
 * (Livraison 3), pas avant.
 */
export const CONNECTORS_ACCEPTING_REQUESTS: ReadonlySet<string> = new Set([
  'facebook', 'instagram', 'youtube', 'tiktok', 'shopify', 'woocommerce',
]);

/** Entrée d'audit, telle que rend `oauth_audit_list()`. */
export interface AuditEntry {
  id: string;
  action: string;
  provider: string | null;
  outcome: string;
  detail: string | null;
  createdAt: string;
}

/**
 * Fournisseurs dont VYORA détient réellement un identifiant côté serveur.
 *
 * Cette liste est une **déclaration de configuration**, pas un état de
 * connexion. Elle est utilisée uniquement pour distinguer « il manque nos
 * identifiants » de « il manque une approbation du fournisseur ».
 *
 * Les valeurs proviennent de variables Edge, jamais du navigateur. On ne peut
 * pas les lire depuis le frontend : ce drapeau est donc une estimation
 * volontairement pessimiste, corrigée côté serveur au moment d'une tentative
 * de connexion.
 */
/** Fournisseurs connus pour exiger une validation externe. */
const PROVIDERS_WITH_EXTERNAL_APPROVAL = new Set([
  'instagram', 'facebook', 'tiktok', 'linkedin', 'microsoft365', 'outlook', 'gmail', 'youtube',
]);

/**
 * Le socle Google déployé stocke un identifiant par service
 * (`gmail`, `google_drive`, `google_calendar` — contrainte CHECK en base).
 * Aucun n'est un alias d'un autre : un compte Drive ne donne pas accès à Gmail.
 * La normalisation consiste donc seulement à passer en minuscules ; elle ne
 * fusionne rien.
 */
export function normalizeProvider(id: string): string {
  return id.trim().toLowerCase();
}

/** Lit les comptes connectés de l'utilisateur. Lève en cas d'échec. */
export async function listConnectedAccounts(): Promise<ConnectedAccount[]> {
  const { data, error } = await supabase.rpc('oauth_list_accounts');
  if (error) throw new Error(error.message || 'Lecture des connexions impossible.');
  const lignes = Array.isArray(data) ? data : [];
  return lignes.map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    provider: String(row.provider ?? ''),
    externalAccountId: (row.external_account_id as string | null) ?? null,
    displayName: (row.display_name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities.map(String) : [],
    status: String(row.status ?? 'unknown'),
    lastVerifiedAt: (row.last_verified_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
  }));
}

/** Journal d'audit des actions OAuth de l'utilisateur. */
export async function listAudit(limit = 50): Promise<AuditEntry[]> {
  const { data, error } = await supabase.rpc('oauth_audit_list', { p_limit: limit });
  if (error) throw new Error(error.message || 'Lecture du journal impossible.');
  const lignes = Array.isArray(data) ? data : [];
  return lignes.map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    action: String(row.action ?? ''),
    provider: (row.provider as string | null) ?? null,
    outcome: String(row.outcome ?? ''),
    detail: (row.detail as string | null) ?? null,
    createdAt: String(row.created_at ?? ''),
  }));
}

/**
 * Révoque une connexion.
 *
 * Passe par `oauth_revoke_account()`, qui vérifie la propriété du compte puis
 * tente une révocation distante chez le fournisseur. Ne supprime pas
 * silencieusement : si la révocation distante échoue, le statut local devient
 * `revoked` avec un motif, et l'appelant le signale à l'utilisateur.
 */
export async function revokeConnection(accountId: string): Promise<{ remoteRevoked: boolean }> {
  const { data, error } = await supabase.rpc('oauth_revoke_account', { p_account_id: accountId });
  if (error) throw new Error(error.message || 'Révocation impossible.');
  const resultat = (data ?? {}) as Record<string, unknown>;
  return { remoteRevoked: Boolean(resultat.remote_revoked ?? resultat.remoteRevoked ?? false) };
}

/**
 * Déduit le statut d'une fiche.
 *
 * Ordre de priorité : un compte réel l'emporte toujours sur une supposition.
 * Ensuite seulement on regarde la configuration et les approbations.
 *
 * `engineImplemented` vient du catalogue (`engine !== null`). Tant qu'aucun
 * connecteur n'existe, une fiche ne peut pas être « non connecté » au sens
 * « vous pouvez cliquer » : elle est « Configuration requise » ou
 * « Validation externe requise ».
 */
/**
 * Dérive le statut affiché d'une fiche.
 *
 * ## L'ordre des sources est la garantie
 *
 * 1. **Compte OAuth réel** — la seule preuve d'une connexion. Prioritaire sur
 *    tout le reste : une demande d'activation ne peut pas masquer un compte
 *    expiré, ni l'inverse.
 * 2. **Demande d'activation** — tracée en base, mais ce n'est pas une
 *    connexion.
 * 3. **Capacité du catalogue** — décrit ce qui manque pour pouvoir connecter.
 *
 * Le cas `authorization_missing` mérite d'être explicité : le socle écrit
 * `status = 'connected'` dans `integration_connections` sur simple demande
 * (`bg_request_scoped_integration_connection`), sans qu'aucun échange OAuth
 * n'ait eu lieu. Croire ce champ sur parole afficherait « Connecté » sans
 * preuve côté fournisseur — exactement ce qui est interdit. On ne le croit donc
 * que s'il est corroboré par un compte OAuth vérifié.
 */
export function deriveStatus(
  entry: IntegrationEntry,
  accounts: ConnectedAccount[],
  engineImplemented: boolean,
  requests: ActivationRequest[] = [],
): IntegrationStatus {
  const cle = normalizeProvider(entry.id);

  // 1. Compte OAuth réel : la seule preuve acceptable.
  const comptes = accounts.filter((a) => normalizeProvider(a.provider) === cle);
  if (comptes.length > 0) {
    const prioritaire = comptes.find((a) => a.status === 'connected')
      ?? comptes.find((a) => a.status === 'error')
      ?? comptes[0];
    if (prioritaire.status === 'connected') return 'connected';
    if (prioritaire.status === 'expired') return 'expired';
    if (prioritaire.status === 'revoked') return 'revoked';
    return 'error';
  }

  // 2. Demande d'activation persistée.
  const demandes = requests.filter((r) => normalizeProvider(r.connectorKey) === cle);
  if (demandes.length > 0) {
    // Une demande n'est « en attente » que tant qu'aucun compte externe n'est
    // rattaché. Sinon le socle prétend une connexion sans preuve OAuth.
    const enAttente = demandes.find((r) => r.status === 'pending' && !r.externalAccountRef);
    if (enAttente) return 'requested';

    const pretendueConnectee = demandes.find((r) => r.status === 'connected');
    if (pretendueConnectee) return 'authorization_missing';

    if (demandes.some((r) => r.status === 'error')) return 'error';
    // `disconnected` / `unconfigured` : rien à signaler de plus que l'absence
    // de connexion, on retombe sur la capacité du catalogue ci-dessous.
  }

  // 3. Ce qui manque pour pouvoir connecter.
  if (!engineImplemented) {
    const aUneApprobation = entry.auth.some((a) => a.externalApproval)
      || PROVIDERS_WITH_EXTERNAL_APPROVAL.has(entry.id);
    return aUneApprobation ? 'needs_approval' : 'needs_config';
  }

  return 'not_connected';
}

/**
 * Une demande d'activation est-elle possible pour ce fournisseur ?
 *
 * Vrai uniquement si le socle l'accepte (`bg_validate_connector_key`) et
 * qu'aucune demande active n'existe déjà. Proposer un bouton que le serveur
 * refuserait serait un faux pas de plus.
 */
export function canRequestActivation(
  entry: IntegrationEntry,
  status: IntegrationStatus,
): boolean {
  if (!CONNECTORS_ACCEPTING_REQUESTS.has(entry.id)) return false;
  return status === 'needs_config' || status === 'needs_approval'
    || status === 'not_connected' || status === 'error';
}

/** Une demande en attente peut-elle être annulée ? */
export function canCancelRequest(status: IntegrationStatus): boolean {
  return status === 'requested';
}

/** Compte associé à une fiche, s'il existe. */
/**
 * Permissions demandées par la fiche mais non accordées par le compte réel.
 *
 * Un utilisateur peut n'accorder qu'une partie des scopes (ou les révoquer
 * depuis le fournisseur). La connexion reste valide — elle n'est pas « en
 * erreur » — mais l'interface doit dire ce qui manque au lieu de laisser
 * croire que toutes les capacités annoncées sont disponibles.
 */
export function missingCapabilities(entry: IntegrationEntry, account: ConnectedAccount | null): string[] {
  if (!account) return [];
  const accordees = new Set(account.capabilities);
  return entry.capabilities.filter((c) => !accordees.has(c));
}

export function accountFor(entry: IntegrationEntry, accounts: ConnectedAccount[]): ConnectedAccount | null {
  return accounts.find((a) => normalizeProvider(a.provider) === normalizeProvider(entry.id)) ?? null;
}

/** Compteur par statut, pour l'en-tête du catalogue. */
export function summarize(
  entries: IntegrationEntry[],
  accounts: ConnectedAccount[],
  /** Statuts déjà dérivés, quand l'appelant en dispose (état inconnu exclu). */
  etatsConnus?: IntegrationStatus[],
): Record<IntegrationStatus, number> {
  const base: Record<IntegrationStatus, number> = {
    connected: 0, expired: 0, revoked: 0, error: 0,
    not_connected: 0, needs_config: 0, needs_approval: 0, unavailable: 0,
    requested: 0, authorization_missing: 0,
  };
  if (etatsConnus) {
    for (const statut of etatsConnus) base[statut] += 1;
    return base;
  }
  for (const entry of entries) {
    base[deriveStatus(entry, accounts, entry.engine !== null)] += 1;
  }
  return base;
}

/** Une fiche peut-elle proposer un bouton « Connecter » actif ? */
export function canConnect(entry: IntegrationEntry, status: IntegrationStatus): boolean {
  if (entry.engine === null) return false;
  return status === 'not_connected' || status === 'expired' || status === 'revoked' || status === 'error';
}

/** Catégories effectivement présentes, pour ne pas afficher d'onglet vide. */
export function presentCategories(entries: IntegrationEntry[]): CatalogCategory[] {
  const vues = new Set<CatalogCategory>();
  for (const entry of entries) vues.add(entry.category);
  return Array.from(vues);
}
