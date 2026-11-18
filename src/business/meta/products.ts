/**
 * VYORA Meta Integrations — définition des produits Meta connectables.
 *
 * Quatre fiches distinctes, un seul socle OAuth (application Meta « VYORA »,
 * App ID 1692282959171281, type Business). Chaque produit déclare :
 *
 * - le parcours d'autorisation RÉELLEMENT utilisé :
 *   - `embedded-signup` : WhatsApp Embedded Signup (SDK JavaScript Meta,
 *     `FB.login` avec `config_id`, `response_type: 'code'`) — Meta ne propose
 *     pas de variante par redirection pour l'inscription WhatsApp ;
 *   - `login-for-business` : Facebook Login for Business (boîte de dialogue
 *     `dialog/oauth` avec `config_id`, échange du code côté serveur) ;
 * - les permissions demandées — exactement celles listées dans la
 *   configuration Meta correspondante, pas une de plus ;
 * - les champs Webhook à abonner ;
 * - les variables serveur attendues (le secret d'application n'est jamais
 *   exposé : seul son NOM figure ici).
 *
 * Rien ici n'affirme qu'un produit est opérationnel : l'état vient de la
 * base, alimentée par un échange OAuth réel.
 */

export type MetaProduct = 'whatsapp' | 'facebook' | 'messenger' | 'instagram';

/**
 * Version du parcours WhatsApp Embedded Signup (paramètre `extras.version`).
 *
 * Meta a retiré v2 et v3 le 15 octobre 2026 ; v4 est la version de repli
 * implicite ; v5 est courante depuis le 20 octobre 2026. On l'épingle ici.
 */
export const META_EMBEDDED_SIGNUP_VERSION = 'v5';

export const META_PRODUCTS: readonly MetaProduct[] = ['whatsapp', 'facebook', 'messenger', 'instagram'];

export function isMetaProduct(value: unknown): value is MetaProduct {
  return typeof value === 'string' && (META_PRODUCTS as readonly string[]).includes(value);
}

export type MetaAuthFlow = 'embedded-signup' | 'login-for-business';

export interface MetaProductDefinition {
  key: MetaProduct;
  label: string;
  flow: MetaAuthFlow;
  /** Permissions Meta demandées lors de l'autorisation. */
  scopes: readonly string[];
  /** Variable serveur portant l'identifiant de configuration Meta (`config_id`). */
  configIdEnv: string;
  /** Objet Webhook Meta et champs à abonner. */
  webhook: { object: 'whatsapp_business_account' | 'page' | 'instagram'; fields: readonly string[] };
  /** Permissions soumises à App Review avant usage par des tiers. */
  advancedAccess: readonly string[];
}

export const META_PRODUCT_DEFINITIONS: Record<MetaProduct, MetaProductDefinition> = {
  whatsapp: {
    key: 'whatsapp',
    label: 'WhatsApp Business',
    flow: 'embedded-signup',
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    configIdEnv: 'META_WHATSAPP_CONFIG_ID',
    webhook: { object: 'whatsapp_business_account', fields: ['messages', 'message_template_status_update', 'account_update'] },
    advancedAccess: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  },
  facebook: {
    key: 'facebook',
    label: 'Facebook Pages',
    flow: 'login-for-business',
    scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_metadata', 'business_management'],
    configIdEnv: 'META_FACEBOOK_CONFIG_ID',
    webhook: { object: 'page', fields: ['feed'] },
    advancedAccess: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_metadata', 'business_management'],
  },
  messenger: {
    key: 'messenger',
    label: 'Messenger',
    flow: 'login-for-business',
    scopes: ['pages_show_list', 'pages_manage_metadata', 'pages_messaging', 'business_management'],
    configIdEnv: 'META_MESSENGER_CONFIG_ID',
    webhook: { object: 'page', fields: ['messages', 'messaging_postbacks', 'message_deliveries', 'message_reads'] },
    advancedAccess: ['pages_messaging', 'pages_show_list', 'pages_manage_metadata', 'business_management'],
  },
  instagram: {
    key: 'instagram',
    label: 'Instagram Business',
    flow: 'login-for-business',
    /*
     * Parcours retenu : « Instagram via Facebook Login » (compte professionnel
     * relié à une Page). Ce sont les permissions `instagram_*` de ce parcours,
     * pas celles de « Instagram API with Instagram Login »
     * (`instagram_business_*`), qui ne se mélangent pas.
     */
    scopes: ['pages_show_list', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights', 'business_management'],
    configIdEnv: 'META_INSTAGRAM_CONFIG_ID',
    webhook: { object: 'instagram', fields: ['comments'] },
    advancedAccess: ['instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights', 'pages_show_list', 'business_management'],
  },
};

/** Version de l'API Graph utilisée partout (serveur et SDK). */
/**
 * Version de l'API Graph utilisée pour tous les appels Meta.
 *
 * v21.0 était disponible jusqu'au 21 janvier 2027 (calendrier officiel Meta) :
 * une application neuve n'a aucune raison de naître sur une version qui expire
 * dans deux mois. v26.0 est la version courante ; elle est aussi celle citée par
 * la documentation Meta actuelle. La version est centralisée ici : une seule
 * ligne à changer lors des montées de version.
 */
export const META_GRAPH_VERSION = 'v26.0';

/** Noms des variables serveur. Les valeurs ne transitent jamais par le navigateur. */
export const META_SERVER_ENV = {
  appId: 'META_APP_ID',
  appSecret: 'META_APP_SECRET',
  webhookVerifyToken: 'META_WEBHOOK_VERIFY_TOKEN',
  /** Racine publique du SaaS, pour le retour après autorisation. */
  appUrl: 'VYORA_APP_URL',
} as const;

/**
 * Produits partageant un même jeton utilisateur Facebook : Facebook Pages,
 * Messenger et Instagram passent tous par Login for Business. Une seule
 * connexion `facebook` peut donc porter les trois, mais chaque fiche garde son
 * propre enregistrement, ses propres permissions accordées et son propre état.
 */
export function flowOf(product: MetaProduct): MetaAuthFlow {
  return META_PRODUCT_DEFINITIONS[product].flow;
}

/** Permissions manquantes par rapport à la définition du produit. */
export function missingScopes(product: MetaProduct, granted: readonly string[]): string[] {
  const accordees = new Set(granted);
  return META_PRODUCT_DEFINITIONS[product].scopes.filter((s) => s !== 'business_management' && !accordees.has(s));
}
