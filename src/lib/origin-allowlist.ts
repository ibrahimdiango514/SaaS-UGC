/**
 * Origines autorisées pour les Edge Functions de l'importateur.
 *
 * ## Pourquoi ce module existe
 * `store-import` et `store-connect` sont appelées par la même application, mais
 * chacune tenait sa propre liste. Celle de `store-connect` était alimentée par
 * une seule variable d'environnement, vide en production : toutes les requêtes
 * du navigateur recevaient `access-control-allow-origin: null`, donc étaient
 * bloquées. Le connecteur fonctionnait en test et échouait dans l'application.
 *
 * ## Ce que « autorisé » veut dire
 * CORS n'est **pas** la frontière d'authentification : chaque requête porte un
 * JWT vérifié côté serveur. La liste empêche seulement qu'une page tierce
 * fasse lire une réponse à un navigateur ; un appel direct sans jeton reste
 * refusé par la garde d'authentification.
 *
 * ## Motifs
 * `https://deploy-preview-*--saas-ugc-growth.netlify.app` et
 * `https://*.e2b.app` ne peuvent pas être comparés par égalité : les comparer
 * ainsi ne correspondait jamais à rien. Le `*` est donc un joker (un ou
 * plusieurs caractères, jamais vide), et le reste de l'origine doit
 * correspondre exactement — pas de correspondance partielle silencieuse.
 */

/**
 * Origines par défaut : l'application publiée, ses prévisualisations Netlify et
 * les environnements de prévisualisation e2b, plus le développement local.
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'https://vyora-ugc.netlify.app',
  'https://saas-ugc-growth.netlify.app',
  'https://deploy-preview-*--saas-ugc-growth.netlify.app',
  'https://deploy-preview-*--vyora.netlify.app',
  'https://reelora.netlify.app',
  'https://*.e2b.app',
];

/**
 * Construit la liste effective : valeurs par défaut, puis origines
 * supplémentaires fournies par la configuration (séparées par des virgules).
 *
 * Les doublons sont retirés : une origine en double dans l'en-tête `vary` ou
 * dans un journal ne sert à rien et brouille la lecture.
 */
export function buildAllowedOrigins(extra: string | null | undefined): string[] {
  const supplementaires = String(extra ?? '')
    .split(',')
    .map((origine) => origine.trim())
    .filter(Boolean);
  return [...DEFAULT_ALLOWED_ORIGINS, ...supplementaires]
    .filter((origine, index, toutes) => toutes.indexOf(origine) === index);
}

/** Une origine correspond-elle à un motif (avec `*` comme joker) ? */
export function matchesOrigin(pattern: string, origin: string): boolean {
  if (!pattern || !origin) return false;
  if (pattern === origin) return true;
  if (!pattern.includes('*')) return false;
  // `*` = un ou plusieurs caractères. `.*` accepterait aussi le vide, ce qui
  // ferait correspondre `https://*.e2b.app` à `https://.e2b.app` — une origine
  // qui n'existe pas, mais autant ne pas l'admettre.
  const motif = `^${pattern.split('*').map(echapperRegex).join('.+')}$`;
  return new RegExp(motif, 'i').test(origin);
}

/**
 * Origine à renvoyer dans `access-control-allow-origin`.
 *
 * Origine inconnue : `null` (littéral), jamais `*`. Renvoyer `*` laisserait
 * n'importe quelle page lire la réponse ; `null` bloque le navigateur sans
 * élargir le droit.
 */
export function resolveCorsOrigin(allowed: readonly string[], origin: string | null): string {
  if (!origin) return 'null';
  return allowed.some((motif) => matchesOrigin(motif, origin)) ? origin : 'null';
}

/** Caractères spéciaux neutralisés avant de construire une expression. */
function echapperRegex(valeur: string): string {
  return valeur.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
