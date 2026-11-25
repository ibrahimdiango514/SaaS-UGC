/**
 * SORAHNEX — catalogue des intégrations.
 *
 * ## Ce que ce fichier est, et n'est pas
 *
 * C'est un **catalogue déclaratif** : il décrit les fournisseurs, leurs
 * capacités et les permissions qu'ils exigent. Il ne contient aucun secret, et
 * ne prétend pas qu'une connexion est possible là où elle ne l'est pas.
 *
 * ## Le principe qui gouverne tout le fichier
 *
 * Chaque fournisseur déclare **le mode d'authentification réellement
 * disponible** et, s'il n'y en a aucun, la raison. Trois états en découlent,
 * calculés — jamais saisis à la main :
 *
 *   - `available`      : un mode de connexion existe et ses prérequis sont remplis ;
 *   - `needs_config`   : le mode existe mais les identifiants SORAHNEX manquent ;
 *   - `needs_approval` : le fournisseur exige une validation externe (Meta, TikTok…) ;
 *   - `unavailable`    : aucun mode légal n'existe pour l'instant.
 *
 * Un fournisseur sans mode de connexion **n'affiche pas** de bouton actif. C'est
 * la règle « ne jamais simuler une connexion », appliquée au niveau du modèle
 * plutôt que de l'interface : une fiche ne peut pas mentir sur son état, car
 * l'état n'est pas une donnée qu'on saisit, il est dérivé.
 *
 * ## Extension
 *
 * Ajouter un fournisseur ne demande aucune modification du moteur ni de
 * l'interface : il suffit d'ajouter une entrée dans `INTEGRATIONS`. Les
 * catégories, la recherche, les filtres et les fiches s'en déduisent.
 */

/** Familles affichées dans le catalogue. */
export type CatalogCategory = 'social' | 'commerce' | 'productivity' | 'business';

export const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  social: 'Réseaux sociaux',
  commerce: 'Boutiques en ligne',
  productivity: 'Productivité',
  business: 'Business et commerce',
};

export const CATEGORY_DESCRIPTIONS: Record<CatalogCategory, string> = {
  social: 'Publier, planifier et mesurer sur vos réseaux.',
  commerce: 'Importer vos produits, suivre commandes et stocks.',
  productivity: 'Messagerie, fichiers, agendas et documents.',
  business: 'CRM, facturation, paiements, stocks et commandes.',
};

/** Nature du mécanisme d'authentification. */
export type AuthMode =
  | 'oauth2'
  | 'api-key'
  | 'app-install'
  | 'public-catalog'
  | 'file-import'
  | 'none'
  /*
   * `custom-api` n'est pas un mode d'authentification à proprement parler :
   * c'est la marque d'une fiche dont l'utilisateur décrit lui-même la
   * connexion (adresse, en-tête, chemin, mapping). Il vit dans cette union
   * parce que `engine` et `auth[].mode` partagent le même vocabulaire, et parce
   * qu'un mode à part évite de faire croire qu'une simple clé suffirait.
   */
  | 'custom-api';

/** Ce qu'un fournisseur permet de faire une fois connecté. */
export type Capability =
  | 'account-read'
  | 'content-publish'
  | 'publication-schedule'
  | 'analytics-read'
  | 'catalog-read'
  | 'catalog-write'
  | 'orders-read'
  | 'inventory-read'
  | 'inventory-write'
  | 'messages-read'
  | 'messages-send'
  | 'files-read'
  | 'calendar-read'
  | 'calendar-write'
  | 'contacts-read';

export const CAPABILITY_LABELS: Record<Capability, string> = {
  'account-read': 'Lire les informations du compte',
  'content-publish': 'Publier du contenu',
  'publication-schedule': 'Planifier des publications',
  'analytics-read': 'Lire les statistiques',
  'catalog-read': 'Lire le catalogue produits',
  'catalog-write': 'Modifier les produits',
  'orders-read': 'Lire les commandes',
  'inventory-read': 'Lire les stocks',
  'inventory-write': 'Mettre à jour les stocks',
  'messages-read': 'Lire les messages',
  'messages-send': 'Envoyer des messages',
  'files-read': 'Lire les fichiers',
  'calendar-read': 'Lire les événements',
  'calendar-write': 'Créer des événements',
  'contacts-read': 'Lire les contacts',
};

/**
 * Prérequis d'un mode d'authentification.
 *
 * `configured` est renseigné à l'exécution à partir de la configuration réelle
 * (variables d'environnement côté serveur, drapeau d'approbation). Il n'est
 * jamais saisi en dur « true » pour faire joli.
 */
export interface AuthRequirement {
  mode: AuthMode;
  /** Libellé de ce que l'utilisateur devra fournir ou autoriser. */
  label: string;
  /** Nom de la variable serveur attendue, si le mode en dépend. */
  serverConfigKey?: string;
  /** Validation externe connue du fournisseur. */
  externalApproval?: string;
}

export interface IntegrationEntry {
  /** Identifiant stable, utilisé en base et par le futur moteur. */
  id: string;
  name: string;
  category: CatalogCategory;
  /** Description courte, affichée sur la fiche. */
  description: string;
  /** Ce que la connexion permettra réellement. */
  capabilities: Capability[];
  /** Modes d'authentification, du plus complet au plus simple. */
  auth: AuthRequirement[];
  /**
   * Mode effectivement utilisé par le moteur, quand il est implémenté.
   * `null` = aucun connecteur écrit : la fiche l'indique explicitement.
   */
  engine: AuthMode | null;
  /** Documentation officielle, pour que l'utilisateur puisse vérifier. */
  docsUrl?: string;
  /** Particularité à connaître avant de connecter. */
  caveat?: string;
}

/**
 * Le catalogue.
 *
 * `engine: null` partout au départ : la Livraison 2 construit le catalogue et
 * la couche d'état ; les connecteurs arrivent avec le moteur (Livraison 3).
 * Aucune fiche ne prétend donc être connectable tant que le moteur ne l'est pas.
 */
export const INTEGRATIONS: IntegrationEntry[] = [
  /* ------------------------------ Réseaux sociaux ------------------------ */
  {
    id: 'instagram',
    name: 'Instagram',
    category: 'social',
    description: 'Publications, stories et statistiques de votre compte professionnel.',
    capabilities: ['account-read', 'content-publish', 'publication-schedule', 'analytics-read'],
    auth: [
      {
        mode: 'oauth2',
        label: 'Compte professionnel Instagram relié à une page Facebook',
        serverConfigKey: 'META_APP_ID',
        externalApproval: 'App Review Meta : instagram_content_publish, pages_show_list',
      },
      {
        mode: 'public-catalog',
        label: 'Aucune alternative : la publication exige une autorisation Meta.',
      },
    ],
    engine: null,
    docsUrl: 'https://developers.facebook.com/docs/instagram-api',
    caveat: 'Compte professionnel obligatoire. L’approbation Meta conditionne la publication.',
  },
  {
    id: 'facebook',
    name: 'Facebook Pages',
    category: 'social',
    description: 'Publier sur vos pages et lire leurs statistiques.',
    capabilities: ['account-read', 'content-publish', 'publication-schedule', 'analytics-read'],
    auth: [
      {
        mode: 'oauth2',
        label: 'Page Facebook dont vous êtes administrateur',
        serverConfigKey: 'META_APP_ID',
        externalApproval: 'App Review Meta : pages_manage_posts, pages_read_engagement',
      },
    ],
    engine: null,
    docsUrl: 'https://developers.facebook.com/docs/pages-api',
    caveat: 'Rôle administrateur de la page requis.',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    category: 'social',
    description: 'Envoi de vidéos et consultation des performances.',
    capabilities: ['account-read', 'content-publish', 'analytics-read'],
    auth: [
      {
        mode: 'oauth2',
        label: 'Compte TikTok creator ou business',
        serverConfigKey: 'TIKTOK_CLIENT_KEY',
        externalApproval: 'Audit d’application TikTok : video.publish',
      },
    ],
    engine: null,
    docsUrl: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
    caveat: 'L’audit TikTok peut prendre plusieurs semaines. Aucun contournement n’est prévu.',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    category: 'social',
    description: 'Publication de vidéos et lecture des statistiques de chaîne.',
    capabilities: ['account-read', 'content-publish', 'analytics-read'],
    auth: [
      {
        mode: 'oauth2',
        label: 'Chaîne YouTube via un compte Google',
        serverConfigKey: 'GOOGLE_CLIENT_ID',
        externalApproval: 'Vérification Google : youtube.upload',
      },
      {
        mode: 'public-catalog',
        label: 'Lecture d’une chaîne publique sans connexion',
      },
    ],
    engine: null,
    docsUrl: 'https://developers.google.com/youtube/v3',
    caveat: 'Le quota Google limite le nombre d’envois quotidiens.',
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    category: 'social',
    description: 'Publications sur votre profil et vos pages entreprise.',
    capabilities: ['account-read', 'content-publish', 'analytics-read'],
    auth: [
      {
        mode: 'oauth2',
        label: 'Profil LinkedIn ou page entreprise',
        serverConfigKey: 'LINKEDIN_CLIENT_ID',
        externalApproval: 'Accès Marketing Developer Platform LinkedIn',
      },
    ],
    engine: null,
    docsUrl: 'https://learn.microsoft.com/linkedin/',
    caveat: 'L’accès API est restreint et soumis à candidature.',
  },
  {
    id: 'pinterest',
    name: 'Pinterest',
    category: 'social',
    description: 'Épingles, tableaux et statistiques.',
    capabilities: ['account-read', 'content-publish', 'analytics-read'],
    auth: [
      {
        mode: 'oauth2',
        label: 'Compte Pinterest',
        serverConfigKey: 'PINTEREST_APP_ID',
      },
    ],
    engine: null,
    docsUrl: 'https://developers.pinterest.com/',
  },

  /* -------------------------------- Boutiques ---------------------------- */
  {
    id: 'shopify',
    name: 'Shopify',
    category: 'commerce',
    /*
     * Capacités RÉELLES, pas souhaitées.
     *
     * `catalog-read` et `inventory-read` existent : `store-import` lit
     * `/products.json` et normalise les variantes.
     *
     * `catalog-write`, `inventory-write` et `orders-read` sont RETIRÉS : aucune
     * ligne de code ne les implémente, aucun moyen d'authentification n'existe
     * (voir `engine`), et `safe-egress.ts` refuse toute méthode autre que GET.
     * Les afficher revenait à promettre une écriture impossible.
     */
    description: 'Import du catalogue de votre boutique Shopify par l’API Admin (produits, variantes, stock).',
    /*
     * Ce qui est RÉELLEMENT implémenté, et rien de plus :
     *
     * - `catalog-read` et `inventory-read` : lus par l'API Admin, variantes et
     *   quantités comprises.
     * - `catalog-write`, `inventory-write` et `orders-read` restent RETIRÉS :
     *   aucune ligne de code ne les implémente, et `safe-egress.ts` refuse toute
     *   méthode autre que GET. Les annoncer promettrait une écriture impossible.
     *
     * L'authentification retenue est le **jeton d'application personnalisée**
     * (`shpat_…`), pas OAuth d'application publique : sans `SHOPIFY_API_SECRET`
     * côté serveur, un parcours OAuth échouerait dès la première redirection.
     * OAuth est donc absent de `auth`, et la fiche le dit.
     */
    capabilities: ['catalog-read', 'inventory-read'],
    auth: [
      {
        mode: 'api-key',
        label: 'Jeton d’API Admin d’une application personnalisée (shpat_…)',
      },
      {
        mode: 'public-catalog',
        label: 'Lecture du catalogue public via /products.json (sans connexion)',
      },
      {
        mode: 'file-import',
        label: 'Import d’un export CSV Shopify',
      },
    ],
    engine: 'api-key',
    docsUrl: 'https://shopify.dev/docs/api',
    caveat:
      'Lecture seule : SORAHNEX ne crée, ne modifie et ne supprime rien dans Shopify. Le jeton se révoque '
      + 'en désinstallant l’application. Les produits en brouillon et archivés sont écartés et comptés. '
      + 'Le catalogue public reste lisible sans connexion, pour les boutiques qui le publient.',
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    category: 'commerce',
    /*
     * Même raisonnement que Shopify, avec une différence : WooCommerce n'expose
     * que trois droits (lecture, écriture, suppression), sans scope par
     * ressource. On demande donc « Lecture » seule, et le client n'émet que des
     * `GET`. `orders-read` est RETIRÉ : aucune commande n'est lue, et les
     * commandes contiennent des données personnelles d'acheteurs.
     */
    description: 'Import du catalogue de votre site WooCommerce par l’API REST (produits, variations, stock).',
    capabilities: ['catalog-read', 'inventory-read'],
    auth: [
      {
        mode: 'api-key',
        label: 'Clés API REST WooCommerce (Consumer key + Consumer secret), droit « Lecture »',
      },
      {
        mode: 'file-import',
        label: 'Import d’un export CSV WooCommerce',
      },
    ],
    engine: 'api-key',
    docsUrl: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
    caveat:
      'Lecture seule : le droit « Lecture » suffit, et SORAHNEX n’émet que des requêtes de lecture. '
      + 'L’API REST exige des permaliens autres que « Simple » — sinon /wp-json/ renvoie 404. '
      + 'Aucune commande n’est lue : les commandes contiennent des données personnelles d’acheteurs.',
  },
  {
    id: 'prestashop',
    name: 'PrestaShop',
    category: 'commerce',
    description: 'Catalogue et stocks de votre boutique PrestaShop, lus par l’API Webservice.',
    /*
     * Capacités DÉCLARÉES par la fiche, donc vérifiables.
     *
     * `catalog-read` et `inventory-read` sont réellement fournis : l'import lit
     * `products`, `combinations`, `stock_availables`, `product_options` et
     * `product_option_values`, et la connexion n'est enregistrée qu'après une
     * lecture réussie de `shops` et `languages`.
     *
     * `orders-read` est retiré : le connecteur ne lit aucune commande. Une
     * capacité affichée mais non implémentée est une promesse fausse, et c'est
     * exactement ce que cette fiche ne doit pas faire.
     */
    capabilities: ['catalog-read', 'inventory-read'],
    auth: [
      { mode: 'api-key', label: 'Clé Webservice PrestaShop (droits de lecture sur le catalogue)' },
      { mode: 'file-import', label: 'Import d’un export CSV PrestaShop' },
    ],
    // Seul fournisseur dont le moteur est écrit : la clé est vérifiée par le
    // serveur, rangée dans Vault, et le catalogue est lu par l'API officielle.
    engine: 'api-key',
    docsUrl: 'https://devdocs.prestashop-project.org/',
    caveat: 'La clé Webservice se crée dans PrestaShop : Paramètres avancés → Webservice. Elle ne doit jamais transiter par le navigateur : SORAHNEX la vérifie et la range côté serveur.',
  },
  {
    id: 'chariow',
    name: 'Chariow',
    category: 'commerce',
    description: 'Catalogue de votre boutique Chariow, lu par l’API officielle (clé de boutique).',
    /*
     * Capacités DÉCLARÉES, donc vérifiables.
     *
     * `catalog-read` et `inventory-read` sont réellement fournis : l'import lit
     * `GET /v1/products` et `GET /v1/store`, et la connexion n'est enregistrée
     * qu'après une lecture réussie des deux.
     *
     * `orders-read` est volontairement ABSENT : le connecteur ne lit aucune
     * commande, et les scopes demandés au marchand (`store.read`,
     * `products.read`) ne le permettraient pas. Une capacité affichée mais non
     * implémentée est une promesse fausse.
     *
     * `catalog-write` est absent pour la même raison, en plus fort : Chariow
     * n'est utilisé qu'en lecture, et le code n'a aucun chemin d'écriture.
     */
    capabilities: ['catalog-read', 'inventory-read'],
    auth: [
      {
        mode: 'api-key',
        label: 'Clé de boutique Chariow — scopes `store.read` et `products.read` uniquement',
      },
      { mode: 'file-import', label: 'Import d’un export CSV de vos produits' },
    ],
    // Moteur réellement écrit : la clé est vérifiée par le serveur en lisant
    // `GET /v1/store` puis `GET /v1/products`, rangée dans Vault, et le
    // catalogue est lu par l'API officielle.
    engine: 'api-key',
    docsUrl: 'https://chariow.dev',
    caveat:
      'La clé se crée dans app.chariow.com → Settings → API Keys, et n’est affichée qu’une seule fois. '
      + 'Cochez uniquement « store.read » et « products.read » : SORAHNEX n’a besoin d’aucun autre droit. '
      + 'Chariow n’expose pas les variantes détaillées ni de SKU : les produits à tarifs par variante sont importés '
      + 'comme des fiches simples, avec un avertissement dans l’aperçu.',
  },
  {
    id: 'magento',
    name: 'Magento / Adobe Commerce',
    category: 'commerce',
    description: 'Catalogue, commandes et stocks Magento.',
    capabilities: ['catalog-read', 'orders-read', 'inventory-read'],
    auth: [
      { mode: 'api-key', label: 'Jeton d’intégration Magento', serverConfigKey: 'MAGENTO_ALLOW_KEYS' },
      { mode: 'file-import', label: 'Import CSV Magento' },
    ],
    engine: null,
    docsUrl: 'https://developer.adobe.com/commerce/webapi/',
  },
  {
    id: 'opencart',
    name: 'OpenCart',
    category: 'commerce',
    description: 'Import des produits de votre boutique OpenCart par export, ou par API personnalisée.',
    /*
     * `orders-read` est RETIRÉ et `catalog-read` ne s'applique PAS à une API
     * OpenCart : celle-ci est à session (login + cookie, `api_token` en
     * paramètre d'URL) et le cœur d'OpenCart n'expose AUCUNE route produits.
     * Il n'y a donc rien à connecter nativement — le dire ici évite d'envoyer
     * l'utilisateur chercher une clé qui ne lui donnerait pas ses produits.
     */
    capabilities: [],
    auth: [
      { mode: 'file-import', label: 'Import d’un export CSV, XLSX ou XML OpenCart' },
    ],
    engine: null,
    docsUrl: 'https://docs.opencart.com/',
    caveat:
      'L’API d’OpenCart est à session et n’expose pas le catalogue : il n’existe pas de clé permettant '
      + 'd’importer les produits. Utilisez un export CSV, ou le connecteur « API personnalisée » si vous '
      + 'disposez d’une extension exposant vos produits en JSON.',
  },
  {
    id: 'wix',
    name: 'Wix',
    category: 'commerce',
    description: 'Catalogue Wix Stores.',
    capabilities: ['catalog-read', 'orders-read'],
    auth: [
      { mode: 'api-key', label: 'Clé API Wix', serverConfigKey: 'WIX_API_KEY' },
      { mode: 'public-catalog', label: 'Catalogue public Wix Stores' },
    ],
    engine: null,
    docsUrl: 'https://dev.wix.com/docs/rest',
  },
  {
    id: 'bigcommerce',
    name: 'BigCommerce',
    category: 'commerce',
    description: 'Catalogue et commandes BigCommerce.',
    capabilities: ['catalog-read', 'orders-read', 'inventory-read'],
    auth: [
      { mode: 'api-key', label: 'Jeton API BigCommerce', serverConfigKey: 'BIGCOMMERCE_API_KEY' },
      { mode: 'file-import', label: 'Import CSV BigCommerce' },
    ],
    engine: null,
    docsUrl: 'https://developer.bigcommerce.com/docs',
  },
  {
    id: 'squarespace',
    name: 'Squarespace',
    category: 'commerce',
    description: 'Produits et commandes Squarespace.',
    capabilities: ['catalog-read', 'orders-read'],
    auth: [
      { mode: 'api-key', label: 'Clé API Squarespace Commerce', serverConfigKey: 'SQUARESPACE_API_KEY' },
      { mode: 'file-import', label: 'Import CSV Squarespace' },
    ],
    engine: null,
    docsUrl: 'https://developers.squarespace.com/commerce-apis',
    caveat: 'L’accès API Commerce est réservé aux offres compatibles.',
  },
  {
    id: 'ecwid',
    name: 'Ecwid',
    category: 'commerce',
    description: 'Catalogue et commandes Ecwid.',
    capabilities: ['catalog-read', 'orders-read'],
    auth: [
      { mode: 'api-key', label: 'Jeton secret Ecwid', serverConfigKey: 'ECWID_API_KEY' },
      { mode: 'public-catalog', label: 'Catalogue public Ecwid' },
    ],
    engine: null,
    docsUrl: 'https://api-docs.ecwid.com/',
  },
  {
    /*
     * « Autre plateforme » n'est pas une plateforme : c'est le connecteur qui
     * permet de décrire la sienne. Il a donc ses propres règles.
     *
     * - `capabilities: ['catalog-read']` — une seule, et elle est réelle : la
     *   configuration n'ouvre que la lecture du catalogue. Rien d'autre n'est
     *   codé, donc rien d'autre n'est annoncé.
     * - `engine: 'custom-api'` — moteur distinct, pas `api-key` : il n'y a pas
     *   UNE clé à demander mais une description complète à recueillir. Un
     *   formulaire générique de clé n'aurait aucun sens ici.
     * - Pas de `caveat` rassurant : celui-ci dit exactement ce qui est
     *   attendu de l'utilisateur, y compris quand il n'a pas d'API.
     */
    id: 'custom-api',
    name: 'Autre plateforme (API personnalisée)',
    category: 'commerce',
    description: 'Connectez une boutique dont l’API expose vos produits en JSON.',
    capabilities: ['catalog-read'],
    auth: [
      { mode: 'custom-api', label: 'URL de l’API, mode d’authentification et correspondance des champs' },
    ],
    engine: 'custom-api',
    caveat:
      'Nécessite une API HTTPS qui renvoie vos produits en JSON. SORAHNEX lit la première page, '
      + 'propose une correspondance des champs, et n’enregistre rien avant un test réussi. '
      + 'Si votre boutique n’expose pas d’API, utilisez l’import d’un export CSV : il n’existe '
      + 'aucun moyen d’inventer les produits d’un site qui ne les publie pas.',
  },

  /* ------------------------------- Productivité -------------------------- */
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'productivity',
    description: 'Lire, classer et rédiger des messages.',
    capabilities: ['account-read', 'messages-read', 'messages-send'],
    auth: [
      {
        mode: 'oauth2',
        label: 'Compte Google',
        serverConfigKey: 'GOOGLE_CLIENT_ID',
        externalApproval: 'Vérification Google pour gmail.send et gmail.readonly',
      },
    ],
    engine: null,
    docsUrl: 'https://developers.google.com/gmail/api',
    caveat: 'Les scopes sensibles Gmail exigent une vérification Google en production.',
  },
  {
    id: 'google_drive',
    name: 'Google Drive',
    category: 'productivity',
    description: 'Parcourir et récupérer vos fichiers.',
    capabilities: ['account-read', 'files-read'],
    auth: [
      { mode: 'oauth2', label: 'Compte Google', serverConfigKey: 'GOOGLE_CLIENT_ID' },
    ],
    engine: null,
    docsUrl: 'https://developers.google.com/drive/api',
  },
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    category: 'productivity',
    description: 'Consulter et créer des événements.',
    capabilities: ['account-read', 'calendar-read', 'calendar-write'],
    auth: [
      { mode: 'oauth2', label: 'Compte Google', serverConfigKey: 'GOOGLE_CLIENT_ID' },
    ],
    engine: null,
    docsUrl: 'https://developers.google.com/calendar/api',
  },
  {
    id: 'microsoft365',
    name: 'Microsoft 365',
    category: 'productivity',
    description: 'Outlook, OneDrive et calendrier Microsoft.',
    capabilities: ['account-read', 'messages-read', 'files-read', 'calendar-read'],
    auth: [
      {
        mode: 'oauth2',
        label: 'Compte professionnel Microsoft',
        serverConfigKey: 'MICROSOFT_CLIENT_ID',
        externalApproval: 'Enregistrement d’application Azure AD et consentement administrateur',
      },
    ],
    engine: null,
    docsUrl: 'https://learn.microsoft.com/graph/overview',
    caveat: 'Le consentement administrateur de votre organisation peut être nécessaire.',
  },
  {
    id: 'outlook',
    name: 'Outlook',
    category: 'productivity',
    description: 'Boîte mail Outlook personnelle ou professionnelle.',
    capabilities: ['account-read', 'messages-read', 'messages-send'],
    auth: [
      { mode: 'oauth2', label: 'Compte Microsoft', serverConfigKey: 'MICROSOFT_CLIENT_ID' },
    ],
    engine: null,
    docsUrl: 'https://learn.microsoft.com/graph/api/resources/mail-api-overview',
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'productivity',
    description: 'Messages et notifications de vos canaux.',
    capabilities: ['account-read', 'messages-read', 'messages-send'],
    auth: [
      {
        mode: 'oauth2',
        label: 'Installation de l’application sur votre espace Slack',
        serverConfigKey: 'SLACK_CLIENT_ID',
      },
    ],
    engine: null,
    docsUrl: 'https://api.slack.com/',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'productivity',
    description: 'Lire et enrichir vos pages et bases de données.',
    capabilities: ['account-read', 'files-read'],
    auth: [
      {
        mode: 'oauth2',
        label: 'Autorisation d’une intégration Notion',
        serverConfigKey: 'NOTION_CLIENT_ID',
      },
      { mode: 'api-key', label: 'Jeton d’intégration interne', serverConfigKey: 'NOTION_TOKEN' },
    ],
    engine: null,
    docsUrl: 'https://developers.notion.com/',
  },

  /* --------------------------------- Business ---------------------------- */
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'business',
    description: 'Contacts, entreprises et pipeline commercial.',
    capabilities: ['account-read', 'contacts-read'],
    auth: [
      {
        mode: 'oauth2',
        label: 'Application HubSpot installée sur votre compte',
        serverConfigKey: 'HUBSPOT_CLIENT_ID',
      },
      { mode: 'api-key', label: 'Jeton d’application privée', serverConfigKey: 'HUBSPOT_TOKEN' },
    ],
    engine: null,
    docsUrl: 'https://developers.hubspot.com/docs/api/overview',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'business',
    description: 'Paiements, factures et abonnements.',
    capabilities: ['account-read', 'orders-read'],
    auth: [
      { mode: 'api-key', label: 'Clé restreinte Stripe (lecture)', serverConfigKey: 'STRIPE_RESTRICTED_KEY' },
    ],
    engine: null,
    docsUrl: 'https://stripe.com/docs/api',
    caveat: 'Utilisez une clé restreinte en lecture, jamais la clé secrète complète.',
  },
  {
    id: 'saspay',
    name: 'SasPay',
    category: 'business',
    description: 'Encaissement mobile money déjà intégré à SORAHNEX.',
    capabilities: ['account-read', 'orders-read'],
    auth: [
      { mode: 'api-key', label: 'Clé marchand SasPay', serverConfigKey: 'SASPAY_API_KEY' },
    ],
    engine: null,
    docsUrl: 'https://saspay.com',
    caveat: 'Déjà utilisé pour les abonnements SORAHNEX ; le catalogue n’expose que la lecture.',
  },
  {
    id: 'odoo',
    name: 'Odoo',
    category: 'business',
    description: 'CRM, facturation, stocks et commandes.',
    capabilities: ['account-read', 'catalog-read', 'orders-read', 'inventory-read', 'contacts-read'],
    auth: [
      { mode: 'api-key', label: 'Clé API Odoo et URL de votre instance', serverConfigKey: 'ODOO_ALLOW_KEYS' },
      { mode: 'file-import', label: 'Import CSV Odoo' },
    ],
    engine: null,
    docsUrl: 'https://www.odoo.com/documentation/master/developer.html',
  },
];

/** Index par identifiant, pour les recherches ponctuelles. */
export const INTEGRATION_BY_ID: Record<string, IntegrationEntry> = Object.fromEntries(
  INTEGRATIONS.map((entry) => [entry.id, entry]),
);

/** Nombre de fournisseurs par catégorie. */
export function countByCategory(): Record<CatalogCategory, number> {
  const counts: Record<CatalogCategory, number> = { social: 0, commerce: 0, productivity: 0, business: 0 };
  for (const entry of INTEGRATIONS) counts[entry.category] += 1;
  return counts;
}

/**
 * Recherche dans le catalogue.
 *
 * Porte sur le nom, la description et les capacités : chercher « stocks » doit
 * remonter les boutiques qui gèrent l'inventaire, pas seulement celles dont le
 * nom contient le mot.
 */
export function searchIntegrations(
  entries: IntegrationEntry[],
  query: string,
  category: CatalogCategory | 'all',
): IntegrationEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (category !== 'all' && entry.category !== category) return false;
    if (!q) return true;
    const capacites = entry.capabilities.map((c) => CAPABILITY_LABELS[c].toLowerCase()).join(' ');
    return (
      entry.name.toLowerCase().includes(q)
      || entry.description.toLowerCase().includes(q)
      || capacites.includes(q)
      || CATEGORY_LABELS[entry.category].toLowerCase().includes(q)
    );
  });
}
