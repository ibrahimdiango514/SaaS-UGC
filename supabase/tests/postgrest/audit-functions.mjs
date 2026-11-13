// Suite 05 — Audit des privilèges d'exécution des fonctions (matrice rôle × fonction).
//
// Produit la matrice complète (JSON + Markdown) dans results/ et vérifie les
// invariants de sécurité :
//   1. saas_business.* : AUCUN EXECUTE pour les rôles client
//      (anon, authenticated, service_role) — seule voie = les rôles serveur
//      dédiés (bg_edge / bg_billing_worker / bg_erasure).
//   2. Partition des rôles serveur : fonctions billing → bg_billing_worker
//      SEUL ; fonctions d'effacement → bg_erasure SEUL ; chaque fonction a
//      exactement un destinataire.
//   3. public.vyora_payment_* : service_role SEUL (webhooks/serveur).
//   4. public.vyora_admin_* : jamais anon (authentifié + contrôle claim
//      interne, et/ou service_role).
//   5. RPC public.reelora_* client-facing : authenticated (+ service_role),
//      jamais anon.
//   6. Toutes les fonctions saas_business sont SECURITY DEFINER avec
//      search_path figée (pg_catalog, saas_business).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHarness } from './harness.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROLES = ['anon', 'authenticated', 'service_role', 'bg_edge', 'bg_billing_worker', 'bg_erasure', 'postgres', 'supabase_admin'];
const APP_SCHEMAS = ['public', 'saas_business', 'saas_ugc', 'ugc_private', 'auth', 'vault', 'net', 'cron', 'storage'];
const CLIENT = [0, 1, 2]; // indexes anon, authenticated, service_role

export async function run(ctx) {
  const h = makeHarness({ baseUrl: 'http://127.0.0.1:1', title: '05 — Audit fonctions (matrice EXECUTE × rôles)' });
  const q = (sql, params = []) => ctx.adminQuery(sql, params);

  const rows = await q(`
    select n.nspname as schema,
           p.proname as function,
           p.prosecdef as definer,
           (select string_agg(x, ', ') from unnest(p.proconfig) cfg(x) where x like 'search_path%') as search_path,
           exists (select 1 from pg_trigger t where t.tgfoid = p.oid and not t.tgisinternal) as trigger_fn,
           (select count(*) from pg_proc xz join pg_namespace nx on nx.oid = xz.pronamespace
              where xz.oid <> p.oid and xz.prosrc like '%' || p.proname || '%') as internal_ref,
           ${ROLES.map((role, i) => `has_function_privilege('${role}', p.oid, 'EXECUTE') as r${i}`).join(',\n           ')}
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = any($1)
    order by 1, 2
  `, [APP_SCHEMAS]);

  // --- Matrice lisible (Markdown + JSON) ------------------------------------
  const bySchema = new Map();
  for (const row of rows) {
    if (!bySchema.has(row.schema)) bySchema.set(row.schema, []);
    bySchema.get(row.schema).push(row);
  }
  let md = `# Audit des fonctions — matrice EXECUTE par rôle\n\n`;
  md += `Banc PostgREST local — PG 17 réel, socle Supabase + migrations du dépôt.\n\n`;
  md += `Légende : **1** = EXECUTE accordé, · = refusé, D = SECURITY DEFINER, T = fonction de trigger (appelée par le propriétaire de la table, pas par EXECUTE).\n`;
  for (const [schema, fns] of bySchema) {
    md += `\n## ${schema} (${fns.length} fonctions)\n\n`;
    md += `| Fonction | D | ${ROLES.map((x) => x.replace('_', '\u2011')).join(' | ')} |\n`;
    md += `|---|---|${ROLES.map(() => '---').join('|')}|\n`;
    for (const fn of fns) {
      const cells = ROLES.map((_, i) => (fn[`r${i}`] ? '**1**' : '·')).join(' | ');
      md += `| ${fn.function}${fn.trigger_fn ? ' (T)' : ''} | ${fn.definer ? 'D' : '·'} | ${cells} |\n`;
    }
  }
  const outDir = join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'audit-functions.md'), md);
  writeFileSync(join(outDir, 'audit-functions.json'), JSON.stringify(
    { generated_at: new Date().toISOString(), roles: ROLES,
      total_functions: rows.length,
      by_schema: Object.fromEntries([...bySchema].map(([s, fns]) => [s, fns.length])),
      functions: rows.map(({ schema, function: fn, definer, search_path, trigger_fn: triggerFn, internal_ref: internalRef, ...rest }) =>
        ({ schema, fn, definer, trigger: triggerFn, search_path, internal_ref: internalRef, execute: ROLES.map((role, i) => rest[`r${i}`] ? role : null) })) },
    null, 2));

  // --- Invariants -------------------------------------------------------------
  // 1. saas_business : aucun rôle client.
  const bgFns = rows.filter((x) => x.schema === 'saas_business');
  const bgClientLeaks = bgFns.filter((fn) => CLIENT.some((i) => fn[`r${i}`]));
  h.check(bgClientLeaks.length === 0,
    'invariant : saas_business.* — AUCUN EXECUTE pour anon/authenticated/service_role',
    `fuites = ${bgClientLeaks.map((f) => f.function).join(', ') || 'aucune'}`);

  // 2. Partition des rôles serveur (les fonctions de trigger, notées (T),
  //    sont exécutées par le propriétaire de la table : pas de destinataire
  //    EXECUTE attendu, et elles ne doivent en recevoir aucun).
  const bgPlain = bgFns.filter((f) => !f.trigger_fn);
  const bgTriggers = bgFns.filter((f) => f.trigger_fn);
  const billingFns = bgPlain.filter((f) => /billing_event/.test(f.function));
  h.check(billingFns.length === 5 && billingFns.every((f) => f.r4 && !f.r3 && !f.r5 && !CLIENT.some((i) => f[`r${i}`])),
    'invariant : fonctions billing_event → bg_billing_worker SEUL (5 fns, sans surchevauchée)',
    billingFns.map((f) => `${f.function}[edge=${f.r3},billing=${f.r4},erasure=${f.r5}]`).join(' '));
  const erasureFns = bgPlain.filter((f) => /erasure/.test(f.function));
  h.check(erasureFns.length === 1 && erasureFns.every((f) => f.r5 && !f.r3 && !f.r4 && !CLIENT.some((i) => f[`r${i}`])),
    'invariant : effacement de compte → bg_erasure SEUL',
    erasureFns.map((f) => `${f.function}[edge=${f.r3},billing=${f.r4},erasure=${f.r5}]`).join(' '));
  const edgeOnly = bgPlain.filter((f) => f.r3 && !f.r4 && !f.r5);
  // Sans destinataire = helper interne : appelé par d'autres fonctions
  // (SECURITY DEFINER, qui exécutent comme le propriétaire — pas d'EXECUTE
  // requis) ou par un chemin serveur documenté. Aucune ne peut être appelée
  // directement par un client (aucun EXECUTE client, invariant n°1).
  const KNOWN_SERVER_CALLED = new Set([
    // Appelé par l'Edge Function vyora-provider-health (jeton Vault serveur).
    'vyora_record_provider_verification',
  ]);
  const internal = bgPlain.filter((f) => !f.r3 && !f.r4 && !f.r5 && !CLIENT.some((i) => f[`r${i}`]) && (f.internal_ref > 0 || KNOWN_SERVER_CALLED.has(f.function)));
  const unexplained = bgPlain.filter((f) => !f.r3 && !f.r4 && !f.r5 && !CLIENT.some((i) => f[`r${i}`]) && !(f.internal_ref > 0 || KNOWN_SERVER_CALLED.has(f.function)));
  h.check(edgeOnly.length + billingFns.length + erasureFns.length + internal.length === bgPlain.length && unexplained.length === 0,
    'invariant : partition saas_business sans trou ni doublon — chaque fonction (hors trigger) a un rôle serveur destinataire OU est un helper interne appelé par d\'autres fonctions (jamais accessible au client)',
    `edge=${edgeOnly.length} billing=${billingFns.length} erasure=${erasureFns.length} helpers-internes=${internal.length} inexpliquées=${unexplained.map((f) => f.function).join(',') || 'aucune'}`);
  const triggerLeaks = bgTriggers.filter((f) => [f.r3, f.r4, f.r5, ...CLIENT.map((i) => f[`r${i}`])].some(Boolean));
  h.check(bgTriggers.length >= 5 && triggerLeaks.length === 0,
    `invariant : fonctions de trigger saas_business (${bgTriggers.length}) — aucun destinataire EXECUTE (elles ne s'exécutent que par le propriétaire de la table)`,
    `fuites = ${triggerLeaks.map((f) => f.function).join(', ') || 'aucune'}`);

  // 3. vyora_payment_* : service_role seul.
  const paymentFns = rows.filter((x) => x.schema === 'public' && /^vyora_payment_/.test(x.function));
  const paymentLeaks = paymentFns.filter((f) => f.r0 || f.r1);
  h.check(paymentFns.length >= 25 && paymentLeaks.length === 0,
    `invariant : public.vyora_payment_* (${paymentFns.length} fns) → service_role SEUL (aucun accès anon/authenticated direct)`,
    `fuites = ${paymentLeaks.map((f) => f.function).join(', ') || 'aucune'}`);

  // 4. vyora_admin_* : jamais anon.
  const adminFns = rows.filter((x) => x.schema === 'public' && /^vyora_admin_/.test(x.function));
  const adminLeaks = adminFns.filter((f) => f.r0);
  h.check(adminFns.length >= 19 && adminLeaks.length === 0,
    `invariant : public.vyora_admin_* (${adminFns.length} fns) — jamais anon (le filtrage admin se fait sur les claims JWT + rôle, jamais côté client)`,
    `fuites anon = ${adminLeaks.map((f) => f.function).join(', ') || 'aucune'}`);

  // 5. reelora_* client-facing : authenticated + service_role, jamais anon.
  const reeloraFns = rows.filter((x) => x.schema === 'public' && /^reelora_/.test(x.function));
  // Seul l'anon est toléré pour la sonde de bootstrap du 1er admin
  // (sondage d'accessibilité en lecture, protégée en interne).
  const KNOWN_ANON_ALLOWED = new Set(['reelora_first_admin_bootstrap_available']);
  const reeloraAnon = reeloraFns.filter((f) => f.r0 && !KNOWN_ANON_ALLOWED.has(f.function));
  const reeloraAnonKnown = reeloraFns.filter((f) => f.r0 && KNOWN_ANON_ALLOWED.has(f.function));
  const reeloraAuth = reeloraFns.filter((f) => f.r1);
  h.check(reeloraFns.length >= 40 && reeloraAnon.length === 0 && reeloraAnonKnown.length === 1 && reeloraAuth.length >= 30,
    `invariant : public.reelora_* (${reeloraFns.length} fns) — la surface client passe par authenticated ; seule exception anon = la sonde de bootstrap du 1er admin (documentée)`,
    `anon-inattendu=${reeloraAnon.map((f) => f.function).join(', ') || 'aucune'} exception=${reeloraAnonKnown.map((f) => f.function).join(', ')} authenticated=${reeloraAuth.length}`);

  // 6. saas_business (hors trigger) : SECURITY DEFINER + search_path figée.
  //    Seule exception : les helpers de sérialisation purs (sans DML, sans
  //    destinataire EXECUTE — appelés uniquement à l'intérieur des fonctions
  //    SECURITY DEFINER, qui portent le contexte des privilèges).
  const KNOWN_PURE_HELPERS = new Set(['vyora_payment_order_json', 'vyora_payment_refund_json']);
  const notDefiner = bgPlain.filter((f) => !f.definer);
  const unknownNotDefiner = notDefiner.filter((f) => !KNOWN_PURE_HELPERS.has(f.function));
  const pureExposed = notDefiner.filter((f) => [f.r0, f.r1, f.r2, f.r3, f.r4, f.r5].some(Boolean));
  h.check(unknownNotDefiner.length === 0 && pureExposed.length === 0,
    'invariant : saas_business.* (hors trigger) — 100 % SECURITY DEFINER, sauf 2 helpers de sérialisation purs (sans DML, AUCUN EXECUTE, appelés uniquement en interne)',
    `hors-définition inattendus=${unknownNotDefiner.map((f) => f.function).join(', ') || 'aucune'} ; helpers exposés=${pureExposed.map((f) => f.function).join(', ') || 'aucune'}`);
  // Deux formes strictes : 'pg_catalog, saas_business' ou '' (vide — le plus
  // strict : tous les objets doivent être qualifiés, aucun shadowing possible).
  const strictPath = (sp) => !!sp && (sp.includes('pg_catalog') && sp.includes('saas_business') || sp === 'search_path=""');
  const loosePath = bgPlain.filter((f) => !strictPath(f.search_path));
  h.check(loosePath.length === 0,
    'invariant : saas_business.* (hors trigger) — search_path figée (pg_catalog, saas_business) ou vide sur toutes les fonctions : pas de shadowing de schéma',
    `permissive = ${loosePath.map((f) => `${f.function}[${f.search_path || '∅'}]`).join(' ; ') || 'aucune'}`);

  // 7. Surface client effective : public uniquement.
  const clientSurface = rows.filter((x) => (x.r0 || x.r1) && x.schema === 'public');
  h.check(clientSurface.length > 0 && clientSurface.every((f) => f.schema === 'public'),
    `invariant : surface client effective = ${clientSurface.length} fonctions du schéma public uniquement (aucune fonction saas_business n'est exécutée par un client)`,
    `exemples : ${clientSurface.slice(0, 3).map((f) => f.function).join(', ')}…`);

  return h.finish();
}

// Exécution autonome : `npm run audit` (monte l'environnement seul).
const isDirect = process.argv[1] && fileURLToPath(new URL(import.meta.url)) === path.resolve(process.argv[1]);
if (isDirect) {
  const { setupEnv } = await import('./env.mjs');
  const { withClient } = await import('./pg.mjs');
  console.log('═ Audit des fonctions : matrice EXECUTE par rôle (banc PG 17, migrations du dépôt)');
  const env = await setupEnv({ fresh: true, log: (m) => console.log(m) });
  const ctx = {
    adminQuery: async (sql, params = []) => (await withClient('postgres', (db) => db.query(sql, params))).rows,
  };
  const res = await run(ctx);
  console.log(`\n╚══ ${res.title} : ${res.failed === 0 ? res.total + '/' + res.total + ' vérifications réussies' : 'ÉCHEC (' + res.failed + ')'}`);
  console.log('\nMatrice écrite : results/audit-functions.md et .json');
  await env.pgServer.stop();
  process.exit(res.failed === 0 ? 0 : 1);
}
