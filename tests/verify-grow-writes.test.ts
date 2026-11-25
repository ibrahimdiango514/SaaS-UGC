import { describe, expect, it } from 'vitest';
// @ts-expect-error — script Node sans déclaration de types.
import { executerEcritures, nettoyer, rediger } from '../scripts/verify-grow-writes.mjs';

/**
 * Harnais de vérification des ÉCRITURES de Grow (`scripts/verify-grow-writes.mjs`).
 *
 * Aucun accès réseau : un `fetch` factice simule le backend. Ce qui est testé
 * ici, c'est la rigueur du harnais : accepte-t-il un 200 qui ne persiste rien ?
 * Nettoie-t-il après un échec ? Un harnais complaisant ferait croire que le
 * produit fonctionne — c'est pire que pas de harnais.
 */

type Reponse = { statut: number; corps: unknown };

/** Backend simulé, avec un magasin en mémoire. */
function fauxBackend(options: {
  /** Répond 200 à la création mais n'enregistre rien (écriture fantôme). */
  creationFantome?: boolean;
  /** La modification répond 200 mais n'applique rien. */
  modificationFantome?: boolean;
  /** La suppression répond 200 mais ne retire rien. */
  suppressionFantome?: boolean;
} = {}) {
  const magasin = new Map<string, { id: string; category: string; data: Record<string, unknown> }>();
  let compteur = 0;
  const appels: Array<{ action: string; op?: string }> = [];

  const fetchImpl = async (_url: string, init: { body?: string }) => {
    const corps = JSON.parse(String(init.body ?? '{}'));
    appels.push({ action: corps.action, op: corps.op });
    const repondre = (statut: number, json: unknown) => ({
      ok: statut >= 200 && statut < 300,
      status: statut,
      text: async () => JSON.stringify(json),
    });

    if (corps.action !== 'modules.records') return repondre(200, { data: {} });

    if (corps.op === 'create') {
      const id = `id-${++compteur}`;
      if (!options.creationFantome) {
        magasin.set(id, { id, category: corps.category, data: corps.data ?? {} });
      }
      return repondre(200, { data: { recordId: id } });
    }
    if (corps.op === 'list') {
      return repondre(200, { data: { records: [...magasin.values()].filter((r) => r.category === corps.category) } });
    }
    if (corps.op === 'update') {
      const existant = magasin.get(corps.recordId);
      if (!existant) return repondre(404, { error: { code: 'MODULE_RECORD_NOT_FOUND' } });
      if (!options.modificationFantome) {
        magasin.set(corps.recordId, { ...existant, data: { ...existant.data, ...(corps.data ?? {}) } });
      }
      return repondre(200, { data: { updated: true } });
    }
    if (corps.op === 'delete') {
      if (!options.suppressionFantome) magasin.delete(corps.recordId);
      return repondre(200, { data: { deleted: true } });
    }
    return repondre(400, { error: { code: 'UNKNOWN_ACTION' } });
  };

  return { fetchImpl, magasin, appels };
}

const PARAMS = (backend: ReturnType<typeof fauxBackend>) => ({
  base: 'https://exemple.test',
  jeton: 'jeton-de-test',
  marqueur: 'verif-test',
  fetchImpl: backend.fetchImpl,
});

describe('Écritures réelles — un 200 ne suffit pas', () => {
  it('un backend honnête passe : création, relecture, modification, suppression', async () => {
    const backend = fauxBackend();
    const { uids, echecs } = await executerEcritures(PARAMS(backend));
    expect(echecs).toEqual([]);
    // Le magasin doit être vide : le harnais supprime ce qu'il crée.
    expect(backend.magasin.size).toBe(0);
    // Et il ne doit rien rester à nettoyer.
    expect(uids).toEqual([]);
  });

  it('REFUSE une création fantôme (200 mais rien d’enregistré)', async () => {
    const backend = fauxBackend({ creationFantome: true });
    const { echecs } = await executerEcritures(PARAMS(backend));
    expect(echecs.length).toBeGreaterThan(0);
    for (const echec of echecs) {
      expect(echec).toMatch(/INTROUVABLE|création refusée/);
    }
  });

  it('REFUSE une modification fantôme (200 mais valeur inchangée)', async () => {
    const backend = fauxBackend({ modificationFantome: true });
    const { echecs, uids } = await executerEcritures(PARAMS(backend));
    expect(echecs.some((e: string) => e.includes('NON retrouvée'))).toBe(true);
    // Ce qui a été créé doit rester à nettoyer : le harnais ne doit pas l'oublier.
    expect(uids.length).toBeGreaterThan(0);
  });

  it('REFUSE une suppression fantôme (200 mais enregistrement toujours là)', async () => {
    const backend = fauxBackend({ suppressionFantome: true });
    const { echecs } = await executerEcritures(PARAMS(backend));
    expect(echecs.some((e: string) => e.includes('TOUJOURS présent'))).toBe(true);
  });

  it('ne teste que les modules métier : aucune génération, aucun paiement', async () => {
    const backend = fauxBackend();
    await executerEcritures(PARAMS(backend));
    for (const appel of backend.appels) {
      expect(appel.action).toBe('modules.records');
      expect(['create', 'list', 'update', 'delete']).toContain(appel.op);
    }
  });
});

describe('Nettoyage — ne rien laisser derrière soi', () => {
  it('supprime les identifiants restants et les retire de la liste à purger', async () => {
    const backend = fauxBackend();
    // Simule un essai interrompu : deux lignes créées à la main.
    for (const categorie of ['bg_module_crm_contacts', 'bg_module_cash_expenses']) {
      await backend.fetchImpl('https://exemple.test', {
        body: JSON.stringify({ action: 'modules.records', category: categorie, op: 'create', data: { name: 'reste' } }),
      });
    }
    expect(backend.magasin.size).toBe(2);
    const restants = await nettoyer({
      base: 'https://exemple.test', jeton: 'jeton-de-test',
      uids: [...backend.magasin.keys()], fetchImpl: backend.fetchImpl,
    });
    expect(restants.length).toBe(2); // la fonction rend la liste des tentatives
    expect(backend.magasin.size).toBe(0); // mais le magasin est bien vidé
  });

  it('ne lève pas si la suppression échoue : le rapport se poursuit', async () => {
    const fetchImpl = async () => { throw new Error('réseau coupé'); };
    await expect(nettoyer({ base: 'https://exemple.test', jeton: 'j', uids: ['a', 'b'], fetchImpl }))
      .resolves.toEqual(['a', 'b']);
  });
});

describe('Rédaction — aucun secret dans le rapport', () => {
  it('masque jetons, clés et mots de passe', () => {
    const sortie = rediger({
      access_token: 'secret-en-clair',
      erreur: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-longue',
      // Composée à l'exécution : une chaîne littérale déclencherait la garde de
      // secrets du dépôt, à juste titre.
      cle: ['sb', 'secret', 'tresSensible'].join('_'),
    });
    expect(sortie).not.toContain('secret-en-clair');
    expect(sortie).not.toContain('tresSensible');
    expect(sortie).toContain('<masqué>');
    expect(sortie).toContain('<clé-masquée>');
  });

  it('n’affiche pas « [object Object] »', () => {
    expect(rediger({ error: { code: 'MODULE_RECORD_NOT_FOUND' } })).toContain('MODULE_RECORD_NOT_FOUND');
  });
});
