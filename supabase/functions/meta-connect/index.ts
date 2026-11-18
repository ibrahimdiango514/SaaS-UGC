/**
 * Point d'entrée déployé de l'Edge Function `meta-connect`.
 *
 * Toute la logique testable est dans `handler.ts` (pur, dépendances
 * injectées). Ce fichier ne fait que brancher l'environnement :
 * authentification GoTrue, base PostgreSQL, Vault, sortie Graph.
 *
 * ## Le jeton ne sort jamais d'ici
 * - Les jetons Meta (utilisateur long, page, système WhatsApp) sont déposés
 *   dans **Vault** (`vault.create_secret`) et seuls leurs NOMS sont conservés
 *   en base (`meta_connections.token_ref`, `meta_pages.token_ref`).
 * - Chaque appel métier relit le jeton côté serveur et l'envoie à
 *   `graph.facebook.com` en en-tête `Authorization`. Aucune réponse HTTP, aucun
 *   journal ne contient de jeton : `redactTokens` filet de sécurité en plus.
 * - L'App Secret ne sert qu'ici, pour l'échange de code et `debug_token`.
 *
 * ## Réglages serveur
 * Secrets Supabase attendus (jamais exposés au navigateur) :
 *   META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN,
 *   META_WHATSAPP_CONFIG_ID, META_FACEBOOK_CONFIG_ID, META_MESSENGER_CONFIG_ID,
 *   META_INSTAGRAM_CONFIG_ID, VYORA_APP_URL.
 * Facultatifs : META_CONNECT_DATABASE_URL (sinon SUPABASE_DB_URL),
 * VYORA_ALLOWED_ORIGINS (origines supplémentaires séparées par des virgules).
 */
import postgres from 'npm:postgres@3.4.5';
import { handleMetaConnect, type ConnectionRow, type MetaConfig, type MetaDeps, type PageRow } from './handler.ts';
import { type MetaProduct } from '../../../src/business/meta/products.ts';
import { buildAllowedOrigins } from '../../../src/lib/origin-allowlist.ts';
import { readTestFlowConfig } from '../../../src/business/meta/test-flow.ts';

/**
 * Lecture d'environnement par `globalThis` : ce fichier reste vérifiable par
 * `tsc -p tsconfig.edge.json` sans charger les types Deno, comme `store-connect`.
 */
const env = (name: string): string =>
  (globalThis as unknown as { Deno?: { env?: { get(k: string): string | undefined } } })
    .Deno?.env?.get(name) ?? '';

const SUPABASE_URL = env('SUPABASE_URL');
const ANON_KEY = env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');
const DATABASE_URL = env('META_CONNECT_DATABASE_URL') || env('SUPABASE_DB_URL');
const ALLOWED_ORIGINS = buildAllowedOrigins(env('VYORA_ALLOWED_ORIGINS'));

/**
 * Jeton du parcours de test — lu depuis l'environnement, jamais d'une requête.
 *
 * Il est posé sur `globalThis` (et non passé dans `MetaDeps`) pour qu'aucune
 * action cliente ne puisse l'atteindre : `deps` est sérialisé nulle part, mais
 * un jeton qui n'apparaît pas dans la structure partagée ne peut pas fuiter par
 * inadvertance dans une réponse qui la parcourrait.
 */
(globalThis as unknown as { __metaTestToken?: string }).__metaTestToken = env('META_TEST_ACCESS_TOKEN');

const config: MetaConfig = {
  appId: env('META_APP_ID'),
  appSecret: env('META_APP_SECRET'),
  appUrl: env('VYORA_APP_URL') || 'https://vyora-saas-ugc.netlify.app',
  supabaseUrl: SUPABASE_URL,
  configIds: {
    whatsapp: env('META_WHATSAPP_CONFIG_ID'),
    facebook: env('META_FACEBOOK_CONFIG_ID'),
    messenger: env('META_MESSENGER_CONFIG_ID'),
    instagram: env('META_INSTAGRAM_CONFIG_ID'),
  },
};

function requiredSql() {
  if (!DATABASE_URL) throw new Error('SUPABASE_DB_URL absent : la fonction ne peut pas joindre la base.');
  return postgres(DATABASE_URL, { max: 2, prepare: false, idle_timeout: 20 });
}

/* ------------------------------ authentification ---------------------------- */

/** Identité vérifiée auprès de GoTrue. Un en-tête forgé ne donne rien. */
async function getUserId(authorization: string): Promise<string | null> {
  const jwt = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  if (!jwt || !SUPABASE_URL) return null;
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), 8000);
  try {
    const reponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { authorization: `Bearer ${jwt}`, apikey: ANON_KEY },
      signal: controleur.signal,
    });
    if (!reponse.ok) return null;
    const donnees = await reponse.json() as { id?: unknown };
    const id = typeof donnees?.id === 'string' ? donnees.id : '';
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
  } catch {
    return null;
  } finally {
    clearTimeout(minuteur);
  }
}

/* ------------------------------- dépendances -------------------------------- */

async function withDb<T>(fn: (db: ReturnType<typeof requiredSql>) => Promise<T>): Promise<T> {
  const db = requiredSql();
  try {
    return await fn(db);
  } finally {
    await db.end().catch(() => {});
  }
}

type Sql = ReturnType<typeof requiredSql>;

async function storeSecret(name: string, value: string): Promise<void> {
  await withDb(async (db) => {
    const [existant] = await db<{ id: string }[]>`select id from vault.secrets where name = ${name} limit 1`;
    if (existant?.id) await db`select vault.update_secret(${existant.id}::uuid, ${value})`;
    else await db`select vault.create_secret(${value}, ${name}, ${'Jeton Meta VYORA'})`;
  });
}

async function readSecret(name: string): Promise<string | null> {
  try {
    return await withDb(async (db) => {
      const [ligne] = await db<{ secret: string }[]>`
        select decrypted_secret as secret from vault.decrypted_secrets where name = ${name} limit 1`;
      return typeof ligne?.secret === 'string' && ligne.secret ? ligne.secret : null;
    });
  } catch {
    return null;
  }
}

async function deleteSecret(name: string): Promise<void> {
  try {
    await withDb(async (db) => {
      await db`delete from vault.secrets where name = ${name}`;
    });
  } catch {
    // Un secret orphelin n'ouvre aucun accès : il n'est plus référencé.
  }
}

function asProduct(value: unknown): MetaProduct {
  return String(value) as MetaProduct;
}

const deps: MetaDeps = {
  config,
  // Le parcours de test est fermé tant que META_TEST_FLOW_ENABLED n'est pas
  // explicitement à 'true'. Son absence ne l'ouvre jamais.
  testFlow: readTestFlowConfig(env),
  getUserId,

  /**
   * Administrateur propriétaire, décidé par la BASE pour l'identifiant GoTrue
   * vérifié. Aucune adresse e-mail, aucun en-tête, aucun paramètre de requête
   * n'entre dans cette décision : un client ne peut pas se déclarer admin.
   */
  async isAdmin(userId: string) {
    try {
      return await withDb(async (db: Sql) => {
        const [ligne] = await db<{ admin: boolean }[]>`
          select saas_business.meta_is_admin(${userId}::uuid) as admin`;
        return ligne?.admin === true;
      });
    } catch {
      // Panne de lecture = refus. Un doute ne doit jamais ouvrir un parcours
      // réservé à l'administrateur.
      return false;
    }
  },

  async checkImportAccess(userId: string) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ droits: Record<string, unknown> }[]>`
        select saas_business.bg_import_access(${userId}::uuid, now()) as droits`;
      const droits = ligne?.droits ?? {};
      return {
        allowed: droits.allowed === true,
        reason: typeof droits.reason === 'string' ? droits.reason : 'SUBSCRIPTION_REQUIRED',
        message: typeof droits.message === 'string' ? droits.message : 'Un abonnement Business Grow actif est requis.',
      };
    });
  },

  async grantWorkspace(userId: string, workspaceId: string) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ can_read: boolean; can_write: boolean }[]>`
        select can_read, can_write from saas_business.bg_can_workspace(${userId}::uuid, ${workspaceId}::uuid, true)`;
      return { canRead: ligne?.can_read === true, canWrite: ligne?.can_write === true };
    });
  },

  async stateCreate(state, userId, workspaceId, product) {
    await withDb(async (db: Sql) => {
      await db`select saas_business.meta_state_create(${state}, ${userId}::uuid, ${workspaceId}::uuid, ${product}, 600)`;
    });
  },

  async stateConsume(state) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ user_id: string; workspace_id: string; product: string }[]>`
        select user_id, workspace_id, product from saas_business.meta_state_consume(${state})`;
      if (!ligne) return null;
      return { userId: ligne.user_id, workspaceId: ligne.workspace_id, product: asProduct(ligne.product) };
    });
  },

  storeSecret,
  readSecret,
  deleteSecret,

  async connectionUpsert(payload) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ id: string }[]>`
        select saas_business.meta_connection_upsert(${JSON.stringify(payload)}::jsonb) as id`;
      if (!ligne?.id) throw new Error('meta_connection_upsert sans identifiant');
      return ligne.id;
    });
  },

  async connectionInternal(userId, workspaceId, product) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ row: ConnectionRow | null }[]>`
        select saas_business.meta_connection_internal(${userId}::uuid, ${workspaceId}::uuid, ${product}) as row`;
      return ligne?.row ?? null;
    });
  },

  async connectionsList(userId, workspaceId, product) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ liste: unknown[] }[]>`
        select saas_business.meta_connections_list(${userId}::uuid, ${workspaceId}::uuid, ${product ?? null}) as liste`;
      return Array.isArray(ligne?.liste) ? ligne.liste : [];
    });
  },

  async connectionSetStatus(userId, workspaceId, product, status, error) {
    await withDb(async (db: Sql) => {
      await db`select saas_business.meta_connection_set_status(${userId}::uuid, ${workspaceId}::uuid, ${product}, ${status}, ${error ?? null})`;
    });
  },

  async connectionMergeMetadata(userId, workspaceId, product, metadata) {
    await withDb(async (db: Sql) => {
      await db`select saas_business.meta_connection_merge_metadata(${userId}::uuid, ${workspaceId}::uuid, ${product}, ${JSON.stringify(metadata)}::jsonb)`;
    });
  },

  async connectionDelete(userId, workspaceId, product) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ resultat: { token_refs?: string[] } }[]>`
        select saas_business.meta_connection_delete(${userId}::uuid, ${workspaceId}::uuid, ${product}) as resultat`;
      const refs = Array.isArray(ligne?.resultat?.token_refs) ? ligne.resultat.token_refs.filter((r): r is string => typeof r === 'string') : [];
      return { tokenRefs: refs };
    });
  },

  async pagesReplace(userId, workspaceId, product, pages) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ resultat: { removed_token_refs?: string[] } }[]>`
        select saas_business.meta_pages_replace(${userId}::uuid, ${workspaceId}::uuid, ${product}, ${JSON.stringify(pages)}::jsonb) as resultat`;
      const refs = Array.isArray(ligne?.resultat?.removed_token_refs)
        ? ligne.resultat.removed_token_refs.filter((r): r is string => typeof r === 'string')
        : [];
      return { removedTokenRefs: refs };
    });
  },

  async pageInternal(userId, workspaceId, product, pageId) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ row: PageRow | null }[]>`
        select saas_business.meta_page_internal(${userId}::uuid, ${workspaceId}::uuid, ${product}, ${pageId}) as row`;
      return ligne?.row ?? null;
    });
  },

  /**
   * Trace dans le socle Business Grow : c'est cette ligne qui rend la fiche
   * « Connecté » côté catalogue, et elle n'est écrite qu'après un échange
   * OAuth réussi, avec l'identifiant externe réel.
   */
  async recordIntegration(userId, workspaceId, connectorKey, credentialRef, externalRef) {
    await withDb(async (db: Sql) => {
      await db`select saas_business.bg_connect_integration(
        ${userId}::uuid, ${workspaceId}::uuid, ${connectorKey}, ${credentialRef}, ${externalRef},
        ${['profile']}::text[], ${1}::integer, ${0}::integer)`;
    });
  },

  async disconnectIntegration(userId, workspaceId, connectorKey) {
    await withDb(async (db: Sql) => {
      await db`select saas_business.bg_disconnect_integration(${userId}::uuid, ${workspaceId}::uuid, ${connectorKey})`;
    });
  },

  async messageRecord(payload) {
    await withDb(async (db: Sql) => {
      await db`select saas_business.meta_message_record(${JSON.stringify(payload)}::jsonb)`;
    });
  },

  async messagesList(userId, workspaceId, channel, accountRef, conversationRef, limit) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ liste: unknown[] }[]>`
        select saas_business.meta_messages_list(${userId}::uuid, ${workspaceId}::uuid, ${channel}, ${accountRef}, ${conversationRef}, ${limit}::integer) as liste`;
      return Array.isArray(ligne?.liste) ? ligne.liste : [];
    });
  },

  async conversationsList(userId, workspaceId, channel, accountRef, limit) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ liste: unknown[] }[]>`
        select saas_business.meta_conversations_list(${userId}::uuid, ${workspaceId}::uuid, ${channel}, ${accountRef}, ${limit}::integer) as liste`;
      return Array.isArray(ligne?.liste) ? ligne.liste : [];
    });
  },

  async pageEventsList(userId, workspaceId, channel, pageId, limit) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ liste: unknown[] }[]>`
        select saas_business.meta_page_events_list(${userId}::uuid, ${workspaceId}::uuid, ${channel}, ${pageId}, ${limit}::integer) as liste`;
      return Array.isArray(ligne?.liste) ? ligne.liste : [];
    });
  },

  log: (message, detail) => {
    // Les appelants ne transmettent que des codes : aucun jeton ne peut arriver
    // ici. Filet de sécurité : `redactTokens` est déjà appliqué en amont.
    console.error(message, detail ?? {});
  },

  now: () => new Date(),
};

const runtime = (globalThis as unknown as {
  Deno: { serve(handler: (request: Request) => Promise<Response>): unknown };
}).Deno;

runtime.serve((request: Request) => handleMetaConnect(request, deps, { allowedOrigins: ALLOWED_ORIGINS }));
