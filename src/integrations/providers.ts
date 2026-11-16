// VYORA Connect — registre des fournisseurs externes.
//
// Ce fichier est la SOURCE DE VÉRITÉ de ce que l'interface a le droit
// d'afficher. Il ne décrit pas une intention, il décrit un état vérifiable.
//
// ## Principe cardinal : aucun état supposé
// Un fournisseur n'est `ready` que si ses identifiants sont réellement
// configurés côté serveur. L'interface ne devine jamais : elle reçoit l'état
// depuis `provider_status()`, lui-même calculé sans exposer aucun secret.
//
// ## Pourquoi quatre états et pas deux
// - `ready`          : identifiants présents, le bouton « Connecter » fonctionne.
// - `needs_setup`    : le code existe mais les identifiants manquent. Bouton
//                      désactivé, avec la raison exacte. C'est le cas des trois
//                      fournisseurs Google aujourd'hui.
// - `awaiting_review`: dépend d'une autorisation externe (Meta, TikTok, Google
//                      audit). Aucun bouton, même désactivé : il n'y a rien à
//                      cliquer tant que le fournisseur n'a pas approuvé.
// - `unavailable`    : non implémenté côté VYORA. Affiché pour information.
//
// Confondre `needs_setup` et `awaiting_review` serait trompeur : le premier
// dépend de nous, le second d'un tiers. L'utilisateur n'a pas la même action.

/** Capacités fermées, identiques à la contrainte SQL `oauth_accounts`. */
export type OAuthCapability = 'read' | 'draft' | 'send' | 'modify';

/** Fournisseurs réellement implémentés dans `vyora-oauth`. */
export type OAuthProviderKey = 'gmail' | 'google_drive' | 'google_calendar';

export type ProviderStatus = 'ready' | 'needs_setup' | 'awaiting_review' | 'unavailable';

export type ProviderGroup = 'google' | 'social' | 'messaging';

export interface CapabilityDefinition {
  readonly id: OAuthCapability;
  /** Libellé tourné vers l'action concrète, pas le jargon OAuth. */
  readonly label: string;
  readonly description: string;
  /** Risque pour l'utilisateur : sert à ordonner les avertissements. */
  readonly risk: 'low' | 'medium' | 'high';
}

/**
 * Les quatre capacités, dans l'ordre de moindre privilège.
 * Une capacité n'est jamais impliquée par une autre : `draft` ne donne pas
 * `send`. C'est vérifié à la fois ici (interface) et dans l'Edge Function.
 */
export const CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    id: 'read',
    label: 'Lire',
    description: 'Consulter les messages, fichiers ou événements existants.',
    risk: 'low',
  },
  {
    id: 'draft',
    label: 'Rédiger',
    description: 'Créer des brouillons sans jamais les envoyer.',
    risk: 'medium',
  },
  {
    id: 'send',
    label: 'Envoyer',
    description: 'Envoyer des messages en votre nom. Action irréversible.',
    risk: 'high',
  },
  {
    id: 'modify',
    label: 'Modifier',
    description: 'Étiqueter, déplacer ou modifier des éléments existants.',
    risk: 'medium',
  },
];

export function capabilityLabel(id: string): string {
  return CAPABILITIES.find((capability) => capability.id === id)?.label ?? id;
}

export function capabilityRisk(id: string): CapabilityDefinition['risk'] {
  return CAPABILITIES.find((capability) => capability.id === id)?.risk ?? 'low';
}

/** Ce que l'utilisateur doit savoir avant d'autoriser, par fournisseur. */
export interface ProviderDefinition {
  readonly id: string;
  readonly name: string;
  readonly group: ProviderGroup;
  /** `true` = le flux OAuth est réellement câblé dans `vyora-oauth`. */
  readonly implemented: boolean;
  /** Capacités proposables. Vide si non implémenté. */
  readonly capabilities: readonly OAuthCapability[];
  /** Ce que VYORA fera réellement avec ces accès, en une phrase. */
  readonly purpose: string;
  /** Pourquoi le fournisseur n'est pas disponible aujourd'hui. */
  readonly blocker: string | null;
  /** Clé de secret serveur attendue (nom seul, jamais la valeur). */
  readonly requiredSecrets: readonly string[];
  /** Variable d'état quand `implemented` est vrai. */
  readonly providerKey: OAuthProviderKey | null;
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    group: 'google',
    implemented: true,
    capabilities: ['read', 'draft', 'send', 'modify'],
    purpose: 'Lire vos e-mails, préparer des brouillons et envoyer des réponses.',
    blocker: 'Identifiants OAuth Google non configurés sur le serveur.',
    requiredSecrets: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    providerKey: 'gmail',
  },
  {
    id: 'google_drive',
    name: 'Google Drive',
    group: 'google',
    implemented: true,
    capabilities: ['read', 'modify'],
    purpose: 'Accéder à vos fichiers et en enregistrer de nouveaux.',
    blocker: 'Identifiants OAuth Google non configurés sur le serveur.',
    requiredSecrets: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    providerKey: 'google_drive',
  },
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    group: 'google',
    implemented: true,
    capabilities: ['read', 'modify'],
    purpose: 'Consulter votre agenda et y créer des événements.',
    blocker: 'Identifiants OAuth Google non configurés sur le serveur.',
    requiredSecrets: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    providerKey: 'google_calendar',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    group: 'social',
    implemented: false,
    capabilities: [],
    purpose: 'Publier vos créations et suivre leurs performances.',
    blocker:
      'Nécessite une application Meta approuvée (révision App Review) et un compte professionnel.',
    requiredSecrets: [],
    providerKey: null,
  },
  {
    id: 'facebook',
    name: 'Facebook',
    group: 'social',
    implemented: false,
    capabilities: [],
    purpose: 'Publier sur vos pages et lire les statistiques.',
    blocker:
      'Nécessite une application Meta approuvée (révision App Review) et les autorisations de page.',
    requiredSecrets: [],
    providerKey: null,
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    group: 'social',
    implemented: false,
    capabilities: [],
    purpose: 'Publier vos vidéos et suivre leur audience.',
    blocker:
      'Accès API TikTok soumis à l’éligibilité de l’application et à une autorisation explicite.',
    requiredSecrets: [],
    providerKey: null,
  },
  {
    id: 'youtube',
    name: 'YouTube',
    group: 'social',
    implemented: false,
    capabilities: [],
    purpose: 'Mettre en ligne vos vidéos et lire leurs statistiques.',
    blocker:
      'Nécessite un audit Google des scopes YouTube avant toute publication automatisée.',
    requiredSecrets: [],
    providerKey: null,
  },
  {
    id: 'whatsapp_business',
    name: 'WhatsApp Business',
    group: 'messaging',
    implemented: false,
    capabilities: [],
    purpose: 'Échanger avec vos clients depuis un numéro professionnel.',
    blocker:
      'Nécessite un compte WhatsApp Business vérifié et un numéro dédié approuvé par Meta.',
    requiredSecrets: [],
    providerKey: null,
  },
];

export function providerById(id: string): ProviderDefinition | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * État réel d'un fournisseur.
 *
 * `configured` vient du serveur (`provider_status`), jamais d'une supposition
 * côté navigateur. Un fournisseur non implémenté est TOUJOURS bloqué, même si
 * des identifiants traînaient : il n'y a pas de code pour les utiliser.
 */
export function statusOf(provider: ProviderDefinition, configured: boolean): ProviderStatus {
  if (!provider.implemented) return 'awaiting_review';
  return configured ? 'ready' : 'needs_setup';
}

export const STATUS_LABELS: Record<ProviderStatus, string> = {
  ready: 'Disponible',
  needs_setup: 'Configuration requise',
  awaiting_review: 'Autorisation fournisseur',
  unavailable: 'Indisponible',
};

/** Un bouton « Connecter » n'existe que si un flux réel peut aboutir. */
export function canConnect(status: ProviderStatus): boolean {
  return status === 'ready';
}

export interface ProviderCardViewModel {
  readonly provider: ProviderDefinition;
  readonly status: ProviderStatus;
  readonly statusLabel: string;
  readonly actionable: boolean;
  /** Raison affichée à l'utilisateur, jamais un message technique brut. */
  readonly reason: string;
}

export function buildProviderCard(
  provider: ProviderDefinition,
  configured: boolean,
): ProviderCardViewModel {
  const status = statusOf(provider, configured);
  return {
    provider,
    status,
    statusLabel: STATUS_LABELS[status],
    actionable: canConnect(status),
    reason:
      status === 'ready'
        ? provider.purpose
        : status === 'needs_setup'
          ? (provider.blocker ?? 'Configuration serveur incomplète.')
          : (provider.blocker ?? 'Ce fournisseur n’est pas encore disponible.'),
  };
}

/** Groupes affichés, dans l'ordre où ils apparaissent dans l'interface. */
export const GROUP_LABELS: Record<ProviderGroup, string> = {
  google: 'Google Workspace',
  social: 'Réseaux sociaux',
  messaging: 'Messagerie',
};

export function groupProviders(
  cards: readonly ProviderCardViewModel[],
): Array<{ group: ProviderGroup; label: string; items: ProviderCardViewModel[] }> {
  const order: ProviderGroup[] = ['google', 'social', 'messaging'];
  return order
    .map((group) => ({
      group,
      label: GROUP_LABELS[group],
      items: cards.filter((card) => card.provider.group === group),
    }))
    .filter((section) => section.items.length > 0);
}

/* -------------------------------------------------------------------------- */
/* Vues dérivées — transformations pures, sans accès réseau ni DOM            */
/* -------------------------------------------------------------------------- */

/**
 * Compte connecté, prêt à l'affichage.
 *
 * Les libellés de date sont calculés ici plutôt que dans le composant : cela
 * garde les composants purement présentationnels et rend le formatage testable
 * sans rendu.
 */
export interface ConnectedAccountView {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly capabilities: readonly string[];
  readonly status: 'pending' | 'connected' | 'expired' | 'revoked' | 'error';
  readonly statusLabel: string;
  readonly lastError: string | null;
  readonly lastVerifiedLabel: string;
  readonly createdLabel: string;
}

const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  connected: 'Connecté',
  pending: 'En attente',
  expired: 'Autorisation expirée',
  revoked: 'Déconnecté',
  error: 'Erreur',
};

export function accountStatusLabel(status: string): string {
  return ACCOUNT_STATUS_LABELS[status] ?? status;
}

/** Interface minimale attendue : évite un import circulaire avec connect-api. */
export interface RawAccount {
  readonly id: string;
  readonly provider: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly capabilities: readonly string[];
  readonly status: 'pending' | 'connected' | 'expired' | 'revoked' | 'error';
  readonly last_verified_at: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
}

/** Nom lisible d'un fournisseur, même inconnu du registre. */
export function providerName(id: string): string {
  return providerById(id)?.name ?? id;
}

export function toAccountView(
  account: RawAccount,
  formatRelative: (value: string | null | undefined) => string,
  formatAbsolute: (value: string | null | undefined) => string,
): ConnectedAccountView {
  return {
    id: account.id,
    providerId: account.provider,
    providerName: providerName(account.provider),
    email: account.email,
    displayName: account.display_name,
    capabilities: account.capabilities,
    status: account.status,
    statusLabel: accountStatusLabel(account.status),
    lastError: account.last_error,
    lastVerifiedLabel: formatRelative(account.last_verified_at),
    createdLabel: formatAbsolute(account.created_at),
  };
}

/** Un compte révoqué reste visible mais n'est plus actif : on le signale. */
export function isActiveAccount(account: { status: string }): boolean {
  return account.status === 'connected' || account.status === 'expired' || account.status === 'error';
}

/** Comptes réellement utilisables pour au moins une action. */
export function usableAccounts<T extends { status: string }>(accounts: readonly T[]): T[] {
  return accounts.filter((account) => account.status === 'connected');
}

/* ------------------------- Journal des événements ------------------------ */

export type AuditTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface AuditEventView {
  readonly id: number;
  readonly providerName: string | null;
  readonly actionLabel: string;
  readonly tone: AuditTone;
  readonly capabilityLabel: string | null;
  readonly detail: string | null;
  readonly dateLabel: string;
}

const ACTION_LABELS: Record<string, { label: string; tone: AuditTone }> = {
  connect_start: { label: 'Connexion démarrée', tone: 'neutral' },
  connect_success: { label: 'Compte connecté', tone: 'success' },
  connect_failure: { label: 'Connexion échouée', tone: 'danger' },
  token_refresh: { label: 'Autorisation renouvelée', tone: 'success' },
  token_refresh_failure: { label: 'Renouvellement échoué', tone: 'danger' },
  revoke: { label: 'Compte déconnecté', tone: 'warning' },
  read: { label: 'Lecture', tone: 'neutral' },
  draft: { label: 'Brouillon créé', tone: 'neutral' },
  send: { label: 'Message envoyé', tone: 'warning' },
  modify: { label: 'Modification', tone: 'warning' },
  denied: { label: 'Action refusée', tone: 'danger' },
};

export function auditActionLabel(action: string): { label: string; tone: AuditTone } {
  return ACTION_LABELS[action] ?? { label: action.replace(/_/g, ' '), tone: 'neutral' };
}

export interface RawAuditEvent {
  readonly id: number;
  readonly provider: string | null;
  readonly action: string;
  readonly capability: string | null;
  readonly outcome: 'ok' | 'denied' | 'error';
  readonly detail: string | null;
  readonly created_at: string;
}

export function toAuditView(
  event: RawAuditEvent,
  formatRelative: (value: string | null | undefined) => string,
): AuditEventView {
  const { label, tone } = auditActionLabel(event.action);
  return {
    id: event.id,
    providerName: event.provider ? providerName(event.provider) : null,
    actionLabel: label,
    // Un refus explicite prime sur la tonalité nominale de l'action.
    tone: event.outcome === 'error' ? 'danger' : event.outcome === 'denied' ? 'danger' : tone,
    capabilityLabel: event.capability ? capabilityLabel(event.capability) : null,
    detail: event.detail,
    dateLabel: formatRelative(event.created_at),
  };
}
