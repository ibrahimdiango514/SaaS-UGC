/**
 * VYORA — gestion des connexions MCP sortantes contre la base réelle (P6).
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
import type { EgressDeps } from '../store-import/safe-egress.ts';

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
}

export interface DependancesGestion {
  base: AccesGestion;
  egress: EgressDeps;
  delaiMs?: number;
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
                tools, tool_permissions, last_checked_at, last_error, created_at, revoked_at
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
                tools, tool_permissions, last_checked_at, last_error, created_at, revoked_at
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
            tools, tool_permissions, last_checked_at, last_error, created_at, revoked_at
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

        await sql`
          select public.mcp_servers_record_probe(
            ${userId}::uuid,
            ${serverId}::uuid,
            ${status}::text,
            ${protocolVersion}::text,
            ${serverName}::text,
            ${serverVersion}::text,
            ${null}::jsonb,
            ${JSON.stringify(outils)}::jsonb,
            ${erreur}::text
          )
        `;
        // La fonction enregistre le sondage ; les permissions sont posées par
        // la fonction dédiée, qui vérifie elle-même le propriétaire.
        await sql`
          select public.mcp_servers_set_permissions(
            ${userId}::uuid,
            ${serverId}::uuid,
            ${JSON.stringify(permissions)}::jsonb
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
            ${JSON.stringify(fusion)}::jsonb
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
      return {
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
    outils: serveur.outils,
    toolPermissions: serveur.toolPermissions,
    dernierTestAt: serveur.dernierTestAt,
    derniereErreur: serveur.derniereErreur,
    createdAt: serveur.createdAt,
    revokedAt: serveur.revokedAt,
  };
}
