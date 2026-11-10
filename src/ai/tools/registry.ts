import type {
  AIToolProposal,
  BusinessToolDefinition,
  BusinessToolExecution,
} from '../contracts';

export const BUSINESS_GROW_TOOLS_SPEC: BusinessToolDefinition[] = [
  {
    name: 'propose_business_memory_save',
    title: 'Mémoriser une information métier',
    description: 'Enregistre une information structurée (objectif, produit, audience, ton, préférence) dans la mémoire isolée Business Grow après validation.',
    category: 'memory',
    riskLevel: 'write_requires_approval',
    requiresBusinessProfile: true,
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['company', 'product', 'audience', 'goal', 'positioning', 'tone', 'preference', 'work_history', 'metric', 'insight'],
        },
        memory_key: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['category', 'memory_key', 'summary'],
    },
  },
  {
    name: 'propose_action_plan',
    title: 'Créer un plan d’action priorisé',
    description: 'Structure un plan d’action commercial ou marketing avec priorités et KPIs, soumis à validation.',
    category: 'strategy',
    riskLevel: 'write_requires_approval',
    requiresBusinessProfile: false,
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        horizon: { type: 'string' },
        steps: { type: 'array' },
      },
      required: ['objective', 'steps'],
    },
  },
  {
    name: 'draft_ugc_brief_handoff',
    title: 'Préparer un brief vers Studio UGC',
    description: 'Prépare un brief vidéo réutilisable dans Studio UGC sans débiter de crédits vidéo Studio UGC.',
    category: 'studio_handoff',
    riskLevel: 'draft',
    requiresBusinessProfile: false,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        platform: { type: 'string' },
        hook_idea: { type: 'string' },
        key_message: { type: 'string' },
        call_to_action: { type: 'string' },
      },
      required: ['title', 'platform', 'key_message'],
    },
  },
  {
    name: 'read_connected_store_metrics',
    title: 'Lire les indicateurs d’un connecteur autorisé',
    description: 'Lit les relevés synchronisés d’une boutique ou d’un réseau social réellement connecté. Échoue si aucun connecteur n’est autorisé.',
    category: 'connector_read',
    riskLevel: 'read',
    requiresBusinessProfile: true,
    parameters: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['shopify', 'woocommerce', 'facebook', 'instagram', 'youtube', 'tiktok'],
        },
      },
      required: ['platform'],
    },
  },
];

export function findToolDefinition(toolName: string): BusinessToolDefinition | undefined {
  return BUSINESS_GROW_TOOLS_SPEC.find((t) => t.name === toolName);
}

export function requiresExplicitUserApproval(proposal: Pick<AIToolProposal, 'toolName' | 'riskLevel'>): boolean {
  const def = findToolDefinition(proposal.toolName);
  const risk = def?.riskLevel ?? proposal.riskLevel;
  return risk === 'write_requires_approval';
}

export function canExecuteToolLocally(exec: BusinessToolExecution): { allowed: boolean; reason?: string } {
  if (exec.risk_level === 'write_requires_approval' && exec.status !== 'approved') {
    return {
      allowed: false,
      reason: 'Validation explicite de l’utilisateur requise avant exécution.',
    };
  }
  if (exec.status === 'rejected') {
    return { allowed: false, reason: 'Action refusée par l’utilisateur.' };
  }
  return { allowed: true };
}
