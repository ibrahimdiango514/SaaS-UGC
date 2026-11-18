// @vitest-environment node
/**
 * Transport épinglé — le `POST` n'a rien changé au `GET`.
 *
 * `pinned-fetch.ts` et `safe-egress.ts` sont importés par DEUX fonctions déjà
 * déployées (`store-import` et `store-connect`), dont le code expédié est un
 * bundle figé à un commit précis. Ajouter `POST` pour le client MCP a donc
 * modifié ces bundles : leurs artefacts épinglés ne correspondaient plus au
 * code du dépôt, et `tests/store-import-artifact.test.ts` l'a signalé (6
 * échecs). Ce test-ci verrouille ce qui compte : la requête `GET` produite est
 * BYTE POUR BYTE celle d'avant.
 *
 * Les valeurs attendues sont figées à la main, pas recopiées depuis la
 * fonction : sinon le test passerait même si la fonction changeait.
 */
import { describe, expect, it } from 'vitest';
import { buildRequest, PinnedFetchFailure } from '../supabase/functions/store-import/pinned-fetch.ts';

describe('requête GET : aucune dérive après l’ajout de POST', () => {
  it('produit la forme exacte d’origine, sans corps ni content-length', () => {
    const requete = buildRequest('shopify.example', '/admin/api/products.json?limit=5', 'application/json');
    expect(requete).toBe([
      'GET /admin/api/products.json?limit=5 HTTP/1.1',
      'Host: shopify.example',
      'User-Agent: VYORA-CatalogImporter/1.0 (+https://vyora.app)',
      'Accept: application/json',
      'Accept-Language: fr,en;q=0.8',
      'Accept-Encoding: identity',
      'Connection: close',
      '',
      '',
    ].join('\r\n'));
  });

  it('transmet la clé de la boutique sans altérer la forme', () => {
    const requete = buildRequest('boutique.example', '/api/products', 'application/json', {
      authorization: 'Bearer cle-boutique',
      'x-api-key': 'valeur',
    });
    expect(requete).toContain('Authorization: Bearer cle-boutique');
    expect(requete).toContain('X-Api-Key: valeur');
    expect(requete.startsWith('GET /api/products HTTP/1.1')).toBe(true);
    // Un GET n'a jamais de corps : ajouter `Content-Length` ferait attendre
    // certains serveurs et casserait l'import de catalogue.
    expect(requete).not.toContain('Content-Length');
  });

  it('ignore une méthode inconnue et retombe sur GET', () => {
    // `methode` vient d'un appelant : une valeur inattendue ne doit pas
    // produire un verbe arbitraire sur le fil.
    const requete = buildRequest('h.example', '/', '*/*', {}, 'DELETE' as unknown as 'GET');
    expect(requete.startsWith('GET / HTTP/1.1')).toBe(true);
  });
});

describe('requête POST (client MCP)', () => {
  it('ajoute la méthode, la longueur en OCTETS et le corps', () => {
    const corps = JSON.stringify({ jsonrpc: '2.0', method: 'initialize' });
    const requete = buildRequest('mcp.example', '/mcp', 'application/json', { 'content-type': 'application/json' }, 'POST', corps);
    expect(requete.startsWith('POST /mcp HTTP/1.1')).toBe(true);
    expect(requete).toContain(`Content-Length: ${Buffer.byteLength(corps, 'utf8')}`);
    expect(requete.endsWith(corps)).toBe(true);
  });

  it('compte les octets, pas les caractères (accents UTF-8)', () => {
    const corps = JSON.stringify({ nom: 'café côté' });
    const requete = buildRequest('mcp.example', '/mcp', 'application/json', {}, 'POST', corps);
    const declare = Number(/Content-Length: (\d+)/.exec(requete)?.[1]);
    expect(declare).toBe(Buffer.byteLength(corps, 'utf8'));
    // Le piège : `corps.length` (caractères) serait strictement plus petit.
    expect(declare).toBeGreaterThan(corps.length);
  });

  it('refuse un type de contenu autre que JSON', () => {
    expect(() => buildRequest('mcp.example', '/mcp', 'application/json', {
      'content-type': 'application/x-www-form-urlencoded',
    }, 'POST', '{}')).toThrow(PinnedFetchFailure);
  });

  it('refuse un corps qui injecte des en-têtes', () => {
    // Le corps est écrit après la ligne vide, mais un `\r\n` mal placé dans un
    // en-tête reste la voie d'injection classique : on la couvre toujours.
    expect(() => buildRequest('mcp.example', '/mcp', 'application/json', {
      authorization: 'Bearer x\r\nX-Injecte: 1',
    }, 'POST', '{}')).toThrow(PinnedFetchFailure);
  });
});
