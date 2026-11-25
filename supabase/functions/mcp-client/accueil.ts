/**
 * SORAHNEX — accès réel aux données des connexions MCP externes (P5).
 *
 * Ce module implémente `AccesBase` (voir `execution.ts`) contre PostgreSQL et
 * Vault. Il est le seul endroit où un secret sort de Vault, et il le fait par
 * une fonction `security definer` dédiée (`mcp_servers_secret`), jamais par une
 * requête directe sur `vault.decrypted_secrets` : `service_role` n'a, et ne doit
 * pas avoir, de privilège de lecture sur le schéma `vault`.
 *
 * ## Isolation : trois verrous, pas un
 *
 * `lireConnexion` ne se contente pas de filtrer sur `user_id` :
 *
 *   1. la ligne doit appartenir à l'utilisateur (`user_id = $1`) ;
 *   2. l'utilisateur doit être **membre** de l'espace de travail de la ligne
 *      (`mcp_is_workspace_member`) — un `user_id` correct sur un workspace dont
 *      il a été retiré ne doit plus rien ouvrir ;
 *   3. une connexion révoquée est retournée avec `revokedAt` renseigné, et non
 *      silencieusement traitée comme absente : la porte doit pouvoir répondre
 *      « révoquée » plutôt que « introuvable », ce qui aide l'utilisateur à
 *      comprendre.
 *
 * Le filtre sur le workspace est fait en SQL et non en TypeScript : une seule
 * source de vérité, et il reste vrai si un appelant oublie une vérification.
 */
import type { AccesBase, ConnexionServeur } from './execution.ts';
import { lireOAuthBase, stockerJetonsBase, type SqlOAuth } from './oauth-acces.ts';

/**
 * Client SQL minimal, compatible `postgres.js`.
 *
 * Typé structurellement plutôt qu'importé : ce module reste compilable par
 * `tsc` sans `node_modules`, et les tests peuvent fournir un faux client.
 */
export interface SqlTag {
  (fragments: TemplateStringsArray, ...valeurs: unknown[]): Promise<unknown[]>;
  end(options?: { timeout?: number }): Promise<void>;
}

export interface OptionsAcces {
  /** Ouvre une connexion. Appelé une fois par opération puis refermé. */
  sql: () => SqlTag;
}

interface LigneServeur {
  id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  url: string;
  auth_kind: string;
  secret_ref: string | null;
  vault_name: string | null;
  status: string;
  revoked_at: string | null;
  tools: unknown;
  tool_permissions: unknown;
  oauth_as?: unknown;
}

const AUTH_KINDS = new Set(['none', 'bearer', 'api_key', 'oauth']);
const STATUTS = new Set(['unknown', 'connected', 'auth_required', 'error', 'revoked']);

/**
 * Normalise les outils découverts.
 *
 * La base stocke du JSON libre. On ne fait pas confiance à sa forme : un outil
 * sans nom exploitable est écarté (il ne pourrait de toute façon pas être
 * appelé), et une liste corrompue devient une liste vide — donc un refus, ce
 * qui est le bon sens de l'erreur.
 */
function normaliserOutils(brut: unknown): { name: string; description?: string }[] {
  if (!Array.isArray(brut)) return [];
  const sortie: { name: string; description?: string }[] = [];
  for (const element of brut) {
    if (typeof element !== 'object' || element === null) continue;
    const objet = element as Record<string, unknown>;
    if (typeof objet.name !== 'string' || objet.name.trim() === '') continue;
    sortie.push({
      name: objet.name.trim(),
      description: typeof objet.description === 'string' ? objet.description : undefined,
    });
  }
  return sortie;
}

/** Un objet JSON, ou un objet vide. Jamais `null`, jamais un tableau. */
function objetJson(brut: unknown): Record<string, unknown> {
  if (typeof brut !== 'object' || brut === null || Array.isArray(brut)) return {};
  return brut as Record<string, unknown>;
}

/**
 * Convertit une ligne SQL en `ConnexionServeur`.
 *
 * Exporté pour être testé sans base : c'est ici que se joue la traduction des
 * valeurs inattendues en refus.
 */
export function depuisLigne(ligne: LigneServeur): ConnexionServeur {
  const authKind = AUTH_KINDS.has(ligne.auth_kind)
    ? (ligne.auth_kind as ConnexionServeur['authKind'])
    : 'none';
  const status = STATUTS.has(ligne.status)
    ? (ligne.status as ConnexionServeur['status'])
    : 'error';

  const permissions = objetJson(ligne.tool_permissions);

  return {
    id: ligne.id,
    userId: ligne.user_id,
    workspaceId: ligne.workspace_id,
    name: ligne.name,
    url: ligne.url,
    authKind,
    secretVaultName: ligne.vault_name ?? (ligne.secret_ref ? `mcp_server_${ligne.id}` : null),
    status,
    revokedAt: ligne.revoked_at,
    outils: normaliserOutils(ligne.tools),
    /*
     * Les permissions sont lues dans la même requête que la connexion : une
     * permission retirée entre deux appels est donc vue immédiatement, sans
     * cache intermédiaire à invalider.
     */
    toolPermissions: permissions,
    oauthAs: objetJson(ligne.oauth_as),
    /*
     * AUCUNE écriture n'est autorisée. La migration P2 ne porte pas de colonne
     * d'autorisation d'écriture, et la consigne est explicite : rien ne doit
     * être activé automatiquement. Une écriture reste donc impossible
     * aujourd'hui — elle exigera une colonne dédiée ET une UI d'accord
     * explicite, pas un ajout silencieux ici.
     */
    ecrituresAutorisees: {},
  };
}

/**
 * Lecture réelle. Une seule requête, donc un seul instant : impossible
 * d'obtenir une connexion lue avant une révocation et des permissions lues
 * après.
 */
export function creerAccesReel(options: OptionsAcces): AccesBase {
  return {
    async lireConnexion({ userId, serverId }): Promise<ConnexionServeur | null> {
      const sql = options.sql();
      try {
        const lignes = await sql`
          select
            s.id, s.user_id, s.workspace_id, s.name, s.url, s.auth_kind,
            s.secret_ref, sec.vault_name, s.status, s.revoked_at,
            s.tools, s.tool_permissions, s.oauth_as
          from public.mcp_servers s
          left join public.mcp_servers_secrets sec on sec.server_id = s.id
          where s.id = ${serverId}::uuid
            and s.user_id = ${userId}::uuid
            and public.mcp_is_workspace_member(s.user_id, s.workspace_id)
          limit 1
        ` as LigneServeur[];
        if (!Array.isArray(lignes) || lignes.length === 0) return null;
        return depuisLigne(lignes[0]);
      } finally {
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    },

    async lireOAuth(serverId: string) {
      const sql = options.sql();
      try {
        return await lireOAuthBase(sql as unknown as SqlOAuth, serverId);
      } finally {
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    },

    async stockerJetonsOAuth(input: {
      userId: string;
      serverId: string;
      access: string;
      refresh?: string;
      expireLe: string | null;
      scope?: string | null;
    }): Promise<void> {
      const sql = options.sql();
      try {
        await stockerJetonsBase(sql as unknown as SqlOAuth, input);
      } finally {
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    },

    async lireSecret(vaultName: string): Promise<string | null> {
      // Garde-fou : un nom de secret ne doit jamais être une valeur. On refuse
      // tout ce qui n'a pas la forme attendue, ce qui évite qu'un appelant
      // détourne cette fonction vers un autre secret Vault.
      if (!/^mcp_server_[0-9a-f-]{36}$/i.test(vaultName)) return null;

      const sql = options.sql();
      try {
        /*
         * Le nom contient l'identifiant du serveur : on le réutilise pour
         * appeler la fonction dédiée, qui vérifie elle-même la correspondance
         * serveur → secret. Aucune requête directe sur `vault.decrypted_secrets`.
         */
        const serverId = vaultName.slice('mcp_server_'.length);
        const lignes = await sql`
          select public.mcp_servers_secret(${serverId}::uuid) as secret
        ` as { secret: string | null }[];
        const valeur = Array.isArray(lignes) ? lignes[0]?.secret : null;
        if (typeof valeur !== 'string' || valeur.trim() === '') return null;
        return valeur;
      } finally {
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    },
  };
}
