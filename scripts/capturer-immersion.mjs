#!/usr/bin/env node
/**
 * Captures de preuve visuelle de la landing immersive.
 *
 * ## Pourquoi ce script existe
 * Une landing « immersive » ne se prouve pas par des tests unitaires : il faut
 * des images. Ce dépôt a déjà été livré une fois avec un rapport qui affirmait
 * des scènes 3D sans qu'aucune capture n'ait été faite — le résultat était une
 * page de blocs. La preuve visuelle est donc un livrable, pas un bonus.
 *
 * ## Ce qu'il fait
 * Il prend une image toutes les 300 ms pendant un défilement complet, à
 * 1440×900 puis à 360×740, et enregistre les fichiers dans `preuves-immersion/`
 * (ignoré par Git : 137 PNG pesaient 37 Mo).
 *
 * ## Prérequis — navigateur
 * Il faut un Chromium joignable en CDP. Aucune image ne peut être produite
 * sans navigateur ; le script échoue franchement plutôt que de simuler.
 *
 *   # 1. Chromium avec ses bibliothèques (l'environnement n'en a aucune)
 *   npm pack @sparticuz/chromium && tar xzf sparticuz-chromium-*.tgz
 *   node -e "const z=require('node:zlib'),f=require('node:fs');\
 *     f.writeFileSync('/tmp/chromium', z.brotliDecompressSync(f.readFileSync('package/bin/chromium.br')))"
 *   chmod +x /tmp/chromium
 *
 *   # 2. Lancement en mode DevTools
 *   /tmp/chromium --headless=new --no-sandbox --disable-gpu \
 *     --remote-debugging-port=9222 about:blank &
 *
 *   # 3. Playwright (client seulement, aucun téléchargement de navigateur)
 *   npm i -D playwright-core
 *   node scripts/capturer-immersion.mjs
 *
 * Sur une machine qui a déjà Chromium, pointer `CDP_URL` dessus suffit.
 *
 * ## Le mode « complet »
 * Sans WebGL (cas de l'intégration continue et de cet environnement), la page
 * retombe en version allégée : les scènes sont visibles, la caméra ne bouge
 * pas. Pour capturer le chemin animé, on force le niveau par l'URL
 * (`?immersion=complet`) — c'est une commande de vérification, pas un réglage
 * produit, et `prefers-reduced-motion` garde le dernier mot.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173/';
const SORTIE = process.env.SORTIE ?? 'preuves-immersion';
const PAS = 260;

const MODES = [
  { nom: 'desktop', taille: { width: 1440, height: 900 }, url: `${BASE}?immersion=complet` },
  { nom: 'mobile', taille: { width: 360, height: 740 }, url: BASE, mobile: true },
];

function chargerPlaywright() {
  try {
    return require('playwright-core');
  } catch {
    try {
      return require('playwright');
    } catch {
      console.error(
        'Playwright est requis (client seulement). Installez-le :\n  npm i -D playwright-core',
      );
      process.exit(1);
    }
  }
}

const { chromium } = chargerPlaywright();

let navigateur;
try {
  navigateur = await chromium.connectOverCDP(CDP);
} catch {
  console.error(
    `Aucun Chromium joignable sur ${CDP}.\n` +
      'Démarrez-le avec --remote-debugging-port=9222 (voir l’en-tête de ce fichier),\n' +
      'ou définissez CDP_URL. Aucune capture ne peut être inventée.',
  );
  process.exit(1);
}

mkdirSync(SORTIE, { recursive: true });

for (const mode of MODES) {
  const dossier = `${SORTIE}/${mode.nom}`;
  mkdirSync(dossier, { recursive: true });

  const contexte = await navigateur.newContext({
    viewport: mode.taille,
    deviceScaleFactor: 1,
    isMobile: Boolean(mode.mobile),
    hasTouch: Boolean(mode.mobile),
  });
  const page = await contexte.newPage();
  await page.goto(mode.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);

  const info = await page.evaluate(() => ({
    hauteur: document.documentElement.scrollHeight,
    niveau: document.querySelector('[data-moteur-immersion]')?.getAttribute('data-niveau') ?? 'inconnu',
    webgl: (() => {
      const canvas = document.createElement('canvas');
      return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    })(),
  }));
  console.log(`[${mode.nom}]`, JSON.stringify(info));

  const total = info.hauteur - mode.taille.height;
  let index = 0;
  for (let y = 0; y <= total; y += PAS) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    // 300 ms entre deux images : c'est le protocole demandé.
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dossier}/${mode.nom}-${String(index).padStart(3, '0')}-y${y}.png` });
    index += 1;
  }
  console.log(`[${mode.nom}] ${index} images → ${dossier}`);
  await contexte.close();
}

await navigateur.close();
