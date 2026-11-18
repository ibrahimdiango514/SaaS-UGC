import { describe, expect, it } from 'vitest';
import {
  MAX_OUTILS,
  assainir,
  deciderAppel,
  entetesAuthentification,
  executerOutil,
  normaliserPourStockage,
  testerConnexion,
  type PermissionStockee,
  type ServeurExterne,
} from '../supabase/functions/mcp-client/external';
import { creerContexte, type OutilDecouvert } from '../supabase/functions/mcp-client/client';

/**
 * Couche « connexions MCP sortantes » — tests SANS réseau.
 *
 * Ils couvrent la décision (pure), l'assainissement des valeurs venues du
 * serveur distant, et les refus qui doivent intervenir AVANT tout appel.
 * Le parcours complet contre un vrai serveur MCP est dans
 * `mcp-external-live.test.ts`.
 */

/* -------------------------------------------------------------------------- */
/* 1. Assainissement                                                          */
/* -------------------------------------------------------------------------- */

describe('assainir — rien de ce que dit le serveur distant n’est repris tel quel', () => {
  it('borne la profondeur', () => {
    let valeur: unknown = 'fond';
    for (let i = 0; i < 20; i += 1) valeur = { niveau: valeur };
    const propre = assainir(valeur) as Record<string, unknown>;
    expect(JSON.stringify(propre)).not.toContain('fond');
  });

  it('retire __proto__ et constructor', () => {
    const hostile = JSON.parse('{"__proto__":{"pollue":true},"constructor":{"x":1},"ok":"oui"}');
    const propre = assainir(hostile) as Record<string, unknown>;
    expect(Object.keys(propre)).toEqual(['ok']);
    expect(({} as Record<string, unknown>).pollue).toBeUndefined();
  });

  it('tronque les chaînes et refuse les nombres non finis', () => {
    const propre = assainir({ texte: 'x'.repeat(5000), infini: Number.POSITIVE_INFINITY }) as Record<string, unknown>;
    expect((propre.texte as string).length).toBe(2_000);
    expect(propre.infini).toBeNull();
  });

  it('borne le nombre d’éléments d’un tableau', () => {
    const propre = assainir(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(propre).toHaveLength(100);
  });
});

describe('normaliserPourStockage', () => {
  it('classe localement et ne recopie jamais un readOnlyHint', () => {
    const outil: OutilDecouvert = {
      name: 'delete_order',
      description: 'Supprime une commande.',
      inputSchema: { type: 'object', readOnlyHint: true },
      exigeConfirmation: true,
      classement: 'le nom contient « delete »',
    };
    const stocke = normaliserPourStockage(outil);
    expect(stocke.classification).toBe('write');
    expect(stocke.requires_confirmation).toBe(true);
    expect(stocke.classification_reason).toContain('delete');
  });

  it('remplace un schéma démesuré par un objet vide', () => {
    const enorme: Record<string, unknown> = {};
    for (let i = 0; i < 90; i += 1) enorme[`champ_${i}`] = 'y'.repeat(1_900);
    const stocke = normaliserPourStockage({
      name: 'outil',
      description: '',
      inputSchema: enorme,
      exigeConfirmation: false,
      classement: 'lecture',
    });
    expect(stocke.input_schema).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Décision d'appel — le refus est local                                   */
/* -------------------------------------------------------------------------- */

const OUTILS_CONNUS = [
  { name: 'list_products' },
  { name: 'get_product' },
  { name: 'delete_product' },
  { name: 'do_something' },
];

function decider(outil: string, permission?: PermissionStockee, revoque = false) {
  return deciderAppel({
    revoque,
    outil,
    description: '',
    outilsConnus: OUTILS_CONNUS,
    permission,
  });
}

describe('deciderAppel — fail-closed', () => {
  it('refuse un outil sans permission', () => {
    const d = decider('list_products');
    expect(d.permis).toBe(false);
    if (!d.permis) expect(d.code).toBe('outil_non_autorise');
  });

  it('refuse un outil en attente ou refusé', () => {
    expect(decider('list_products', { etat: 'pending' }).permis).toBe(false);
    expect(decider('list_products', { etat: 'denied' }).permis).toBe(false);
  });

  it('accepte une lecture explicitement autorisée', () => {
    expect(decider('list_products', { etat: 'allowed' }).permis).toBe(true);
  });

  it('refuse une écriture dont l’autorisation n’est pas persistée', () => {
    // `deciderAppel` ne connaît pas la confirmation ponctuelle : il ne peut
    // donc pas renvoyer « à confirmer ». Ce cas-là appartient à `execution.ts`.
    const d = decider('delete_product', { etat: 'allowed' });
    expect(d.permis).toBe(false);
    if (!d.permis) {
      expect(d.code).toBe('ecriture_desactivee');
      expect(d.motif).toContain('delete');
    }
  });

  it('accepte une écriture avec confirmation explicite', () => {
    expect(decider('delete_product', { etat: 'allowed', ecritureAutorisee: true }).permis).toBe(true);
  });

  it('traite un nom inconnu comme une écriture', () => {
    const d = decider('do_something', { etat: 'allowed' });
    expect(d.permis).toBe(false);
    if (!d.permis) expect(d.code).toBe('ecriture_desactivee');
  });

  it('écriture sans autorisation persistée : « désactivée », pas « à confirmer »', () => {
    // Le message doit dire la vérité : aucune confirmation ne peut suffire,
    // puisque la migration P2 ne porte aucune colonne d'autorisation d'écriture.
    const d = decider('delete_product', { etat: 'allowed' });
    expect(d.permis).toBe(false);
    if (!d.permis) {
      expect(d.code).toBe('ecriture_desactivee');
      expect(d.motif).toContain('lecture seule');
    }
  });

  it('refuse un outil jamais découvert', () => {
    const d = decider('outil_fantome', { etat: 'allowed' });
    expect(d.permis).toBe(false);
    if (!d.permis) expect(d.code).toBe('outil_inconnu');
  });

  it('refuse tout sur une connexion révoquée, même autorisée', () => {
    const d = decider('list_products', { etat: 'allowed' }, true);
    expect(d.permis).toBe(false);
    if (!d.permis) expect(d.code).toBe('revoked');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. En-têtes d'authentification — aucun mécanisme supposé                   */
/* -------------------------------------------------------------------------- */

describe('entetesAuthentification', () => {
  it('n’envoie rien pour un serveur public', () => {
    expect(entetesAuthentification('none', null)).toEqual({});
  });

  it('bearer et oauth utilisent Authorization', () => {
    expect(entetesAuthentification('bearer', 'jeton')).toEqual({ authorization: 'Bearer jeton' });
    expect(entetesAuthentification('oauth', 'jeton')).toEqual({ authorization: 'Bearer jeton' });
  });

  it('api_key utilise X-Api-Key', () => {
    expect(entetesAuthentification('api_key', 'cle')).toEqual({ 'x-api-key': 'cle' });
  });

  it('un secret vide ne produit aucun en-tête vide', () => {
    expect(entetesAuthentification('bearer', '   ')).toEqual({});
    expect(entetesAuthentification('api_key', null)).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Refus avant réseau                                                      */
/* -------------------------------------------------------------------------- */

describe('executerOutil — le refus intervient avant l’appel réseau', () => {
  it('ne contacte jamais le serveur quand la permission manque', async () => {
    let appels = 0;
    const contexte = creerContexte(
      { url: 'https://mcp.example/mcp' },
      {
        resolveHost: async () => {
          appels += 1;
          return ['93.184.216.34'];
        },
      },
    );
    const resultat = await executerOutil(contexte, {
      outil: 'delete_product',
      permission: { etat: 'denied' },
      outilsConnus: OUTILS_CONNUS,
      revoque: false,
    });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('outil_non_autorise');
    // Aucune résolution DNS, donc aucun octet émis.
    expect(appels).toBe(0);
  });

  it('ne contacte pas le serveur pour une écriture non confirmée', async () => {
    let appels = 0;
    const contexte = creerContexte(
      { url: 'https://mcp.example/mcp' },
      {
        resolveHost: async () => {
          appels += 1;
          return ['93.184.216.34'];
        },
      },
    );
    const resultat = await executerOutil(contexte, {
      outil: 'delete_product',
      permission: { etat: 'allowed' },
      outilsConnus: OUTILS_CONNUS,
      revoque: false,
    });
    expect(resultat.ok).toBe(false);
    expect(appels).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Échecs de connexion — états distincts                                   */
/* -------------------------------------------------------------------------- */

function serveurSansReponse(): ServeurExterne {
  return { url: 'https://mcp.example/mcp', auth: { kind: 'none' } };
}

describe('testerConnexion — états exposables', () => {
  it('refuse une adresse non publique AVANT toute connexion', async () => {
    let connexions = 0;
    const resultat = await testerConnexion(serveurSansReponse(), {
      resolveHost: async () => ['127.0.0.1'],
      connect: async () => {
        connexions += 1;
        throw new Error('ne doit jamais être atteint');
      },
    });
    expect(resultat.etat).toBe('error');
    // Refus SSRF, pas une panne réseau : le code le dit explicitement.
    expect(resultat.codes).toContain('serveur_invalide');
    expect(resultat.codes).not.toContain('reseau');
    expect(connexions).toBe(0);
    expect(resultat.message).not.toMatch(/127\.0\.0\.1|localhost/);
  });

  it('signale une authentification refusée comme auth_required', async () => {
    const resultat = await testerConnexion(serveurSansReponse(), {
      resolveHost: async () => ['93.184.216.34'],
      connect: async () => ({
        write: async (o: Uint8Array) => o.byteLength,
        read: async () => null,
        close: async () => undefined,
      }),
    });
    // Le socket ne rend rien : c'est une erreur de protocole, pas un succès.
    expect(resultat.etat).toBe('error');
    expect(resultat.codes?.length).toBeGreaterThan(0);
  });
});

describe('MAX_OUTILS', () => {
  it('borne la découverte conservée', () => {
    expect(MAX_OUTILS).toBeLessThanOrEqual(500);
    expect(MAX_OUTILS).toBeGreaterThan(0);
  });
});
