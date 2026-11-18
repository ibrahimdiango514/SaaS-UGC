#!/usr/bin/env node
/**
 * Sonde de mise en service Meta — lecture seule, aucune écriture.
 *
 * ## Ce que ce script fait
 *
 * Il répond à une seule question, à chaque étape de la configuration :
 * **« l'Edge Function est-elle joignable et correctement configurée ? »**
 * Il n'appelle aucune API Meta, n'écrit rien en base et ne demande aucun
 * secret. Il ne peut donc pas « simuler » une connexion.
 *
 * ## Ce que ce script ne peut PAS prouver
 *
 * Une réponse `configured: true` signifie que `META_APP_ID` et `META_APP_SECRET`
 * sont présents côté serveur — rien de plus. Un jeton Meta réellement valide ne
 * se vérifie qu'en terminant un parcours OAuth dans le navigateur.
 *
 * ## Usage
 *
 *   node scripts/meta-readiness.mjs                 # état des deux fonctions
 *   node scripts/meta-readiness.mjs --webhook-token # + diagnostic du Verify Token
 *
 * Le jeton de vérification n'est **jamais** affiché ni journalisé : il est lu
 * depuis l'environnement local (`META_WEBHOOK_VERIFY_TOKEN`) uniquement pour
 * que Meta puisse comparer. Ne l'écrivez pas en clair dans un historique shell.
 */
import { pathToFileURL } from 'node:url';
import process from 'node:process';

/** @typedef {{ label: string, ok: boolean, statut?: number, detail?: string }} Sonde */
/** @typedef {{ rapport: Sonde[], reseauIndisponible: boolean }} Rapport */

export const PROJECT_REF = 'xbuuhfwobrafcbgtdgjx';
export const BASE = `https://${PROJECT_REF}.supabase.co/functions/v1`;

/** Origines attendues côté navigateur (doit correspondre à VYORA_ALLOWED_ORIGINS). */
export const ORIGINES_ATTENDUES = [
  'https://vyora-saas-ugc.netlify.app',
  'http://localhost:5173',
];

/**
 * Construit la requête qui imite le retour OAuth d'un navigateur.
 *
 * Un `state` volontairement invalide : le handler doit refuser AVANT d'écrire
 * quoi que ce soit en base. Une réponse 303 vers l'écran Intégrations avec
 * `meta=error&code=STATE_INVALID` prouve que la fonction tourne et que le
 * contrôle d'état est actif.
 */
export function requeteCallback(origine) {
  const url = new URL(`${BASE}/meta-connect/callback`);
  url.searchParams.set('state', 'state-de-sonde-invalide');
  url.searchParams.set('code', 'code-de-sonde');
  return { url: url.toString(), origine };
}

/** Requête `status` non authentifiée : doit répondre 401, jamais 200. */
export function requeteStatusSansJwt() {
  return {
    url: `${BASE}/meta-connect`,
    methode: 'POST',
    corps: JSON.stringify({ action: 'status', workspaceId: '00000000-0000-0000-0000-000000000000' }),
  };
}

/** Poignée de main webhook avec un jeton volontairement faux. */
export function requeteWebhookFauxJeton() {
  const url = new URL(`${BASE}/meta-webhook`);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', 'sonde-jeton-faux');
  url.searchParams.set('hub.challenge', '12345');
  return url.toString();
}

async function tenter(label, fn) {
  try {
    const resultat = await fn();
    return { label, ...resultat };
  } catch (erreur) {
    return { label, ok: false, detail: erreur instanceof Error ? erreur.message : String(erreur) };
  }
}

/** Exécute les trois sondes et rend un rapport structuré (aucun secret rendu). @returns {Promise<Rapport>} */
export async function sonder({ fetchImpl = fetch, webhookToken = '' } = {}) {
  const rapport = [];
  /*
   * Distinction essentielle : un échec réseau ne prouve RIEN sur le serveur.
   * L'afficher comme « ✗ » laisserait croire à un problème de déploiement,
   * alors que c'est peut-être le poste de l'exécutant qui n'a pas de réseau.
   */
  let reseauIndisponible = false;
  const appeler = async (...args) => {
    try {
      return await fetchImpl(...args);
    } catch (erreur) {
      reseauIndisponible = true;
      throw erreur;
    }
  };

  // 1. La fonction est déployée : une requête sans JWT doit être refusée par le
  //    handler (401) et non par la passerelle (404 = non déployée).
  rapport.push(await tenter('meta-connect (POST sans JWT)', async () => {
    const { url, methode, corps } = requeteStatusSansJwt();
    const r = await appeler(url, {
      method: methode,
      headers: { 'content-type': 'application/json', origin: ORIGINES_ATTENDUES[0] },
      body: corps,
    });
    const texte = await r.text();
    const code = (() => {
      try {
        const corps = JSON.parse(texte);
        return corps?.error?.code ?? null;
      } catch {
        return null;
      }
    })();
    return {
      ok: r.status === 401 && code === 'UNAUTHENTICATED',
      statut: r.status,
      detail: r.status === 404
        ? 'fonction absente (404) : elle n’est pas déployée'
        : `attendu 401/UNAUTHENTICATED, reçu ${r.status}/${code ?? 'sans code'}`,
    };
  }));

  // 2. Le retour OAuth est traité par le handler, pas par la passerelle.
  rapport.push(await tenter('meta-connect (GET /callback)', async () => {
    const { url, origine } = requeteCallback(ORIGINES_ATTENDUES[0]);
    const r = await appeler(url, { redirect: 'manual', headers: { origin: origine } });
    const location = r.headers.get('location') ?? '';
    return {
      ok: r.status === 303 && location.includes('meta=error') && location.includes('STATE_INVALID'),
      statut: r.status,
      detail: r.status === 404
        ? 'fonction absente (404) : elle n’est pas déployée'
        : r.status === 303
          ? location.replace(/code=[^&]*/, 'code=…')
          : `attendu 303 vers l’écran Intégrations avec STATE_INVALID, reçu ${r.status}`,
    };
  }));

  // 3. Le webhook est déployé et refuse un jeton faux (403 avec motif).
  rapport.push(await tenter('meta-webhook (GET poignée de main)', async () => {
    const r = await appeler(requeteWebhookFauxJeton());
    const texte = (await r.text()).trim();
    const motif = /\((TOKEN_[A-Z_]+|MODE_[A-Z_]+|CHALLENGE_[A-Z_]+)\)/.exec(texte)?.[1] ?? null;
    return {
      ok: (r.status === 403 && motif === 'TOKEN_MISMATCH') || (r.status === 503 && motif === 'TOKEN_NOT_CONFIGURED'),
      statut: r.status,
      detail: r.status === 404
        ? 'fonction absente (404) : elle n’est pas déployée'
        : `reçu ${r.status} / ${motif ?? texte.slice(0, 40)}`,
    };
  }));

  // 4. Optionnel : la poignée de main réussie, avec le VRAI Verify Token.
  if (webhookToken) {
    rapport.push(await tenter('meta-webhook (Verify Token réel)', async () => {
      const url = new URL(`${BASE}/meta-webhook`);
      url.searchParams.set('hub.mode', 'subscribe');
      url.searchParams.set('hub.verify_token', webhookToken);
      url.searchParams.set('hub.challenge', '97531');
      const r = await appeler(url.toString());
      const texte = (await r.text()).trim();
      return {
        ok: r.status === 200 && texte === '97531',
        statut: r.status,
        detail: r.status === 200
          ? (texte === '97531' ? 'challenge rendu : le jeton correspond' : 'réponse 200 mais challenge différent')
          : `reçu ${r.status}`,
      };
    }));
  }

  return { rapport, reseauIndisponible };
}

const estPrincipal = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (estPrincipal) {
  const token = process.env.META_WEBHOOK_VERIFY_TOKEN ?? '';
  if (token) console.log('Verify Token lu depuis l’environnement local (jamais affiché).');
  console.log(`Projet : ${PROJECT_REF}\n`);
  const { rapport, reseauIndisponible } = await sonder({ webhookToken: token });
  for (const ligne of rapport) {
    console.log(`${ligne.ok ? '✓' : '✗'} ${ligne.label} — ${ligne.detail}`);
  }
  if (reseauIndisponible) {
    console.log('\nRéseau indisponible depuis ce poste : AUCUNE conclusion ne peut être tirée.');
    console.log('Relancez la sonde depuis un poste dont l’accès HTTPS sortant est autorisé.');
    process.exit(2);
  }
  const echecs = rapport.filter((l) => !l.ok).length;
  console.log(`\n${rapport.length - echecs}/${rapport.length} sondes réussies.`);
  if (echecs) {
    console.log('Une sonde en échec ne prouve pas un bug : vérifiez d’abord que la fonction est déployée et que les secrets sont posés.');
    process.exit(1);
  }
  console.log('Rappel : ces sondes ne prouvent AUCUNE connexion Meta réelle. Seul un parcours OAuth terminé dans le navigateur le peut.');
}
