import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const read = (name: string) => readFileSync(`supabase/migrations/${name}.sql`,'utf8');
it('applies endpoint evidence additively, preserves admin/service gates and never enables models', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create schema saas_ugc; create schema ugc_private; create schema auth;
      create role anon; create role authenticated; create role service_role;
      create function auth.role() returns text language sql as $$ select current_setting('test.role',true) $$;
      create function ugc_private.reelora_assert_admin() returns void language plpgsql as $$ begin
        if current_setting('test.admin',true) is distinct from 'yes' then raise exception 'forbidden'; end if;
      end $$;`);
    await db.exec(read('20261120010940_studio_universal_catalog'));
    await db.exec(read('20261120011030_studio_muapi_model_details'));
    await db.exec(read('20261120015111_studio_catalog_admin_read'));
    await db.exec(`insert into saas_ugc.studio_ai_models(provider_key,provider_model_id,display_name,category,input_schema)
      values('muapi','qwen3-text-to-image','Qwen','image','{"schemas":{"input_data":{"type":"object","properties":{}}}}'),
      ('muapi','keep-me','Keep','video','{}');`);
    await db.exec(read('20261120024717_studio_endpoint_evidence'));
    expect((await db.query<{n:number}>('select count(*)::int as n from saas_ugc.studio_ai_models where studio_enabled')).rows[0].n).toBe(0);
    const evidence = await db.query<{endpoint_evidence:{endpoint:string}}>("select endpoint_evidence from saas_ugc.studio_ai_models where provider_model_id='qwen3-text-to-image'");
    expect(evidence.rows[0].endpoint_evidence.endpoint).toBe('/api/v1/qwen3-text-to-image');
    await expect(db.query("select public.studio_catalog_admin_model_detail('qwen3-text-to-image')")).rejects.toThrow('forbidden');
    await db.exec("set test.admin='yes'");
    const detail = await db.query<{data:{endpoint_evidence:unknown}}>("select public.studio_catalog_admin_model_detail('qwen3-text-to-image') as data");
    expect(detail.rows[0].data.endpoint_evidence).toBeTruthy();
    await expect(db.query("select public.studio_save_muapi_detail('keep-me','ok',200,'{}',null)")).rejects.toThrow('forbidden');
    await db.exec("set test.role='service_role'");
    await db.query(`select public.studio_save_muapi_detail('keep-me','ok',200,$1::jsonb,null)`,[JSON.stringify({schemas:{input_data:{type:'object',properties:{}}},vyora_endpoint_evidence:{endpoint:'real'}})]);
    const saved = await db.query<{input_schema:Record<string,unknown>;endpoint_evidence:{endpoint:string}}>("select input_schema,endpoint_evidence from saas_ugc.studio_ai_models where provider_model_id='keep-me'");
    expect(saved.rows[0].input_schema.vyora_endpoint_evidence).toBeUndefined();
    expect(saved.rows[0].endpoint_evidence.endpoint).toBe('real');
    const permissions = await db.query<{allowed:boolean}>("select has_table_privilege('authenticated','saas_ugc.studio_ai_models','SELECT') as allowed");
    expect(permissions.rows[0].allowed).toBe(false);
  } finally { await db.close(); }
},30000);
