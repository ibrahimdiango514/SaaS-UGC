/**
 * Sonde réelle Business Grow : charge l'application avec une session Supabase
 * RÉELLE (JWT du compte sonde de diagnostic) et enregistre les échanges réseau
 * vers la fonction Edge. Aucune interception : on observe le vrai comportement.
 *
 *   node scripts/business-probe.mjs --base http://127.0.0.1:4180 --out /tmp/bg-probe
 *   (requiert LD_LIBRARY_PATH=/tmp/al2023/lib pour Chromium)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = arg('base', 'http://127.0.0.1:4180');
const OUT = path.resolve(arg('out', '/tmp/bg-probe'));
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/tmp/chromium';
const ACCESS_TOKEN = process.env.PROBE_ACCESS_TOKEN ?? '';
const REFRESH_TOKEN = process.env.PROBE_REFRESH_TOKEN ?? '';
const ROUTE = arg('route', '/app/business');

if (!ACCESS_TOKEN) {
  console.error('PROBE_ACCESS_TOKEN manquant');
  process.exit(2);
}

fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });

const user = JSON.parse(Buffer.from(ACCESS_TOKEN.split('.')[1], 'base64url').toString());
const session = {
  access_token: ACCESS_TOKEN,
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: user.exp + 3600,
  refresh_token: REFRESH_TOKEN,
  user: {
    id: user.sub,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    app_metadata: user.app_metadata ?? { provider: 'email', providers: ['email'] },
    user_metadata: user.user_metadata ?? {},
    identities: [],
  },
};

const browser = await puppeteer.launch({
  executablePath: EXECUTABLE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const exchanges = [];
const consoleErrors = [];

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 500));
});
page.on('requestfailed', (req) => {
  if (/supabase\.co|business-grow/i.test(req.url())) {
    exchanges.push({ kind: 'failed', url: req.url(), method: req.method(), error: req.failure()?.errorText });
  }
});
page.on('response', async (res) => {
  const url = res.url();
  if (!/supabase\.co\/functions|business-grow/i.test(url)) return;
  let body = '';
  try { body = (await res.text()).slice(0, 800); } catch { /* ignore */ }
  const headers = res.headers();
  exchanges.push({
    kind: 'response',
    status: res.status(),
    url,
    method: res.request().method(),
    acao: headers['access-control-allow-origin'] ?? null,
    body,
  });
});

await page.evaluateOnNewDocument((payload) => {
  window.localStorage.setItem('reelora.auth.v1', JSON.stringify(payload));
}, session);

await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'networkidle2', timeout: 90_000 });
await new Promise((r) => setTimeout(r, 6000));

const text = await page.evaluate(() => document.body.innerText);
const report = {
  base: BASE,
  route: ROUTE,
  finalUrl: page.url(),
  exchanges,
  consoleErrors,
  bodyText: text.slice(0, 4000),
  verdict: {
    backendUnavailableMessage: /absent ou injoignable|pas encore installé ou accessible|indisponible/i.test(text),
    noVerifiedProvider: /aucun service IA v[ée]rifi[ée]|Aucun service IA disponible/i.test(text),
  },
};

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await page.screenshot({ path: path.join(OUT, 'screenshots', 'business.png'), fullPage: true });

console.log(JSON.stringify({ exchangeCount: exchanges.length, exchanges, verdict: report.verdict }, null, 2));
console.log('--- BODY TEXT ---');
console.log(report.bodyText.slice(0, 2500));

await browser.close();
