// VYORA AI CORE — routage intelligent.
//
// Sélectionne une chaîne ordonnée de modèles pour une tâche :
//  1. règles de routage du rôle (priorité croissante) — sinon catalogue complet ;
//  2. le fournisseur doit être CONFIGURÉ côté moteur (clé présente) ;
//  3. le modèle doit être VÉRIFIÉ (test API réel passé) — jamais un modèle
//     jamais testé, jamais une capacité incompatible ;
//  4. capacités requises (rôle + demande) respectées ;
//  5. niveau demandé (fast/economy/advanced/specialized/fallback) — repli
//     tolérant si aucun modèle du niveau n'est disponible ;
//  6. budget mensuel : au-delà du budget, seuls les modèles gratuits restent
//     autorisés (gratuit ≠ illimité : le rate limit du fournisseur s'applique
//     toujours) ; budget épuisé → code explicite, aucune réponse inventée ;
//  7. anti-double-routage : un même modèle de base n'est jamais présent deux
//     fois (accès direct ET agrégateur) ; l'agrégateur est un recours, pas un
//     doublon de facturation ;
//  8. chaîne plafonnée (anti-boucle) — le moteur n'essaiera que cette chaîne.

import { modelBaseKey } from './adapters.ts';
import { AiLevel } from './types.ts';
import { AiRegistryModel, AiRegistrySnapshot } from './registry.ts';

export type AiChainSkipReason = 'NO_CONFIGURED_PROVIDER' | 'BUDGET_EXHAUSTED' | 'NO_MATCHING_MODEL' | null;

export interface AiRouteRequest {
  /** Rôle métier (ex. business_advisor) — ses règles + capacités s'appliquent. */
  role?: string | null;
  /** Niveau de service demandé ; 'auto' = tous les niveaux, par ordre d'économie. */
  level?: AiLevel | 'auto' | null;
  /** Capacitions supplémentaires exigées par la demande (outils, JSON…). */
  requireCapabilities?: string[];
  /** Fournisseur préféré (mis en tête de chaîne, sans bloquer le secours). */
  preferProvider?: string | null;
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
}

const TIER_ORDER: Record<string, number> = {
  fast: 0, economy: 1, standard: 2, advanced: 3, specialized: 4, fallback: 5,
};

function hasCapabilities(model: AiRegistryModel, required: string[]): boolean {
  for (const cap of required) if (model.capabilities[cap] !== true) return false;
  return true;
}

function isFree(model: AiRegistryModel): boolean {
  return (model.costIn === null || model.costIn === 0) && (model.costOut === null || model.costOut === 0);
}

export function buildAiChain(
  snapshot: AiRegistrySnapshot,
  request: AiRouteRequest,
  configuredProviders: ReadonlySet<string>,
): { steps: AiChainStep[]; skipReason: AiChainSkipReason } {
  const modelIndex = new Map<string, AiRegistryModel>();
  for (const model of snapshot.models) modelIndex.set(`${model.provider}|${model.key}`, model);
  const providerIndex = new Map(snapshot.providers.map((p) => [p.key, p]));

  const role = (request.role
    ? snapshot.roles.find((r) => r.key === request.role && r.enabled)
    : undefined);
  const roleCaps = role?.capabilities ?? {};
  const requiredCaps: string[] = [
    ...Object.keys(roleCaps).filter((c) => roleCaps[c]),
    ...(request.requireCapabilities ?? []),
  ];

  // — 1. Candidats bruts (règles du rôle, sinon catalogue) —
  type Candidate = { model: AiRegistryModel; priority: number };
  let candidates: Candidate[] = [];
  if (role) {
    candidates = snapshot.rules
      .filter((r) => r.role === role.key)
      .flatMap((r) => {
        const model = modelIndex.get(`${r.provider}|${r.model}`);
        return model ? [{ model, priority: r.priority }] : [];
      });
  } else {
    candidates = snapshot.models.map((model) => ({ model, priority: 0 }));
  }

  // — 2. Fournisseur configuré (clé Edge présente) —
  candidates = candidates.filter((c) => configuredProviders.has(c.model.provider));

  // — 3. Modèle vérifié (test API réel) —
  candidates = candidates.filter((c) => c.model.verified);

  // — 4. Capacités (rôle + demande) —
  candidates = candidates.filter((c) => hasCapabilities(c.model, requiredCaps));

  // — 5. Niveau demandé (repli tolérant) —
  if (request.level && request.level !== 'auto') {
    const atLevel = candidates.filter((c) => c.model.tier === request.level);
    if (atLevel.length) candidates = atLevel;
  }

  // — 6. Budget mensuel —
  const budget = snapshot.budget.monthly;
  if (budget !== null && budget > 0 && snapshot.monthlySpendUsd >= budget) {
    candidates = candidates.filter((c) => isFree(c.model));
  }

  if (!candidates.length) {
    const configured = snapshot.providers.some((p) => configuredProviders.has(p.key));
    const reason: AiChainSkipReason = !configured
      ? 'NO_CONFIGURED_PROVIDER'
      : budget !== null && budget > 0 && snapshot.monthlySpendUsd >= budget
        ? 'BUDGET_EXHAUSTED'
        : 'NO_MATCHING_MODEL';
    return { steps: [], skipReason: reason };
  }

  // — Ordre : priorité, puis agrégateur en dernier, puis niveau, puis coût —
  const costOf = (m: AiRegistryModel): number => (m.costIn === null ? 1e6 : m.costIn);
  candidates.sort((a, b) => {
    const pa = a.priority - b.priority;
    if (pa !== 0) return pa;
    const ga = (providerIndex.get(a.model.provider)?.aggregator === true ? 1 : 0)
      - (providerIndex.get(b.model.provider)?.aggregator === true ? 1 : 0);
    if (ga !== 0) return ga;
    const ta = TIER_ORDER[a.model.tier] - TIER_ORDER[b.model.tier];
    if (ta !== 0) return ta;
    return costOf(a.model) - costOf(b.model);
  });

  // — 7. Anti-double-routage : un modèle de base une seule fois ;
  //     l'agrégateur ne duplique jamais un accès direct déjà présent. —
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of candidates) {
    const base = modelBaseKey(c.model.providerModel);
    if (seen.has(base)) continue;
    seen.add(base);
    deduped.push(c);
  }

  // — Préférence fournisseur (mise en tête, stable) —
  const prefer = request.preferProvider;
  const ordered = prefer
    ? [...deduped.filter((c) => c.model.provider === prefer), ...deduped.filter((c) => c.model.provider !== prefer)]
    : deduped;

  const maxLen = Math.max(1, Math.min(8, request.maxChainLength ?? 4));
  return { steps: ordered.slice(0, maxLen).map((c) => ({
    providerKey: c.model.provider,
    modelKey: c.model.key,
    providerModelKey: c.model.providerModel,
    tier: c.model.tier,
    costIn: c.model.costIn,
    costOut: c.model.costOut,
    priority: c.priority,
    viaAggregator: providerIndex.get(c.model.provider)?.aggregator === true,
  })), skipReason: null };
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
