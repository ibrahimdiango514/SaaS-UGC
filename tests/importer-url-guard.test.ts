// @vitest-environment node
/**
 * Garde SSRF de l'importateur de boutiques.
 *
 * Ce fichier existe avant l'interface, volontairement. Une faille SSRF ne se
 * corrige pas après coup : elle est dans la conception. On vérifie donc, cas
 * par cas, que **chaque forme connue de contournement** est refusée.
 *
 * Les cas ci-dessous ne sont pas inventés : ce sont ceux que l'on trouve dans
 * les rapports d'incident et les listes de contournement publiées (OWASP,
 * articles sur le SSRF). Les formes décimales et hexadécimales sont
 * particulièrement importantes : `2130706433` vaut `127.0.0.1`, et beaucoup de
 * filtres naïfs le laissent passer.
 */
import { describe, expect, it } from 'vitest';
import {
  assertPublicAddresses,
  explainRejection,
  isPrivateIpv4,
  isPrivateIpv6,
  isPublicHostname,
  parseStoreUrl,
  storeRoot,
  storeRootCandidates,
} from '../src/business/importer/url-guard';

describe('forme de l’URL — seul HTTPS standard est accepté', () => {
  it('accepte une URL de boutique normale', () => {
    const check = parseStoreUrl('https://www.ma-boutique.com/products/serum');
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.url.hostname).toBe('www.ma-boutique.com');
  });

  it('accepte un domaine saisi sans schéma', () => {
    const check = parseStoreUrl('ma-boutique.com');
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.url.protocol).toBe('https:');
  });

  it('refuse HTTP, même saisi explicitement', () => {
    // On ne « corrige » pas silencieusement : une intention en clair est rejetée.
    const check = parseStoreUrl('http://ma-boutique.com');
    expect(check).toEqual({ ok: false, reason: 'not_https' });
  });

  it('refuse un port non standard', () => {
    expect(parseStoreUrl('https://ma-boutique.com:8443/')).toEqual({ ok: false, reason: 'non_standard_port' });
    expect(parseStoreUrl('https://ma-boutique.com:22/')).toEqual({ ok: false, reason: 'non_standard_port' });
  });

  it('accepte le port 443 explicite', () => {
    expect(parseStoreUrl('https://ma-boutique.com:443/').ok).toBe(true);
  });

  it('refuse des identifiants dans l’URL', () => {
    expect(parseStoreUrl('https://admin:secret@ma-boutique.com/')).toEqual({ ok: false, reason: 'credentials_in_url' });
  });

  it('refuse un fragment', () => {
    expect(parseStoreUrl('https://ma-boutique.com/#section')).toEqual({ ok: false, reason: 'has_fragment' });
  });

  it('refuse une entrée vide ou invalide', () => {
    expect(parseStoreUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseStoreUrl('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuse les schémas non HTTP', () => {
    for (const url of ['ftp://ma-boutique.com', 'file:///etc/passwd', 'gopher://x.com', 'javascript:alert(1)']) {
      const check = parseStoreUrl(url);
      expect(check.ok).toBe(false);
    }
  });
});

describe('hôte — les littéraux IP sont refusés', () => {
  it('refuse 127.0.0.1 sous toutes ses écritures', () => {
    // `new URL` normalise déjà la plupart de ces formes en 127.0.0.1.
    for (const hôte of [
      '127.0.0.1',
      '127.1',
      '2130706433',
      '0x7f000001',
      '0x7f.0.0.1',
      '0177.0.0.1',
      '127.000.000.001',
    ]) {
      const check = parseStoreUrl(`https://${hôte}/`);
      expect(check.ok, `${hôte} aurait dû être refusé`).toBe(false);
    }
  });

  it('refuse les IPv4 publiques : un nom de domaine est exigé', () => {
    expect(parseStoreUrl('https://8.8.8.8/')).toEqual({ ok: false, reason: 'ip_literal' });
  });

  it('refuse les IPv6 littérales, y compris loopback et mappées', () => {
    for (const hôte of ['[::1]', '[fe80::1]', '[fc00::1]', '[2001:db8::1]']) {
      const check = parseStoreUrl(`https://${hôte}/`);
      expect(check.ok, `${hôte} aurait dû être refusé`).toBe(false);
    }
  });

  it('refuse une IPv6 mappée vers une IPv4 privée', () => {
    // `new URL` normalise [::ffff:127.0.0.1] en [::ffff:7f00:1] : c'est la
    // résolution qui doit l'attraper, car la forme littérale ne le dit plus.
    const check = parseStoreUrl('https://[::ffff:127.0.0.1]/');
    expect(check.ok).toBe(false);
    // Le contrôle par adresse reste, lui, sans ambiguïté.
    expect(isPrivateIpv6('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIpv6('::ffff:7f00:1')).toBe(true);
  });

  it('refuse un entier ou un hexadécimal seul comme hôte', () => {
    expect(isPublicHostname('2130706433')).toEqual({ ok: false, reason: 'ip_literal' });
    expect(isPublicHostname('0x7f000001')).toEqual({ ok: false, reason: 'ip_literal' });
  });
});

describe('hôte — les noms réservés sont refusés', () => {
  it('refuse localhost et ses variantes', () => {
    for (const hôte of ['localhost', 'LOCALHOST', 'localhost.localdomain', 'ip6-localhost']) {
      expect(isPublicHostname(hôte)).toEqual({ ok: false, reason: 'reserved_hostname' });
    }
  });

  it('refuse les suffixes de réseau interne', () => {
    for (const hôte of ['serveur.internal', 'nas.local', 'printer.intranet', 'box.lan', 'x.arpa', 'router.home']) {
      expect(isPublicHostname(hôte), `${hôte} aurait dû être refusé`).toEqual({ ok: false, reason: 'reserved_hostname' });
    }
  });

  it('refuse un nom à label unique', () => {
    expect(isPublicHostname('intranet')).toEqual({ ok: false, reason: 'single_label' });
    expect(isPublicHostname('shop')).toEqual({ ok: false, reason: 'single_label' });
  });

  it('accepte un domaine public normal', () => {
    expect(isPublicHostname('ma-boutique.com')).toEqual({ ok: true });
    expect(isPublicHostname('shop.example.co.uk')).toEqual({ ok: true });
    // Le point final est une forme valide en DNS.
    expect(isPublicHostname('ma-boutique.com.')).toEqual({ ok: true });
  });

  it('ne confond pas un domaine qui contient « local » avec un domaine local', () => {
    // « locale.fr » n'est pas « .local » : refuser ici serait un faux positif.
    expect(isPublicHostname('locale.fr')).toEqual({ ok: true });
    expect(isPublicHostname('localmarket.com')).toEqual({ ok: true });
  });
});

describe('adresses résolues — refus des réseaux privés', () => {
  it('refuse les plages IPv4 privées et spéciales', () => {
    const privees = [
      '0.0.0.0', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.1.2.3',
      '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1',
      '192.168.255.255', '100.64.0.1', '192.0.0.1', '198.18.0.1',
      '224.0.0.1', '255.255.255.255',
    ];
    for (const ip of privees) {
      expect(isPrivateIpv4(ip), `${ip} aurait dû être refusée`).toBe(true);
    }
  });

  it('accepte les adresses IPv4 publiques', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1', '100.128.0.1']) {
      expect(isPrivateIpv4(ip), `${ip} aurait dû être acceptée`).toBe(false);
    }
  });

  it('refuse les adresses IPv6 privées', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:192.168.0.1']) {
      expect(isPrivateIpv6(ip), `${ip} aurait dû être refusée`).toBe(true);
    }
  });

  it('accepte une IPv6 publique', () => {
    expect(isPrivateIpv6('2001:4860:4860::8888')).toBe(false);
  });

  it('un seul résultat privé suffit à refuser (DNS rebinding)', () => {
    // Cas typique : la zone renvoie une adresse publique puis une interne.
    expect(assertPublicAddresses(['93.184.216.34', '10.0.0.5'])).toEqual({ ok: false, reason: 'private_address' });
    expect(assertPublicAddresses(['::1'])).toEqual({ ok: false, reason: 'private_address' });
  });

  it('refuse une résolution vide', () => {
    expect(assertPublicAddresses([])).toEqual({ ok: false, reason: 'no_addresses' });
  });

  it('accepte une résolution entièrement publique', () => {
    expect(assertPublicAddresses(['93.184.216.34', '2606:2800:220:1::1'])).toEqual({ ok: true });
  });

  it('une adresse mal formée est traitée comme privée (fail-closed)', () => {
    for (const ip of ['', 'pas-une-ip', '999.1.1.1', '1.2.3']) {
      expect(isPrivateIpv4(ip)).toBe(true);
    }
  });
});

describe('messages de refus — utiles sans révéler l’infrastructure', () => {
  it('chaque refus a un message affichable', () => {
    const raisons = [
      'empty', 'invalid_url', 'not_https', 'non_standard_port', 'credentials_in_url',
      'has_fragment', 'ip_literal', 'reserved_hostname', 'single_label', 'private_address', 'no_addresses',
    ] as const;
    for (const raison of raisons) {
      const message = explainRejection(raison);
      expect(message.length).toBeGreaterThan(10);
      // Aucun message ne doit nommer une adresse interne ou un mécanisme.
      expect(message).not.toMatch(/169\.254|localhost|metadata|dns|rebind/i);
    }
  });
});

describe('racine de boutique — remonter sans perdre une base d’installation', () => {
  const root = (input: string) => storeRoot(new URL(input)).toString();

  it('remonte d’une fiche produit à la racine', () => {
    expect(root('https://boutique.com/products/serum')).toBe('https://boutique.com/');
  });

  it('remonte d’une page de collection', () => {
    expect(root('https://boutique.com/collections/soins?page=2')).toBe('https://boutique.com/');
  });

  it('reste à la racine quand l’URL l’est déjà', () => {
    expect(root('https://boutique.com/')).toBe('https://boutique.com/');
    expect(root('https://boutique.com')).toBe('https://boutique.com/');
  });

  it('ne devine jamais un sous-répertoire dans la racine par défaut', () => {
    // `/boutique/` peut être une base WordPress ou une route applicative :
    // la racine est donc l'origine, prévisible, sans supposition.
    expect(root('https://site.com/boutique/product/serum')).toBe('https://site.com/');
  });

  it('propose le sous-répertoire comme candidat explicite, à essayer', () => {
    const candidats = storeRootCandidates(new URL('https://site.com/boutique/product/serum'));
    expect(candidats.map(String)).toEqual([
      'https://site.com/',
      'https://site.com/boutique/',
    ]);
  });

  it('n’ajoute aucune variante pour une route applicative connue', () => {
    for (const chemin of ['/cart', '/panier', '/account', '/checkout', '/pages/about', '/products/x']) {
      const candidats = storeRootCandidates(new URL(`https://boutique.com${chemin}`));
      // La racine seule : aucune supposition sur /cart/ comme base.
      expect(candidats.map(String), chemin).toEqual(['https://boutique.com/']);
    }
  });

  it('n’essaie pas le sous-répertoire quand l’URL est déjà la racine', () => {
    expect(storeRootCandidates(new URL('https://boutique.com/')).map(String)).toEqual(['https://boutique.com/']);
  });
});
