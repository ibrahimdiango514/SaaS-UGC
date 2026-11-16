// @vitest-environment node
/**
 * Integration Engine — garanties fondatrices.
 *
 * Ce fichier protège le contrat avant qu'un seul fournisseur réel ne soit
 * branché. C'est volontaire : le coût d'un connecteur mal formé découvert en
 * production (bouton actif, appel sans jeton, secret dans une URL) est bien
 * supérieur au coût de ces tests maintenant.
 */
import { describe, expect, it } from 'vitest';
import {
  capabilitiesSatisfied,
  connectorError,
  effectiveCapabilities,
  isConnectorAvailable,
  OAUTH_BASE_CAPABILITIES,
  type ConnectorAdapter,
} from '../src/integrations/engine/contract';
import {
  CATALOG_CONNECTOR_KEYS,
  ConnectorRegistrationError,
  ConnectorRegistry,
  assertValidConnector,
  connectorRegistry,
  implementedKeys,
  unimplementedKeys,
} from '../src/integrations/engine/registry';
import {
  assertVerifier,
  buildAuthorizeUrl,
  challengeS256,
  generateState,
  generateVerifier,
  isS256Challenge,
  isValidStateShape,
} from '../src/integrations/engine/pkce';
import { INTEGRATIONS } from '../src/integrations/catalog';

function fakeAdapter(over: Partial<ConnectorAdapter> = {}): ConnectorAdapter {
  return {
    key: 'shopify',
    mode: 'oauth2',
    supportedCapabilities: ['read'],
    oauth: {
      authorizeUrl: 'https://shop.example/oauth/authorize',
      tokenUrl: 'https://shop.example/oauth/token',
      scopesFor: () => ['read_products'],
    },
    probe: async () => ({ ok: true, value: { ok: true, accountLabel: 'Boutique', scopes: ['read'] } }),
    revoke: async () => ({ ok: true, value: undefined }),
    ...over,
  };
}

describe('contrat — les capacités ne peuvent pas dépasser ce qui est accordé', () => {
  it('l’intersection est stricte, jamais l’union', () => {
    expect(effectiveCapabilities(['read', 'send', 'modify'], ['read', 'send'])).toEqual(['read', 'send']);
  });

  it('une capacité demandée mais non accordée est signalée, pas ignorée', () => {
    expect(capabilitiesSatisfied(['read', 'send'], ['read'])).toEqual(['send']);
  });

  it('aucune capacité accordée ne donne aucun droit', () => {
    expect(effectiveCapabilities(['read'], [])).toEqual([]);
  });

  it('le socle OAuth reste un sous-ensemble du contrat', () => {
    for (const capacité of OAUTH_BASE_CAPABILITIES) {
      expect(['read', 'draft', 'send', 'modify', 'write']).toContain(capacité);
    }
  });
});

describe('contrat — le refus par défaut', () => {
  it('un connecteur absent n’est jamais disponible', () => {
    expect(isConnectorAvailable(null)).toBe(false);
    expect(isConnectorAvailable(undefined)).toBe(false);
  });

  it('un objet partiel n’est pas un connecteur', () => {
    const partiel = { key: 'shopify' } as unknown as ConnectorAdapter;
    expect(isConnectorAvailable(partiel)).toBe(false);
  });

  it('un connecteur complet est disponible', () => {
    expect(isConnectorAvailable(fakeAdapter())).toBe(true);
  });
});

describe('erreurs — seule une panne transitoire est rejouable', () => {
  it('une erreur d’autorisation n’est pas rejouable', () => {
    expect(connectorError('unauthorized', 'jeton absent').retryable).toBe(false);
    expect(connectorError('forbidden', 'scope manquant').retryable).toBe(false);
    expect(connectorError('not_configured', 'client id absent').retryable).toBe(false);
  });

  it('un quota ou un incident réseau le sont', () => {
    expect(connectorError('rate_limited', 'trop de requêtes').retryable).toBe(true);
    expect(connectorError('network', 'connexion perdue').retryable).toBe(true);
    expect(connectorError('upstream_error', '500').retryable).toBe(true);
  });

  it('le message reste sûr : aucun jeton ne doit y figurer', () => {
    const erreur = connectorError('upstream_error', 'Erreur du fournisseur', { status: 502 });
    expect(erreur.message).not.toMatch(/token|secret|bearer/i);
    expect(erreur.status).toBe(502);
  });
});

describe('registre — un fournisseur inventé est refusé', () => {
  it('refuse une clé absente du catalogue', () => {
    expect(() => assertValidConnector(fakeAdapter({ key: 'fournisseur-imaginaire' })))
      .toThrow(ConnectorRegistrationError);
  });

  it('refuse un connecteur sans capacité', () => {
    expect(() => assertValidConnector(fakeAdapter({ supportedCapabilities: [] })))
      .toThrow(/sans capacité déclarée/);
  });

  it('refuse l’OAuth sans endpoints', () => {
    expect(() => assertValidConnector(fakeAdapter({ mode: 'oauth2', oauth: null })))
      .toThrow(/OAuth sans endpoints/);
  });

  it('refuse des endpoints OAuth sur un mode qui n’en a pas', () => {
    expect(() => assertValidConnector(fakeAdapter({ mode: 'api-key' })))
      .toThrow(/déclare OAuth en mode api-key/);
  });

  it('refuse un connecteur incomplet (sans probe ou revoke)', () => {
    const incomplet = { ...fakeAdapter(), probe: undefined } as unknown as ConnectorAdapter;
    expect(() => assertValidConnector(incomplet)).toThrow(/incomplet/);
  });

  it('un doublon est refusé, jamais écrasé silencieusement', () => {
    const registre = new ConnectorRegistry();
    registre.register(fakeAdapter());
    expect(() => registre.register(fakeAdapter())).toThrow(/déjà enregistré/);
  });

  it('un fournisseur non enregistré renvoie null, pas un substitut', () => {
    const registre = new ConnectorRegistry();
    expect(registre.get('shopify')).toBeNull();
    expect(registre.capabilitiesOf('shopify')).toEqual([]);
  });
});

describe('registre — la liste des clés reste alignée sur le catalogue', () => {
  it('les 26 clés du registre sont exactement celles du catalogue', () => {
    const catalogue = INTEGRATIONS.map((e) => e.id).sort();
    expect([...CATALOG_CONNECTOR_KEYS].sort()).toEqual(catalogue);
  });

  it('le registre global est vide au départ : aucune implémentation inventée', () => {
    expect(connectorRegistry.size()).toBe(0);
    expect(implementedKeys()).toEqual([]);
    // Les 26 fournisseurs sont donc non implémentés, sans exception.
    expect(unimplementedKeys()).toHaveLength(26);
  });
});

describe('PKCE — le vérifieur ne quitte jamais le serveur', () => {
  it('génère un vérifieur conforme à la RFC 7636', () => {
    const verifier = generateVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(() => assertVerifier(verifier)).not.toThrow();
  });

  it('produit des valeurs distinctes', () => {
    expect(generateVerifier()).not.toBe(generateVerifier());
  });

  it('refuse une entropie insuffisante', () => {
    expect(() => generateVerifier(new Uint8Array(16))).toThrow(/entropie/);
  });

  it('refuse un vérifieur trop court ou hors alphabet', () => {
    expect(() => assertVerifier('court')).toThrow(/invalide/);
    expect(() => assertVerifier('a'.repeat(60) + '!')).toThrow(/invalide/);
  });

  it('calcule une empreinte S256 de forme attendue', async () => {
    const verifier = 'a'.repeat(43);
    const challenge = await challengeS256(verifier);
    expect(challenge).toHaveLength(43);
    expect(isS256Challenge(challenge)).toBe(true);
    // Déterministe : même vérifieur, même empreinte.
    expect(await challengeS256(verifier)).toBe(challenge);
  });

  it('deux vérifieurs différents donnent deux empreintes différentes', async () => {
    expect(await challengeS256('a'.repeat(43))).not.toBe(await challengeS256('b'.repeat(43)));
  });
});

describe('state — opaque, jetable, jamais un identifiant utilisateur', () => {
  it('a une forme valide', () => {
    const state = generateState();
    expect(isValidStateShape(state)).toBe(true);
  });

  it('rejette les formes forgées avant tout accès en base', () => {
    expect(isValidStateShape(null)).toBe(false);
    expect(isValidStateShape('')).toBe(false);
    expect(isValidStateShape('trop-court')).toBe(false);
    expect(isValidStateShape('a'.repeat(200))).toBe(false);
    expect(isValidStateShape('a'.repeat(60) + ' ')).toBe(false);
  });
});

describe('URL d’autorisation — aucun secret ne doit y figurer', () => {
  const base = {
    authorizeUrl: 'https://fournisseur.example/oauth/authorize',
    clientId: 'client-public',
    redirectUri: 'https://app.example/oauth/callback',
    scopes: ['read', 'send'],
  };

  it('porte PKCE en S256 et le state', async () => {
    const state = generateState();
    const challenge = await challengeS256(generateVerifier());
    const url = new URL(buildAuthorizeUrl({ ...base, state, challenge }));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('read send');
  });

  it('refuse une URL non HTTPS', async () => {
    const url = { ...base, authorizeUrl: 'http://fournisseur.example/oauth', state: generateState(), challenge: await challengeS256(generateVerifier()) };
    expect(() => buildAuthorizeUrl(url)).toThrow(/HTTPS/);
  });

  it('refuse un state invalide et un défi non S256', async () => {
    const challenge = await challengeS256(generateVerifier());
    expect(() => buildAuthorizeUrl({ ...base, state: 'court', challenge })).toThrow(/state invalide/);
    expect(() => buildAuthorizeUrl({ ...base, state: generateState(), challenge: 'plain' })).toThrow(/S256/);
  });

  it('n’ajoute jamais client_secret, même si on le lui passe', async () => {
    const url = buildAuthorizeUrl({
      ...base,
      state: generateState(),
      challenge: await challengeS256(generateVerifier()),
      extra: { client_secret: 'ne-doit-pas-fuiter', access_type: 'offline' },
    });
    expect(url).not.toContain('ne-doit-pas-fuiter');
    expect(url).not.toContain('client_secret');
    // Les paramètres légitimes, eux, sont conservés.
    expect(new URL(url).searchParams.get('access_type')).toBe('offline');
  });
});
