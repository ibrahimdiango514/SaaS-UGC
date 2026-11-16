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
  type ImportAccess, type StoreImportDependencies,
} from './handler.ts';
import type { NormalizedProduct } from '../../../src/business/importer/normalize.ts';

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
function productRow(workspaceId: string, produit: NormalizedProduct) {
  const montant = produit.priceMinor === null
    ? null
    : produit.priceMinor / 10 ** (produit.currencyExponent ?? 2);
  return {
    workspace_id: workspaceId,
    name: produit.name.slice(0, 300),
    description: produit.description ? produit.description.slice(0, 4_000) : null,
    key_benefits: JSON.stringify(produit.benefits ?? []),
    features: JSON.stringify(produit.features ?? []),
    price_amount: montant,
    price_currency: (produit.currency || 'XOF').slice(0, 3),
    product_url: produit.productUrl,
    product_facts: JSON.stringify({
      source: 'url-import',
      platform: produit.source?.platform ?? null,
      reference: produit.source?.reference ?? null,
      imported_at: new Date().toISOString(),
    }),
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

  async insertProducts(workspaceId: string, produits: NormalizedProduct[]) {
    const db = requiredSql();
    let created = 0;
    const failed: Array<{ name: string; reason: string }> = [];
    for (const produit of produits) {
      try {
        await db`
          insert into saas_ugc.ugc_products ${db(productRow(workspaceId, produit))}
        `;
        created += 1;
      } catch {
        // Un échec n'annule pas les autres : on rapporte précisément.
        failed.push({ name: produit.name, reason: 'Enregistrement refusé par la base.' });
      }
    }
    return { created, failed };
  },

  resolveHost: denoResolveHost(),
  allowedOrigins,
};

const handler = createStoreImportHandler(store);
(globalThis as unknown as { Deno: { serve(h: (r: Request) => Promise<Response>): void } }).Deno.serve(handler);
