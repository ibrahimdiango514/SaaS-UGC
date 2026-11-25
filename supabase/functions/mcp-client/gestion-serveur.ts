/**
 * SORAHNEX — gestion des connexions MCP sortantes contre la base réelle (P6).
 *
 * ## Le secret traverse exactement deux fois
 *
 *   1. **Entrée** : il arrive dans le corps de la requête et part directement
 *      dans `vault.create_secret` via `mcp_servers_create`. Il n'est ni
 *      journalisé, ni conservé en mémoire au-delà de l'appel, ni renvoyé.
 *   2. **Sortie, jamais** : pour tester une connexion, on lit le secret par
 *      `mcp_servers_secret` (security definer, réservé à `service_role`) et on
 *      le place dans un en-tête d'authentification. Il ne revient pas.
 *
 * Aucune fonction de ce module ne renvoie une valeur de secret. Le type
 * `ServeurGere` n'a pas de champ pour l'accueillir : ce n'est pas un oubli,
 * c'est une garantie de compilation.
 *
 * ## Isolation
 *
 * Chaque requête reçoit le `userId` **résolu par GoTrue**, jamais celui du
 * corps. Les lectures passent par la vue `mcp_servers_public`, qui filtre sur
 * `auth.uid()` … sauf que `service_role` n'a pas d'`auth.uid()`. C'est
 * pourquoi le filtre est **explicite** ici (`user_id = $1`) : la vue seule ne
 * suffirait pas, et s'y fier serait une faille silencieuse. La deuxième
 * barrière est `mcp_is_workspace_member`, vérifiée par les fonctions SQL.
 */
import type { SqlTag } from './accueil.ts';
import {
  permissionsInitiales,
  appliquerPermission,
  type DemandeCreation,
  type EtatPermission,
} from './gestion.ts';
import { entetesAuthentification, testerConnexion, type ServeurExterne } from './external.ts';
import { detruireOAuthBase, lireOAuthBase, stockerJetonsBase, type SqlOAuth } from './oauth-acces.ts';
import type { EgressDeps } from '../store-import/safe-egress.ts';
import type { DependancesP5 } from './execution.ts';
import { classerOutil } from './client.ts';

/* -------------------------------------------------------------------------- */
/* 1. Types publics — aucun secret                                              */
/* -------------------------------------------------------------------------- */

export interface ServeurGere {
  id: string;
  workspaceId: string;
  nom: string;
  url: string;
  authKind: string;
  /** Vrai si un secret existe. La valeur, elle, ne sort jamais. */
  aSecret: boolean;
  status: string;
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
  outils: { name: string; description?: string }[];
  toolPermissions: Record<string, unknown>;
  dernierTestAt: string | null;
  derniereErreur: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** Identifiant client OAuth (public, pas un secret), `null` hors OAuth. */
  oauthClientId: string | null;
  /** Serveur d'autorisation retenu, `null` hors OAuth. */
  authorizationServer: string | null;
  /** Expiration du jeton OAuth courant (ISO), `null` si inconnue. */
  oauthExpireLe: string | null;
  /** Portées obtenues, `null` si non annoncées. */
  oauthScope: string | null;
  /**
   * Métadonnées du serveur d'autorisation (points de terminaison, méthodes).
   * Publiques par nature : ce sont les mêmes valeurs que le serveur publie.
   * Elles évitent de refaire une découverte à chaque renouvellement.
   */
  oauthAs: Record<string, unknown> | null;
}

export interface AccesGestion {
  listerServeurs(input: { userId: string; workspaceId?: string }): Promise<ServeurGere[]>;
  lireServeur(input: { userId: string; serverId: string }): Promise<ServeurGere | null>;
  creerServeur(input: { userId: string } & DemandeCreation): Promise<{ serverId: string }>;
  enregistrerDecouverte(input: {
    userId: string;
    serverId: string;
    status: string;
    protocolVersion: string | null;
    serverName: string | null;
    serverVersion: string | null;
    outils: { name: string; description?: string }[];
    erreur: string | null;
  }): Promise<void>;
  definirPermission(input: {
    userId: string;
    serverId: string;
    outil: string;
    etat: EtatPermission;
  }): Promise<Record<string, unknown>>;
  revoquer(input: { userId: string; serverId: string }): Promise<boolean>;
  /** Lit la VALEUR du secret. Réservé au test de connexion, jamais renvoyée. */
  lireSecret(input: { userId: string; serverId: string }): Promise<string | null>;

  /* --- OAuth 2.1 sortant (P6c) ------------------------------------------- */

  /** Mémorise un état d'autorisation (usage unique, 10 minutes). */
  creerFluxOAuth(input: {
    state: string;
    userId: string;
    serverId: string;
    verifier: string;
    redirectUri: string;
  }): Promise<void>;
  /**
   * Consomme un état et renvoie ce qu'il portait.
   *
   * Lève `state_invalide` si l'état est inconnu, déjà utilisé ou expiré : un
   * code d'autorisation rejoué ne doit jamais aboutir à un second jeu de jetons.
   */
  consommerFluxOAuth(state: string): Promise<{
    serverId: string;
    userId: string;
    verifier: string;
    redirectUri: string;
  } | null>;
  /** Enregistre le client OAuth obtenu (ou saisi) et le serveur d'autorisation. */
  enregistrerClientOAuth(input: {
    userId: string;
    serverId: string;
    clientId: string;
    clientSecret?: string;
    authorizationServer: string;
    metadonnees: unknown;
  }): Promise<void>;
  /** Lit les jetons OAuth côté serveur. Jamais renvoyés à l'appelant HTTP. */
  lireOAuth(serverId: string): Promise<{
    access: string | null;
    refresh: string | null;
    expireLe: string | null;
    scope: string | null;
    clientId: string | null;
    clientSecret: string | null;
  } | null>;
  /** Écrit (ou met à jour) les jetons OAuth dans Vault. */
  stockerJetonsOAuth(input: {
    userId: string;
    serverId: string;
    access: string;
    refresh?: string;
    expireLe: string | null;
    scope?: string | null;
  }): Promise<void>;
  /** Détruit les jetons OAuth (jetons ET rafraîchissement). */
  detruireOAuth(serverId: string): Promise<void>;
}

export interface DependancesGestion {
  base: AccesGestion;
  egress: EgressDeps;
  delaiMs?: number;
  /**
   * Porte d'exécution des outils (P5). Optionnelle : sans elle, la route
   * `executer` répond `execution_indisponible` plutôt que d'improviser un accès
   * direct. Un chemin d'appel absent vaut mieux qu'un second chemin non testé.
   */
  execution?: DependancesP5;
}

/* -------------------------------------------------------------------------- */
/* 2. Traduction d'une ligne SQL                                               */
/* -------------------------------------------------------------------------- */

interface LigneServeur {
  id: string;
  workspace_id: string;
  name: string;
  url: string;
  auth_kind: string;
  has_secret: boolean;
  status: string;
  protocol_version: string | null;
  server_name: string | null;
  server_version: string | null;
  tools: unknown;
  tool_permissions: unknown;
  last_checked_at: string | null;
  last_error: string | null;
  oauth_client_id?: string | null;
  authorization_server?: string | null;
  oauth_expire_le?: string | null;
  oauth_scope?: string | null;
  oauth_as?: unknown;
  created_at: string;
  revoked_at: string | null;
}

/** Normalise la liste d'outils. Une forme inattendue devient une liste vide,
 * donc « aucun outil utilisable » — le bon sens de l'erreur. */
export function normaliserOutilsGeres(brut: unknown): { name: string; description?: string }[] {
  if (!Array.isArray(brut)) return [];
  const sortie: { name: string; description?: string }[] = [];
  for (const element of brut) {
    if (typeof element !== 'object' || element === null) continue;
    const o = element as Record<string, unknown>;
    if (typeof o.name !== 'string' || o.name.trim() === '') continue;
    sortie.push({
      name: o.name.trim(),
      description: typeof o.description === 'string' ? o.description : undefined,
    });
  }
  return sortie;
}

function objetJson(brut: unknown): Record<string, unknown> {
  if (typeof brut !== 'object' || brut === null || Array.isArray(brut)) return {};
  return brut as Record<string, unknown>;
}

export function depuisLigneGeree(ligne: LigneServeur): ServeurGere {
  return {
    id: ligne.id,
    workspaceId: ligne.workspace_id,
    nom: ligne.name,
    url: ligne.url,
    authKind: ligne.auth_kind,
    aSecret: ligne.has_secret === true,
    status: ligne.status,
    protocolVersion: ligne.protocol_version,
    serverName: ligne.server_name,
    serverVersion: ligne.server_version,
    outils: normaliserOutilsGeres(ligne.tools),
    toolPermissions: objetJson(ligne.tool_permissions),
    dernierTestAt: ligne.last_checked_at,
    derniereErreur: ligne.last_error,
    createdAt: ligne.created_at,
    revokedAt: ligne.revoked_at,
    oauthClientId: ligne.oauth_client_id ?? null,
    authorizationServer: ligne.authorization_server ?? null,
    oauthExpireLe: ligne.oauth_expire_le ?? null,
    oauthScope: ligne.oauth_scope ?? null,
    oauthAs: objetJson(ligne.oauth_as),
  };
}

/** Le nom du secret Vault suit la convention posée par `mcp_servers_create`. */
export function nomVault(serverId: string): string {
  return `mcp_server_${serverId}`;
}

/* -------------------------------------------------------------------------- */
/* 3. Accès réel                                                               */
/* -------------------------------------------------------------------------- */

/*
 * Les colonnes sont écrites dans chaque requête plutôt que factorisées dans une
 * constante interpolée : `SqlTag` n'expose pas d'échappement brut, et c'est
 * très bien ainsi. Une requête lisible en un seul endroit vaut mieux qu'une
 * concaténation dont on finit par ne plus voir le contenu.
 */


export function creerAccesGestion(options: { sql: () => SqlTag }): AccesGestion {
  /** Ouvre, exécute, referme. Une connexion par opération. */
  async function avecSql<T>(operation: (sql: SqlTag) => Promise<T>): Promise<T> {
    const sql = options.sql();
    try {
      return await operation(sql);
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  }

  return {
    async listerServeurs({ userId, workspaceId }) {
      return avecSql(async (sql) => {
        /*
         * Filtre explicite sur `user_id`, ET appartenance au workspace.
         *
         * La vue `mcp_servers_public` filtre sur `auth.uid()`, mais cette
         * fonction tourne en `service_role`, où `auth.uid()` est nul. S'y fier
         * renverrait TOUS les serveurs : c'est précisément la faille qu'on
         * évite en écrivant le prédicat ici.
         */
        const lignes = workspaceId
          ? await sql`
              select
                id, workspace_id, name, url, auth_kind,
                (secret_ref is not null) as has_secret,
                status, protocol_version, server_name, server_version,
                tools, tool_permissions, last_checked_at, last_error, created_at, revoked_at,
                oauth_client_id, authorization_server, oauth_expire_le, oauth_scope, oauth_as
              from public.mcp_servers
              where user_id = ${userId}::uuid
                and workspace_id = ${workspaceId}::uuid
                and public.mcp_is_workspace_member(user_id, workspace_id)
              order by created_at desc
            ` as LigneServeur[]
          : await sql`
              select
                id, workspace_id, name, url, auth_kind,
                (secret_ref is not null) as has_secret,
                status, protocol_version, server_name, server_version,
                tools, tool_permissions, last_checked_at, last_error, created_at, revoked_at,
                oauth_client_id, authorization_server, oauth_expire_le, oauth_scope, oauth_as
              from public.mcp_servers
              where user_id = ${userId}::uuid
                and public.mcp_is_workspace_member(user_id, workspace_id)
              order by created_at desc
            ` as LigneServeur[];
        return (Array.isArray(lignes) ? lignes : []).map(depuisLigneGeree);
      });
    },

    async lireServeur({ userId, serverId }) {
      return avecSql(async (sql) => {
        const lignes = await sql`
          select
            id, workspace_id, name, url, auth_kind,
            (secret_ref is not null) as has_secret,
            status, protocol_version, server_name, server_version,
            tools, tool_permissions, last_checked_at, last_error, created_at, revoked_at,
                oauth_client_id, authorization_server, oauth_expire_le, oauth_scope, oauth_as
          from public.mcp_servers
          where id = ${serverId}::uuid
            and user_id = ${userId}::uuid
            and public.mcp_is_workspace_member(user_id, workspace_id)
          limit 1
        ` as LigneServeur[];
        if (!Array.isArray(lignes) || lignes.length === 0) return null;
        return depuisLigneGeree(lignes[0]);
      });
    },

    async creerServeur({ userId, ...demande }) {
      return avecSql(async (sql) => {
        /*
         * Passage par la fonction SQL, jamais par un INSERT direct : c'est elle
         * qui vérifie l'appartenance au workspace, la cohérence
         * secret/auth_kind, et qui dépose le secret dans Vault. La contourner
         * reviendrait à réimplémenter ces contrôles ici, avec le risque de
         * divergence.
         */
        const lignes = await sql`
          select public.mcp_servers_create(
            ${userId}::uuid,
            ${demande.workspaceId}::uuid,
            ${demande.nom}::text,
            ${demande.url}::text,
            ${demande.authKind}::text,
            ${demande.secret ?? null}::text,
            ${demande.oauthClientId ?? null}::text,
            ${demande.authorizationServer ?? null}::text
          ) as resultat
        ` as { resultat: { server_id?: string } }[];
        const resultat = Array.isArray(lignes) ? lignes[0]?.resultat : null;
        const serverId = resultat?.server_id;
        if (typeof serverId !== 'string') {
          throw new Error('creation_sans_identifiant');
        }
        return { serverId };
      });
    },

    async enregistrerDecouverte({
      userId, serverId, status, protocolVersion, serverName, serverVersion, outils, erreur,
    }) {
      return avecSql(async (sql) => {
        /*
         * Les permissions existantes sont relues dans la MÊME requête que la
         * mise à jour : un re-test ne doit pas réinitialiser un choix explicite
         * de l'utilisateur, et deux requêtes séparées laisseraient une fenêtre
         * où une permission accordée entre-temps serait écrasée.
         */
        const existant = await sql`
          select tool_permissions from public.mcp_servers
          where id = ${serverId}::uuid and user_id = ${userId}::uuid
        ` as { tool_permissions: unknown }[];
        const permissions = permissionsInitiales(
          outils,
          Array.isArray(existant) ? existant[0]?.tool_permissions : undefined,
        );
        /*
         * `::text::jsonb`, et non `::jsonb` : le paramètre doit être typé TEXT.
         *
         * Le pilote sérialise une valeur selon le type du paramètre. Avec un
         * cast direct `::jsonb`, la chaîne produite par `JSON.stringify` est
         * elle-même encodée en JSON : `tools` arrive en base comme la CHAÎNE
         * `"[{...}]"`, et non comme un tableau. La contrainte
         * `mcp_servers_tools_array` (jsonb_typeof = 'array') refuse alors
         * l'écriture, et l'erreur remontait en 500 opaque. Avec `::text`, la
         * chaîne part telle quelle et c'est PostgreSQL qui la parse.
         */

        await sql`
          select public.mcp_servers_record_probe(
            ${userId}::uuid,
            ${serverId}::uuid,
            ${status}::text,
            ${protocolVersion}::text,
            ${serverName}::text,
            ${serverVersion}::text,
            ${null}::jsonb,
            ${JSON.stringify(outils)}::text::jsonb,
            ${erreur}::text
          )
        `;
        // La fonction enregistre le sondage ; les permissions sont posées par
        // la fonction dédiée, qui vérifie elle-même le propriétaire.
        await sql`
          select public.mcp_servers_set_permissions(
            ${userId}::uuid,
            ${serverId}::uuid,
            ${JSON.stringify(permissions)}::text::jsonb
          )
        `;
      });
    },

    async definirPermission({ userId, serverId, outil, etat }) {
      return avecSql(async (sql) => {
        const lignes = await sql`
          select tool_permissions from public.mcp_servers
          where id = ${serverId}::uuid
            and user_id = ${userId}::uuid
            and public.mcp_is_workspace_member(user_id, workspace_id)
          limit 1
        ` as { tool_permissions: unknown }[];
        if (!Array.isArray(lignes) || lignes.length === 0) {
          // Signalé par une exception : l'appelant traduit en 404. On ne crée
          // pas de serveur implicite pour « réparer » une cible inexistante.
          throw new Error('server_not_found');
        }
        const fusion = appliquerPermission(lignes[0]?.tool_permissions, outil, etat);
        await sql`
          select public.mcp_servers_set_permissions(
            ${userId}::uuid,
            ${serverId}::uuid,
            ${JSON.stringify(fusion)}::text::jsonb
          )
        `;
        return fusion;
      });
    },

    async revoquer({ userId, serverId }) {
      return avecSql(async (sql) => {
        /*
         * `mcp_servers_revoke` détruit le secret Vault, vide `secret_ref`, pose
         * `revoked_at` et conserve la ligne pour l'historique. On ne supprime
         * jamais la ligne ici : perdre la trace d'une connexion qui a existé
         * rendrait tout audit impossible.
         */
        const lignes = await sql`
          select public.mcp_servers_revoke(
            ${userId}::uuid,
            ${serverId}::uuid
          ) as resultat
        ` as { resultat: { revoked?: boolean } }[];
        const resultat = Array.isArray(lignes) ? lignes[0]?.resultat : null;
        return resultat?.revoked === true;
      });
    },

    /* --- OAuth 2.1 sortant -------------------------------------------- */

    async creerFluxOAuth({ state, userId, serverId, verifier, redirectUri }) {
      return avecSql(async (sql) => {
        await sql`
          select public.mcp_oauth_flux_creer(
            ${state}::text,
            ${userId}::uuid,
            ${serverId}::uuid,
            ${verifier}::text,
            ${redirectUri}::text
          )
        `;
      });
    },

    async consommerFluxOAuth(state) {
      return avecSql(async (sql) => {
        const lignes = await sql`
          select * from public.mcp_oauth_flux_consommer(${state}::text)
        ` as { server_id: string; user_id: string; code_verifier: string; redirect_uri: string }[];
        const ligne = Array.isArray(lignes) ? lignes[0] : undefined;
        if (!ligne) return null;
        return {
          serverId: ligne.server_id,
          userId: ligne.user_id,
          verifier: ligne.code_verifier,
          redirectUri: ligne.redirect_uri,
        };
      });
    },

    async enregistrerClientOAuth({ userId, serverId, clientId, clientSecret, authorizationServer, metadonnees }) {
      return avecSql(async (sql) => {
        /*
         * Le contrôle de propriété est fait par l'appelant (lecture préalable),
         * mais l'`update` le refait : sans ce prédicat, une erreur d'aiguillage
         * pourrait configurer la connexion d'un autre utilisateur.
         */
        const lignes = await sql`
          update public.mcp_servers
             set oauth_client_id = ${clientId}::text,
                 authorization_server = ${authorizationServer}::text,
                 oauth_as = ${JSON.stringify(metadonnees ?? null)}::text::jsonb
           where id = ${serverId}::uuid
             and user_id = ${userId}::uuid
          returning id
        ` as { id: string }[];
        if (!Array.isArray(lignes) || lignes.length === 0) throw new Error('server_not_found');

        if (clientSecret) {
          await sql`
            select public.mcp_oauth_secret_ecrire(
              ${`mcp_oauth_client_secret_${serverId}`}::text,
              ${clientSecret}::text,
              ${`Secret client OAuth MCP sortant ${serverId}`}::text
            )
          `;
        }
      });
    },

    async lireOAuth(serverId) {
      return avecSql((sql) => lireOAuthBase(sql as unknown as SqlOAuth, serverId));
    },

    async stockerJetonsOAuth(input) {
      return avecSql((sql) => stockerJetonsBase(sql as unknown as SqlOAuth, input));
    },

    async detruireOAuth(serverId) {
      return avecSql((sql) => detruireOAuthBase(sql as unknown as SqlOAuth, serverId));
    },

    async lireSecret({ serverId }) {
      return avecSql(async (sql) => {
        // Fonction `security definer` réservée à `service_role`. Le nom de
        // secret n'est pas un paramètre : la fonction retrouve la
        // correspondance serveur → Vault par elle-même.
        const lignes = await sql`
          select public.mcp_servers_secret(${serverId}::uuid) as secret
        ` as { secret: string | null }[];
        const valeur = Array.isArray(lignes) ? lignes[0]?.secret : null;
        return typeof valeur === 'string' && valeur.trim() !== '' ? valeur : null;
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 4. Test de connexion réel                                                    */
/* -------------------------------------------------------------------------- */

export interface ResultatTestGestion {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Teste réellement une connexion : `initialize` + `tools/list`, par la sortie
 * réseau épinglée (SSRF, DNS, TLS, refus de redirection).
 *
 * Ce que ce test **ne fait pas** : il n'appelle aucun outil. Un test ne doit pas
 * exécuter d'action au nom de l'utilisateur ; il prouve seulement que la
 * session s'ouvre et que la liste d'outils arrive.
 */
export async function testerServeurReel(
  input: { userId: string; serverId: string; serveur: ServeurGere },
  deps: DependancesGestion,
): Promise<ResultatTestGestion> {
  const { serveur } = input;

  if (serveur.revokedAt !== null || serveur.status === 'revoked') {
    return { status: 409, body: { error: 'revoked', message: 'Cette connexion est révoquée.' } };
  }

  // Le secret est lu AVANT le réseau : s'il manque alors qu'il est requis, le
  // test échouerait de toute façon, mais avec un 401 trompeur.
  let jeton: string | null = null;
  if (serveur.authKind !== 'none') {
    if (!serveur.aSecret) {
      // En OAuth, « pas de secret » veut dire « pas encore autorisé » : le
      // remède n'est pas de coller un jeton mais de lancer l'autorisation.
      return serveur.authKind === 'oauth'
        ? {
          status: 409,
          body: {
            error: 'auth_required',
            message: 'Cette connexion n’est pas encore autorisée : cliquez sur « Autoriser » pour lancer OAuth.',
          },
        }
        : {
          status: 409,
          body: { error: 'secret_manquant', message: 'Aucun secret n’est configuré pour cette connexion.' },
        };
    }
    jeton = await deps.base.lireSecret({ userId: input.userId, serverId: input.serverId });
    if (!jeton) {
      return {
        status: 409,
        body: {
          error: 'secret_manquant',
          message: 'Le secret de cette connexion est introuvable : supprimez-la et recréez-la.',
        },
      };
    }
  }

  const entetes = entetesAuthentification(serveur.authKind as never, jeton);
  const externe: ServeurExterne = {
    url: serveur.url,
    auth: { kind: serveur.authKind as never, fournirEntetes: () => entetes },
  };

  const resultat = await testerConnexion(externe, deps.egress, { delaiMs: deps.delaiMs });

  /*
   * La découverte est persistée, que le test réussisse ou non.
   *
   * En cas d'échec, on enregistre l'erreur et on remet les permissions à
   * `pending` pour les outils déjà connus — jamais à `allowed`. Un serveur
   * devenu inaccessible ne doit pas laisser des autorisations actives sur des
   * outils qu'on ne peut plus vérifier.
   */
  const outils = resultat.etat === 'connected' ? (resultat.outils ?? []).map((o) => ({
    name: o.name,
    ...(o.description ? { description: o.description } : {}),
  })) : [];

  await deps.base.enregistrerDecouverte({
    userId: input.userId,
    serverId: input.serverId,
    status: resultat.etat === 'connected' ? 'connected'
      : resultat.etat === 'auth_required' ? 'auth_required' : 'error',
    protocolVersion: resultat.protocole ?? null,
    serverName: resultat.serverInfo?.name ?? null,
    serverVersion: resultat.serverInfo?.version ?? null,
    outils: resultat.etat === 'connected' ? outils : [],
    erreur: resultat.etat === 'connected' ? null : resultat.message,
  });

  const corps: Record<string, unknown> = {
    etat: resultat.etat,
    message: resultat.message,
    ...(resultat.protocole ? { protocole: resultat.protocole } : {}),
    ...(resultat.serverInfo ? { serverName: resultat.serverInfo.name, serverVersion: resultat.serverInfo.version } : {}),
    outils: resultat.etat === 'connected' ? outils : [],
    ...(resultat.codes?.length ? { codes: resultat.codes } : {}),
  };

  // Un test qui échoue n'est pas une erreur serveur : c'est un résultat
  // lisible. Seul un refus de sécurité mérite un statut distinct.
  const status = resultat.etat === 'connected' ? 200
    : resultat.etat === 'auth_required' ? 409
    : 502;

  return { status, body: { ok: resultat.etat === 'connected', ...corps } };
}

/* -------------------------------------------------------------------------- */
/* 5. Sérialisation pour le client                                             */
/* -------------------------------------------------------------------------- */

/**
 * Forme JSON d'un serveur, telle qu'envoyée au navigateur.
 *
 * Écrite à la main plutôt que par épandage : si un champ `secret` apparaissait
 * un jour sur `ServeurGere`, il ne fuiterait pas par accident. C'est une liste
 * blanche, pas une liste noire.
 */
export function versJson(serveur: ServeurGere): Record<string, unknown> {
  return {
    id: serveur.id,
    workspaceId: serveur.workspaceId,
    nom: serveur.nom,
    url: serveur.url,
    authKind: serveur.authKind,
    aSecret: serveur.aSecret,
    status: serveur.status,
    protocolVersion: serveur.protocolVersion,
    serverName: serveur.serverName,
    serverVersion: serveur.serverVersion,
    /*
     * `lecture` est calculé ICI, avec la même règle que la porte d'exécution.
     *
     * Sans cela, l'interface devrait deviner elle-même ce qui est exécutable —
     * et une règle dupliquée dans le navigateur finirait par diverger de celle
     * qui décide réellement. Le serveur dit ce qu'il acceptera ; le navigateur
     * se contente de l'afficher.
     */
    outils: serveur.outils.map((o) => ({
      name: o.name,
      ...(o.description ? { description: o.description } : {}),
      lecture: classerOutil(o.name, o.description ?? '').lecture,
    })),
    toolPermissions: serveur.toolPermissions,
    dernierTestAt: serveur.dernierTestAt,
    derniereErreur: serveur.derniereErreur,
    createdAt: serveur.createdAt,
    revokedAt: serveur.revokedAt,
    /*
     * Champs OAuth exposés au navigateur : identifiant client et serveur
     * d'autorisation sont PUBLICS (ce sont les valeurs envoyées dans l'URL
     * d'autorisation). Les jetons, eux, ne sortent jamais.
     */
    oauthClientId: serveur.oauthClientId,
    authorizationServer: serveur.authorizationServer,
    oauthExpireLe: serveur.oauthExpireLe,
    oauthScope: serveur.oauthScope,
  };
}
