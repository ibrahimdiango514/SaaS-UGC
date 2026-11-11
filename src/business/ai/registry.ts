export type BusinessProviderId =
  | 'gemini'
  | 'groq'
  | 'gonka'
  | 'kilo'
  | 'openrouter'
  | 'llm7'
  | 'muapi';

export type ExtensibleAdapterId = 'openai' | 'anthropic' | 'deepseek' | 'mistral';

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
  | 'video-generation';

export type ProviderConnectionState =
  | 'unverified'
  | 'not-configured'
  | 'configured-untested'
  | 'available'
  | 'unavailable';

export interface BusinessProviderDefinition {
  id: BusinessProviderId;
  name: string;
  proposedCapabilities: readonly BusinessCapability[];
  connectionState: ProviderConnectionState;
  statusLabel: string;
  statusDescription: string;
  note?: string;
}

export interface ExtensibleAdapterDefinition {
  id: ExtensibleAdapterId;
  name: string;
  proposedCapabilities: readonly BusinessCapability[];
  connectionState: 'unverified';
  statusLabel: string;
  statusDescription: string;
  envKeyHint: string;
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

export const BUSINESS_PROVIDERS: readonly BusinessProviderDefinition[] = [
  {
    id: 'gemini',
    name: 'Gemini',
    proposedCapabilities: ['writing', 'images', 'documents'],
    connectionState: 'unverified',
    statusLabel: 'Non vérifié',
    statusDescription: 'Aucune connexion ni capacité de modèle vérifiée.',
  },
  {
    id: 'groq',
    name: 'Groq',
    proposedCapabilities: ['scripts', 'hooks', 'reasoning'],
    connectionState: 'unverified',
    statusLabel: 'Non vérifié',
    statusDescription: 'La disponibilité côté serveur n’est pas vérifiée dans Business Grow.',
    note: 'Le Studio conserve son intégration distincte.',
  },
  {
    id: 'gonka',
    name: 'Gonka',
    proposedCapabilities: ['analysis', 'reasoning'],
    connectionState: 'unverified',
    statusLabel: 'Non vérifié',
    statusDescription: 'Aucune connexion ni capacité de modèle vérifiée.',
  },
  {
    id: 'kilo',
    name: 'Kilo',
    proposedCapabilities: ['economic-routing', 'fallback'],
    connectionState: 'unverified',
    statusLabel: 'Non vérifié',
    statusDescription: 'Aucun routage économique ou secours activé.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    proposedCapabilities: ['specialized-models', 'model-comparison'],
    connectionState: 'unverified',
    statusLabel: 'Non vérifié',
    statusDescription: 'Aucun modèle spécialisé ou comparatif disponible.',
  },
  {
    id: 'llm7',
    name: 'LLM7',
    proposedCapabilities: ['experimentation'],
    connectionState: 'unverified',
    statusLabel: 'Non vérifié',
    statusDescription: 'Aucune connexion ni capacité de modèle vérifiée.',
  },
  {
    id: 'muapi',
    name: 'MuAPI',
    proposedCapabilities: ['video-generation'],
    connectionState: 'unverified',
    statusLabel: 'Non vérifié',
    statusDescription: 'La génération vidéo reste dans le Studio UGC.',
    note: 'Hors du routage conversationnel Business Grow.',
  },
];

export const EXTENSIBLE_PROVIDER_ADAPTERS: readonly ExtensibleAdapterDefinition[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    proposedCapabilities: ['writing', 'reasoning', 'analysis'],
    connectionState: 'unverified',
    statusLabel: 'Adaptateur prêt',
    statusDescription: 'Interface serveur préparée dans le registre central (aucune clé configurée).',
    envKeyHint: 'BUSINESS_GROW_OPENAI_API_KEY',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    proposedCapabilities: ['writing', 'reasoning', 'analysis'],
    connectionState: 'unverified',
    statusLabel: 'Adaptateur prêt',
    statusDescription: 'Interface serveur préparée dans le registre central (aucune clé configurée).',
    envKeyHint: 'BUSINESS_GROW_ANTHROPIC_API_KEY',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    proposedCapabilities: ['reasoning', 'economic-routing'],
    connectionState: 'unverified',
    statusLabel: 'Adaptateur prêt',
    statusDescription: 'Interface serveur préparée dans le registre central (aucune clé configurée).',
    envKeyHint: 'BUSINESS_GROW_DEEPSEEK_API_KEY',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    proposedCapabilities: ['writing', 'reasoning'],
    connectionState: 'unverified',
    statusLabel: 'Adaptateur prêt',
    statusDescription: 'Interface serveur préparée dans le registre central (aucune clé configurée).',
    envKeyHint: 'BUSINESS_GROW_MISTRAL_API_KEY',
  },
];

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

