#!/usr/bin/env node
/**
 * Vérification AUTHENTIFIÉE de SORAHNEX contre le backend réel.
 *
 * Pourquoi ce script existe
 * -------------------------
 * Les sondes anonymes ne prouvent qu'une chose : la fonction refuse un appel sans
 * jeton. Elles ne disent RIEN sur ce qui se passe une fois connecté — or c'est là
 * que vivent Grow, Studio, MCP et les intégrations. Ce script obtient une vraie
 * session GoTrue puis appelle les mêmes actions que l'interface, et constate les
 * réponses réelles.
 *
 * Il est exécuté par un runner GitHub (cet environnement de développement n'a pas
 * d'accès réseau aux domaines de production), ou en local par un développeur qui
 * a cet accès.
 *
 * Périmètre : LECTURE SEULE. Aucune action d'écriture n'est envoyée : ni création
 * de prospect, ni génération payante, ni connexion OAuth. On vérifie que le
 * backend répond juste à un utilisateur connecté, sans rien modifier ni dépenser.
 *
 * Identifiants
 * ------------
 * - `SORAHNEX_TEST_EMAIL` + `SORAHNEX_TEST_PASSWORD` : compte de test existant.
 * - sinon, `SORAHNEX_QA_SIGNUP=1` : crée un compte de test éphémère via la route
 *   d'inscription PUBLIQUE (la même que n'importe quel visiteur ; `mailer_autoconfirm`
 *   est actif, aucun e-mail n'est envoyé). Le mot de passe est engendré sur place,
 *   jamais journalisé, jamais écrit dans le dépôt.
 * - sans les deux : sortie « neutre » (code 0) avec l'explication. Un test qui ne
 *   peut pas tourner ne doit pas faire croire à un échec du produit.
 *
 * Aucun secret n'est lu ni affiché : seule la clé PUBLIQUE du projet est utilisée,
 * celle qui est déjà livrée au navigateur.
 */

const SUPABASE_URL = (process.env.SORAHNEX_SUPABASE_URL || 'https://xbuuhfwobrafcbgtdgjx.supabase.co').replace(/\/+$/, '');
const PUBLISHABLE_KEY = process.env.SORAHNEX_PUBLISHABLE_KEY || 'sb_publishable_utbZhw8dg-2M1-g0nXIhfA_n6dZCDZz';
const TIMEOUT_MS = Number(process.env.SORAHNEX_TIMEOUT_MS || 30_000);

/** Ne jamais laisser un jeton, un mot de passe ou une clé sortir dans les journaux. */
export function rediger(texte) {
  // Un corps JSON doit être sérialisé AVANT rédaction : String(objet) ne produit
  // que « [object Object] », ce qui effacerait précisément le code d'erreur cherché.
  const source = texte !== null && typeof texte === 'object' ? JSON.stringify(texte) : String(texte ?? '');
  return source
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jeton-masqué>')
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '<clé-masquée>')
    .replace(/("(?:access_token|refresh_token|password)"\s*:\s*")[^"]*(")/gi, '$1<masqué>$2')
    .slice(0, 240);
}

/**
 * Classe une réponse. Un refus MÉTIER structuré (4xx avec un code) prouve que le
 * handler a tourné ; une panne d'artefact ou une 5xx ne le prouve pas et doit
 * faire échouer la vérification.
 */
export function classer(statut, corps) {
  const texte = typeof corps === 'string' ? corps : JSON.stringify(corps ?? null);
  if (/ARTIFACT_UNAVAILABLE|ARTIFACT_LOAD_FAILED/.test(texte)) return 'ARTEFACT';
  if (statut === 0) return 'AUCUNE RÉPONSE';
  if (statut >= 500) return 'PANNE';
  // Un 403 AVEC un code métier est une restriction d'accès voulue (par exemple
  // BUSINESS_GROW_SUBSCRIPTION_REQUIRED : Import & Connect est réservé aux
  // abonnés). La session est valide, le handler a tourné et a décidé : c'est un
  // résultat, pas une panne. Un 403 sans code, ou un 401, reste un refus de
  // session — ce qui serait un vrai échec pour un test censé être connecté.
  const codeMetier = /\berror\b/.test(texte) && /"code"\s*:\s*"[A-Z_]+"/.test(texte);
  if (statut === 403 && codeMetier) return 'ACCÈS RESTREINT';
  if (statut === 401 || statut === 403) return 'SESSION REFUSÉE';
  if (statut >= 200 && statut < 300) return 'OK';
  if (statut >= 400 && statut < 500) return 'REFUS MÉTIER';
  return 'INATTENDU';
}

/** Une vérification échoue sur panne réelle, pas sur un refus métier attendu. */
export function estEchec(verdict) {
  return verdict === 'ARTEFACT' || verdict === 'PANNE' || verdict === 'AUCUNE RÉPONSE' || verdict === 'SESSION REFUSÉE';
}

async function appeler(url, options = {}) {
  try {
    const reponse = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const brut = await reponse.text();
    let corps = brut;
    try { corps = JSON.parse(brut); } catch { /* réponse non JSON : gardée telle quelle */ }
    return { statut: reponse.status, corps };
  } catch (erreur) {
    return { statut: 0, corps: erreur instanceof Error ? erreur.message : String(erreur) };
  }
}

function entetes(jeton) {
  const base = { apikey: PUBLISHABLE_KEY, 'content-type': 'application/json' };
  return jeton ? { ...base, authorization: `Bearer ${jeton}` } : base;
}

/** Inscription publique d'un compte de test éphémère. Aucun e-mail n'est envoyé. */
async function creerCompteEphemere() {
  const horodatage = Date.now().toString(36);
  const email = `qa.${horodatage}@sorahnex.test`;
  const motDePasse = `Qa!${horodatage}-${Math.random().toString(36).slice(2, 12)}A7`;
  const { statut, corps } = await appeler(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: entetes(),
    body: JSON.stringify({ email, password: motDePasse, data: { full_name: 'Vérification QA', app_scope: 'vyora' } }),
  });
  const jeton = corps?.access_token;
  if (!jeton) {
    return { ok: false, raison: `inscription HTTP ${statut} : ${rediger(corps)}`, email };
  }
  return { ok: true, jeton, email, identifiant: corps?.user?.id ?? null };
}

async function connecter(email, motDePasse) {
  const { statut, corps } = await appeler(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: entetes(),
    body: JSON.stringify({ email, password: motDePasse }),
  });
  if (!corps?.access_token) return { ok: false, raison: `connexion HTTP ${statut} : ${rediger(corps)}` };
  return { ok: true, jeton: corps.access_token, identifiant: corps?.user?.id ?? null };
}

/**
 * Les actions réellement appelées par l'interface (src/business/api.ts,
 * src/mcp/serveurs.ts, src/lib/api.ts). Toutes en lecture.
 */
export function sondes(jeton, workspaceId = null) {
  const bg = (action, valeurs = {}) => ({
    nom: `business-grow · ${action}`,
    url: `${SUPABASE_URL}/functions/v1/business-grow`,
    init: { method: 'POST', headers: entetes(jeton), body: JSON.stringify({ action, ...valeurs }) },
  });
  const modules = [
    'bg_module_crm_contacts',
    'bg_module_crm_opportunities',
    'bg_module_crm_tasks',
    'bg_module_cash_expenses',
    'bg_module_catalog_products',
    'bg_module_marketing_campaigns',
    'bg_module_payment_recovery',
    'bg_module_automation_rules',
  ];
  return [
    bg('status'),
    bg('quota.status'),
    bg('conversations.list'),
    bg('memory.get'),
    bg('integrations.list'),
    bg('tools.list'),
    // `agent.reports.list` exige une entreprise : sans elle, le backend répond
    // 400 INVALID_WORKSPACE, ce qui est le contrat attendu, pas une panne.
    bg('agent.reports.list', workspaceId ? { workspaceId } : {}),
    ...modules.map((category) => ({
      ...bg('modules.records', { category, op: 'list', ...(workspaceId ? { workspaceId } : {}) }),
      nom: `business-grow · module ${category.replace('bg_module_', '')}${workspaceId ? ' (par entreprise)' : ''}`,
    })),
    {
      nom: 'mcp-client · gestion/lister',
      url: `${SUPABASE_URL}/functions/v1/mcp-client/gestion/lister`,
      init: { method: 'POST', headers: entetes(jeton), body: '{}' },
    },
    // `universal-catalog` n'expose AUCUNE action de lecture : ses seules actions
    // (sync_muapi, sync_muapi_details, validate_muapi_input) écrivent ou
    // déclenchent un travail fournisseur. On ne les sonde donc pas ici — la
    // vérification de production couvre déjà sa présence et son refus anonyme.
    {
      nom: 'reelora-video · catalog',
      url: `${SUPABASE_URL}/functions/v1/reelora-video`,
      init: { method: 'POST', headers: entetes(jeton), body: JSON.stringify({ action: 'catalog' }) },
    },
    {
      nom: 'studio-runtime · quotas',
      url: `${SUPABASE_URL}/functions/v1/studio-runtime`,
      init: { method: 'POST', headers: entetes(jeton), body: JSON.stringify({ action: 'quotas' }) },
    },
  ];
}

async function principal() {
  const lignes = [];
  const resume = process.env.GITHUB_STEP_SUMMARY;
  let compte = null;

  const email = process.env.SORAHNEX_TEST_EMAIL;
  const motDePasse = process.env.SORAHNEX_TEST_PASSWORD;
  let session;
  if (email && motDePasse) {
    session = await connecter(email, motDePasse);
    compte = email;
  } else if (process.env.SORAHNEX_QA_SIGNUP === '1') {
    session = await creerCompteEphemere();
    compte = session.email;
  } else {
    const message = 'Vérification authentifiée non exécutée : ni compte de test (SORAHNEX_TEST_EMAIL / SORAHNEX_TEST_PASSWORD), ni SORAHNEX_QA_SIGNUP=1. Aucun résultat n’est affirmé.';
    console.log(`::notice::${message}`);
    if (resume) await ecrire(resume, `### Vérification authentifiée\n\n${message}\n`);
    return 0;
  }

  if (!session.ok) {
    console.log(`::error::Session impossible — ${session.raison}`);
    if (resume) await ecrire(resume, `### Vérification authentifiée\n\n**Session impossible** : ${session.raison}\n`);
    return 1;
  }
  console.log(`::notice::session obtenue pour ${compte} (identifiant ${session.identifiant ?? 'inconnu'})`);
  lignes.push(`Session GoTrue obtenue pour \`${compte}\`.`);

  // Une entreprise (espace de travail) est nécessaire aux actions par périmètre.
  // Lecture seule : on cherche celle du compte, on n'en crée pas.
  const espaces = await appeler(`${SUPABASE_URL}/rest/v1/ugc_workspace_members?select=workspace_id&limit=1`, {
    headers: entetes(session.jeton),
  });
  const workspaceId = Array.isArray(espaces.corps) && espaces.corps[0]?.workspace_id ? espaces.corps[0].workspace_id : null;
  const portee = workspaceId ? `entreprise ${workspaceId}` : 'aucune entreprise sur ce compte : les actions par périmètre répondront « entreprise requise »';
  console.log(`::notice::périmètre — ${portee}`);
  lignes.push(`Périmètre : ${portee}.`);

  let echecs = 0;
  const tableau = ['| Sonde | HTTP | Verdict | Extrait |', '| --- | --- | --- | --- |'];
  const enEchec = [];
  const parVerdict = new Map();
  for (const sonde of sondes(session.jeton, workspaceId)) {
    const { statut, corps } = await appeler(sonde.url, sonde.init);
    const verdict = classer(statut, corps);
    const extrait = rediger(corps).replace(/\|/g, '/').replace(/\n/g, ' ');
    parVerdict.set(verdict, (parVerdict.get(verdict) ?? 0) + 1);
    if (estEchec(verdict)) {
      echecs++;
      enEchec.push(`${sonde.nom} → ${verdict} (HTTP ${statut})`);
    }
    tableau.push(`| ${sonde.nom} | ${statut} | ${verdict} | \`${extrait}\` |`);
  }

  // GitHub ne conserve que ~10 annotations par étape : le détail complet part donc
  // dans un rapport téléchargeable, et le journal ne garde qu'un résumé.
  const rapport = [
    '# Vérification authentifiée SORAHNEX — lecture seule',
    '',
    `- Date : ${new Date().toISOString()}`,
    `- Compte : ${compte}`,
    `- Périmètre : ${portee}`,
    `- Sondes : ${tableau.length - 2}`,
    '',
    ...(enEchec.length ? ['## Échecs réels', '', ...enEchec.map((l) => `- ${l}`), ''] : []),
    ...tableau,
    '',
  ].join('\n');
  await ecrire('rapport-verification-authentifiee.md', rapport);

  const resumeParVerdict = [...parVerdict.entries()].map(([v, n]) => `${v} ${n}`).join(' · ');
  console.log(`::notice::${tableau.length - 2} sondes · ${resumeParVerdict} · rapport complet : rapport-verification-authentifiee.md (artefact)`);
  for (const ligne of enEchec.slice(0, 5)) console.log(`::error::${ligne}`);
  if (enEchec.length > 5) console.log(`::error::… et ${enEchec.length - 5} autre(s) échec(s), tous listés dans le rapport.`);

  if (resume) {
    await ecrire(resume, [
      '### Vérification authentifiée (lecture seule)',
      '',
      ...lignes,
      '',
      ...tableau,
      '',
      echecs ? `**${echecs} sonde(s) en échec réel.**` : 'Aucune panne : toutes les sondes ont obtenu une réponse du handler.',
      '',
      `Détail complet : artefact \`rapport-verification-authentifiee\` de cette exécution.`,
      '',
    ].join('\n'));
  }
  console.log(`Bilan : ${echecs} échec(s) réel(s).`);
  return echecs ? 1 : 0;
}

async function ecrire(chemin, texte) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(chemin, texte, 'utf8');
}

// Exécution directe uniquement : les fonctions pures ci-dessus sont testées sans réseau.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  principal().then((code) => process.exit(code)).catch((erreur) => {
    console.log(`::error::${rediger(erreur instanceof Error ? erreur.message : erreur)}`);
    process.exit(1);
  });
}
