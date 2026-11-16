/**
 * Point d'entrée déployé de l'Edge Function `store-import`.
 *
 * Toute la logique testable est dans `handler.ts` (pur, sans réseau réel ni
 * base) et `safe-egress.ts` / `pinned-fetch.ts` (sortie réseau épinglée).
 * Ce fichier ne fait que brancher l'environnement : authentification, accès à
 * l'entreprise, liste des produits existants, écriture.
 *
 * ## Déploiement
 * `verify_jwt=true` : la passerelle exige déjà un JWT. La fonction le revérifie
 * auprès de GoTrue (`getUserId`) — on ne fait pas confiance à un en-tête seul.
 *
 * ## Autorisation de l'entreprise
 * `saas_business.bg_require_workspace(p_user_id, p_workspace_id, p_write)`
 * vérifie propriétaire OU membre avec rôle écrivain, en base, avec verrou. Une
 * entreprise d'un autre utilisateur échoue donc côté base, pas côté client.
 *
 * ## Isolation des données
 * Chaque requête SQL filtre sur `workspace_id` ET vérifie l'accès juste avant.
 * Aucun identifiant fourni par le client n'est utilisé comme filtre sans ce
 * contrôle.
 */

import postgres from 'npm:postgres@3.4.5';
import {
  createStoreImportHandler, denoResolveHost,
  type ImportAccess, type PreviewRecord, type PreviewStore, type StoreImportDependencies,
} from './handler.ts';
import type { NormalizedProduct } from '../../../src/business/importer/normalize.ts';
import { minorToDecimal } from '../../../src/business/importer/normalize.ts';
// L'analyseur de fichier, importé explicitement : sans lui, `parseFile` levait
// un ReferenceError à l'exécution et tout import de fichier finissait en 500.
import { importFile } from '../../../src/business/importer/files.ts';

const env = (name: string): string => (globalThis as unknown as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(name) ?? '';

const supabaseUrl = env('SUPABASE_URL');
const anonKey = env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');
const databaseUrl = env('STORE_IMPORT_DATABASE_URL') || env('BUSINESS_GROW_DATABASE_URL') || env('SUPABASE_DB_URL');

// CORS : les mêmes origines que Business Grow. CORS n'est pas la frontière
// d'authentification (chaque requête exige un JWT), mais une origine inconnue
// n'est pas traitée.
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'https://vyora-ugc.netlify.app',
  'https://saas-ugc-growth.netlify.app',
  'https://deploy-preview-*--saas-ugc-growth.netlify.app',
  'https://deploy-preview-*--vyora.netlify.app',
  'https://reelora.netlify.app',
  'https://*.e2b.app',
  ...(env('STORE_IMPORT_ALLOWED_ORIGINS') || '').split(','),
]
  .map((origin) => origin.trim())
  .filter(Boolean)
  .filter((origin, index, all) => all.indexOf(origin) === index);

const sql = databaseUrl
  ? postgres(databaseUrl, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: 'require',
      prepare: false,
      connection: { application_name: 'vyora-store-import-edge' },
    })
  : null;

function requiredSql() {
  if (!sql) throw new Error('store-import database connection is not configured.');
  return sql;
}

/** Vérifie le JWT auprès de GoTrue ; ne fait jamais confiance au seul en-tête. */
async function getUserId(authorization: string): Promise<string | null> {
  if (!supabaseUrl || !anonKey) return null;
  const result = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: authorization },
    signal: AbortSignal.timeout(10_000),
  });
  if (result.status === 401 || result.status === 403) return null;
  if (!result.ok) throw new Error('Supabase Auth request failed.');
  const user = (await result.json()) as { id?: unknown };
  return typeof user.id === 'string' ? user.id : null;
}

/**
 * Convertit un produit normalisé en ligne `ugc_products`.
 *
 * Le prix est stocké en unité majeure (colonne `price_amount`), la devise dans
 * `price_currency` ; un prix inconnu reste `null` plutôt que d'inventer zéro.
 */
function productRow(workspaceId: string, produit: NormalizedProduct, origine: 'url' | 'file') {
  // `minorToDecimal` applique le bon exposant : le XOF n'a PAS de décimales.
  // L'ancien calcul divisait tout par 100, ce qui aurait écrit 12 000 XOF
  // comme 120,00 — un prix faux, silencieusement, à chaque import.
  const montant = minorToDecimal(produit.priceMinor, produit.currency);
  return {
    workspace_id: workspaceId,
    name: produit.name.slice(0, 300),
    description: produit.description ? produit.description.slice(0, 4_000) : null,
    key_benefits: JSON.stringify([]),
    features: JSON.stringify([]),
    price_amount: montant,
    price_currency: (produit.currency || 'XOF').slice(0, 3),
    product_url: produit.productUrl,
    product_facts: JSON.stringify({
      // L'origine est réelle, pas supposée : l'historique doit pouvoir dire si
      // le produit vient d'une URL ou d'un fichier déposé.
      source: origine ?? 'import',
      platform: produit.source?.platform ?? null,
      reference: produit.source?.reference ?? null,
      imported_at: new Date().toISOString(),
    }),
  };
}

/**
 * Aperçus partagés entre instances Edge.
 *
 * ## Le défaut que cela corrige
 * Les aperçus vivaient dans une `Map` locale. Supabase lance plusieurs
 * instances : la confirmation arrivait souvent sur une autre que celle qui
 * avait produit l'aperçu, et répondait `PREVIEW_EXPIRED`. Mesuré ici même :
 * sur quatre tentatives réelles, trois ont échoué pour cette seule raison.
 * Aucune donnée sensible n'est en jeu — le payload est exactement ce que
 * l'aperçu a déjà renvoyé au client — mais l'import devenait inutilisable.
 *
 * ## Pourquoi la base
 * Elle est déjà là, elle est transactionnelle, et elle survit au redémarrage
 * d'une instance. Une purge paresseuse sur `expires_at` suffit : inutile
 * d'ajouter un ordonnanceur pour une table de quelques lignes.
 */
function postgresPreviewStore(): PreviewStore {
  return {
    async get(id) {
      const db = requiredSql();
      const [ligne] = await db<{ payload: PreviewRecord }[]>`
        select payload from saas_ugc.ugc_import_previews
        where id = ${id} and expires_at > now()
      `;
      return ligne?.payload;
    },
    async set(id, record, expiresAt) {
      const db = requiredSql();
      const expire = new Date(expiresAt).toISOString();
      // `JSON.stringify` enveloppé de `json()` explicite : sans cela, le pilote
      // sérialise l'objet en LIGNE composée postgres `(...)` et `::jsonb`
      // échoue — la colonne finissait par contenir une chaîne, l'aperçu était
      // écrit mais jamais relu, et la confirmation répondait `PREVIEW_EXPIRED`.
      const payload = JSON.stringify(record);
      await db`
        insert into saas_ugc.ugc_import_previews (id, user_id, workspace_id, payload, expires_at)
        values (${id}, ${record.userId}::uuid, ${record.workspaceId}::uuid,
                (${payload}::text)::jsonb, ${expire}::timestamptz)
        on conflict (id) do update
          set payload = excluded.payload, expires_at = excluded.expires_at
      `;
    },
    async delete(id) {
      const db = requiredSql();
      await db`delete from saas_ugc.ugc_import_previews where id = ${id}`;
    },
    async purge() {
      const db = requiredSql();
      await db`delete from saas_ugc.ugc_import_previews where expires_at <= now()`;
    },
  };
}

const store: StoreImportDependencies = {
  getUserId,

  /**
   * Abonnement Business Ground — la SEULE source de vérité.
   *
   * Appel à `saas_business.bg_import_access`, qui lit `subscriptions` et
   * `plans` et applique la règle (statut actif, période en cours, formule
   * encore commercialisée). Aucune valeur du navigateur n'entre ici : seul
   * l'identifiant issu de GoTrue.
   *
   * Toute panne (base absente, erreur SQL) PROPAGE l'exception : le handler
   * répond alors 503 et n'exécute rien. Un module réservé aux abonnés ne
   * s'ouvre jamais par accident.
   */
  async checkImportAccess(userId: string): Promise<ImportAccess> {
    const db = requiredSql();
    const [ligne] = await db<{ droits: Record<string, unknown> }[]>`
      select saas_business.bg_import_access(${userId}::uuid, now()) as droits
    `;
    const droits = (ligne?.droits ?? {}) as Record<string, unknown>;
    return {
      allowed: droits.allowed === true,
      reason: typeof droits.reason === 'string' ? droits.reason : 'UNKNOWN',
      message: typeof droits.message === 'string'
        ? droits.message
        : 'Un abonnement Business Ground actif est requis.',
      status: typeof droits.status === 'string' ? droits.status : null,
      planKey: typeof droits.plan_key === 'string' ? droits.plan_key : null,
      currentPeriodEnd: typeof droits.current_period_end === 'string'
        ? droits.current_period_end : null,
    };
  },

  async grantWorkspace(userId: string, workspaceId: string) {
    const db = requiredSql();
    // Lecture : owner ou membre. Écriture : rôle owner/admin/editor.
    const [ligne] = await db<{ can_read: boolean; can_write: boolean }[]>`
      select
        saas_business.bg_can_workspace(${userId}::uuid, ${workspaceId}::uuid, false) as can_read,
        saas_business.bg_can_workspace(${userId}::uuid, ${workspaceId}::uuid, true) as can_write
    `;
    return { canRead: Boolean(ligne?.can_read), canWrite: Boolean(ligne?.can_write) };
  },

  async listExistingProducts(workspaceId: string) {
    const db = requiredSql();
    const lignes = await db<{ id: string; name: string }[]>`
      select id, name from saas_ugc.ugc_products
      where workspace_id = ${workspaceId}::uuid
      order by name
      limit 5000
    `;
    return lignes.map((ligne) => ({ id: String(ligne.id), name: String(ligne.name) }));
  },

  async insertProducts(workspaceId: string, produits: NormalizedProduct[], origine: 'url' | 'file' = 'url') {
    const db = requiredSql();
    let created = 0;
    const failed: Array<{ name: string; reason: string }> = [];
    for (const produit of produits) {
      try {
        await db`
          insert into saas_ugc.ugc_products ${db(productRow(workspaceId, produit, origine))}
        `;
        created += 1;
      } catch {
        // Un échec n'annule pas les autres : on rapporte précisément.
        failed.push({ name: produit.name, reason: 'Enregistrement refusé par la base.' });
      }
    }
    return { created, failed };
  },

  // Même analyseur que le navigateur : un fichier ne doit pas être lu
  // différemment selon le chemin qui l'apporte.
  parseFile: (bytes: Uint8Array, filename: string) => importFile(bytes, filename),
  resolveHost: denoResolveHost(),
  previewStore: postgresPreviewStore(),
  allowedOrigins,
};

const handler = createStoreImportHandler(store);
(globalThis as unknown as { Deno: { serve(h: (r: Request) => Promise<Response>): void } }).Deno.serve(handler);
