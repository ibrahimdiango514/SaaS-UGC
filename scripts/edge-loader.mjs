/**
 * Chargeur de l'artefact Edge `reelora-video`.
 *
 * ## Contexte réel
 * Le canal de déploiement disponible (connecteur Supabase) écrit le champ
 * `body` de la fonction, mais ne transmet de façon fiable que des charges
 * courtes : au-delà de ~5 Ko, le contenu est tronqué — ce qui a réellement
 * produit un `BOOT_ERROR` en production lors d'un premier essai. Un artefact
 * de 43 Ko ne peut donc pas être écrit directement.
 *
 * ## Solution
 * L'artefact complet est stocké par tranches gzip+base64 dans
 * `public._edge_deploy_artifact` (empreinte SHA-256 vérifiée en base), et la
 * fonction déployée contient un chargeur court qui, à froid :
 *   1. relit et concatène les tranches ;
 *   2. décompresse et contrôle la taille attendue ;
 *   3. évalue le code via `new Function` en masquant le bloc `export{}` ;
 *   4. renvoie le handler `(request) => Promise<Response>`.
 *
 * Ce module ne duplique aucune logique métier : il charge le code livré dans
 * le dépôt. `tests/edge-loader.test.ts` prouve que le handler obtenu est bien
 * celui du bundle et qu'il répond à l'identique.
 *
 * Fichier volontairement en JavaScript : il est évalué tel quel en production.
 */

/**
 * Extrait les correspondances `local as exported` du bloc final `export{…}`.
 * @param {string} source
 * @returns {Array<{local: string, exported: string}>}
 */
export function parseExports(source) {
  const match = source.match(/export\{([^}]*)\};?\s*$/);
  if (!match) throw new Error('bloc export introuvable dans l’artefact');
  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const pair = entry.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      return pair ? { local: pair[1], exported: pair[2] } : { local: entry, exported: entry };
    });
}

/**
 * Transforme un artefact ESM minifié en script évaluable qui renvoie ses
 * exports. Ne modifie aucun code métier : seul le bloc `export{}` est remplacé
 * par un `return`, et l'auto-serve Deno inliné est neutralisé (la plateforme
 * Edge sert déjà la fonction).
 * @param {string} source
 * @returns {{code: string, exports: string[]}}
 */
export function prepareArtifact(source) {
  const stripped = source.replace(/^\/\* VYORA-EDGE-SHA256:[0-9a-f]{12}[^\n]*\n/, '');
  const pairs = parseExports(stripped);
  const match = stripped.match(/export\{([^}]*)\};?\s*$/);
  const body = stripped.slice(0, match.index);
  const cleaned = body.replace(/(\w+)\.Deno\?\.serve&&\1\.Deno\.serve\((\w+)\);?\s*$/, '');
  if (/\bDeno\.serve\(/.test(cleaned)) throw new Error('auto-serve résiduel dans l’artefact');
  const returned = pairs.map((p) => `${p.exported}:${p.local}`).join(',');
  return { code: `${cleaned}\nreturn {${returned}};`, exports: pairs.map((p) => p.exported) };
}

/**
 * Évalue un artefact et renvoie ses exports (dont `handler`).
 * @param {string} source
 * @returns {{handler: (request: Request) => Promise<Response>, [key: string]: unknown}}
 */
export function loadArtifact(source) {
  const { code } = prepareArtifact(source);
  // eslint-disable-next-line no-new-func
  const module = new Function(code)();
  if (typeof module.handler !== 'function') throw new Error('handler absent de l’artefact');
  return module;
}
