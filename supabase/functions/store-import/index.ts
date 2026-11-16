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
    // Identifiant produit généré ici, et non par un `returning id`.
    //
    // `db(row)` produit un FRAGMENT de requête ; y accoler `returning id` fait
    // dépendre la lecture du résultat de la façon dont le pilote compose ce
    // fragment. Générer l'UUID côté serveur supprime cette dépendance et rend
    // l'insertion de variantes déterministe : `product_id` est connu avant
    // l'écriture, dans la même transaction.
    id: crypto.randomUUID(),
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
 * Convertit une variante normalisée en ligne `ugc_product_variants`.
 *
 * Deux pièges, tous deux dus à la valeur `null` :
 *   - un prix de variante absent signifie « même prix que le parent », pas
 *     « gratuit » : on écrit `null`, jamais 0 ;
 *   - une devise de variante absente retombe sur celle du produit, sinon la
 *     contrainte `^[A-Z]{3}$` refuserait la ligne.
 *
 * `position` conserve l'ordre du fichier : c'est ce qui permet d'afficher
 * « S, M, L » dans l'ordre voulu par le commerçant plutôt qu'alphabétiquement.
 */
function variantRows(produit: NormalizedProduct) {
  return (produit.variants ?? []).map((variante, index) => ({
    attribute_value: variante.name.slice(0, 120),
    sku: variante.sku ? variante.sku.slice(0, 120) : null,
    // `minorToDecimal` applique le bon exposant de devise : 12 000 XOF reste
    // 12 000, 24,90 EUR reste 24,90.
    price_amount: minorToDecimal(variante.priceMinor, produit.currency),
    price_currency: (produit.currency || 'XOF').slice(0, 3),
    stock: typeof variante.stock === 'number' && variante.stock >= 0 ? variante.stock : null,
    available: typeof variante.available === 'boolean' ? variante.available : null,
    position: index,
  }));
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

  /**
   * Écrit les produits ET leurs variantes.
   *
   * ## Pourquoi tout dans une transaction
   * Un produit écrit sans ses variantes est un catalogue faux : l'aperçu a
   * annoncé « S, M, L » et la base ne contiendrait qu'une fiche nue. Un
   * `begin`/`commit` par produit garantit qu'on n'obtient jamais cet état
   * intermédiaire — si l'insertion d'une variante échoue (contrainte, conflit
   * d'unicité), le produit de ce lot est annulé et l'échec est rapporté.
   *
   * Le découpage reste **par produit**, pas par fichier : une ligne invalide
   * ne doit pas annuler les 200 autres.
   */
  /**
   * Écrit les produits ET leurs variantes.
   *
   * Mode `updateExisting` : le produit est retrouvé par son nom dans
   * l'entreprise, mis à jour, et ses variantes sont réécrites à partir du
   * fichier. C'est ce qui permet de « mettre à jour les variantes depuis
   * CSV/XLSX » : réimporter un catalogue dont les tailles ont changé ne doit
   * pas créer une seconde fiche produit.
   *
   * Les variantes existantes sont SUPPRIMÉES puis réécrites — et non
   * désactivées — uniquement dans ce mode explicite : le fichier fait foi sur
   * la composition du produit. Hors de ce mode, rien n'est jamais supprimé.
   */
  async insertProducts(
    workspaceId: string,
    produits: NormalizedProduct[],
    origine: 'url' | 'file' = 'url',
    options: { updateExisting?: boolean } = {},
  ) {
    const db = requiredSql();
    let created = 0;
    let updated = 0;
    let variantsCreated = 0;
    let variantsUpdated = 0;
    const failed: Array<{ name: string; reason: string }> = [];

    // Mise à jour : les identifiants des produits déjà présents, par nom
    // normalisé (casse et espaces ignorés, comme l'aperçu qui les signale).
    // Interrogation directe plutôt que `this.listExistingProducts` : la
    // méthode ne dépend ainsi pas de la façon dont la fonction est appelée, ce
    // qu'une minification ou un appel détaché rendrait fragile.
    let parNom = new Map<string, string>();
    if (options.updateExisting) {
      const existants = await db<{ id: string; name: string }[]>`
        select id, name from saas_ugc.ugc_products
        where workspace_id = ${workspaceId}::uuid
      `;
      parNom = new Map(existants.map((p) => [String(p.name).trim().toLowerCase(), String(p.id)]));
    }

    for (const produit of produits) {
      const variantes = variantRows(produit);
      const cible = options.updateExisting
        ? parNom.get(produit.name.trim().toLowerCase()) ?? null
        : null;
      try {
        const ecrites = await db.begin(async (tx) => {
          if (cible) {
            // Remplacement : les champs du fichier écrasent le produit, et les
            // variantes repartent de zéro. Le produit garde son identifiant,
            // donc ses vidéos et son historique de contenu restent liés.
            //
            // On réutilise `productRow` pour la conversion de prix : réécrire
            // `minorToDecimal` ici aurait fait diverger le prix mis à jour de
            // celui créé (l'erreur « 12 000 devient 120 » est déjà arrivée).
            const champs = productRow(workspaceId, produit, origine);
            await tx`
              update saas_ugc.ugc_products
                 set name = ${champs.name},
                     description = ${champs.description},
                     price_amount = ${champs.price_amount},
                     price_currency = ${champs.price_currency},
                     product_url = ${champs.product_url},
                     product_facts = ${champs.product_facts},
                     updated_at = now()
               where id = ${cible}::uuid
                 and workspace_id = ${workspaceId}::uuid
            `;
            await tx`
              delete from saas_ugc.ugc_product_variants
               where product_id = ${cible}::uuid
            `;
            for (const variante of variantes) {
              await tx`
                insert into saas_ugc.ugc_product_variants ${tx({ product_id: cible, ...variante })}
              `;
            }
            return variantes.length;
          }
          const ligne = productRow(workspaceId, produit, origine);
          await tx`
            insert into saas_ugc.ugc_products ${tx(ligne)}
          `;
          const productId = String(ligne.id);
          for (const variante of variantes) {
            // `(valeur::text)::jsonb` n'est pas nécessaire ici : aucune colonne
            // jsonb n'est écrite dans cette boucle. Le pilote envoie des
            // scalaires, sérialisés correctement.
            await tx`
              insert into saas_ugc.ugc_product_variants ${tx({ product_id: productId, ...variante })}
            `;
          }
          return variantes.length;
        });
        if (cible) {
          updated += 1;
          variantsUpdated += ecrites;
        } else {
          created += 1;
          variantsCreated += ecrites;
        }
      } catch (erreur) {
        // Un échec n'annule pas les autres : on rapporte précisément, en
        // conservant la raison lisible plutôt qu'un message générique.
        const raison = erreur instanceof Error ? erreur.message : '';
        failed.push({
          name: produit.name,
          reason: raison.includes('ugc_product_variants_unique_option')
            ? 'Deux variantes portent la même option : produit non créé.'
            : raison.includes('ugc_product_variants_value_check')
              ? 'Nom de variante vide ou trop long : produit non créé.'
              : 'Enregistrement refusé par la base.',
        });
      }
    }
    return { created, updated, variantsCreated, variantsUpdated, failed };
  },

  /**
   * Journalise un import confirmé.
   *
   * Écrit par la fonction (service_role) uniquement : la RLS interdit à
   * `authenticated` d'insérer dans cette table, une ligne d'historique ne peut
   * donc pas être fabriquée depuis le navigateur.
   */
  async recordImport(job: {
    workspaceId: string;
    userId: string;
    source: 'file' | 'url';
    reference: string | null;
    created: number;
    failed: number;
    variantsCreated: number;
    failures: Array<{ name: string; reason: string }>;
  }) {
    const db = requiredSql();
    const statut = job.created === 0 ? 'failed' : job.failed > 0 ? 'partial' : 'completed';
    await db`
      insert into saas_ugc.ugc_import_jobs
        (workspace_id, user_id, source, reference, status,
         products_created, products_failed, variants_created, failures)
      values (
        ${job.workspaceId}::uuid,
        ${job.userId}::uuid,
        ${job.source},
        ${job.reference},
        ${statut},
        ${job.created},
        ${job.failed},
        ${job.variantsCreated},
        ${JSON.stringify(job.failures)}::text::jsonb
      )
    `;
    return { status: statut };
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
