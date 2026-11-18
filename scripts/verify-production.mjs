#!/usr/bin/env node
/**
 * Constat de production — ce que le site public sert vraiment.
 *
 * ## Pourquoi un script, et pas un simple `curl` dans un rapport
 * Publier ne prouve pas servir. Trois faits distincts doivent être mesurés :
 *   1. le site répond (code HTTP) ;
 *   2. il sert la révision attendue (cachet `vyora-revision`) ;
 *   3. l'Edge Function refuse bien un appel anonyme (401 = `verify_jwt` actif).
 *
 * Le script compare ces faits à la réalité de GitHub (`main`), sans jamais
 * supposer qu'un merge équivaut à un déploiement.
 *
 * ## Ce qu'il ne fait pas
 * Il n'utilise **aucun secret** : les deux points d'entrée sont publics et leur
 * réponse anonyme est exactement la mesure recherchée. Il ne modifie rien.
 *
 * ## Usage
 *   node scripts/verify-production.mjs
 *   node scripts/verify-production.mjs --site https://exemple.netlify.app
 *
 * Codes de sortie : 0 = tout concorde ; 1 = écart mesuré ; 2 = mesure impossible.
 */
import process from 'node:process';

export const DEFAULTS = {
  // `VYORA_SITE_URL` permet de viser le nouveau domaine Netlify sans toucher
  // au code ; `--site` reste prioritaire. L'ancien domaine n'est qu'un repli.
  site: (process.env.VYORA_SITE_URL || '').trim() || 'https://vyora-ugc.netlify.app',
  fn: 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/store-import',
  repo: 'ibrahimdiango514/SaaS-UGC',
};

/** Extrait le cachet de révision du HTML servi. */
export function revisionFromHtml(html) {
  const match = /<meta\s+name="vyora-revision"\s+content="([^"]*)"/.exec(html);
  return match ? match[1] : null;
}

/** Interprète le code HTTP d'un appel anonyme à l'Edge Function. */
export function judgeFunctionStatus(code) {
  if (code === 401) return { ok: true, verdict: 'jeton exigé (verify_jwt actif), chargeur démarré' };
  if (code === 503) return { ok: false, verdict: 'fonction joignable mais artefact indisponible (503)' };
  if (code === 0) return { ok: false, verdict: 'aucune réponse : injoignable depuis ce réseau' };
  return { ok: false, verdict: `code inattendu (${code}) pour un appel anonyme` };
}

/** Confronte le cachet servi au commit de `main`. */
export function judgeRevision(served, expected) {
  if (!served) return { ok: false, verdict: 'aucun cachet : le site sert un build antérieur à cette livraison' };
  if (served === 'dev') return { ok: false, verdict: 'cachet « dev » : build sans référence de commit' };
  if (!expected) return { ok: false, verdict: `cachet ${served}, mais commit de main illisible` };
  if (served !== expected) return { ok: false, verdict: `le site sert ${served} alors que main est à ${expected}` };
  return { ok: true, verdict: `${served} : le site sert bien la révision de main` };
}

async function get(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return { status: response.status, text: await response.text() };
}

async function main(argv) {
  const arg = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const site = arg('site', DEFAULTS.site);
  const fn = arg('fn', DEFAULTS.fn);
  const repo = arg('repo', DEFAULTS.repo);

  let expected = '';
  try {
    const body = JSON.parse((await get(`https://api.github.com/repos/${repo}/commits/main`)).text);
    expected = String(body.sha ?? '').slice(0, 7);
  } catch {
    // L'absence d'information n'est pas un succès : le verdict le dira.
  }

  let siteStatus = 0;
  let html = '';
  try {
    const result = await get(site);
    siteStatus = result.status;
    html = result.text;
  } catch {
    siteStatus = 0;
  }

  let fnStatus = 0;
  let fnBody = '';
  try {
    const result = await get(fn, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"action":"preview"}',
    });
    fnStatus = result.status;
    fnBody = result.text;
  } catch {
    fnStatus = 0;
  }

  const served = revisionFromHtml(html);
  const siteVerdict = siteStatus === 200
    ? judgeRevision(served, expected)
    : { ok: false, verdict: `site injoignable (${siteStatus || 'aucune réponse'})` };
  const fnVerdict = judgeFunctionStatus(fnStatus);

  console.log(`site    : ${site} → HTTP ${siteStatus || 'aucune réponse'}`);
  console.log(`cachet  : ${served ?? 'absent'} (main: ${expected || 'inconnu'})`);
  console.log(`verdict : ${siteVerdict.ok ? 'OK' : 'ÉCART'} — ${siteVerdict.verdict}`);
  console.log(`function: ${fn} → HTTP ${fnStatus || 'aucune réponse'}`);
  console.log(`          ${fnVerdict.verdict}`);
  if (fnBody) console.log(`          réponse: ${fnBody.slice(0, 200)}`);

  if (siteStatus === 0 && fnStatus === 0) return 2;
  return siteVerdict.ok && fnVerdict.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
