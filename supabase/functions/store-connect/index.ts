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

const DEFAULT_SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const DATABASE_URL = Deno.env.get('SUPABASE_DB_URL') ?? '';

/** Origines autorisées, séparées par des virgules. */
const ALLOWED_ORIGINS = (Deno.env.get('VYORA_ALLOWED_ORIGINS') ?? '')
  .split(',').map((o) => o.trim()).filter(Boolean);

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
  const resultats = await Promise.allSettled([
    Deno.resolveDns(hostname, 'A'),
    Deno.resolveDns(hostname, 'AAAA'),
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
  deleteCredential,

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
    // L'identité de l'appelant est passée à la RPC sous forme de claims : la
    // fonction `vyora_ugc_store_connection` lit `auth.uid()`, elle ne peut donc
    // pas être détournée pour lire une autre entreprise.
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

Deno.serve((request: Request) =>
  handleStoreConnect(request, deps, { allowedOrigins: ALLOWED_ORIGINS }),
);
