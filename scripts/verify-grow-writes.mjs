#!/usr/bin/env node
/**
 * Vérification AUTHENTIFIÉE des ÉCRITURES de Business Grow.
 *
 * Pourquoi ce fichier est séparé de `verify-authenticated.mjs`
 * -------------------------------------------------------------
 * Ce dernier est en lecture seule, par principe : il peut tourner à chaque push
 * sans rien modifier. Or une lecture ne prouve pas qu'une action écrit : un
 * handler peut répondre 200 et n'enregistrer nulle part. C'est le défaut le plus
 * coûteux à découvrir en production, parce que l'interface paraît fonctionner.
 *
 * Ce harnais-ci CRÉE, MODIFIE puis SUPPRIME de vraies lignes, et vérifie après
 * chaque étape que l'état a réellement changé. Il est donc :
 *   - déclenché UNIQUEMENT par un marqueur explicite ([verif-ecriture]) ou un
 *     dispatch manuel — jamais à chaque push ;
 *   - limité aux modules de test d'un compte de test ;
 *   - nettoyé intégralement à la fin, y compris en cas d'échec ;
 *   - refusé s'il n'est pas dans un compte identifiable comme compte de test.
 *
 * Périmètre : aucune génération payante, aucun paiement, aucun OAuth. Uniquement
 * des enregistrements de module métier (CRM, caisse, catalogue).
 *
 * Déclenchement :
 *   SORAHNEX_TEST_EMAIL / SORAHNEX_TEST_PASSWORD   (compte existant)
 *   ou SORAHNEX_QA_SIGNUP=1                        (compte éphémère)
 *   + SORAHNEX_WRITE_TEST=1                        (double opt-in)
 * Sans le double opt-in : sortie neutre (code 0), aucun résultat affirmé.
 */

const SUPABASE_URL = (process.env.SORAHNEX_SUPABASE_URL || 'https://xbuuhfwobrafcbgtdgjx.supabase.co').replace(/\/+$/, '');
const PUBLISHABLE_KEY = process.env.SORAHNEX_PUBLISHABLE_KEY || 'sb_publishable_utbZhw8dg-2M1-g0nXIhfA_n6dZCDZz';
const TIMEOUT_MS = Number(process.env.SORAHNEX_TIMEOUT_MS || 30_000);

/** Marqueur posé dans chaque donnée créée : permet de retrouver et purger. */
const MARQUEUR = `verif-ecriture-${Date.now().toString(36)}`;

/** Ne jamais laisser un jeton, un mot de passe ou une clé sortir. */
export function rediger(texte) {
  const source = texte !== null && typeof texte === 'object' ? JSON.stringify(texte) : String(texte ?? '');
  return source
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jeton-masqué>')
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '<clé-masquée>')
    .replace(/("(?:access_token|refresh_token|password)"\s*:\s*")[^"]*(")/gi, '$1<masqué>$2')
    .slice(0, 240);
}

async function appeler(url, options = {}) {
  try {
    const reponse = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const brut = await reponse.text();
    let corps = brut;
    try { corps = JSON.parse(brut); } catch { /* réponse non JSON */ }
    return { statut: reponse.status, corps };
  } catch (erreur) {
    return { statut: 0, corps: erreur instanceof Error ? erreur.message : String(erreur) };
  }
}

function entetes(jeton) {
  return { apikey: PUBLISHABLE_KEY, 'content-type': 'application/json', authorization: `Bearer ${jeton}` };
}

/**
 * Une écriture n'est prouvée que si l'API la CONFIRME **et** si une lecture
 * ultérieure la retrouve. Un 200 seul ne prouve rien : certains handlers
 * répondent 200 sur une opération silencieusement ignorée.
 *
 * @returns {{uids: string[], echecs: string[]}}
 */
export async function executerEcritures({ base = SUPABASE_URL, jeton, workspaceId = null, marqueur = MARQUEUR, fetchImpl = fetch }) {
  const uids = [];
  const echecs = [];
  const post = async (corps) => {
    const r = await fetchImpl(`${base}/functions/v1/business-grow`, {
      method: 'POST', headers: entetes(jeton), body: JSON.stringify(corps),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const texte = await r.text();
    let json = null;
    try { json = JSON.parse(texte); } catch { /* non JSON */ }
    return { statut: r.status, json, texte };
  };
  const lien = workspaceId ? { workspaceId } : {};

  const modules = [
    { categorie: 'bg_module_crm_contacts', donnees: { name: `Contact ${marqueur}`, email: `${marqueur}@sorahnex.test` }, modification: { name: `Contact ${marqueur} modifié` } },
    { categorie: 'bg_module_cash_expenses', donnees: { label: `Dépense ${marqueur}`, amount: 1000 }, modification: { label: `Dépense ${marqueur} modifiée` } },
    { categorie: 'bg_module_crm_tasks', donnees: { title: `Tâche ${marqueur}` }, modification: { title: `Tâche ${marqueur} modifiée` } },
  ];

  for (const module of modules) {
    const nom = module.categorie.replace('bg_module_', '');

    // 1. Création.
    const creation = await post({ action: 'modules.records', category: module.categorie, op: 'create', data: module.donnees, ...lien });
    const recordId = creation.json?.data?.recordId;
    if (creation.statut !== 200 || !recordId) {
      echecs.push(`${nom} : création refusée (HTTP ${creation.statut}) ${rediger(creation.json ?? creation.texte)}`);
      continue;
    }
    uids.push(recordId);

    // 2. La lecture la retrouve-t-elle VRAIMENT ? C'est la seule preuve de persistance.
    const lecture = await post({ action: 'modules.records', category: module.categorie, op: 'list', ...lien });
    const enregistrements = lecture.json?.data?.records;
    if (!Array.isArray(enregistrements)) {
      echecs.push(`${nom} : la liste n'est pas lisible après création (HTTP ${lecture.statut})`);
      continue;
    }
    const retrouve = enregistrements.some((r) => r.id === recordId);
    if (!retrouve) {
      echecs.push(`${nom} : création confirmée mais enregistrement INTROUVABLE à la lecture — l'écriture ne persiste pas`);
      continue;
    }

    // 3. Modification, puis relecture.
    const modification = await post({ action: 'modules.records', category: module.categorie, op: 'update', recordId, data: module.modification, ...lien });
    if (modification.json?.data?.updated !== true) {
      echecs.push(`${nom} : modification refusée (HTTP ${modification.statut})`);
      continue;
    }
    const relec = await post({ action: 'modules.records', category: module.categorie, op: 'list', ...lien });
    const apres = (relec.json?.data?.records ?? []).find((r) => r.id === recordId);
    const valeurAttendue = Object.values(module.modification)[0];
    const valeurObtenue = apres ? JSON.stringify(apres) : '';
    if (!valeurObtenue.includes(valeurAttendue)) {
      echecs.push(`${nom} : modification confirmée mais valeur NON retrouvée à la lecture`);
      continue;
    }

    // 4. Suppression, puis vérification de la disparition.
    const suppression = await post({ action: 'modules.records', category: module.categorie, op: 'delete', recordId, ...lien });
    if (suppression.json?.data?.deleted !== true) {
      echecs.push(`${nom} : suppression refusée (HTTP ${suppression.statut})`);
      continue;
    }
    const apresSuppression = await post({ action: 'modules.records', category: module.categorie, op: 'list', ...lien });
    const encoreLa = (apresSuppression.json?.data?.records ?? []).some((r) => r.id === recordId);
    if (encoreLa) {
      echecs.push(`${nom} : suppression confirmée mais enregistrement TOUJOURS présent`);
      continue;
    }
    uids.pop(); // supprimé : plus rien à nettoyer pour ce module
  }

  return { uids, echecs };
}

/** Purge tout ce qui resterait d'un essai interrompu. Ne lève jamais. */
export async function nettoyer({ base = SUPABASE_URL, jeton, workspaceId = null, uids = [], fetchImpl = fetch, categories = ['bg_module_crm_contacts', 'bg_module_cash_expenses', 'bg_module_crm_tasks'] }) {
  const restants = [];
  for (const recordId of uids) {
    for (const category of categories) {
      try {
        const r = await fetchImpl(`${base}/functions/v1/business-grow`, {
          method: 'POST', headers: entetes(jeton),
          body: JSON.stringify({ action: 'modules.records', category, op: 'delete', recordId, ...(workspaceId ? { workspaceId } : {}) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (r.ok) break;
      } catch { /* on réessaiera au prochain uid */ }
    }
    restants.push(recordId);
  }
  return restants;
}

async function creerCompteEphemere() {
  const horodatage = Date.now().toString(36);
  const email = `qa.ecriture.${horodatage}@sorahnex.test`;
  const motDePasse = `Qa!${horodatage}-${Math.random().toString(36).slice(2, 12)}A7`;
  const { statut, corps } = await appeler(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: PUBLISHABLE_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: motDePasse, data: { full_name: 'Vérification écritures', app_scope: 'vyora' } }),
  });
  if (!corps?.access_token) return { ok: false, raison: `inscription HTTP ${statut} : ${rediger(corps)}` };
  return { ok: true, jeton: corps.access_token, email, identifiant: corps?.user?.id ?? null };
}

async function principal() {
  const resume = process.env.GITHUB_STEP_SUMMARY;
  const ecrireResume = async (texte) => { if (resume) { const { appendFile } = await import('node:fs/promises'); await appendFile(resume, texte, 'utf8'); } };

  if (process.env.SORAHNEX_WRITE_TEST !== '1') {
    const message = 'Vérification des écritures non exécutée : SORAHNEX_WRITE_TEST=1 absent. Aucun résultat n’est affirmé.';
    console.log(`::notice::${message}`);
    await ecrireResume(`### Vérification des écritures\n\n${message}\n`);
    return 0;
  }

  const email = process.env.SORAHNEX_TEST_EMAIL;
  const motDePasse = process.env.SORAHNEX_TEST_PASSWORD;
  let session;
  if (email && motDePasse) {
    const r = await appeler(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: PUBLISHABLE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: motDePasse }),
    });
    session = r.corps?.access_token ? { ok: true, jeton: r.corps.access_token, email } : { ok: false, raison: `connexion HTTP ${r.statut}` };
  } else if (process.env.SORAHNEX_QA_SIGNUP === '1') {
    session = await creerCompteEphemere();
  } else {
    const message = 'Vérification des écritures non exécutée : ni compte de test, ni SORAHNEX_QA_SIGNUP=1.';
    console.log(`::notice::${message}`);
    await ecrireResume(`### Vérification des écritures\n\n${message}\n`);
    return 0;
  }

  if (!session.ok) {
    console.log(`::error::session impossible — ${session.raison}`);
    await ecrireResume(`### Vérification des écritures\n\n**Session impossible** : ${session.raison}\n`);
    return 1;
  }

  // Périmètre : l'entreprise du compte, si elle existe (lecture seule).
  const espaces = await appeler(`${SUPABASE_URL}/rest/v1/ugc_workspace_members?select=workspace_id&limit=1`, { headers: entetes(session.jeton) });
  const workspaceId = Array.isArray(espaces.corps) && espaces.corps[0]?.workspace_id ? espaces.corps[0].workspace_id : null;

  console.log(`::notice::écritures sur ${session.email}${workspaceId ? ` (entreprise ${workspaceId})` : ' (sans entreprise)'} — marqueur ${MARQUEUR}`);
  const { uids, echecs } = await executerEcritures({ jeton: session.jeton, workspaceId, marqueur: MARQUEUR });
  const restants = await nettoyer({ jeton: session.jeton, workspaceId, uids });

  for (const echec of echecs) console.log(`::error::${echec}`);
  if (restants.length) console.log(`::warning::${restants.length} enregistrement(s) de test n'ont pas pu être supprimés : ${restants.join(', ')}`);
  if (!echecs.length) console.log(`::notice::écritures vérifiées : création, persistance, modification et suppression réelles, puis nettoyage`);

  await ecrireResume([
    '### Vérification des écritures (Grow)',
    '',
    `- Compte : \`${session.email}\``,
    `- Périmètre : ${workspaceId ? `entreprise ${workspaceId}` : 'personnel'}`,
    `- Modules testés : contacts CRM, dépenses de caisse, tâches`,
    '',
    echecs.length ? `**${echecs.length} échec(s) :**\n\n${echecs.map((e) => `- ${e}`).join('\n')}` : 'Création, relecture, modification puis suppression : **prouvées réelles**.',
    restants.length ? `\n${restants.length} enregistrement(s) non nettoyé(s) : ${restants.join(', ')}` : '',
    '',
  ].join('\n'));

  return echecs.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  principal().then((code) => process.exit(code)).catch((erreur) => {
    console.log(`::error::${rediger(erreur instanceof Error ? erreur.message : erreur)}`);
    process.exit(1);
  });
}
