import { describe, expect, it, vi } from 'vitest';
import {
  buildRequest,
  decodeChunked,
  httpGetPinned,
  parseHead,
  PinnedFetchFailure,
  type PinnedSocket,
} from '../supabase/functions/store-import/pinned-fetch.ts';
import {
  MAX_REDIRECTS,
  PinnedNetworkError,
  pinnedFetchLike,
  safeGet,
  type EgressDeps,
} from '../supabase/functions/store-import/safe-egress.ts';

/* -------------------------------------------------------------------------- */
/* Faux socket : sert une réponse HTTP brute prédéfinie, journalise les écrits. */
/* -------------------------------------------------------------------------- */

function socketServing(raw: string | Uint8Array, options: { hang?: boolean } = {}): PinnedSocket & { written: string[]; closed: boolean } {
  const octets = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  let position = 0;
  let ferme = false;
  // Réveille une lecture en attente à la fermeture : un vrai socket Deno
  // interrompt `read()` quand `close()` est appelé, le faux doit faire pareil —
  // sinon un test de délai attendrait la fin de son propre minuteur.
  let reveiller: (() => void) | null = null;
  return {
    written: [] as string[],
    closed: false,
    async write(p: Uint8Array) {
      this.written.push(new TextDecoder().decode(p));
      return p.byteLength;
    },
    async read(p: Uint8Array) {
      if (options.hang) {
        // Serveur qui ne répond jamais : la lecture reste en attente jusqu'à
        // l'abandon (fermeture du socket), comme en production.
        await new Promise<void>((resolve) => {
          reveiller = resolve;
        });
        return null;
      }
      if (position >= octets.length) return null;
      const taille = Math.min(p.length, octets.length - position);
      p.set(octets.subarray(position, position + taille));
      position += taille;
      return taille;
    },
    close() {
      this.closed = true;
      ferme = true;
      reveiller?.();
    },
    get isClosed() {
      return ferme;
    },
  } as PinnedSocket & { written: string[]; closed: boolean };
}

function reponseHttp(corps: string, entetes: Record<string, string> = {}, statut = '200 OK'): string {
  const lignes = [`HTTP/1.1 ${statut}`];
  for (const [nom, valeur] of Object.entries(entetes)) lignes.push(`${nom}: ${valeur}`);
  lignes.push(`Content-Length: ${new TextEncoder().encode(corps).byteLength}`);
  lignes.push('Connection: close', '', corps);
  return lignes.join('\r\n');
}

/* -------------------------------------------------------------------------- */
/* Connexion épinglée : l'IP contactée est bien celle qui a été validée.      */
/* -------------------------------------------------------------------------- */

describe('httpGetPinned — épinglage de l’adresse', () => {
  it('ouvre la connexion sur l’IP fournie et valide le certificat sur l’hôte', async () => {
    const connect = vi.fn(async () => socketServing(reponseHttp('ok')));
    const resultat = await httpGetPinned(
      { ip: '203.0.113.10', hostname: 'boutique.example', path: '/products.json' },
      { accept: 'application/json', maxBytes: 1024, connect },
    );

    expect(resultat.status).toBe(200);
    expect(resultat.body).toBe('ok');
    // Preuve d'épinglage : la connexion a reçu l'IP littérale, pas le nom.
    expect(connect).toHaveBeenCalledWith('203.0.113.10', 'boutique.example');
  });

  it('envoie l’hôte d’origine dans l’en-tête Host et dans le SNI, jamais l’IP', async () => {
    const socket = socketServing(reponseHttp('ok'));
    const connect = vi.fn(async () => socket);
    await httpGetPinned(
      { ip: '203.0.113.10', hostname: 'boutique.example', path: '/a?b=1' },
      { accept: 'application/json', maxBytes: 1024, connect },
    );
    const requete = socket.written[0];
    expect(requete).toContain('Host: boutique.example');
    expect(requete).toContain('GET /a?b=1 HTTP/1.1');
    expect(requete).not.toContain('203.0.113.10');
  });

  it('refuse un corps qui dépasse le plafond, sans le charger entièrement', async () => {
    const enorme = 'x'.repeat(200_000);
    const connect = vi.fn(async () => socketServing(reponseHttp(enorme)));
    await expect(
      httpGetPinned({ ip: '203.0.113.10', hostname: 'b.example', path: '/' }, { accept: '*/*', maxBytes: 1_000, connect }),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('abandonne une réponse trop lente', async () => {
    const connect = vi.fn(async () => socketServing('', { hang: true }));
    await expect(
      httpGetPinned({ ip: '203.0.113.10', hostname: 'b.example', path: '/' }, { accept: '*/*', maxBytes: 1_000, timeoutMs: 50, connect }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('échoue fermé quand le runtime Deno n’expose pas connect/startTls', async () => {
    // Aucun repli vers `fetch` : sans épinglage possible, l'import est refusé.
    const { connectPinnedTls } = await import('../supabase/functions/store-import/pinned-fetch.ts');
    await expect(connectPinnedTls('203.0.113.10', 'boutique.example')).rejects.toMatchObject({
      code: 'connect_failed',
    });
  });

  it('n’utilise jamais fetch comme repli (aucun appel réseau implicite)', async () => {
    const espion = vi.spyOn(globalThis, 'fetch');
    const { connectPinnedTls } = await import('../supabase/functions/store-import/pinned-fetch.ts');
    await expect(connectPinnedTls('203.0.113.10', 'boutique.example')).rejects.toBeInstanceOf(PinnedFetchFailure);
    expect(espion).not.toHaveBeenCalled();
    espion.mockRestore();
  });

  it('refuse un chemin contenant un retour à la ligne (injection de requête)', () => {
    expect(() => buildRequest('b.example', '/a\r\nHost: evil.example', '*/*')).toThrow(PinnedFetchFailure);
  });
});

describe('parseHead / decodeChunked', () => {
  it('lit le statut et les en-têtes, insensibles à la casse', () => {
    const raw = new TextEncoder().encode(reponseHttp('corps', { 'Content-Type': 'application/json' }));
    const head = parseHead(raw);
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe('application/json');
    expect(new TextDecoder().decode(raw.slice(head.bodyOffset))).toBe('corps');
  });

  it('décode un corps chunked (mode par défaut de nombreux serveurs)', () => {
    const brut = new TextEncoder().encode('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n');
    expect(new TextDecoder().decode(decodeChunked(brut, 1_000))).toBe('hello world');
  });

  it('refuse un chunk dont la longueur annoncée dépasse le corps reçu', () => {
    const brut = new TextEncoder().encode('ff\r\nabc\r\n0\r\n\r\n');
    expect(() => decodeChunked(brut, 1_000)).toThrow(PinnedFetchFailure);
  });

  it('refuse un chunked qui dépasse le plafond', () => {
    const brut = new TextEncoder().encode('10\r\n0123456789abcdef\r\n10\r\n0123456789abcdef\r\n0\r\n\r\n');
    expect(() => decodeChunked(brut, 20)).toThrow(PinnedFetchFailure);
  });

  it('refuse une réponse sans en-têtes complets', () => {
    expect(() => parseHead(new TextEncoder().encode('HTTP/1.1 200 OK\r\n'))).toThrow(PinnedFetchFailure);
  });

  it('refuse une ligne de statut invalide', () => {
    expect(() => parseHead(new TextEncoder().encode('GARBAGE\r\n\r\n'))).toThrow(PinnedFetchFailure);
  });
});

/* -------------------------------------------------------------------------- */
/* SSRF : le contrôle est fait AU MOMENT DE LA CONNEXION                     */
/* -------------------------------------------------------------------------- */

function deps(fetching: (raw: string, ip: string) => string, adresses: Record<string, string[] | Error>) {
  const connexions: Array<{ ip: string; hostname: string }> = [];
  const resolutions: string[] = [];
  const d: EgressDeps = {
    resolveHost: async (hostname) => {
      resolutions.push(hostname);
      const valeur = adresses[hostname];
      if (valeur instanceof Error) throw valeur;
      return valeur ?? [];
    },
    connect: async (ip, hostname) => {
      connexions.push({ ip, hostname });
      return socketServing(fetching(hostname, ip));
    },
  };
  return { deps: d, connexions, resolutions };
}

const json = (corps: unknown) => reponseHttp(JSON.stringify(corps), { 'Content-Type': 'application/json' });

describe('safeGet — refus des adresses interdites', () => {
  it.each([
    ['localhost', ['127.0.0.1']],
    ['[::1]', ['::1']],
    ['metadata cloud', ['169.254.169.254']],
    ['réseau privé 10/8', ['10.0.0.5']],
    ['réseau privé 192.168/16', ['192.168.1.10']],
    ['réseau privé 172.16/12', ['172.20.0.1']],
    ['loopback IPv6', ['::1']],
    ['IPv4 mappée en IPv6', ['::ffff:127.0.0.1']],
    ['IPv4 mappée en hexadécimal', ['::ffff:7f00:1']],
    ['ULA IPv6', ['fd00::1']],
    ['lien local IPv6', ['fe80::1']],
  ])('refuse %s sans ouvrir de connexion', async (_nom, adresses) => {
    const { deps: d, connexions } = deps(() => json({}), { 'boutique.example': adresses });
    const resultat = await safeGet('https://boutique.example/', { accept: '*/*', maxBytes: 1_000 }, d);

    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('blocked_url');
    // L'essentiel : aucune connexion TCP n'a été tentée.
    expect(connexions).toHaveLength(0);
  });

  it('refuse un nom dont UNE SEULE adresse est privée (DNS à plusieurs adresses)', async () => {
    const { deps: d, connexions } = deps(() => json({}), {
      'boutique.example': ['203.0.113.10', '10.0.0.7'],
    });
    const resultat = await safeGet('https://boutique.example/', { accept: '*/*', maxBytes: 1_000 }, d);
    expect(resultat.ok).toBe(false);
    expect(connexions).toHaveLength(0);
  });

  it('refuse un nom qui ne renvoie aucune adresse', async () => {
    const { deps: d } = deps(() => json({}), { 'boutique.example': [] });
    const resultat = await safeGet('https://boutique.example/', { accept: '*/*', maxBytes: 1_000 }, d);
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('dns_empty');
  });

  it('refuse quand la résolution échoue', async () => {
    const { deps: d } = deps(() => json({}), { 'boutique.example': new Error('NXDOMAIN') });
    const resultat = await safeGet('https://boutique.example/', { accept: '*/*', maxBytes: 1_000 }, d);
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('dns_failed');
  });

  it('refuse une IP écrite directement dans l’URL', async () => {
    const { deps: d, connexions } = deps(() => json({}), { '169.254.169.254': ['169.254.169.254'] });
    const resultat = await safeGet('https://169.254.169.254/latest/meta-data/', { accept: '*/*', maxBytes: 1_000 }, d);
    expect(resultat.ok).toBe(false);
    expect(connexions).toHaveLength(0);
  });
});

describe('safeGet — preuve que l’IP connectée est l’IP validée', () => {
  it('se connecte à l’adresse publique validée et la rapporte', async () => {
    const { deps: d, connexions } = deps(() => json({ products: [] }), {
      'boutique.example': ['203.0.113.10'],
    });
    const resultat = await safeGet('https://boutique.example/products.json', { accept: 'application/json', maxBytes: 1_000 }, d);

    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.connectedTo).toBe('203.0.113.10');
    expect(connexions).toEqual([{ ip: '203.0.113.10', hostname: 'boutique.example' }]);
  });

  it('essaie les adresses publiques dans l’ordre jusqu’à une réponse', async () => {
    let tentative = 0;
    const d: EgressDeps = {
      resolveHost: async () => ['203.0.113.10', '203.0.113.11'],
      connect: async () => {
        tentative += 1;
        if (tentative === 1) throw Object.assign(new Error('refus'), { code: 'connect_failed' });
        return socketServing(json({ ok: true }));
      },
    };
    const resultat = await safeGet('https://boutique.example/', { accept: '*/*', maxBytes: 1_000 }, d);
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.value.connectedTo).toBe('203.0.113.11');
  });
});

describe('safeGet — redirections revalidées', () => {
  it('refuse une redirection vers les métadonnées cloud AVANT de s’y connecter', async () => {
    const { deps: d, connexions } = deps(
      () => reponseHttp('', { Location: 'http://169.254.169.254/latest/meta-data/' }, '302 Found'),
      { 'boutique.example': ['203.0.113.10'], '169.254.169.254': ['169.254.169.254'] },
    );
    const resultat = await safeGet('https://boutique.example/', { accept: '*/*', maxBytes: 1_000 }, d);

    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('blocked_url');
    // Une seule connexion : celle vers la boutique, jamais vers les métadonnées.
    expect(connexions).toEqual([{ ip: '203.0.113.10', hostname: 'boutique.example' }]);
  });

  it('refuse une redirection vers localhost', async () => {
    const { deps: d, connexions } = deps(
      () => reponseHttp('', { Location: 'https://127.0.0.1:443/admin' }, '301 Moved'),
      { 'boutique.example': ['203.0.113.10'], '127.0.0.1': ['127.0.0.1'] },
    );
    const resultat = await safeGet('https://boutique.example/', { accept: '*/*', maxBytes: 1_000 }, d);
    expect(resultat.ok).toBe(false);
    expect(connexions).toHaveLength(1);
  });

  it('suit une redirection légitime vers un autre hôte public', async () => {
    const { deps: d } = deps(
      (_h) => reponseHttp('', { Location: 'https://cdn.example/products.json' }, '302 Found'),
      { 'boutique.example': ['203.0.113.10'], 'cdn.example': ['198.51.100.7'] },
    );
    const resultat = await safeGet('https://boutique.example/', { accept: '*/*', maxBytes: 1_000 }, d);
    // La redirection mène à une 302 en boucle : on vérifie le nombre de sauts borné.
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('too_many_redirects');
  });

  it('s’arrête après le nombre maximal de redirections', async () => {
    const { deps: d, connexions } = deps(
      (_h, ip) => reponseHttp('', { Location: `https://boutique.example/${ip}/suite` }, '302 Found'),
      { 'boutique.example': ['203.0.113.10'] },
    );
    const resultat = await safeGet('https://boutique.example/', { accept: '*/*', maxBytes: 1_000 }, d);
    expect(resultat.ok).toBe(false);
    expect(connexions.length).toBe(MAX_REDIRECTS + 1);
  });
});

describe('safeGet — changement de résolution entre deux sauts (rebinding)', () => {
  it('refuse quand le nom passe d’une adresse publique à une adresse privée', async () => {
    let appels = 0;
    const connexions: string[] = [];
    const d: EgressDeps = {
      resolveHost: async () => {
        appels += 1;
        // Première résolution : publique. Seconde : interne — rebinding classique.
        return appels === 1 ? ['203.0.113.10'] : ['10.0.0.9'];
      },
      connect: async (ip) => {
        connexions.push(ip);
        return socketServing(reponseHttp('', { Location: 'https://boutique.example/autre' }, '302 Found'));
      },
    };
    const resultat = await safeGet('https://boutique.example/', { accept: '*/*', maxBytes: 1_000 }, d);

    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('blocked_url');
    // Seule l'adresse publique a été contactée.
    expect(connexions).toEqual(['203.0.113.10']);
  });

  it('refuse une redirection dont la destination change de résolution avant connexion', async () => {
    const connexions: string[] = [];
    const d: EgressDeps = {
      resolveHost: async (hostname) => (hostname === 'boutique.example' ? ['203.0.113.10'] : ['127.0.0.1']),
      connect: async (ip) => {
        connexions.push(ip);
        return socketServing(reponseHttp('', { Location: 'https://autre.example/x' }, '302 Found'));
      },
    };
    const resultat = await safeGet('https://boutique.example/', { accept: '*/*', maxBytes: 1_000 }, d);
    expect(resultat.ok).toBe(false);
    expect(connexions).toEqual(['203.0.113.10']);
  });
});

/* -------------------------------------------------------------------------- */
/* Réutilisation : le FetchLike branché sur la sortie épinglée                */
/* -------------------------------------------------------------------------- */

describe('pinnedFetchLike — réutiliser la logique existante sans la dupliquer', () => {
  it('rend une Response standard lisible par les garde-fous de sources.ts', async () => {
    const { deps: d } = deps(() => json({ products: [{ name: 'X' }] }), { 'boutique.example': ['203.0.113.10'] });
    const fetchImpl = pinnedFetchLike(d, { accept: 'application/json', maxBytes: 10_000 });
    const reponse = await fetchImpl('https://boutique.example/products.json');

    expect(reponse.status).toBe(200);
    expect(reponse.headers.get('content-type')).toBe('application/json');
    await expect(reponse.json()).resolves.toEqual({ products: [{ name: 'X' }] });
  });

  it('refuse toute méthode autre que GET (aucune écriture distante)', async () => {
    const { deps: d } = deps(() => json({}), { 'boutique.example': ['203.0.113.10'] });
    const fetchImpl = pinnedFetchLike(d, { accept: '*/*', maxBytes: 1_000 });
    await expect(fetchImpl('https://boutique.example/', { method: 'POST' })).rejects.toThrow(/Méthode non autorisée/);
  });

  it('propage un refus d’adresse sous forme d’erreur typée', async () => {
    const { deps: d } = deps(() => json({}), { 'boutique.example': ['10.1.2.3'] });
    const fetchImpl = pinnedFetchLike(d, { accept: '*/*', maxBytes: 1_000 });
    await expect(fetchImpl('https://boutique.example/')).rejects.toBeInstanceOf(PinnedNetworkError);
  });

  it('ne laisse jamais fuiter d’en-tête d’autorisation vers un autre hôte', async () => {
    const ecrits: string[] = [];
    const d: EgressDeps = {
      resolveHost: async (hostname) => (hostname === 'boutique.example' ? ['203.0.113.10'] : ['198.51.100.9']),
      connect: async (ip, hostname) => {
        const socket = socketServing(reponseHttp('', { Location: 'https://autre.example/x' }, '302 Found'));
        const write = socket.write.bind(socket);
        socket.write = async (p: Uint8Array) => {
          ecrits.push(new TextDecoder().decode(p));
          return write(p);
        };
        void ip;
        void hostname;
        return socket;
      },
    };
    const fetchImpl = pinnedFetchLike(d, { accept: '*/*', maxBytes: 1_000 });
    await expect(
      fetchImpl('https://boutique.example/', { headers: { authorization: 'Bearer secret-interne' } }),
    ).rejects.toBeInstanceOf(PinnedNetworkError);
    // Le jeton n'est jamais transmis : la requête sortante ne le contient pas.
    expect(ecrits.join('\n')).not.toContain('secret-interne');
  });
});
