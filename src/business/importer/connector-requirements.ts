/**
 * VYORA — exigences d'identification déclaratives, par connecteur.
 *
 * ## Le problème que ce fichier résout
 *
 * Jusqu'ici, chaque plateforme connectable coûtait un **composant React** :
 * `PrestashopConnectForm`, `ChariowConnectForm`, et un troisième demain. Or les
 * différences réelles entre deux connecteurs tiennent en quelques lignes :
 *
 * | | PrestaShop | Chariow |
 * |---|---|---|
 * | Champs | URL + clé Webservice | clé seule |
 * | Où vit l'API | chez le marchand | chez l'éditeur |
 * | Rôle de l'URL | adresse à interroger | confirmer la clé |
 *
 * Trois différences, un composant entier. Ce n'est pas tenable si l'objectif est
 * d'accepter « le plus grand nombre possible de plateformes » : le coût marginal
 * d'une plateforme doit être **une entrée dans ce fichier**, pas un écran.
 *
 * ## Ce qui reste propre à chaque connecteur, et pourquoi
 *
 * Le composant générique sait afficher des champs, valider leur forme, envoyer,
 * et rendre l'état. Il ne sait pas ce qu'est « une clé Chariow » : c'est le rôle
 * de `secretKinds` ci-dessous, qui décrit **la forme attendue**, jamais la
 * valeur. Aucun secret n'entre dans ce module.
 *
 * ## Règle de sécurité
 *
 * `fields` ne contient que des **descripteurs** : un nom, un libellé, une
 * forme. Aucune valeur, aucun exemple de clé réelle. Ce fichier est importé par
 * le navigateur ; il ne doit rien contenir qui puisse fuiter.
 */

/** Forme reconnue d'une valeur saisie. Contrôlée côté client ET serveur. */
export type FieldFormat =
  | 'url'
  | 'bearer-key'
  | 'api-key'
  | 'shop-domain'
  | 'account-id';

/** Descripteur d'un champ de connexion. Jamais une valeur. */
export interface ConnectorField {
  /** Nom logique — c'est aussi la clé envoyée à l'Edge Function. */
  name: string;
  label: string;
  /** Texte d'aide affiché sous le champ. */
  hint?: string;
  /** Exemple **fictif**, pour la forme seulement. */
  placeholder?: string;
  format: FieldFormat;
  /**
   * Champ secret : `type="password"`, et jamais réaffiché après enregistrement.
   * Un champ non secret (URL de boutique) reste visible, ce qui aide à vérifier.
   */
  secret: boolean;
  required: boolean;
}

/**
 * État d'une connexion, du point de vue de l'utilisateur.
 *
 * Distinct de `IntegrationStatus` (qui décrit la fiche dans le catalogue) :
 * ici, c'est l'état **d'une tentative de connexion**, celui qui décide quel
 * bouton afficher. Les deux existent parce qu'ils répondent à deux questions
 * différentes : « puis-je proposer ce fournisseur ? » et « où en est ma
 * connexion ? ».
 */
export type ConnectionState =
  | 'not-configured'
  | 'pending'
  | 'connected'
  | 'auth-error'
  | 'insufficient-scope'
  | 'expired';

export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  'not-configured': 'Non configurée',
  pending: 'Vérification en cours',
  connected: 'Connectée',
  'auth-error': 'Identifiants refusés',
  'insufficient-scope': 'Autorisations insuffisantes',
  expired: 'Connexion expirée',
};

/**
 * Ce qui est **réellement** possible pour un connecteur donné.
 *
 * Déclaré ici plutôt que déduit de la présence d'un bouton : une capacité
 * affichée sans code derrière est une promesse fausse (voir l'audit).
 */
export interface ConnectorCapabilities {
  /** Peut-on lire le catalogue et l'importer ? */
  catalogRead: boolean;
  /** Peut-on lire les stocks ? */
  inventoryRead: boolean;
  /**
   * L'API expose-t-elle des variantes détaillées ?
   *
   * `false` chez Chariow (booléen seul) et chez toute API personnalisée dont le
   * mapping ne les déclare pas. Sert à afficher un avertissement **avant**
   * l'import, pas après.
   */
  variants: boolean;
  /** L'API expose-t-elle une référence produit (SKU) ? */
  sku: boolean;
  /** L'API publie-t-elle un total de produits (pagination bornée connue) ? */
  totalKnown: boolean;
}

/** Définition complète d'un connecteur, du point de vue de l'interface. */
export interface ConnectorRequirement {
  /** Clé stable, identique à `connectorKey` et à `integration_providers`. */
  key: string;
  /** Nom affiché. */
  label: string;
  /**
   * Où vit l'API.
   *
   * `hosted` : chez l'éditeur, hôte fixe, l'URL de vitrine n'est qu'une preuve.
   * `shop`   : chez le marchand, l'URL **est** l'API et doit être résolue.
   */
  apiLocation: 'hosted' | 'shop';
  /** Champs à saisir, dans l'ordre d'affichage. */
  fields: ConnectorField[];
  capabilities: ConnectorCapabilities;
  /** Où créer la clé, en une phrase actionnable. */
  setupHint: string;
  /** Lien vers la documentation officielle. */
  docsUrl: string;
  /**
   * Limitation à connaître **avant** de connecter.
   *
   * Affichée dans la fiche et dans le formulaire. C'est ce qui distingue une
   * limite documentée d'une déception à l'usage.
   */
  caveat?: string;
}

/* -------------------------------------------------------------------------- */
/* Définitions                                                                */
/* -------------------------------------------------------------------------- */

const SEUIL_CLE = 8;

/**
 * Connecteurs dont la connexion est réellement implémentée et déployée.
 *
 * Cette liste est la **source de vérité de l'interface** : une fiche dont la clé
 * n'y figure pas n'affiche pas de formulaire de connexion, quel que soit son
 * `engine` dans le catalogue. C'est la garantie qu'aucun bouton mort n'existe.
 */
export const CONNECTOR_REQUIREMENTS: Record<string, ConnectorRequirement> = {
  prestashop: {
    key: 'prestashop',
    label: 'PrestaShop',
    apiLocation: 'shop',
    fields: [
      {
        name: 'url',
        label: 'Adresse de la boutique',
        hint: 'Racine de la boutique, en https. L’API est interrogée sur cette adresse.',
        placeholder: 'https://ma-boutique.com',
        format: 'url',
        secret: false,
        required: true,
      },
      {
        name: 'apiKey',
        label: 'Clé Webservice',
        hint: 'PrestaShop → Paramètres avancés → Webservice. Droits de lecture du catalogue suffisent.',
        placeholder: 'Clé Webservice',
        format: 'api-key',
        secret: true,
        required: true,
      },
    ],
    capabilities: {
      catalogRead: true,
      inventoryRead: true,
      // Les déclinaisons SONT lues (combinations + stock_availables).
      variants: true,
      // `reference` est lue et sert au rapprochement.
      sku: true,
      // `Content-Range` publie le total.
      totalKnown: true,
    },
    setupHint: 'Créez une clé dans PrestaShop → Paramètres avancés → Webservice, avec les droits de lecture.',
    docsUrl: 'https://devdocs.prestashop-project.org/',
  },

  chariow: {
    key: 'chariow',
    label: 'Chariow',
    apiLocation: 'hosted',
    fields: [
      {
        name: 'apiKey',
        label: 'Clé API de boutique',
        hint: 'app.chariow.com → Settings → API Keys. Cochez uniquement « products.read » et « store.read ». Affichée une seule fois.',
        placeholder: 'sk_live_…',
        format: 'bearer-key',
        secret: true,
        required: true,
      },
    ],
    capabilities: {
      catalogRead: true,
      inventoryRead: true,
      // `has_variant_pricing` est un booléen : aucune variante détaillée.
      variants: false,
      // Aucun SKU publié par l'API.
      sku: false,
      // Pas de total : la pagination est un curseur sans compte annoncé.
      totalKnown: false,
    },
    setupHint: 'Créez une clé dans app.chariow.com → Settings → API Keys, avec « products.read » et « store.read » seulement.',
    docsUrl: 'https://chariow.dev',
    caveat:
      'Chariow n’expose ni variantes détaillées ni référence produit : les produits à tarifs par variante sont '
      + 'importés comme des fiches simples, avec un avertissement. Les produits non publiés (brouillon, suspendu) sont écartés.',
  },
};

/** Vrai si ce connecteur a un parcours de connexion réellement déployé. */
export function hasConnectFlow(connectorKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_REQUIREMENTS, connectorKey);
}

/** Exigences d'un connecteur, ou `null` s'il n'est pas connectable. */
export function requirementsFor(connectorKey: string): ConnectorRequirement | null {
  return CONNECTOR_REQUIREMENTS[connectorKey] ?? null;
}

/* -------------------------------------------------------------------------- */
/* États de connexion                                                          */
/* -------------------------------------------------------------------------- */

/** Ce que l'Edge Function renvoie à propos d'une connexion. */
export interface RawConnectionState {
  status?: string | null;
  connected?: boolean | null;
  lastError?: string | null;
  lastErrorCode?: string | null;
  hasCredential?: boolean | null;
  checkedAt?: string | null;
}

/**
 * Traduit l'état serveur en état affichable.
 *
 * ## Pourquoi cette fonction existe
 *
 * Le serveur dit `connected` / `error` / `disconnected`. L'utilisateur, lui, a
 * besoin de distinguer **« je n'ai jamais configuré »** de **« ma clé a été
 * refusée »** et de **« mes droits sont insuffisants »** : les trois gestes à
 * faire sont différents (configurer / régénérer / cocher un scope). Un seul
 * statut « erreur » oblige à deviner.
 *
 * ## Règle de prudence
 * `connected` n'est vrai que si le serveur le dit **et** qu'un secret existe.
 * Une ligne `status = 'connected'` sans clé en Vault (ancienne demande
 * d'activation) ne doit jamais s'afficher comme connectée.
 */
export function deriveConnectionState(
  raw: RawConnectionState | null | undefined,
  options: { hasSecretWhenUnknown?: boolean } = {},
): ConnectionState {
  if (!raw) return 'not-configured';

  const statut = String(raw.status ?? '').trim().toLowerCase();
  if (!statut || statut === 'unconfigured' || statut === 'disconnected') {
    // `disconnected` est un état VOULU : la configuration a été retirée.
    return 'not-configured';
  }

  if (statut === 'pending' || statut === 'requested') return 'pending';

  if (statut === 'expired') return 'expired';

  if (statut === 'connected') {
    // La clé doit réellement exister. `hasCredential` vient de la RPC ; à
    // défaut, on retombe sur l'option explicite de l'appelant, jamais sur une
    // supposition optimiste.
    // `hasCredential` quand la RPC le fournit ; sinon `connected`, que le
    // serveur ne met à vrai que si un secret existe réellement ; en dernier
    // recours seulement, l'information transmise par l'écran hôte.
    const aUneCle = raw.hasCredential ?? raw.connected ?? options.hasSecretWhenUnknown ?? false;
    return aUneCle ? 'connected' : 'auth-error';
  }

  if (statut === 'error') {
    const code = String(raw.lastErrorCode ?? '').toUpperCase();
    const message = String(raw.lastError ?? '').toLowerCase();
    if (
      code.includes('SCOPE') || code.includes('FORBIDDEN')
      || message.includes('scope') || message.includes('permission')
      || message.includes('autorisation')
    ) {
      return 'insufficient-scope';
    }
    if (
      code.includes('AUTH') || code.includes('TOKEN') || code.includes('KEY')
      || message.includes('clé') || message.includes('key') || message.includes('refus')
    ) {
      return 'auth-error';
    }
    // Une erreur non qualifiée reste une erreur d'authentification du point de
    // vue de l'utilisateur : c'est le seul geste qu'il peut tenter.
    return 'auth-error';
  }

  return 'pending';
}

/* -------------------------------------------------------------------------- */
/* Validation côté navigateur                                                  */
/* -------------------------------------------------------------------------- */

export interface FieldValidation {
  ok: boolean;
  /** Message affichable, absent quand `ok`. */
  error?: string;
}

/**
 * Valide la FORME d'une valeur saisie.
 *
 * Ce contrôle est un confort : il évite un aller-retour réseau pour une faute
 * visible. Il ne remplace **jamais** celui du serveur, qui reste seul juge de la
 * validité réelle (une clé bien formée peut être révoquée).
 */
export function validateField(field: ConnectorField, value: string): FieldValidation {
  const saisie = value.trim();

  if (!saisie) {
    return field.required ? { ok: false, error: `${field.label} est requis.` } : { ok: true };
  }
  if (/[\s\u0000-\u001f\u007f]/.test(saisie)) {
    return { ok: false, error: `${field.label} contient un espace ou un caractère invisible.` };
  }

  switch (field.format) {
    case 'url': {
      let url: URL;
      try {
        url = new URL(saisie);
      } catch {
        return { ok: false, error: `${field.label} doit être une adresse complète (https://…).` };
      }
      if (url.protocol !== 'https:') {
        return { ok: false, error: `${field.label} doit commencer par https://.` };
      }
      if (!url.hostname.includes('.')) {
        return { ok: false, error: `${field.label} ne désigne pas un domaine public.` };
      }
      return { ok: true };
    }

    case 'bearer-key':
      if (!saisie.startsWith('sk_') && !saisie.startsWith('pk_')) {
        return { ok: false, error: `${field.label} ne semble pas valide (elle commence par « sk_ »).` };
      }
      if (saisie.length < 20) {
        return { ok: false, error: `${field.label} semble incomplète.` };
      }
      return { ok: true };

    case 'api-key':
      if (saisie.length < SEUIL_CLE) {
        return { ok: false, error: `${field.label} doit contenir au moins ${SEUIL_CLE} caractères.` };
      }
      return { ok: true };

    case 'shop-domain':
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(saisie)) {
        return { ok: false, error: `${field.label} doit être un domaine (ex. ma-boutique.com).` };
      }
      return { ok: true };

    case 'account-id':
      if (!/^[A-Za-z0-9_-]{3,64}$/.test(saisie)) {
        return { ok: false, error: `${field.label} contient des caractères inattendus.` };
      }
      return { ok: true };

    default:
      return { ok: true };
  }
}

/** Valide tous les champs d'un connecteur. Rend les erreurs par nom de champ. */
export function validateConnectorInput(
  requirement: ConnectorRequirement,
  values: Record<string, string>,
): { ok: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  for (const field of requirement.fields) {
    const resultat = validateField(field, values[field.name] ?? '');
    if (!resultat.ok && resultat.error) errors[field.name] = resultat.error;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Vrai si la saisie est complète (sans juger de sa validité). */
export function isComplete(requirement: ConnectorRequirement, values: Record<string, string>): boolean {
  return requirement.fields
    .filter((f) => f.required)
    .every((f) => (values[f.name] ?? '').trim().length > 0);
}
