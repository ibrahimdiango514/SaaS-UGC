export type BusinessRoleKey =
  | 'business_advisor'
  | 'business_analysis'
  | 'content_strategy'
  | 'action_plan'
  | 'marketing_campaign'
  | 'sales_analysis'
  | 'tool_planning';

export type ToolRiskLevel =
  | 'read_only'
  | 'write_requires_approval'
  | 'external_publish_requires_approval';

export type BusinessToolName =
  | 'propose_memory_save'
  | 'propose_action_plan'
  | 'propose_campaign_brief'
  | 'handoff_ugc_brief'
  | 'request_connector_read';

export interface BusinessRoleSpec {
  roleKey: BusinessRoleKey;
  label: string;
  description: string;
  guidance: string;
}

export interface MemorySnapshot {
  consent?: boolean;
  profile?: Record<string, unknown> | null;
  items?: Array<{ category?: string; content?: unknown }>;
}

/** Mémoire persistante de l'agent (saas_business.ai_memories, 7 catégories). */
export interface AgentMemoryItem {
  id?: string;
  category: string;
  title: string;
  content: string;
  confidence: string;
}

export interface WorkspaceCompanyContext {
  workspace?: { id?: string; name?: string; country_code?: string; default_language?: string } | null;
  brands?: Array<{ name?: string; industry?: string | null; description?: string | null; voice_guidelines?: string | null }>;
  products?: Array<{ name?: string; description?: string | null; key_benefits?: string[] | null }>;
}

export interface ExtractedToolProposal {
  toolName: BusinessToolName;
  riskLevel: ToolRiskLevel;
  summary: string;
  arguments: Record<string, unknown>;
}

export const BUSINESS_ROLE_SPECS: readonly BusinessRoleSpec[] = [
  {
    roleKey: 'business_advisor',
    label: 'Conseil business général',
    description: 'Assistant général Business Grow pour piloter l’activité et structurer les décisions.',
    guidance: 'Réponds en conseiller stratégique concret, orienté résultats mesurables.',
  },
  {
    roleKey: 'business_analysis',
    label: 'Analyse d’entreprise',
    description: 'Diagnostic positionnement, offre, proposition de valeur et goulots d’étranglement.',
    guidance: 'Structure ton diagnostic : forces vérifiées, points de friction, leviers prioritaires et risques.',
  },
  {
    roleKey: 'action_plan',
    label: 'Plan d’action',
    description: 'Plan d’exécution priorisé (30/60/90 jours, jalons, KPIs, responsables).',
    guidance: 'Fournis un plan séquencé par priorité avec échéances réalistes, actions concrètes et critères de succès.',
  },
  {
    roleKey: 'marketing_campaign',
    label: 'Campagne marketing',
    description: 'Angles d’acquisition, offres, tunnel de conversion et messages clés.',
    guidance: 'Propose cible, promesse, canaux, angles créatifs et métriques à suivre sans inventer de chiffres.',
  },
  {
    roleKey: 'sales_analysis',
    label: 'Croissance des ventes',
    description: 'Optimisation panier moyen, conversion, pricing, rétention et relance.',
    guidance: 'Analyse les leviers d’acquisition, conversion et réachat en séparant hypothèses et faits connus.',
  },
  {
    roleKey: 'content_strategy',
    label: 'Stratégie & idées de contenu',
    description: 'Idées éditoriales, hooks et briefs créatifs prêts pour la production.',
    guidance: 'Propose des formats, hooks, messages et angles adaptés à la marque; si utile, suggère un brief Studio UGC sans consommer de crédits Studio.',
  },
  {
    roleKey: 'tool_planning',
    label: 'Planification d’actions assistées',
    description: 'Structuration de propositions d’actions soumises à validation utilisateur.',
    guidance: 'Identifie uniquement les actions utiles et soumets-les pour approbation explicite avant toute écriture.',
  },
];

const VALID_ROLES = new Set<string>(BUSINESS_ROLE_SPECS.map((role) => role.roleKey));

export function normalizeRoleKey(value: unknown): BusinessRoleKey {
  if (typeof value === 'string' && VALID_ROLES.has(value.trim())) {
    return value.trim() as BusinessRoleKey;
  }
  return 'business_advisor';
}

const TOOL_RISK_MAP: Record<BusinessToolName, ToolRiskLevel> = {
  propose_memory_save: 'write_requires_approval',
  propose_action_plan: 'write_requires_approval',
  propose_campaign_brief: 'write_requires_approval',
  handoff_ugc_brief: 'write_requires_approval',
  request_connector_read: 'read_only',
};

const VALID_TOOLS = new Set<string>(Object.keys(TOOL_RISK_MAP));

function safeJsonSlice(value: unknown, maxChars: number): string {
  try {
    const raw = JSON.stringify(value);
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
  } catch {
    return '{}';
  }
}

export function buildBusinessSystemInstruction(input: {
  baseSystemMessage: string;
  roleKey: BusinessRoleKey;
  memory?: MemorySnapshot | null;
  workspaceContext?: WorkspaceCompanyContext | null;
  agentMemories?: AgentMemoryItem[] | null;
}): string {
  const hasConsentMemory = Boolean(
    input.memory?.consent === true
    && ((input.memory.profile && Object.keys(input.memory.profile).length > 0)
      || (Array.isArray(input.memory.items) && input.memory.items.length > 0)),
  );
  const hasWorkspaceContext = Boolean(
    input.workspaceContext?.workspace?.name
    || (input.workspaceContext?.brands?.length ?? 0) > 0
    || (input.workspaceContext?.products?.length ?? 0) > 0,
  );
  const hasAgentMemory = (input.agentMemories?.length ?? 0) > 0;

  // Preserve exact base system prompt when no extra grounding or specialized role is active.
  if (input.roleKey === 'business_advisor' && !hasConsentMemory && !hasWorkspaceContext && !hasAgentMemory) {
    return input.baseSystemMessage;
  }

  const role = BUSINESS_ROLE_SPECS.find((item) => item.roleKey === input.roleKey) ?? BUSINESS_ROLE_SPECS[0];
  const sections: string[] = [
    input.baseSystemMessage,
    `Rôle actif : ${role.label} (${role.roleKey}). ${role.guidance}`,
    'Règle de véracité : aucun connecteur social ou e-commerce externe n’est actif sans autorisation vérifiée ; ne simule jamais de métriques réelles.',
  ];

  if (hasWorkspaceContext && input.workspaceContext) {
    const ws = input.workspaceContext.workspace;
    const brands = (input.workspaceContext.brands ?? []).slice(0, 5);
    const products = (input.workspaceContext.products ?? []).slice(0, 8);
    sections.push(
      `Contexte entreprise VYORA (lecture autorisée) : ${safeJsonSlice({
        workspace: ws?.name ?? null,
        country: ws?.country_code ?? null,
        language: ws?.default_language ?? null,
        brands,
        products,
      }, 2500)}`,
    );
  }

  if (hasConsentMemory && input.memory) {
    sections.push(
      `Mémoire métier consentie par l’utilisateur : ${safeJsonSlice({
        profile: input.memory.profile ?? null,
        items: (input.memory.items ?? []).slice(0, 15).map((item) => ({
          category: item.category ?? 'general',
          content: item.content,
        })),
      }, 2500)}`,
    );
  }

  if (hasAgentMemory && input.agentMemories) {
    sections.push(
      `Mémoire de l’agent (continuité, périmètre de cet utilisateur/espaces autorisés) : ${safeJsonSlice({
        items: input.agentMemories.slice(0, 5).map((item) => ({
          category: item.category,
          title: item.title,
          content: item.content,
          confidence: item.confidence,
        })),
      }, 1600)} — Règle : ne considère comme FAIT que les entrées marquées confidence=fact ; traite les hypothèses comme telles et ne les présente jamais comme des données vérifiées.`,
    );
  }

  sections.push(
    'Si et seulement si une action structurée concrète doit être soumise à l’approbation de l’utilisateur (mémoriser un fait clé, créer un plan d’action, préparer un brief de campagne, ou préparer un brief vidéo vers Studio UGC), tu peux ajouter à la toute fin de ta réponse un bloc caché compact (< 400 caractères) exact, toujours fermé par --> : <!--REELORA_TOOL_PROPOSALS:[{"toolName":"propose_memory_save|propose_action_plan|propose_campaign_brief|handoff_ugc_brief","summary":"...","arguments":{...}}]-->. Pour handoff_ugc_brief, utilise les clés product, angle, hook, targetAudience. N’exécute jamais d’action sans validation humaine.',
  );

  return sections.join('\n\n');
}

const TOOL_BLOCK_RE = /\n*(?:---\s*\n*)?<!--REELORA_TOOL_PROPOSALS:([\s\S]*?)-->/g;
const TRUNCATED_TOOL_BLOCK_RE = /\n*(?:---\s*\n*)?<!--REELORA_TOOL_PROPOSALS:[\s\S]*$/;

function cleanOptString(value: unknown, maxLen: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLen) : undefined;
}

export function normalizeToolProposalArguments(
  toolName: BusinessToolName,
  rawArgs: Record<string, unknown>,
  fallbackSummary = '',
): Record<string, unknown> {
  if (toolName === 'handoff_ugc_brief') {
    const product = cleanOptString(rawArgs.product, 160)
      ?? cleanOptString(rawArgs.productName, 160)
      ?? cleanOptString(rawArgs.produit, 160)
      ?? cleanOptString(fallbackSummary, 160)
      ?? '';
    const angle = cleanOptString(rawArgs.angle, 400)
      ?? cleanOptString(rawArgs.campaignAngle, 400)
      ?? cleanOptString(rawArgs.creativeAngle, 400)
      ?? cleanOptString(rawArgs.summary, 400)
      ?? cleanOptString(fallbackSummary, 400)
      ?? '';
    const hook = cleanOptString(rawArgs.hook, 300)
      ?? cleanOptString(rawArgs.accroche, 300)
      ?? '';
    const targetAudience = cleanOptString(rawArgs.targetAudience, 300)
      ?? cleanOptString(rawArgs.audience, 300)
      ?? cleanOptString(rawArgs.cible, 300)
      ?? '';
    const cta = cleanOptString(rawArgs.cta, 200)
      ?? cleanOptString(rawArgs.callToAction, 200);
    const ratioRaw = rawArgs.preferredRatio ?? rawArgs.ratio;
    const preferredRatio = ratioRaw === '9:16' || ratioRaw === '1:1' || ratioRaw === '16:9'
      ? ratioRaw
      : undefined;

    return {
      ...rawArgs,
      product,
      angle,
      hook,
      targetAudience,
      ...(cta ? { cta } : {}),
      ...(preferredRatio ? { preferredRatio } : {}),
      consumesStudioCredits: false,
    };
  }

  if (toolName === 'propose_memory_save') {
    const category = cleanOptString(rawArgs.category, 80) ?? 'business_context';
    const summary = cleanOptString(rawArgs.summary, 1000)
      ?? cleanOptString(rawArgs.text, 1000)
      ?? cleanOptString(fallbackSummary, 1000);
    return {
      ...rawArgs,
      category,
      ...(summary ? { summary } : {}),
    };
  }

  return rawArgs;
}

export function extractToolProposals(rawText: string): {
  cleanText: string;
  proposals: ExtractedToolProposal[];
} {
  const proposals: ExtractedToolProposal[] = [];
  const withoutClosedBlocks = rawText.replace(TOOL_BLOCK_RE, (_match, rawJson: string) => {
    try {
      const parsed: unknown = JSON.parse(rawJson.trim());
      if (Array.isArray(parsed)) {
        for (const entry of parsed.slice(0, 5)) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
          const record = entry as Record<string, unknown>;
          const toolName = typeof record.toolName === 'string' ? record.toolName.trim() : '';
          if (!VALID_TOOLS.has(toolName)) continue;
          const typedTool = toolName as BusinessToolName;
          const summary = typeof record.summary === 'string' && record.summary.trim()
            ? record.summary.trim().slice(0, 240)
            : typedTool;
          const rawArgs = record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments)
            ? record.arguments as Record<string, unknown>
            : {};
          proposals.push({
            toolName: typedTool,
            riskLevel: TOOL_RISK_MAP[typedTool],
            summary,
            arguments: normalizeToolProposalArguments(typedTool, rawArgs, summary),
          });
        }
      }
    } catch {
      // Malformed hidden tool proposal block is safely ignored without failing the reply.
    }
    return '';
  });
  const cleanText = withoutClosedBlocks.replace(TRUNCATED_TOOL_BLOCK_RE, '').trim();

  return { cleanText: cleanText || rawText.trim(), proposals };
}

// ---------------------------------------------------------------------------
// Extraction heuristique des DÉCLARATIONS explicites de l'utilisateur.
//
// La mémoire persistante de l'agent ne s'alimente QUE de ce que l'utilisateur
// déclare explicitement (aucun appel LLM supplémentaire, aucune déduction).
// Trois catégories ciblées : faits sur l'entreprise, décisions, préférences
// personnelles. Tout le reste (questions, demandes) n'est JAMAIS mémorisé.
// ---------------------------------------------------------------------------

export interface ExtractedUserStatement {
  category: 'company' | 'decision' | 'user';
  title: string;
  content: string;
}

// NB : pas de \b final — en JavaScript \b est ASCII-only et échoue après un
// caractère accentué (é, ê…). Les ancres initiales \b suffisent (phrases
// françaises multimots, risque de faux positif négligeable).
const COMPANY_RE =
  /\b(notre (entreprise|soci[ée]t[ée]|marque|produit|activit[ée]|client[ée]le|secteur|budget)|mon entreprise|m'a?\s?entreprise|nous (vendons|produisons|fabriquons|travaillons|sommes bas[ée]s|ciblons|livrons)|mon activit[ée]|mon budget)/i;
const DECISION_RE =
  /\b(j[’']?ai (d[ée]cid[ée]|choisi|opt[ée] pour)|on a (d[ée]cid[ée]|choisi|opt[ée])|d[ée]cision (finale|prise|:)|je (retiens|arr[ê]te que|choisis))/i;
const USER_PREF_RE =
  /\bje (pr[ée]f[èe]re|aime|n[’']?aime pas|veux|souhaite|voulais|pr[ée]f[èe]rais|compte|habite|travaille (sur|à)|me trouve)/i;

export function extractUserStatement(content: string): ExtractedUserStatement | null {
  const text = content.trim();
  if (text.length < 8 || text.length > 500) return null;
  // Une déclaration simple : une ou deux phrases, sans question.
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 3) return null;
  if (/\?\s*$/.test(text)) return null;

  const firstLine = text.split('\n')[0].trim().slice(0, 90);

  if (COMPANY_RE.test(text)) {
    return { category: 'company', title: firstLine, content: text };
  }
  if (DECISION_RE.test(text)) {
    return { category: 'decision', title: firstLine, content: text };
  }
  if (USER_PREF_RE.test(text)) {
    return { category: 'user', title: firstLine, content: text };
  }
  return null;
}
