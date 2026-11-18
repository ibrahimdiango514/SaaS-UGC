/**
 * VYORA — accès SQL aux jetons OAuth sortants.
 *
 * ## Pourquoi un module à part
 *
 * Deux chemins lisent les mêmes jetons : la **gestion** (état de la connexion,
 * révocation) et la **porte d'exécution** (renouvellement juste avant un appel).
 * Si chacun écrivait sa requête, une correction de sécurité appliquée d'un côté
 * laisserait l'autre ouvert. La requête vit donc ici, une seule fois.
 *
 * ## Rien ne sort d'ici vers le navigateur
 *
 * Ces fonctions renvoient des valeurs de secret (`access`, `refresh`,
 * `client_secret`). Elles ne sont appelées que par du code serveur, et le
 * résultat n'est jamais sérialisé dans une réponse HTTP de gestion.
 */

/** Signature minimale du client SQL (postgres.js), pour rester testable. */
export type SqlOAuth = (
  gabarit: TemplateStringsArray,
  ...valeurs: unknown[]
) => Promise<unknown>;

export interface JetonsOAuth {
  access: string | null;
  refresh: string | null;
  expireLe: string | null;
  scope: string | null;
  clientId: string | null;
  clientSecret: string | null;
}

/**
 * Lit les jetons et la configuration client d'un serveur.
 *
 * `mcp_oauth_lire` renvoie les secrets déchiffrés depuis Vault ; le reste vient
 * de la ligne `mcp_servers`. Une seule requête, donc un seul instant : les
 * jetons lus ne peuvent pas être plus récents que l'identifiant client lu.
 */
export async function lireOAuthBase(sql: SqlOAuth, serverId: string): Promise<JetonsOAuth | null> {
  const lignes = await sql`
    select
      public.mcp_oauth_lire(${serverId}::uuid) as jetons,
      (
        select oauth_client_id
        from public.mcp_servers
        where id = ${serverId}::uuid
      ) as client_id,
      public.mcp_oauth_secret_lire(${`mcp_oauth_client_secret_${serverId}`}::text) as client_secret
  ` as { jetons: Record<string, unknown> | null; client_id: string | null; client_secret: string | null }[];

  const ligne = Array.isArray(lignes) ? lignes[0] : undefined;
  if (!ligne) return null;
  const jetons = (ligne.jetons ?? {}) as Record<string, unknown>;
  return {
    access: typeof jetons.access === 'string' ? jetons.access : null,
    refresh: typeof jetons.refresh === 'string' ? jetons.refresh : null,
    expireLe: typeof jetons.expire_le === 'string' ? jetons.expire_le : null,
    scope: typeof jetons.scope === 'string' ? jetons.scope : null,
    clientId: ligne.client_id ?? null,
    clientSecret: ligne.client_secret ?? null,
  };
}

/** Écrit les jetons dans Vault et met à jour les colonnes d'état. */
export async function stockerJetonsBase(
  sql: SqlOAuth,
  input: {
    userId: string;
    serverId: string;
    access: string;
    refresh?: string;
    expireLe: string | null;
    scope?: string | null;
  },
): Promise<void> {
  await sql`
    select public.mcp_oauth_stocker(
      ${input.userId}::uuid,
      ${input.serverId}::uuid,
      ${input.access}::text,
      ${input.refresh ?? null}::text,
      ${input.expireLe ?? null}::timestamptz,
      ${input.scope ?? null}::text
    )
  `;
}

/** Détruit jetons, secret client, flux en attente et colonnes d'état. */
export async function detruireOAuthBase(sql: SqlOAuth, serverId: string): Promise<void> {
  await sql`select public.mcp_oauth_detruire(${serverId}::uuid)`;
}
