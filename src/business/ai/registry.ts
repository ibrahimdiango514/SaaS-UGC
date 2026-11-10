export type BusinessProviderId =
  | 'gemini'
  | 'groq'
  | 'gonka'
  | 'kilo'
  | 'openrouter'
  | 'llm7'
  | 'muapi';

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

export function isBusinessProviderAvailable(provider: BusinessProviderDefinition): boolean {
  return provider.connectionState === 'available';
}
