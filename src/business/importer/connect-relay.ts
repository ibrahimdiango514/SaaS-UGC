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

/**
 * Connecteurs dont la connexion est réellement implémentée.
 *
 * Le type est fermé volontairement : ajouter un fournisseur au catalogue sans
 * avoir écrit son parcours de connexion ne doit pas compiler ici. Une fiche
 * cliquable qui échouerait à la première requête serait un bouton mort.
 */
export type StoreConnectorKey = 'prestashop' | 'chariow' | 'shopify' | 'woocommerce';

/** État d'une connexion boutique, tel que le serveur le décrit. */
export interface StoreConnectionState {
  connectorKey: string;
  /** `connected` une fois la vérification réussie. */
  status: string;
  /**
   * Vrai seulement si le statut vaut `connected` **et** qu'une clé est
   * réellement enregistrée.
   *
   * La RPC distingue les deux : une ligne laissée par une ancienne demande
   * d'activation, sans secret, ne doit pas s'afficher comme connectée.
   */
  connected?: boolean;
  connectedTo: string | null;
  endpoint: string | null;
  shopName: string | null;
  version: string | null;
  totalProducts: number | null;
  resourcesRead: string[];
  /**
   * URL publique de la boutique, quand l'éditeur la publie (Chariow).
   * Absente pour PrestaShop, dont l'API appartient au marchand.
   */
  storeUrl?: string | null;
  /** Statut de la boutique chez l'éditeur (`active`, `suspended`…). */
  storeStatus?: string | null;
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
  /** Hôte réellement contacté — preuve du contrôle de sortie. */
  connectedTo: string;
  endpoint: string;
  durationMs: number;
  /** Boutique annoncée par l'éditeur (Chariow : `GET /v1/store`). */
  storeUrl?: string | null;
  storeStatus?: string | null;
  storeId?: string | null;
}

/**
 * Connecte une boutique.
 *
 * ## Ce que le navigateur envoie
 * Une adresse (PrestaShop) et/ou une clé. **Rien d'autre.**
 *
 * ## Ce qu'il ne reçoit jamais
 * La clé, son nom de secret, un jeton. Le serveur la dépose dans Vault et
 * répond uniquement des faits observés (nom de boutique, ressources lues,
 * hôte contacté).
 *
 * ## Pourquoi `url` est facultative
 * PrestaShop expose son API **chez le marchand** : sans adresse, il n'y a rien
 * à interroger, elle est donc obligatoire côté serveur. Chariow expose son API
 * **chez l'éditeur** (`api.chariow.com`) : l'adresse de la vitrine ne sert
 * qu'à confirmer que la clé appartient bien à cette boutique. Le type le dit,
 * et le serveur refuse une adresse absente là où elle est indispensable.
 */
export async function connectStore(input: {
  workspaceId: string;
  connectorKey: StoreConnectorKey;
  url?: string;
  apiKey: string;
  /**
   * Second secret, quand le connecteur en exige deux.
   *
   * Seul WooCommerce est dans ce cas (Consumer key + Consumer secret). Le champ
   * reste facultatif : l'absence est valide pour tous les autres connecteurs, et
   * le serveur refuse explicitement si le connecteur choisi l'exige.
   */
  apiSecret?: string;
}): Promise<StoreConnectionResult> {
  const { data } = await invokeEdge<{ data: StoreConnectionResult }>('store-connect', {
    action: 'connect',
    workspaceId: input.workspaceId,
    connectorKey: input.connectorKey,
    ...(input.url ? { url: input.url } : {}),
    apiKey: input.apiKey,
    ...(input.apiSecret ? { apiSecret: input.apiSecret } : {}),
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
  connectorKey: StoreConnectorKey;
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
  connectorKey: StoreConnectorKey;
}): Promise<void> {
  await invokeEdge<{ data: unknown }>('store-connect', {
    action: 'disconnect',
    workspaceId: input.workspaceId,
    connectorKey: input.connectorKey,
  });
}
