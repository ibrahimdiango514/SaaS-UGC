import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_NAME,
  ARTIFACT_TABLE,
  BUNDLE,
  HOSTED_LOADER,
  artifact,
  renderHostedLoader,
} from '../scripts/build-business-grow-artifact.mjs';

/**
 * `loader.ts` est la source réellement déployée en production : elle lit le
 * bundle dans `public._edge_function_artifact` et le vérifie avant exécution.
 *
 * Ces tests EXÉCUTENT le chargeur (transpilé, Deno et fetch simulés) au lieu de
 * chercher des chaînes dans son texte : un chargeur qui ouvrirait son propre
 * `Deno.serve` en plus de celui du bundle passerait une vérification textuelle
 * et répondrait pourtant n'importe quoi en production.
 */
const root = process.cwd();
const loader = readFileSync(join(root, HOSTED_LOADER), 'utf8');
const bundle = readFileSync(join(root, BUNDLE), 'utf8');
const migration = readFileSync(
  join(root, 'supabase/migrations/20261112190000_vyora_edge_function_artifact.sql'),
  'utf8',
);

type Served = (request: Request) => Response | Promise<Response>;
type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

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

const rows = (source: unknown) => async () =>
  new Response(JSON.stringify(source === undefined ? [] : [{ source }]), { status: 200 });

describe('chargeur de production business-grow', () => {
  it('est exactement ce que produit le générateur, pour le bundle committé', () => {
    const built = artifact();
    expect(loader).toBe(renderHostedLoader(built));
    expect(bundle).toBe(built.source);
    expect(createHash('sha256').update(bundle, 'utf8').digest('hex')).toBe(built.sha256);
  });

  it('reste assez court pour ne pas être altéré par le canal de déploiement', () => {
    // Incident v18 : un corps de 17 Ko est arrivé corrompu (WORKER_ERROR).
    expect(loader.length).toBeLessThan(4_000);
    expect(loader).not.toMatch(/[A-Za-z0-9+/]{200,}/);
  });

  it('lit l’artefact par nom et SHA-256 avec la clé de service', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await runLoader(async (url, init) => {
      calls.push({ url, init });
      return rows(bundle)();
    });
    const sha = createHash('sha256').update(bundle, 'utf8').digest('hex');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://project.supabase.co/rest/v1/${ARTIFACT_TABLE}?select=source&name=eq.${ARTIFACT_NAME}&sha256=eq.${sha}`,
    );
    expect(calls[0].init?.headers).toMatchObject({
      apikey: 'service-role-key',
      Authorization: 'Bearer service-role-key',
    });
  });

  it('sert le handler du bundle une seule fois, postgres injecté avant', async () => {
    const { handlers, errors, injected } = await runLoader(rows(bundle));
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
    ['artefact absent', rows(undefined), 'artifact_missing'],
    ['artefact tronqué', rows(bundle.slice(0, -1)), 'artifact_size_mismatch'],
    ['artefact altéré à taille égale', rows(`${bundle.slice(0, -1)}!`), 'artifact_digest_mismatch'],
    ['lecture refusée', async () => new Response('{}', { status: 401 }), 'artifact_read_failed:401'],
    ['réseau en panne', async () => { throw new Error('network down'); }, 'network down'],
  ] as Array<[string, FetchStub, string]>)('n’exécute rien et répond 503 explicite : %s', async (_label, stub, reason) => {
    let attempts = 0;
    const { handlers, errors, injected } = await runLoader(async (url, init) => {
      attempts += 1;
      return stub(url, init);
    });
    // Trois essais avant d'abandonner, puis un unique répondeur d'erreur.
    expect(attempts).toBe(3);
    expect(handlers).toHaveLength(1);
    expect(injected).toBeUndefined();
    expect(errors.join('\n')).toContain(reason);

    const response = await handlers[0](new Request('https://x/functions/v1/business-grow', { method: 'POST' }));
    expect(response.status).toBe(503);
    // Lisible par le navigateur : sans cet en-tête, le client afficherait
    // « backend injoignable » au lieu du vrai motif.
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const payload = await response.json();
    expect(payload.error.code).toBe('BUSINESS_GROW_ARTIFACT_UNAVAILABLE');
    expect(payload.error.message).toContain(reason);

    const preflight = await handlers[0](new Request('https://x/functions/v1/business-grow', { method: 'OPTIONS' }));
    expect(preflight.status).toBe(200);
  });

  it('se rétablit si la lecture réussit au deuxième essai', async () => {
    let attempts = 0;
    const { handlers, errors } = await runLoader(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('cold start blip');
      return rows(bundle)();
    });
    expect(attempts).toBe(2);
    expect(handlers).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('signale des secrets d’exécution manquants sans appeler le réseau', async () => {
    let called = false;
    const { handlers, errors } = await runLoader(async () => { called = true; return rows(bundle)(); }, {});
    expect(called).toBe(false);
    expect(errors.join('\n')).toContain('runtime_env_missing');
    expect((await handlers[0](new Request('https://x/', { method: 'POST' }))).status).toBe(503);
  });

  it('la table d’artefacts est versionnée et fermée aux rôles clients', () => {
    expect(migration).toContain(`public.${ARTIFACT_TABLE}`);
    // Clé (nom, sha256) : publier une version ne remplace jamais celle en service.
    expect(migration).toMatch(/primary key \(name, sha256\)/);
    expect(migration).toMatch(/enable row level security/);
    expect(migration).toMatch(/revoke all on public\._edge_function_artifact from public, anon, authenticated/);
    // L'empreinte est recalculée par la base : une ligne ne peut pas mentir.
    expect(migration).toMatch(/sha256 = encode\(extensions\.digest\(convert_to\(source, 'UTF8'\), 'sha256'\), 'hex'\)/);
  });
});
