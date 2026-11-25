/**
 * Identité technique SORAHNEX — source unique.
 *
 * Un seul endroit décrit :
 *   - les noms de produit réellement affichés ;
 *   - les noms techniques des Edge Functions, dans leur forme héritée
 *     (`vyora-*`, `reelora-*`) et dans leur forme cible (`sorahnex-*`) ;
 *   - les en-têtes internes, buckets et préfixes RPC qui restent, pour
 *     l'instant, sous leur nom historique.
 *
 * Pourquoi deux noms ?
 *
 * Les Edge Functions sont déployées en production sous leur nom historique.
 * Renommer le dossier source ne renomme pas la fonction déployée : un frontend
 * qui appellerait directement `sorahnex-ai` recevrait un 404 tant que la
 * nouvelle fonction n'est pas déployée. La compatibilité transitoire est donc
 * explicite : le code appelle `edgeFunctionName('ai')`, et une seule variable
 * d'environnement bascule tous les appels une fois les nouvelles fonctions
 * déployées.
 *
 *   VITE_SORAHNEX_EDGE_NAMING=legacy     (défaut) → vyora-ai, reelora-video…
 *   VITE_SORAHNEX_EDGE_NAMING=canonical           → sorahnex-ai, sorahnex-video…
 *
 * Aucun appelant ne doit écrire un nom de fonction en dur.
 */

export type NamingMode = 'legacy' | 'canonical';

export const SORAHNEX_IDENTITY = {
  product: 'SORAHNEX',
  studio: 'SORAHNEX Studio',
  grow: 'SORAHNEX Grow',
  admin: 'Administration SORAHNEX',
  /** Boîte réellement relevée : conservée jusqu'à bascule prouvée. */
  supportEmail: 'support@vyora.app',
  /** Domaine cible de la marque ; les anciens domaines restent servis. */
  domain: 'sorahnex.app',
} as const;

export interface TechnicalNames {
  /** Nom déployé aujourd'hui. Ne pas modifier sans redéploiement vérifié. */
  legacy: string;
  /** Nom cible, cohérent avec la marque. */
  canonical: string;
}

/**
 * Edge Functions du projet. Les entrées neutres (`store-*`) sont renvoyées
 * telles quelles : elles ne portent pas de marque.
 */
export const EDGE_FUNCTIONS = {
  ai: { legacy: 'vyora-ai', canonical: 'sorahnex-ai' },
  aiProviders: { legacy: 'vyora-ai-providers', canonical: 'sorahnex-ai-providers' },
  businessGrow: { legacy: 'business-grow', canonical: 'sorahnex-business-grow' },
  catalog: { legacy: 'universal-catalog', canonical: 'sorahnex-catalog' },
  health: { legacy: 'reelora-health', canonical: 'sorahnex-health' },
  mcp: { legacy: 'vyora-mcp', canonical: 'sorahnex-mcp' },
  mcpClient: { legacy: 'mcp-client', canonical: 'sorahnex-mcp-client' },
  ownerBootstrap: { legacy: 'reelora-owner-bootstrap', canonical: 'sorahnex-owner-bootstrap' },
  payments: { legacy: 'vyora-payments', canonical: 'sorahnex-payments' },
  paymentsReconcile: { legacy: 'vyora-payments-reconcile', canonical: 'sorahnex-payments-reconcile' },
  providerDiscovery: { legacy: 'vyora-provider-discovery', canonical: 'sorahnex-provider-discovery' },
  providerHealth: { legacy: 'vyora-provider-health', canonical: 'sorahnex-provider-health' },
  saspayWebhook: { legacy: 'vyora-saspay-webhook', canonical: 'sorahnex-saspay-webhook' },
  storeConnect: { legacy: 'store-connect', canonical: 'store-connect' },
  storeImport: { legacy: 'store-import', canonical: 'store-import' },
  studioRuntime: { legacy: 'studio-runtime', canonical: 'sorahnex-studio-runtime' },
  video: { legacy: 'reelora-video', canonical: 'sorahnex-video' },
  videoQuote: { legacy: 'video-quote', canonical: 'sorahnex-video-quote' },
  videoWorker: { legacy: 'reelora-video-worker', canonical: 'sorahnex-video-worker' },
} as const satisfies Record<string, TechnicalNames>;

export type EdgeFunctionId = keyof typeof EDGE_FUNCTIONS;

/** En-têtes internes acceptés par les fonctions planifiées / workers. */
export const INTERNAL_HEADERS = {
  cron: { legacy: 'x-vyora-cron', canonical: 'x-sorahnex-cron' },
  workerToken: { legacy: 'x-reelora-worker-token', canonical: 'x-sorahnex-worker-token' },
} as const satisfies Record<string, TechnicalNames>;

/**
 * Buckets de stockage.
 *
 * Vérifié en lecture sur le projet de production : AUCUN bucket ne porte la
 * marque (`ugc-assets`, `payment-proofs`, plus trois buckets d'autres
 * applications partageant le projet). Il n'y a donc rien à renommer ici, et
 * c'est une bonne nouvelle : un bucket renommé déplacerait des fichiers et
 * casserait les URL signées existantes.
 *
 * Les noms `vyora_files` et `reelora_avatars` sont des TABLES, pas des buckets.
 */
export const STORAGE_BUCKETS = {
  ugcAssets: { legacy: 'ugc-assets', canonical: 'ugc-assets' },
  paymentProofs: { legacy: 'payment-proofs', canonical: 'payment-proofs' },
} as const satisfies Record<string, TechnicalNames>;

/**
 * Relations (tables et vues) portant encore la marque, relevées en production.
 * Le renommage passe par une vue de compatibilité, jamais par un `DROP`.
 */
export const DATABASE_RELATIONS = {
  'public.reelora_avatars': 'public.sorahnex_avatars',
  'public.reelora_prompt_templates': 'public.sorahnex_prompt_templates',
  'public.reelora_generation_presets': 'public.sorahnex_generation_presets',
  'public.reelora_plans': 'public.sorahnex_plans',
  'public.reelora_subscriptions': 'public.sorahnex_subscriptions',
  'public.reelora_usage_events': 'public.sorahnex_usage_events',
  'public.reelora_notifications': 'public.sorahnex_notifications',
  'public.reelora_audit_logs': 'public.sorahnex_audit_logs',
  'public.reelora_video_models': 'public.sorahnex_video_models',
  'public.vyora_files': 'public.sorahnex_files',
  'saas_ugc.vyora_payment_initiations': 'saas_ugc.sorahnex_payment_initiations',
  'saas_ugc.vyora_fee_schedule': 'saas_ugc.sorahnex_fee_schedule',
  'saas_ugc.vyora_payment_reconciliations': 'saas_ugc.sorahnex_payment_reconciliations',
  'saas_ugc.vyora_payment_reconcile_runs': 'saas_ugc.sorahnex_payment_reconcile_runs',
  'saas_ugc.vyora_payment_anomalies': 'saas_ugc.sorahnex_payment_anomalies',
} as const;

/** Préfixes des fonctions SQL/RPC héritées. */
export const RPC_PREFIXES = ['vyora_', 'reelora_'] as const;
export const RPC_CANONICAL_PREFIX = 'sorahnex_';

function envValue(key: string): string | undefined {
  const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
  return meta.env?.[key];
}

/** Mode de nommage actif. Défaut : `legacy`, c'est-à-dire ce qui est déployé. */
export function edgeNamingMode(): NamingMode {
  return envValue('VITE_SORAHNEX_EDGE_NAMING') === 'canonical' ? 'canonical' : 'legacy';
}

/** Nom réseau d'une Edge Function, selon le mode de nommage actif. */
export function edgeFunctionName(id: EdgeFunctionId): string {
  const names: TechnicalNames = EDGE_FUNCTIONS[id];
  return names[edgeNamingMode()];
}

/** Nom cible d'une fonction SQL héritée (`vyora_x` → `sorahnex_x`). */
export function canonicalRpcName(name: string): string {
  for (const prefix of RPC_PREFIXES) {
    if (name.startsWith(prefix)) return `${RPC_CANONICAL_PREFIX}${name.slice(prefix.length)}`;
  }
  return name;
}

/** En-têtes à transmettre : le nom canonique, doublé du nom hérité pendant la transition. */
export function internalHeaders(kind: keyof typeof INTERNAL_HEADERS, value: string): Record<string, string> {
  const names: TechnicalNames = INTERNAL_HEADERS[kind];
  return { [names.legacy]: value, [names.canonical]: value };
}
