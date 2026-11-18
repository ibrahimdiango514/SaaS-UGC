/**
 * VYORA — routes HTTP de gestion des connexions MCP sortantes (P6).
 *
 * ## Ordre des contrôles, et pourquoi il compte
 *
 * méthode → taille → route → **identité GoTrue** → validation → base → réseau.
 *
 * Aucune lecture en base n'a lieu avant que l'identité soit établie. Un appel
 * sans jeton valide ne peut donc ni énumérer les serveurs d'un autre compte, ni
 * provoquer un accès réseau.
 *
 * ## Le corps ne choisit jamais l'identité
 *
 * `userId` vient de `identite`, résolu auprès de GoTrue par l'appelant. Un
 * `userId` présent dans le JSON est ignoré — `validerCreation` ne le lit même
 * pas.
 *
 * ## Aucune réponse ne contient de secret
 *
 * Les serveurs sont sérialisés par `versJson`, qui est une liste blanche. Le
 * test de connexion ne renvoie qu'un état, un message et des noms d'outils.
 */
import { entetesCors, construireReponse } from './http.ts';
import {
  estCheminGestion,
  routeGestion,
  validerCible,
  validerCreation,
  validerExecution,
  validerPermission,
} from './gestion.ts';
import { executerOutilExterne, statutHttp } from './execution.ts';
import { traiterDemarrageOAuth } from './oauth-http.ts';
import { testerServeurReel, versJson, type DependancesGestion, type ServeurGere } from './gestion-serveur.ts';
import type { ResolveurIdentite } from './http.ts';

/** Plafond de corps : une création porte un secret, pas un fichier. */
const MAX_CORPS_GESTION = 64 * 1024;

export interface OptionsGestion {
  originesSupplementaires: string | null;
  identite: ResolveurIdentite;
  journal?: (message: string, details: Record<string, unknown>) => void;
}

/**
 * Traduit les exceptions des fonctions SQL en réponses lisibles.
 *
 * Les fonctions `mcp_servers_*` lèvent des codes stables (`workspace_forbidden`,
 * `server_not_found`, `server_revoked`, `secret_required`…). Les laisser
 * remonter en 500 priverait l'utilisateur de l'information, et un message SQL
 * brut pourrait révéler la structure interne.
 */
export function traduireErreurSql(message: string): { status: number; code: string; message: string } {
  const texte = String(message ?? '');
  const connus: Array<[string, number, string]> = [
    ['workspace_forbidden', 403, 'Vous n’êtes pas membre de cet espace de travail.'],
    ['server_not_found', 404, 'Connexion MCP introuvable.'],
    ['server_revoked', 409, 'Cette connexion MCP est révoquée.'],
    ['secret_required', 400, 'Ce mode d’authentification exige un secret.'],
    ['secret_not_allowed', 400, 'Aucun secret ne doit être fourni en mode « none ».'],
    ['auth_kind_invalid', 400, 'Mode d’authentification invalide.'],
    ['user_required', 400, 'Utilisateur requis.'],
  ];
  for (const [motif, status, messageLisible] of connus) {
    if (texte.includes(motif)) return { status, code: motif, message: messageLisible };
  }
  /*
   * Une panne réseau n'est PAS une panne de base.
   *
   * `tester` fait deux choses : lire/écrire en base, puis joindre un serveur
   * distant. Si la sortie réseau échoue (DNS indisponible, TLS refusé,
   * connexion tombée), annoncer « la base n'a pas pu traiter la demande »
   * envoie l'utilisateur — et nous — au mauvais endroit. On distingue donc les
   * deux, sans jamais relayer le message d'origine : il peut contenir un nom
   * d'hôte interne.
   */
  if (/dns|résolution|resolution|connect_failed|tls_failed|timeout|timed out|econn|socket|network|réseau|reseau/i.test(texte)) {
    return {
      status: 502,
      code: 'reseau_indisponible',
      message: 'Le serveur MCP n’a pas pu être joint depuis VYORA.',
    };
  }
  // Jamais de message SQL brut : il décrit le schéma interne.
  return { status: 500, code: 'erreur_base', message: 'La base n’a pas pu traiter la demande.' };
}

export async function traiterRequeteGestion(
  request: Request,
  deps: () => DependancesGestion,
  options: OptionsGestion,
): Promise<Response> {
  const cors = entetesCors(options.originesSupplementaires, request.headers.get('origin'));
  const journal = options.journal ?? console.error;

  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') {
    return construireReponse(405, { error: 'methode_non_autorisee' }, cors);
  }

  const annonce = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(annonce) && annonce > MAX_CORPS_GESTION) {
    return construireReponse(413, { error: 'corps_trop_volumineux' }, cors);
  }

  let corps: unknown = null;
  try {
    const texte = await request.text();
    if (texte.length > MAX_CORPS_GESTION) {
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

  const url = new URL(request.url);
  const route = routeGestion(url.pathname);
  if (!route) {
    return construireReponse(404, { error: 'route_inconnue', message: 'Route de gestion inconnue.' }, cors);
  }

  const base = deps().base;
  try {
    switch (route) {
      case 'lister': {
        const workspaceId = typeof (corps as Record<string, unknown> | null)?.workspaceId === 'string'
          ? (corps as Record<string, unknown>).workspaceId as string
          : undefined;
        const serveurs = await base.listerServeurs({ userId: identite.userId, ...(workspaceId ? { workspaceId } : {}) });
        return construireReponse(200, { ok: true, serveurs: serveurs.map(versJson) }, cors);
      }

      case 'creer': {
        const validation = validerCreation(corps);
        if (!validation.ok) {
          return construireReponse(validation.status, { error: validation.code, message: validation.message }, cors);
        }
        const { serverId } = await base.creerServeur({ userId: identite.userId, ...validation.demande });
        const serveur = await base.lireServeur({ userId: identite.userId, serverId });
        journal('[mcp-client] serveur créé', { userId: identite.userId, serverId });
        // On ne renvoie que la forme publique : le secret fourni ne revient pas.
        return construireReponse(201, {
          ok: true,
          serverId,
          serveur: serveur ? versJson(serveur) : null,
        }, cors);
      }

      case 'tester': {
        const validation = validerCible(corps);
        if (!validation.ok) {
          return construireReponse(validation.status, { error: validation.code, message: validation.message }, cors);
        }
        const serveur: ServeurGere | null = await base.lireServeur({
          userId: identite.userId,
          serverId: validation.demande.serverId,
        });
        if (!serveur) {
          return construireReponse(404, { error: 'server_not_found', message: 'Connexion MCP introuvable.' }, cors);
        }
        const resultat = await testerServeurReel(
          { userId: identite.userId, serverId: validation.demande.serverId, serveur },
          deps(),
        );
        journal('[mcp-client] test de connexion', {
          userId: identite.userId,
          serverId: validation.demande.serverId,
          status: resultat.status,
        });
        return construireReponse(resultat.status, resultat.body, cors);
      }

      case 'permissions': {
        const validation = validerCible(corps);
        if (!validation.ok) {
          return construireReponse(validation.status, { error: validation.code, message: validation.message }, cors);
        }
        const serveur = await base.lireServeur({
          userId: identite.userId,
          serverId: validation.demande.serverId,
        });
        if (!serveur) {
          return construireReponse(404, { error: 'server_not_found', message: 'Connexion MCP introuvable.' }, cors);
        }
        /*
         * Les outils connus viennent de la BASE, jamais du corps : sans cela, un
         * client pourrait accorder une permission pour un outil qu'il n'a jamais
         * vu, et l'appel passerait plus tard sans revue.
         */
        const noms = serveur.outils.map((o) => o.name);
        const permission = validerPermission(corps, noms);
        if (!permission.ok) {
          return construireReponse(permission.status, { error: permission.code, message: permission.message }, cors);
        }
        const fusion = await base.definirPermission({
          userId: identite.userId,
          serverId: validation.demande.serverId,
          outil: permission.demande.outil,
          etat: permission.demande.etat,
        });
        journal('[mcp-client] permission modifiée', {
          userId: identite.userId,
          serverId: validation.demande.serverId,
          outil: permission.demande.outil,
          etat: permission.demande.etat,
        });
        return construireReponse(200, { ok: true, toolPermissions: fusion }, cors);
      }

      case 'oauth-demarrer': {
        /*
         * Délégué à `oauth-http.ts` : la découverte, l'enregistrement et PKCE
         * ont leur propre module, et cette route les réutilise plutôt que de
         * les réimplémenter ici. La fonction garde la même identité GoTrue.
         */
        return traiterDemarrageOAuth(request, corps, deps, {
          originesSupplementaires: options.originesSupplementaires,
          identite: options.identite,
          ...(options.journal ? { journal: options.journal } : {}),
        });
      }

      case 'executer': {
        const validation = validerExecution(corps);
        if (!validation.ok) {
          return construireReponse(validation.status, { error: validation.code, message: validation.message }, cors);
        }
        const execution = deps().execution;
        if (!execution) {
          return construireReponse(503, {
            error: 'execution_indisponible',
            message: 'L’exécution d’outils n’est pas configurée sur ce déploiement.',
          }, cors);
        }
        /*
         * Aucune confirmation d'écriture n'est transmise ici, volontairement.
         *
         * `executerOutilExterne` exige DEUX conditions persistées/vérifiées pour
         * une écriture : une autorisation stockée en base ET une confirmation
         * pour l'appel. La base ne porte aucune colonne d'autorisation
         * d'écriture, et cette route ne relaie aucune confirmation : une
         * écriture reste donc structurellement impossible à déclencher, quoi
         * que le client envoie. Ce n'est pas un oubli, c'est la garantie.
         */
        const resultat = await executerOutilExterne(
          { serverId: validation.demande.serverId, outil: validation.demande.outil, arguments: validation.demande.arguments },
          { userId: identite.userId },
          execution,
        );

        // Journal : identifiants et issue, jamais d'arguments ni de secret.
        journal(resultat.ok ? '[mcp-client] outil exécuté' : '[mcp-client] exécution refusée', {
          userId: identite.userId,
          serverId: validation.demande.serverId,
          outil: validation.demande.outil,
          code: resultat.ok ? 'ok' : resultat.code,
        });

        if (!resultat.ok) {
          return construireReponse(
            statutHttp(String(resultat.code ?? '')),
            { error: resultat.code, message: resultat.message },
            cors,
          );
        }
        return construireReponse(200, {
          ok: true,
          outil: validation.demande.outil,
          isError: resultat.isError === true,
          contenu: resultat.contenu ?? null,
        }, cors);
      }

      case 'revoquer': {
        const validation = validerCible(corps);
        if (!validation.ok) {
          return construireReponse(validation.status, { error: validation.code, message: validation.message }, cors);
        }
        const revoque = await base.revoquer({
          userId: identite.userId,
          serverId: validation.demande.serverId,
        });
        journal('[mcp-client] révocation', {
          userId: identite.userId,
          serverId: validation.demande.serverId,
          revoque,
        });
        if (!revoque) {
          return construireReponse(404, { error: 'server_not_found', message: 'Connexion MCP introuvable.' }, cors);
        }
        return construireReponse(200, { ok: true }, cors);
      }

      default:
        return construireReponse(404, { error: 'route_inconnue' }, cors);
    }
  } catch (erreur) {
    const traduction = traduireErreurSql(erreur instanceof Error ? erreur.message : String(erreur));
    journal('[mcp-client] gestion en erreur', {
      userId: identite.userId,
      route,
      code: traduction.code,
    });
    return construireReponse(traduction.status, { error: traduction.code, message: traduction.message }, cors);
  }
}

export { estCheminGestion };
