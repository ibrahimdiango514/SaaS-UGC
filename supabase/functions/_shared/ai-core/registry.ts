// SORAHNEX AI CORE — lecture du registre (snapshot JSON produit par
// saas_business.bg_ai_registry_snapshot(), réservé au service_role).

import { AI_ADAPTER_KINDS, AI_LEVELS, AiAdapterKind, AiLevel } from './types.ts';

export interface AiRegistryProvider {
  key: string;
  name: string;
  status: string;
  aggregator: boolean;
  /** Gabarit de protocole (`openai` | `none`) : un seul protocole servi. */
  adapterKind: AiAdapterKind;
  /** URL de base de l'API, fournie par le registre (jamais par le code). */
  baseUrl: string | null;
  /** Variable d'environnement portant l'URL de base (prioritaire si définie). */
  baseUrlEnv?: string | null;
  /** URL de la liste des modèles (facultative). */
  modelsUrl: string | null;
  /** Nom de la variable d'environnement portant la clé (jamais la valeur). */
  apiKeyEnv: string | null;
  /** Nom de la variable portant l'identifiant de compte, si requis. */
  accountIdEnv: string | null;
  /** En-têtes supplémentaires déclarés au registre (attribution, version). */
  headers: Record<string, string>;
  /** Voie d'appel déclarée au registre : API officielle ou passerelle. */
  transport: 'rest' | 'gateway';
  /** Variable portant l'identifiant de passerelle (Cloudflare), si requise. */
  gatewayIdEnv: string | null;
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

/**
 * Clé de fournisseur valide — même règle que la contrainte SQL
 * (`provider_key ~ ^[a-z][a-z0-9_-]{1,39}$`). Une clé mal formée est écartée :
 * elle servirait à construire une URL et un nom de variable d'environnement.
 */
function providerKeyOrNull(value: unknown): string | null {
  const key = strOrNull(value);
  return key && /^[a-z][a-z0-9_-]{1,39}$/.test(key) ? key : null;
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
 * Gabarit de protocole d'un fournisseur.
 *
 * Le registre peut ne pas le fournir (ligne antérieure à son introduction) :
 * on retombe alors sur `openai`, protocole majoritaire, et le moteur vérifie
 * l'URL avant d'envoyer quoi que ce soit. `none` reste possible pour déclarer
 * un protocole exotique : le fournisseur est alors listé mais jamais appelé.
 */
function adapterKindOf(value: unknown): AiAdapterKind {
  const raw = String(value ?? '').toLowerCase();
  return (AI_ADAPTER_KINDS as readonly string[]).includes(raw) ? (raw as AiAdapterKind) : 'openai';
}

/** En-têtes supplémentaires : uniquement des chaînes non vides. */
function headerMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string' && val.trim()) out[key] = val;
  }
  return out;
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
        const key = providerKeyOrNull(r.key);
        if (!key) return [];
        return [{
          key,
          name: strOrNull(r.name) ?? key,
          status: strOrNull(r.status) ?? 'unverified',
          aggregator: r.aggregator === true,
          adapterKind: adapterKindOf(r.adapter_kind),
          baseUrl: strOrNull(r.base_url),
          baseUrlEnv: strOrNull(r.base_url_env),
          modelsUrl: strOrNull(r.models_url),
          apiKeyEnv: strOrNull(r.api_key_env),
          accountIdEnv: strOrNull(r.account_id_env),
          gatewayIdEnv: strOrNull(r.gateway_id_env),
          transport: String(r.transport ?? '').toLowerCase() === 'gateway' ? 'gateway' : 'rest',
          headers: headerMap(r.headers),
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
