/**
 * Reproduit la page Business dans les conditions du harnais de capture
 * (interception réseau identique à scripts/studio-preview.mjs) et rapporte
 * le texte réellement affiché + les échanges vers la fonction Edge.
 *
 *   node scripts/business-page-probe.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:4180';
const OUT = '/tmp/business-page-probe';
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/tmp/chromium';
fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });

const TOKEN = 'preview-header.' + Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.preview-signature';
const iso = () => new Date().toISOString();
const USER_ID = 'preview-user-0001';
const session = {
  access_token: TOKEN, token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'preview-refresh-token',
  user: {
    id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'preview@vyora.local',
    email_confirmed_at: iso(), created_at: iso(), updated_at: iso(),
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [],
  },
};
const CORS = {
  'access-control-allow-origin': BASE,
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
};

const browser = await puppeteer.launch({
  executablePath: EXECUTABLE, headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });

const seen = [];
await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = new URL(req.url());
  if (url.hostname === new URL(BASE).hostname) return req.continue();
  if (!/supabase\.co$/.test(url.hostname)) return req.abort();
  if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: CORS, body: '' });
  if (url.pathname.startsWith('/auth/v1/')) {
    const payload = url.pathname.endsWith('/user')
      ? session.user
      : { access_token: TOKEN, token_type: 'bearer', expires_in: 3600, expires_at: session.expires_at, refresh_token: 'r', user: session.user };
    return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(payload) });
  }
  if (url.pathname.startsWith('/functions/v1/')) {
    // Comportement du harnais actuel : rien de spécifique à business-grow.
    seen.push({ fn: url.pathname.split('/').pop(), body: req.postData()?.slice(0, 120) });
    return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ configured: {} }) });
  }
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const name = url.pathname.split('/').pop();
    const rpc = name === 'reelora_bootstrap'
      ? { user_id: USER_ID, workspace_id: 'preview-workspace-0001', plan: 'studio', credits: 120, is_admin: false }
      : {};
    return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(rpc) });
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    if (!['GET', 'HEAD'].includes(req.method())) return req.abort();
    return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: '[]' });
  }
  return req.abort();
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate((s) => window.localStorage.setItem('reelora.auth.v1', JSON.stringify(s)), session);
await page.goto(`${BASE}/app/business`, { waitUntil: 'networkidle2', timeout: 90_000 });
await new Promise((r) => setTimeout(r, 5000));

const text = await page.evaluate(() => document.body.innerText);
await page.screenshot({ path: path.join(OUT, 'screenshots', 'business-mobile.png'), fullPage: true });

console.log('--- fonctions appelées ---');
console.log(JSON.stringify(seen, null, 2));
console.log('--- texte affiché (extrait) ---');
console.log(text.slice(0, 2200));

await browser.close();
