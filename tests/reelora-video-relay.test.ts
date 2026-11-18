/**
 * Relais Netlify → `reelora-video`.
 *
 * Ce relais est le seul chemin par lequel le Studio atteint la fonction vidéo
 * depuis le navigateur : il doit donc être éprouvé, pas seulement écrit.
 * Ce qui est vérifié :
 *   1. la cible exacte (production) et l'absence de tout secret dans le fichier ;
 *   2. le refus sans session, AVANT tout appel réseau ;
 *   3. la transmission fidèle de `Authorization` / `apikey` et du corps ;
 *   4. la remontée du statut et du corps de la fonction, sans réécriture ;
 *   5. l'absence de mise en cache d'une réponse qui dépend de l'utilisateur.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const RELAY = 'netlify/edge-functions/reelora-video.js';
const TARGET = 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/reelora-video';

type RelayHandler = (request: Request) => Promise<Response>;

async function loadRelay(): Promise<RelayHandler> {
  // Relais Edge en JavaScript, sans fichier de déclaration (même convention que
  // le relais business-grow) : le type est fourni explicitement ci-dessous.
  // @ts-expect-error module JS sans déclaration TypeScript
  const mod = await import('../netlify/edge-functions/reelora-video.js') as { default: RelayHandler };
  return mod.default;
}

const session = {
  authorization: 'Bearer jeton-utilisateur',
  apikey: 'sb_publishable_public',
};

function request(body = '{"action":"catalog"}', headers: Record<string, string> = session) {
  return new Request('https://vyora-ugc.netlify.app/api/reelora-video', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('relais reelora-video — contrat de fichier', () => {
  const source = readFileSync(join(process.cwd(), RELAY), 'utf8');

  it('vise la fonction de production et seulement elle', () => {
    expect(source).toContain(TARGET);
    expect(source).toContain("path: '/api/reelora-video'");
  });

  it('ne contient aucun secret ni lecture d’environnement', () => {
    // Un relais qui lirait un secret deviendrait un second point de fuite.
    expect(source).not.toMatch(/SERVICE_ROLE|MUAPI_API_KEY|GROQ_API_KEY|Deno\.env\.get|process\.env/);
    expect(source).not.toMatch(/sb_secret_/);
  });

  it('est déclaré dans netlify.toml', () => {
    const toml = readFileSync(join(process.cwd(), 'netlify.toml'), 'utf8');
    expect(toml).toContain('path = "/api/reelora-video"');
    expect(toml).toContain('function = "reelora-video"');
  });
});

describe('relais reelora-video — comportement', () => {
  it('refuse une requête sans session SANS appeler la fonction', async () => {
    const relay = await loadRelay();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await relay(request('{}', { 'content-type': 'application/json' }));

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    const payload = await response.json() as { error: { code: string } };
    expect(payload.error.code).toBe('UNAUTHENTICATED');
  });

  it('transmet la session et le corps tels quels, sans rien inventer', async () => {
    const relay = await loadRelay();
    const appels: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      appels.push({ url, init });
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const body = '{"action":"start","job_id":"abc"}';
    const response = await relay(request(body));

    expect(appels).toHaveLength(1);
    expect(appels[0].url).toBe(TARGET);
    expect(appels[0].init?.method).toBe('POST');
    expect(appels[0].init?.body).toBe(body);
    const headers = new Headers(appels[0].init?.headers);
    expect(headers.get('Authorization')).toBe(session.authorization);
    expect(headers.get('apikey')).toBe(session.apikey);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('remonte le statut et le corps d’erreur de la fonction sans les réécrire', async () => {
    const relay = await loadRelay();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"error":{"code":"MODEL_UNAVAILABLE","message":"indisponible"}}',
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    )));

    const response = await relay(request());

    expect(response.status).toBe(422);
    expect(await response.text()).toContain('MODEL_UNAVAILABLE');
  });

  it('n’autorise pas la mise en cache d’une réponse personnelle', async () => {
    const relay = await loadRelay();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const response = await relay(request());
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuse un corps absent ou démesuré avant tout appel', async () => {
    const relay = await loadRelay();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const vide = await relay(request(''));
    expect(vide.status).toBe(400);

    const enorme = await relay(request('x'.repeat(262_145)));
    expect(enorme.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('répond 405 à autre chose que POST et 204 à la pré-vérification CORS', async () => {
    const relay = await loadRelay();
    vi.stubGlobal('fetch', vi.fn());

    const options = await relay(new Request('https://x/api/reelora-video', { method: 'OPTIONS' }));
    expect(options.status).toBe(204);

    const get = await relay(new Request('https://x/api/reelora-video', {
      method: 'GET',
      headers: { ...session },
    }));
    expect(get.status).toBe(405);
  });

  it('convertit une coupure réseau en 502 explicite, jamais en succès', async () => {
    const relay = await loadRelay();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('réseau coupé'); }));

    const response = await relay(request());
    expect(response.status).toBe(502);
    const payload = await response.json() as { error: { code: string } };
    expect(payload.error.code).toBe('REELORA_VIDEO_UNAVAILABLE');
  });
});
