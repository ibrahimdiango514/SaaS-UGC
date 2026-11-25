import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// PGlite rejoue plusieurs migrations à chaque test : le budget par défaut de
// 15 s ne suffit plus, l'initialisation seule prenant ~2 à 3 s.
vi.setConfig({ testTimeout: 60000 });

/**
 * Quotas extensibles et droits d'abonnement (migration
 * `…_studio_quota_plan_policy`), sur une vraie base Postgres (PGlite).
 *
 * Ce que ces tests prouvent :
 *   - la famille de quota est une DONNÉE (règles ordonnées), pas un codage
 *     spécial par modèle ; une catégorie inconnue reste refusée ;
 *   - les quotas historiques (script/prompt/vidéo/image/export) sont repris à
 *     l'identique, aucune valeur nouvelle n'est appliquée ;
 *   - une politique non approuvée n'est JAMAIS consommée silencieusement ;
 *   - une limite approuvée est appliquée, avec événement au bon type ;
 *   - la préparation persiste une famille audio/3D/LoRA et n'accorde un plan
 *     que si le droit correspondant est approuvé.
 */
const prepareMigration = readFileSync('supabase/migrations/20261120210000_studio_runtime_prepare.sql', 'utf8');
const policyMigration = readFileSync('supabase/migrations/20261120230000_studio_quota_plan_policy.sql', 'utf8');
const lot16Migration = readFileSync('supabase/migrations/20261121000000_studio_family_policy_lot16.sql', 'utf8');
const lot17Migration = readFileSync('supabase/migrations/20261121010000_studio_json_result_training_lot17.sql', 'utf8');

const VIDEO = '11111111-1111-4111-8111-111111111111';
const AUDIO = '22222222-2222-4222-8222-222222222222';
const THREE_D = '33333333-3333-4333-8333-333333333333';
const LORA = '44444444-4444-4444-8444-444444444444';
const TOOL = '55555555-5555-4555-8555-555555555555';
const UID = '66666666-6666-4666-8666-666666666666';

const pricing = (model: string, over: Record<string, unknown> = {}) => ({
  cost_usd: 0.1, currency: 'USD', dynamic_pricing: true,
  estimate_path: `/api/v1/models/${model}/estimate-cost`, ...over,
});

async function database() {
  const db = new PGlite();
  await db.exec(`create schema saas_ugc; create schema ugc_private; create schema auth;
    create role anon; create role authenticated; create role service_role;
    create function auth.role() returns text language sql as $$ select current_setting('test.role',true) $$;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create function ugc_private.reelora_assert_active() returns void language plpgsql as $$
      begin if (select auth.uid()) is null then raise exception 'not_authenticated'; end if; end $$;
    create function ugc_private.reelora_assert_admin() returns void language plpgsql as $$
      begin if current_setting('test.admin',true) is distinct from 'yes' then raise exception 'forbidden'; end if; end $$;
    create function ugc_private.studio_spec_hash(p_id uuid) returns text language sql stable as $$ select 'hash'::text $$;
    create table saas_ugc.ugc_app_settings(setting_key text primary key, setting_value jsonb, updated_at timestamptz default now());
    insert into saas_ugc.ugc_app_settings(setting_key,setting_value) values('studio_pricing_config',
      '{"usd_to_xof":620,"credit_value_xof":100,"target_margin_percent":60,"processing_cost_usd":0.01}'::jsonb);
    create table saas_ugc.ugc_plans(
      plan_key text primary key, display_name text not null, sort_order integer not null default 0,
      active boolean not null default true, max_scripts_per_month integer not null default 1,
      max_prompts_per_month integer not null default 1, max_videos_per_month integer not null default 0);
    insert into saas_ugc.ugc_plans(plan_key,display_name,sort_order,max_scripts_per_month,max_prompts_per_month,max_videos_per_month) values
      ('free','Découverte',1,5,5,1),('studio','Studio',2,80,60,20),('pro','Pro',3,400,300,80),('enterprise','Entreprise',4,5000,5000,1000);
    create table saas_ugc.ugc_subscriptions(user_id uuid, plan_key text, status text, current_period_end timestamptz);
    insert into saas_ugc.ugc_subscriptions values('${UID}','pro','active',now()+interval '1 month');
    create table saas_ugc.ugc_usage_events(
      id uuid primary key default gen_random_uuid(), user_id uuid not null, workspace_id uuid,
      event_kind text not null constraint ugc_usage_events_event_kind_check
        check (event_kind in ('script','prompt','video','image','export')),
      quantity integer not null default 1, period_key text not null, reference_id uuid,
      metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
    create table saas_ugc.studio_ai_models(
      id uuid primary key, provider_key text not null, provider_model_id text not null,
      input_schema jsonb, output_schema jsonb, endpoint_evidence jsonb default '{}'::jsonb,
      provider_enabled boolean default true, coming_soon boolean default false, public_catalog_present boolean default true,
      account_access text not null default 'unverified', category text, metadata jsonb default '{}'::jsonb,
      updated_at timestamptz default now());
    create table saas_ugc.studio_model_integrations(
      model_id uuid primary key, status text, family text, protocol text, spec_hash text);
    create table saas_ugc.studio_runtime_configs(model_id uuid primary key,
      credits integer, max_cost_usd numeric, quota_kind text not null default 'video'
        constraint studio_runtime_configs_quota_kind_check check (quota_kind in ('video','image','script')),
      allowed_plans text[] not null default '{}',
      enabled boolean not null default false, adapter text not null default 'muapi_prediction_v1', output_kind text not null default 'media',
      estimate_path text, revision integer not null default 1, verified_hash text, verification_reference text,
      verified_at timestamptz, updated_at timestamptz default now());
    create table saas_ugc.studio_ai_model_details(model_id uuid primary key, status text, http_status integer, checked_at timestamptz default now());
    create table saas_ugc.studio_ai_catalog_syncs(id uuid primary key default gen_random_uuid(),
      provider_key text, source_scope text, synced_at timestamptz default now());
    create table saas_ugc.studio_runtime_limits(id boolean primary key default true check(id), enabled boolean not null default false,
      daily_usd numeric not null default 0, sync_enabled boolean not null default true);
    insert into saas_ugc.studio_runtime_limits(id) values(true);
    -- Tables minimales du parcours de génération : la migration du lot 16
    -- remplace les fonctions de devis/réservation pour le tarif gratuit, et
    -- PostgreSQL valide leur corps à la création.
    create table saas_ugc.studio_runtime_quotes(id uuid primary key default gen_random_uuid(), user_id uuid, model_id uuid,
      params jsonb, spec_hash text, config_revision integer, credits integer, estimated_usd numeric,
      expires_at timestamptz not null default now()+interval '10 minutes', created_at timestamptz default now());
    create table saas_ugc.studio_runtime_jobs(id uuid primary key default gen_random_uuid(), user_id uuid, workspace_id uuid,
      quote_id uuid, request_key uuid, model_id uuid, status text, credits integer, estimated_usd numeric, actual_usd numeric,
      quota_kind text, output_kind text, provider_id text, protocol_key text, result_field text, error_code text, outputs jsonb,
      poll_after timestamptz, reservation_deadline timestamptz default now()+interval '1 day',
      created_at timestamptz default now(), updated_at timestamptz default now());
    create table saas_ugc.studio_runtime_requests(id uuid primary key default gen_random_uuid(), created_at timestamptz default now());
    create function public.studio_runtime_access() returns jsonb language sql stable as $$
      select jsonb_build_object('plan','pro','workspace_id','22222222-2222-4222-8222-222222222222') $$;
    create function ugc_private.apply_wallet_delta(p_user uuid, p_kind text, p_delta bigint, p_reserved bigint, p_reference text, p_reason text, p_metadata jsonb default '{}'::jsonb)
      returns void language plpgsql as $$ begin return; end $$;
    insert into saas_ugc.studio_ai_models(id,provider_key,provider_model_id,category,endpoint_evidence,account_access,metadata) values
      ('${VIDEO}','muapi','clip-model','Text to Video','{"endpoint":"/api/v1/clip-model","resolution":{"status":"resolved","path":"clip-model"}}'::jsonb,'available','{}'),
      ('${AUDIO}','muapi','sound-model','Text to Audio','{"endpoint":"/api/v1/sound-model","resolution":{"status":"resolved","path":"sound-model"}}'::jsonb,'available','{}'),
      ('${THREE_D}','muapi','mesh-model','Image to 3D','{"endpoint":"/api/v1/mesh-model","resolution":{"status":"resolved","path":"mesh-model"}}'::jsonb,'available','{}'),
      ('${LORA}','muapi','lora-model','LoRA inference','{"endpoint":"/api/v1/lora-model","resolution":{"status":"resolved","path":"lora-model"}}'::jsonb,'available','{}'),
      ('${TOOL}','muapi','watermark-model','Image','{"endpoint":"/api/v1/watermark-model","resolution":{"status":"resolved","path":"watermark-model"}}'::jsonb,'available','{"group_of":"utility"}');
    insert into saas_ugc.studio_model_integrations(model_id,status,family,protocol,spec_hash) values
      ('${VIDEO}','integration_prepared','text-to-video','muapi_output_media_v1','hash'),
      ('${AUDIO}','integration_prepared','audio-generation','muapi_output_media_v1','hash'),
      ('${THREE_D}','integration_prepared','image-to-3d','muapi_output_media_v1','hash'),
      ('${LORA}','integration_prepared','lora-inference','muapi_output_media_v1','hash'),
      ('${TOOL}','integration_prepared','utility','muapi_output_media_v1','hash');`);
  await db.exec(prepareMigration);
  await db.exec(policyMigration);
  await db.exec(lot16Migration);
  await db.exec(lot17Migration);
  await db.exec(`update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify(pricing('clip-model'))}'::jsonb where id='${VIDEO}';
    update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify(pricing('sound-model', { cost_usd: 0.25 }))}'::jsonb where id='${AUDIO}';
    update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify(pricing('mesh-model', { cost_usd: 0.4 }))}'::jsonb where id='${THREE_D}';
    update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify(pricing('lora-model', { cost_usd: 0.05 }))}'::jsonb where id='${LORA}';
    update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify(pricing('watermark-model', { cost_usd: 0.02 }))}'::jsonb where id='${TOOL}';
    set test.role='service_role'; set test.uid='${UID}';`);
  return db;
}

const family = (db: PGlite, category: string, metadata = {}) =>
  db.query<{ family: string | null }>(
    `select ugc_private.studio_quota_family($1,null,$2::jsonb) as family`, [category, JSON.stringify(metadata)]);
const prepare = (db: PGlite, id: string) =>
  db.query<{ result: { remaining: string[]; [key: string]: unknown } }>('select public.studio_prepare_runtime($1) as result', [id]);

describe('familles de quota, droits et consommation', () => {
  it('résout les familles par règles de données, sans condition par modèle', async () => {
    const db = await database();
    try {
      expect((await family(db, 'Text to Audio')).rows[0].family).toBe('audio');
      expect((await family(db, 'Music Generation')).rows[0].family).toBe('music');
      expect((await family(db, 'Text to Speech')).rows[0].family).toBe('voice');
      expect((await family(db, 'Image to 3D')).rows[0].family).toBe('model_3d');
      expect((await family(db, 'LoRA inference')).rows[0].family).toBe('lora');
      expect((await family(db, 'Text to Text')).rows[0].family).toBe('script');
      expect((await family(db, 'Text to Video')).rows[0].family).toBe('video');
      // Un utilitaire fournisseur n'est jamais un générateur, même « Image ».
      expect((await family(db, 'Image', { group_of: 'utility' })).rows[0].family).toBe('tool');
      // Une catégorie inconnue n'est jamais rattachée d'office.
      expect((await family(db, 'Something unmapped')).rows[0].family).toBeNull();
    } finally { await db.close(); }
  });

  it('reprend les quotas historiques sans inventer de limite', async () => {
    const db = await database();
    try {
      const rows = await db.query<{ plan_key: string; family: string; monthly_limit: number; approved: boolean }>(
        `select plan_key,family,monthly_limit,approved from saas_ugc.studio_plan_quotas
          where plan_key='pro' and family in ('script','prompt','video','image','export') order by family`);
      expect(rows.rows).toEqual([
        { plan_key: 'pro', family: 'export', monthly_limit: 100, approved: true },
        { plan_key: 'pro', family: 'image', monthly_limit: 160, approved: true },
        { plan_key: 'pro', family: 'prompt', monthly_limit: 300, approved: true },
        { plan_key: 'pro', family: 'script', monthly_limit: 400, approved: true },
        { plan_key: 'pro', family: 'video', monthly_limit: 80, approved: true },
      ]);
      const proposed = await db.query<{ n: number }>(
        `select count(*)::int n from saas_ugc.studio_plan_quotas where family in ('audio','music','voice','model_3d','lora','tool') and approved`);
      expect(proposed.rows[0].n).toBe(0);
    } finally { await db.close(); }
  });

  it('refuse une politique non approuvée puis applique la limite approuvée', async () => {
    const db = await database();
    try {
      await db.exec(`set test.role='authenticated'`);
      await expect(db.query(`select public.reelora_consume_quota('audio')`)).rejects.toThrow('quota_policy_missing:audio');
      // L'administration approuve explicitement 2 audios pour Pro.
      await db.exec(`set test.admin='yes'`);
      await db.query(`select public.studio_set_plan_quota('pro','audio',2,true,true)`);
      const first = await db.query<{ r: Record<string, unknown> }>(`select public.reelora_consume_quota('audio','${UID}'::uuid) as r`);
      expect(first.rows[0].r).toMatchObject({ family: 'audio', used: 1, limit: 2, remaining: 1, plan: 'pro' });
      await db.query(`select public.reelora_consume_quota('audio')`);
      await expect(db.query(`select public.reelora_consume_quota('audio')`)).rejects.toThrow('quota_exceeded:audio:2:2');
      const events = await db.query<{ event_kind: string; n: number }>(
        `select event_kind, count(*)::int n from saas_ugc.ugc_usage_events group by event_kind`);
      expect(events.rows).toEqual([{ event_kind: 'audio', n: 2 }]);
    } finally { await db.close(); }
  });

  it('refuse d’approuver un quota incomplet', async () => {
    const db = await database();
    try {
      await db.exec(`set test.admin='yes'`);
      await expect(db.query(`select public.studio_set_plan_quota('pro','audio',null,true,true)`)).rejects.toThrow('approved_quota_incomplete');
      await expect(db.query(`select public.studio_set_plan_quota('pro','audio',0,true,true)`)).rejects.toThrow('approved_quota_incomplete');
      await expect(db.query(`select public.studio_set_plan_family('pro','unknown',true,true)`)).rejects.toThrow('invalid_family');
    } finally { await db.close(); }
  });

  it('persiste audio, 3D, LoRA et outil, sans activer ni accorder de plan par défaut', async () => {
    const db = await database();
    try {
      for (const [id, expected] of [[AUDIO, 'audio'], [THREE_D, 'model_3d'], [LORA, 'lora'], [TOOL, 'tool']] as const) {
        const { rows } = await prepare(db, id);
        expect(rows[0].result).toMatchObject({ quota_kind: expected, enabled: false, verified: false, changed: true });
        expect(rows[0].result).toMatchObject({ plans: [] });
        expect(rows[0].result.remaining).toEqual(expect.arrayContaining(['PLAN_UNAVAILABLE', 'QUOTA_POLICY_MISSING', 'PAID_VALIDATION_PENDING']));
      }
    } finally { await db.close(); }
  });

  it('accorde un plan uniquement quand le droit est approuvé', async () => {
    const db = await database();
    try {
      await prepare(db, AUDIO);
      // Une validation payée déjà enregistrée ne doit pas être effacée par la
      // seule attribution d'un plan : le contrat fournisseur ne change pas.
      await db.exec(`update saas_ugc.studio_runtime_configs set verified_hash='hash', verified_at=now(), verification_reference='preuve existante'`);
      await db.exec(`set test.admin='yes'`);
      await db.query(`select public.studio_set_plan_family('pro','audio',true,true)`);
      await db.query(`select public.studio_set_plan_quota('pro','audio',10,true,true)`);
      await db.exec(`set test.role='service_role'`);
      const { rows } = await prepare(db, AUDIO);
      expect(rows[0].result).toMatchObject({ plans: ['pro'], quota_policy: true, enabled: false, verified: true });
      expect(rows[0].result.remaining).not.toContain('PLAN_UNAVAILABLE');
      expect(rows[0].result.remaining).not.toContain('QUOTA_POLICY_MISSING');
      expect(rows[0].result.remaining).toContain('PAID_VALIDATION_PENDING');
    } finally { await db.close(); }
  });

  it('compte les mêmes états que le runtime, sans activer ni certifier', async () => {
    const db = await database();
    try {
      for (const id of [VIDEO, AUDIO, THREE_D, LORA, TOOL]) await prepare(db, id);
      await db.exec(`set test.admin='yes'`);
      const summary = await db.query<{ s: Record<string, number> }>(`select public.studio_catalog_admin_summary() as s`);
      expect(summary.rows[0].s).toMatchObject({ models: 5, prepared: 5, configurable: 5, operational: 0, enabled: 0, studio_available: 0 });
      expect(summary.rows[0].s.quota_policy_pending).toBeGreaterThanOrEqual(1);
    } finally { await db.close(); }
  });

  it('dérive les familles nouvelles d’un quota approuvé, sans les approuver', async () => {
    const db = await database();
    try {
      await db.exec(`set test.role='service_role'`);
      await db.query(`select public.studio_propose_family_policy()`);
      const quotas = await db.query<{ plan_key: string; family: string; monthly_limit: number; approved: boolean }>(
        `select plan_key,family,monthly_limit,approved from saas_ugc.studio_plan_quotas
          where family in ('audio','model_3d','tool') order by family,plan_key`);
      // free vidéo 1 → audio 2 ; studio 20 → 40 ; pro 80 → 160 ; entreprise 1000 → 2000.
      expect(quotas.rows.filter((row) => row.family === 'audio').map((row) => [row.plan_key, row.monthly_limit])).toEqual(
        [['enterprise', 2000], ['free', 2], ['pro', 160], ['studio', 40]]);
      expect(quotas.rows.filter((row) => row.family === 'model_3d').map((row) => row.monthly_limit)).toEqual([1000, 1, 80, 20]);
      expect(quotas.rows.filter((row) => row.family === 'tool').map((row) => row.monthly_limit)).toEqual([5000, 5, 400, 100]);
      expect(quotas.rows.every((row) => row.approved === false)).toBe(true);
      // La politique approuvée existante n'est jamais réécrite par une proposition.
      const video = await db.query<{ monthly_limit: number; approved: boolean }>(
        `select monthly_limit,approved from saas_ugc.studio_plan_quotas where plan_key='pro' and family='video'`);
      expect(video.rows[0]).toEqual({ monthly_limit: 80, approved: true });
      const entitlement = await db.query<{ n: number }>(
        `select count(*)::int n from saas_ugc.studio_plan_families where family='audio' and approved`);
      expect(entitlement.rows[0].n).toBe(0);
      await db.exec(`set test.admin='yes'`);
      const proposals = await db.query<{ p: { families: { family: string; plans: { plan_key: string; proposed_limit: number; quota_approved: boolean }[] }[] } }>(
        `select public.studio_family_policy_proposals() as p`);
      const audio = proposals.rows[0].p.families.find((item) => item.family === 'audio')!;
      expect(audio.plans.find((plan) => plan.plan_key === 'pro')).toMatchObject({ proposed_limit: 160, quota_approved: false });
    } finally { await db.close(); }
  });

  it('n’approuve une politique dérivée que sur acte explicite et motivé', async () => {
    const db = await database();
    try {
      await db.exec(`set test.role='service_role'`);
      await db.query(`select public.studio_propose_family_policy('audio')`);
      await db.exec(`set test.admin='yes'`);
      await expect(db.query(`select public.studio_approve_family_policy('audio',false,null)`)).rejects.toThrow('approval_note_required');
      const approved = await db.query<{ r: { quota_plans_approved: number; entitlement_plans_approved: number } }>(
        `select public.studio_approve_family_policy('audio',false,'arbitrage produit du 21/11/2026') as r`);
      expect(approved.rows[0].r).toMatchObject({ quota_plans_approved: 4, entitlement_plans_approved: 0 });
      const entitlements = await db.query<{ n: number }>(
        `select count(*)::int n from saas_ugc.studio_plan_families where family='audio' and approved`);
      expect(entitlements.rows[0].n).toBe(0);
      await db.exec(`set test.role='authenticated'`);
      const consumption = await db.query<{ r: { family: string; limit: number; remaining: number } }>(
        `select public.reelora_consume_quota('audio') as r`);
      expect(consumption.rows[0].r).toMatchObject({ family: 'audio', limit: 160, remaining: 159 });
    } finally { await db.close(); }
  });

  it('accepte un tarif fournisseur officiellement nul, jamais un prix absent', async () => {
    const db = await database();
    try {
      await db.exec(`update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify({
        cost_usd: 0, currency: 'USD', billing: 'free', cost_strategy: 'watermark-free',
        estimate_path: '/api/v1/models/watermark-model/estimate-cost',
        source_url: 'https://api.muapi.ai/api/v1/models/watermark-model',
      })}'::jsonb where id='${TOOL}'`);
      await db.exec(`set test.role='service_role'`);
      const free = await prepare(db, TOOL);
      expect(free.rows[0].result).toMatchObject({ credits: 0, max_cost_usd: 0, billing: 'free' });
      // Le runtime ne peut pas facturer un modèle gratuit.
      await db.exec(`set test.admin='yes'`);
      const config = await db.query<{ c: { config: { credits: number; billing: string } } }>(
        `select public.studio_runtime_admin_config('watermark-model') as c`);
      expect(config.rows[0].c.config).toMatchObject({ credits: 0, billing: 'free' });
      // Un zéro SANS stratégie de coût ni source est refusé DÈS l'écriture :
      // le prix ne peut pas devenir « gratuit » par défaut.
      await expect(db.exec(`update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify({
        cost_usd: 0, currency: 'USD', estimate_path: '/api/v1/models/watermark-model/estimate-cost',
      })}'::jsonb where id='${TOOL}'`)).rejects.toThrow('studio_ai_models_provider_pricing_shape');
      await expect(db.exec(`update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify({
        cost_usd: 0, currency: 'USD', billing: 'free', cost_strategy: 'watermark-free',
        estimate_path: '/api/v1/models/watermark-model/estimate-cost',
      })}'::jsonb where id='${TOOL}'`)).rejects.toThrow('studio_ai_models_provider_pricing_shape');
    } finally { await db.close(); }
  });

  it('expose un quota client cohérent et des compteurs d’usage', async () => {
    const db = await database();
    try {
      await db.exec(`set test.admin='yes'`);
      await db.query(`select public.studio_set_plan_quota('pro','audio',3,true,true)`);
      await db.exec(`set test.role='authenticated'`);
      await db.query(`select public.reelora_consume_quota('audio')`);
      const { rows } = await db.query<{ q: { plan: string; items: { family: string; used: number; limit: number | null; policy: string }[] } }>(
        `select public.studio_runtime_quotas() as q`);
      expect(rows[0].q.plan).toBe('pro');
      expect(rows[0].q.items.find((item) => item.family === 'audio')).toMatchObject({ used: 1, limit: 3, policy: 'active' });
      expect(rows[0].q.items.find((item) => item.family === 'video')).toMatchObject({ used: 0, limit: 80, policy: 'active' });
      expect(rows[0].q.items.find((item) => item.family === 'lora')?.policy).toBe('pending_approval');
    } finally { await db.close(); }
  });
});

/**
 * Incrément 17 : deux capacités ajoutées par migration de DONNÉES/CONTRAT —
 * la famille d'un entraînement LoRA et le protocole de donnée déclarée. Rien
 * n'est approuvé ni activé par ces changements.
 */
describe('capacités du lot 17', () => {
  it('rattache un entraînement à la famille lora sans approuver de limite', async () => {
    const db = await database();
    try {
      expect((await family(db, 'Training', { integration_family: 'training' })).rows[0].family).toBe('lora');
      const approved = await db.query<{ n: number }>(
        `select count(*)::int n from saas_ugc.studio_plan_quotas where family='lora' and approved`);
      expect(approved.rows[0].n).toBe(0);
    } finally { await db.close(); }
  });

  it('accepte le protocole de donnée déclarée, le classe en texte et refuse le reste', async () => {
    const db = await database();
    try {
      await db.query(`update saas_ugc.studio_model_integrations set protocol='muapi_output_json_v1' where model_id='${LORA}'`);
      await prepare(db, LORA);
      const config = await db.query<{ output_kind: string }>(
        `select output_kind from saas_ugc.studio_runtime_configs where model_id='${LORA}'`);
      expect(config.rows[0].output_kind).toBe('text');
      await expect(db.query(
        `update saas_ugc.studio_model_integrations set protocol='muapi_output_unknown_v1' where model_id='${LORA}'`)).rejects.toThrow();
    } finally { await db.close(); }
  });
});
