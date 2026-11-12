export type Json = Record<string, unknown>;

export interface Profile {
  user_id: string;
  display_name: string | null;
  country_code: string;
  preferred_language: string;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  owner_user_id: string;
  name: string;
  country_code: string;
  default_language: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  member_role: 'owner' | 'admin' | 'editor' | 'viewer';
  created_at: string;
}

export interface Plan {
  plan_key: string;
  display_name: string;
  tagline: string | null;
  monthly_price_minor: number;
  currency: string;
  monthly_credits: number;
  max_projects: number;
  max_scripts_per_month: number;
  max_prompts_per_month: number;
  max_videos_per_month: number;
  max_avatars: number;
  features: string[];
  active: boolean;
  sort_order: number;
}

export interface Subscription {
  user_id: string;
  plan_key: string;
  status: 'active' | 'suspended' | 'cancelled' | 'pending_payment';
  current_period_start: string;
  current_period_end: string;
}

export interface QuotaStatus {
  plan: Plan;
  status: string;
  credits: number;
  period: string;
  projects: number;
  avatars: number;
  usage: Record<string, number>;
  period_end: string;
}

export interface Project {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  product_id: string | null;
  created_by: string;
  title: string;
  brief: string | null;
  campaign_objective: string | null;
  target_audience: string | null;
  target_market: string | null;
  platform: string | null;
  language: string;
  aspect_ratio: string;
  status: 'draft' | 'queued' | 'generating' | 'completed' | 'failed' | 'archived';
  settings: Json;
  created_at: string;
  updated_at: string;
}

export interface Script {
  id: string;
  project_id: string;
  version: number;
  language: string;
  marketing_angle: string | null;
  hook: string | null;
  script_text: string;
  call_to_action: string | null;
  claims_to_avoid: string[];
  status: 'draft' | 'approved' | 'superseded';
  created_by: string | null;
  created_at: string;
}

export interface Scene {
  id: string;
  project_id: string;
  script_id: string | null;
  scene_order: number;
  duration_seconds: number;
  scene_type: string;
  visual_prompt: string | null;
  spoken_text: string | null;
  subtitle_text: string | null;
  asset_id: string | null;
  scene_settings: Json;
  created_at: string;
}

export interface Avatar {
  id: string;
  workspace_id: string;
  created_by: string;
  name: string;
  description: string | null;
  /** `legacy` preserves already-stored rows without exposing a retired provider name. */
  provider: 'muapi' | 'custom' | 'legacy';
  provider_avatar_id: string | null;
  voice_id: string | null;
  preview_storage_path: string | null;
  preview_url: string | null;
  language: string;
  style: Json;
  is_default: boolean;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface PromptTemplate {
  id: string;
  workspace_id: string | null;
  created_by: string | null;
  title: string;
  category: 'script' | 'hook' | 'cta' | 'scene' | 'visual' | 'system';
  content: string;
  variables: string[];
  is_system: boolean;
  is_favorite: boolean;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export interface GenerationPreset {
  id: string;
  workspace_id: string;
  created_by: string;
  name: string;
  config: Json;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface Brand {
  id: string;
  workspace_id: string;
  name: string;
  website_url: string | null;
  industry: string | null;
  description: string | null;
  logo_storage_path: string | null;
  brand_colors: string[];
  voice_guidelines: string | null;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  name: string;
  description: string | null;
  key_benefits: string[];
  features: string[];
  price_amount: number | null;
  price_currency: string | null;
  product_url: string | null;
  reference_image_paths: string[];
  product_facts: Json;
  created_at: string;
  updated_at: string;
}

export interface ServiceCatalogItem {
  service_key: string;
  display_name: string;
  description: string | null;
  credits_cost: number;
  active: boolean;
  config: Json;
}

export interface GenerationJob {
  id: string;
  workspace_id: string;
  project_id: string | null;
  created_by: string;
  service_key: string;
  status: 'queued' | 'reserved' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  request_payload: Json;
  result_payload: Json;
  provider: string | null;
  provider_job_id: string | null;
  credits_reserved: number;
  credits_charged: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface GeneratedAsset {
  id: string;
  workspace_id: string;
  project_id: string | null;
  generation_job_id: string | null;
  created_by: string;
  asset_type: string;
  storage_path: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  metadata: Json;
  created_at: string;
}

export interface LedgerEntry {
  id: string;
  user_id: string;
  operation_type: string;
  available_delta: number;
  reserved_delta: number;
  description: string | null;
  created_at: string;
}

export interface RechargeOrder {
  id: string;
  user_id: string;
  amount_minor: number;
  currency: string;
  country_code: string;
  credits_to_grant: number;
  provider: string;
  status: string;
  provider_reference: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface AppNotification {
  id: string;
  user_id: string;
  title: string;
  body: string | null;
  kind: 'info' | 'success' | 'warning' | 'error' | 'admin_request';
  href: string | null;
  read_at: string | null;
  created_at: string;
}

export interface AdminUser {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  display_name: string | null;
  country_code: string | null;
  preferred_language: string | null;
  plan_key: string | null;
  subscription_status: string | null;
  credits: number;
  roles: string[];
  projects: number;
  videos: number;
}

export interface AdminOverview {
  users: number;
  projects: number;
  jobs: number;
  jobs_succeeded: number;
  jobs_failed: number;
  credits_charged: number;
  credits_available: number;
  pending_recharges: number;
  assets: number;
  jobs_by_status: Record<string, number>;
  usage_this_month: Record<string, number>;
}

export interface AiScene {
  scene_type: string;
  duration_seconds: number;
  visual_prompt: string;
  spoken_text: string;
  subtitle_text: string;
  scene_settings?: Json;
}

export interface AiScriptResult {
  action: string;
  hook: string;
  script_text: string;
  call_to_action: string;
  marketing_angle: string;
  claims_to_avoid: string[];
  scenes: AiScene[];
  script_id: string | null;
  scenes_saved: number;
}

/** A parameter actually supported by one verified MuAPI video model. */
export interface MuApiParamDef {
  type: 'select' | 'number' | 'boolean' | 'string' | 'array' | 'object';
  label?: string;
  description?: string;
  options?: (string | number)[];
  min?: number;
  max?: number;
  step?: number;
  default?: string | number | boolean;
  required?: boolean;
}

export type ReeloraModelStatus = 'active' | 'disabled' | 'coming_soon' | 'unsupported' | 'unverified';
export type MuApiAccountAccess = 'account' | 'public_only' | 'unverified';

/** Catalog row from GET reelora-video { action: "catalog" } (live MuAPI metadata). */
export interface MuApiModel {
  model_id: string;
  display_name: string;
  description: string | null;
  category: string;
  endpoint?: string;
  input_fields: string[];
  required_fields: string[];
  param_schema: Record<string, MuApiParamDef>;
  cost_usd?: number | string | null;
  cost_currency?: string;
  is_enabled: boolean;
  is_coming_soon: boolean;
  sort_order?: number;
  synced_at?: string | null;
  family?: string | null;
  group_of?: string | null;
  domain?: string | null;
  cost_strategy?: string | null;
  dynamic_pricing?: boolean;
  endpoint_url?: string | null;
  estimate_endpoint?: string | null;
  source?: string | null;
  reelora_status?: ReeloraModelStatus;
  reelora_reason?: string;
  account_access?: MuApiAccountAccess;
}

/** Read-only diagnostics explaining the difference between public and account catalogue. */
export interface VideoCatalogDiagnostics {
  fetched_at: string;
  detected_video: number;
  active: number;
  unavailable: number;
  verified: boolean;
  error?: string | null;
}

export interface VideoCatalogResponse {
  models: MuApiModel[];
  catalog: VideoCatalogDiagnostics;
}

export interface AdminVideoCatalogResponse {
  models: MuApiModel[];
  catalog: {
    source: string;
    fetched_at: string;
    public_total: number | null;
    authenticated_total: number | null;
    detected_video: number;
    active: number;
    unavailable: number;
    verified?: boolean;
    reasons?: Record<string, number>;
    endpoints?: string[];
    error?: string | null;
    account: {
      key_configured: boolean;
      key_valid: boolean;
      catalog_status: number | null;
      balance_status: number | null;
      keys_status: number | null;
      key_is_test: boolean | null;
      error?: string | null;
    };
  };
}

export interface AdminProviderSpendEntry {
  id: string;
  generation_job_id: string;
  provider: string;
  model_id: string;
  provider_request_id: string | null;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  status: 'reserved' | 'submitted' | 'unknown' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
  reason_code: string | null;
  created_at: string;
  completed_at: string | null;
}

export type ProviderSpendAlertState = 'ok' | 'threshold' | 'cap_reached' | 'disabled';

export interface AdminProviderSpendAlert {
  id: string;
  provider: string | null;
  kind: 'threshold' | 'cap_exceeded' | 'blocked_attempt' | 'cap_reached';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  reason: string;
  created_at: string;
  acknowledged_at: string | null;
}

export interface AdminProviderSpendSummary {
  enabled: boolean;
  max_usd: number;
  /** Seuil d'alerte en pourcentage du plafond global (0 = alertes désactivées). */
  alert_percent: number;
  /** Plafonds optionnels par fournisseur ; absent = seul le plafond global s'applique. */
  provider_caps_usd: Record<string, number>;
  alert_state: ProviderSpendAlertState;
  actual_spent_usd: number;
  reserved_usd: number;
  estimated_unpriced_usd: number;
  committed_usd: number;
  remaining_usd: number;
  tests_count: number;
  blocked_count: number;
  by_provider: {
    provider: string;
    actual_spent_usd: number;
    reserved_usd: number;
    committed_usd: number;
    /** Plafond dédié au fournisseur (chaîne numérique SQL) ou null. */
    cap_usd: string | null;
    remaining_usd: number | null;
  }[];
  alerts: AdminProviderSpendAlert[];
  history: AdminProviderSpendEntry[];
}

/** Opaque customer quote; provider costs and supplier diagnostics stay server-side. */
export type ProviderQuoteSource = 'provider_estimate' | 'catalog_tariff' | 'none';

/**
 * Devis fournisseur réel (MuAPI). `available=false` signifie qu'AUCUN montant
 * n'a pu être vérifié : l'interface ne doit jamais afficher de prix inventé.
 */
export interface ProviderQuote {
  available: boolean;
  cost_usd: number | null;
  currency: 'USD' | null;
  source: ProviderQuoteSource;
  error_code: string | null;
  error_message: string | null;
  checked_at: string;
  catalog_synced_at: string | null;
  stale_catalog: boolean;
  pricing_basis: Record<string, string | number | boolean>;
  billing_units: string[];
  estimate_endpoint_available: boolean;
}

export interface VideoCostEstimate {
  service_key: string;
  credits_cost: number;
  service_active: boolean;
  model_id: string | null;
  model_available: boolean;
  model_status?: ReeloraModelStatus;
  model_reason?: string | null;
  pricing_available: boolean;
  pricing_error?: string | null;
  quote_id?: string | null;
  quote_expires_at?: string | null;
  /** Devis fournisseur exact, calculé côté serveur, avant toute génération. */
  provider_quote?: ProviderQuote | null;
}

export interface VideoActionResult {
  job_id: string;
  status: string;
  provider_state?: string;
  model_id?: string;
  progress?: number;
  preview_url?: string | null;
  storage_path?: string;
  message?: string;
  error?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Métriques administrateur (RPC vyora_admin_metrics, lecture seule)          */
/* -------------------------------------------------------------------------- */

export interface AdminMetricMonth {
  month: string;
}

export interface AdminRevenueMonth extends AdminMetricMonth {
  collected_minor: number;
  orders: number;
}

export interface AdminMrrMonth extends AdminMetricMonth {
  mrr_minor: number;
  new_mrr_minor: number;
  lost_mrr_minor: number;
  net_mrr_minor: number;
  active_subscriptions: number;
}

export interface AdminCountMonth extends AdminMetricMonth {
  count: number;
}

export interface AdminStudioMonth extends AdminMetricMonth {
  jobs: number;
  succeeded: number;
  failed: number;
  credits_charged: number;
}

export interface AdminGrowthMonth extends AdminMetricMonth {
  requests: number;
  succeeded: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  provider_cost_micros: number;
}

export interface AdminProviderAttempts {
  provider_key: string;
  attempts: number;
  succeeded: number;
  failed: number;
  provider_cost_micros: number;
  last_attempt_at: string | null;
}

export interface AdminStudioCostEvent {
  provider: string;
  currency: string;
  amount: number | string;
  events: number;
  last_event_at: string | null;
}

export interface AdminMetrics {
  generated_at: string;
  months: number;
  period_start: string;
  period_end: string;
  history: {
    first_activity_at: string | null;
    exploitable_from: string;
    has_history: boolean;
    months_of_history: number;
  };
  revenue: {
    currency: string;
    collected_total_minor: number;
    collected_orders: number;
    pending_orders: number;
    by_month: AdminRevenueMonth[];
  };
  mrr: {
    currency: string;
    current_minor: number;
    active_recurring_subscriptions: number;
    by_month: AdminMrrMonth[];
  };
  subscriptions: {
    total: number;
    active: number;
    cancelled: number;
    by_plan: Array<{ plan_key: string; plan_name: string; status: string; count: number; monthly_price_minor: number }>;
    new_by_month: AdminCountMonth[];
    cancelled_by_month: AdminCountMonth[];
  };
  users: {
    customers: number;
    with_subscription: number;
    new_by_month: AdminCountMonth[];
  };
  studio: {
    jobs_total: number;
    jobs_succeeded: number;
    jobs_failed: number;
    credits_charged_total: number;
    usage_by_kind: Record<string, number>;
    by_month: AdminStudioMonth[];
  };
  business_growth: {
    requests_total: number;
    requests_succeeded: number;
    requests_failed: number;
    conversations: number;
    messages: number;
    memory_items: number;
    tool_executions: number;
    tokens_total: number;
    by_month: AdminGrowthMonth[];
  };
  providers: {
    business_growth: AdminProviderAttempts[];
    studio_cost_events: AdminStudioCostEvent[];
  };
  models: {
    total: number;
    selectable: number;
    coming_soon: number;
    synced_at: string | null;
  };
}

/* -------------------------------------------------------------------------- */
/* Opérations de crédits administrateur (RPC transactionnelles)               */
/* -------------------------------------------------------------------------- */

export interface AdminCreditMovement {
  user_id: string;
  delta: number;
  requested_delta: number;
  reason: string;
  balance_before: number;
  balance_after: number;
  ledger_id: string;
  replayed: boolean;
  actor_user_id: string;
  applied_at: string;
}

export interface AdminCreditHistoryEntry {
  id: string;
  delta: number;
  reserved_delta: number;
  operation: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AdminCreditHistory {
  user_id: string;
  balance: number;
  reserved: number;
  entries: AdminCreditHistoryEntry[];
}
