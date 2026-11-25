/**
 * SORAHNEX — frontière HTTP de l'Edge Function `mcp-client`.
 *
 * ## Pourquoi ce module existe
 *
 * Cette logique vivait dans `index.ts`, qui importe `npm:postgres@3.4.5`. Un
 * module qui importe un schéma d'URL `npm:` n'est **pas chargeable** par
 * Vitest : la couche HTTP — plafond de corps, CORS, résolution d'identité,
 * ordre des refus, journal — restait donc la seule partie du chemin critique
 * sans aucun test. La sortir ici la rend vérifiable, sans rien changer au
 * comportement.
 *
 * `index.ts` ne fait plus que brancher l'environnement réel : base, sortie
 * réseau épinglée, identité GoTrue.
 *
 * ## CORS : les origines par défaut s'appliquent TOUJOURS
 *
 * L'implémentation précédente lisait uniquement `VYORA_ALLOWED_ORIGINS`. Cette
 * variable **n'existe pas** dans le projet : la liste était donc vide, et
 * toute requête du navigateur recevait `access-control-allow-origin: null`.
 * C'est exactement la panne déjà rencontrée sur `store-connect`. On passe
 * désormais par `buildAllowedOrigins`, qui part des valeurs par défaut du dépôt
 * et n'y ajoute que des origines supplémentaires.
 */
import { buildAllowedOrigins, resolveCorsOrigin } from '../../../src/lib/origin-allowlist.ts';
import { traiterAppelOutil, validerCorps } from './route.ts';
import type { DependancesP5 } from './execution.ts';

/** Plafond de corps, aligné sur celui annoncé par `route.ts`. */
export const MAX_CORPS = 256 * 1024;

/** Identité résolue auprès de GoTrue par l'appelant. Jamais lue du corps. */
export type ResolveurIdentite = (authorization: string) => Promise<{ userId: string } | null>;

export interface OptionsHttp {
  /** Origines supplémentaires, séparées par des virgules. Les défauts restent. */
  originesSupplementaires: string | null;
  identite: ResolveurIdentite;
  /** Journal d'erreur. Injectable pour être vérifié sans polluer la sortie. */
  journal?: (message: string, details: Record<string, unknown>) => void;
}

export function construireReponse(
  status: number,
  corps: unknown,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
  });
}

/** En-têtes CORS pour cette requête. Origine inconnue : `null`, jamais `*`. */
export function entetesCors(
  originesSupplementaires: string | null,
  origineDemandee: string | null,
): Record<string, string> {
  const autorisees = buildAllowedOrigins(originesSupplementaires);
  return {
    'access-control-allow-origin': resolveCorsOrigin(autorisees, origineDemandee),
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
}

/**
 * Traite une requête HTTP de bout en bout.
 *
 * Ordre strict, et il compte pour la sécurité : méthode, taille, forme, puis
 * identité, puis validation du corps, puis décision en base, puis réseau.
 * Aucun accès base avant que l'identité soit établie ; aucun accès réseau avant
 * que `execution.ts` ait tout revérifié.
 */
export async function traiterRequete(
  request: Request,
  deps: () => DependancesP5,
  options: OptionsHttp,
): Promise<Response> {
  const cors = entetesCors(options.originesSupplementaires, request.headers.get('origin'));

  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') {
    return construireReponse(405, { error: 'methode_non_autorisee' }, cors);
  }

  // Le plafond est vérifié sur l'en-tête déclaré ET sur le corps lu : un
  // en-tête peut mentir, la taille réelle non.
  const annonce = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(annonce) && annonce > MAX_CORPS) {
    return construireReponse(413, { error: 'corps_trop_volumineux' }, cors);
  }

  let corps: unknown;
  try {
    const texte = await request.text();
    if (texte.length > MAX_CORPS) {
      return construireReponse(413, { error: 'corps_trop_volumineux' }, cors);
    }
    corps = texte ? JSON.parse(texte) : null;
  } catch {
    return construireReponse(400, { error: 'corps_illisible' }, cors);
  }

  const identite = await options.identite(request.headers.get('authorization') ?? '');
  if (!identite) {
    return construireReponse(401, {
      error: 'authentification_requise',
      message: 'Jeton absent ou invalide.',
    }, cors);
  }

  const validation = validerCorps(corps);
  const resultat = await traiterAppelOutil({ identite, corps }, deps());

  // Journal minimal : identifiants, outil, statut. Jamais d'arguments ni de
  // secret. La validation peut échouer ; on journalise alors ce qui est connu.
  const details: Record<string, unknown> = {
    userId: identite.userId,
    serverId: validation.ok ? validation.demande.serverId : null,
    outil: validation.ok ? validation.demande.outil : null,
    status: resultat.status,
    code: typeof resultat.body.error === 'string' ? resultat.body.error : undefined,
  };
  if (resultat.status >= 400) {
    (options.journal ?? console.error)('[mcp-client] appel refusé', details);
  }

  return construireReponse(resultat.status, resultat.body, cors);
}
