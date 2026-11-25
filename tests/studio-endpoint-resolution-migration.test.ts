import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261120190000_studio_endpoint_resolution.sql', 'utf8');
const MODEL = '11111111-1111-4111-8111-111111111111';

async function database() {
  const db = new PGlite();
  await db.exec(`create schema saas_ugc; create schema ugc_private; create schema auth;
    create role anon; create role authenticated; create role service_role;
    create function auth.role() returns text language sql as $$ select current_setting('test.role',true) $$;
    create table saas_ugc.studio_ai_models(
      id uuid primary key, provider_key text not null, provider_model_id text not null,
      input_schema jsonb, output_schema jsonb, endpoint_evidence jsonb default '{}'::jsonb,
      provider_enabled boolean default true, coming_soon boolean default false, public_catalog_present boolean default true,
      category text, metadata jsonb default '{}'::jsonb, updated_at timestamptz default now());
    create table saas_ugc.studio_model_integrations(model_id uuid primary key, spec_hash text not null,
      family text, protocol text, adapter_version text, status text, stages jsonb default '{}'::jsonb,
      blockers jsonb default '[]'::jsonb, input_signature text, openapi_evidence jsonb default '{}'::jsonb,
      result_field text, checked_at timestamptz default now());
    create table saas_ugc.studio_runtime_configs(model_id uuid primary key, enabled boolean default false,
      verified_hash text, verified_at timestamptz, revision integer default 1, updated_at timestamptz default now());
    insert into saas_ugc.studio_ai_models(id,provider_key,provider_model_id,input_schema,output_schema,endpoint_evidence,category)
      values('${MODEL}','muapi','flux-dev','{"schemas":{"input_data":{"type":"object","endpoint_url":"flux-dev-image"}}}'::jsonb,
        '{"schemas":{"type":"object","properties":{"output":{"type":"object","properties":{"image_url":{"type":"string","title":"Image URL"}}}}}}'::jsonb,
        '{"endpoint":"/api/v1/flux-dev","endpoint_url":"flux-dev-image"}'::jsonb,'Text to Image');
    insert into saas_ugc.studio_runtime_configs(model_id,enabled,verified_hash,verified_at)
      values('${MODEL}',true,'previous-hash',now());`);
  await db.exec(migration);
  return db;
}

const resolution = (over: Record<string, unknown> = {}) => ({
  status: 'resolved', path: 'flux-dev-image', resolution: 'openapi_single', operation_id: 'generate_flux_dev_image',
  contract_fingerprint: 'deadbeefdeadbeef', document_sha256: 'a'.repeat(64),
  declared_paths: ['flux-dev', 'flux-dev-image'], documented_paths: ['flux-dev-image'], ...over,
});

describe('endpoint resolution persistence', () => {
  it('stores the official proof, keeps declarations and invalidates the attestation', async () => {
    const db = await database();
    try {
      await db.exec("set test.role='service_role'");
      const before = await db.query<{ hash: string }>(`select ugc_private.studio_spec_hash('${MODEL}') as hash`);
      const report = {
        version: 'muapi-families-5', family: 'text-to-image', protocol: 'muapi_output_media_v1',
        result_field: 'image_url', status: 'integration_prepared',
        stages: { endpoint_confirmed: true }, blockers: ['CONSTRAINT_REVIEW_REQUIRED', 'REAL_TEST_PENDING'],
        input_signature: 'sig', openapi_evidence: { source: 'https://api.muapi.ai/openapi.json' },
        endpoint_resolution: resolution(),
      };
      const result = await db.query<{ saved: boolean }>(
        "select public.studio_save_integration($1,$2,$3::jsonb) as saved",
        [MODEL, before.rows[0].hash, JSON.stringify(report)],
      );
      expect(result.rows[0].saved).toBe(true);
      const row = await db.query<{ endpoint_evidence: { resolution: Record<string, unknown>; endpoint: string; endpoint_url: string } }>(
        `select endpoint_evidence from saas_ugc.studio_ai_models where id='${MODEL}'`,
      );
      expect(row.rows[0].endpoint_evidence.resolution).toMatchObject({ status: 'resolved', path: 'flux-dev-image', resolution: 'openapi_single' });
      // Original declarations are preserved.
      expect(row.rows[0].endpoint_evidence.endpoint).toBe('/api/v1/flux-dev');
      expect(row.rows[0].endpoint_evidence.endpoint_url).toBe('flux-dev-image');
      const config = await db.query<{ enabled: boolean; verified_hash: string | null; verified_at: string | null }>(
        `select enabled,verified_hash,verified_at from saas_ugc.studio_runtime_configs where model_id='${MODEL}'`,
      );
      expect(config.rows[0]).toMatchObject({ enabled: false, verified_hash: null, verified_at: null });
      const integration = await db.query<{ spec_hash: string }>(`select spec_hash from saas_ugc.studio_model_integrations where model_id='${MODEL}'`);
      const current = await db.query<{ hash: string }>(`select ugc_private.studio_spec_hash('${MODEL}') as hash`);
      expect(integration.rows[0].spec_hash).toBe(current.rows[0].hash);
    } finally {
      await db.close();
    }
  });

  it('invalidates again when the proven contract changes', async () => {
    const db = await database();
    try {
      await db.exec("set test.role='service_role'");
      const first = await db.query<{ hash: string }>(`select ugc_private.studio_spec_hash('${MODEL}') as hash`);
      const base = {
        version: 'muapi-families-5', family: 'text-to-image', protocol: 'muapi_output_media_v1',
        status: 'integration_prepared', stages: {}, blockers: [], input_signature: 'sig',
        openapi_evidence: { source: 'https://api.muapi.ai/openapi.json' },
      };
      await db.query("select public.studio_save_integration($1,$2,$3::jsonb)", [MODEL, first.rows[0].hash, JSON.stringify({ ...base, endpoint_resolution: resolution() })]);
      await db.exec(`update saas_ugc.studio_runtime_configs set enabled=true, verified_hash='attested', verified_at=now() where model_id='${MODEL}'`);
      const second = await db.query<{ hash: string }>(`select ugc_private.studio_spec_hash('${MODEL}') as hash`);
      await db.query("select public.studio_save_integration($1,$2,$3::jsonb)", [MODEL, second.rows[0].hash, JSON.stringify({ ...base, endpoint_resolution: resolution({ contract_fingerprint: 'cafebabecafebabe' }) })]);
      const config = await db.query<{ enabled: boolean; verified_hash: string | null }>(`select enabled,verified_hash from saas_ugc.studio_runtime_configs where model_id='${MODEL}'`);
      expect(config.rows[0]).toMatchObject({ enabled: false, verified_hash: null });
    } finally {
      await db.close();
    }
  });

  it('refuses an unsafe or incomplete proof instead of guessing', async () => {
    const db = await database();
    try {
      await db.exec("set test.role='service_role'");
      const hash = await db.query<{ hash: string }>(`select ugc_private.studio_spec_hash('${MODEL}') as hash`);
      for (const bad of [resolution({ path: '../etc/passwd' }), resolution({ resolution: 'guessed' }), resolution({ status: 'pending' }), resolution({ declared_paths: [] }), resolution({ document_sha256: 'not-a-sha' })]) {
        await expect(db.query("select public.studio_save_integration($1,$2,$3::jsonb)", [MODEL, hash.rows[0].hash, JSON.stringify({ version: 'muapi-families-5', family: 'x', protocol: null, status: 'blocked', stages: {}, blockers: [], input_signature: 's', endpoint_resolution: bad })]))
          .rejects.toThrow('invalid_report');
      }
    } finally {
      await db.close();
    }
  });

  it('accepts reports written by the previous runtime versions and refuses unknown ones', async () => {
    // Compatibilité de bascule : un worker encore en v4 (ou plus ancien) doit
    // pouvoir écrire son rapport pendant que le nouveau runtime est déployé.
    // Une version inconnue est refusée : elle pourrait décrire un contrat que
    // le runtime ne sait pas décoder.
    const db = await database();
    try {
      await db.exec("set test.role='service_role'");
      const base = { family: 'text-to-image', protocol: 'muapi_output_media_v1', status: 'blocked', stages: {}, blockers: [], input_signature: 's' };
      for (const version of ['muapi-families-2', 'muapi-families-3', 'muapi-families-4', 'muapi-families-5']) {
        const hash = await db.query<{ hash: string }>(`select ugc_private.studio_spec_hash('${MODEL}') as hash`);
        const saved = await db.query<{ saved: boolean }>(
          'select public.studio_save_integration($1,$2,$3::jsonb) as saved',
          [MODEL, hash.rows[0].hash, JSON.stringify({ ...base, version })],
        );
        expect(saved.rows[0].saved, version).toBe(true);
        const row = await db.query<{ adapter_version: string }>(`select adapter_version from saas_ugc.studio_model_integrations where model_id='${MODEL}'`);
        expect(row.rows[0].adapter_version).toBe(version);
      }
      const hash = await db.query<{ hash: string }>(`select ugc_private.studio_spec_hash('${MODEL}') as hash`);
      await expect(db.query('select public.studio_save_integration($1,$2,$3::jsonb)',
        [MODEL, hash.rows[0].hash, JSON.stringify({ ...base, version: 'muapi-families-6' })]))
        .rejects.toThrow('invalid_report');
    } finally {
      await db.close();
    }
  });

  it('keeps the service-only gate', async () => {
    const db = await database();
    try {
      await db.exec("set test.role='authenticated'");
      await expect(db.query("select public.studio_save_integration($1,$2,$3::jsonb)", [MODEL, 'x', '{}'])).rejects.toThrow('forbidden');
    } finally {
      await db.close();
    }
  });
});
