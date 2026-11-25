import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Préparation des configurations runtime (migration `…_studio_runtime_prepare`).
 *
 * Ce que ces tests prouvent, sur une vraie base Postgres (PGlite) :
 *   - une configuration n'est écrite que si le contrat, l'endpoint, le prix
 *     déclaré et l'endpoint d'estimation sont tous prouvés ;
 *   - les crédits viennent UNIQUEMENT de la grille serveur existante ;
 *   - rien n'est jamais activé ni vérifié par la préparation ;
 *   - un changement de prix ou d'estimation invalide une validation antérieure ;
 *   - les refus sont explicites, jamais silencieux.
 */
const migration = readFileSync('supabase/migrations/20261120210000_studio_runtime_prepare.sql', 'utf8');
const VIDEO = '11111111-1111-4111-8111-111111111111';
const AUDIO = '22222222-2222-4222-8222-222222222222';
const NO_PRICE = '33333333-3333-4333-8333-333333333333';
const NO_ESTIMATE = '44444444-4444-4444-8444-444444444444';
const NOT_PREPARED = '55555555-5555-4555-8555-555555555555';

const pricing = (model: string, over: Record<string, unknown> = {}) => ({
  cost_usd: 0.1, currency: 'USD', dynamic_pricing: true,
  estimate_path: `/api/v1/models/${model}/estimate-cost`, ...over,
});

async function database() {
  const db = new PGlite();
  await db.exec(`create schema saas_ugc; create schema ugc_private; create schema auth;
    create role anon; create role authenticated; create role service_role;
    create function auth.role() returns text language sql as $$ select current_setting('test.role',true) $$;
    create table saas_ugc.ugc_app_settings(setting_key text primary key, setting_value jsonb, updated_at timestamptz default now());
    insert into saas_ugc.ugc_app_settings(setting_key,setting_value) values('studio_pricing_config',
      '{"usd_to_xof":620,"credit_value_xof":100,"target_margin_percent":60,"processing_cost_usd":0.01}'::jsonb);
    create table saas_ugc.studio_ai_models(
      id uuid primary key, provider_key text not null, provider_model_id text not null,
      input_schema jsonb, output_schema jsonb, endpoint_evidence jsonb default '{}'::jsonb,
      provider_enabled boolean default true, coming_soon boolean default false, public_catalog_present boolean default true,
      account_access text not null default 'unverified', category text, metadata jsonb default '{}'::jsonb,
      updated_at timestamptz default now());
    create table saas_ugc.studio_model_integrations(model_id uuid primary key, status text, family text, protocol text);
    create table saas_ugc.studio_runtime_configs(model_id uuid primary key,
      credits integer, max_cost_usd numeric, quota_kind text not null default 'video', allowed_plans text[] not null default '{}',
      enabled boolean not null default false, adapter text not null default 'muapi_prediction_v1', output_kind text not null default 'media',
      estimate_path text, revision integer not null default 1, verified_hash text, verification_reference text,
      verified_at timestamptz, updated_at timestamptz default now());
    create table saas_ugc.studio_ai_model_details(model_id uuid primary key, status text, http_status integer, checked_at timestamptz default now());
    insert into saas_ugc.studio_ai_models(id,provider_key,provider_model_id,category,endpoint_evidence,account_access) values
      ('${VIDEO}','muapi','clip-model','Text to Video','{"endpoint":"/api/v1/clip-model","resolution":{"status":"resolved","path":"clip-model"}}'::jsonb,'available'),
      ('${AUDIO}','muapi','sound-model','Text to Audio','{"endpoint":"/api/v1/sound-model","resolution":{"status":"resolved","path":"sound-model"}}'::jsonb,'available'),
      ('${NO_PRICE}','muapi','price-less-model','Text to Video','{"endpoint":"/api/v1/price-less-model","resolution":{"status":"resolved","path":"price-less-model"}}'::jsonb,'available'),
      ('${NO_ESTIMATE}','muapi','no-estimate-model','Text to Video','{"endpoint":"/api/v1/no-estimate-model","resolution":{"status":"resolved","path":"no-estimate-model"}}'::jsonb,'available'),
      ('${NOT_PREPARED}','muapi','blocked-model','Text to Video','{"endpoint":"/api/v1/blocked-model","resolution":{"status":"resolved","path":"blocked-model"}}'::jsonb,'available');
    insert into saas_ugc.studio_model_integrations(model_id,status,family,protocol) values
      ('${VIDEO}','integration_prepared','text-to-video','muapi_output_media_v1'),
      ('${AUDIO}','integration_prepared','audio-generation','muapi_output_media_v1'),
      ('${NO_PRICE}','integration_prepared','text-to-video','muapi_output_media_v1'),
      ('${NO_ESTIMATE}','integration_prepared','text-to-video','muapi_output_media_v1'),
      ('${NOT_PREPARED}','blocked','text-to-video',null);`);
  await db.exec(migration);
  await db.exec(`update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify(pricing('clip-model'))}'::jsonb where id='${VIDEO}';
    update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify(pricing('sound-model', { cost_usd: 0.25 }))}'::jsonb where id='${AUDIO}';
    update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify(pricing('no-estimate-model', { estimate_path: null }))}'::jsonb where id='${NO_ESTIMATE}';
    set test.role='service_role';`);
  return db;
}

const prepare = (db: PGlite, id: string) => db.query<Record<string, unknown>>('select public.studio_prepare_runtime($1) as result', [id]);

describe('préparation d’une configuration runtime', () => {
  it('écrit une configuration complète depuis les preuves, sans activer', async () => {
    const db = await database();
    try {
      const { rows } = await prepare(db, VIDEO);
      const result = rows[0].result as Record<string, unknown>;
      // 0.1 USD × 620 × 1.6 + 0.01 × 620 = 105,4 XOF → 2 crédits (arrondi supérieur).
      expect(result).toMatchObject({
        credits: 2, max_cost_usd: 0.1, quota_kind: 'video', output_kind: 'media',
        estimate_path: '/api/v1/models/clip-model/estimate-cost', enabled: false, verified: false, changed: true,
      });
      expect(result.remaining).toEqual(expect.arrayContaining(['PLAN_UNAVAILABLE', 'PAID_VALIDATION_PENDING', 'ADMIN_DISABLED']));
      const cfg = await db.query<{ credits: number; enabled: boolean; verified_at: string | null; adapter: string }>(
        'select credits,enabled,verified_at,adapter from saas_ugc.studio_runtime_configs where model_id=$1', [VIDEO]);
      expect(cfg.rows[0]).toMatchObject({ credits: 2, enabled: false, verified_at: null, adapter: 'muapi_prediction_v1' });
    } finally { await db.close(); }
  });

  it('est idempotente : une seconde préparation ne change ni révision ni valeurs', async () => {
    const db = await database();
    try {
      await prepare(db, VIDEO);
      const before = await db.query<{ revision: number }>('select revision from saas_ugc.studio_runtime_configs where model_id=$1', [VIDEO]);
      const { rows } = await prepare(db, VIDEO);
      expect((rows[0].result as Record<string, unknown>).changed).toBe(false);
      const after = await db.query<{ revision: number }>('select revision from saas_ugc.studio_runtime_configs where model_id=$1', [VIDEO]);
      expect(after.rows[0].revision).toBe(before.rows[0].revision);
    } finally { await db.close(); }
  });

  it('refuse un modèle sans prix déclaré, sans estimation, ou non préparé', async () => {
    const db = await database();
    try {
      await expect(prepare(db, NO_PRICE)).rejects.toThrow('provider_pricing_missing');
      await expect(prepare(db, NO_ESTIMATE)).rejects.toThrow('estimate_endpoint_missing');
      await expect(prepare(db, NOT_PREPARED)).rejects.toThrow('integration_not_prepared');
      const configs = await db.query<{ n: number }>('select count(*)::int as n from saas_ugc.studio_runtime_configs');
      // Aucune ligne partielle n'est laissée derrière un refus.
      expect(configs.rows[0].n).toBe(0);
    } finally { await db.close(); }
  });

  it('refuse une famille sans politique de quota plutôt que d’en inventer une', async () => {
    // « Text to Audio » n'a aucun type de quota de plan : l'audio ne peut pas
    // consommer un quota vidéo/image par décret technique.
    const db = await database();
    try {
      await expect(prepare(db, AUDIO)).rejects.toThrow('quota_policy_missing');
    } finally { await db.close(); }
  });

  it('invalide une validation payée dès que le prix change', async () => {
    const db = await database();
    try {
      await prepare(db, VIDEO);
      await db.exec(`update saas_ugc.studio_runtime_configs set enabled=true,verified_hash='h',verified_at=now(),allowed_plans=array['pro'] where model_id='${VIDEO}'`);
      await db.exec(`update saas_ugc.studio_ai_models set provider_pricing='${JSON.stringify(pricing('clip-model', { cost_usd: 0.4 }))}'::jsonb where id='${VIDEO}'`);
      const { rows } = await prepare(db, VIDEO);
      expect((rows[0].result as Record<string, unknown>).changed).toBe(true);
      const cfg = await db.query<{ enabled: boolean; verified_hash: string | null; verified_at: string | null; credits: number; revision: number }>(
        'select enabled,verified_hash,verified_at,credits,revision from saas_ugc.studio_runtime_configs where model_id=$1', [VIDEO]);
      // 0.4 USD × 620 × 1.6 + 6,2 = 403 XOF → 5 crédits.
      // Révision 1 (création) puis 2 (première configuration) puis 3 (prix changé).
      expect(cfg.rows[0]).toMatchObject({ enabled: false, verified_hash: null, verified_at: null, credits: 5, revision: 3 });
    } finally { await db.close(); }
  });

  it('prépare en lot et rapporte le motif exact de chaque refus', async () => {
    const db = await database();
    try {
      const { rows } = await db.query<Record<string, unknown>>('select public.studio_prepare_runtime_batch(500) as result');
      const result = rows[0].result as Record<string, unknown>;
      // Les 5 lignes préparées du jeu de test : 1 configurée, 3 refusées avec
      // motif, et le modèle bloqué n'est même pas examiné.
      expect(result).toMatchObject({ scanned: 4, configured: 1, refused: 3 });
      expect(result.reasons).toMatchObject({
        provider_pricing_missing: 1, estimate_endpoint_missing: 1, quota_policy_missing: 1,
      });
    } finally { await db.close(); }
  });

  it('expose l’état de préparation en lecture seule', async () => {
    const db = await database();
    try {
      await prepare(db, VIDEO);
      const { rows } = await db.query<{ r: unknown }>('select public.studio_runtime_readiness() as r');
      expect(Array.isArray(rows[0].r)).toBe(true);
      expect(rows[0].r as unknown[]).toHaveLength(4);
    } finally { await db.close(); }
  });

  it('garde les fonctions service-only', async () => {
    const db = await database();
    try {
      await db.exec("set test.role='authenticated'");
      await expect(prepare(db, VIDEO)).rejects.toThrow('forbidden');
      await expect(db.query('select public.studio_prepare_runtime_batch(10)')).rejects.toThrow('forbidden');
      await expect(db.query('select public.studio_runtime_readiness()')).rejects.toThrow('forbidden');
    } finally { await db.close(); }
  });
});

describe('preuve tarifaire déclarée', () => {
  it('refuse un prix nul, non-USD ou un endpoint d’estimation hors modèle', async () => {
    const db = await database();
    try {
      for (const bad of [pricing('clip-model', { cost_usd: 0 }), pricing('clip-model', { currency: 'XOF' }), pricing('clip-model', { estimate_path: '../etc' }), pricing('clip-model', { cost_usd: 1001 })]) {
        await expect(db.query(`update saas_ugc.studio_ai_models set provider_pricing=$1 where id='${NO_PRICE}'`, [JSON.stringify(bad)]))
          .rejects.toThrow(/studio_ai_models_provider_pricing_shape|check/i);
      }
    } finally { await db.close(); }
  });

  it('refuse un endpoint d’estimation qui vise un autre modèle', async () => {
    // La forme est valide, mais la preuve ne concerne pas ce modèle : la
    // préparation refuse au lieu de devisier sur le tarif d'un autre modèle.
    const db = await database();
    try {
      await db.query(`update saas_ugc.studio_ai_models set provider_pricing=$1 where id='${VIDEO}'`, [JSON.stringify(pricing('autre-modele'))]);
      await expect(prepare(db, VIDEO)).rejects.toThrow('estimate_endpoint_missing');
    } finally { await db.close(); }
  });

  it('accepte un prix déclaré et un endpoint d’estimation absent', async () => {
    const db = await database();
    try {
      await db.query(`update saas_ugc.studio_ai_models set provider_pricing=$1 where id='${NO_PRICE}'`, [JSON.stringify(pricing('price-less-model', { estimate_path: null }))]);
      const row = await db.query<{ n: number }>(`select count(*)::int as n from saas_ugc.studio_ai_models where provider_pricing->>'cost_usd'='0.1'`);
      expect(row.rows[0].n).toBeGreaterThan(0);
    } finally { await db.close(); }
  });

  it('la fiche qui ne déclare plus de prix efface l’ancien', async () => {
    const db = await database();
    try {
      await db.query(
        'select public.studio_save_muapi_detail($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)',
        ['clip-model', 'ok', 200, JSON.stringify({ schemas: { input_data: { type: 'object', properties: {} } }, vyora_endpoint_evidence: { endpoint: '/api/v1/clip-model' } }), null, JSON.stringify(pricing('clip-model'))],
      );
      const priced = await db.query<{ provider_pricing: { cost_usd: number } | null }>(`select provider_pricing from saas_ugc.studio_ai_models where id='${VIDEO}'`);
      expect(priced.rows[0].provider_pricing?.cost_usd).toBe(0.1);
      await db.query(
        'select public.studio_save_muapi_detail($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)',
        ['clip-model', 'ok', 200, JSON.stringify({ schemas: { input_data: { type: 'object', properties: {} } }, vyora_endpoint_evidence: { endpoint: '/api/v1/clip-model' } }), null, null],
      );
      const cleared = await db.query<{ provider_pricing: unknown }>(`select provider_pricing from saas_ugc.studio_ai_models where id='${VIDEO}'`);
      expect(cleared.rows[0].provider_pricing).toBeNull();
    } finally { await db.close(); }
  });
});
