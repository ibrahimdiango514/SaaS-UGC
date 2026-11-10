import type {
  ExternalConnectorPlatform,
  ExternalConnectorSpec,
  ExternalConnectorState,
} from '../contracts';

export interface SocialMetricsSummary {
  platform: 'facebook' | 'instagram' | 'youtube' | 'tiktok';
  periodStart: string;
  periodEnd: string;
  followersCount: number | null;
  reach: number | null;
  impressions: number | null;
  engagementRatePercent: number | null;
  topPosts: Array<{ id: string; title: string; views: number; engagements: number }>;
}

export interface EcommerceCatalogSummary {
  platform: 'shopify' | 'woocommerce';
  periodStart: string;
  periodEnd: string;
  activeProductsCount: number | null;
  ordersCount: number | null;
  grossRevenueMinor: number | null;
  currency: string | null;
  topProducts: Array<{ externalId: string; title: string; unitsSold: number }>;
}

export interface ExternalConnectorAdapter {
  readonly spec: ExternalConnectorSpec;
  isAuthorized(state: ExternalConnectorState | null | undefined): boolean;
  describeMissingPrerequisites(state: ExternalConnectorState | null | undefined): string;
}

export const EXTERNAL_CONNECTOR_CATALOG: ExternalConnectorSpec[] = [
  {
    platform: 'facebook',
    displayName: 'Facebook Pages & Ads',
    category: 'social',
    oauthSupported: false,
    requiredScopes: ['pages_show_list', 'pages_read_engagement', 'ads_read'],
    capabilities: ['lecture_publications', 'statistiques_audience', 'performances_campagnes'],
    documentationNote: 'Interface prête : nécessite l’enregistrement d’une app Meta, OAuth serveur et stockage de jeton chiffré dans Vault.',
  },
  {
    platform: 'instagram',
    displayName: 'Instagram Business',
    category: 'social',
    oauthSupported: false,
    requiredScopes: ['instagram_basic', 'instagram_manage_insights'],
    capabilities: ['lecture_reels_posts', 'portee_engagement', 'croissance_abonnes'],
    documentationNote: 'Interface prête : dépend du flux OAuth Meta Graph et des permissions Business vérifiées.',
  },
  {
    platform: 'youtube',
    displayName: 'YouTube Studio / Data',
    category: 'social',
    oauthSupported: false,
    requiredScopes: ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'],
    capabilities: ['lecture_videos_shorts', 'vues_retention', 'croissance_chaine'],
    documentationNote: 'Interface prête : nécessite client OAuth Google et vérification des scopes YouTube Analytics.',
  },
  {
    platform: 'tiktok',
    displayName: 'TikTok Business',
    category: 'social',
    oauthSupported: false,
    requiredScopes: ['user.info.basic', 'video.list', 'research.data.basic'],
    capabilities: ['lecture_videos', 'vues_taux_completion', 'tendances_hashtags'],
    documentationNote: 'Interface prête : nécessite une app TikTok for Developers approuvée et redirection OAuth HTTPS.',
  },
  {
    platform: 'shopify',
    displayName: 'Shopify Store',
    category: 'ecommerce',
    oauthSupported: false,
    requiredScopes: ['read_products', 'read_orders', 'read_analytics'],
    capabilities: ['synchronisation_catalogue', 'analyse_ventes_produits', 'paniers_commandes'],
    documentationNote: 'Interface prête : nécessite Shopify Partner App, OAuth par boutique (*.myshopify.com) et secret webhook HMAC.',
  },
  {
    platform: 'woocommerce',
    displayName: 'WooCommerce',
    category: 'ecommerce',
    oauthSupported: false,
    requiredScopes: ['read'],
    capabilities: ['synchronisation_catalogue', 'lecture_commandes', 'stock_categories'],
    documentationNote: 'Interface prête : nécessite URL boutique HTTPS + clés REST WooCommerce stockées uniquement côté serveur/Vault.',
  },
];

export function isConnectorAuthorized(state: ExternalConnectorState | null | undefined): boolean {
  if (!state) return false;
  return state.connection_status === 'connected_active' || state.connection_status === 'connected_readonly';
}

export function connectorRequirementMessage(platform: ExternalConnectorPlatform): string {
  const spec = EXTERNAL_CONNECTOR_CATALOG.find((c) => c.platform === platform);
  if (!spec) return 'Connecteur externe non configuré et non autorisé.';
  return `${spec.displayName} n’est pas encore connecté : ${spec.documentationNote}`;
}
