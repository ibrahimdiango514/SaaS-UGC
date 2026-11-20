// VYORA AI CORE — routage automatique multi-fournisseurs.
//
// Objectif produit : choisir le meilleur modèle disponible pour une tâche, sans
// qu'aucune liste de fournisseurs ne soit écrite dans le code. Le routeur ne lit
// que le registre (snapshot) et le catalogue que les fournisseurs publient.
//
// Ordre de décision — FILTRES DURS (le modèle non conforme est écarté) :
//   1. fournisseur configuré côté Edge (clé présente) ;
//   2. modèle vérifié par une sonde réelle (jamais un modèle supposé) ;
//   3. capacités exigées (rôle + demande) : vision, images, vidéo, audio,
//      embeddings, outils, sortie structurée, raisonnement… ;
//   4. contexte minimal demandé ;
//   5. plafond de coût publié éventuel ;
//   6. budget mensuel : épuisé → seuls les modèles gratuits restent.
//
// Puis SOFT (le modèle reste éligible, il est seulement ordonné) :
//   7. niveau de service demandé ;
//   8. ordonnancement par score : règles du rôle, préférence d'appelant,
//      fournisseur à éviter (échec en cours), santé publiée, coût, débit,
//      pénalité d'agrégateur ;
//   9. diversité de secours : la chaîne alterne les fournisseurs (un incident
//      fournisseur ne consomme qu'une tentative) ;
//  10. anti-double-routage : un modèle de base une seule fois ;
//  11. chaîne plafonnée (anti-boucle, défaut 4, max 8).

import { modelBaseKey } from './adapters.ts';
import { AiLevel } from './types.ts';
import { AiRegistryModel, AiRegistrySnapshot } from './registry.ts';

export type AiChainSkipReason = 'NO_CONFIGURED_PROVIDER' | 'BUDGET_EXHAUSTED' | 'NO_MATCHING_MODEL' | null;

export interface AiRouteRequest {
  /** Rôle métier (ex. business_advisor) — ses règles et capacités s'appliquent. */
  role?: string | null;
  /** Niveau de service demandé ; 'auto' = tous les niveaux. */
  level?: AiLevel | 'auto' | null;
  /** Capacités supplémentaires exigées par la demande (vision, tools, JSON…). */
  requireCapabilities?: string[];
  /** Fournisseur préféré (favorisé, sans bloquer le secours). */
  preferProvider?: string | null;
  /** Fournisseurs à reléguer (ex. celui qui vient d'échouer sur cet appel). */
  avoidProviders?: string[];
  /** Contexte minimal exigé (jetons d'entrée). */
  minContextTokens?: number | null;
  /** Plafond de coût d'entrée par million de jetons (USD publiés). */
  maxCostInPerMtok?: number | null;
  /** Longueur maximale de la chaîne (plafond anti-boucle, défaut 4). */
  maxChainLength?: number;
}

export interface AiChainStep {
  providerKey: string;
  modelKey: string;
  providerModelKey: string;
  tier: AiLevel | 'standard';
  costIn: number | null;
  costOut: number | null;
  priority: number;
  viaAggregator: boolean;
  /** Score d'ordonnancement (plus grand = essayé plus tôt). */
  score: number;
  /** Origine du candidat : règle du rôle ou catalogue complet. */
  reason: 'role_rule' | 'catalog';
  /** Santé publiée par la sonde pour ce fournisseur. */
  providerStatus: string;
}

const TIER_ORDER: Record<string, number> = {
  fast: 0, economy: 1, standard: 2, advanced: 3, specialized: 4, fallback: 5,
};

/** État de santé → bonus/malus d'ordonnancement (jamais une exclusion). */
const STATUS_SCORE: Record<string, number> = {
  available: 12,
  degraded: 0,
  unverified: -2,
  unavailable: -40,
};

function hasCapabilities(model: AiRegistryModel, required: string[]): boolean {
  for (const cap of required) if (model.capabilities[cap] !== true) return false;
  return true;
}

function isFree(model: AiRegistryModel): boolean {
  // Unknown prices are not free: exhausted budgets fail closed.
  return model.costIn === 0 && model.costOut === 0;
}

/** Favorise les prix connus et bas ; l'inconnu n'est jamais traité comme gratuit. */
function costScore(model: AiRegistryModel): number {
  if (model.costIn === null && model.costOut === null) return -6;
  const reference = model.costOut ?? model.costIn ?? 0;
  if (reference === 0) return 10;
  if (reference <= 0.5) return 8;
  if (reference <= 1.5) return 6;
  if (reference <= 4) return 3;
  if (reference <= 10) return 1;
  return -3;
}

/**
 * Score d'un candidat : entier, déterministe, sans hasard. Deux exécutions sur
 * le même registre produisent exactement la même chaîne.
 */
function scoreCandidate(params: {
  model: AiRegistryModel;
  priority: number | null;
  level: AiLevel | 'auto' | null;
  preferProvider: string | null;
  avoidProviders: ReadonlySet<string>;
  aggregator: boolean;
  status: string;
}): number {
  const { model, priority, level, preferProvider, avoidProviders, aggregator, status } = params;
  let score = 100;
  if (priority !== null) score += Math.max(0, 45 - Math.min(priority, 20) * 2);
  else score -= 8;
  if (preferProvider && model.provider === preferProvider) score += 25;
  if (avoidProviders.has(model.provider)) score -= 35;
  score += STATUS_SCORE[status] ?? 0;
  if (level && level !== 'auto') {
    if (model.tier === level) score += 14;
    else score -= Math.abs((TIER_ORDER[model.tier] ?? 2) - (TIER_ORDER[level] ?? 2)) * 3;
  }
  score += costScore(model);
  if (model.rpm !== null && model.rpm > 0 && model.rpm < 60) score -= 6;
  if (aggregator) score -= 5;
  return score;
}

/**
 * Construit la chaîne ordonnée d'essais pour une tâche.
 *
 * `configuredProviders` = fournisseurs dont une clé est réellement résolue côté
 * serveur. Un fournisseur sans clé est écarté AVANT tout score : le moteur ne
 * tente jamais un fournisseur qu'il ne peut pas authentifier.
 */
export function buildAiChain(
  snapshot: AiRegistrySnapshot,
  request: AiRouteRequest,
  configuredProviders: ReadonlySet<string>,
): { steps: AiChainStep[]; skipReason: AiChainSkipReason } {
  const modelIndex = new Map<string, AiRegistryModel>();
  for (const model of snapshot.models) modelIndex.set(`${model.provider}|${model.key}`, model);
  const providerIndex = new Map(snapshot.providers.map((p) => [p.key, p]));

  const role = request.role
    ? snapshot.roles.find((r) => r.key === request.role && r.enabled)
    : undefined;
  const roleCaps = role?.capabilities ?? {};
  const requiredCaps: string[] = [
    ...Object.keys(roleCaps).filter((c) => roleCaps[c]),
    ...(request.requireCapabilities ?? []),
  ];
  const avoidProviders = new Set(request.avoidProviders ?? []);
  const level = request.level ?? 'auto';

  // — 1. Candidats : règles du rôle (priorité) PUIS catalogue complet —
  type Candidate = { model: AiRegistryModel; priority: number | null; reason: 'role_rule' | 'catalog' };
  const rules = role ? snapshot.rules.filter((r) => r.role === role.key) : [];
  const candidates: Candidate[] = [];
  const seenRuleModel = new Set<string>();
  for (const rule of rules) {
    const model = modelIndex.get(`${rule.provider}|${rule.model}`);
    if (!model) continue;
    seenRuleModel.add(`${model.provider}|${model.key}`);
    candidates.push({ model, priority: rule.priority, reason: 'role_rule' });
  }
  for (const model of snapshot.models) {
    if (seenRuleModel.has(`${model.provider}|${model.key}`)) continue;
    candidates.push({ model, priority: null, reason: 'catalog' });
  }

  // — 2. Filtres durs —
  let filtered = candidates.filter((c) => configuredProviders.has(c.model.provider));
  filtered = filtered.filter((c) => c.model.verified);
  filtered = filtered.filter((c) => hasCapabilities(c.model, requiredCaps));

  const minContext = request.minContextTokens ?? null;
  if (minContext !== null && minContext > 0) {
    filtered = filtered.filter((c) => c.model.contextIn === null || c.model.contextIn >= minContext);
  }
  const maxCost = request.maxCostInPerMtok ?? null;
  if (maxCost !== null) {
    filtered = filtered.filter((c) => c.model.costIn !== null && c.model.costIn <= maxCost);
  }

  const budget = snapshot.budget.monthly;
  const budgetExhausted = budget !== null && budget > 0 && snapshot.monthlySpendUsd >= budget;
  if (budgetExhausted) filtered = filtered.filter((c) => isFree(c.model));

  if (!filtered.length) {
    const anyConfigured = snapshot.providers.some((p) => configuredProviders.has(p.key));
    const reason: AiChainSkipReason = !anyConfigured
      ? 'NO_CONFIGURED_PROVIDER'
      : budgetExhausted
        ? 'BUDGET_EXHAUSTED'
        : 'NO_MATCHING_MODEL';
    return { steps: [], skipReason: reason };
  }

  // — 3. Ordonnancement par score (départage stable et explicite) —
  const scored = filtered.map((c) => {
    const provider = providerIndex.get(c.model.provider);
    const aggregator = provider?.aggregator === true;
    const status = provider?.status ?? 'unverified';
    return {
      candidate: c,
      aggregator,
      status,
      score: scoreCandidate({
        model: c.model,
        priority: c.priority,
        level,
        preferProvider: request.preferProvider ?? null,
        avoidProviders,
        aggregator,
        status,
      }),
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ca = a.candidate.model.costIn ?? Number.POSITIVE_INFINITY;
    const cb = b.candidate.model.costIn ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    return `${a.candidate.model.provider}|${a.candidate.model.key}`
      .localeCompare(`${b.candidate.model.provider}|${b.candidate.model.key}`);
  });

  // — 4. Anti-double-routage : un modèle de base une seule fois —
  const seenBase = new Set<string>();
  const deduped: typeof scored = [];
  for (const entry of scored) {
    const base = modelBaseKey(entry.candidate.model.providerModel);
    if (seenBase.has(base)) continue;
    seenBase.add(base);
    deduped.push(entry);
  }

  // — 5. Diversité de secours : un modèle par fournisseur d'abord —
  const maxLen = Math.max(1, Math.min(8, request.maxChainLength ?? 4));
  const ordered: typeof scored = [];
  const usedProviders = new Set<string>();
  for (const entry of deduped) {
    if (ordered.length >= maxLen) break;
    if (usedProviders.has(entry.candidate.model.provider)) continue;
    usedProviders.add(entry.candidate.model.provider);
    ordered.push(entry);
  }
  for (const entry of deduped) {
    if (ordered.length >= maxLen) break;
    if (ordered.includes(entry)) continue;
    ordered.push(entry);
  }

  return {
    steps: ordered.map((entry) => ({
      providerKey: entry.candidate.model.provider,
      modelKey: entry.candidate.model.key,
      providerModelKey: entry.candidate.model.providerModel,
      tier: entry.candidate.model.tier,
      costIn: entry.candidate.model.costIn,
      costOut: entry.candidate.model.costOut,
      priority: entry.candidate.priority ?? 0,
      viaAggregator: entry.aggregator,
      score: entry.score,
      reason: entry.candidate.reason,
      providerStatus: entry.status,
    })),
    skipReason: null,
  };
}

/** Coût estimé (USD) d'un appel, à partir des prix par 1M tokens du registre. */
export function estimateCostUsd(
  costInPerMtok: number | null,
  costOutPerMtok: number | null,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (inputTokens === null || outputTokens === null) return null;
  const inCost = costInPerMtok === null ? null : (inputTokens / 1_000_000) * costInPerMtok;
  const outCost = costOutPerMtok === null ? null : (outputTokens / 1_000_000) * costOutPerMtok;
  if (inCost === null || outCost === null) return null;
  return Math.round((inCost + outCost) * 1e6) / 1e6;
}

/**
 * Traduit une tâche métier en capacités exigées — table de VOCABULAIRE, pas de
 * fournisseurs : elle ne nomme aucun modèle et n'en privilégie aucun.
 */
export function capabilitiesForTask(task: string): string[] {
  const map: Record<string, string[]> = {
    vision: ['vision'],
    image_input: ['vision'],
    image_generation: ['images'],
    video_generation: ['video'],
    audio_generation: ['audio'],
    audio_input: ['audio_input'],
    embeddings: ['embeddings'],
    tools: ['tools'],
    structured_output: ['structured_output'],
    reasoning: ['reasoning'],
    documents: ['documents'],
  };
  return map[task.trim().toLowerCase()] ?? [];
}

/**
 * Estimation du nombre de jetons d'entrée d'une conversation, sans tokenizer :
 * borne supérieure prudente (4 caractères ≈ 1 jeton + enveloppe par message).
 * Sert uniquement à écarter un modèle au contexte trop court, jamais à facturer.
 */
export function estimatePromptTokens(messages: { content: string }[]): number {
  let total = 0;
  for (const message of messages) total += Math.ceil(message.content.length / 4) + 8;
  return total + 16;
}
