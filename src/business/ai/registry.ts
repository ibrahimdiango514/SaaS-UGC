/**
 * VYORA — définitions partagées de l'espace Business.
 *
 * AUCUN fournisseur n'est listé ici : la liste des services IA vient du
 * registre serveur (`ai_providers`). Ajouter un fournisseur est une opération
 * d'administration (ligne de registre + secret), jamais une modification de
 * code ou de ce fichier.
 */
export type BusinessProviderId = string;

export type BusinessCapability =
  | 'writing'
  | 'images'
  | 'documents'
  | 'scripts'
  | 'hooks'
  | 'reasoning'
  | 'analysis'
  | 'economic-routing'
  | 'fallback'
  | 'specialized-models'
  | 'model-comparison'
  | 'experimentation'
  | 'video-generation'
  | string;

export type ProviderConnectionState =
  | 'unverified'
  | 'not-configured'
  | 'configured-untested'
  | 'available'
  | 'unavailable';

/** Fournisseur tel qu'il doit être AFFICHÉ, construit depuis le registre. */
export interface BusinessProviderDefinition {
  id: BusinessProviderId;
  name: string;
  proposedCapabilities: readonly BusinessCapability[];
  connectionState: ProviderConnectionState;
  statusLabel: string;
  statusDescription: string;
  note?: string;
}

export type BusinessRoleKey =
  | 'business_advisor'
  | 'business_analysis'
  | 'action_plan'
  | 'marketing_campaign'
  | 'sales_analysis'
  | 'content_strategy'
  | 'tool_planning';

export type RoutingSelectionMode = 'auto' | 'manual';

export interface BusinessRoleDefinition {
  roleKey: BusinessRoleKey;
  label: string;
  description: string;
}

export const BUSINESS_ROLES: readonly BusinessRoleDefinition[] = [
  { roleKey: 'business_advisor', label: 'Conseil business', description: 'Pilotage global et réponses contextualisées' },
  { roleKey: 'business_analysis', label: 'Analyse entreprise', description: 'Diagnostic offre, positionnement et leviers' },
  { roleKey: 'action_plan', label: 'Plan d’action', description: 'Feuille de route priorisée et jalons' },
  { roleKey: 'marketing_campaign', label: 'Campagne marketing', description: 'Acquisition, angles, promesse et tunnel' },
  { roleKey: 'sales_analysis', label: 'Croissance ventes', description: 'Conversion, pricing, rétention et panier' },
  { roleKey: 'content_strategy', label: 'Idées contenu', description: 'Angles éditoriaux, hooks et briefs UGC' },
  { roleKey: 'tool_planning', label: 'Actions assistées', description: 'Propositions d’actions soumises à validation' },
];

export function isBusinessProviderAvailable(provider: BusinessProviderDefinition): boolean {
  return provider.connectionState === 'available';
}

/**
 * Projette une ligne du registre serveur en définition affichable.
 * Aucune capability n'est inventée : seules celles des modèles vérifiés du
 * fournisseur sont reprises.
 */
export function describeRegistryProvider(row: {
  key: string;
  name?: string | null;
  status: string;
  aggregator: boolean;
  capabilities?: readonly BusinessCapability[];
}): BusinessProviderDefinition {
  const available = row.status === 'available';
  return {
    id: row.key,
    name: row.name?.trim() || row.key,
    proposedCapabilities: row.capabilities ?? [],
    connectionState: available ? 'available' : 'unverified',
    statusLabel: available ? 'Vérifié' : 'Non vérifié',
    statusDescription: available
      ? 'Disponibilité confirmée par une sonde réelle.'
      : 'Aucune disponibilité confirmée pour ce service.',
    ...(row.aggregator ? { note: 'Agrégateur : recours, jamais un doublon de facturation.' } : {}),
  };
}

/** Capacités lisibles d'un modèle, dans l'ordre de leurs libellés connus. */
export function capabilitiesOf(capabilities: Record<string, unknown> | null | undefined): string[] {
  return describeModelCapabilities(capabilities ?? {});
}

export const MODEL_CAPABILITY_LABELS: Record<string, string> = {
  reasoning: 'Raisonnement stratégique',
  analysis: 'Analyse structurée',
  writing: 'Rédaction & synthèse',
  scripts: 'Scripts & hooks rapides',
  hooks: 'Accroches marketing',
  documents: 'Synthèse documentaire',
  images: 'Compréhension multimodale',
  'economic-routing': 'Routage économique',
  fallback: 'Secours haute disponibilité',
  'specialized-models': 'Modèles spécialisés',
  'model-comparison': 'Comparaison multi-modèles',
  experimentation: 'Expérimentation',
  'video-generation': 'Génération vidéo Studio',
  structured_output: 'Sortie structurée',
  tool_planning: 'Propositions d’actions',
  multilingual: 'Multilingue (FR/EN)',
  fast_response: 'Réponse rapide',
  high_throughput: 'Haut débit',
};

export const BUSINESS_ROUTING_DEFAULTS = {
  defaultRoleKey: 'business_advisor' as BusinessRoleKey,
  defaultSelectionMode: 'auto' as RoutingSelectionMode,
  defaultAllowFallbackInAuto: true,
  defaultAllowFallbackInManual: false,
} as const;

export function describeModelCapabilities(capabilities: Record<string, unknown>): string[] {
  return Object.entries(capabilities)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => MODEL_CAPABILITY_LABELS[key] ?? key);
}

