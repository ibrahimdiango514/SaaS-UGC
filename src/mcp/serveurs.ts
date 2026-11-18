/**
 * VYORA — serveurs MCP SORTANTS, vu de l'application.
 *
 * ## Sortant ≠ entrant
 *
 * `src/mcp/api.ts` gère le MCP **entrant** : VYORA est le serveur, l'utilisateur
 * connecte Claude ou Cursor. Ce module-ci fait l'inverse : l'utilisateur
 * connecte SES serveurs MCP distants, et VYORA les appelle.
 *
 * ## Ce module ne voit jamais un secret
 *
 * Il en **envoie** un, une fois, à la création. Il n'en reçoit jamais : la
 * réponse ne contient qu'un booléen `aSecret`. Aucun `localStorage`, aucun état
 * global, aucun journal — le secret est remis à l'appelant qui le passe
 * directement au réseau puis l'oublie.
 *
 * ## Toute la décision est côté serveur
 *
 * Les permissions sont vérifiées à chaque appel par `execution.ts`, qui relit la
 * base. Ce module ne fait qu'afficher et demander ; il ne peut pas élargir une
 * autorisation, et une permission accordée ici ne suffit jamais à elle seule.
 */
import { supabase } from '../lib/supabase';

/** Réponse d'erreur des routes de gestion, telle que le serveur la produit. */
export class ErreurGestion extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ErreurGestion';
    this.code = code;
    this.status = status;
  }
}

export type ModeAuth = 'none' | 'bearer' | 'api_key' | 'oauth';

export interface ServeurMcp {
  id: string;
  workspaceId: string;
  nom: string;
  url: string;
  authKind: ModeAuth | string;
  /** Vrai si un secret existe. Sa valeur n'est jamais transmise. */
  aSecret: boolean;
  status: string;
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
  /**
   * `lecture` est calculé par le SERVEUR (même règle que la porte d'exécution).
   * Facultatif parce qu'une réponse ancienne peut ne pas le porter : dans ce
   * cas l'écran n'affiche pas de bouton « Exécuter » plutôt que de deviner.
   */
  outils: { name: string; description?: string; lecture?: boolean }[];
  toolPermissions: Record<string, unknown>;
  dernierTestAt: string | null;
  derniereErreur: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** Identifiant client OAuth (public), `null` hors OAuth. */
  oauthClientId?: string | null;
  /** Serveur d'autorisation retenu, `null` hors OAuth. */
  authorizationServer?: string | null;
  /** Expiration du jeton OAuth courant, ISO. */
  oauthExpireLe?: string | null;
  /** Portées obtenues. */
  oauthScope?: string | null;
}

/** Ce que le serveur renvoie quand on prépare une autorisation OAuth. */
export interface DemarrageOAuth {
  autorisationUrl: string;
  state: string;
  serveurAutorisation: string;
  portees: string[] | null;
  clientEnregistre: boolean;
  /**
   * Faux quand le serveur n'a pas ANNONCÉ S256 dans ses métadonnées. La
   * demande part quand même (beaucoup de serveurs l'omettent et l'exigent),
   * mais l'écran doit le dire : ce n'est pas une vérification.
   */
  pkceAnnonce: boolean;
  /** URL de retour effectivement enregistrée chez le fournisseur (publique). */
  redirectUri?: string;
}

export interface RevocationOAuth {
  ok: boolean;
  /**
   * Ce que le fournisseur a fait : `revoque` (RFC 7009 accepté), `refuse`
   * (il a répondu non : nos jetons sont détruits mais il peut les croire
   * valides), `indisponible` (pas de point de révocation), `aucun_jeton`.
   */
  distant: 'revoque' | 'refuse' | 'indisponible' | 'aucun_jeton';
  detailDistant?: string;
  jetonsDetruits: number;
  status: 'auth_required';
}

export interface ResultatTest {
  ok: boolean;
  etat: string;
  message: string;
  protocole?: string;
  serverName?: string;
  serverVersion?: string;
  /**
   * `lecture` est calculé par le SERVEUR (même règle que la porte d'exécution).
   * Facultatif parce qu'une réponse ancienne peut ne pas le porter : dans ce
   * cas l'écran n'affiche pas de bouton « Exécuter » plutôt que de deviner.
   */
  outils: { name: string; description?: string; lecture?: boolean }[];
  codes?: string[];
}

/** Base des routes de gestion : `/functions/v1/mcp-client/gestion`. */
function urlGestion(route: string): string {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined);
  return `${base ?? ''}/functions/v1/mcp-client/gestion/${route}`;
}

/**
 * Appel brut, avec la session courante.
 *
 * `supabase.functions.invoke` ne sait pas viser un sous-chemin : on passe donc
 * par `fetch` avec le jeton de session. Le jeton est celui de GoTrue, et le
 * serveur le revérifie auprès de GoTrue — il ne fait pas confiance à sa
 * présence.
 */
async function appeler<T>(route: string, corps: unknown): Promise<T> {
  const { data: session } = await supabase.auth.getSession();
  const jeton = session.session?.access_token;
  if (!jeton) {
    throw new ErreurGestion('Vous devez être connecté.', 'non_authentifie', 401);
  }

  let reponse: Response;
  try {
    reponse = await fetch(urlGestion(route), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jeton}`,
        apikey: (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)
          ?? 'sb_publishable_utbZhw8dg-2M1-g0nXIhfA_n6dZCDZz',
      },
      body: JSON.stringify(corps ?? {}),
    });
  } catch {
    throw new ErreurGestion(
      'Impossible de joindre le service. Vérifiez votre connexion.',
      'reseau',
      0,
    );
  }

  let charge: unknown = null;
  try {
    charge = await reponse.json();
  } catch {
    /* corps non JSON : on retombe sur le statut seul */
  }
  const obj = (charge ?? {}) as Record<string, unknown>;

  if (!reponse.ok) {
    const message = typeof obj.message === 'string'
      ? obj.message
      : 'Le service a refusé la demande.';
    const code = typeof obj.error === 'string' ? obj.error : 'erreur';
    throw new ErreurGestion(message, code, reponse.status);
  }
  return charge as T;
}

/**
 * Prépare une autorisation OAuth et renvoie l'URL vers laquelle envoyer
 * l'utilisateur.
 *
 * Ce module ne reçoit AUCUN jeton : la réponse ne contient qu'une URL, un état
 * et des métadonnées publiques. Les jetons sont échangés côté serveur, lors du
 * retour du navigateur, et rangés dans Vault.
 */
export async function demarrerOAuth(serverId: string): Promise<DemarrageOAuth> {
  return appeler<DemarrageOAuth>('oauth-demarrer', { serverId });
}

/** Liste les serveurs de l'utilisateur connecté. */
export async function listerServeurs(): Promise<ServeurMcp[]> {
  const r = await appeler<{ serveurs?: ServeurMcp[] }>('lister', {});
  return Array.isArray(r?.serveurs) ? r.serveurs : [];
}

export interface CreationServeur {
  workspaceId: string;
  nom: string;
  url: string;
  authKind: ModeAuth;
  /** Transmis une fois, puis oublié. Jamais renvoyé par le serveur. */
  secret?: string;
  oauthClientId?: string;
  authorizationServer?: string;
}

/** Crée un serveur. Le secret part dans Vault côté serveur ; il ne revient pas. */
export async function creerServeur(entree: CreationServeur): Promise<{ serverId: string; serveur: ServeurMcp | null }> {
  const r = await appeler<{ serverId: string; serveur: ServeurMcp | null }>('creer', entree);
  return { serverId: r.serverId, serveur: r.serveur ?? null };
}

/**
 * Teste réellement une connexion : `initialize` + `tools/list` par la sortie
 * réseau épinglée. N'exécute aucun outil.
 */
export async function testerConnexion(serverId: string): Promise<ResultatTest> {
  return appeler<ResultatTest>('tester', { serverId });
}

/** Accorde ou refuse un outil. `pending` n'est pas acceptable en entrée. */
export async function definirPermission(
  serverId: string,
  outil: string,
  etat: 'allowed' | 'denied',
): Promise<Record<string, unknown>> {
  const r = await appeler<{ toolPermissions?: Record<string, unknown> }>('permissions', {
    serverId,
    outil,
    etat,
  });
  return r?.toolPermissions ?? {};
}

export interface ResultatExecution {
  ok: boolean;
  outil: string;
  /** `true` si le SERVEUR distant a signalé une erreur dans son résultat. */
  isError: boolean;
  /**
   * Charge utile brute du serveur distant, telle quelle. On ne la transforme
   * pas ici : c'est la donnée de l'utilisateur, pas la nôtre.
   */
  contenu: unknown;
}

/**
 * Exécute un outil réellement, sur le serveur distant.
 *
 * Aucune autorisation n'est envoyée : le serveur relit la permission en base et
 * refuse avant tout appel réseau. Cette fonction ne peut donc pas élargir un
 * droit, seulement demander une exécution déjà permise.
 */
export async function executerOutil(
  serverId: string,
  outil: string,
  args: Record<string, unknown> = {},
): Promise<ResultatExecution> {
  return appeler<ResultatExecution>('executer', { serverId, outil, arguments: args });
}

/**
 * Extrait le texte affichable d'une réponse `tools/call`.
 *
 * MCP renvoie une liste de blocs `{ type, text }`. On n'affiche que le texte —
 * pas de HTML, pas de rendu de balisage — et on plafonne la taille pour ne pas
 * figer l'écran avec une réponse de plusieurs mégaoctets.
 */
export function texteDuContenu(contenu: unknown, max = 4_000): string {
  const blocs = Array.isArray(contenu) ? contenu : [];
  const morceaux = blocs
    .map((bloc) => {
      if (typeof bloc === 'string') return bloc;
      if (bloc && typeof bloc === 'object' && typeof (bloc as { text?: unknown }).text === 'string') {
        return (bloc as { text: string }).text;
      }
      return '';
    })
    .filter(Boolean);
  const texte = morceaux.length > 0 ? morceaux.join('\n\n') : JSON.stringify(contenu ?? null, null, 2);
  return texte.length > max ? `${texte.slice(0, max)}\n… (tronqué)` : texte;
}

/** Révoque : le secret est détruit côté serveur, la ligne reste (historique). */
export async function revoquerServeur(serverId: string): Promise<void> {
  await appeler<{ ok: boolean }>('revoquer', { serverId });
}

/**
 * Retire l'accès OAuth : révocation chez le fournisseur quand il le permet,
 * destruction des jetons locaux dans tous les cas. La connexion repasse en
 * `auth_required` et peut être réautorisée ; elle n'est pas supprimée.
 */
export async function revoquerOAuth(serverId: string): Promise<RevocationOAuth> {
  return appeler<RevocationOAuth>('oauth-revoquer', { serverId });
}

/* -------------------------------------------------------------------------- */
/* Présentation                                                                 */
/* -------------------------------------------------------------------------- */

export const LIBELLES_AUTH: Record<string, string> = {
  none: 'Aucune',
  bearer: 'Jeton Bearer',
  api_key: 'Clé d’API',
  oauth: 'OAuth',
};

export const LIBELLES_ETAT: Record<string, { libelle: string; ton: 'ok' | 'attention' | 'erreur' | 'neutre' }> = {
  connected: { libelle: 'Connecté', ton: 'ok' },
  auth_required: { libelle: 'Authentification refusée', ton: 'attention' },
  error: { libelle: 'Erreur', ton: 'erreur' },
  unknown: { libelle: 'Jamais testé', ton: 'neutre' },
  revoked: { libelle: 'Révoqué', ton: 'erreur' },
};

/** État lisible d'une permission. `pending` = jamais accordé. */
export function etatPermission(valeur: unknown): 'allowed' | 'denied' | 'pending' {
  return valeur === 'allowed' || valeur === 'denied' ? valeur : 'pending';
}
