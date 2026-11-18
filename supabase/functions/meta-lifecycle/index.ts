/**
 * Point d'entrée déployé de l'Edge Function `meta-lifecycle`.
 *
 * ## Ce que fait cette fonction
 * Deux rappels exigés par Meta, tous deux en POST sur une URL publique :
 *
 *   - `/deauthorize` : la personne a retiré VYORA depuis Facebook. On efface ses
 *     connexions et les fournisseurs d'identité associés.
 *   - `/data-deletion` : la personne demande la suppression de ses données. On
 *     efface tout et on renvoie l'URL de suivi + le code de confirmation exigés.
 *
 * ## Pourquoi ces routes sont sur la même fonction
 * Elles partagent exactement les mêmes dépendances (App Secret, base, Vault) et
 * surtout le même contrôle d'entrée. Les séparer dupliquerait la vérification
 * de signature — la partie qu'il ne faut surtout pas dupliquer, car une copie
 * divergente est une porte ouverte.
 *
 * ## Sécurité
 * Aucun JWT Supabase (Meta n'en a pas). L'authentification repose intégralement
 * sur `signed_request` : HMAC-SHA256(App Secret, payload), comparaison à temps
 * constant. Sans signature valide → 401, aucune écriture.
 *
 * Toute la logique testable est dans `handler.ts`.
 */
import postgres from 'npm:postgres@3.4.5';
import { handleMetaLifecycle, type LifecycleDeps } from './handler.ts';

const env = (name: string): string =>
  (globalThis as unknown as { Deno?: { env?: { get(k: string): string | undefined } } })
    .Deno?.env?.get(name) ?? '';

const DATABASE_URL = env('META_LIFECYCLE_DATABASE_URL') || env('SUPABASE_DB_URL');

function requiredSql() {
  if (!DATABASE_URL) throw new Error('SUPABASE_DB_URL absent : la fonction ne peut pas joindre la base.');
  return postgres(DATABASE_URL, { max: 2, prepare: false, idle_timeout: 20 });
}

async function withDb<T>(fn: (db: ReturnType<typeof requiredSql>) => Promise<T>): Promise<T> {
  const db = requiredSql();
  try {
    return await fn(db);
  } finally {
    await db.end().catch(() => {});
  }
}

type Sql = ReturnType<typeof requiredSql>;

/**
 * Efface les secrets Vault référencés.
 *
 * Un échec n'est pas bloquant : la ligne en base est déjà supprimée, donc le
 * secret n'est plus référencé et n'ouvre plus aucun accès. On le signale dans
 * le journal pour qu'il puisse être purgé, sans faire échouer la réponse à Meta
 * (qui n'a aucun moyen de rejouer une demande utilisateur).
 */
async function deleteSecrets(refs: string[]): Promise<number> {
  let supprimes = 0;
  for (const ref of new Set(refs.filter(Boolean))) {
    try {
      await withDb(async (db: Sql) => {
        await db`delete from vault.secrets where name = ${ref}`;
      });
      supprimes += 1;
    } catch {
      // Le secret restera orphelin mais inutilisable : aucune référence en base.
    }
  }
  return supprimes;
}

const deps: LifecycleDeps = {
  appSecret: env('META_APP_SECRET'),
  appUrl: env('VYORA_APP_URL') || 'https://vyora-saas-ugc.netlify.app',
  now: () => new Date(),

  async revokeUserConnections(metaUserId) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ r: { removed?: number; token_refs?: string[] } }[]>`
        select saas_business.meta_revoke_user_connections(${metaUserId}) as r`;
      const r = ligne?.r ?? {};
      return { removed: Number(r.removed ?? 0), tokenRefs: r.token_refs ?? [] };
    });
  },

  async deleteUserData(metaUserId) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ r: { connections_removed?: number; token_refs?: string[] } }[]>`
        select saas_business.meta_delete_user_data(${metaUserId}) as r`;
      const r = ligne?.r ?? {};
      return { connectionsRemoved: Number(r.connections_removed ?? 0), tokenRefs: r.token_refs ?? [] };
    });
  },

  async recordDeletionRequest(metaUserId, confirmationCode, connectionsRemoved) {
    await withDb(async (db: Sql) => {
      await db`select saas_business.meta_deletion_record(${metaUserId}, ${confirmationCode}, ${connectionsRemoved})`;
    });
  },

  deleteSecrets,

  log(message, details) {
    // Aucune donnée personnelle : ni identifiant Meta, ni jeton, ni code.
    console.log(JSON.stringify({ function: 'meta-lifecycle', message, ...details }));
  },
};

Deno.serve(async (requete) => {
  const chemin = new URL(requete.url).pathname;
  return handleMetaLifecycle({
    method: requete.method,
    // Route en fin de chemin : `/functions/v1/meta-lifecycle/deauthorize`.
    route: chemin.split('/').filter(Boolean).pop() ?? '',
    contentType: requete.headers.get('content-type') ?? '',
    // Corps BRUT indispensable : la signature porte sur les octets exacts.
    rawBody: await requete.text(),
    deps,
  });
});
