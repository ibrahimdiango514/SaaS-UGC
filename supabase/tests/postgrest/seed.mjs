// Banc PostgREST — données de test : 2 entreprises, 4 utilisateurs, orphelins.
//
//   Entreprise A (workspace A) : alice (propriétaire) + carol (éditeur)
//   Entreprise B (workspace B) : bob (propriétaire)
//   dave : utilisateur SANS entreprise
//   boss : administrateur plateforme (role admin), sans entreprise
//
// Aucune donnée réelle de client : tous les identifiants sont fictifs
// (*.test) et la base est jetable.
import crypto from 'node:crypto';
import { withClient } from './pg.mjs';

export async function seed({ log = (m) => console.log(m) } = {}) {
  return withClient('postgres', async (db) => {
    const q = async (sql, params = []) => (await db.query(sql, params)).rows[0];
    const qAll = async (sql, params = []) => (await db.query(sql, params)).rows;

    log('seed         utilisateurs, entreprises, données de test');

    // --- Utilisateurs (auth.users : la seule source d'identité) ------------
    const users = {};
    const mkUser = async (email, meta = {}) => {
      const u = await q(`insert into auth.users(email, raw_user_meta_data, email_confirmed_at)
        values ($1, $2::jsonb, now()) on conflict (email) do update set raw_user_meta_data = excluded.raw_user_meta_data
        returning *`, [email, JSON.stringify(meta)]);
      return u;
    };
    users.alice = await mkUser('alice@company-a.test', { full_name: 'Alice (Entreprise A)' });
    users.bob = await mkUser('bob@company-b.test', { full_name: 'Bob (Entreprise B)' });
    users.carol = await mkUser('carol@company-a.test', { full_name: 'Carol (Entreprise A)' });
    users.dave = await mkUser('dave@no-company.test', { full_name: 'Dave (sans entreprise)' });
    users.boss = await mkUser('boss@vyora.test', { full_name: 'Boss (admin)' });

    // --- Entreprises (= workspaces) -----------------------------------------
    const orphanOwner = crypto.randomUUID();
    const wsA = (await q(`insert into saas_ugc.ugc_workspaces(owner_user_id, name, country_code)
      values ($1, 'Entreprise A', 'ML') returning *`, [users.alice.id])).id;
    const wsB = (await q(`insert into saas_ugc.ugc_workspaces(owner_user_id, name, country_code)
      values ($1, 'Entreprise B', 'ML') returning *`, [users.bob.id])).id;
    const wsOrphan = (await q(`insert into saas_ugc.ugc_workspaces(owner_user_id, name)
      values ($1, 'Entreprise orpheline (aucun membre)') returning *`, [orphanOwner])).id;
    await db.query(`insert into saas_ugc.ugc_workspace_members(workspace_id, user_id, role)
      values ($1, $2, 'editor') on conflict do nothing`, [wsA, users.carol.id]);

    const brandA = (await q(`insert into saas_ugc.ugc_brands(workspace_id, name, industry, description, voice_guidelines)
      values ($1, 'MarqueA', 'Épicerie fine', 'Produits artisanaux de Bamako', 'Ton chaleureux') returning id`, [wsA])).id;
    const brandB = (await q(`insert into saas_ugc.ugc_brands(workspace_id, name, industry, description, voice_guidelines)
      values ($1, 'MarqueB', 'Textile', 'Mode locale', 'Ton direct') returning id`, [wsB])).id;
    const productA = (await q(`insert into saas_ugc.ugc_products(workspace_id, name, description, key_benefits)
      values ($1, 'Amandes torréfiées A', 'Amandes artisanales', 'Goût, traçabilité') returning id`, [wsA])).id;
    const productB = (await q(`insert into saas_ugc.ugc_products(workspace_id, name, description, key_benefits)
      values ($1, 'Cire B', 'Cire tissée main', 'Originalité') returning id`, [wsB])).id;

    // --- Comptes VYORA / portefeuilles / rôles ------------------------------
    for (const u of [users.alice, users.bob, users.carol, users.dave]) {
      await db.query(`insert into saas_ugc.ugc_customer_accounts(user_id) values ($1) on conflict do nothing`, [u.id]);
      await db.query(`insert into saas_ugc.ugc_wallets(user_id) values ($1) on conflict do nothing`, [u.id]);
      await db.query(`insert into saas_ugc.ugc_profiles(user_id, display_name) values ($1, $2) on conflict (user_id) do nothing`, [u.id, u.raw_user_meta_data.full_name]);
    }
    await db.query(`insert into saas_ugc.ugc_user_roles(user_id, role) values ($1, 'admin') on conflict do nothing`, [users.boss.id]);

    // --- Donnes workspace-scoped (isolation A/B) -----------------------------
    const avatar = async (ws, by, name) => q(`insert into saas_ugc.ugc_avatars(workspace_id, created_by, name, provider)
      values ($1, $2, $3, 'custom') returning id`, [ws, by, name]);
    const avA1 = await avatar(wsA, users.alice.id, 'Avatar Alice 1');
    const avA2 = await avatar(wsA, users.carol.id, 'Avatar Carol (A)');
    const avB1 = await avatar(wsB, users.bob.id, 'Avatar Bob 1');
    const avB2 = await avatar(wsB, users.bob.id, 'Avatar Bob 2');
    const avOrphan = await avatar(wsOrphan, orphanOwner, 'Avatar orphelin');

    const prompt = async (ws, by, title) => q(`insert into saas_ugc.ugc_prompt_templates(workspace_id, created_by, title, category, content, is_system)
      values ($1, $2, $3, 'script', 'Contenu de test suffisant pour le banc.', false) returning id`, [ws, by, title]);
    const prA = await prompt(wsA, users.alice.id, 'Prompt A');
    const prB = await prompt(wsB, users.bob.id, 'Prompt B');

    const project = async (ws, by, title) => q(`insert into saas_ugc.ugc_video_projects(
        workspace_id, owner_user_id, created_by, title, platform, language, aspect_ratio)
      values ($1, $2, $2, $3, 'TikTok', 'fr', '9:16') returning id`, [ws, by, title]);
    const projA = await project(wsA, users.alice.id, 'Projet A');
    const projB = await project(wsB, users.bob.id, 'Projet B');

    // Crédits de départ pour le parcours générations (le seed reelora_v1
    // crédite 9 crédits par profil ; on met à niveau pour les tests RPC).
    for (const u of [users.alice, users.bob]) {
      await db.query(`update saas_ugc.ugc_wallets set available_balance = 100 where user_id = $1`, [u.id]);
    }

    // --- Données user-scoped (données personnelles) --------------------------
    const notif = async (u, title) => q(`insert into saas_ugc.ugc_notifications(user_id, title, body, kind)
      values ($1, $2, 'Notification de test', 'info') returning id`, [u.id, title]);
    const nAlice = await notif(users.alice, 'Notif Alice');
    const nBob = await notif(users.bob, 'Notif Bob');
    const nCaroline = await notif(users.carol, 'Notif Carol');

    // Les formules (free/studio/…) existent déjà : migration 20261108164514.
    const sub = async (u, plan) => q(`insert into saas_ugc.ugc_subscriptions(user_id, plan_key, status)
      values ($1, $2, 'active') on conflict (user_id) do nothing returning user_id`, [u.id, plan]);
    const sAlice = await sub(users.alice, 'free');
    const sBob = await sub(users.bob, 'studio');

    const usage = async (u, kind, quantity) => q(`insert into saas_ugc.ugc_usage_events(user_id, event_kind, quantity, period_key)
      values ($1, $2, $3, to_char(now(), 'YYYY-MM')) returning id`, [u.id, kind, quantity]);
    const uAlice = await usage(users.alice, 'video', 1);
    const uBob = await usage(users.bob, 'video', 2);

    // --- Sondes de claims (table bench : RLS par claim « company ») ----------
    await db.query(`delete from public.bench_claims_probe`);
    await db.query(`insert into public.bench_claims_probe(company, label) values
      ('A', 'Ligne entreprise A'), ('B', 'Ligne entreprise B'), ('C', 'Ligne entreprise C')`);

    // --- Business Grow : quotas de test (wallets par utilisateur) ------------
    await qAll(`insert into saas_business.plans(plan_key, display_name, billing_enabled, monthly_request_limit, active)
      values ('test-400', 'Formule de banc (400 unités)', true, 400, true) on conflict (plan_key) do update
      set active = true, billing_enabled = true, monthly_request_limit = 400`);
    const bgSub = async (u) => q(`insert into saas_business.subscriptions(user_id, plan_key, status, billing_provider, external_customer_id, external_subscription_id, current_period_start, current_period_end)
      values ($1, 'test-400', 'active', 'bench', $2, $3, now(), now() + interval '30 days')
      returning id`, [u.id, `cus-bench-${u.id.slice(0, 8)}`, `sub-bench-${u.id.slice(0, 8)}`]);
    await bgSub(users.alice);
    await bgSub(users.bob);
    for (const u of [users.alice, users.bob]) {
      await db.query(`insert into saas_business.wallets(user_id, period_key, available_units, monthly_allowance)
        values ($1, to_char(now(), 'YYYY-MM'), 400, 400)
        on conflict (user_id) do update set available_units = 400, monthly_allowance = 400`, [u.id]);
    }
    // dave : wallet BG à 0 unité (pas d'abonnement BG). bg_ensure_wallet
    // réinitialise à monthly_allowance (0 ici) → quota épuisé → 402.
    await db.query(`insert into saas_business.wallets(user_id, period_key, available_units, monthly_allowance)
      values ($1, to_char(now(), 'YYYY-MM'), 0, 0)
      on conflict (user_id) do update set available_units = 0, monthly_allowance = 0`, [users.dave.id]);

    return {
      users, workspaces: { A: wsA, B: wsB, orphan: wsOrphan, orphanOwner },
      projects: { A: projA, B: projB },
      brands: { A: brandA, B: brandB }, products: { A: productA, B: productB },
      avatars: { a1: avA1, a2: avA2, b1: avB1, b2: avB2, orphan: avOrphan },
      prompts: { a: prA, b: prB },
      notifications: { alice: nAlice, bob: nBob, carol: nCaroline },
      subscriptions: { alice: sAlice, bob: sBob },
      usage: { alice: uAlice, bob: uBob },
    };
  });
}
