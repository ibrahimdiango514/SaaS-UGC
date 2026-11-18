/**
 * Point d'entrée déployé de l'Edge Function `meta-lifecycle`.
 *
 * ## Ce que fait cette fonction
 * Trois routes :
 *
 *   - `/deauthorize`     : la personne a retiré VYORA depuis Facebook. On efface
 *                          ses connexions Pages / Instagram / Messenger.
 *   - `/data-deletion`   : la personne demande la suppression de ses données.
 *                          On efface tout et on renvoie l'URL de suivi + le code.
 *   - `/deletion-status` : page PUBLIQUE de suivi, `?code=…`.
 *
 * ## Pourquoi ces routes sont sur la même fonction
 * Les deux rappels partagent exactement les mêmes dépendances (App Secret, base)
 * et surtout le même contrôle d'entrée. Les séparer dupliquerait la vérification
 * de signature — la partie qu'il ne faut surtout pas dupliquer, car une copie
 * divergente est une porte ouverte.
 *
 * ## Sécurité
 * Aucun JWT Supabase (Meta n'en a pas). L'authentification des deux rappels
 * repose intégralement sur `signed_request` : HMAC-SHA256(App Secret, payload),
 * comparaison à temps constant. Sans signature valide → 401, aucune écriture.
 *
 * La route de suivi est publique par obligation (Meta exige une URL consultable
 * sans authentification) et ne renvoie qu'un état et des dates — jamais un
 * identifiant Meta, un nom, une adresse ou un jeton.
 */
import postgres from 'npm:postgres@3.4.5';
import { handleMetaLifecycle, type DeletionStatus, type LifecycleDeps } from './handler.ts';
import { buildAllowedOrigins, resolveCorsOrigin } from '../../../src/lib/origin-allowlist.ts';

const env = (name: string): string =>
  (globalThis as unknown as { Deno?: { env?: { get(k: string): string | undefined } } })
    .Deno?.env?.get(name) ?? '';

const DATABASE_URL = env('META_LIFECYCLE_DATABASE_URL') || env('SUPABASE_DB_URL');
/*
 * Même construction que `meta-connect` : les origines par défaut de la
 * plateforme (application publiée, aperçus Netlify, environnements e2b) plus
 * d'éventuels ajouts par `VYORA_ALLOWED_ORIGINS`. Redéfinir une liste locale
 * ferait diverger les deux fonctions au premier changement de domaine.
 */
const ALLOWED_ORIGINS = buildAllowedOrigins(env('VYORA_ALLOWED_ORIGINS'));

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

const deps: LifecycleDeps = {
  appSecret: env('META_APP_SECRET'),
  appUrl: env('VYORA_APP_URL') || 'https://vyora-saas-ugc.netlify.app',
  now: () => new Date(),

  async revokeUserConnections(metaUserId) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ r: { removed?: number } }[]>`
        select saas_business.meta_revoke_user_connections(${metaUserId}) as r`;
      return { removed: Number(ligne?.r?.removed ?? 0) };
    });
  },

  /*
   * Un SEUL appel : la base supprime et enregistre la demande dans la même
   * transaction, puis renvoie le code qu'elle a réellement calculé. Si l'appel
   * échoue, rien n'est supprimé — on ne peut pas se retrouver avec des données
   * détruites et aucune preuve vérifiable.
   */
  async deleteUserData(metaUserId) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ r: { confirmation_code?: string; connections_removed?: number } }[]>`
        select saas_business.meta_delete_user_data(${metaUserId}) as r`;
      const r = ligne?.r ?? {};
      if (typeof r.confirmation_code !== 'string' || !r.confirmation_code) {
        // Sans code, la page de suivi serait inutilisable : on échoue plutôt que
        // de renvoyer une réponse incomplète à Meta.
        throw new Error('suppression effectuée sans code de confirmation');
      }
      return {
        confirmationCode: r.confirmation_code,
        connectionsRemoved: Number(r.connections_removed ?? 0),
      };
    });
  },

  async readDeletionStatus(confirmationCode): Promise<DeletionStatus | null> {
    const [ligne] = await withDb(async (db: Sql) => db<{ r: DeletionStatus | null }[]>`
      select saas_business.meta_deletion_status(${confirmationCode}) as r`);
    const r = ligne?.r ?? null;
    if (!r || !r.status) return null;
    return {
      status: r.status,
      requestedAt: r.requestedAt ?? null,
      completedAt: r.completedAt ?? null,
      hasFailure: r.hasFailure === true,
    };
  },

  log(message, details) {
    // Aucune donnée personnelle : ni identifiant Meta, ni jeton, ni code.
    console.log(JSON.stringify({ function: 'meta-lifecycle', message, ...details }));
  },
};

Deno.serve(async (requete) => {
  const url = new URL(requete.url);
  const origine = requete.headers.get('origin');

  const reponse = await handleMetaLifecycle({
    method: requete.method,
    // Route en fin de chemin : `/functions/v1/meta-lifecycle/deauthorize`.
    route: url.pathname.split('/').filter(Boolean).pop() ?? '',
    contentType: requete.headers.get('content-type') ?? '',
    // Corps BRUT indispensable : la signature porte sur les octets exacts.
    rawBody: await requete.text(),
    query: { code: url.searchParams.get('code') ?? '' },
  }, deps);

  /*
   * CORS : la page de suivi est servie par l'application Netlify et appelle
   * cette fonction depuis le navigateur. Sans en-tête, le navigateur bloque la
   * lecture de la réponse et la page afficherait une erreur alors que la demande
   * est parfaitement enregistrée.
   *
   * `resolveCorsOrigin` renvoie `null` pour une origine inconnue : la lecture
   * reste alors impossible depuis une page tierce.
   */
  return new Response(JSON.stringify(reponse.body), {
    status: reponse.status,
    headers: {
      ...reponse.headers,
      'access-control-allow-origin': resolveCorsOrigin(ALLOWED_ORIGINS, origine),
      'vary': 'origin',
    },
  });
});
