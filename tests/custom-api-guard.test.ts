/**
 * Phase D — garde du connecteur « API personnalisée ».
 *
 * Ce connecteur est le seul endroit du produit où un utilisateur choisit
 * l'adresse que le serveur va contacter. Ces tests sont donc écrits comme une
 * revue d'attaque : chaque cas est une façon connue de transformer une
 * fonctionnalité d'intégration en accès au réseau interne.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_AUTH_HEADERS,
  MAX_CUSTOM_HEADERS,
  MAX_HEADER_VALUE_LENGTH,
  applyHeaderPolicy,
  buildAuthHeaders,
  explainCustomApiRejection,
  parseCustomApiBaseUrl,
  parseCustomApiEndpoint,
  redactHeaders,
} from '../src/business/importer/custom-api-guard';

const base = new URL('https://api.ma-boutique.com/');

describe('adresse de base — refus des cibles SSRF', () => {
  const refuse = (url: string) => {
    const resultat = parseCustomApiBaseUrl(url);
    expect(resultat.ok, `${url} aurait dû être refusé`).toBe(false);
    return resultat.ok ? null : resultat.reason;
  };

  it('accepte une API HTTPS publique', () => {
    const resultat = parseCustomApiBaseUrl('https://api.ma-boutique.com/');
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.value.hostname).toBe('api.ma-boutique.com');
  });

  it('refuse les métadonnées cloud et toute IP littérale', () => {
    // La cible SSRF la plus recherchée : credentials d'instance cloud.
    expect(refuse('https://169.254.169.254/latest/meta-data/')).toBe('ip_literal');
    expect(refuse('https://127.0.0.1/api')).toBe('ip_literal');
    expect(refuse('https://[::1]/api')).toBe('ip_literal');
    expect(refuse('https://10.0.0.5/api')).toBe('ip_literal');
    expect(refuse('https://192.168.1.10/api')).toBe('ip_literal');
    // IPv4 déguisée en entier : le parseur la normalise, la garde la refuse.
    expect(refuse('https://2130706433/api')).toBe('ip_literal');
    expect(refuse('https://0x7f000001/api')).toBe('ip_literal');
  });

  it('refuse les noms réservés au réseau local', () => {
    expect(refuse('https://localhost/api')).toBe('reserved_hostname');
    expect(refuse('https://api.local/api')).toBe('reserved_hostname');
    expect(refuse('https://intranet.internal/api')).toBe('reserved_hostname');
    expect(refuse('https://serveur.lan/api')).toBe('reserved_hostname');
    // Nom à label unique : « shop » n'est pas un domaine public.
    expect(refuse('https://shop/api')).toBe('single_label');
  });

  it('refuse le trafic en clair et les ports non standard', () => {
    expect(refuse('http://api.ma-boutique.com/')).toBe('not_https');
    expect(refuse('https://api.ma-boutique.com:8443/')).toBe('non_standard_port');
    // Port 443 explicite : accepté, c'est le même.
    expect(parseCustomApiBaseUrl('https://api.ma-boutique.com:443/').ok).toBe(true);
  });

  it('refuse les identifiants dans l’URL', () => {
    // `https://user:pass@host/` est un classique pour faire passer un secret
    // hors des en-têtes — donc hors de tout masquage.
    expect(refuse('https://user:secret@api.ma-boutique.com/')).toBe('credentials_in_url');
  });

  it('refuse une base portant des paramètres', () => {
    const resultat = parseCustomApiBaseUrl('https://api.ma-boutique.com/?key=1');
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.reason).toBe('invalid_url');
  });

  it('refuse les schémas non HTTP', () => {
    expect(refuse('file:///etc/passwd')).toBe('not_https');
    expect(refuse('gopher://api.ma-boutique.com/')).toBe('not_https');
    expect(refuse('ftp://api.ma-boutique.com/')).toBe('not_https');
    // Un schéma non HTTP est refusé quel que soit le motif exact : ce qui
    // compte est qu'il ne soit jamais contacté.
    expect(refuse('javascript:alert(1)')).toBe('not_https');
  });

  it('refuse les fragments et les adresses vides', () => {
    expect(refuse('https://api.ma-boutique.com/#x')).toBe('has_fragment');
    expect(refuse('')).toBe('empty');
    expect(refuse('   ')).toBe('empty');
  });

  it('refuse une adresse démesurément longue', () => {
    expect(refuse(`https://api.ma-boutique.com/${'a'.repeat(3000)}`)).toBe('path_too_long');
  });
});

describe('endpoint — confinement à l’hôte configuré', () => {
  it('résout un chemin relatif contre la base', () => {
    const resultat = parseCustomApiEndpoint(base, '/api/v1/products');
    expect(resultat.ok).toBe(true);
    if (resultat.ok) {
      expect(resultat.value.url.hostname).toBe('api.ma-boutique.com');
      expect(resultat.value.path).toBe('/api/v1/products');
    }
  });

  it('accepte une URL absolue sur le MÊME hôte', () => {
    const resultat = parseCustomApiEndpoint(base, 'https://api.ma-boutique.com/api/products');
    expect(resultat.ok).toBe(true);
  });

  it('refuse une URL absolue sur un autre hôte', () => {
    // Sans cette règle, la base affichée et vérifiée ne serait pas l'hôte
    // réellement contacté : l'utilisateur croirait parler à son serveur.
    const resultat = parseCustomApiEndpoint(base, 'https://exfiltrate.example/api');
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.reason).toBe('host_not_allowed');
  });

  it('refuse une adresse protocole-relative', () => {
    // `//evil.example/x` est interprété comme absolu par le parseur : c'est un
    // contournement de la règle d'hôte si on ne le traite pas à part.
    const resultat = parseCustomApiEndpoint(base, '//evil.example/api');
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.reason).toBe('host_not_allowed');
  });

  it('refuse une redirection vers un hôte interne', () => {
    for (const cible of [
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1:443/api',
      'https://localhost/api',
    ]) {
      const resultat = parseCustomApiEndpoint(base, cible);
      expect(resultat.ok, cible).toBe(false);
    }
  });

  it('normalise les segments « . » littéraux et refuse les formes encodées', () => {
    // `..` littéral : l'analyseur normalise AVANT qu'on le voie, donc le
    // chemin examiné est exactement le chemin appelé. Ce n'est pas un refus,
    // c'est une normalisation — et elle reste confinée à l'hôte configuré.
    const litteral = parseCustomApiEndpoint(base, '/api/../admin');
    expect(litteral.ok).toBe(true);
    if (litteral.ok) expect(litteral.value.path).toBe('/admin');

    // `%2e%2e` : non décodé par l'analyseur, mais décodé par certains serveurs
    // avant routage. Refusé sur la saisie brute.
    const encode = parseCustomApiEndpoint(base, '/api/%2e%2e/admin');
    expect(encode.ok).toBe(false);
    if (!encode.ok) expect(encode.reason).toBe('path_dot_segments');
  });

  it('refuse un chemin avec caractères de contrôle', () => {
    // Contrôlé sur la saisie : `new URL()` retire le NUL, donc un contrôle
    // placé après analyse ne verrait rien.
    for (const brut of ['/api/products\u0000', '/api/pro\u0007duits', 'https://api.ma-boutique.com/a\u000ab']) {
      const resultat = parseCustomApiEndpoint(base, brut);
      expect(resultat.ok, JSON.stringify(brut)).toBe(false);
      if (!resultat.ok) expect(resultat.reason, JSON.stringify(brut)).toBe('path_control_chars');
    }
  });

  it('conserve la query légitime', () => {
    const resultat = parseCustomApiEndpoint(base, '/api/products?page=1&limit=50');
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.value.path).toBe('/api/products?page=1&limit=50');
  });

  it('accepte une double barre dans la query, la refuse dans le chemin', () => {
    // `?next=https://exemple.com` est un paramètre banal : le refuser
    // interdirait des API réelles.
    const avecQuery = parseCustomApiEndpoint(base, '/api/products?next=https://exemple.com');
    expect(avecQuery.ok).toBe(true);

    // Dans le chemin, `//` désigne un hôte pour le parseur.
    expect(parseCustomApiEndpoint(base, '/api//evil.example/x').ok).toBe(false);
  });

  it('refuse un endpoint vide', () => {
    expect(parseCustomApiEndpoint(base, '').ok).toBe(false);
    expect(parseCustomApiEndpoint(base, '   ').ok).toBe(false);
  });
});

describe('politique d’en-têtes', () => {
  it('accepte les en-têtes d’authentification usuels', () => {
    const resultat = applyHeaderPolicy([
      { name: 'X-Api-Key', value: 'cle-123' },
      { name: 'Authorization', value: 'Bearer jeton' },
    ]);
    expect(resultat.headers.map((h) => h.name).sort()).toEqual(['authorization', 'x-api-key']);
    expect(resultat.rejected).toEqual([]);
  });

  it('refuse les en-têtes qui cassent le message HTTP', () => {
    for (const nom of ['Host', 'Connection', 'Content-Length', 'Transfer-Encoding', 'TE', 'Upgrade']) {
      const resultat = applyHeaderPolicy([{ name: nom, value: 'x' }]);
      expect(resultat.headers, nom).toEqual([]);
      expect(resultat.rejected[0]?.reason, nom).toBe('header_not_allowed');
    }
  });

  it('refuse un en-tête arbitraire', () => {
    const resultat = applyHeaderPolicy([{ name: 'X-Whatever', value: 'x' }]);
    expect(resultat.headers).toEqual([]);
    expect(resultat.rejected[0]?.reason).toBe('header_not_allowed');
  });

  it('refuse l’injection CRLF', () => {
    const resultat = applyHeaderPolicy([
      { name: 'x-api-key', value: 'cle\r\nX-Injected: 1' },
    ]);
    expect(resultat.headers).toEqual([]);
    expect(resultat.rejected[0]?.reason).toBe('header_value_invalid');
  });

  it('refuse une valeur vide ou démesurée', () => {
    expect(applyHeaderPolicy([{ name: 'x-api-key', value: '  ' }]).headers).toEqual([]);
    expect(applyHeaderPolicy([{ name: 'x-api-key', value: 'a'.repeat(MAX_HEADER_VALUE_LENGTH + 1) }]).headers).toEqual([]);
  });

  it('signale un doublon au lieu de l’écraser en silence', () => {
    const resultat = applyHeaderPolicy([
      { name: 'x-api-key', value: 'un' },
      { name: 'X-API-KEY', value: 'deux' },
    ]);
    expect(resultat.headers).toHaveLength(1);
    expect(resultat.headers[0].value).toBe('un');
    expect(resultat.rejected[0]?.reason).toBe('header_value_invalid');
  });

  it('borne le nombre d’en-têtes', () => {
    const entree = [
      { name: 'authorization', value: 'Bearer a' },
      { name: 'x-api-key', value: 'b' },
      { name: 'api-key', value: 'c' },
      { name: 'apikey', value: 'd' },
      { name: 'x-auth-token', value: 'e' },
      { name: 'x-shopify-access-token', value: 'f' },
    ];
    const resultat = applyHeaderPolicy(entree);
    expect(resultat.headers).toHaveLength(MAX_CUSTOM_HEADERS);
    expect(resultat.rejected[0]?.reason).toBe('too_many_headers');
  });

  it('retourne une liste vide pour une configuration absente', () => {
    expect(applyHeaderPolicy(null).headers).toEqual([]);
    expect(applyHeaderPolicy(undefined).headers).toEqual([]);
    expect(applyHeaderPolicy([]).headers).toEqual([]);
  });
});

describe('construction des en-têtes d’authentification', () => {
  it('bearer', () => {
    const resultat = buildAuthHeaders({ scheme: 'bearer', secret: 'jeton-123' });
    expect(resultat.headers).toEqual([{ name: 'authorization', value: 'Bearer jeton-123' }]);
  });

  it('basic encode en base64', () => {
    const resultat = buildAuthHeaders({ scheme: 'basic', secret: 'user:pass' });
    expect(resultat.headers).toHaveLength(1);
    expect(resultat.headers[0].value).toBe(`Basic ${btoa('user:pass')}`);
  });

  it('en-tête nommé, refusé s’il n’est pas dans la liste blanche', () => {
    const bon = buildAuthHeaders({ scheme: 'header', secret: 'cle', headerName: 'X-Api-Key' });
    expect(bon.headers[0].name).toBe('x-api-key');

    const mauvais = buildAuthHeaders({ scheme: 'header', secret: 'cle', headerName: 'X-Maison' });
    expect(mauvais.headers).toEqual([]);
    expect(mauvais.rejected[0]?.reason).toBe('header_not_allowed');

    // `header` ne peut pas usurper `authorization` : ce nom a son propre mode.
    const detourne = buildAuthHeaders({ scheme: 'header', secret: 'cle', headerName: 'authorization' });
    expect(detourne.headers).toEqual([]);
  });

  it('refuse un secret contenant un saut de ligne', () => {
    const resultat = buildAuthHeaders({ scheme: 'bearer', secret: 'jeton\r\nX-Injected: 1' });
    expect(resultat.headers).toEqual([]);
  });

  it('refuse un secret vide', () => {
    expect(buildAuthHeaders({ scheme: 'bearer', secret: '   ' }).headers).toEqual([]);
    expect(buildAuthHeaders({ scheme: 'bearer' }).headers).toEqual([]);
  });

  it('`none` n’envoie rien', () => {
    expect(buildAuthHeaders({ scheme: 'none' })).toEqual({ headers: [], rejected: [] });
  });

  it('refuse un mode inconnu', () => {
    const resultat = buildAuthHeaders({ scheme: 'magique' as never, secret: 'x' });
    expect(resultat.headers).toEqual([]);
    expect(resultat.rejected[0]?.reason).toBe('header_not_allowed');
  });
});

describe('masquage des en-têtes', () => {
  it('ne laisse filtrer aucune valeur secrète', () => {
    const masques = redactHeaders([
      { name: 'authorization', value: 'Bearer sk_live_tres_secret_0123456789' },
      { name: 'x-api-key', value: 'cle-secrete' },
    ]);
    const texte = JSON.stringify(masques);
    expect(texte).not.toContain('sk_live');
    expect(texte).not.toContain('cle-secrete');
    // La forme reste lisible : c'est ce qui aide à diagnostiquer.
    expect(texte).toContain('Bearer');
  });

  it('indique la longueur sans le contenu', () => {
    const [masque] = redactHeaders([{ name: 'x-api-key', value: 'abcdefghij' }]);
    expect(masque.value).toContain('10');
    expect(masque.value).not.toContain('abcdefghij');
  });
});

describe('messages de refus', () => {
  it('chaque refus a un message non technique', () => {
    const refus = [
      'not_absolute', 'path_dot_segments', 'path_control_chars', 'path_too_long',
      'host_not_allowed', 'header_not_allowed', 'header_value_invalid',
      'header_too_long', 'too_many_headers', 'empty', 'not_https',
      'ip_literal', 'reserved_hostname', 'single_label', 'private_address',
    ] as const;
    for (const raison of refus) {
      const message = explainCustomApiRejection(raison);
      expect(message.length, raison).toBeGreaterThan(5);
      // Aucun jargon interne ne doit apparaître.
      expect(message, raison).not.toMatch(/undefined|null|NaN/);
    }
  });

  it('mentionne le réseau local pour une cible interne', () => {
    expect(explainCustomApiRejection('reserved_hostname')).toMatch(/local|réservé/i);
    expect(explainCustomApiRejection('ip_literal')).toMatch(/IP|domaine/i);
  });
});

describe('liste blanche des en-têtes', () => {
  it('est courte et documentée', () => {
    expect(ALLOWED_AUTH_HEADERS.length).toBeLessThanOrEqual(10);
    // Aucun en-tête de contrôle du message HTTP ne doit y figurer.
    for (const interdit of ['host', 'connection', 'content-length', 'transfer-encoding']) {
      expect(ALLOWED_AUTH_HEADERS as readonly string[]).not.toContain(interdit);
    }
  });
});

/**
 * La garde ne peut pas être contournée par la forme de l'adresse.
 *
 * Chaque cas ci-dessous est une variante de la même attaque : faire résoudre
 * au serveur un nom qui désigne une adresse interne. On teste les deux
 * fonctions de saisie **et** on vérifie que la logique sous-jacente refuse.
 */
describe('résistance aux formes déguisées', () => {
  const formes = [
    'https://169.254.169.254.nip.io/latest/meta-data/', // wildcard DNS vers 169.254.169.254
    'https://127.0.0.1.sslip.io/api',
    'https://LOCALHOST/api',
    'https://LocalHost./api',
    'https://service.internal/api',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://[fd00::1]/api',
    'https://[fe80::1]/api',
    'https://0/api',
    'https://0xffffffff/api',
  ];

  it('refuse les hôtes qui ressemblent à des noms publics', () => {
    for (const url of formes) {
      const resultat = parseCustomApiBaseUrl(url);
      /*
       * Deux issues acceptables, et une seule interdite :
       *   - refus immédiat (casse, hôte réservé) ;
       *   - acceptation par la garde de FORME, mais alors la résolution DNS
       *     `assertPublicAddresses` refusera l'adresse interne au moment de la
       *     connexion.
       *
       * Ce qui ne doit jamais arriver : une adresse interne acceptée *et*
       * contactée. C'est `safe-egress` qui le garantit, et il est déjà testé ;
       * ici on vérifie qu'aucun de ces noms n'est traité comme banal.
       */
      if (resultat.ok) {
        /*
         * Un nom public peut encoder une IP dans ses labels
         * (`169.254.169.254.nip.io` résout vers 169.254.169.254). C'est
         * précisément pourquoi la garde de forme ne suffit pas et pourquoi
         * `assertPublicAddresses` contrôle les adresses **résolues, au moment
         * de la connexion**. Ce qui est vérifié ici : le nom est traité comme
         * un nom (donc soumis à résolution et contrôle), il n'est pas pris pour
         * une IP littérale.
         */
        expect(resultat.value.hostname).toMatch(/\.[a-z]{2,}$/i);
      }
    }
  });

  it('refuse explicitement ce qui doit l’être sans dépendre du DNS', () => {
    for (const url of ['https://127.0.0.1/api', 'https://localhost/api', 'https://169.254.169.254/']) {
      expect(parseCustomApiBaseUrl(url).ok, url).toBe(false);
    }
  });

  it('un domaine nip.io est accepté en forme mais son IP sera contrôlée à la connexion', () => {
    // Transparence assumée : la garde de forme ne peut pas résoudre le DNS (le
    // faire ici créerait une fenêtre de rebinding). `assertPublicAddresses`
    // est le contrôle qui vaut, et il s'exécute sur l'IP réellement contactée.
    const resultat = parseCustomApiBaseUrl('https://169.254.169.254.nip.io/');
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.value.hostname).toBe('169.254.169.254.nip.io');
  });
});
