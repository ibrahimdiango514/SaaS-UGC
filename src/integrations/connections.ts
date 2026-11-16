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
  | 'unavailable';

export const STATUS_LABELS: Record<IntegrationStatus, string> = {
  connected: 'Connecté',
  expired: 'Connexion expirée',
  revoked: 'Accès révoqué',
  error: 'Erreur de connexion',
  not_connected: 'Non connecté',
  needs_config: 'Configuration requise',
  needs_approval: 'Validation externe requise',
  unavailable: 'Indisponible',
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

/** Entrée d'audit, telle que le rend `oauth_audit_list()`. */
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
export function deriveStatus(
  entry: IntegrationEntry,
  accounts: ConnectedAccount[],
  engineImplemented: boolean,
): IntegrationStatus {
  const comptes = accounts.filter((a) => normalizeProvider(a.provider) === normalizeProvider(entry.id));
  if (comptes.length > 0) {
    const prioritaire = comptes.find((a) => a.status === 'connected')
      ?? comptes.find((a) => a.status === 'error')
      ?? comptes[0];
    if (prioritaire.status === 'connected') return 'connected';
    if (prioritaire.status === 'expired') return 'expired';
    if (prioritaire.status === 'revoked') return 'revoked';
    return 'error';
  }

  if (!engineImplemented) {
    // Aucun connecteur écrit : on distingue la cause plutôt que d'afficher un
    // « non connecté » qui laisserait croire qu'un clic suffirait.
    const aUneApprobation = entry.auth.some((a) => a.externalApproval)
      || PROVIDERS_WITH_EXTERNAL_APPROVAL.has(entry.id);
    return aUneApprobation ? 'needs_approval' : 'needs_config';
  }

  // Un connecteur existe : l'utilisateur peut lancer la connexion. Si les
  // identifiants serveur manquent, c'est le moteur qui le dira à l'exécution
  // (fail-closed) — on ne prétend pas ici savoir si le projet est configuré.
  return 'not_connected';
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
): Record<IntegrationStatus, number> {
  const base: Record<IntegrationStatus, number> = {
    connected: 0, expired: 0, revoked: 0, error: 0,
    not_connected: 0, needs_config: 0, needs_approval: 0, unavailable: 0,
  };
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
