export type IntegrationKind = 'social' | 'commerce';

export type IntegrationConnectionState =
  | 'pending'
  | 'connected'
  | 'expired'
  | 'revoked'
  | 'error';

export type IntegrationCapability =
  | 'account-read'
  | 'content-publish'
  | 'publication-schedule'
  | 'analytics-read'
  | 'catalog-read'
  | 'orders-read';

export interface IntegrationDefinition {
  id: string;
  name: string;
  kind: IntegrationKind;
  proposedCapabilities: readonly IntegrationCapability[];
  authorization: 'oauth2' | 'app-install';
  rollout: 'planned';
  note: string;
}

export interface IntegrationAccount {
  id: string;
  workspaceId: string;
  integrationId: string;
  externalAccountId: string;
  displayName: string | null;
  state: IntegrationConnectionState;
  grantedScopes: string[];
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorizationStartRequest {
  workspaceId: string;
  redirectUri: string;
}

export interface AuthorizationStartResult {
  authorizationUrl: string;
  expiresAt: string;
}

export interface IntegrationSyncResult {
  received: number;
  created: number;
  updated: number;
  skipped: number;
  cursor: string | null;
  completedAt: string;
}

export interface IntegrationAdapter {
  readonly definition: IntegrationDefinition;
  startAuthorization(request: AuthorizationStartRequest): Promise<AuthorizationStartResult>;
  completeAuthorization(input: { code: string; state: string }): Promise<IntegrationAccount>;
  refresh(accountId: string): Promise<IntegrationAccount>;
  disconnect(accountId: string): Promise<void>;
  sync(accountId: string, cursor?: string | null): Promise<IntegrationSyncResult>;
}

export const INTEGRATION_DEFINITIONS: readonly IntegrationDefinition[] = [
  {
    id: 'facebook',
    name: 'Facebook',
    kind: 'social',
    proposedCapabilities: ['account-read', 'content-publish', 'publication-schedule', 'analytics-read'],
    authorization: 'oauth2',
    rollout: 'planned',
    note: 'Connexion Meta officielle et autorisations de page requises.',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    kind: 'social',
    proposedCapabilities: ['account-read', 'content-publish', 'publication-schedule', 'analytics-read'],
    authorization: 'oauth2',
    rollout: 'planned',
    note: 'Compte professionnel et autorisations Meta nécessaires.',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    kind: 'social',
    proposedCapabilities: ['account-read', 'content-publish', 'publication-schedule', 'analytics-read'],
    authorization: 'oauth2',
    rollout: 'planned',
    note: 'OAuth Google et scopes YouTube à approuver.',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    kind: 'social',
    proposedCapabilities: ['account-read', 'content-publish', 'analytics-read'],
    authorization: 'oauth2',
    rollout: 'planned',
    note: 'Accès API TikTok soumis aux autorisations et à l’éligibilité de l’application.',
  },
  {
    id: 'shopify',
    name: 'Shopify',
    kind: 'commerce',
    proposedCapabilities: ['catalog-read', 'orders-read'],
    authorization: 'oauth2',
    rollout: 'planned',
    note: 'Installation OAuth et scopes marchands requis.',
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    kind: 'commerce',
    proposedCapabilities: ['catalog-read', 'orders-read'],
    authorization: 'app-install',
    rollout: 'planned',
    note: 'Connexion serveur signée à configurer; les clés REST ne doivent jamais être exposées au navigateur.',
  },
];

export function isIntegrationConnected(account: IntegrationAccount | null | undefined): boolean {
  return account?.state === 'connected';
}
