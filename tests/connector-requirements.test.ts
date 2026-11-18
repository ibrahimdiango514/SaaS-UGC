/**
 * Phase A — exigences déclaratives par connecteur.
 *
 * Ce que ces tests protègent :
 *  1. aucune plateforme ne peut afficher un formulaire si son parcours de
 *     connexion n'existe pas (`hasConnectFlow`) ;
 *  2. les champs déclarés couvrent exactement ce que l'Edge Function attend ;
 *  3. un état serveur n'est jamais traduit en « connectée » sans preuve ;
 *  4. la validation de forme refuse les saisies dangereuses (sauts de ligne,
 *     `http://`, schémas non publics).
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_STATE_LABELS,
  CONNECTOR_REQUIREMENTS,
  deriveConnectionState,
  hasConnectFlow,
  isComplete,
  requirementsFor,
  validateConnectorInput,
  validateField,
  type ConnectorRequirement,
} from '../src/business/importer/connector-requirements';

describe('registre des exigences de connexion', () => {
  it('ne déclare que des connecteurs réellement déployés', () => {
    // Cette liste est un garde-fou : elle ne doit croissance qu'avec un
    // parcours de connexion livré et testé côté Edge Function.
    expect(Object.keys(CONNECTOR_REQUIREMENTS).sort()).toEqual(['chariow', 'prestashop', 'shopify', 'woocommerce']);
  });

  it('`hasConnectFlow` est faux pour tout le reste du catalogue', () => {
    // Shopify et WooCommerce ont désormais un parcours : ils SORTENT de cette
    // liste. Ce qui reste n'a réellement aucun formulaire livré.
    for (const cle of ['opencart', 'magento', 'wix', 'squarespace', 'ecwid', 'bigcommerce']) {
      expect(hasConnectFlow(cle), cle).toBe(false);
      expect(requirementsFor(cle), cle).toBeNull();
    }
  });

  it('Shopify et WooCommerce déclarent un parcours complet et cohérent', () => {
    for (const cle of ['shopify', 'woocommerce']) {
      const exigence = requirementsFor(cle);
      expect(exigence, cle).not.toBeNull();
      // Un champ d'adresse ET au moins un secret : sans les deux, aucune
      // connexion n'est vérifiable.
      expect(exigence!.fields.some((f) => f.name === 'url')).toBe(true);
      expect(exigence!.fields.some((f) => f.secret)).toBe(true);
      // Aucun champ secret ne doit être facultatif.
      for (const champ of exigence!.fields.filter((f) => f.secret)) {
        expect(champ.required, `${cle}/${champ.name}`).toBe(true);
      }
      expect(exigence!.capabilities.catalogRead).toBe(true);
      // Lecture seule : aucune capacité d'écriture n'existe dans le type, et
      // ces connecteurs ne doivent rien annoncer d'autre.
      expect(exigence!.setupHint.length).toBeGreaterThan(20);
    }
  });

  it('WooCommerce demande DEUX secrets, Shopify un seul', () => {
    // Le formulaire générique envoie le dernier secret comme `apiKey` et le
    // premier comme `apiSecret` : la distinction est structurante.
    expect(requirementsFor('woocommerce')!.fields.filter((f) => f.secret)).toHaveLength(2);
    expect(requirementsFor('shopify')!.fields.filter((f) => f.secret)).toHaveLength(1);
  });

  it('ne se laisse pas tromper par une clé du prototype', () => {
    // `in` aurait renvoyé true pour `toString` : un bug classique qui ferait
    // apparaître un formulaire vide.
    expect(hasConnectFlow('toString')).toBe(false);
    expect(hasConnectFlow('__proto__')).toBe(false);
  });

  it('chaque exigence porte une clé cohérente avec son entrée', () => {
    for (const [cle, exigence] of Object.entries(CONNECTOR_REQUIREMENTS)) {
      expect(exigence.key, cle).toBe(cle);
      expect(exigence.label.length, cle).toBeGreaterThan(0);
      expect(exigence.setupHint.length, cle).toBeGreaterThan(20);
      expect(exigence.docsUrl.startsWith('https://'), cle).toBe(true);
      expect(exigence.fields.length, cle).toBeGreaterThan(0);
    }
  });

  it('chaque connecteur déclare au moins un champ secret requis', () => {
    for (const [cle, exigence] of Object.entries(CONNECTOR_REQUIREMENTS)) {
      const secrets = exigence.fields.filter((champ) => champ.secret);
      expect(secrets.length, cle).toBeGreaterThan(0);
      expect(secrets.some((champ) => champ.required), cle).toBe(true);
    }
  });

  it('aucun champ non secret ne peut porter un nom de secret', () => {
    for (const [cle, exigence] of Object.entries(CONNECTOR_REQUIREMENTS)) {
      for (const champ of exigence.fields) {
        if (/key|secret|token|password/i.test(champ.name)) {
          expect(champ.secret, `${cle}.${champ.name}`).toBe(true);
        }
      }
    }
  });

  it('PrestaShop exige une URL, Chariow non', () => {
    const prestashop = requirementsFor('prestashop')!;
    const chariow = requirementsFor('chariow')!;
    expect(prestashop.apiLocation).toBe('shop');
    expect(prestashop.fields.map((f) => f.name)).toEqual(['url', 'apiKey']);
    expect(chariow.apiLocation).toBe('hosted');
    expect(chariow.fields.map((f) => f.name)).toEqual(['apiKey']);
    // Le formulaire générique s'appuie sur `url` : son absence doit être une
    // information, pas une erreur.
    expect(chariow.fields.some((f) => f.name === 'url')).toBe(false);
  });

  it('les capacités déclarées ne promettent pas de variantes là où l’API n’en publie pas', () => {
    expect(requirementsFor('chariow')!.capabilities.variants).toBe(false);
    expect(requirementsFor('chariow')!.capabilities.sku).toBe(false);
    expect(requirementsFor('prestashop')!.capabilities.variants).toBe(true);
    expect(requirementsFor('prestashop')!.capabilities.sku).toBe(true);
  });

  it('aucun connecteur ne déclare de capacité d’écriture', () => {
    // Les deux Edge Functions n'émettent que des GET ; `pinnedFetchLike` refuse
    // toute autre méthode. Déclarer une écriture serait une promesse fausse.
    for (const [cle, exigence] of Object.entries(CONNECTOR_REQUIREMENTS)) {
      const cles = Object.keys(exigence.capabilities).join(' ');
      expect(cles, cle).not.toMatch(/write|modify|delete/i);
    }
  });

  it('Chariow documente sa limite sur les variantes', () => {
    expect(requirementsFor('chariow')!.caveat).toMatch(/variante/i);
    // PrestaShop n'a pas de limitation équivalente : un caveat vide est honnête.
    expect(requirementsFor('prestashop')!.caveat).toBeUndefined();
  });
});

describe('dérivation de l’état de connexion', () => {
  it('sans aucun enregistrement, non configurée', () => {
    expect(deriveConnectionState(null)).toBe('not-configured');
    expect(deriveConnectionState(undefined)).toBe('not-configured');
    expect(deriveConnectionState({})).toBe('not-configured');
  });

  it('`disconnected` est un état voulu, pas une erreur', () => {
    expect(deriveConnectionState({ status: 'disconnected' })).toBe('not-configured');
    expect(deriveConnectionState({ status: 'unconfigured' })).toBe('not-configured');
  });

  it('`pending` reste en attente', () => {
    expect(deriveConnectionState({ status: 'pending' })).toBe('pending');
    expect(deriveConnectionState({ status: 'requested' })).toBe('pending');
  });

  it('connectée seulement si le serveur le dit ET qu’un secret existe', () => {
    expect(deriveConnectionState({ status: 'connected', hasCredential: true })).toBe('connected');
    // Ligne laissée par une ancienne demande d'activation, sans clé en Vault :
    // l'afficher « connectée » ferait échouer l'import sans explication.
    expect(deriveConnectionState({ status: 'connected', hasCredential: false })).toBe('auth-error');
    expect(deriveConnectionState({ status: 'connected' })).toBe('auth-error');
    expect(
      deriveConnectionState({ status: 'connected' }, { hasSecretWhenUnknown: true }),
    ).toBe('connected');
  });

  it('distingue « identifiants refusés » de « droits insuffisants »', () => {
    expect(deriveConnectionState({ status: 'error', lastErrorCode: 'AUTH_INVALID' })).toBe('auth-error');
    expect(deriveConnectionState({ status: 'error', lastErrorCode: 'INSUFFICIENT_SCOPE' })).toBe('insufficient-scope');
    expect(deriveConnectionState({ status: 'error', lastError: 'Autorisation insuffisante : ajoutez products.read' })).toBe('insufficient-scope');
    expect(deriveConnectionState({ status: 'error', lastError: 'La clé a été refusée par l’éditeur.' })).toBe('auth-error');
  });

  it('une erreur non qualifiée reste une erreur d’authentification', () => {
    // Seul geste possible pour l'utilisateur : régénérer la clé.
    expect(deriveConnectionState({ status: 'error' })).toBe('auth-error');
    expect(deriveConnectionState({ status: 'error', lastError: 'inattendu' })).toBe('auth-error');
  });

  it('`expired` est reconnu', () => {
    expect(deriveConnectionState({ status: 'expired' })).toBe('expired');
  });

  it('chaque état a un libellé', () => {
    for (const etat of ['not-configured', 'pending', 'connected', 'auth-error', 'insufficient-scope', 'expired'] as const) {
      expect(CONNECTION_STATE_LABELS[etat].length).toBeGreaterThan(0);
    }
  });
});

describe('validation de forme des champs', () => {
  const champUrl = requirementsFor('prestashop')!.fields[0];
  const champCle = requirementsFor('prestashop')!.fields[1];
  const champCleChariow = requirementsFor('chariow')!.fields[0];

  it('refuse http:// et les adresses incomplètes', () => {
    expect(validateField(champUrl, 'http://ma-boutique.com').ok).toBe(false);
    expect(validateField(champUrl, 'ma-boutique.com').ok).toBe(false);
    expect(validateField(champUrl, 'https://localhost').ok).toBe(false);
    expect(validateField(champUrl, 'https://ma-boutique.com').ok).toBe(true);
  });

  it('refuse les caractères de contrôle et les espaces', () => {
    expect(validateField(champCle, 'cle avec espace').ok).toBe(false);
    expect(validateField(champCle, 'cle\r\nX-Injected: 1').ok).toBe(false);
    expect(validateField(champCle, 'cle\u0000').ok).toBe(false);
  });

  it('refuse une clé trop courte', () => {
    expect(validateField(champCle, 'abc').ok).toBe(false);
    expect(validateField(champCle, '0123456789abcdef').ok).toBe(true);
  });

  it('exige le préfixe Chariow', () => {
    expect(validateField(champCleChariow, 'abc_dev_0123456789abcdef').ok).toBe(false);
    expect(validateField(champCleChariow, 'sk_live_0123456789abcdef').ok).toBe(true);
    expect(validateField(champCleChariow, 'sk_live_court').ok).toBe(false);
  });

  it('un champ requis vide est une erreur, un champ optionnel vide non', () => {
    expect(validateField(champUrl, '').ok).toBe(false);
    expect(validateField({ ...champUrl, required: false }, '').ok).toBe(true);
  });

  it('un champ requis composé d’espaces est vide', () => {
    expect(validateField(champUrl, '   ').ok).toBe(false);
  });

  it('`validateConnectorInput` nomme les champs fautifs', () => {
    const exigence = requirementsFor('prestashop')!;
    const resultat = validateConnectorInput(exigence, { url: 'http://interdit', apiKey: 'x' });
    expect(resultat.ok).toBe(false);
    expect(Object.keys(resultat.errors).sort()).toEqual(['apiKey', 'url']);

    const bon = validateConnectorInput(exigence, {
      url: 'https://ma-boutique.com',
      apiKey: '0123456789abcdef',
    });
    expect(bon).toEqual({ ok: true, errors: {} });
  });

  it('`isComplete` ignore les champs optionnels', () => {
    const exigence: ConnectorRequirement = requirementsFor('prestashop')!;
    expect(isComplete(exigence, {})).toBe(false);
    expect(isComplete(exigence, { url: 'https://a.com' })).toBe(false);
    expect(isComplete(exigence, { url: 'https://a.com', apiKey: 'k' })).toBe(true);
  });

  it('Chariow n’exige qu’un seul champ', () => {
    expect(isComplete(requirementsFor('chariow')!, {})).toBe(false);
    expect(isComplete(requirementsFor('chariow')!, { apiKey: 'sk_live_0123456789abcdef' })).toBe(true);
  });
});
