import { describe, expect, it } from 'vitest';
import { safeGet, safePost } from '../supabase/functions/store-import/safe-egress';

/**
 * Non-régression : un seul en-tête `Accept` sur le fil.
 *
 * `buildRequest` écrit `Accept` depuis `options.accept`, puis recopie les
 * en-têtes supplémentaires de la liste blanche. Depuis que `accept` et
 * `content-type` y figurent (nécessaire au transport MCP), un appelant qui
 * passe `accept` produisait un **doublon** — observé en recette sur la sonde
 * de `store-connect` (`entetes = { accept: 'application/json' }`).
 *
 * Le contrat est vérifié ici au niveau de la sortie réelle (`safeGet` /
 * `safePost`), c'est-à-dire des octets écrits sur le socket.
 */

function lignes(requete: string, prefixe: string): string[] {
  return requete
    .split('\r\n')
    .filter((ligne) => ligne.toLowerCase().startsWith(`${prefixe.toLowerCase()}:`));
}

/** Socket minimal : rend une réponse HTTP fixe et retient ce qui est écrit. */
function socketServing(raw: string) {
  const octets = new TextEncoder().encode(raw);
  let position = 0;
  const ecrites: string[] = [];
  return {
    ecrites,
    async write(octetsEnvoyes: Uint8Array) {
      ecrites.push(new TextDecoder().decode(octetsEnvoyes));
      return octetsEnvoyes.byteLength;
    },
    async read(destination: Uint8Array) {
      if (position >= octets.length) return null;
      const taille = Math.min(destination.length, octets.length - position);
      destination.set(octets.subarray(position, position + taille));
      position += taille;
      return taille;
    },
    async close() {
      return undefined;
    },
  };
}

const REPONSE_JSON = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}';

describe('sortie épinglée — un seul Accept sur le fil', () => {
  it('safeGet : un seul Accept même si l’appelant en passe un', async () => {
    const socket = socketServing(REPONSE_JSON);
    const resultat = await safeGet(
      'https://shop.example/products.json',
      {
        accept: 'application/json',
        maxBytes: 4096,
        headers: { accept: 'application/json', authorization: 'Bearer x' },
      },
      { resolveHost: async () => ['93.184.216.34'], connect: async () => socket },
    );
    expect(resultat.ok).toBe(true);
    expect(lignes(socket.ecrites[0], 'Accept')).toHaveLength(1);
    expect(lignes(socket.ecrites[0], 'Authorization')).toEqual(['Authorization: Bearer x']);
  });

  it('l’Accept envoyé est celui calculé, jamais celui de l’appelant', async () => {
    const socket = socketServing(REPONSE_JSON);
    const resultat = await safeGet(
      'https://shop.example/products.json',
      { accept: 'text/html,application/xhtml+xml', maxBytes: 4096, headers: { accept: '*/*' } },
      { resolveHost: async () => ['93.184.216.34'], connect: async () => socket },
    );
    expect(resultat.ok).toBe(true);
    expect(lignes(socket.ecrites[0], 'Accept')).toEqual(['Accept: text/html,application/xhtml+xml']);
  });

  it('safePost : Accept et Content-Type uniques, Content-Length en octets', async () => {
    const socket = socketServing(REPONSE_JSON);
    const corps = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { nom: 'é' } });
    const resultat = await safePost(
      'https://mcp.example/mcp',
      {
        accept: 'application/json, text/event-stream',
        maxBytes: 4096,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': 'abc',
        },
        body: corps,
      },
      { resolveHost: async () => ['93.184.216.34'], connect: async () => socket },
    );
    expect(resultat.ok).toBe(true);
    expect(lignes(socket.ecrites[0], 'Accept')).toHaveLength(1);
    expect(lignes(socket.ecrites[0], 'Content-Type')).toHaveLength(1);
    expect(lignes(socket.ecrites[0], 'Mcp-Session-Id')).toEqual(['Mcp-Session-Id: abc']);
    // La longueur est celle du corps en OCTETS : l'accent compte deux octets.
    const attendu = new TextEncoder().encode(corps).byteLength;
    expect(lignes(socket.ecrites[0], 'Content-Length')).toEqual([`Content-Length: ${attendu}`]);
  });

  it('refuse un content-type non JSON même en POST', async () => {
    const socket = socketServing(REPONSE_JSON);
    const resultat = await safePost(
      'https://mcp.example/mcp',
      { accept: 'application/json', maxBytes: 4096, headers: { 'content-type': 'text/plain' }, body: '{}' },
      { resolveHost: async () => ['93.184.216.34'], connect: async () => socket },
    );
    // Refus AVANT tout octet écrit : la requête ne part pas.
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('protocol_error');
    expect(socket.ecrites).toHaveLength(0);
  });
});
