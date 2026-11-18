import { describe, expect, it } from 'vitest';
import { safeGet } from '../supabase/functions/store-import/safe-egress';

/**
 * Compatibilité du réalignement : les appelants EXISTANTS ne changent pas.
 *
 * `store-connect` sonde une API personnalisée en passant
 * `headers = { accept: 'application/json', ...auth }`. Ce test fige l'effet du
 * correctif sur cette forme exacte : mêmes en-têtes d'authentification, une
 * seule ligne `Accept`, valeur calculée (`options.accept`) et non celle de
 * l'appelant. Aucune méthode, aucun corps, aucune redirection ne change.
 */

function socketServing(raw: string) {
  const octets = new TextEncoder().encode(raw);
  let position = 0;
  const ecrites: string[] = [];
  return {
    ecrites,
    async write(o: Uint8Array) {
      ecrites.push(new TextDecoder().decode(o));
      return o.byteLength;
    },
    async read(d: Uint8Array) {
      if (position >= octets.length) return null;
      const n = Math.min(d.length, octets.length - position);
      d.set(octets.subarray(position, position + n));
      position += n;
      return n;
    },
    async close() {
      return undefined;
    },
  };
}

const REPONSE = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}';

describe('sonde de store-connect — forme d’en-têtes inchangée', () => {
  it('conserve les en-têtes d’authentification et n’envoie qu’un Accept', async () => {
    const socket = socketServing(REPONSE);
    const resultat = await safeGet(
      'https://boutique.example/wp-json/wc/v3/products?per_page=1',
      {
        accept: 'application/json',
        maxBytes: 65_536,
        // Forme réelle : `entetes = { accept, ...buildAuthHeaders() }`.
        headers: {
          accept: 'application/json',
          authorization: 'Bearer secret-boutique',
          'x-api-key': 'cle-api',
        },
      },
      { resolveHost: async () => ['203.0.113.10'], connect: async () => socket },
    );

    expect(resultat.ok).toBe(true);
    const requete = socket.ecrites[0];
    const lignes = requete.split('\r\n');
    expect(lignes[0]).toBe('GET /wp-json/wc/v3/products?per_page=1 HTTP/1.1');
    expect(lignes.filter((l) => l.startsWith('Accept:'))).toEqual(['Accept: application/json']);
    expect(lignes).toContain('Authorization: Bearer secret-boutique');
    expect(lignes).toContain('X-Api-Key: cle-api');
    // Aucun corps, aucune méthode d'écriture : la sonde ne modifie rien.
    expect(lignes.filter((l) => l.startsWith('Content-Length:'))).toHaveLength(0);
    expect(requete).not.toContain('POST');
  });
});
