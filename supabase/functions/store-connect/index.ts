/**
 * Point d'entrée déployé de l'Edge Function `store-connect`.
 *
 * Toute la logique testable est dans `handler.ts` (pur). Ce fichier ne fait que
 * brancher l'environnement : authentification GoTrue, base PostgreSQL, Vault,
 * sortie réseau épinglée.
 *
 * ## Le secret ne sort jamais d'ici
 * - La clé reçue du navigateur est déposée dans **Vault** (`vault.create_secret`),
 *   puis oubliée. Seul son NOM est conservé dans
 *   `saas_business.integration_connections.credential_ref`.
 * - La relecture d'un secret pour l'aperçu se fait **dans cette fonction** :
 *   le navigateur ne l'obtient jamais.
 * - Aucun `console.log` ne reçoit de clé. Les journaux d'erreur ne portent que
 *   des codes et des noms de ressource.
 */
import postgres from 'npm:postgres@3.4.5';
import { handleStoreConnect, type ConnectDependencies } from './handler.ts';
import type { EgressDeps } from '../store-import/safe-egress.ts';
import { pinnedFetchLike } from '../store-import/safe-egress.ts';
import { buildAllowedOrigins } from '../../../src/lib/origin-allowlist.ts';

/**
 * Lecture d'environnement sans supposer la présence de `Deno`.
 *
 * `tsconfig.edge.json` vérifie ce fichier sans charger les types Deno (le
 * dépôt n'en dépend pas) : un `Deno.env.get(...)` en portée de module y serait
 * une erreur de compilation, donc la fonction ne serait plus vérifiée du tout.
 * On accède au runtime par `globalThis`, comme `store-import` le fait déjà.
 */
const env = (name: string): string =>
  (globalThis as unknown as { Deno?: { env?: { get(k: string): string | undefined } } })
    .Deno?.env?.get(name) ?? '';

const DEFAULT_SUPABASE_URL = env('SUPABASE_URL');
const ANON_KEY = env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');
// `STORE_CONNECT_DATABASE_URL` d'abord : une chaîne dédiée évite de partager
// par accident les réglages d'une autre fonction.
const DATABASE_URL = env('STORE_CONNECT_DATABASE_URL') || env('SUPABASE_DB_URL');

/**
 * Origines autorisées : la liste par défaut partagée avec `store-import` et
 * `mcp-client` (application publiée, aperçus, développement local), PLUS les
 * origines du secret `VYORA_ALLOWED_ORIGINS` (séparées par des virgules).
 *
 * Avant : seul le secret était lu. Secret absent ou incomplet = toutes les
 * requêtes du navigateur recevaient `access-control-allow-origin: null`, donc
 * étaient bloquées alors que les autres fonctions acceptaient la même origine.
 * Un nouveau domaine de production se déclare donc UNE fois, dans le secret,
 * et les origines connues continuent de fonctionner sans redéploiement.
 */
const ALLOWED_ORIGINS = buildAllowedOrigins(env('VYORA_ALLOWED_ORIGINS'));

function requiredSql() {
  if (!DATABASE_URL) {
    throw new Error('SUPABASE_DB_URL absent : la fonction ne peut pas joindre la base.');
  }
  // `max: 2` suffit : la fonction fait peu de requêtes et les Edge Functions
  // sont recyclées souvent. Une préparation de requête limitée évite de saturer
  // le pooler.
  return postgres(DATABASE_URL, { max: 2, prepare: false, idle_timeout: 20 });
}

/* ------------------------------ authentification ----------------------------- */

/**
 * Identité de l'appelant, auprès de GoTrue.
 *
 * On ne fait pas confiance à un en-tête `x-user-id` fourni par le client : un
 * appel direct à la fonction pourrait le forger. Le JWT est vérifié par la
 * passerelle (`verify_jwt=true`) ET l'identité relue ici.
 */
async function getUserId(authorization: string): Promise<string | null> {
  const jwt = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  if (!jwt) return null;

  if (!DEFAULT_SUPABASE_URL) return null;

  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), 8000);
  try {
    const reponse = await fetch(`${DEFAULT_SUPABASE_URL}/auth/v1/user`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        apikey: ANON_KEY,
      },
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

/* ---------------------------------- Vault --------------------------------- */

/**
 * Nom de secret Vault, stable pour un couple (utilisateur, connecteur).
 *
 * Contient l'identifiant de l'utilisateur mais **aucune donnée secrète** : le
 * nom sert de clé de recherche, pas de mot de passe. Il est néanmoins traité
 * comme interne — jamais renvoyé au navigateur.
 */
function credentialName(userId: string, connectorKey: string): string {
  return `vyora_${connectorKey}_${userId}`;
}

/**
 * Dépose (ou remplace) la clé dans Vault et rend le nom du secret.
 *
 * `vault.create_secret` refuse un nom déjà pris : sur une reconnexion, on met
 * donc à jour le secret existant au lieu d'en créer un second. Sans cela, une
 * clé corrigée après échec laisserait l'ancienne en place, et l'aperçu
 * continuerait d'échouer sans que rien ne l'explique.
 */
async function storeCredential(input: {
  userId: string; connectorKey: string; secret: string;
}): Promise<string> {
  const db = requiredSql();
  const nom = credentialName(input.userId, input.connectorKey);
  try {
    const [existant] = await db<{ id: string }[]>`
      select id from vault.secrets where name = ${nom} limit 1
    `;
    if (existant?.id) {
      await db`select vault.update_secret(${existant.id}::uuid, ${input.secret})`;
    } else {
      await db`select vault.create_secret(${input.secret}, ${nom}, ${`Clé API ${input.connectorKey} — VYORA`})`;
    }
    return nom;
  } catch (erreur) {
    // Le message de l'erreur Postgres ne contient pas la valeur du secret.
    console.error('store-connect: dépôt Vault échoué', {
      code: (erreur as { code?: string })?.code ?? 'inconnu',
    });
    throw new Error('Vault indisponible');
  } finally {
    await db.end().catch(() => {});
  }
}

/** Relit la clé côté serveur. Jamais renvoyée au navigateur. */
async function readCredential(userId: string, connectorKey: string): Promise<string | null> {
  const db = requiredSql();
  try {
    const [ligne] = await db<{ secret: string }[]>`
      select decrypted_secret as secret
        from vault.decrypted_secrets
       where name = ${credentialName(userId, connectorKey)}
       limit 1
    `;
    return typeof ligne?.secret === 'string' && ligne.secret ? ligne.secret : null;
  } catch {
    return null;
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * Nom du secret Vault existant, sans en lire la valeur.
 *
 * `save-custom` en a besoin quand la clé a déjà été déposée par une sonde
 * réussie : on ne veut ni la redemander à l'utilisateur, ni la relire pour la
 * replacer à l'identique.
 */
async function readCredentialRef(userId: string, connectorKey: string): Promise<string | null> {
  const db = requiredSql();
  try {
    const [ligne] = await db<{ name: string }[]>`
      select name
        from vault.secrets
       where name = ${credentialName(userId, connectorKey)}
       limit 1
    `;
    return typeof ligne?.name === 'string' && ligne.name ? ligne.name : null;
  } catch {
    return null;
  } finally {
    await db.end().catch(() => {});
  }
}

/** Retire le secret Vault. Best-effort : ne fait jamais échouer la déconnexion. */
async function deleteCredential(name: string): Promise<void> {
  const db = requiredSql();
  try {
    await db`delete from vault.secrets where name = ${name}`;
  } catch {
    // Un secret orphelin n'ouvre aucun accès : il n'est plus référencé par
    // aucune connexion active. On ne bloque pas l'utilisateur pour autant.
  } finally {
    await db.end().catch(() => {});
  }
}

/* -------------------------------- dépendances ------------------------------ */

/** Résolution DNS réelle, utilisée par la sortie épinglée. */
async function resolveHost(hostname: string): Promise<string[]> {
  // Fail-closed : sans résolveur, la connexion épinglée ne peut pas vérifier
  // l'adresse, donc on refuse plutôt que de laisser `fetch` résoudre seul.
  const deno = (globalThis as unknown as {
    Deno?: { resolveDns?: (nom: string, type: 'A' | 'AAAA') => Promise<string[]> };
  }).Deno;
  if (typeof deno?.resolveDns !== 'function') {
    throw new Error('Deno.resolveDns indisponible');
  }
  const resultats = await Promise.allSettled([
    deno.resolveDns(hostname, 'A'),
    deno.resolveDns(hostname, 'AAAA'),
  ]);
  const adresses: string[] = [];
  for (const resultat of resultats) {
    if (resultat.status === 'fulfilled' && Array.isArray(resultat.value)) {
      adresses.push(...resultat.value);
    }
  }
  return adresses;
}

const egress: EgressDeps = { resolveHost };

const deps: ConnectDependencies = {
  getUserId,

  /** Abonnement Business Ground : la seule source de vérité, lue en base. */
  async checkImportAccess(userId: string) {
    const db = requiredSql();
    try {
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
      };
    } finally {
      await db.end().catch(() => {});
    }
  },

  /**
   * Droits sur l'entreprise, lus en base.
   *
   * `bg_can_workspace` vérifie propriétaire OU membre avec rôle d'écriture. Un
   * identifiant d'entreprise fourni par le client ne donne donc rien : il est
   * contrôlé avant d'être utilisé.
   */
  async grantWorkspace(userId: string, workspaceId: string) {
    const db = requiredSql();
    try {
      const [ligne] = await db<{ can_read: boolean; can_write: boolean }[]>`
        select can_read, can_write
          from saas_business.bg_can_workspace(${userId}::uuid, ${workspaceId}::uuid, true)
      `;
      return { canRead: ligne?.can_read === true, canWrite: ligne?.can_write === true };
    } finally {
      await db.end().catch(() => {});
    }
  },

  storeCredential,
  readCredential,
  readCredentialRef,
  deleteCredential,

  /**
   * Enregistre la configuration d'une API personnalisée.
   *
   * Une seule RPC : `bg_save_custom_api_connection` valide, délègue la partie
   * commune à `bg_connect_integration` (appartenance, abonnement, journal) puis
   * écrit la configuration. Les erreurs `connect_invalid:CODE` remontent telles
   * quelles pour que l'interface nomme le champ fautif.
   */
  async saveCustomApiConfig(input) {
    const db = requiredSql();
    try {
      const [ligne] = await db<{ resultat: Record<string, unknown> }[]>`
        select saas_business.bg_save_custom_api_connection(
          ${input.userId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.credentialRef},
          ${input.baseUrl},
          ${input.authScheme},
          ${input.authHeaderName},
          ${input.productsPath},
          ${input.paginationKind},
          ${input.pageSize}::integer,
          ${input.maxPages}::integer,
          ${JSON.stringify(input.mapping)}::jsonb,
          ${input.priceUnit},
          ${input.currency},
          ${input.probeStatus}::integer,
          ${input.productsFound}::integer,
          ${input.probeSummary},
          ${input.durationMs}::integer
        ) as resultat
      `;
      const resultat = ligne?.resultat ?? {};
      return {
        ok: true,
        connectionId: String((resultat as { connection_id?: string }).connection_id ?? ''),
        configurationId: String((resultat as { configuration_id?: string }).configuration_id ?? ''),
      };
    } catch (erreur) {
      const brut = erreur instanceof Error ? erreur.message : String(erreur);
      // `connect_invalid:MAPPING_NAME_REQUIRED` → code et message lisibles.
      const trouve = /connect_(?:invalid|forbidden):([A-Z_]+)/.exec(brut);
      const code = trouve?.[1] ?? 'CUSTOM_API_SAVE_FAILED';
      return {
        ok: false,
        code,
        message: messagePourCode(code),
      };
    } finally {
      await db.end().catch(() => {});
    }
  },

  async recordConnection(input) {
    const db = requiredSql();
    try {
      const [ligne] = await db<{ resultat: { connection_id: string; status: string } }[]>`
        select saas_business.bg_connect_integration(
          ${input.userId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.connectorKey},
          ${input.credentialRef},
          ${input.externalAccountRef},
          ${input.resourcesRead}::text[],
          ${input.totalProducts}::integer,
          ${input.durationMs}::integer
        ) as resultat
      `;
      return {
        connectionId: String(ligne?.resultat?.connection_id ?? ''),
        status: String(ligne?.resultat?.status ?? 'connected'),
      };
    } finally {
      await db.end().catch(() => {});
    }
  },

  async recordFailure(input) {
    const db = requiredSql();
    try {
      const [ligne] = await db<{ resultat: { connection_id: string; status: string } }[]>`
        select saas_business.bg_record_integration_failure(
          ${input.userId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.connectorKey},
          ${input.errorCode},
          ${input.errorMessage},
          ${input.durationMs}::integer
        ) as resultat
      `;
      return {
        connectionId: String(ligne?.resultat?.connection_id ?? ''),
        status: String(ligne?.resultat?.status ?? 'error'),
      };
    } finally {
      await db.end().catch(() => {});
    }
  },

  async markDisconnected(userId: string, workspaceId: string, connectorKey: string) {
    void userId;
    // La RPC relit l'identité côté base (`auth.uid()`) et exige le droit
    // d'écriture sur l'entreprise : `userId` n'est ici qu'un rappel de qui
    // appelle, il n'est jamais utilisé comme preuve.
    const db = requiredSql();
    try {
      const [ligne] = await db<{ resultat: unknown }[]>`
        select saas_business.bg_disconnect_integration(
          ${userId}::uuid, ${workspaceId}::uuid, ${connectorKey}
        ) as resultat
      `;
      return ligne?.resultat ?? null;
    } finally {
      await db.end().catch(() => {});
    }
  },

  async readConnection(userId: string, workspaceId: string, connectorKey: string) {
    // `userId` n'est pas passé à la RPC, volontairement : la RPC lit
    // `auth.uid()` elle-même, donc un identifiant fourni par l'appelant ne
    // peut pas la détourner vers une autre entreprise.
    void userId;
    const db = requiredSql();
    try {
      const [ligne] = await db<{ etat: unknown }[]>`
        select public.vyora_ugc_store_connection(${workspaceId}::uuid, ${connectorKey}) as etat
      `;
      return ligne?.etat ?? null;
    } finally {
      await db.end().catch(() => {});
    }
  },

  resolveHost,

  fetchImpl: pinnedFetchLike(egress, {
    accept: 'application/json',
    // Un catalogue PrestaShop avec déclinaisons dépasse largement 256 Kio :
    // la lecture doit tenir, sinon les gros catalogues échoueraient seuls.
    maxBytes: 8 * 1024 * 1024,
  }),

  log: (message, detail) => {
    // Aucun secret ne peut arriver ici : les appelants ne transmettent que des
    // codes et des compteurs.
    console.error(message, detail ?? {});
  },
};

// `Deno.serve` lu sur `globalThis` pour la même raison que `env` : le fichier
// doit rester vérifiable par `tsc` sans les types Deno.
const runtime = (globalThis as unknown as {
  Deno: { serve(handler: (request: Request) => Promise<Response>): unknown };
}).Deno;

runtime.serve((request: Request) =>
  handleStoreConnect(request, deps, { allowedOrigins: ALLOWED_ORIGINS }),
);

/**
 * Traduit un code d'erreur de la RPC en message affichable.
 *
 * Les codes viennent de `bg_save_custom_api_connection`, qui les émet en
 * `connect_invalid:CODE`. On ne renvoie jamais le message brut de Postgres :
 * il contient le nom de la fonction et parfois des valeurs.
 */
function messagePourCode(code: string): string {
  switch (code) {
    case 'PROBE_REQUIRED':
      return 'Testez l’API avec succès avant d’enregistrer cette configuration.';
    case 'NO_PRODUCTS_FOUND':
      return 'L’API a répondu, mais aucun produit n’a été trouvé : vérifiez le chemin des produits.';
    case 'CREDENTIAL_REF_REQUIRED':
      return 'Aucune clé n’est enregistrée pour cette API.';
    case 'BASE_URL_REQUIRED':
      return 'L’adresse de base doit commencer par https://.';
    case 'MAPPING_REQUIRED':
      return 'La correspondance des champs est absente.';
    case 'MAPPING_NAME_REQUIRED':
      return 'Le champ « nom du produit » doit être associé : sans lui, aucun produit ne peut être importé.';
    case 'PRICE_UNIT_REQUIRED':
      return 'L’unité des prix doit être précisée.';
    case 'CONNECTION_REQUIRED':
      return 'La connexion doit être testée avant d’être configurée.';
    case 'WORKSPACE_ACCESS_DENIED':
      return 'Droits insuffisants sur cette entreprise.';
    case 'SUBSCRIPTION_REQUIRED':
    case 'SUBSCRIPTION_EXPIRED':
      return 'Un abonnement Business Ground actif est requis.';
    default:
      return 'La configuration n’a pas pu être enregistrée.';
  }
}
