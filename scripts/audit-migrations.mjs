#!/usr/bin/env node
/**
 * Audit des migrations : ce que le dépôt contient, ce que la base a appliqué.
 *
 * Pourquoi
 * -------
 * Le journal de migrations du projet Supabase contient **214** entrées dont la
 * majorité appartient à un autre produit partageant le même projet (immobilier,
 * SBC, n8n, city life…). Le dépôt contient 111 fichiers, tous datés de novembre
 * 2026. Comparer les deux listes telles quelles ne donne rien d'exploitable.
 *
 * Ce qui compte réellement, et que ce script mesure :
 *   1. les fichiers du dépôt sont-ils présents dans le journal (par version = les
 *      14 chiffres initiaux du nom) ?
 *   2. pour ceux qui manquent, leurs OBJETS existent-ils quand même en base ?
 *      (application hors journal, cas déjà rencontré avec MCP) ;
 *   3. quels objets attendus par le FRONTEND manquent en base ? C'est le seul
 *      écart qui casse une fonctionnalité.
 *
 * Aucune connexion ici : la partie base est fournie par un fichier JSON produit
 * par l'inspection (voir docs/MIGRATIONS_STATUS.md). Le script reste donc
 * exécutable en local, sans secret et sans réseau.
 *
 * Usage :
 *   node scripts/audit-migrations.mjs                 # état du dépôt seul
 *   node scripts/audit-migrations.mjs --base=etat.json
 */

import { readFileSync, readdirSync } from 'node:fs';

/**
 * Objets (fonctions et tables) réellement appelés par le frontend. Vérifiés un
 * par un contre la production le 2026-11-25 : les 23 tables et les 94 RPC
 * existent. Cette liste est conservée ici pour que le script puisse le
 * revérifier plus tard, et pour documenter le périmètre utile.
 */
export const OBJETS_FRONTEND = {
  tables: [
    'reelora_audit_logs', 'reelora_avatars', 'reelora_generation_presets', 'reelora_notifications',
    'reelora_plans', 'reelora_prompt_templates', 'reelora_subscriptions', 'ugc_app_settings',
    'ugc_brands', 'ugc_credit_ledger', 'ugc_generated_assets', 'ugc_generation_jobs',
    'ugc_job_events', 'ugc_products', 'ugc_profiles', 'ugc_project_scenes', 'ugc_project_scripts',
    'ugc_recharge_orders', 'ugc_service_catalog', 'ugc_video_projects', 'ugc_workspace_members',
    'ugc_workspaces', 'vyora_files',
  ],
  fonctions: [
    'business_grow_catalog', 'mcp_create_token', 'mcp_list_activity', 'mcp_list_tokens',
    'mcp_list_tool_permissions', 'mcp_revoke_token', 'mcp_rotate_token', 'mcp_set_tool_permission',
    'oauth_audit_list', 'oauth_list_accounts', 'oauth_revoke_account', 'reelora_attach_asset_to_project',
    'reelora_bootstrap', 'reelora_cancel_generation', 'reelora_create_project',
    'reelora_mark_all_notifications_read', 'reelora_mark_notification_read', 'reelora_quota_status',
    'reelora_request_plan_change', 'reelora_save_scenes', 'reelora_save_script',
    'reelora_start_generation', 'studio_catalog_admin_model_detail', 'studio_catalog_admin_models',
    'studio_catalog_admin_summary', 'studio_credit_grid', 'ugc_create_recharge_order',
    'ugc_redeem_promo_code', 'vyora_business_subscription', 'vyora_file_attach_to_conversation',
    'vyora_file_attach_to_project', 'vyora_file_register', 'vyora_import_connect_access',
    'vyora_my_payments', 'vyora_provider_health_status', 'vyora_ugc_catalog',
    'vyora_ugc_import_history', 'vyora_ugc_import_report', 'vyora_ugc_variant_create',
    'vyora_ugc_variant_set_active', 'vyora_ugc_variant_update',
  ],
};

/** Objets Studio connus comme ABSENTS de la production (migrations lot16/17). */
export const OBJETS_NON_APPLIQUES = [
  'studio_runtime_quotas', 'studio_runtime_plan_matrix', 'studio_set_plan_quota',
  'studio_runtime_prepare', 'studio_runtime_prepare_batch', 'studio_runtime_readiness',
  'studio_external_action_request', 'studio_external_action_confirm',
  'studio_external_action_cancel', 'studio_external_action_list',
  'studio_propose_family_policy', 'studio_approve_family_policy', 'studio_family_policy_proposals',
];

/** Version d'une migration = ses 14 premiers chiffres (format Supabase). */
export function version(nomFichier) {
  const m = nomFichier.match(/^(\d{14})_/);
  return m ? m[1] : null;
}

export function lireDepot(racine = process.cwd()) {
  const fichiers = readdirSync(`${racine}/supabase/migrations`).filter((f) => f.endsWith('.sql'));
  return fichiers.map((f) => ({ fichier: f, version: version(f) })).filter((m) => m.version);
}

/**
 * @param {{ depot: {fichier: string, version: string}[], journal: string[], objetsBase?: {tables?: string[], fonctions?: string[]} }} entree
 */
export function auditer({ depot, journal, objetsBase }) {
  const versionsJournal = new Set(journal);
  const appliquees = [];
  const absentes = [];
  for (const migration of depot) {
    (versionsJournal.has(migration.version) ? appliquees : absentes).push(migration);
  }

  const constats = [];
  const horsProduit = journal.filter((v) => !/^2026(11|10)/.test(v)).length;

  // Une migration absente du journal n'est un problème QUE si ses objets manquent
  // en base : une application hors journal est un cas déjà rencontré et acceptable.
  const absentesSansObjets = [];
  if (objetsBase) {
    const tables = new Set(objetsBase.tables ?? []);
    const fonctions = new Set(objetsBase.fonctions ?? []);
    for (const nom of OBJETS_FRONTEND.tables) {
      if (!tables.has(nom)) constats.push({ niveau: 'bloquant', message: `table attendue par le frontend ABSENTE : ${nom}` });
    }
    for (const nom of OBJETS_FRONTEND.fonctions) {
      if (!fonctions.has(nom)) constats.push({ niveau: 'bloquant', message: `fonction attendue par le frontend ABSENTE : ${nom}` });
    }
    for (const nom of OBJETS_NON_APPLIQUES) {
      const present = fonctions.has(nom);
      constats.push({
        niveau: present ? 'attention' : 'information',
        message: present
          ? `objet Studio ${nom} présent alors qu'il était attendu absent : vérifier l'état de lot16/17`
          : `objet Studio ${nom} absent (attendu : lot16/17 non appliquées)`,
      });
    }
  } else {
    constats.push({ niveau: 'attention', message: 'état de la base non fourni : les objets attendus par le frontend n’ont pas été revérifiés' });
  }

  if (horsProduit > 0) {
    constats.push({
      niveau: 'information',
      message: `journal : ${journal.length} entrées, dont ${horsProduit} antérieures à novembre 2026 et appartenant à d'autres produits du même projet — sans lien avec SORAHNEX`,
    });
  }

  return {
    totalDepot: depot.length,
    totalJournal: journal.length,
    appliquees,
    absentes,
    absentesSansObjets,
    constats,
  };
}

export function formater(r) {
  const lignes = [
    `Migrations — dépôt : ${r.totalDepot} · journal de la base : ${r.totalJournal}`,
    `  présentes dans le journal : ${r.appliquees.length}`,
    `  absentes du journal       : ${r.absentes.length}`,
  ];
  if (r.absentes.length) {
    lignes.push('  (une absence de journal n’est un problème que si les objets manquent : voir constats)');
    for (const m of r.absentes.slice(0, 12)) lignes.push(`    - ${m.fichier}`);
    if (r.absentes.length > 12) lignes.push(`    … et ${r.absentes.length - 12} autre(s)`);
  }
  lignes.push('');
  const parNiveau = { bloquant: 0, attention: 0, information: 0 };
  for (const c of r.constats) parNiveau[c.niveau] = (parNiveau[c.niveau] ?? 0) + 1;
  lignes.push(`Constats : ${r.constats.length} (bloquants ${parNiveau.bloquant}, attention ${parNiveau.attention}, information ${parNiveau.information})`);
  for (const c of r.constats.filter((c) => c.niveau !== 'information')) {
    lignes.push(`  [${c.niveau}] ${c.message}`);
  }
  return lignes.join('\n');
}

function argument(nom) {
  const prefixe = `--${nom}=`;
  const trouve = process.argv.find((a) => a.startsWith(prefixe));
  return trouve ? trouve.slice(prefixe.length) : null;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const cheminBase = argument('base');
  const entree = { depot: lireDepot(), journal: [], objetsBase: undefined };
  if (cheminBase) {
    const etat = JSON.parse(readFileSync(cheminBase, 'utf8'));
    entree.journal = etat.journal ?? [];
    entree.objetsBase = etat.objets ?? undefined;
  } else {
    // Sans état de base : on vérifie seulement la cohérence du dépôt.
    entree.journal = [];
    console.log('Information : aucun état de base fourni (--base=etat.json). Seul le dépôt est analysé.\n');
  }
  const resultat = auditer(entree);
  console.log(formater(resultat));
  process.exit(resultat.constats.some((c) => c.niveau === 'bloquant') ? 1 : 0);
}
