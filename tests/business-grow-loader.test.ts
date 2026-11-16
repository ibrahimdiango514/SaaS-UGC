import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { LOADER, artifact, renderGithubLoader } from '../scripts/build-business-grow-artifact.mjs';

/**
 * `loader.ts` est la source réellement déployée en production : elle télécharge
 * le bundle depuis un commit précis du dépôt, vérifie sa taille et son SHA-256,
 * puis l'exécute.
 *
 * Ces tests EXÉCUTENT le chargeur (transpilé, `Deno` et `fetch` simulés) au lieu
 * de chercher des chaînes dans son texte. Un chargeur qui ouvrirait son propre
 * `Deno.serve` en plus de celui du bundle passerait une vérification textuelle
 * et répondrait pourtant n'importe quoi en production.
 *
 * ## Ce qui a changé
 * Ils exécutaient auparavant le chargeur « artefact en base »
 * (`public._edge_function_artifact`), qui n'est plus déployé. Tester un chargeur
 * absent de la production donne une fausse assurance — l'écart qui avait laissé
 * la garde d'abonnement hors du bundle `store-import` pendant une phase entière.
 */
const root = process.cwd();
const loader = readFileSync(join(root, LOADER), 'utf8');
const bundle = readFileSync(join(root, 'supabase/functions/business-grow.edge.js'), 'utf8');
const sha = createHash('sha256').update(bundle, 'utf8').digest('hex');

type Served = (request: Request) => Response | Promise<Response>;
type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

const COMMIT = /const COMMIT = "([0-9a-f]{40})";/.exec(loader)?.[1] ?? '';

/** Réponse GitHub `raw` : le contenu du bundle, sans en-tête particulier. */
const raw = (corps: string) => async () => new Response(corps, { status: 200 });

async function runLoader(fetchStub: FetchStub, env: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
}) {
  const js = esbuild.transformSync(loader, { loader: 'ts', format: 'esm', target: 'es2022' }).code
    // L'import npm: n'existe que sous Deno ; la valeur injectée suffit ici.
    .replace(/import postgres from "npm:postgres@3\.4\.5";/, 'const postgres = () => ({});');
  expect(js).not.toMatch(/^\s*import\s/m);

  const scope = globalThis as unknown as Record<string, unknown>;
  const previous = { Deno: scope.Deno, fetch: scope.fetch, pg: scope.__bgPostgres, setTimeout: scope.setTimeout };
  const handlers: Served[] = [];
  const errors: string[] = [];
  const previousError = console.error;
  scope.Deno = {
    env: { get: (name: string) => env[name] ?? '' },
    serve: (handler: Served) => { handlers.push(handler); },
  };
  scope.fetch = fetchStub;
  // Les temporisations entre essais ne doivent pas ralentir la suite.
  scope.setTimeout = (fn: () => void) => { fn(); return 0; };
  delete scope.__bgPostgres;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  let injected: unknown;
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (code: string) => () => Promise<void>;
    await new AsyncFunction(js)();
    injected = scope.__bgPostgres;
  } finally {
    console.error = previousError;
    scope.Deno = previous.Deno;
    scope.fetch = previous.fetch;
    scope.setTimeout = previous.setTimeout;
    scope.__bgPostgres = previous.pg;
  }
  return { handlers, errors, injected };
}

describe('chargeur de production business-grow', () => {
  it('est exactement ce que produit le générateur, pour le bundle committé', () => {
    const built = artifact();
    expect(loader).toBe(renderGithubLoader(built, COMMIT));
    expect(bundle).toBe(built.source);
    expect(sha).toBe(built.sha256);
  });

  it('épingle un commit complet, jamais une branche mouvante', () => {
    expect(COMMIT).toMatch(/^[0-9a-f]{40}$/);
    // `main` avancerait sous une empreinte figée : panne au redémarrage suivant.
    expect(loader).not.toMatch(/raw\.githubusercontent\.com[^"`]*\/(main|develop|master)\//);
    expect(loader).toContain(COMMIT);
  });

  it('reste assez court pour ne pas être altéré par le canal de déploiement', () => {
    // Incident v18 : un corps de 17 Ko est arrivé corrompu (WORKER_ERROR).
    expect(loader.length).toBeLessThan(8_000);
    expect(loader).not.toMatch(/[A-Za-z0-9+/]{200,}/);
  });

  it('télécharge le bundle au commit épinglé', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await runLoader(async (url, init) => {
      calls.push({ url, init });
      return raw(bundle)();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('raw.githubusercontent.com');
    expect(calls[0].url).toContain(COMMIT);
    expect(calls[0].url).toContain('business-grow.edge.js');
  });

  it('sert le handler du bundle une seule fois, postgres injecté avant', async () => {
    const { handlers, errors, injected } = await runLoader(raw(bundle));
    // Un second Deno.serve (celui du chargeur) masquerait le vrai handler.
    expect(handlers).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(typeof injected).toBe('function');

    // C'est bien le handler métier : il répond au préflight CORS de la prod.
    const response = await handlers[0](new Request('https://project.supabase.co/functions/v1/business-grow', {
      method: 'OPTIONS',
      headers: { origin: 'https://vyora-ugc.netlify.app' },
    }));
    expect(response.headers.get('access-control-allow-origin')).toBe('https://vyora-ugc.netlify.app');
  });

  it.each([
    ['bundle absent', async () => new Response('404: Not Found', { status: 404 }), 'http_404'],
    ['bundle tronqué', raw(bundle.slice(0, -1)), 'taille_'],
    ['bundle altéré à taille égale', raw(`${bundle.slice(0, -1)}!`), 'empreinte_'],
    ['réseau en panne', async () => { throw new Error('network down'); }, 'Error'],
  ] as Array<[string, FetchStub, string]>)('n’exécute rien et répond 503 explicite : %s', async (_label, stub, reason) => {
    let attempts = 0;
    const { handlers, errors, injected } = await runLoader(async (url, init) => {
      attempts += 1;
      return stub(url, init);
    });
    // Deux sources (raw puis API) × trois essais avant d'abandonner, puis un
    // unique répondeur d'erreur : aucune exécution partielle.
    expect(attempts).toBe(6);
    expect(handlers).toHaveLength(1);
    // Rien n'est exécuté : aucune dépendance n'a été injectée.
    expect(injected).toBeUndefined();
    expect(errors.join('\n')).toContain(reason);

    const response = await handlers[0](new Request('https://x/functions/v1/business-grow', { method: 'POST' }));
    expect(response.status).toBe(503);
    // Lisible par le navigateur : sans cet en-tête, le client afficherait
    // « backend injoignable » au lieu du vrai motif.
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const payload = await response.json();
    expect(payload.error.code).toBe('BUSINESS_GROW_ARTIFACT_UNAVAILABLE');
    // Le motif interne reste dans les journaux : le corps de la réponse ne
    // révèle ni le commit, ni l'URL, ni le détail de la vérification.
    expect(payload.error.message).not.toContain(reason);
    expect(payload.error.message).not.toContain(COMMIT);

    const preflight = await handlers[0](new Request('https://x/functions/v1/business-grow', { method: 'OPTIONS' }));
    expect(preflight.status).toBe(200);
  });

  it('se rétablit si la lecture réussit au deuxième essai', async () => {
    let attempts = 0;
    const { handlers, errors } = await runLoader(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('cold start blip');
      return raw(bundle)();
    });
    expect(attempts).toBe(2);
    expect(handlers).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('empreinte calculée sur le fichier brut, saut de ligne final compris', async () => {
    // `store-import` retirait le saut de ligne avant de hacher : l'empreinte ne
    // portait alors plus sur le fichier committé, et le chargeur refusait un
    // bundle légitime. Ici, un bundle dépourvu d'un caractère doit échouer.
    const sansDernier = bundle.endsWith('\n') ? bundle.slice(0, -1) : `${bundle}!`;
    const { handlers, errors } = await runLoader(raw(sansDernier));
    expect(errors.join('\n')).toMatch(/(taille_|empreinte_)/);
    expect((await handlers[0](new Request('https://x/', { method: 'POST' }))).status).toBe(503);
  });
});
