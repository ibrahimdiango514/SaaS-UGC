import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60000 });

/**
 * Pipeline d'action externe (migration `…_studio_external_actions`), rejoué sur
 * une vraie base Postgres (PGlite).
 *
 * Prouve : détection par déclaration, permissions, confirmation explicite
 * obligatoire, idempotence anti-double-soumission, audit append-only, et
 * ABSENCE de toute fonction d'exécution fournisseur.
 */

const migration = readFileSync('supabase/migrations/20261121020000_studio_external_actions.sql', 'utf8');
const UID = '66666666-6666-4666-8666-666666666666';
const WS = '77777777-7777-4777-8777-777777777777';
const TIKTOK = '88888888-8888-4888-8888-888888888888';
const GENERATOR = '99999999-9999-4999-8999-999999999999';

const tiktokInput = {
  schemas: { input_data: {
    type: 'object', title: 'TikTok', endpoint_url: 'tiktok-publish',
    required: ['account_id', 'media_url'],
    properties: {
      account_id: { type: 'integer', title: 'Account ID', options_source: 'social_accounts', options_platform: 'tiktok' },
      media_url: { type: 'string', field: 'video', description: 'Public URL of the video to upload.' },
      title: { type: 'string', default: '' },
    },
  } },
};
const tiktokOutput = { schemas: { properties: { id: { type: 'string' }, status: { type: 'string' },
  output: { type: 'object', properties: { publish_id: { type: 'string' } } } } } };

async function database() {
  const db = new PGlite();
  await db.exec(`create schema saas_ugc; create schema ugc_private; create schema auth;
    create role anon; create role authenticated; create role service_role;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create function auth.role() returns text language sql as $$ select current_setting('test.role',true) $$;
    create table saas_ugc.studio_ai_models(
      id uuid primary key, provider_key text, provider_model_id text, category text,
      public_catalog_present boolean, provider_enabled boolean, input_schema jsonb, output_schema jsonb);
    create function public.studio_runtime_access() returns jsonb language sql as $$ select '{"workspace_id":"${WS}"}'::jsonb $$;`);
  await db.exec(migration);
  await db.query(
    `insert into saas_ugc.studio_ai_models(id,provider_key,provider_model_id,category,public_catalog_present,provider_enabled,input_schema,output_schema)
     values ($1,'muapi','tiktok-publish','other',true,true,$3::jsonb,$4::jsonb),
            ($2,'muapi','generator','Text to Image',true,true,$5::jsonb,$6::jsonb)`,
    [TIKTOK, GENERATOR, JSON.stringify(tiktokInput), JSON.stringify(tiktokOutput),
      JSON.stringify({ schemas: { input_data: { type: 'object', endpoint_url: 'generator', properties: { prompt: { type: 'string' } } } } }),
      JSON.stringify({ schemas: { properties: { id: { type: 'string' }, output: { type: 'object', properties: { outputs: { type: 'array' } } } } } })],
  );
  return db;
}

const asUser = async (db: PGlite, uid: string | null) => {
  await db.query('select set_config($1,$2,false)', ['test.uid', uid ?? '']);
};

type Result = { ok: true; rows: any[] } | { ok: false; code: string };
const call = async (db: PGlite, sql: string, params: unknown[] = []): Promise<Result> => {
  try { return { ok: true, rows: (await db.query(sql, params)).rows }; }
  catch (error) { return { ok: false, code: String((error as Error).message).split('\n')[0] }; }
};
const request = (db: PGlite, model = TIKTOK, params: Record<string, unknown> = { account_id: 7, media_url: 'https://cdn.example.com/v.mp4' }) =>
  call(db, `select public.studio_external_action_request($1,$2::jsonb) as r`, [model, JSON.stringify(params)]);

describe('demande d’action externe', () => {
  it('refuse un générateur : ce n’est pas une action externe', async () => {
    const db = await database();
    await asUser(db, UID);
    const result = await call(db, `select public.studio_external_action_request($1,'{}'::jsonb)`, [GENERATOR]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toContain('not_an_external_action');
  });

  it('exige une session', async () => {
    const db = await database();
    await asUser(db, null);
    const result = await request(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toContain('not_authenticated');
  });

  it('crée une demande avec permissions, confirmation et aucune exécution', async () => {
    const db = await database();
    await asUser(db, UID);
    const result = await request(db);
    expect(result.ok).toBe(true);
    const payload = (result as { rows: any[] }).rows[0].r;
    expect(payload).toMatchObject({ created: true, status: 'requested', platform: 'tiktok', kind: 'publish', execution: 'unavailable' });
    expect(payload.permissions).toEqual(['social.tiktok.account', 'social.tiktok.publish']);
    expect(payload.confirmation).toContain('tiktok');
  });

  it('est idempotente sur les mêmes paramètres (anti-double soumission)', async () => {
    const db = await database();
    await asUser(db, UID);
    const first = (await request(db) as { rows: any[] }).rows[0].r;
    const second = (await request(db) as { rows: any[] }).rows[0].r;
    expect(second.created).toBe(false);
    expect(second.action_id).toBe(first.action_id);
    const count = await db.query(`select count(*)::int as n from saas_ugc.studio_external_actions`);
    expect((count.rows[0] as any).n).toBe(1);
  });

  it('accepte une plateforme déclarée à un caractère (« x »)', async () => {
    const db = await database();
    await asUser(db, UID);
    await db.query(
      `insert into saas_ugc.studio_ai_models(id,provider_key,provider_model_id,category,public_catalog_present,provider_enabled,input_schema,output_schema)
       values ('12121212-1212-4212-8212-121212121212','muapi','x-publish','other',true,true,$1::jsonb,$2::jsonb)`,
      [JSON.stringify({ schemas: { input_data: { type: 'object', required: ['account_id', 'media_url'], properties: {
        account_id: { type: 'integer', options_source: 'social_accounts', options_platform: 'x' },
        media_url: { type: 'string', field: 'video', description: 'Public URL of the media to post.' },
      } } } }), JSON.stringify(tiktokOutput)],
    );
    const result = await request(db, '12121212-1212-4212-8212-121212121212', { account_id: 1, media_url: 'https://cdn.example.com/v.mp4' });
    expect(result.ok).toBe(true);
    expect((result as { rows: any[] }).rows[0].r).toMatchObject({ platform: 'x', kind: 'publish', status: 'requested' });
    expect((result as { rows: any[] }).rows[0].r.permissions).toEqual(['social.x.account', 'social.x.publish']);
  });

  it('refuse un champ non déclaré et un champ obligatoire absent', async () => {
    const db = await database();
    await asUser(db, UID);
    const unknown = await request(db, TIKTOK, { account_id: 7, media_url: 'https://cdn.example.com/v.mp4', admin: true });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toContain('invalid_params');
    const missing = await request(db, TIKTOK, { account_id: 7 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toContain('parameter_required');
  });
});

describe('confirmation et audit', () => {
  const confirmed = async (db: PGlite, actionId: string, confirm: boolean, note: string) =>
    call(db, `select public.studio_external_action_confirm($1,$2,$3) as r`, [actionId, confirm, note]);

  it('exige une confirmation explicite et une note écrite', async () => {
    const db = await database();
    await asUser(db, UID);
    const action = (await request(db) as { rows: any[] }).rows[0].r;
    const noConfirm = await confirmed(db, action.action_id, false, 'je confirme');
    expect(noConfirm.ok).toBe(false);
    if (!noConfirm.ok) expect(noConfirm.code).toContain('confirmation_required');
    const noNote = await confirmed(db, action.action_id, true, '');
    expect(noNote.ok).toBe(false);
    if (!noNote.ok) expect(noNote.code).toContain('approval_note_required');
  });

  it('confirme sans exécuter, puis annule, avec un audit complet', async () => {
    const db = await database();
    await asUser(db, UID);
    const action = (await request(db) as { rows: any[] }).rows[0].r;
    const confirmation = await confirmed(db, action.action_id, true, 'publication validée');
    expect(confirmation.ok).toBe(true);
    expect((confirmation as { rows: any[] }).rows[0].r).toMatchObject({ status: 'confirmed', execution: 'unavailable' });
    const cancel = await call(db, `select public.studio_external_action_cancel($1) as r`, [action.action_id]);
    expect(cancel.ok).toBe(true);
    expect((cancel as { rows: any[] }).rows[0].r).toMatchObject({ status: 'cancelled' });
    const events = await db.query(`select kind from saas_ugc.studio_external_action_events order by id`);
    expect(events.rows.map((row: any) => row.kind)).toEqual(['requested', 'confirmed', 'cancelled']);
    const list = await call(db, `select public.studio_external_action_list(50) as r`);
    expect((list as { rows: any[] }).rows[0].r[0].status).toBe('cancelled');
  });

  it('n’expose aucune fonction d’exécution fournisseur', async () => {
    const db = await database();
    const functions = await db.query(`select proname from pg_proc where proname like 'studio_external_action%' order by proname`);
    expect(functions.rows.map((row: any) => row.proname)).toEqual([
      'studio_external_action_cancel', 'studio_external_action_confirm', 'studio_external_action_list', 'studio_external_action_request',
    ]);
    // Aucun code SQL de ce pipeline ne joint le fournisseur : aucune de ses
    // fonctions ne contient d'URL MuAPI ni de nom d'exécution.
    const network = await db.query(`select count(*)::int as n from pg_proc
      where proname like 'studio_external_action%'
        and (prosrc ilike '%api.muapi.ai%' or prosrc ilike '%net.http%' or prosrc ilike '%execute%')`);
    expect((network.rows[0] as any).n).toBe(0);
    const executable = await db.query(`select count(*)::int as n from pg_proc
      where proname ~ '^studio_external_action_(execute|submit|publish)$'`);
    expect((executable.rows[0] as any).n).toBe(0);
  });
});
