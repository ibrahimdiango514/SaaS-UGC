// VYORA AI CORE — lecture du registre (snapshot JSON produit par
// saas_business.bg_ai_registry_snapshot(), réservé au service_role).

import { AI_LEVELS, AiLevel } from './types.ts';

export interface AiRegistryProvider {
  key: string;
  name: string;
  status: string;
  aggregator: boolean;
}

export interface AiRegistryModel {
  provider: string;
  key: string;
  providerModel: string;
  name: string;
  verified: boolean;
  tier: AiLevel | 'standard';
  capabilities: Record<string, boolean>;
  contextIn: number | null;
  maxOut: number | null;
  /** Coût par 1M tokens (USD) — null = prix non publié, jamais inventé. */
  costIn: number | null;
  costOut: number | null;
  rpm: number | null;
  tpm: number | null;
}

export interface AiRegistryRole {
  key: string;
  capabilities: Record<string, boolean>;
  enabled: boolean;
}

export interface AiRegistryRule {
  role: string;
  provider: string;
  model: string;
  priority: number;
}

export interface AiRegistryBudget {
  monthly: number | null;
  alert: number | null;
  daily: number | null;
}

export interface AiRegistrySnapshot {
  version: number;
  providers: AiRegistryProvider[];
  models: AiRegistryModel[];
  roles: AiRegistryRole[];
  rules: AiRegistryRule[];
  budget: AiRegistryBudget;
  monthlySpendUsd: number;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function capMap(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === true) out[k] = true;
  }
  return out;
}

function tierOf(value: unknown): AiLevel | 'standard' {
  return (AI_LEVELS as readonly string[]).includes(String(value)) ? (value as AiLevel) : 'standard';
}

/**
 * Valide et normalise un snapshot. Totalement défensif : tout ce qui n'est
 * pas au format attendu est écarté (le moteur ne doit jamais planter sur un
 * registre partiel — il retombe alors sur son chemin de secours).
 */
export function parseRegistrySnapshot(raw: unknown): AiRegistrySnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;

  const providers: AiRegistryProvider[] = Array.isArray(root.providers)
    ? root.providers.flatMap((p): AiRegistryProvider[] => {
        const r = (p ?? {}) as Record<string, unknown>;
        const key = strOrNull(r.key);
        if (!key) return [];
        return [{
          key,
          name: strOrNull(r.name) ?? key,
          status: strOrNull(r.status) ?? 'unverified',
          aggregator: r.aggregator === true,
        }];
      })
    : [];

  const models: AiRegistryModel[] = Array.isArray(root.models)
    ? root.models.flatMap((m): AiRegistryModel[] => {
        const r = (m ?? {}) as Record<string, unknown>;
        const provider = strOrNull(r.provider);
        const key = strOrNull(r.key);
        const providerModel = strOrNull(r.provider_model);
        if (!provider || !key || !providerModel) return [];
        return [{
          provider,
          key,
          providerModel,
          name: strOrNull(r.name) ?? key,
          verified: r.verified === true,
          tier: tierOf(r.tier),
          capabilities: capMap(r.capabilities),
          contextIn: numOrNull(r.context_in),
          maxOut: numOrNull(r.max_out),
          costIn: numOrNull(r.cost_in),
          costOut: numOrNull(r.cost_out),
          rpm: numOrNull(r.rpm),
          tpm: numOrNull(r.tpm),
        }];
      })
    : [];

  const roles: AiRegistryRole[] = Array.isArray(root.roles)
    ? root.roles.flatMap((r): AiRegistryRole[] => {
        const o = (r ?? {}) as Record<string, unknown>;
        const key = strOrNull(o.key);
        if (!key) return [];
        return [{ key, capabilities: capMap(o.capabilities), enabled: o.enabled !== false }];
      })
    : [];

  const rules: AiRegistryRule[] = Array.isArray(root.rules)
    ? root.rules.flatMap((r): AiRegistryRule[] => {
        const o = (r ?? {}) as Record<string, unknown>;
        const role = strOrNull(o.role);
        const provider = strOrNull(o.provider);
        const model = strOrNull(o.model);
        const priority = numOrNull(o.priority);
        if (!role || !provider || !model || priority === null) return [];
        return [{ role, provider, model, priority }];
      })
    : [];

  const b = (root.budget ?? {}) as Record<string, unknown>;
  const budget: AiRegistryBudget = {
    monthly: numOrNull(b.monthly),
    alert: numOrNull(b.alert),
    daily: numOrNull(b.daily),
  };

  return {
    version: numOrNull(root.version) ?? 1,
    providers,
    models,
    roles,
    rules,
    budget,
    monthlySpendUsd: Math.max(0, numOrNull(root.monthly_spend_usd) ?? 0),
  };
}
