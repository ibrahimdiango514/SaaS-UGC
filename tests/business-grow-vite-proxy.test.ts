import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

/** Integration test for the actual Vite relay, using a disposable local upstream. */
describe('Business Grow Vite relay', () => {
  let upstream: Server;
  let vite: ViteDevServer;
  let baseUrl: string;
  let viteCacheDir: string;
  let upstreamOpen = false;
  const previousUrl = process.env.VITE_SUPABASE_URL;
  const previousLocalFunction = process.env.VITE_BUSINESS_GROW_FUNCTION_URL;
  const received: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    upstream = createHttpServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        received.push({ method: request.method, url: request.url, headers: request.headers, body });
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'upstream-private=do-not-forward; Path=/',
          'Cache-Control': 'public, max-age=100',
        });
        response.end(JSON.stringify({ data: { providers: [] } }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamOpen = true;
    const upstreamPort = (upstream.address() as AddressInfo).port;
    process.env.VITE_SUPABASE_URL = `http://127.0.0.1:${upstreamPort}`;
    delete process.env.VITE_BUSINESS_GROW_FUNCTION_URL;

    // Vite treats port 0 as its default port, so reserve an ephemeral port first.
    const reservation = createHttpServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const vitePort = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    // A test server must never share Vite's dependency cache with the live
    // preview: closing/reoptimizing it can otherwise delete the preview's
    // modules and make the browser render an empty page (504 Outdated Optimize Dep).
    viteCacheDir = mkdtempSync(join(tmpdir(), 'vyora-vite-test-'));
    vite = await createViteServer({
      configFile: `${process.cwd()}/vite.config.ts`,
      cacheDir: viteCacheDir,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: vitePort, strictPort: true },
    });
    await vite.listen();
    baseUrl = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (vite) await vite.close();
    if (viteCacheDir) rmSync(viteCacheDir, { recursive: true, force: true });
    if (upstreamOpen) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (previousUrl === undefined) delete process.env.VITE_SUPABASE_URL;
    else process.env.VITE_SUPABASE_URL = previousUrl;
    if (previousLocalFunction === undefined) delete process.env.VITE_BUSINESS_GROW_FUNCTION_URL;
    else process.env.VITE_BUSINESS_GROW_FUNCTION_URL = previousLocalFunction;
  });

  it('uses an isolated cache instead of the live preview dependency cache', () => {
    expect(vite.config.cacheDir).toBe(viteCacheDir);
    expect(vite.config.cacheDir).not.toBe(join(process.cwd(), 'node_modules', '.vite'));
  });

  it('forwards the JWT and public key only to the configured function, without cookies or Origin', async () => {
    const response = await fetch(`${baseUrl}/api/business-grow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer local-test-token',
        apikey: 'local-test-public-key',
        Origin: 'https://5173-test.e2b.app',
        Cookie: 'app-session=must-not-leak',
        'X-Private-Header': 'must-not-leak',
      },
      body: JSON.stringify({ action: 'status' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { providers: [] } });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: 'POST', url: '/functions/v1/business-grow' });
    expect(JSON.parse(received[0].body)).toEqual({ action: 'status' });
    expect(received[0].headers.authorization).toBe('Bearer local-test-token');
    expect(received[0].headers.apikey).toBe('local-test-public-key');
    expect(received[0].headers.origin).toBeUndefined();
    expect(received[0].headers.cookie).toBeUndefined();
    expect(received[0].headers['x-private-header']).toBeUndefined();
  });

  it('reports an upstream connection failure as a JSON 502, not an HTML 404', async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    upstreamOpen = false;
    const response = await fetch(`${baseUrl}/api/business-grow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test', apikey: 'public' },
      body: JSON.stringify({ action: 'status' }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'BUSINESS_GROW_RELAY_UNAVAILABLE' } });
  });
});
