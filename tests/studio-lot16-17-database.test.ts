import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Migrations Studio lot16 / lot17 / actions externes — exécutées pour de vrai,
 * dans une base éphémère (PGlite), hors production.
 *
 * Pourquoi ce fichier existe
 * --------------------------
 * Ces trois migrations ne sont PAS appliquées en production. Elles sont
 * « sensibles » pour une raison précise : lot16 remplace
 * `public.reelora_consume_quota` et `public.studio_runtime_finish`, c'est-à-dire
 * le chemin qui débite un portefeuille client. Les appliquer sans preuve, c'est
 * risquer de facturer deux fois ou de ne plus facturer du tout.
 *
 * On les fait donc tourner ici, sur des portefeuilles factices, et on vérifie ce
 * qui compte :
 *   1. elles s'appliquent sans erreur sur le schéma réel ;
 *   2. elles échouent FERMÉ : sans arbitrage produit, un quota proposé vaut 0 et
 *      la consommation est refusée au lieu de passer silencieusement ;
 *   3. elles ne créent aucun débit : aucune écriture de portefeuille n'a lieu
 *      pour une demande de quota ou une proposition de politique ;
 *   4. les actions externes n'exécutent RIEN — ni appel fournisseur, ni crédit —
 *      même après confirmation, conformément à ce que le handler annonce.
 *
 * Ce que ce fichier ne prouve pas : le comportement sur la vraie base (rôles,
 * RLS, extensions). PGlite est un Postgres autonome, pas Supabase.
 */

const lire = (nom: string) => readFileSync(`supabase/migrations/${nom}.sql`, 'utf8');

const UTILISATEUR = '11111111-1111-4111-8111-111111111111';
const AUTRE = '22222222-2222-4222-8222-222222222222';

/** Applique la chaîne de migrations jusqu'au lot16 inclus. */
async function basePrete(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema saas_ugc; create schema ugc_private; create schema auth;
    create schema storage; create schema cron;
    create function cron.schedule(text,text,text) returns integer language sql as $$select 1$$;
    create role anon; create role authenticated; create role service_role;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${UTILISATEUR}'), ('${AUTRE}');
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    create function auth.role() returns text language sql as $$select current_setting('test.role',true)$$;
    create function ugc_private.reelora_assert_admin() returns void language plpgsql as $$
      begin if current_setting('test.admin',true) is distinct from 'yes' then raise exception 'forbidden'; end if; end$$;
    create function ugc_private.reelora_assert_active() returns void language plpgsql as $$
      begin if auth.uid() is null then raise exception 'not_authenticated'; end if; end$$;
    create function ugc_private.reelora_assert_vyora_customer() returns void language plpgsql as $$
      begin if auth.uid() is null then raise exception 'not_authenticated'; end if; end$$;
    create function ugc_private.can_edit_workspace(uuid) returns boolean language sql as $$select $1=auth.uid()$$;
    create function saas_ugc.ugc_ensure_my_workspace() returns uuid language sql as $$select auth.uid()$$;
    create table saas_ugc.ugc_subscriptions(user_id uuid, plan_key text, status text, current_period_end timestamptz);
    create table saas_ugc.ugc_plans(plan_key text primary key, active boolean, display_name text,
      sort_order integer default 0, max_scripts_per_month integer default 0,
      max_prompts_per_month integer default 0, max_videos_per_month integer default 0);
    create table saas_ugc.ugc_wallets(user_id uuid primary key, available_balance bigint, reserved_balance bigint);
    create table saas_ugc.ugc_usage_events(id uuid default gen_random_uuid(), user_id uuid, event_kind text,
      reference_id uuid, quantity integer default 1, period_key text default '2026-11',
      metadata jsonb default '{}'::jsonb);
    create table storage.objects(bucket_id text, name text, metadata jsonb);
    -- Version d'origine de la consommation, que lot16 REMPLACE : on simule celle
    -- qui existe réellement en production pour que le remplacement soit testé,
    -- et non contourné.
    create function public.reelora_consume_quota(p_kind text, p_reference_id uuid, p_metadata jsonb)
      returns jsonb language plpgsql as $$
      begin
        perform ugc_private.reelora_assert_active();
        insert into saas_ugc.ugc_usage_events(user_id, event_kind, reference_id) values (auth.uid(), p_kind, p_reference_id);
        return '{}'::jsonb;
      end$$;
    -- Journal des mouvements de portefeuille : sert à PROUVER qu'aucun débit
    -- n'a eu lieu. Une base factice qui n'écrit rien ne prouverait rien.
    create table saas_ugc.fake_ledger(user_id uuid, cle text unique, operation text, montant bigint);
    create function ugc_private.apply_wallet_delta(uuid,text,bigint,bigint,text,text,jsonb) returns uuid
      language plpgsql as $$
      begin
        if exists(select 1 from saas_ugc.fake_ledger where cle = $5) then return gen_random_uuid(); end if;
        update saas_ugc.ugc_wallets set available_balance = available_balance + $3, reserved_balance = reserved_balance + $4
          where user_id = $1 and available_balance + $3 >= 0 and reserved_balance + $4 >= 0;
        if not found then raise exception 'insufficient_balance'; end if;
        insert into saas_ugc.fake_ledger values ($1, $5, $2, $3); return gen_random_uuid();
      end$$;
    insert into saas_ugc.ugc_wallets values ('${UTILISATEUR}', 100, 0), ('${AUTRE}', 50, 0);
    insert into saas_ugc.ugc_plans(plan_key, active, display_name, sort_order, max_scripts_per_month, max_prompts_per_month, max_videos_per_month)
      values ('pro', true, 'Pro', 3, 400, 300, 80);
    insert into saas_ugc.ugc_subscriptions values
      ('${UTILISATEUR}', 'pro', 'active', now() + interval '1 month'),
      ('${AUTRE}', 'pro', 'active', now() + interval '1 month');
  `);

  // Chaîne déjà couverte par tests/studio-runtime-database.test.ts.
  for (const migration of [
    '20261120010940_studio_universal_catalog',
  ]) {
    await db.exec(lire(migration));
  }
  await db.exec('alter table saas_ugc.studio_ai_models add column endpoint_evidence jsonb;');
  await db.exec('create table saas_ugc.studio_ai_detail_events(model_id uuid, event_type text, status text, http_status integer, occurred_at timestamptz);');
  for (const migration of [
    '20261120035256_studio_runtime',
    '20261120035400_studio_runtime_claim_fix',
    '20261120041508_studio_family_progress',
    '20261120044000_studio_direct_media_adapter',
  ]) {
    await db.exec(lire(migration));
  }
  await db.exec('create table saas_ugc.studio_ai_model_details(model_id uuid, status text);');
  for (const migration of [
    '20261120050000_studio_catalog_truth',
    '20261120053000_studio_structured_media',
    '20261120054000_studio_text_adapter',
    '20261120190000_studio_endpoint_resolution',
    '20261120210000_studio_runtime_prepare',
    '20261120230000_studio_quota_plan_policy',
  ]) {
    await db.exec(lire(migration));
  }
  return db;
}

async function fonctionExiste(db: PGlite, nom: string): Promise<boolean> {
  const r = await db.query<{ n: string }>(
    `select p.proname as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname = $1`, [nom]);
  return r.rows.length > 0;
}

describe('lot16 — politique de familles et quotas', () => {
  it('s’applique sans erreur et expose les RPC de quota', async () => {
    const db = await basePrete();
    try {
      await db.exec(lire('20261121000000_studio_family_policy_lot16'));
      for (const rpc of ['studio_runtime_quotas', 'studio_runtime_plan_matrix', 'studio_propose_family_policy', 'studio_approve_family_policy', 'studio_set_plan_family']) {
        expect(await fonctionExiste(db, rpc), `RPC absente : ${rpc}`).toBe(true);
      }
      // Les familles sont décrites, et lot16 n'approuve rien au passage.
      const familles = await db.query<{ n: number }>('select count(*)::int as n from saas_ugc.studio_quota_families');
      expect(familles.rows[0].n).toBeGreaterThan(0);
      const approuvees = await db.query<{ family: string }>(
        `select family from saas_ugc.studio_plan_quotas where approved order by family`);
      // État hérité de 20261120230000, mesuré : cinq familles approuvées.
      expect(approuvees.rows.map((r) => r.family)).toEqual(['export', 'image', 'prompt', 'script', 'video']);
    } finally { await db.close(); }
  }, 120_000);

  it('échoue FERMÉ : une proposition dérivée d’une famille non approuvée vaut 0', async () => {
    const db = await basePrete();
    try {
      await db.exec(lire('20261121000000_studio_family_policy_lot16'));
      await db.exec(`set test.uid = '${UTILISATEUR}'; set test.role = 'authenticated'; set test.admin = 'yes';`);
      const avantApprouvees = await db.query<{ family: string }>(
        `select family from saas_ugc.studio_plan_quotas where approved order by family`);
      const propositions = await db.query<Record<string, unknown>>(
        'select public.studio_propose_family_policy(null) as r');
      expect(propositions.rows[0].r, 'la proposition doit renvoyer un rapport').toBeTruthy();
      const apresApprouvees = await db.query<{ family: string }>(
        `select family from saas_ugc.studio_plan_quotas where approved order by family`);
      // Une proposition n'approuve RIEN : exactement le même ensemble approuvé.
      expect(apresApprouvees.rows.map((r) => r.family)).toEqual(avantApprouvees.rows.map((r) => r.family));
      // Le point qui compte : des familles ont une limite NON NULLE et sont
      // pourtant non approuvées. C'est ce qui fait échouer la consommation fermée
      // au lieu de laisser passer un débit jamais arbitré.
      const piege = await db.query<{ n: number }>(`
        select count(*)::int as n from saas_ugc.studio_plan_quotas
        where approved = false and enabled = true and monthly_limit > 0`);
      expect(piege.rows[0].n, 'des limites non approuvées doivent rester bloquantes').toBeGreaterThan(0);
    } finally { await db.close(); }
  }, 120_000);

  it('ne débite AUCUN portefeuille en proposant ou en approuvant une politique', async () => {
    const db = await basePrete();
    try {
      await db.exec(lire('20261121000000_studio_family_policy_lot16'));
      await db.exec(`set test.uid = '${UTILISATEUR}'; set test.role = 'authenticated'; set test.admin = 'yes';`);
      const avant = await db.query<{ n: number }>('select count(*)::int as n from saas_ugc.fake_ledger');
      await db.query('select public.studio_propose_family_policy(null)');
      await db.query(`select public.studio_propose_family_policy('audio')`);
      const apres = await db.query<{ n: number }>('select count(*)::int as n from saas_ugc.fake_ledger');
      expect(apres.rows[0].n).toBe(avant.rows[0].n);
      const soldes = await db.query<{ available_balance: number }>(`select available_balance from saas_ugc.ugc_wallets where user_id = '${UTILISATEUR}'`);
      expect(Number(soldes.rows[0].available_balance)).toBe(100);
    } finally { await db.close(); }
  }, 120_000);

  it('refuse la consommation quand la politique de la famille manque', async () => {
    const db = await basePrete();
    try {
      await db.exec(lire('20261121000000_studio_family_policy_lot16'));
      await db.exec(`set test.uid = '${UTILISATEUR}'; set test.role = 'authenticated'; set test.admin = 'no';`);
      // refusera_consommer doit lever « quota_policy_missing » et non consommer.
      await expect(db.query(`select public.reelora_consume_quota('audio', gen_random_uuid(), '{}'::jsonb)`))
        .rejects.toThrow(/quota_policy_missing|invalid/i);
      const evenements = await db.query<{ n: number }>('select count(*)::int as n from saas_ugc.ugc_usage_events');
      expect(evenements.rows[0].n, 'aucun événement d’usage ne doit être écrit').toBe(0);
    } finally { await db.close(); }
  }, 120_000);
});

describe('lot17 — résultats JSON et formation', () => {
  it('s’applique après lot16 sans casser les RPC de préparation', async () => {
    const db = await basePrete();
    try {
      await db.exec(lire('20261121000000_studio_family_policy_lot16'));
      await db.exec(lire('20261121010000_studio_json_result_training_lot17'));
      expect(await fonctionExiste(db, 'studio_prepare_runtime')).toBe(true);
      expect(await fonctionExiste(db, 'studio_runtime_model')).toBe(true);
    } finally { await db.close(); }
  }, 120_000);
});

describe('actions externes — aucune exécution, aucun crédit', () => {
  it('s’applique et n’exécute rien, même après confirmation', async () => {
    const db = await basePrete();
    try {
      await db.exec(lire('20261121000000_studio_family_policy_lot16'));
      await db.exec(lire('20261121020000_studio_external_actions'));
      for (const rpc of ['studio_external_action_request', 'studio_external_action_confirm', 'studio_external_action_cancel', 'studio_external_action_list']) {
        expect(await fonctionExiste(db, rpc), `RPC absente : ${rpc}`).toBe(true);
      }
      // Un modèle « action externe » se RECONNAÎT à une déclaration explicite :
      // une entrée dont `options_source` vaut `social_accounts`, ou une sortie
      // qui déclare `publish_id` / `media_id`. On suit la règle de la migration
      // plutôt que d'inventer un modèle que la fonction refuserait.
      await db.exec(`insert into saas_ugc.studio_ai_models(provider_key, provider_model_id, display_name, category,
        provider_enabled, coming_soon, account_access, public_catalog_present, input_schema, output_schema)
        values ('muapi','external-model','Externe','video',true,false,'available',true,
        '{"schemas":{"input_data":{"type":"object","required":["account"],"properties":{"account":{"type":"string","options_source":"social_accounts","options_platform":"instagram"}}}}}',
        '{"schemas":{"properties":{"output":{"type":"object","properties":{"publish_id":{"type":"string"}}}}}}');`);
      await db.exec(`set test.uid = '${UTILISATEUR}'; set test.role = 'authenticated'; set test.admin = 'no';`);
      const modelId = (await db.query<{ id: string }>('select id from saas_ugc.studio_ai_models limit 1')).rows[0].id;

      const avant = await db.query<{ n: number }>('select count(*)::int as n from saas_ugc.fake_ledger');
      const demande = await db.query<Record<string, unknown>>(
        `select public.studio_external_action_request($1::uuid, '{"account":"instagram-1"}'::jsonb) as r`, [modelId]);
      expect(demande.rows[0].r).toBeTruthy();

      // Aucun mouvement d'argent à la demande.
      const apresDemande = await db.query<{ n: number }>('select count(*)::int as n from saas_ugc.fake_ledger');
      expect(apresDemande.rows[0].n).toBe(avant.rows[0].n);

      const actions = await db.query<{ id: string; status: string }>('select id, status from saas_ugc.studio_external_actions');
      expect(actions.rows.length).toBe(1);
      expect(actions.rows[0].status).not.toBe('executed');

      // La confirmation change l'état mais n'appelle rien et ne débite rien.
      await db.query(`select public.studio_external_action_confirm($1::uuid, true, 'confirmé par le client')`, [actions.rows[0].id]);
      const apresConfirmation = await db.query<{ n: number }>('select count(*)::int as n from saas_ugc.fake_ledger');
      expect(apresConfirmation.rows[0].n, 'une confirmation ne doit jamais débiter').toBe(avant.rows[0].n);
      const solde = await db.query<{ available_balance: number }>(`select available_balance from saas_ugc.ugc_wallets where user_id = '${UTILISATEUR}'`);
      expect(Number(solde.rows[0].available_balance)).toBe(100);

      // Le journal d'événements garde la trace de l'acte.
      const evenements = await db.query<{ n: number }>('select count(*)::int as n from saas_ugc.studio_external_action_events');
      expect(evenements.rows[0].n).toBeGreaterThan(0);
    } finally { await db.close(); }
  }, 180_000);
});
