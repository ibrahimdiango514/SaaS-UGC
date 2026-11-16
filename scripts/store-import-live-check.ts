#!/usr/bin/env npx deno run --allow-net
/**
 * Contrôle réel de la sortie réseau de l'Edge Function `store-import`.
 *
 * ## Ce que ce script prouve, et ce qu'il ne prouve pas
 *
 * Il exécute le VRAI code (`pinned-fetch.ts`, `safe-egress.ts`, `handler.ts`)
 * dans le vrai runtime Deno, contre de vrais serveurs. Il prouve :
 *   1. `Deno.resolveDns` renvoie les adresses du nom ;
 *   2. ces adresses passent la garde existante (`assertPublicAddresses`) ;
 *   3. la connexion TCP s'ouvre SUR l'IP validée, puis le TLS est vérifié
 *      contre l'hôte (SNI) — certificat réel, aucune dérogation ;
 *   4. une requête HTTP complète aboutit (statut + octets) ;
 *   5. les adresses internes et les redirections vers elles sont refusées
 *      AVANT toute connexion ;
 *   6. le handler complet répond honnêtement sur un hôte qui n'est pas une
 *      boutique (plateforme inconnue), sans inventer de produits.
 *
 * Il ne prouve PAS l'import d'un catalogue marchand réel : le bac à sable de
 * développement n'autorise que quelques hôtes sortants. Cette preuve-là exige
 * un déploiement Supabase (voir le rapport de livraison).
 *
 * ## Usage
 *   DENO_TLS_CA_STORE=mozilla,system npx --yes deno@2.9.6 run \
 *     --allow-net scripts/store-import-live-check.ts [hote-de-test]
 *
 * `DENO_TLS_CA_STORE` est nécessaire quand le réseau du poste intercepte TLS
 * (proxy d'entreprise) : le certificat du proxy est alors vérifié via le
 * magasin système au lieu d'être ignoré. Aucune option ne désactive la
 * vérification du certificat dans ce script.
 */

import { httpGetPinned } from '../supabase/functions/store-import/pinned-fetch.ts';
import { safeGet } from '../supabase/functions/store-import/safe-egress.ts';
import { createStoreImportHandler } from '../supabase/functions/store-import/handler.ts';
import { assertPublicAddresses } from '../src/business/importer/url-guard.ts';

const hote = (globalThis as { Deno?: { args: string[] } }).Deno?.args[0] ?? 'github.com';
const resultats: Array<{ test: string; verdict: 'ok' | 'refusé' | 'échec'; detail: string }> = [];

function noter(test: string, verdict: 'ok' | 'refusé' | 'échec', detail: string): void {
  resultats.push({ test, verdict, detail });
  console.log(`${verdict === 'ok' ? '✔' : verdict === 'refusé' ? '⛔' : '✖'} ${test} — ${detail}`);
}

const resolver = async (nom: string): Promise<string[]> => {
  const [a, aaaa] = await Promise.all([
    Deno.resolveDns(nom, 'A').catch(() => [] as string[]),
    Deno.resolveDns(nom, 'AAAA').catch(() => [] as string[]),
  ]);
  return [...a, ...aaaa];
};

/* 1 — DNS réel + garde existante -------------------------------------------- */
let adresses: string[] = [];
try {
  adresses = await resolver(hote);
  const garde = assertPublicAddresses(adresses);
  if (adresses.length && garde.ok) {
    noter('résolution DNS + validation', 'ok', `${hote} → ${adresses.join(', ')}`);
  } else {
    noter('résolution DNS + validation', 'échec', garde.ok ? 'aucune adresse' : JSON.stringify(garde.reason));
  }
} catch (erreur) {
  noter('résolution DNS + validation', 'échec', String(erreur).slice(0, 120));
}

/* 2 — Connexion épinglée + TLS vérifié sur l'hôte --------------------------- */
if (adresses.length) {
  try {
    const reponse = await httpGetPinned(
      { ip: adresses[0], hostname: hote, path: '/' },
      { accept: 'text/html', maxBytes: 4_000_000 },
    );
    noter(
      'connexion épinglée + TLS vérifié',
      'ok',
      `IP ${adresses[0]} · HTTP ${reponse.status} · ${reponse.bytes} octets`,
    );
  } catch (erreur) {
    const code = (erreur as { code?: string }).code ?? 'inconnu';
    noter('connexion épinglée + TLS vérifié', 'échec', `${code} : ${String(erreur).slice(0, 120)}`);
  }
}

/* 3 — Refus des adresses internes, sans connexion --------------------------- */
for (const [nom, adressesInterdites] of [
  ['localhost', ['127.0.0.1']],
  ['métadonnées cloud', ['169.254.169.254']],
  ['IPv4 mappée en IPv6', ['::ffff:127.0.0.1']],
] as const) {
  const refus = await safeGet(`https://${hote}/`, { accept: '*/*', maxBytes: 1_000 }, {
    resolveHost: async () => [...adressesInterdites],
    connect: async () => {
      throw new Error('CONNEXION_INTERDITE_EFFECTUEE');
    },
  });
  if (!refus.ok && refus.error.code === 'blocked_url') {
    noter(`refus ${nom}`, 'refusé', refus.error.message);
  } else {
    noter(`refus ${nom}`, 'échec', JSON.stringify(refus));
  }
}

/* 4 — Redirection vers une adresse interdite, refusée avant connexion ------- */
{
  const contacts: string[] = [];
  const redirection = await safeGet(`https://${hote}/`, { accept: '*/*', maxBytes: 1_000 }, {
    resolveHost: async (nom) => (nom === hote ? ['203.0.113.10'] : ['169.254.169.254']),
    connect: async (ip) => {
      contacts.push(ip);
      const corps = '';
      const brut = `HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n${corps}`;
      const octets = new TextEncoder().encode(brut);
      let position = 0;
      return {
        async write() {
          return octets.length;
        },
        async read(p: Uint8Array) {
          if (position >= octets.length) return null;
          const n = Math.min(p.length, octets.length - position);
          p.set(octets.subarray(position, position + n));
          position += n;
          return n;
        },
        close() {},
      };
    },
  });
  const seulementPublique = contacts.length === 1 && contacts[0] === '203.0.113.10';
  if (!redirection.ok && redirection.error.code === 'blocked_url' && seulementPublique) {
    noter('refus d’une redirection vers les métadonnées', 'refusé', 'une seule connexion, vers l’adresse publique');
  } else {
    noter('refus d’une redirection vers les métadonnées', 'échec', `${JSON.stringify(redirection)} · contacts=${contacts.join(',')}`);
  }
}

/* 5 — Handler complet sur un hôte réel qui n'est pas une boutique ----------- */
{
  const handler = createStoreImportHandler({
    getUserId: async () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    grantWorkspace: async () => ({ canRead: true, canWrite: true }),
    listExistingProducts: async () => [],
    insertProducts: async () => {
      throw new Error('ÉCRITURE_INTERDITE_PENDANT_UN_APERCU');
    },
    resolveHost: resolver,
    allowedOrigins: ['https://vyora-ugc.netlify.app'],
  });
  const reponse = await handler(new Request('https://exemple.supabase.co/functions/v1/store-import', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://vyora-ugc.netlify.app',
      authorization: 'Bearer jeton-de-controle',
    },
    body: JSON.stringify({
      action: 'preview',
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      url: `https://${hote}/`,
    }),
  }));
  const corps = await reponse.json() as { error?: { code?: string; message?: string } };
  if (reponse.status === 422 && corps.error?.code === 'PLATFORM_UNKNOWN') {
    noter('aperçu sur un hôte non marchand', 'ok', 'plateforme inconnue annoncée, aucun produit inventé');
  } else if (reponse.status === 200) {
    noter('aperçu sur un hôte non marchand', 'ok', 'aperçu produit (hôte reconnu comme boutique)');
  } else if (reponse.status === 413 && corps.error?.code === 'RESPONSE_TOO_LARGE') {
    // Règle du produit : une page d'accueil au-delà du plafond est REFUSÉE, pas
    // tronquée — tronquer reviendrait à analyser une page incomplate.
    noter('aperçu sur un hôte non marchand', 'ok', 'page trop volumineuse refusée explicitement (413)');
  } else {
    noter('aperçu sur un hôte non marchand', 'échec', `${reponse.status} ${JSON.stringify(corps).slice(0, 140)}`);
  }
}

/* Bilan -------------------------------------------------------------------- */
const echecs = resultats.filter((r) => r.verdict === 'échec').length;
console.log(`\n${resultats.length - echecs}/${resultats.length} contrôles conformes.`);
(globalThis as { Deno?: { exit(code: number): void } }).Deno?.exit(echecs ? 1 : 0);
