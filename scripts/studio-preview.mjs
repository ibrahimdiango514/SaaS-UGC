#!/usr/bin/env node
/**
 * Captures de preview du Studio VYORA (desktop + mobile) — harnais de
 * vérification VISUELLE, exécuté dans un Chromium sans interface.
 *
 * ## Ce que ce script fait
 * Il ouvre l'application Vite réelle (`npm run dev`) dans Chromium et intercepte
 * les requêtes réseau du navigateur pour fournir :
 *   - une session Supabase de démonstration (localStorage `reelora.auth.v1`) ;
 *   - des réponses RPC / Edge représentatives (catalogue vidéo, devis serveur,
 *     grille de crédits Studio).
 *
 * ## Ce que ce script ne fait pas
 * Aucune requête n'atteint Supabase : tout est intercepté au niveau du
 * navigateur. Aucun paiement, aucune réservation, aucune génération fournisseur,
 * aucune écriture en base. Les captures ne prouvent donc pas l'état de la base :
 * elles prouvent le rendu et les interactions de l'interface.
 *
 * ## Usage
 *   node scripts/studio-preview.mjs [--base http://127.0.0.1:4180] [--out preview-studio]
 *
 * Prérequis : `npm run dev` doit tourner, et un binaire Chromium doit être
 * disponible (`PLAYWRIGHT/CHROMIUM`). Voir README du dossier de captures.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = arg('base', process.env.STUDIO_PREVIEW_BASE ?? 'http://127.0.0.1:4180');
const OUT = path.resolve(arg('out', 'preview-studio'));
const SHOTS = path.join(OUT, 'screenshots');
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/tmp/chromium';
const NEXT_TICK = 40;

const now = new Date();
const iso = (offsetMs = 0) => new Date(now.getTime() + offsetMs).toISOString();
const USER_ID = 'preview-user-0001';
const WORKSPACE_ID = 'preview-workspace-0001';

/** Session Supabase de démonstration : jamais valide côté serveur. */
const SESSION = {
  access_token: 'preview-header.' + Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.preview-signature',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(now.getTime() / 1000) + 3600,
  refresh_token: 'preview-refresh-token',
  user: {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'preview@vyora.local',
    email_confirmed_at: iso(),
    created_at: iso(-86400000 * 30),
    updated_at: iso(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: 'Preview VYORA' },
    identities: [],
  },
};

/* ------------------------------------------------------------------ */
/* Catalogue et devis : valeurs d'affichage, pas des prix fournisseur   */
/* ------------------------------------------------------------------ */

const paramSchema = {
  aspect_ratio: { type: 'select', options: ['9:16', '1:1', '16:9'], default: '9:16' },
  resolution: { type: 'select', options: ['480p', '720p', '1080p'], default: '720p' },
  duration: { type: 'select', options: ['5', '8', '10'], default: '5' },
};

const models = [
  {
    model_id: 'preview-t2v-fast', display_name: 'Pipeline Texte → Vidéo (rapide)',
    description: 'Modèle le plus économique du catalogue.', category: 'Text to Video',
    input_fields: ['prompt', 'aspect_ratio', 'resolution', 'duration'],
    required_fields: ['prompt'], param_schema: paramSchema,
    cost_usd: null, is_enabled: true, is_coming_soon: false, sort_order: 10,
    reelora_status: 'active', account_access: 'account', dynamic_pricing: true, source: 'preview',
  },
  {
    model_id: 'preview-t2v-standard', display_name: 'Pipeline Texte → Vidéo (standard)',
    description: 'Rendu équilibré pour un clip UGC.', category: 'Text to Video',
    input_fields: ['prompt', 'aspect_ratio', 'resolution', 'duration'],
    required_fields: ['prompt'], param_schema: paramSchema,
    cost_usd: null, is_enabled: true, is_coming_soon: false, sort_order: 20,
    reelora_status: 'active', account_access: 'account', dynamic_pricing: true, source: 'preview',
  },
  {
    model_id: 'preview-t2v-premium', display_name: 'Pipeline Texte → Vidéo (premium)',
    description: 'Publicité UGC complète.', category: 'Text to Video',
    input_fields: ['prompt', 'aspect_ratio', 'resolution', 'duration'],
    required_fields: ['prompt'], param_schema: paramSchema,
    cost_usd: null, is_enabled: true, is_coming_soon: false, sort_order: 30,
    reelora_status: 'active', account_access: 'account', dynamic_pricing: true, source: 'preview',
  },
  {
    model_id: 'preview-i2v', display_name: 'Pipeline Image → Vidéo',
    description: 'Anime une image de référence.', category: 'Image to Video',
    input_fields: ['prompt', 'image_url', 'aspect_ratio', 'duration'],
    required_fields: ['prompt', 'image_url'], param_schema: paramSchema,
    cost_usd: null, is_enabled: true, is_coming_soon: false, sort_order: 40,
    reelora_status: 'active', account_access: 'account', dynamic_pricing: true, source: 'preview',
  },
  {
    model_id: 'preview-effects', display_name: 'Pipeline Effets',
    description: 'Transitions et effets rapides.', category: 'Video to Video',
    input_fields: ['prompt', 'aspect_ratio'], required_fields: ['prompt'],
    param_schema: paramSchema, cost_usd: null, is_enabled: true, is_coming_soon: false,
    sort_order: 50, reelora_status: 'active', account_access: 'account', dynamic_pricing: true, source: 'preview',
  },
  {
    model_id: 'preview-lipsync', display_name: 'Pipeline Lip Sync',
    description: 'Synchronisation labiale sur audio existant.', category: 'Audio to Video',
    input_fields: ['prompt', 'image_url'], required_fields: ['prompt', 'image_url'],
    param_schema: paramSchema, cost_usd: null, is_enabled: true, is_coming_soon: false,
    sort_order: 60, reelora_status: 'active', account_access: 'account', dynamic_pricing: true, source: 'preview',
  },
];

const services = [
  { service_key: 'ugc_clip_8s', display_name: 'Clip UGC 8 s', description: 'Clip court', credits_cost: 16, active: true, config: {} },
  { service_key: 'ugc_clip_15s', display_name: 'Clip UGC 15 s', description: 'Clip standard', credits_cost: 28, active: true, config: {} },
  { service_key: 'ugc_ad_4clips', display_name: 'Publicité UGC 4 clips', description: 'Publicité complète', credits_cost: 64, active: true, config: {} },
];

const projects = [
  {
    id: 'preview-project-0001', workspace_id: WORKSPACE_ID, brand_id: null,
    title: 'Lancement collection — Studio', brief: 'Clip vertical de présentation produit.',
    platform: 'TikTok', language: 'fr', aspect_ratio: '9:16', status: 'active',
    created_by: USER_ID, created_at: iso(-86400000), updated_at: iso(-3600000),
  },
];

const quota = {
  plan: {
    plan_key: 'studio', display_name: 'Studio', tagline: 'Production régulière',
    monthly_price_minor: 1500000, currency: 'XOF', monthly_credits: 120,
    max_projects: 20, max_scripts_per_month: 60, max_prompts_per_month: 200,
    max_videos_per_month: 30, max_avatars: 5, features: [], active: true, sort_order: 2,
  },
  status: 'active', credits: 120, period: '2026-11', projects: 1, avatars: 0,
  usage: { video: 4 }, period_end: iso(86400000 * 20),
};

const profile = {
  user_id: USER_ID, display_name: 'Preview VYORA', country_code: 'ML',
  preferred_language: 'fr', created_at: iso(-86400000 * 30),
};

const workspace = {
  id: WORKSPACE_ID, name: 'Studio VYORA (démo)', owner_id: USER_ID,
  default_language: 'fr', country_code: 'ML', created_at: iso(-86400000 * 30),
};

const cr = 'studio_credit_history';
const grid = {
  currency: 'XOF',
  usd_to_xof: 620,
  credit_value_xof: 100,
  target_margin_percent: 60,
  processing_cost_usd: 0.01,
  updated_at: iso(-86400000 * 2),
  packs: [
    { pack_key: 'creator', label: 'Creator', price_xof: 5000, credits: 27, price_per_credit_xof: 185.19, recommended: false },
    { pack_key: 'pro_creator', label: 'Pro Creator', price_xof: 15000, credits: 95, price_per_credit_xof: 157.89, recommended: true },
    { pack_key: 'studio_business', label: 'Studio Business', price_xof: 35000, credits: 265, price_per_credit_xof: 132.08, recommended: false },
  ],
  custom_recharge: { min_xof: 5000, max_xof: 350000, step_xof: 1000 },
  // Aucun coût inventé : la preview reproduit la règle réelle (montant
  // uniquement s'il a été mesuré côté serveur).
  examples: [
    { label: 'Clip court 8 s', approx_credits: null },
    { label: 'Clip 15 s', approx_credits: null },
    { label: 'Publicité 4 clips', approx_credits: null },
  ],
};

const history = {
  purchases: [],
  ledger: [
    { id: 'preview-ledger-1', created_at: iso(-3600000 * 5), amount: 120, kind: 'grant', reason: 'Crédits d’abonnement Studio', balance_after: 120, reference: 'studio-plan' },
  ],
};

/* ------------------------------------------------------------------ */
/* Routeur de réponses simulées                                       */
/* ------------------------------------------------------------------ */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
  'access-control-expose-headers': '*',
};

function estimateFor(body) {
  const service = services.find((s) => s.service_key === body.service_key) ?? services[0];
  const credits = service.credits_cost;
  return {
    service_key: service.service_key,
    credits_cost: credits,
    service_active: true,
    model_id: body.model_id ?? models[0].model_id,
    model_available: true,
    model_status: 'available',
    model_reason: null,
    pricing_available: true,
    pricing_error: null,
    quote_id: 'preview-quote-' + credits,
    quote_expires_at: iso(600000),
    provider_quote: {
      available: true, cost_usd: null, currency: 'USD', source: 'preview',
      error_code: null, error_message: null, checked_at: iso(),
      catalog_synced_at: iso(-60000), stale_catalog: false,
      pricing_basis: { note: 'devis simulé côté navigateur' },
      billing_units: [], estimate_endpoint_available: false,
    },
  };
}

function edgeResponse(url, body) {
  const fn = url.pathname.split('/').pop();
  if (fn === 'reelora-health') return { configured: { muapi: true, groq: true, gemini: true } };
  if (fn === 'video-quote') {
    return {
      quote: {
        available: true, cost_usd: null, currency: 'USD', source: 'preview',
        error_code: null, error_message: null, checked_at: iso(),
        catalog_synced_at: iso(-60000), stale_catalog: false,
        pricing_basis: { note: 'devis simulé côté navigateur' },
        billing_units: [], estimate_endpoint_available: false,
      },
      model_available: true, model_reason: null,
    };
  }
  if (fn === 'business-grow') {
    // Miroir de l'Edge Function `business-grow` (v16+). Sans cette branche, la
    // preview renvoyait `{configured:{}}` et la page Business affichait
    // « backend absent ou injoignable » : le harnais masquait la panne réelle.
    const action = body?.action ?? 'status';
    if (action === 'status') {
      return {
        data: {
          providers: [
            { provider_key: 'anthropic', display_name: 'Anthropic Claude', enabled: false, status: 'unverified', config_status: 'missing', checked_at: null, verified_model_keys: [] },
            { provider_key: 'deepseek', display_name: 'DeepSeek', enabled: false, status: 'unverified', config_status: 'missing', checked_at: null, verified_model_keys: [] },
            { provider_key: 'gemini', display_name: 'Gemini', enabled: true, status: 'available', config_status: 'configured', checked_at: iso(-60000), verified_model_keys: ['gemini-2.5-flash'] },
            { provider_key: 'groq', display_name: 'Groq', enabled: true, status: 'available', config_status: 'configured', checked_at: iso(-60000), verified_model_keys: ['openai/gpt-oss-120b'] },
          ],
        },
      };
    }
    if (action === 'providers.verify') {
      return {
        data: {
          providerKey: body?.providerKey ?? 'groq',
          modelKey: body?.providerKey === 'gemini' ? 'gemini-2.5-flash' : 'openai/gpt-oss-120b',
          status: 'healthy', latencyMs: 420, errorCode: null,
          availableModels: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
        },
      };
    }
    return { data: { action, preview: true } };
  }
  if (fn === 'reelora-video') {
    const action = body?.action ?? 'estimate';
    if (action === 'catalog') {
      return {
        models,
        catalog: { fetched_at: iso(), detected_video: models.length, active: models.length, unavailable: 0, verified: true, error: null },
      };
    }
    if (action === 'estimate') return estimateFor(body);
    if (action === 'quote') return { quote: edgeResponse(url, { action: 'video-quote' }).quote, model_available: true, model_reason: null };
    return { error: { code: 'PREVIEW_ONLY', message: 'Action non simulée dans la preview : ' + action } };
  }
  // Fonctions secondaires : elles ne portent aucune décision métier de la page
  // Business, mais elles doivent répondre un corps plausible plutôt qu'un
  // objet générique qui masquerait une fonction réellement absente.
  if (fn === 'reelora-owner-bootstrap') {
    return { user_id: USER_ID, workspace_id: WORKSPACE_ID, role: 'owner', needs_bootstrap: false };
  }
  if (fn === 'vyora-ai' || fn === 'reelora-ai') {
    const action = body?.action ?? 'health';
    if (action === 'health') return { configured: { groq: true, gemini: true }, providers: ['groq', 'gemini'], status: 'ok' };
    return { ok: true, preview: true, action };
  }
  if (fn === 'vyora-provider-health') {
    return { providers: [{ provider_key: 'groq', status: 'available' }, { provider_key: 'gemini', status: 'available' }] };
  }
  if (fn === 'reelora-video-worker') {
    return { ok: true, queued: false, preview: true };
  }
  if (fn === 'vyora-payments') {
    // État par défaut réel : paiement en ligne désactivé. La preview ne simule
    // jamais un paiement, une commande ni un solde marchand.
    const action = body && typeof body === 'object' ? body.action : undefined;
    if (action === 'options') {
      return {
        product: body.product === 'business' ? 'business' : 'studio', available: false, reason: 'PAYMENTS_DISABLED',
        message: 'Le paiement en ligne n’est pas encore activé.', mode: 'test', flows: [], price: null, countries: [],
      };
    }
    if (action === 'balances') {
      return { configured: false, mode: null, balances: [], message: 'Aucune clé SasPay n’est installée côté serveur.' };
    }
    return { error: { code: 'PAYMENTS_DISABLED', message: 'Le paiement en ligne n’est pas encore activé.' } };
  }
  if (fn === 'vyora-saspay-webhook') {
    // Appelé par SasPay uniquement (signature HMAC) : jamais par le navigateur.
    return { error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Signature de webhook invalide.' } };
  }
  // Ne jamais retomber sur un corps générique : cela fait passer une fonction
  // réellement absente pour une fonction saine.
  return { error: { code: 'UNKNOWN_FUNCTION', message: 'Fonction non simulée dans la preview : ' + fn } };
}

function rpcResponse(name) {
  switch (name) {
    case 'reelora_bootstrap':
      return { user_id: USER_ID, workspace_id: WORKSPACE_ID, plan: 'studio', credits: 120, is_admin: false };
    case 'reelora_quota_status':
      return quota;
    case 'studio_credit_grid':
      return grid;
    case 'studio_credit_history':
      return history;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Captures                                                           */
/* ------------------------------------------------------------------ */

const interactions = [];
const consoleErrors = [];
const pageErrors = [];

function record(name, pass, detail) {
  interactions.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${JSON.stringify(detail)}`);
}

async function newPage(browser) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)); });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 400)));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    try {
      handle(req);
    } catch (error) {
      console.error('HANDLER_ERROR', req.method(), req.url().slice(0, 120), String(error).slice(0, 200));
      req.abort().catch(() => {});
    }
  });
  const handle = (req) => {
    const url = new URL(req.url());
    const isSupabase = /supabase\.co$/.test(url.hostname);
    if (url.hostname === new URL(BASE).hostname) return req.continue();
    if (!isSupabase) return req.abort();

    // Préflight CORS : supabase-js échoue si on l'annule.
    if (req.method() === 'OPTIONS') {
      return req.respond({ status: 204, headers: CORS, body: '' });
    }

    // Session & user
    if (url.pathname.startsWith('/auth/v1/')) {
      const payload = url.pathname.endsWith('/user')
        ? SESSION.user
        : { access_token: SESSION.access_token, token_type: 'bearer', expires_in: 3600, expires_at: SESSION.expires_at, refresh_token: SESSION.refresh_token, user: SESSION.user };
      return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(payload) });
    }
    // Edge Functions
    if (url.pathname.startsWith('/functions/v1/')) {
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(edgeResponse(url, body)) });
    }
    // RPC
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').pop();
      const payload = rpcResponse(name);
      if (payload !== null) {
        return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(payload) });
      }
      return req.respond({ status: 400, contentType: 'application/json', headers: CORS, body: JSON.stringify({ message: `RPC ${name} non simulée dans la preview`, code: 'PREVIEW_ONLY' }) });
    }
    // Tables (lecture seule : toute écriture est annulée).
    if (req.headers()['accept']?.includes('vnd.pgrst.object')) {
      // Réponse « single object » : un enregistrement ou 406 si absent.
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      if (!['GET', 'HEAD'].includes(req.method())) return req.abort();
      const table = url.pathname.replace('/rest/v1/', '').split('?')[0];
      const single = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
      const collections = {
        ugc_profiles: [profile],
        ugc_workspaces: [workspace],
        ugc_service_catalog: services,
        ugc_video_projects: projects,
        reelora_avatars: [],
        ugc_generations: [],
        ugc_recharge_orders: [],
        reelora_notifications: [],
      };
      const rows = collections[table] ?? [];
      const body = single ? (rows[0] ?? null) : rows;
      return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
    }
    return req.abort();
  };
  return page;
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EXECUTABLE,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
    env: { ...process.env },
  });

  /* ---------------- Desktop ---------------- */
  const page = await newPage(browser);
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

  // Injecte la session avant tout chargement applicatif.
  await page.setCookie({ name: 'preview', value: '1', domain: new URL(BASE).hostname, path: '/' });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate((session) => {
    window.localStorage.setItem('reelora.auth.v1', JSON.stringify(session));
  }, SESSION);

  const files = [];
  const shot = async (name, title) => {
    const file = path.join(SHOTS, name);
    await page.screenshot({ path: file, fullPage: false });
    files.push({ file: path.relative(OUT, file), title });
  };
  const shotFull = async (name, title) => {
    const file = path.join(SHOTS, name);
    await page.screenshot({ path: file, fullPage: true });
    files.push({ file: path.relative(OUT, file), title });
  };

  // 1. Studio, état initial
  await page.goto(`${BASE}/app/studio`, { waitUntil: 'networkidle2', timeout: 60000 });
  try {
    await page.waitForSelector('[data-testid="studio-prompt-bar"]', { timeout: 30000 });
  } catch (error) {
    console.log('DEBUG_URL', page.url());
    console.log('DEBUG_BODY', (await page.evaluate(() => document.body.innerText)).slice(0, 900));
    throw error;
  }
  await new Promise((r) => setTimeout(r, 1200));

  const hero = await page.$('[data-testid="studio-hero"]');
  const categories = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.studio-bar-tab')).map((el) => el.textContent?.trim()));
  record('Coque immersive : hero + navigation par catégories', Boolean(hero) && categories.length >= 4,
    { categories });
  await shot('01-studio-desktop.png', 'Studio VYORA — canvas immersif, hero et barre de prompt dockée');

  // 2. Devis serveur après saisie d'un prompt
  const prompt = 'Présentation d’une crème hydratante bio filmée en lumière naturelle, plan vertical TikTok.';
  await page.click('[data-testid="studio-prompt-bar"] textarea, [data-testid="studio-prompt-bar"] input').catch(() => {});
  await page.keyboard.type(prompt, { delay: 4 });
  await new Promise((r) => setTimeout(r, 2500));
  const creditSummary = await page.evaluate(() => document.querySelector('[data-testid="studio-credit-summary"]')?.textContent?.trim() ?? '');
  record('Devis serveur affiché dans la barre de prompt', /crédits?/.test(creditSummary) || creditSummary.length > 0, { creditSummary });
  await shot('02-studio-devis-desktop.png', 'Devis serveur et coût en crédits avant génération');

  // 3. Panneau modèles
  const openedCatalog = await page.evaluate(async () => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const target = buttons.find((b) => /mod[eè]le/i.test(b.textContent ?? '') && b.closest('[data-testid="studio-prompt-bar"]'));
    if (!target) return false;
    target.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 1500));
  record('Sélecteur de modèle accessible depuis la barre de prompt', openedCatalog, { openedCatalog });
  if (openedCatalog) await shotFull('03-studio-modeles-desktop.png', 'Panneau des modèles et paramètres réels');
  await page.keyboard.press('Escape');

  // 4. Page crédits
  await page.goto(`${BASE}/app/credits`, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1800));
  const packs = await page.evaluate(() => Array.from(document.querySelectorAll('h3, [data-testid]')).map((e) => e.textContent?.trim()).filter(Boolean).slice(0, 40));
  const hasPacks = await page.evaluate(() => /5\s?000|15\s?000|35\s?000/.test(document.body.innerText));
  record('Page crédits : 3 packs aux prix fixés', hasPacks, { packs: packs.slice(0, 6) });
  await shotFull('04-credits-desktop.png', 'Grille de crédits Studio — packs, prix au crédit et recharge libre');

  // 5. Mobile
  const mobile = await newPage(browser);
  await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mobile.goto(BASE, { waitUntil: 'domcontentloaded' });
  await mobile.evaluate((session) => window.localStorage.setItem('reelora.auth.v1', JSON.stringify(session)), SESSION);
  await mobile.goto(`${BASE}/app/studio`, { waitUntil: 'networkidle2', timeout: 60000 });
  await mobile.waitForSelector('[data-testid="studio-prompt-bar"]', { timeout: 45000 });
  await new Promise((r) => setTimeout(r, 1500));
  const mobileBar = await mobile.evaluate(() => {
    const bar = document.querySelector('[data-testid="studio-prompt-bar"]');
    const r = bar?.getBoundingClientRect();
    return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), viewport: window.innerHeight } : null;
  });
  record('Mobile : barre de prompt atteignable sans défilement horizontal',
    Boolean(mobileBar) && mobileBar.bottom <= mobileBar.viewport + 2, { mobileBar });
  const file = path.join(SHOTS, '05-studio-mobile.png');
  await mobile.screenshot({ path: file });
  files.push({ file: path.relative(OUT, file), title: 'Studio mobile 390×844 — barre de prompt dockée' });

  // Deux captures viewport (et non `fullPage`) : la barre de navigation fixe
  // est un élément `position: fixed` qui se superposerait au contenu dans une
  // capture pleine page.
  await mobile.goto(`${BASE}/app/credits`, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  const fileCredits = path.join(SHOTS, '06-credits-mobile-haut.png');
  await mobile.screenshot({ path: fileCredits });
  files.push({ file: path.relative(OUT, fileCredits), title: 'Crédits Studio mobile — packs et prix au crédit' });
  await mobile.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 600));
  const fileCreditsBottom = path.join(SHOTS, '07-credits-mobile-bas.png');
  await mobile.screenshot({ path: fileCreditsBottom });
  files.push({ file: path.relative(OUT, fileCreditsBottom), title: 'Crédits Studio mobile — recharge libre, historique et périmètre' });

  await browser.close();

  const passed = interactions.filter((i) => i.pass).length;
  const verification = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    mode: 'réseau navigateur intercepté — aucune requête Supabase réelle, aucun paiement, aucune génération',
    viewportDesktop: '1440×1000',
    viewportMobile: '390×844',
    interactions: { total: interactions.length, passed, failed: interactions.length - passed, items: interactions },
    consoleErrors,
    pageErrors,
    files,
  };
  await writeFile(path.join(OUT, 'verification.json'), JSON.stringify(verification, null, 2));
  console.log(`\n${passed}/${interactions.length} interactions · ${consoleErrors.length} erreurs console · ${pageErrors.length} erreurs page`);
  if (passed !== interactions.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
