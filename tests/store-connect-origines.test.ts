import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { buildArtifact } from '../scripts/build-edge-artifact.mjs';
import { DEFAULT_ALLOWED_ORIGINS } from '../src/lib/origin-allowlist';

/**
 * CORS de `store-connect` — exécuté sur le bundle livré, pas sur une lecture
 * du code.
 *
 * ## Le défaut constaté en production (2026-11-18)
 * `store-connect` ne lisait QUE le secret `VYORA_ALLOWED_ORIGINS`. Avant que le
 * domaine Netlify n'y soit ajouté, une requête du site publié recevait
 * `access-control-allow-origin: null` alors que `store-import`, `mcp-client` et
 * `business-grow` acceptaient la même origine (liste par défaut + secret).
 * Le navigateur bloquait donc la connexion de boutique, et uniquement elle.
 *
 * ## Ce que ce test garantit
 * Sans aucun secret, les origines par défaut (`src/lib/origin-allowlist.ts`)
 * sont acceptées ; une origine inconnue reçoit `null` ; le secret AJOUTE une
 * origine sans retirer les autres. Comme le prochain domaine de production
 * n'est pas encore connu, c'est précisément ce mécanisme (défauts + secret)
 * qui permettra de l'autoriser sans redéployer la fonction.
 */

const BUNDLE = buildArtifact('store-connect').source;

type Gestionnaire = (request: Request) => Promise<Response>;

function chargerBundle(secretOrigines = ''): Gestionnaire {
  let gestionnaire: Gestionnaire | null = null;
  const contexte = {
    // La fabrique PostgreSQL n'est jamais appelée : la garde d'authentification
    // répond avant toute requête SQL.
    __edgePostgres: () => () => Promise.resolve([]),
    Deno: {
      serve: (h: Gestionnaire) => { gestionnaire = h; },
      env: {
        get: (nom: string) => {
          if (nom === 'VYORA_ALLOWED_ORIGINS') return secretOrigines;
          if (nom === 'SUPABASE_URL') return 'https://exemple.invalid';
          if (nom === 'SUPABASE_DB_URL') return 'postgres://exemple.invalid/db';
          return 'cle';
        },
      },
    },
    // GoTrue répond « jeton invalide » : on mesure les en-têtes CORS de la
    // réponse 401, exactement ce que le navigateur reçoit avant connexion.
    fetch: () => Promise.resolve(new Response('{}', { status: 401 })),
    Response, Request, Headers, URL, AbortSignal, AbortController,
    TextEncoder, TextDecoder, crypto, atob, btoa, Blob, console,
    setTimeout, clearTimeout, structuredClone, Math, Date, JSON,
  };
  runInNewContext(BUNDLE, contexte);
  if (!gestionnaire) throw new Error('le bundle n’a enregistré aucun gestionnaire HTTP');
  return gestionnaire;
}

function requete(origin: string): Request {
  return new Request('https://exemple.invalid/functions/v1/store-connect', {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      authorization: 'Bearer jeton-invalide',
    },
    body: JSON.stringify({ action: 'status' }),
  });
}

describe('store-connect — origines acceptées (bundle livré)', () => {
  it('accepte les origines par défaut sans aucun secret', async () => {
    const handler = chargerBundle('');
    const publiee = DEFAULT_ALLOWED_ORIGINS.find((o) => o.startsWith('https://') && !o.includes('*'))!;
    const reponse = await handler(requete(publiee));
    expect(reponse.status).toBe(401);
    expect(reponse.headers.get('access-control-allow-origin')).toBe(publiee);
    expect(reponse.headers.get('vary')?.toLowerCase()).toContain('origin');
  });

  it('refuse une origine inconnue (`null`, jamais `*`)', async () => {
    const handler = chargerBundle('');
    const reponse = await handler(requete('https://evil.example'));
    expect(reponse.status).toBe(401);
    expect(reponse.headers.get('access-control-allow-origin')).toBe('null');
  });

  it('le secret ajoute un domaine (futur site Netlify) sans retirer les défauts', async () => {
    const handler = chargerBundle(' https://nouveau-site.example ,https://*.apercu.example ');
    const nouveau = await handler(requete('https://nouveau-site.example'));
    expect(nouveau.headers.get('access-control-allow-origin')).toBe('https://nouveau-site.example');
    const joker = await handler(requete('https://pr-12.apercu.example'));
    expect(joker.headers.get('access-control-allow-origin')).toBe('https://pr-12.apercu.example');
    const defaut = await handler(requete('http://localhost:5173'));
    expect(defaut.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
