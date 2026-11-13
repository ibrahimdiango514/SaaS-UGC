import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_NAME,
  ARTIFACT_TABLE,
  BUNDLE,
  FUNCTIONS,
  loaderPath,
  outputs,
} from '../scripts/build-saspay-artifact.mjs';

/**
 * `<fonction>/loader.ts` est la source réellement déployée des trois fonctions
 * de paiement : elle lit le bundle commun dans `public._edge_function_artifact`
 * et le vérifie avant exécution.
 *
 * Ces tests EXÉCUTENT chaque chargeur (transpilé, Deno et fetch simulés) : un
 * chargeur qui démarrerait le mauvais gestionnaire — le webhook à la place de
 * la réconciliation, par exemple — passerait une vérification textuelle.
 */
const root = process.cwd();
const bundle = readFileSync(join(root, BUNDLE), 'utf8');
const sha = createHash('sha256').update(bundle, 'utf8').digest('hex');
const loaderOf = (name: string) => readFileSync(join(root, loaderPath(name)), 'utf8');

type Served = (request: Request) => Response | Promise<Response>;
type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

async function runLoader(name: string, fetchStub: FetchStub, env: Record<string, string> = ENV) {
  const js = esbuild.transformSync(loaderOf(name), { loader: 'ts', format: 'esm', target: 'es2022' }).code;
  expect(js).not.toMatch(/^\s*import\s/m);

  const scope = globalThis as unknown as Record<string, unknown>;
  const previous = { Deno: scope.Deno, fetch: scope.fetch, setTimeout: scope.setTimeout, name: scope.__vyoraSaspayFunction };
  const handlers: Served[] = [];
  const errors: string[] = [];
  const previousError = console.error;
  scope.Deno = {
    env: { get: (key: string) => env[key] ?? '' },
    serve: (handler: Served) => { handlers.push(handler); },
  };
  scope.fetch = fetchStub;
  // Les temporisations entre essais ne doivent pas ralentir la suite.
  scope.setTimeout = (fn: () => void) => { fn(); return 0; };
  delete scope.__vyoraSaspayFunction;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  let selected: unknown;
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (code: string) => () => Promise<void>;
    await new AsyncFunction(js)();
    selected = scope.__vyoraSaspayFunction;
  } finally {
    console.error = previousError;
    scope.Deno = previous.Deno;
    scope.fetch = previous.fetch;
    scope.setTimeout = previous.setTimeout;
    scope.__vyoraSaspayFunction = previous.name;
  }
  return { handlers, errors, selected };
}

const rows = (source: unknown) => async () =>
  new Response(JSON.stringify(source === undefined ? [] : [{ source }]), { status: 200 });

const post = (headers: Record<string, string> = {}, body = '{}') =>
  new Request('https://project.supabase.co/functions/v1/x', { method: 'POST', headers, body });

async function errorCode(response: Response): Promise<string> {
  const payload = await response.json() as { error?: { code?: string } };
  return payload.error?.code ?? '';
}

describe('artefact de production des paiements SasPay', () => {
  it('fichiers générés à jour : bundle et trois chargeurs', () => {
    const { built, files } = outputs();
    expect(files.map(([file]) => file)).toEqual([BUNDLE, ...FUNCTIONS.map(loaderPath)]);
    for (const [file, expected] of files) {
      expect(readFileSync(join(root, file), 'utf8'), file).toBe(expected);
    }
    expect(built.sha256).toBe(sha);
    expect(built.chars).toBe(bundle.length);
  });

  it('bundle exécutable hors module, en ASCII, sans secret ni clé d’un autre produit', () => {
    expect(bundle).not.toMatch(/^\s*(import|export)\s/m);
    // ASCII : la taille contrôlée en base (char_length) est celle du chargeur.
    // eslint-disable-next-line no-control-regex
    expect(bundle).not.toMatch(/[^\x00-\x7f]/);
    expect(bundle).not.toMatch(/sk_(live|test)_[A-Za-z0-9]{8,}/);
    expect(bundle).toContain('VYORA_SASPAY_SECRET_KEY');
    expect(bundle).toContain('VYORA_SASPAY_WEBHOOK_SECRET');
    // Les secrets du produit immobilier ne sont jamais lus par VYORA.
    expect(bundle).not.toMatch(/["'`]SASPAY_SECRET_KEY["'`]/);
    expect(bundle).not.toMatch(/["'`]SASPAY_WEBHOOK_SECRET["'`]/);
  });

  it.each(FUNCTIONS)('%s : chargeur court, sans code métier ni secret', (name) => {
    const loader = loaderOf(name);
    // Incident business-grow v18 : un corps de 17 Ko est arrivé corrompu.
    expect(loader.length).toBeLessThan(4_000);
    expect(loader).not.toMatch(/[A-Za-z0-9+/]{200,}/);
    expect(loader).toContain(`const FUNCTION_NAME = "${name}";`);
    expect(loader).toContain(`const ARTIFACT_SHA256 = "${sha}";`);
    expect(loader).not.toMatch(/SASPAY/);
  });

  it.each(FUNCTIONS)('%s : lit l’artefact par nom et SHA-256 avec la clé de service', async (name) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { handlers, errors, selected } = await runLoader(name, async (url, init) => {
      calls.push({ url, init });
      return rows(bundle)();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://project.supabase.co/rest/v1/${ARTIFACT_TABLE}?select=source&name=eq.${ARTIFACT_NAME}&sha256=eq.${sha}`,
    );
    expect(calls[0].init?.headers).toMatchObject({ apikey: 'service-role-key', Authorization: 'Bearer service-role-key' });
    // Un second Deno.serve (celui du chargeur) masquerait le vrai gestionnaire.
    expect(handlers).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(selected).toBe(name);
  });

  it('vyora-payments démarre le gestionnaire navigateur (session exigée)', async () => {
    const { handlers } = await runLoader('vyora-payments', rows(bundle));
    const response = await handlers[0](post());
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('PAYMENT_UNAUTHENTICATED');
    const foreign = await handlers[0](post({ origin: 'https://evil.example.com', authorization: 'Bearer x' }));
    expect(foreign.status).toBe(403);
    expect(await errorCode(foreign)).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('vyora-payments-reconcile démarre le gestionnaire planifié (en-tête exigé)', async () => {
    const { handlers } = await runLoader('vyora-payments-reconcile', rows(bundle));
    const response = await handlers[0](post());
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('CRON_FORBIDDEN');
  });

  it('vyora-saspay-webhook démarre le gestionnaire SasPay : sans secret ni signature, aucun succès', async () => {
    const { handlers } = await runLoader('vyora-saspay-webhook', rows(bundle));
    const response = await handlers[0](post({}, '{"event":"transaction.success"}'));
    expect(response.status).toBeGreaterThanOrEqual(400);
    const code = await errorCode(response);
    expect(code).not.toBe('');
    // Ni le gestionnaire navigateur, ni celui de la tâche planifiée.
    expect(code).not.toBe('PAYMENT_UNAUTHENTICATED');
    expect(code).not.toBe('CRON_FORBIDDEN');
  });

  it.each([
    ['absent', undefined],
    ['tronqué', bundle.slice(0, -1)],
    ['altéré à taille égale', bundle.slice(0, -1) + (bundle.endsWith(' ') ? '\n' : ' ')],
    ['d’un autre type', 42],
  ])('artefact %s : jamais exécuté, 503 explicite', async (_label, source) => {
    for (const name of FUNCTIONS) {
      const { handlers, errors, selected } = await runLoader(name, rows(source));
      expect(selected).toBeUndefined();
      expect(handlers).toHaveLength(1);
      expect(errors).toHaveLength(1);
      const response = await handlers[0](post());
      expect(response.status).toBe(503);
      const payload = await response.json() as { error: { code: string; message: string } };
      expect(payload.error.code).toBe('PAYMENT_ARTIFACT_UNAVAILABLE');
      // Le motif technique reste dans les journaux.
      expect(payload.error.message).not.toMatch(/artifact_|digest|mismatch/);
    }
  });

  it('lecture refusée ou environnement absent : 503, jamais le bundle', async () => {
    const denied = await runLoader('vyora-saspay-webhook', async () => new Response('{}', { status: 401 }));
    expect(denied.selected).toBeUndefined();
    expect(denied.errors[0]).toContain('artifact_read_failed:401');
    expect((await denied.handlers[0](post())).status).toBe(503);

    let called = 0;
    const noEnv = await runLoader('vyora-payments', async () => { called += 1; return rows(bundle)(); }, {});
    expect(called).toBe(0);
    expect(noEnv.errors[0]).toContain('runtime_env_missing');
    expect((await noEnv.handlers[0](post())).status).toBe(503);
  });

  it('une lecture ratée à froid est reprise', async () => {
    let attempts = 0;
    const { handlers, errors, selected } = await runLoader('vyora-payments-reconcile', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('network');
      return rows(bundle)();
    });
    expect(attempts).toBe(2);
    expect(errors).toEqual([]);
    expect(selected).toBe('vyora-payments-reconcile');
    expect(handlers).toHaveLength(1);
  });

  it('le bundle refuse un nom de fonction inconnu au lieu de servir par défaut', () => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const previous = { Deno: scope.Deno, name: scope.__vyoraSaspayFunction };
    const served: unknown[] = [];
    scope.Deno = { env: { get: () => '' }, serve: (handler: unknown) => { served.push(handler); } };
    try {
      for (const name of [undefined, '', 'saspay-webhook', 'vyora-payments ']) {
        scope.__vyoraSaspayFunction = name;
        expect(() => new Function(bundle)()).toThrow('vyora_saspay_unknown_function');
      }
      expect(served).toHaveLength(0);
    } finally {
      scope.Deno = previous.Deno;
      scope.__vyoraSaspayFunction = previous.name;
    }
  });
});
