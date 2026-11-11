/**
 * Contrats publics et stables entre le moteur IA Business Grow (géré par Arena)
 * et le reste de la plateforme VYORA (développé dans VS Code : Studio UGC,
 * Dashboard, Projets, Éditeur, Paramètres, Abonnement et futurs Connecteurs).
 *
 * Règle anti-conflit :
 * - Ce fichier ne contient AUCUNE dépendance runtime vers React, Supabase ou
 *   des clés secrètes.
 * - Toute évolution de contrat doit rester rétrocompatible ou versionnée.
 */

import type { BusinessRoleKey, RoutingSelectionMode } from '../business/ai/registry';

export const REELORA_DOMAIN_BOUNDARIES = {
  businessGrowSchema: 'saas_business',
  studioUgcSchema: 'saas_ugc',
  businessGrowEdgeFunction: 'business-grow',
  studioAiEdgeFunction: 'reelora-ai',
  studioVideoEdgeFunction: 'reelora-video',
  studioCreditsNeverDebitedByBusinessGrow: true,
} as const;

export const UGC_HANDOFF_BRIEF_VERSION = 'reelora-ugc-handoff-v1' as const;

export type UgcPreferredRatio = '9:16' | '1:1' | '16:9';

export interface BusinessGrowUgcHandoffBrief {
  version: typeof UGC_HANDOFF_BRIEF_VERSION;
  source: 'business_grow';
  sourceExecutionId: string | null;
  sourceConversationId: string | null;
  brandName: string | null;
  product: string;
  angle: string;
  hook: string;
  targetAudience: string;
  summary: string;
  cta: string | null;
  preferredRatio: UgcPreferredRatio | null;
  suggestedSector: string | null;
  /** Produit réel du catalogue VYORA quand le brief provient d'une fiche existante. */
  productId: string | null;
  /** Projet publicitaire VYORA à réutiliser, pour éviter un doublon de projet. */
  projectId: string | null;
  projectTitle: string | null;
  /** Plateforme visée par le brief (TikTok, Instagram Reels…), si connue. */
  platform: string | null;
  consumesStudioCredits: false;
}

export type BusinessGrowWorkspaceSection =
  | 'chat'
  | 'growth'
  | 'company'
  | 'memory'
  | 'providers'
  | 'integrations';

/** Onglets réels du cockpit croissance Business Grow. */
export type BusinessGrowGrowthTab =
  | 'overview'
  | 'company'
  | 'goals'
  | 'catalog'
  | 'market'
  | 'crm'
  | 'strategy'
  | 'activity'
  | 'settings';

const VALID_GROWTH_TABS = new Set<BusinessGrowGrowthTab>([
  'overview', 'company', 'goals', 'catalog', 'market', 'crm', 'strategy', 'activity', 'settings',
]);

export interface BusinessGrowEntryIntent {
  version: 'reelora-bg-entry-v1';
  section?: BusinessGrowWorkspaceSection;
  roleKey?: BusinessRoleKey;
  workspaceId?: string | null;
  projectId?: string | null;
  projectTitle?: string | null;
  brandName?: string | null;
  productName?: string | null;
  initialDraft?: string | null;
  sourceRoute?: string | null;
  /** Onglet du cockpit croissance à ouvrir après l'arrivée. */
  growthTab?: BusinessGrowGrowthTab | null;
  /** Plateforme visée, quand elle vient d'un projet Studio réel. */
  platform?: string | null;
}

export interface BusinessGrowProviderSummary {
  providerKey: string;
  displayName: string;
  enabled: boolean;
  status: 'unverified' | 'available' | 'degraded' | 'unavailable';
  configStatus: 'missing' | 'configured' | 'error';
  verifiedModelKeys: string[];
}

export interface BusinessGrowPlatformSnapshot {
  backendReachable: boolean;
  availableProviderCount: number;
  providers: BusinessGrowProviderSummary[];
  quota: {
    domain: 'business_grow';
    studioUgcUntouched: true;
    availableUnits: number | null;
    reservedUnits: number;
    monthlyAllowance: number | null;
    periodKey: string | null;
  } | null;
  checkedAt: string;
}

export interface BusinessGrowStatusPort {
  getSnapshot(): Promise<BusinessGrowPlatformSnapshot>;
}

export interface PlatformAiTaskRequest {
  conversationId?: string | null;
  conversationTitle?: string;
  workspaceId?: string | null;
  roleKey: BusinessRoleKey;
  prompt: string;
  idempotencyKey: string;
  routing?: {
    selectionMode?: RoutingSelectionMode;
    preferredProviderKey?: string | null;
    preferredModelKey?: string | null;
    allowFallback?: boolean;
  };
}

export interface PlatformAiTaskResult {
  conversationId: string;
  requestId: string;
  status: string;
  providerKey: string | null;
  modelKey: string | null;
  fallbackUsed: boolean;
  attemptsCount: number;
  assistantReply: string | null;
  toolProposals: Array<{
    id: string | null;
    toolName: string;
    riskLevel: string;
    summary: string;
    arguments: Record<string, unknown>;
  }>;
}

export interface BusinessAiEnginePort {
  executeTask(request: PlatformAiTaskRequest): Promise<PlatformAiTaskResult>;
}

export interface BusinessConnectorReadRequest {
  workspaceId: string;
  connectorKey: 'facebook' | 'instagram' | 'youtube' | 'tiktok' | 'shopify' | 'woocommerce';
  scope: 'account-read' | 'analytics-read' | 'catalog-read' | 'orders-read';
  cursor?: string | null;
}

export interface BusinessConnectorReadBridge {
  readVerifiedSnapshot(request: BusinessConnectorReadRequest): Promise<{
    connected: boolean;
    connectorKey: BusinessConnectorReadRequest['connectorKey'];
    summary: Record<string, unknown> | null;
    nextCursor: string | null;
    errorCode?: string;
  }>;
}

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function optionalText(value: unknown, maxLength: number): string | null {
  const clean = cleanText(value, maxLength);
  return clean || null;
}

function parseRatio(value: unknown): UgcPreferredRatio | null {
  if (value === '9:16' || value === '1:1' || value === '16:9') return value;
  return null;
}

/** Identifiants VYORA (produit, projet) : UUID uniquement, sinon ignorés. */
function optionalUuid(value: unknown): string | null {
  const clean = cleanText(value, 64);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean)
    ? clean
    : null;
}

/**
 * Normalise un brief provenant de Business Grow (tool `handoff_ugc_brief`,
 * `input_args` ou `output_result.handoffDraft`) en contrat strict pour le Studio UGC.
 * Garantit `consumesStudioCredits: false` (aucun débit automatique lors du transfert).
 */
export function normalizeUgcHandoffBrief(
  raw: unknown,
  meta?: { executionId?: string | null; conversationId?: string | null },
): BusinessGrowUgcHandoffBrief | null {
  const record = asObj(raw);
  if (Object.keys(record).length === 0) return null;

  const product = cleanText(record.product, 160)
    || cleanText(record.productName, 160)
    || cleanText(record.produit, 160);
  const angle = cleanText(record.angle, 400)
    || cleanText(record.campaignAngle, 400)
    || cleanText(record.creativeAngle, 400);
  const hook = cleanText(record.hook, 300)
    || cleanText(record.accroche, 300);
  const targetAudience = cleanText(record.targetAudience, 300)
    || cleanText(record.audience, 300)
    || cleanText(record.cible, 300);
  const summary = cleanText(record.summary, 600)
    || cleanText(record.description, 600);
  const cta = optionalText(record.cta, 200)
    || optionalText(record.callToAction, 200);
  const brandName = optionalText(record.brandName, 120)
    || optionalText(record.brand, 120);

  if (!product && !angle && !hook && !summary && !cta) {
    return null;
  }

  return {
    version: UGC_HANDOFF_BRIEF_VERSION,
    source: 'business_grow',
    sourceExecutionId: optionalText(record.sourceExecutionId, 64) ?? meta?.executionId ?? null,
    sourceConversationId: optionalText(record.sourceConversationId, 64) ?? meta?.conversationId ?? null,
    brandName,
    product,
    angle,
    hook,
    targetAudience,
    summary,
    cta,
    preferredRatio: parseRatio(record.preferredRatio ?? record.ratio),
    suggestedSector: optionalText(record.suggestedSector ?? record.sector, 40),
    productId: optionalUuid(record.productId),
    projectId: optionalUuid(record.projectId),
    projectTitle: optionalText(record.projectTitle, 160),
    platform: optionalText(record.platform, 40),
    consumesStudioCredits: false,
  };
}

export function extractUgcHandoffBriefFromLocationState(state: unknown): BusinessGrowUgcHandoffBrief | null {
  const stateObj = asObj(state);
  if (!('ugcBrief' in stateObj)) return null;
  return normalizeUgcHandoffBrief(stateObj.ugcBrief);
}

export function buildStudioLocationStateFromBrief(
  raw: unknown,
  meta?: { executionId?: string | null; conversationId?: string | null },
): { ugcBrief: BusinessGrowUgcHandoffBrief } | undefined {
  const normalized = normalizeUgcHandoffBrief(raw, meta);
  return normalized ? { ugcBrief: normalized } : undefined;
}

export function formatUgcPromptFromBrief(brief: BusinessGrowUgcHandoffBrief): string {
  const parts = [
    brief.product ? `Produit : ${brief.product}` : '',
    brief.hook ? `Accroche : ${brief.hook}` : '',
    brief.angle ? `Angle : ${brief.angle}` : '',
    brief.targetAudience ? `Cible : ${brief.targetAudience}` : '',
    brief.summary && brief.summary !== brief.angle ? brief.summary : '',
    brief.cta ? `CTA : ${brief.cta}` : '',
  ].filter(Boolean);
  return parts.join(' — ').slice(0, 4000);
}

const VALID_SECTIONS = new Set<BusinessGrowWorkspaceSection>([
  'chat', 'growth', 'company', 'memory', 'providers', 'integrations',
]);

const VALID_ROLES = new Set<BusinessRoleKey>([
  'business_advisor',
  'business_analysis',
  'action_plan',
  'marketing_campaign',
  'sales_analysis',
  'content_strategy',
  'tool_planning',
]);

export function buildBusinessGrowLocationState(
  intent: Omit<BusinessGrowEntryIntent, 'version'>,
): { businessGrowIntent: BusinessGrowEntryIntent } {
  return {
    businessGrowIntent: {
      version: 'reelora-bg-entry-v1',
      ...intent,
    },
  };
}

export function parseBusinessGrowEntryIntent(state: unknown): BusinessGrowEntryIntent | null {
  const stateObj = asObj(state);
  const rawIntent = asObj(stateObj.businessGrowIntent);
  if (Object.keys(rawIntent).length === 0) return null;

  const section = typeof rawIntent.section === 'string' && VALID_SECTIONS.has(rawIntent.section as BusinessGrowWorkspaceSection)
    ? rawIntent.section as BusinessGrowWorkspaceSection
    : undefined;
  const roleKey = typeof rawIntent.roleKey === 'string' && VALID_ROLES.has(rawIntent.roleKey as BusinessRoleKey)
    ? rawIntent.roleKey as BusinessRoleKey
    : undefined;

  return {
    version: 'reelora-bg-entry-v1',
    section,
    roleKey,
    workspaceId: optionalText(rawIntent.workspaceId, 64),
    projectId: optionalText(rawIntent.projectId, 64),
    projectTitle: optionalText(rawIntent.projectTitle, 160),
    brandName: optionalText(rawIntent.brandName, 120),
    productName: optionalText(rawIntent.productName, 160),
    initialDraft: optionalText(rawIntent.initialDraft, 4000),
    sourceRoute: optionalText(rawIntent.sourceRoute, 120),
    growthTab: typeof rawIntent.growthTab === 'string'
      && VALID_GROWTH_TABS.has(rawIntent.growthTab as BusinessGrowGrowthTab)
      ? rawIntent.growthTab as BusinessGrowGrowthTab
      : null,
    platform: optionalText(rawIntent.platform, 40),
  };
}

/**
 * Contexte réel disponible dans le Studio UGC pour une continuité de travail
 * Business Grow ↔ Studio. Chaque champ provient d'un projet, d'un produit ou
 * d'une marque réellement chargés : aucune valeur n'est inventée.
 */
export interface StudioToBusinessGrowContext {
  projectId?: string | null;
  projectTitle?: string | null;
  brandName?: string | null;
  productName?: string | null;
  campaignObjective?: string | null;
  targetAudience?: string | null;
  platform?: string | null;
  brief?: string | null;
  scriptText?: string | null;
}

/**
 * Construit l'état de navigation Studio UGC → Business Grow.
 *
 * Le contexte projet / produit / script devient un brouillon de conversation :
 * l'utilisateur continue son travail sans ressaisie. Aucune écriture, aucun
 * appel IA et aucun débit ne sont déclenchés : le brouillon n'est envoyé que
 * si l'utilisateur clique explicitement sur « Envoyer ».
 */
export function buildBusinessGrowLocationStateFromStudio(
  context: StudioToBusinessGrowContext,
  options?: { growthTab?: BusinessGrowGrowthTab | null; section?: BusinessGrowWorkspaceSection },
): { businessGrowIntent: BusinessGrowEntryIntent } | undefined {
  const projectTitle = optionalText(context.projectTitle, 160);
  const productName = optionalText(context.productName, 160);
  const brandName = optionalText(context.brandName, 120);
  const brief = optionalText(context.brief, 800);
  const scriptText = optionalText(context.scriptText, 1200);
  const objective = optionalText(context.campaignObjective, 160);
  const audience = optionalText(context.targetAudience, 160);

  const draftParts = [
    projectTitle ? `Projet UGC en cours : ${projectTitle}.` : '',
    productName ? `Produit : ${productName}.` : '',
    brandName ? `Marque : ${brandName}.` : '',
    objective ? `Objectif de campagne : ${objective}.` : '',
    audience ? `Audience cible : ${audience}.` : '',
    brief ? `Brief : ${brief}.` : '',
    scriptText ? `Script existant : ${scriptText}.` : '',
  ].filter(Boolean);
  const initialDraft = draftParts.length
    ? `${draftParts.join(' ')} Propose un plan de croissance et des angles UGC cohérents avec ce contexte.`.slice(0, 4000)
    : null;

  const projectId = optionalUuid(context.projectId);
  if (!initialDraft && !projectId && !options?.growthTab) return undefined;

  return buildBusinessGrowLocationState({
    section: options?.section ?? 'growth',
    growthTab: options?.growthTab ?? 'strategy',
    projectId,
    projectTitle,
    brandName,
    productName,
    initialDraft,
    platform: optionalText(context.platform, 40),
    sourceRoute: '/app/studio',
  });
}
