/**
 * Point d'entrée déployé de l'Edge Function `meta-webhook`.
 *
 * Meta ne peut présenter aucun JWT Supabase : `verify_jwt = false` dans
 * `supabase/config.toml`. La protection repose entièrement sur :
 *   1. `hub.verify_token` pour la vérification d'abonnement (GET),
 *   2. `X-Hub-Signature-256` = HMAC-SHA256(app secret, corps brut) pour les
 *      notifications (POST) — comparaison à temps constant,
 *   3. la résolution en base de l'identifiant Meta reçu : un WABA ou une page
 *      que VYORA ne connaît pas ne crée aucune ligne.
 *
 * Ce fichier ne fait que brancher la base ; toute la logique est dans
 * `handler.ts`.
 */
import postgres from 'npm:postgres@3.4.5';
import { handleMetaWebhook, type WebhookDeps } from './handler.ts';

const env = (name: string): string =>
  (globalThis as unknown as { Deno?: { env?: { get(k: string): string | undefined } } })
    .Deno?.env?.get(name) ?? '';

const DATABASE_URL = env('META_WEBHOOK_DATABASE_URL') || env('SUPABASE_DB_URL');

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

interface TargetRow {
  connection_id?: string;
  user_id?: string;
  workspace_id?: string;
  page_id?: string;
}

function target(row: TargetRow | null): { connectionId: string; userId: string; workspaceId: string } | null {
  if (!row?.user_id || !row?.workspace_id || !row?.connection_id) return null;
  return { connectionId: row.connection_id, userId: row.user_id, workspaceId: row.workspace_id };
}

const deps: WebhookDeps = {
  verifyToken: env('META_WEBHOOK_VERIFY_TOKEN'),
  appSecret: env('META_APP_SECRET'),

  async recordEvent(object, kind, dedupeKey, payload) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ nouveau: boolean }[]>`
        select saas_business.meta_webhook_event_record(${object}, ${kind}, ${dedupeKey}, ${JSON.stringify(payload)}::jsonb) as nouveau`;
      return ligne?.nouveau === true;
    });
  },

  async finishEvent(dedupeKey, error) {
    await withDb(async (db: Sql) => {
      await db`select saas_business.meta_webhook_event_finish(${dedupeKey}, ${error})`;
    });
  },

  async resolvePhone(phoneNumberId) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ row: TargetRow | null }[]>`
        select saas_business.meta_resolve_phone(${phoneNumberId}) as row`;
      return target(ligne?.row ?? null);
    });
  },

  async resolvePage(pageId, product) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ row: TargetRow | null }[]>`
        select saas_business.meta_resolve_page(${pageId}, ${product}) as row`;
      return target(ligne?.row ?? null);
    });
  },

  async resolveInstagram(igId) {
    return withDb(async (db: Sql) => {
      const [ligne] = await db<{ row: TargetRow | null }[]>`
        select saas_business.meta_resolve_instagram(${igId}) as row`;
      const base = target(ligne?.row ?? null);
      if (!base) return null;
      return { ...base, pageId: String(ligne?.row?.page_id ?? '') };
    });
  },

  async messageRecord(payload) {
    await withDb(async (db: Sql) => {
      await db`select saas_business.meta_message_record(${JSON.stringify(payload)}::jsonb)`;
    });
  },

  async messageSetStatus(externalMessageId, status, errorCode, errorMessage) {
    await withDb(async (db: Sql) => {
      await db`select saas_business.meta_message_set_status(${externalMessageId}, ${status}, ${errorCode}::integer, ${errorMessage})`;
    });
  },

  async pageEventRecord(payload) {
    await withDb(async (db: Sql) => {
      await db`select saas_business.meta_page_event_record(${JSON.stringify(payload)}::jsonb)`;
    });
  },

  log: (message, detail) => {
    // Les appelants ne transmettent que des identifiants Meta et des codes.
    console.error(message, detail ?? {});
  },
};

const runtime = (globalThis as unknown as {
  Deno: { serve(handler: (request: Request) => Promise<Response>): unknown };
}).Deno;

runtime.serve((request: Request) => handleMetaWebhook(request, deps, { maxBytes: 1_048_576 }));
