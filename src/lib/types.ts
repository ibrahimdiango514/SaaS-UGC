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
  type: 'select' | 'number' | 'boolean';
  label?: string;
  options?: (string | number)[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
}

/** Catalog row from GET reelora-video { action: "models" } (curated + live metadata). */
export interface MuApiModel {
  model_id: string;
  display_name: string;
  description: string | null;
  category: 'Text to Video' | 'Image to Video' | string;
  endpoint: string;
  input_fields: string[];
  required_fields: string[];
  param_schema: Record<string, MuApiParamDef>;
  cost_usd: number | string | null;
  cost_currency: string;
  is_enabled: boolean;
  is_coming_soon: boolean;
  synced_at?: string | null;
}

/** Explicit credit / provider cost shown BEFORE the user confirms. */
export interface VideoCostEstimate {
  service_key: string;
  credits_cost: number;
  service_active: boolean;
  model_id: string | null;
  model_available: boolean;
  provider_cost_usd: number | string | null;
  provider_cost_currency: string;
}

export interface VideoActionResult {
  job_id: string;
  status: string;
  provider?: string;
  provider_job_id?: string | null;
  provider_state?: string;
  model_id?: string;
  progress?: number;
  preview_url?: string | null;
  storage_path?: string;
  provider_cost?: Json | null;
  webhook_enabled?: boolean;
  message?: string;
  error?: string | null;
}
