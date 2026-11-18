/**
 * VYORA — registre des connecteurs.
 *
 * ## Rôle
 *
 * Une seule table de vérité : quels fournisseurs possèdent réellement une
 * implémentation. Le catalogue frontend décrit 30 fournisseurs ; ce registre
 * dit lesquels fonctionnent. **Les deux ne doivent jamais être confondus.**
 *
 * ## Règle d'enregistrement
 *
 * `register()` refuse tout connecteur :
 *   - dont la clé n'existe pas dans le catalogue (fournisseur inventé) ;
 *   - qui ne déclare pas au moins une capacité ;
 *   - qui déclare une capacité qu'il ne sait pas exercer (mode sans OAuth ne
 *     peut pas prétendre à un scope) ;
 *   - en mode OAuth sans endpoints complets.
 *
 * Ces refus sont volontairement des exceptions : un connecteur mal formé doit
 * casser au démarrage, pas produire un bouton inerte en production.
 */
import type { ConnectorAdapter, ConnectorCapability } from './contract';
import { isConnectorAvailable } from './contract';

/**
 * Clés du catalogue autorisées.
 *
 * Dupliquer cette liste est un choix assumé : le registre ne peut pas importer
 * `catalog.ts` côté Edge (module qui embarque des libellés d'interface). Un
 * test vérifie que les deux listes restent identiques — la duplication est donc
 * contrôlée plutôt que silencieuse.
 */
export const CATALOG_CONNECTOR_KEYS: readonly string[] = [
  'instagram', 'facebook', 'whatsapp', 'messenger', 'tiktok', 'youtube', 'linkedin', 'pinterest',
  'shopify', 'woocommerce', 'prestashop', 'chariow', 'magento', 'opencart', 'wix',
  'bigcommerce', 'squarespace', 'ecwid',
  // « Autre plateforme » : le connecteur que l'utilisateur décrit lui-même.
  // Il appartient au catalogue, mais n'a pas d'adaptateur au sens des autres —
  // sa configuration est une donnée, pas du code par fournisseur.
  'custom-api',
  'gmail', 'google_drive', 'google_calendar', 'microsoft365', 'outlook', 'slack', 'notion',
  'hubspot', 'stripe', 'saspay', 'odoo',
];

export class ConnectorRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorRegistrationError';
  }
}

/** Valide un connecteur avant de l'exposer. Lève en cas de contrat violé. */
export function assertValidConnector(adapter: ConnectorAdapter): void {
  if (!CATALOG_CONNECTOR_KEYS.includes(adapter.key)) {
    throw new ConnectorRegistrationError(
      `fournisseur inconnu du catalogue : ${adapter.key}`,
    );
  }
  if (adapter.supportedCapabilities.length === 0) {
    throw new ConnectorRegistrationError(
      `connecteur ${adapter.key} sans capacité déclarée`,
    );
  }
  if (adapter.mode === 'oauth2' && !adapter.oauth) {
    throw new ConnectorRegistrationError(
      `connecteur ${adapter.key} en OAuth sans endpoints`,
    );
  }
  if (adapter.mode !== 'oauth2' && adapter.oauth) {
    // Un mode sans OAuth qui déclare des endpoints OAuth est incohérent :
    // l'interface pourrait proposer une redirection qui n'existe pas.
    throw new ConnectorRegistrationError(
      `connecteur ${adapter.key} déclare OAuth en mode ${adapter.mode}`,
    );
  }
  if (typeof adapter.probe !== 'function' || typeof adapter.revoke !== 'function') {
    throw new ConnectorRegistrationError(
      `connecteur ${adapter.key} incomplet (probe et revoke requis)`,
    );
  }
}

export class ConnectorRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();

  /** Enregistre un connecteur validé. Un doublon est refusé, pas écrasé. */
  register(adapter: ConnectorAdapter): void {
    assertValidConnector(adapter);
    if (this.adapters.has(adapter.key)) {
      throw new ConnectorRegistrationError(`connecteur déjà enregistré : ${adapter.key}`);
    }
    this.adapters.set(adapter.key, adapter);
  }

  /** Le connecteur, ou `null` s'il n'existe pas. Jamais de substitut. */
  get(key: string): ConnectorAdapter | null {
    return this.adapters.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.adapters.has(key);
  }

  /**
   * Capacités effectivement exerçables pour une clé donnée.
   *
   * Renvoie un tableau vide pour un fournisseur non implémenté. C'est cette
   * valeur — et non le catalogue — qui doit décider de l'affichage d'une
   * action de connexion.
   */
  capabilitiesOf(key: string): ConnectorCapability[] {
    return this.adapters.get(key)?.supportedCapabilities ?? [];
  }

  keys(): string[] {
    return Array.from(this.adapters.keys()).sort();
  }

  size(): number {
    return this.adapters.size;
  }
}

/**
 * Registre partagé.
 *
 * Volontairement vide à la construction : les connecteurs sont ajoutés par
 * `registerAdapters()`, appelée explicitement. Un registre auto-alimenté
 * masquerait les fournisseurs réellement branchés.
 */
export const connectorRegistry = new ConnectorRegistry();

/** Clés du catalogue qui disposent réellement d'un connecteur. */
export function implementedKeys(registry: ConnectorRegistry = connectorRegistry): string[] {
  return registry.keys().filter((key) => isConnectorAvailable(registry.get(key)));
}

/** Clés du catalogue **sans** implémentation — donc sans connexion possible. */
export function unimplementedKeys(registry: ConnectorRegistry = connectorRegistry): string[] {
  const faits = new Set(implementedKeys(registry));
  return CATALOG_CONNECTOR_KEYS.filter((key) => !faits.has(key));
}
