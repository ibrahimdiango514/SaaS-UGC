/**
 * Client de l'Edge Function `store-connect`.
 *
 * ## Ce que le navigateur envoie, et ce qu'il ne reçoit jamais
 * Il envoie l'adresse de la boutique et la clé Webservice, une fois, au moment
 * de la connexion. La clé part sur HTTPS vers l'Edge Function, qui la dépose
 * dans Vault et n'en renvoie **rien** : ni la clé, ni son nom de secret, ni un
 * jeton. Les appels suivants (aperçu, import) n'ont plus besoin de la clé.
 *
 * ## Aucune connexion depuis le navigateur
 * Comme pour l'import, le navigateur ne contacte jamais la boutique : c'est le
 * serveur qui résout le DNS, refuse les adresses internes et établit la
 * connexion épinglée. Le résultat affiché (`connectedTo`, `endpoint`) est la
 * preuve de ce qui a été contacté, pas une promesse.
 */
import { invokeEdge } from '../../lib/api';

/** État d'une connexion boutique, tel que le serveur le décrit. */
export interface StoreConnectionState {
  connectorKey: string;
  /** `connected` une fois la vérification réussie. */
  status: string;
  connectedTo: string | null;
  endpoint: string | null;
  shopName: string | null;
  version: string | null;
  totalProducts: number | null;
  resourcesRead: string[];
  /** Dernière vérification, si le serveur en conserve une. */
  checkedAt: string | null;
  /** Message d'échec lisible, quand la dernière tentative a échoué. */
  lastError: string | null;
}

/** Résultat d'une connexion vérifiée (`action: 'connect'`). */
export interface StoreConnectionResult {
  connectorKey: string;
  status: string;
  connected: boolean;
  shopName: string | null;
  version: string | null;
  totalProducts: number | null;
  resourcesRead: string[];
  connectedTo: string;
  endpoint: string;
  durationMs: number;
}

/**
 * Connecte une boutique PrestaShop.
 *
 * La clé n'est jamais conservée côté navigateur : elle n'est pas stockée dans
 * un état React au-delà de la saisie, et n'est pas relue ensuite. C'est le
 * serveur qui la retrouve dans Vault pour les aperçus.
 */
export async function connectStore(input: {
  workspaceId: string;
  connectorKey: 'prestashop';
  url: string;
  apiKey: string;
}): Promise<StoreConnectionResult> {
  const { data } = await invokeEdge<{ data: StoreConnectionResult }>('store-connect', {
    action: 'connect',
    workspaceId: input.workspaceId,
    connectorKey: input.connectorKey,
    url: input.url,
    apiKey: input.apiKey,
  });
  return data;
}

/**
 * Lit l'état de la connexion, sans secret.
 *
 * Sert à afficher « connecté » (ou la dernière erreur) quand l'utilisateur
 * revient sur l'écran : il ne doit pas avoir à ressaisir sa clé pour savoir où
 * il en est.
 */
export async function readConnection(input: {
  workspaceId: string;
  connectorKey: 'prestashop';
}): Promise<StoreConnectionState | null> {
  const { data } = await invokeEdge<{ data: StoreConnectionState | null }>('store-connect', {
    action: 'status',
    workspaceId: input.workspaceId,
    connectorKey: input.connectorKey,
  });
  return data;
}

/**
 * Déconnecte la boutique et supprime le secret associé.
 *
 * L'aperçu échouera ensuite avec `CONNECTION_REQUIRED` : c'est voulu, une
 * déconnexion doit réellement retirer l'accès.
 */
export async function disconnectStore(input: {
  workspaceId: string;
  connectorKey: 'prestashop';
}): Promise<void> {
  await invokeEdge<{ data: unknown }>('store-connect', {
    action: 'disconnect',
    workspaceId: input.workspaceId,
    connectorKey: input.connectorKey,
  });
}
