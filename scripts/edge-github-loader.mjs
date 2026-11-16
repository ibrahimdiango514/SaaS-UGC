/**
 * Générateur de chargeur Edge « GitHub épinglé » — source unique.
 *
 * ## Pourquoi ce fichier existe
 * `business-grow` et `store-import` sont tous deux déployés par un chargeur
 * court qui télécharge son bundle depuis un commit précis du dépôt public.
 * Ce mécanisme était dupliqué, et les deux copies avaient divergé : l'une
 * retirait le saut de ligne final avant de calculer l'empreinte, l'autre non,
 * et les fichiers du dépôt (`loader.ts`, `bootstrap.ts`) décrivaient encore
 * l'ancien modèle « artefact en base », qui n'est plus celui de la production.
 *
 * Résultat concret de cette dérive : le dépôt mentait sur ce qui tourne. Un
 * futur `npm run build` aurait réécrit un chargeur vers un artefact
 * inexistant, et la fonction serait tombée en panne sans que personne n'ait
 * touché au code métier.
 *
 * ## Le contrat, en une phrase
 * On télécharge exactement le fichier committé, on vérifie sa taille **en
 * caractères** puis son empreinte SHA-256 sur ses octets UTF-8, et on ne
 * l'exécute que si les deux correspondent. Sinon : 503 explicite.
 *
 * ## Ce qui est délibérément interdit
 * - Épingler une branche (`main`, `develop`) : son contenu change.
 * - Retirer le saut de ligne final : l'empreinte porterait sur autre chose
 *   que le fichier committé.
 * - Exécuter un code partiel ou vide.
 */

/** Nom du dépôt public qui sert le bundle. */
export const GITHUB_REPO = 'ibrahimdiango514/SaaS-UGC';

/** Commit épinglé à 40 hexadécimaux, ou rien. */
export function validerCommit(commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit.trim().toLowerCase())) {
    throw new Error('un SHA de commit complet (40 hexadécimaux) est requis pour épingler le bundle');
  }
  const normalise = commit.trim().toLowerCase();
  if (['main', 'develop', 'master', 'head'].includes(normalise)) {
    throw new Error('une branche mouvante ne peut pas être épinglée');
  }
  return normalise;
}

export function validerEmpreinte(sha256) {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('une empreinte SHA-256 de 64 hexadécimaux est requise');
  }
  return sha256;
}

/**
 * Chemin du bundle dans le dépôt, tel qu'il sera téléchargé.
 * Séparé du nom de fonction pour que le chargeur reste lisible.
 */
function nomDeFichier(path) {
  return String(path).split('/').pop();
}

/**
 * Produit le texte exact du chargeur.
 *
 * @param {object} options
 * @param {'business-grow'|'store-import'} options.fonction
 * @param {string} options.path chemin du bundle dans le dépôt
 * @param {string} options.sha256 empreinte du bundle (UTF-8)
 * @param {number} options.chars longueur du bundle en caractères
 * @param {string} options.commit commit épinglé (40 hex)
 * @param {string} [options.repo]
 * @param {string} [options.chargeur] nom du réglage global fourni au bundle
 * @param {string} [options.codeIndisponible] code d'erreur servi en cas d'échec
 */
export function renderGithubLoader({
  fonction,
  path,
  sha256,
  chars,
  commit,
  repo = GITHUB_REPO,
  chargeur = '__edgePostgres',
  codeIndisponible = `${String(fonction).toUpperCase().replace(/-/g, '_')}_ARTIFACT_UNAVAILABLE`,
}) {
  const pin = validerCommit(commit);
  const empreinte = validerEmpreinte(sha256);
  if (!Number.isInteger(chars) || chars <= 0) {
    throw new Error('la taille du bundle doit être un entier positif');
  }
  const fichier = nomDeFichier(path);

  return [
    `// ${fonction} — chargeur épinglé sur un commit du dépôt public.`,
    '//',
    '// Le code métier est le bundle du dépôt, lu à un commit PRÉCIS (jamais `main`',
    '// ni une branche mouvante) : une URL contenant un SHA de commit ne peut pas',
    '// changer de contenu, et la taille + l\'empreinte SHA-256 sont vérifiées avant',
    '// toute exécution. Un bundle absent, tronqué, reformaté ou modifié n\'est',
    '// JAMAIS exécuté.',
    '//',
    `// Épinglé sur ${fichier} (${chars} caractères).`,
    '//',
    '// Généré par scripts/edge-github-loader.mjs : ne pas éditer à la main.',
    'import postgres from "npm:postgres@3.4.5";',
    '',
    `const REPO = "${repo}";`,
    `const COMMIT = "${pin}";`,
    `const PATH = "${path}";`,
    `const ARTIFACT_SHA256 = "${empreinte}";`,
    `const ARTIFACT_CHARS = ${chars};`,
    '',
    '// Le fichier est comparé TEL QUEL, saut de ligne final compris : l\'empreinte',
    '// porte sur le fichier tel qu\'il est committé.',
    'async function charger(): Promise<string> {',
    '  const urls = [',
    '    "https://raw.githubusercontent.com/" + REPO + "/" + COMMIT + "/" + PATH,',
    '    "https://api.github.com/repos/" + REPO + "/contents/" + PATH + "?ref=" + COMMIT,',
    '  ];',
    '  const echecs: string[] = [];',
    '  for (const url of urls) {',
    '    try {',
    '      const res = await fetch(url, {',
    '        headers: url.startsWith("https://api.github.com/")',
    '          ? { accept: "application/vnd.github.raw+json" }',
    '          : {},',
    '        signal: AbortSignal.timeout(15000),',
    '      });',
    '      if (!res.ok) { echecs.push("http_" + res.status); continue; }',
    '      const source = await res.text();',
    '      if (source.length !== ARTIFACT_CHARS) { echecs.push("taille_" + source.length); continue; }',
    '      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));',
    '      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");',
    '      if (hex !== ARTIFACT_SHA256) { echecs.push("empreinte_" + hex.slice(0, 8)); continue; }',
    '      return source;',
    '    } catch (error) {',
    '      echecs.push(error instanceof Error ? error.name : "reseau");',
    '    }',
    '  }',
    '  throw new Error(echecs.join(","));',
    '}',
    '',
    'let CODE = "";',
    'let failure = "";',
    '// Trois tentatives : une lecture ratée à froid ne doit pas figer l\'instance.',
    'for (let essai = 1; essai <= 3 && !CODE; essai++) {',
    '  try {',
    '    CODE = await charger();',
    '    failure = "";',
    '  } catch (error) {',
    '    failure = error instanceof Error ? error.message : String(error);',
    '    if (essai < 3) await new Promise((r) => setTimeout(r, 400 * essai));',
    '  }',
    '}',
    '',
    'if (CODE) {',
    `  (globalThis as { ${chargeur}?: typeof postgres }).${chargeur} = postgres;`,
    '  new Function(CODE)();',
    '} else {',
    '  // Panne explicite et lisible, jamais un accès ouvert ni un 500 opaque.',
    '  console.error("' + fonction + ' artifact load failed: " + failure);',
    '  const headers = {',
    '    "Content-Type": "application/json",',
    '    "Access-Control-Allow-Origin": "*",',
    '    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",',
    '    "Access-Control-Allow-Methods": "POST, OPTIONS",',
    '  };',
    '  const body = JSON.stringify({',
    '    error: {',
    `      code: "${codeIndisponible}",`,
    `      message: "${messageIndisponible(fonction, codeIndisponible)}",`,
    '    },',
    '  });',
    '  Deno.serve((request: Request) =>',
    '    request.method === "OPTIONS"',
    '      ? new Response("ok", { headers })',
    '      : new Response(body, { status: 503, headers })',
    '  );',
    '}',
    '',
  ].join('\n');
}

function messageIndisponible(fonction, code) {
  return fonction === 'store-import'
    ? "Le service d'import n'a pas pu démarrer son code (artifact_load_failed). Réessayez dans un instant."
    : "Le service Business Grow n'a pas pu charger son code.";
}

/** Marqueurs qu'un chargeur de production ne doit jamais contenir. */
export const MARQUEURS_INTERDITS = [
  { motif: /__[A-Z][A-Z0-9_]*__/, raison: 'placeholder du type __VALEUR__' },
  { motif: /\bPLACEHOLDER\b/i, raison: 'placeholder explicite' },
  { motif: /\bTODO\b/, raison: 'travail inachevé' },
  { motif: /\bFIXME\b/, raison: 'travail inachevé' },
  { motif: /\/blob\/main\//, raison: 'référence à une branche mouvante' },
  { motif: /raw\.githubusercontent\.com[^"]*\/(main|develop|master)\//, raison: 'URL épinglée sur une branche' },
];

/**
 * Vérifie qu'un chargeur généré respecte le contrat.
 * Retourne la liste des problèmes ; vide signifie conforme.
 */
export function verifierChargeur(texte) {
  const problemes = [];
  for (const { motif, raison } of MARQUEURS_INTERDITS) {
    if (motif.test(texte)) problemes.push(raison);
  }
  // L'ordre des contrôles est une garantie de sécurité, pas un détail de style :
  // exécuter avant de vérifier reviendrait à faire confiance au réseau.
  const taille = texte.indexOf('source.length !== ARTIFACT_CHARS');
  const empreinte = texte.indexOf('hex !== ARTIFACT_SHA256');
  const execution = texte.indexOf('new Function(CODE)()');
  if (taille < 0) problemes.push('contrôle de taille absent');
  if (empreinte < 0) problemes.push('contrôle d\'empreinte absent');
  if (execution < 0) problemes.push('exécution absente');
  if (taille >= 0 && empreinte >= 0 && empreinte < taille) problemes.push('empreinte vérifiée avant la taille');
  if (empreinte >= 0 && execution >= 0 && execution < empreinte) problemes.push('code exécuté avant vérification de l\'empreinte');
  if (!/if \(CODE\) \{/.test(texte)) problemes.push('pas de branchement fail-closed');
  if (!/status: 503/.test(texte)) problemes.push('pas de réponse 503 en cas d\'échec');
  return problemes;
}
