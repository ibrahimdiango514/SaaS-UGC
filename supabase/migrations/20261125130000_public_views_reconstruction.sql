-- ---------------------------------------------------------------------------
-- Reconstruction des vues public que le frontend interroge
-- ---------------------------------------------------------------------------
-- POURQUOI CETTE MIGRATION EXISTE
--
-- Le frontend n'interroge jamais le schéma métier : il passe par des VUES
-- exposées dans `public` (PostgREST n'expose que celui-là). Or ces 40 vues
-- avaient été créées dans le tableau de bord Supabase, jamais dans une migration.
-- Conséquence mesurée le 2026-11-25 : sur un projet neuf reconstruit depuis ce
-- dépôt, TOUTES les lectures du frontend échouent (Studio, Grow, caisse,
-- réglages) alors que les fichiers SQL paraissent complets — les tables existent
-- dans `saas_ugc`, mais rien ne les expose.
--
-- Cette migration comble ce trou pour les vues. Elle est IDEMPOTENTE et sans
-- effet sur la production actuelle : `create or replace view` avec des colonnes
-- identiques. Vérifié avant écriture : les 40 vues de production portent
-- `security_invoker=true`, et leurs définitions sont reproduites à l'identique.
--
-- `security_invoker = true` est INDISPENSABLE, pas décoratif : sans cette option
-- une vue s'exécute avec les droits de son propriétaire et CONTOURNE la RLS des
-- tables sous-jacentes. C'est le piège classique des vues « pratiques » — elles
-- transforment une base cloisonnée en base ouverte.
--
-- CE QUI RESTE ABSENT DU DÉPÔT (voir docs/MIGRATIONS_STATUS.md) : les schémas
-- `saas_ugc` et `ugc_private` eux-mêmes, avec leurs tables, contraintes, index,
-- déclencheurs, politiques et données de référence. Cette migration ne suffit
-- donc PAS à reconstruire un backend complet — elle supprime un échec silencieux
-- pour les vues, pas la dépendance à un vidage du schéma métier.
-- ---------------------------------------------------------------------------

create or replace view public.reelora_audit_logs with (security_invoker = true) as
  select id, actor_user_id, action, target_type, target_id, details, created_at
  from saas_ugc.ugc_audit_logs;

create or replace view public.reelora_avatars with (security_invoker = true) as
  select id, workspace_id, created_by, name, description, provider, provider_avatar_id, voice_id, preview_storage_path, preview_url, language, style, is_default, status, created_at, updated_at
  from saas_ugc.ugc_avatars;

create or replace view public.reelora_generation_presets with (security_invoker = true) as
  select id, workspace_id, created_by, name, config, is_default, created_at, updated_at
  from saas_ugc.ugc_generation_presets;

create or replace view public.reelora_notifications with (security_invoker = true) as
  select id, user_id, title, body, kind, href, read_at, created_at
  from saas_ugc.ugc_notifications;

create or replace view public.reelora_plans with (security_invoker = true) as
  select plan_key, display_name, tagline, monthly_price_minor, currency, monthly_credits, max_projects, max_scripts_per_month, max_prompts_per_month, max_videos_per_month, max_avatars, features, active, sort_order, created_at, updated_at
  from saas_ugc.ugc_plans;

create or replace view public.reelora_prompt_templates with (security_invoker = true) as
  select id, workspace_id, created_by, title, category, content, variables, is_system, is_favorite, usage_count, created_at, updated_at
  from saas_ugc.ugc_prompt_templates;

create or replace view public.reelora_subscriptions with (security_invoker = true) as
  select user_id, plan_key, status, current_period_start, current_period_end, created_at, updated_at
  from saas_ugc.ugc_subscriptions;

create or replace view public.reelora_usage_events with (security_invoker = true) as
  select id, user_id, workspace_id, event_kind, quantity, period_key, reference_id, metadata, created_at
  from saas_ugc.ugc_usage_events;

create or replace view public.reelora_video_models with (security_invoker = true) as
  select model_id, display_name, description, category, endpoint, input_fields, required_fields, param_schema, cost_usd, cost_currency, is_enabled, is_coming_soon, active, sort_order, synced_at, created_at, updated_at, public_id
  from saas_ugc.ugc_video_models;

create or replace view public.ugc_app_settings with (security_invoker = true) as
  select setting_key, setting_value, description, updated_at
  from saas_ugc.ugc_app_settings;

create or replace view public.ugc_brands with (security_invoker = true) as
  select id, workspace_id, name, website_url, industry, description, logo_storage_path, brand_colors, voice_guidelines, created_at, updated_at
  from saas_ugc.ugc_brands;

create or replace view public.ugc_campaign_variants with (security_invoker = true) as
  select id, project_id, variant_number, marketing_angle, platform, language, config, status, created_at, updated_at
  from saas_ugc.ugc_campaign_variants;

create or replace view public.ugc_channel_connections with (security_invoker = true) as
  select id, workspace_id, channel, provider, external_account_id, phone_number_id, display_phone_number, token_secret_ref, webhook_secret_ref, status, settings, connected_at, last_verified_at, created_at, updated_at
  from saas_ugc.ugc_channel_connections;

create or replace view public.ugc_conversations with (security_invoker = true) as
  select id, workspace_id, channel_connection_id, channel, external_contact_id, contact_name, contact_phone_e164, user_id, status, context, last_message_at, created_at, updated_at
  from saas_ugc.ugc_conversations;

create or replace view public.ugc_country_pricing with (security_invoker = true) as
  select country_code, currency, min_amount_minor, max_amount_minor, credits_per_1000_minor, active, updated_at
  from saas_ugc.ugc_country_pricing;

create or replace view public.ugc_credit_ledger with (security_invoker = true) as
  select id, user_id, recharge_order_id, generation_job_id, operation_type, available_delta, reserved_delta, idempotency_key, description, metadata, created_at
  from saas_ugc.ugc_credit_ledger;

create or replace view public.ugc_customer_approvals with (security_invoker = true) as
  select id, generation_job_id, version, status, requested_at, responded_at, approved_by, customer_comment, approval_metadata
  from saas_ugc.ugc_customer_approvals;

create or replace view public.ugc_generated_assets with (security_invoker = true) as
  select id, workspace_id, project_id, generation_job_id, created_by, asset_type, storage_path, mime_type, file_size_bytes, metadata, created_at
  from saas_ugc.ugc_generated_assets;

create or replace view public.ugc_generation_attempts with (security_invoker = true) as
  select id, generation_job_id, attempt_number, provider, model, provider_job_id, status, request_metadata, response_metadata, error_code, error_message, started_at, completed_at, created_at
  from saas_ugc.ugc_generation_attempts;

create or replace view public.ugc_generation_jobs with (security_invoker = true) as
  select id, workspace_id, project_id, created_by, service_key, status, request_payload, result_payload, provider, provider_job_id, credits_reserved, credits_charged, request_key, error_code, error_message, started_at, completed_at, created_at, updated_at, reservation_idempotency_key, retry_count, max_attempts, priority, scheduled_at, last_heartbeat_at, cancellation_requested_at, provider_cost_amount, provider_cost_currency, actual_duration_seconds, approved_at, idempotency_scope
  from saas_ugc.ugc_generation_jobs;

create or replace view public.ugc_job_events with (security_invoker = true) as
  select id, generation_job_id, actor_user_id, event_type, from_status, to_status, payload, created_at
  from saas_ugc.ugc_job_events;

create or replace view public.ugc_messages with (security_invoker = true) as
  select id, conversation_id, direction, message_type, body, media_storage_path, mime_type, provider_message_id, delivery_status, payload, sent_at, created_at
  from saas_ugc.ugc_messages;

create or replace view public.ugc_payment_events with (security_invoker = true) as
  select id, provider, provider_event_id, recharge_order_id, event_type, processing_status, payload, received_at, processed_at
  from saas_ugc.ugc_payment_events;

create or replace view public.ugc_price_versions with (security_invoker = true) as
  select id, service_key, version, credits_cost, estimated_provider_cost, cost_currency, target_gross_margin, pricing_status, valid_from, valid_until, notes, created_by, created_at
  from saas_ugc.ugc_price_versions;

create or replace view public.ugc_products with (security_invoker = true) as
  select id, workspace_id, brand_id, name, description, key_benefits, features, price_amount, price_currency, product_url, reference_image_paths, product_facts, created_at, updated_at
  from saas_ugc.ugc_products;

create or replace view public.ugc_profiles with (security_invoker = true) as
  select user_id, display_name, country_code, preferred_language, created_at, updated_at
  from saas_ugc.ugc_profiles;

create or replace view public.ugc_project_scenes with (security_invoker = true) as
  select id, project_id, script_id, scene_order, duration_seconds, scene_type, visual_prompt, spoken_text, subtitle_text, asset_id, scene_settings, created_at, updated_at
  from saas_ugc.ugc_project_scenes;

create or replace view public.ugc_project_scripts with (security_invoker = true) as
  select id, project_id, version, language, marketing_angle, hook, script_text, call_to_action, claims_to_avoid, status, created_by, created_at
  from saas_ugc.ugc_project_scripts;

create or replace view public.ugc_promo_codes with (security_invoker = true) as
  select id, code, bonus_credits, max_redemptions, per_user_limit, starts_at, expires_at, active, created_at
  from saas_ugc.ugc_promo_codes;

create or replace view public.ugc_promo_redemptions with (security_invoker = true) as
  select id, promo_code_id, user_id, credits_granted, created_at
  from saas_ugc.ugc_promo_redemptions;

create or replace view public.ugc_provider_cost_events with (security_invoker = true) as
  select id, generation_job_id, attempt_id, provider, model, cost_type, amount, currency, quantity, unit, source_reference, metadata, occurred_at, created_at
  from saas_ugc.ugc_provider_cost_events;

create or replace view public.ugc_quality_checks with (security_invoker = true) as
  select id, generation_job_id, asset_id, check_type, status, score, details, checked_by, checked_at
  from saas_ugc.ugc_quality_checks;

create or replace view public.ugc_recharge_orders with (security_invoker = true) as
  select id, user_id, amount_minor, currency, country_code, credits_to_grant, provider, provider_reference, checkout_url, idempotency_key, status, paid_at, created_at, updated_at
  from saas_ugc.ugc_recharge_orders;

create or replace view public.ugc_service_catalog with (security_invoker = true) as
  select service_key, display_name, description, credits_cost, active, config, updated_at
  from saas_ugc.ugc_service_catalog;

create or replace view public.ugc_user_consents with (security_invoker = true) as
  select id, user_id, consent_type, document_version, accepted, source, ip_hash, metadata, created_at
  from saas_ugc.ugc_user_consents;

create or replace view public.ugc_video_projects with (security_invoker = true) as
  select id, workspace_id, brand_id, product_id, created_by, title, brief, campaign_objective, target_audience, target_market, platform, language, aspect_ratio, status, settings, created_at, updated_at
  from saas_ugc.ugc_video_projects;

create or replace view public.ugc_wallets with (security_invoker = true) as
  select user_id, available_balance, reserved_balance, lifetime_purchased, lifetime_bonus, created_at, updated_at
  from saas_ugc.ugc_wallets;

create or replace view public.ugc_webhook_events with (security_invoker = true) as
  select id, channel, provider, provider_event_id, event_type, payload, processing_status, received_at, processed_at, error_message
  from saas_ugc.ugc_webhook_events;

create or replace view public.ugc_workspace_members with (security_invoker = true) as
  select id, workspace_id, user_id, member_role, created_at
  from saas_ugc.ugc_workspace_members;

create or replace view public.ugc_workspaces with (security_invoker = true) as
  select id, owner_user_id, name, country_code, default_language, created_at, updated_at
  from saas_ugc.ugc_workspaces;

-- Droits de lecture : mêmes portées qu'en production, où les 40 vues accordent
-- select aux deux rôles et où la RLS des tables (activée partout, aucune
-- politique `anon`) reste le rempart réel. Les vues n'ouvrent donc rien de plus
-- que les tables : chaque politique est écrite `to authenticated`.
grant select on public.reelora_audit_logs, public.reelora_avatars,
  public.reelora_generation_presets, public.reelora_notifications, public.reelora_plans,
  public.reelora_prompt_templates, public.reelora_subscriptions, public.reelora_usage_events,
  public.reelora_video_models to anon, authenticated;

grant select on public.ugc_app_settings, public.ugc_brands, public.ugc_campaign_variants,
  public.ugc_channel_connections, public.ugc_conversations, public.ugc_country_pricing,
  public.ugc_credit_ledger, public.ugc_customer_approvals, public.ugc_generated_assets,
  public.ugc_generation_attempts, public.ugc_generation_jobs, public.ugc_job_events,
  public.ugc_messages, public.ugc_payment_events, public.ugc_price_versions,
  public.ugc_products, public.ugc_profiles, public.ugc_project_scenes,
  public.ugc_project_scripts, public.ugc_promo_codes, public.ugc_promo_redemptions,
  public.ugc_provider_cost_events, public.ugc_quality_checks, public.ugc_recharge_orders,
  public.ugc_service_catalog, public.ugc_user_consents, public.ugc_video_projects,
  public.ugc_wallets, public.ugc_webhook_events, public.ugc_workspace_members,
  public.ugc_workspaces to anon, authenticated;

notify pgrst, 'reload schema';
