#!/usr/bin/env node
/**
 * Captures et mesures des espaces SORAHNEX (Studio, Grow, hub) sur plusieurs
 * tailles d'écran — harnais de vérification VISUELLE et ERGONOMIQUE.
 *
 * ## Ce que ce script fait
 * Il ouvre l'application Vite réelle dans Chromium, fournit une session de
 * démonstration et intercepte TOUTES les requêtes Supabase au niveau du
 * navigateur. Il capture des écrans réels et mesure objectivement :
 *   - le débordement horizontal de la page ;
 *   - les éléments qui dépassent la largeur visible ;
 *   - les cibles interactives trop petites pour un doigt ;
 *   - les erreurs console et exceptions.
 *
 * ## Ce que ce script ne fait pas
 * Aucune requête n'atteint Supabase : aucun paiement, aucune génération, aucune
 * écriture. Les données affichées sont des fixtures de rendu, pas l'état de la
 * base. Les captures prouvent le rendu et les interactions, pas la vérité des
 * données.
 *
 * ## Usage
 *   node scripts/spaces-preview.mjs [--base http://127.0.0.1:5173] [--out preview-espaces]
 *
 * Prérequis : `npm run dev` doit tourner. Chromium : variable CHROMIUM_PATH ou
 * `npx puppeteer browsers install chrome`.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = arg('base', process.env.SPACES_PREVIEW_BASE ?? 'http://127.0.0.1:5173');
const OUT = path.resolve(arg('out', 'preview-espaces'));
const SHOTS = path.join(OUT, 'screenshots');

const now = new Date();
const iso = (offsetMs = 0) => new Date(now.getTime() + offsetMs).toISOString();
const USER_ID = 'preview-user-0001';
const WORKSPACE_ID = 'preview-workspace-0001';

/** Session de démonstration : jamais valide côté serveur. */
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
    email: 'preview@sorahnex.local',
    email_confirmed_at: iso(),
    created_at: iso(-86400000 * 30),
    updated_at: iso(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: 'Aperçu SORAHNEX' },
    identities: [],
  },
};

const quota = {
  plan: {
    plan_key: 'studio', display_name: 'Studio', tagline: 'Production régulière',
    monthly_price_minor: 1500000, currency: 'XOF', monthly_credits: 120,
    max_projects: 20, max_scripts_per_month: 60, max_prompts_per_month: 200,
    max_videos_per_month: 30, max_avatars: 5, features: [], active: true, sort_order: 2,
  },
  status: 'active', credits: 120, period: '2026-11', projects: 3, avatars: 2,
  usage: { video: 4 }, period_end: iso(86400000 * 20),
};

const profile = {
  user_id: USER_ID, display_name: 'Aperçu SORAHNEX', country_code: 'SN',
  preferred_language: 'fr', created_at: iso(-86400000 * 30),
};

const workspace = {
  id: WORKSPACE_ID, name: 'Atelier Sorahnex (démo)', owner_id: USER_ID,
  default_language: 'fr', country_code: 'SN', created_at: iso(-86400000 * 30),
};

const projects = [
  {
    id: 'preview-project-0001', workspace_id: WORKSPACE_ID, brand_id: null,
    title: 'Lancement collection', brief: 'Clip vertical de présentation produit.',
    platform: 'TikTok', language: 'fr', aspect_ratio: '9:16', status: 'active',
    created_by: USER_ID, created_at: iso(-86400000), updated_at: iso(-3600000),
  },
  {
    id: 'preview-project-0002', workspace_id: WORKSPACE_ID, brand_id: null,
    title: 'Témoignage client', brief: 'Témoignage face caméra, 20 secondes.',
    platform: 'Instagram', language: 'fr', aspect_ratio: '9:16', status: 'draft',
    created_by: USER_ID, created_at: iso(-86400000 * 3), updated_at: iso(-86400000),
  },
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
  'access-control-expose-headers': '*',
};

const TABLES = {
  ugc_profiles: [profile],
  ugc_workspaces: [workspace],
  ugc_video_projects: projects,
  ugc_generations: [],
  ugc_service_catalog: [],
  ugc_recharge_orders: [],
  reelora_notifications: [],
  reelora_avatars: [],
};

function rpcResponse(name) {
  switch (name) {
    case 'reelora_bootstrap':
      return { user_id: USER_ID, workspace_id: WORKSPACE_ID, plan: 'studio', credits: 120, is_admin: false };
    case 'reelora_quota_status':
      return quota;
    default:
      return null;
  }
}

function edgeResponse(url) {
  const fn = url.pathname.split('/').pop();
  if (fn === 'business-grow') {
    // Le Growth OS affiche son état « service indisponible » : c'est un état
    // réel de l'interface, pas une donnée inventée.
    return { error: { code: 'BUSINESS_GROW_UNAVAILABLE', message: 'Service métier indisponible dans le harnais de rendu.' } };
  }
  if (fn === 'vyora-ai') return { configured: { ai: false }, status: 'unconfigured' };
  if (fn === 'reelora-health') return { configured: { muapi: false } };
  if (fn === 'reelora-owner-bootstrap') {
    return { user_id: USER_ID, workspace_id: WORKSPACE_ID, role: 'owner', needs_bootstrap: false };
  }
  return { error: { code: 'PREVIEW_ONLY', message: `Fonction non simulée : ${fn}` } };
}

const ROUTES = [
  { id: 'hub', path: '/app', label: 'Sélecteur d’espaces', ready: 'main' },
  { id: 'studio-accueil', path: '/app/studio/accueil', label: 'Studio · tableau de bord', ready: 'main' },
  { id: 'studio-creer', path: '/app/studio', label: 'Studio · création', ready: 'main' },
  { id: 'studio-projets', path: '/app/projets', label: 'Studio · projets', ready: 'main' },
  { id: 'grow-vue', path: '/app/business', label: 'Grow · vue générale', ready: 'main' },
  { id: 'grow-crm', path: '/app/business/crm', label: 'Grow · CRM', ready: 'main' },
  { id: 'grow-modules', path: '/app/business/modules', label: 'Grow · modules métier', ready: 'main' },
  { id: 'grow-module-workspace', path: '/app/business/modules/lead-rescue', label: 'Grow · module métier', ready: 'main' },
  { id: 'grow-assistant', path: '/app/business/assistant', label: 'Grow · assistant IA', ready: 'main' },
  { id: 'parametres', path: '/app/parametres', label: 'Compte · paramètres', ready: 'main' },
];

const VIEWPORTS = [
  { id: 'android-petit', width: 360, height: 740, mobile: true, label: 'Android petit · 360×740' },
  { id: 'android-grand', width: 412, height: 915, mobile: true, label: 'Android grand · 412×915' },
  { id: 'android-paysage', width: 740, height: 360, mobile: true, label: 'Android paysage · 740×360' },
  { id: 'tablette', width: 768, height: 1024, mobile: true, label: 'Tablette · 768×1024' },
  { id: 'tablette-paysage', width: 1024, height: 768, mobile: false, label: 'Tablette paysage · 1024×768' },
  { id: 'pc', width: 1440, height: 900, mobile: false, label: 'PC · 1440×900' },
];

const consoleErrors = [];
const pageErrors = [];
const results = [];

/** Mesures objectives dans la page : débordement, cibles, chevauchement. */
function measure() {
  const doc = document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const scrollableAncestor = (el) => {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowX) || /(auto|scroll)/.test(style.overflow)) return true;
      node = node.parentElement;
    }
    return false;
  };

  const elements = [...document.querySelectorAll('body *')];
  const protruding = [];
  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.position === 'fixed') continue;
    if (rect.right > vw + 1 && !scrollableAncestor(el)) {
      protruding.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className ?? '').slice(0, 70),
        right: Math.round(rect.right),
        text: (el.textContent ?? '').trim().slice(0, 40),
      });
      if (protruding.length >= 6) break;
    }
  }

  const smallTargets = [];
  if (vw < 768) {
    for (const el of document.querySelectorAll('a,button,[role="button"],input,select,textarea,summary')) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden') continue;
      if (rect.height < 40) {
        smallTargets.push({
          tag: el.tagName.toLowerCase(),
          label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 36),
          h: Math.round(rect.height),
          w: Math.round(rect.width),
        });
      }
    }
  }

  const bottomNav = document.querySelector('nav.safe-bottom');
  const fixedBottom = bottomNav ? bottomNav.getBoundingClientRect() : null;
  const lastContent = document.querySelector('main');
  const lastRect = lastContent ? lastContent.getBoundingClientRect() : null;

  return {
    overflowX: Math.max(0, doc.scrollWidth - doc.clientWidth),
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    viewport: { w: vw, h: vh },
    protruding,
    smallTargets: smallTargets.slice(0, 12),
    bottomNavHeight: fixedBottom ? Math.round(fixedBottom.height) : 0,
    mainBottom: lastRect ? Math.round(lastRect.bottom) : null,
    bodyTextLength: (document.body.innerText ?? '').trim().length,
  };
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const executablePath = process.env.CHROMIUM_PATH || (await puppeteer.executablePath());
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
  });

  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));

  const baseHost = new URL(BASE).hostname;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    try {
      const url = new URL(req.url());
      if (url.hostname === baseHost) return req.continue();
      if (!/supabase\.(co|in)$/.test(url.hostname)) return req.abort();
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: CORS, body: '' });

      if (url.pathname.startsWith('/auth/v1/')) {
        const payload = url.pathname.endsWith('/user')
          ? SESSION.user
          : {
            access_token: SESSION.access_token, token_type: 'bearer', expires_in: 3600,
            expires_at: SESSION.expires_at, refresh_token: SESSION.refresh_token, user: SESSION.user,
          };
        return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(payload) });
      }
      if (url.pathname.startsWith('/functions/v1/')) {
        return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(edgeResponse(url)) });
      }
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.split('/').pop();
        const payload = rpcResponse(name);
        if (payload !== null) {
          return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(payload) });
        }
        return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify([]) });
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('?')[0];
        const single = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
        const rows = TABLES[table] ?? [];
        const body = single ? (rows[0] ?? null) : rows;
        return req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
      }
      return req.abort();
    } catch {
      req.abort().catch(() => {});
      return undefined;
    }
  });

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate((session) => {
    window.localStorage.setItem('reelora.auth.v1', JSON.stringify(session));
  }, SESSION);

  for (const viewport of VIEWPORTS) {
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
      deviceScaleFactor: 2,
    });
    for (const route of ROUTES) {
      const entry = { viewport: viewport.id, route: route.id, path: route.path, label: route.label };
      try {
        await page.goto(`${BASE}${route.path}`, { waitUntil: 'networkidle2', timeout: 45000 });
        await page.waitForFunction(() => document.body.innerText.trim().length > 40, { timeout: 15000 });
        await new Promise((resolve) => setTimeout(resolve, 600));
        const metrics = await page.evaluate(measure);
        const file = path.join(SHOTS, `${route.id}-${viewport.id}.png`);
        await page.screenshot({ path: file, fullPage: false });
        Object.assign(entry, {
          ok: metrics.bodyTextLength > 40,
          metrics,
          screenshot: path.relative(OUT, file),
          url: page.url(),
        });
      } catch (error) {
        entry.ok = false;
        entry.error = String(error).slice(0, 240);
      }
      results.push(entry);
      console.log(JSON.stringify({
        viewport: viewport.id, route: route.id, ok: entry.ok,
        overflowX: entry.metrics?.overflowX ?? null,
        protruding: entry.metrics?.protruding.length ?? null,
        smallTargets: entry.metrics?.smallTargets.length ?? null,
        error: entry.error ?? null,
      }));
    }
  }

  await browser.close();

  const report = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    note:
      'Captures réelles d’un Chromium local. Toutes les requêtes Supabase sont interceptées : '
      + 'aucune écriture, aucun appel fournisseur. Les données affichées sont des fixtures de rendu ; '
      + 'le service métier est volontairement indisponible pour observer son état dans l’interface.',
    viewports: VIEWPORTS,
    routes: ROUTES,
    consoleErrors: [...new Set(consoleErrors)].slice(0, 40),
    pageErrors: [...new Set(pageErrors)].slice(0, 40),
    results,
  };
  await writeFile(path.join(OUT, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(`\nRapport : ${path.join(OUT, 'verification.json')}`);
  console.log(`Erreurs console : ${report.consoleErrors.length} · exceptions : ${report.pageErrors.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
