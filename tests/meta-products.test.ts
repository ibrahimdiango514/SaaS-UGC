import { describe, expect, it } from 'vitest';
import {
  META_EMBEDDED_SIGNUP_VERSION,
  META_GRAPH_VERSION,
  META_PRODUCT_DEFINITIONS,
  META_PRODUCTS,
  META_SERVER_ENV,
  flowOf,
  isMetaProduct,
  missingScopes,
} from '../src/business/meta/products';

/**
 * Définitions des quatre produits Meta.
 *
 * Ce que ces tests protègent : les permissions demandées doivent être
 * EXACTEMENT celles déclarées dans la configuration Meta, et le parcours
 * d'autorisation doit correspondre à ce que chaque produit sait faire. Un scope
 * en trop fait échouer la revue Meta ; un scope en moins fait échouer le
 * parcours en production, après approbation.
 */

describe('produits Meta — le parcours correspond au produit', () => {
  it('WhatsApp passe par Embedded Signup, les trois autres par Login for Business', () => {
    expect(flowOf('whatsapp')).toBe('embedded-signup');
    expect(flowOf('facebook')).toBe('login-for-business');
    expect(flowOf('messenger')).toBe('login-for-business');
    expect(flowOf('instagram')).toBe('login-for-business');
  });

  it('les quatre produits ont une fiche et une seule', () => {
    expect([...META_PRODUCTS].sort()).toEqual(['facebook', 'instagram', 'messenger', 'whatsapp']);
    for (const produit of META_PRODUCTS) {
      expect(META_PRODUCT_DEFINITIONS[produit].key).toBe(produit);
      expect(META_PRODUCT_DEFINITIONS[produit].label.length).toBeGreaterThan(3);
    }
  });

  it('reconnaît une clé de produit valide et refuse le reste', () => {
    expect(isMetaProduct('whatsapp')).toBe(true);
    expect(isMetaProduct('whatsapp_BUSINESS')).toBe(false);
    expect(isMetaProduct('tiktok')).toBe(false);
    expect(isMetaProduct(null)).toBe(false);
    expect(isMetaProduct(42)).toBe(false);
  });
});

describe('produits Meta — permissions exactes', () => {
  it('WhatsApp demande les deux permissions Cloud API', () => {
    expect(META_PRODUCT_DEFINITIONS.whatsapp.scopes).toEqual([
      'whatsapp_business_management',
      'whatsapp_business_messaging',
    ]);
  });

  it('Facebook Pages demande les quatre permissions de page', () => {
    expect(META_PRODUCT_DEFINITIONS.facebook.scopes).toEqual(expect.arrayContaining([
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'pages_manage_metadata',
    ]));
  });

  it('Messenger ajoute pages_messaging et ne demande pas pages_manage_posts', () => {
    expect(META_PRODUCT_DEFINITIONS.messenger.scopes).toContain('pages_messaging');
    // Publier une publication de page n'est pas le sujet de Messenger.
    expect(META_PRODUCT_DEFINITIONS.messenger.scopes).not.toContain('pages_manage_posts');
    // Sans pages_show_list, aucune page ne peut être listée.
    expect(META_PRODUCT_DEFINITIONS.messenger.scopes).toContain('pages_show_list');
  });

  it('Instagram n’utilise QUE les permissions du parcours Facebook Login', () => {
    const scopes = [...META_PRODUCT_DEFINITIONS.instagram.scopes];
    /*
     * « Instagram via Facebook Login » : permissions `instagram_*`. Les
     * `instagram_business_*` appartiennent à « Instagram API with Instagram
     * Login » — un autre enchaînement OAuth, avec un autre jeton. Les mélanger
     * échoue au moment de l'échange.
     */
    for (const scope of ['instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights']) {
      expect(scopes).toContain(scope);
    }
    expect(scopes.some((s) => s.startsWith('instagram_business_'))).toBe(false);
    // La Page est le point d'entrée du parcours : elle doit être lisible.
    expect(scopes).toContain('pages_show_list');
  });

  it('aucun scope n’est demandé en double', () => {
    for (const produit of META_PRODUCTS) {
      const scopes = META_PRODUCT_DEFINITIONS[produit].scopes;
      expect(new Set(scopes).size).toBe(scopes.length);
    }
  });

  it('les scopes sont tous des permissions Meta connues (sans préfixe inventé)', () => {
    const connus = /^(whatsapp_business_(management|messaging)|pages_(show_list|read_engagement|manage_posts|manage_metadata|messaging)|business_management|instagram_(basic|content_publish|manage_comments|manage_insights))$/;
    for (const produit of META_PRODUCTS) {
      for (const scope of META_PRODUCT_DEFINITIONS[produit].scopes) {
        expect(scope, `${produit} : ${scope}`).toMatch(connus);
      }
    }
  });

  it('missingScopes signale ce qui manque, sans compter business_management', () => {
    // `business_management` est optionnel : son absence ne bloque pas la fiche.
    expect(missingScopes('facebook', ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_metadata'])).toEqual([]);
    expect(missingScopes('facebook', ['pages_show_list'])).toEqual(['pages_read_engagement', 'pages_manage_posts', 'pages_manage_metadata']);
    expect(missingScopes('whatsapp', [])).toEqual(['whatsapp_business_management', 'whatsapp_business_messaging']);
  });
});

describe('produits Meta — champs Webhook et configuration serveur', () => {
  it('chaque produit déclare l’objet Webhook et ses champs', () => {
    expect(META_PRODUCT_DEFINITIONS.whatsapp.webhook.object).toBe('whatsapp_business_account');
    expect(META_PRODUCT_DEFINITIONS.whatsapp.webhook.fields).toContain('messages');
    // Messenger et Pages partagent l'objet `page` mais pas les mêmes champs.
    expect(META_PRODUCT_DEFINITIONS.facebook.webhook.object).toBe('page');
    expect(META_PRODUCT_DEFINITIONS.facebook.webhook.fields).toContain('feed');
    expect(META_PRODUCT_DEFINITIONS.messenger.webhook.object).toBe('page');
    expect(META_PRODUCT_DEFINITIONS.messenger.webhook.fields).toContain('messages');
    expect(META_PRODUCT_DEFINITIONS.instagram.webhook.object).toBe('instagram');
    expect(META_PRODUCT_DEFINITIONS.instagram.webhook.fields).toContain('comments');
  });

  it('chaque produit a sa variable de configuration, distincte', () => {
    const variables = META_PRODUCTS.map((p) => META_PRODUCT_DEFINITIONS[p].configIdEnv);
    expect(new Set(variables).size).toBe(4);
    for (const variable of variables) expect(variable).toMatch(/^META_[A-Z]+_CONFIG_ID$/);
  });

  it('les permissions avancées annoncées sont celles du produit', () => {
    for (const produit of META_PRODUCTS) {
      const definition = META_PRODUCT_DEFINITIONS[produit];
      for (const scope of definition.advancedAccess) {
        expect(definition.scopes, `${produit} : ${scope}`).toContain(scope);
      }
    }
  });

  it('la version Graph est fixe et le nom des secrets serveur ne contient aucun secret', () => {
    expect(META_GRAPH_VERSION).toMatch(/^v\d+\.\d+$/);
    /*
     * v21.0 était disponible jusqu'au 21 janvier 2027 (calendrier officiel
     * Meta) : naître dessus pour une application neuve serait une dette
     * immédiate. On fige donc une version au moins égale à v22.0, et une
     * version Embedded Signup explicitement déclarée (v2/v3 retirés le
     * 15 octobre 2026).
     */
    expect(Number(META_GRAPH_VERSION.slice(1).split('.')[0])).toBeGreaterThanOrEqual(22);
    expect(META_EMBEDDED_SIGNUP_VERSION).toMatch(/^v\d+(-public-preview)?$/);
    expect(Number(META_EMBEDDED_SIGNUP_VERSION.slice(1).split('-')[0])).toBeGreaterThanOrEqual(4);
    expect(META_SERVER_ENV.appSecret).toBe('META_APP_SECRET');
    // Le NOM du secret, jamais sa valeur : ce module part au navigateur.
    expect(JSON.stringify(META_SERVER_ENV)).not.toMatch(/[A-Za-z0-9]{32,}/);
  });
});
