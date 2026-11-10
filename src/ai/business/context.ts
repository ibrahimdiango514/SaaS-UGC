import type { BusinessMemoryCategory, BusinessProfile } from '../contracts';

export const BUSINESS_MEMORY_CATEGORY_LABELS: Record<BusinessMemoryCategory, string> = {
  company: 'Identité entreprise',
  product: 'Produits & services',
  audience: 'Clients cibles',
  goal: 'Objectifs commerciaux',
  positioning: 'Positionnement',
  tone: 'Ton & voix de marque',
  preference: 'Préférences utilisateur',
  work_history: 'Historique de travail',
  metric: 'Indicateur métier vérifié',
  insight: 'Enseignement stratégique',
};

export interface BusinessProfileCompleteness {
  scorePercent: number;
  missingFields: string[];
  readyForStrategy: boolean;
}

export function evaluateBusinessProfile(profile: Partial<BusinessProfile> | null | undefined): BusinessProfileCompleteness {
  if (!profile || !profile.company_name?.trim()) {
    return {
      scorePercent: 0,
      missingFields: ['Nom de l’entreprise', 'Secteur d’activité', 'Produits/services', 'Clients cibles', 'Objectifs', 'Positionnement', 'Ton de communication'],
      readyForStrategy: false,
    };
  }

  const checks: Array<[string, boolean]> = [
    ['Nom de l’entreprise', Boolean(profile.company_name?.trim())],
    ['Secteur d’activité', Boolean(profile.industry?.trim())],
    ['Produits ou services', Array.isArray(profile.products_services) && profile.products_services.length > 0],
    ['Clients cibles', Array.isArray(profile.target_customers) && profile.target_customers.length > 0],
    ['Objectifs', Array.isArray(profile.business_goals) && profile.business_goals.length > 0],
    ['Positionnement', Boolean(profile.positioning?.trim())],
    ['Ton de communication', Boolean(profile.communication_tone?.trim())],
  ];

  const present = checks.filter(([, ok]) => ok).length;
  const missingFields = checks.filter(([, ok]) => !ok).map(([label]) => label);
  const scorePercent = Math.round((present / checks.length) * 100);

  return {
    scorePercent,
    missingFields,
    readyForStrategy: scorePercent >= 55,
  };
}

export interface StudioUgcBriefHandoff {
  title: string;
  brief: string;
  platform: string;
  campaign_objective: string;
  target_audience: string;
  sourceSpace: 'business_grow';
  consumesStudioCreditsOnDraft: false;
}

/**
 * Formats a Business Grow campaign recommendation into a clean Studio UGC project payload.
 * Never consumes Studio UGC credits: VS Code passes this draft to Studio UGC only on explicit user action.
 */
export function buildUgcBriefHandoff(params: {
  title: string;
  platform?: string;
  keyMessage: string;
  hookIdea?: string;
  callToAction?: string;
  profile?: Pick<BusinessProfile, 'company_name' | 'target_customers' | 'business_goals'> | null;
}): StudioUgcBriefHandoff {
  const parts = [
    params.hookIdea ? `Accroche proposée : ${params.hookIdea}` : '',
    `Message clé : ${params.keyMessage}`,
    params.callToAction ? `Appel à l’action : ${params.callToAction}` : '',
  ].filter(Boolean);

  return {
    title: params.title.trim().slice(0, 140),
    brief: parts.join('\n'),
    platform: params.platform || 'TikTok',
    campaign_objective: params.profile?.business_goals?.[0] ?? 'Acquisition & conversion',
    target_audience: params.profile?.target_customers?.[0] ?? 'Audience cible définie dans Business Grow',
    sourceSpace: 'business_grow',
    consumesStudioCreditsOnDraft: false,
  };
}
