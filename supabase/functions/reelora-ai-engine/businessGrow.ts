import type { AITaskType, AIToolCallProposal, AIToolDeclaration } from './types.ts';

export interface BusinessProfileRecord {
  id: string;
  company_name: string;
  industry?: string | null;
  tagline?: string | null;
  description?: string | null;
  website_url?: string | null;
  primary_language?: string;
  products_services?: unknown[];
  target_customers?: unknown[];
  business_goals?: unknown[];
  positioning?: string | null;
  brand_identity?: Record<string, unknown>;
  communication_tone?: string | null;
  preferences?: Record<string, unknown>;
  ai_memory_consent?: boolean;
}

export interface BusinessMemoryRecord {
  id: string;
  category: string;
  memory_key: string;
  summary: string;
  structured_data?: Record<string, unknown>;
  pinned?: boolean;
  confidence?: number;
}

export interface ExternalConnectorRecord {
  platform: string;
  category: string;
  connection_status: string;
  external_account_name?: string | null;
  last_sync_at?: string | null;
  latest_snapshot?: Record<string, unknown> | null;
}

export const BUSINESS_GROW_TOOLS: AIToolDeclaration[] = [
  {
    name: 'propose_business_memory_save',
    description: 'Proposer l’enregistrement structuré d’une information métier durable (objectif, produit, audience, ton, préférence, positionnement) dans la mémoire Business Grow.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['company', 'product', 'audience', 'goal', 'positioning', 'tone', 'preference', 'work_history', 'metric', 'insight'],
        },
        memory_key: { type: 'string', description: 'Identifiant court en snake_case' },
        summary: { type: 'string', description: 'Synthèse factuelle concise' },
      },
      required: ['category', 'memory_key', 'summary'],
    },
  },
  {
    name: 'propose_action_plan',
    description: 'Structurer un plan d’action commercial ou marketing priorisé pour validation utilisateur.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        horizon: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              priority: { type: 'string', enum: ['haute', 'moyenne', 'normale'] },
              kpi: { type: 'string' },
            },
            required: ['title'],
          },
        },
      },
      required: ['objective', 'steps'],
    },
  },
  {
    name: 'draft_ugc_brief_handoff',
    description: 'Préparer un brief structuré réutilisable dans Studio UGC sans consommer de crédits vidéo Studio UGC.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        platform: { type: 'string', enum: ['TikTok', 'Instagram Reels', 'YouTube Shorts', 'Facebook'] },
        hook_idea: { type: 'string' },
        key_message: { type: 'string' },
        call_to_action: { type: 'string' },
      },
      required: ['title', 'platform', 'key_message'],
    },
  },
];

const TASK_INSTRUCTIONS: Record<AITaskType, string> = {
  default: 'Accompagne l’entreprise de façon claire, concrète et orientée résultats.',
  chat: 'Réponds en tant que copilote métier pragmatique : appuie-toi sur le profil et la mémoire réelle de l’entreprise, pose les questions manquantes si nécessaire.',
  strategy: 'Fournis une analyse stratégique structurée (diagnostic, leviers de croissance prioritaires, risques, métriques cibles).',
  action_plan: 'Construis un plan d’action concret par phases (actions immédiates, semaine 1-4, KPIs mesurables). Utilise l’outil propose_action_plan si pertinent.',
  marketing_campaign: 'Conçois un plan de campagne marketing multi-canaux aligné sur le positionnement, les clients cibles et le ton de l’entreprise.',
  sales_analysis: 'Analyse uniquement les données chiffrées réellement fournies dans la conversation ou les connecteurs connectés. N’invente jamais de chiffres de vente absents.',
  content_ideas: 'Propose des concepts de contenus organiques et UGC adaptés au secteur et aux produits réels, avec angles et accroches.',
  memory_extraction: 'Extrais uniquement les faits métier explicitement déclarés par l’utilisateur.',
  tool_planning: 'Identifie les actions concrètes nécessitant validation avant modification.',
  script_generation: 'Rédige un script adapté au positionnement de la marque.',
};

export function buildBusinessGrowSystemPrompt(params: {
  taskType: AITaskType;
  profile: BusinessProfileRecord | null;
  memories: BusinessMemoryRecord[];
  connectors: ExternalConnectorRecord[];
}): string {
  const { taskType, profile, memories, connectors } = params;
  const lines: string[] = [
    'Tu es l’assistant IA métier de Reelora Business Grow.',
    'Règles strictes de vérité et sécurité :',
    '- Tu t’appuies EXCLUSIVEMENT sur les données métier ci-dessous et les informations données par l’utilisateur.',
    '- N’invente jamais de chiffres de ventes, de ROAS, de commandes Shopify ou de statistiques sociales si aucune donnée réelle n’est fournie.',
    '- Les crédits Business Grow sont strictement séparés des crédits vidéo Studio UGC.',
    `- Mission active (${taskType}) : ${TASK_INSTRUCTIONS[taskType] ?? TASK_INSTRUCTIONS.default}`,
  ];

  if (profile) {
    lines.push('\n### Profil entreprise');
    lines.push(`- Entreprise : ${profile.company_name}`);
    if (profile.industry) lines.push(`- Secteur : ${profile.industry}`);
    if (profile.tagline) lines.push(`- Slogan : ${profile.tagline}`);
    if (profile.description) lines.push(`- Description : ${profile.description}`);
    if (profile.positioning) lines.push(`- Positionnement : ${profile.positioning}`);
    if (profile.communication_tone) lines.push(`- Ton de communication : ${profile.communication_tone}`);
    if (profile.website_url) lines.push(`- Site web : ${profile.website_url}`);
    if (Array.isArray(profile.products_services) && profile.products_services.length > 0) {
      lines.push(`- Produits / services : ${JSON.stringify(profile.products_services.slice(0, 12))}`);
    }
    if (Array.isArray(profile.target_customers) && profile.target_customers.length > 0) {
      lines.push(`- Clients cibles : ${JSON.stringify(profile.target_customers.slice(0, 10))}`);
    }
    if (Array.isArray(profile.business_goals) && profile.business_goals.length > 0) {
      lines.push(`- Objectifs : ${JSON.stringify(profile.business_goals.slice(0, 10))}`);
    }
    if (profile.preferences && Object.keys(profile.preferences).length > 0) {
      lines.push(`- Préférences : ${JSON.stringify(profile.preferences)}`);
    }
  } else {
    lines.push('\n### Profil entreprise\nAucun profil entreprise renseigné pour le moment ; invite l’utilisateur à préciser son activité si utile.');
  }

  if (profile?.ai_memory_consent === false) {
    lines.push('\n### Mémoire métier\nMémoire persistante désactivée par choix de l’utilisateur.');
  } else if (memories.length > 0) {
    lines.push('\n### Mémoire métier active (isolée à cet utilisateur et cette entreprise)');
    for (const m of memories.slice(0, 30)) {
      lines.push(`- [${m.category}${m.pinned ? ' · épinglé' : ''}] ${m.memory_key}: ${m.summary}`);
    }
  }

  lines.push('\n### État réel des intégrations externes (réseaux sociaux & boutiques)');
  if (connectors.length === 0) {
    lines.push('- Aucune boutique (Shopify, WooCommerce) ni réseau social (Facebook, Instagram, YouTube, TikTok) connecté actuellement.');
  } else {
    for (const c of connectors) {
      const statusLabel = c.connection_status === 'connected_active' || c.connection_status === 'connected_readonly'
        ? `connecté (${c.external_account_name || c.platform})`
        : 'non connecté';
      lines.push(`- ${c.platform} (${c.category}) : ${statusLabel}`);
      if (c.latest_snapshot) {
        lines.push(`  Dernier relevé vérifié : ${JSON.stringify(c.latest_snapshot)}`);
      }
    }
  }

  return lines.join('\n');
}

export function classifyToolProposals(calls: AIToolCallProposal[]): AIToolCallProposal[] {
  return calls.map((call) => ({
    ...call,
    riskLevel: call.toolName === 'propose_business_memory_save' || call.toolName === 'propose_action_plan'
      ? 'write_requires_approval'
      : call.toolName === 'draft_ugc_brief_handoff'
      ? 'draft'
      : 'read',
  }));
}
