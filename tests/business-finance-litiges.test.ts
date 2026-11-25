import { describe, expect, it } from 'vitest';
import {
  alerteEcheance, brouillonReponse, dossierFrom, dossiersAQctiver, inventorierPreuves,
  preuvesManquantes, type SourcePreuves,
} from '../src/business/finance/litiges';
import type { ReceivableDispute } from '../src/business/finance/model';

const dispute = (partiel: Partial<ReceivableDispute> = {}): ReceivableDispute => ({
  id: 'l1', receivableId: 'r1', contactId: 'k1', reason: 'Montant contesté',
  description: 'Le client conteste la ligne de livraison.', openedAt: '2026-11-10',
  owner: 'Aïcha', status: 'ouvert', resolution: '', createdAt: '2026-11-10T08:00:00Z',
  ...partiel,
});

const sources = (partiel: Partial<SourcePreuves> = {}): SourcePreuves => ({
  creance: { reference: 'FAC-0042', montantInitial: 250000, devise: 'XOF', dueDate: '2026-11-01', conditions: 'Paiement à 30 jours' },
  relances: 2, paiements: 1, commande: null, echanges: 3,
  ...partiel,
});

describe('Dossiers de litige — compatibilité et honnêteté', () => {
  it('relit un ANCIEN dossier sans montant ni échéance, sans erreur', () => {
    const dossier = dossierFrom(dispute(), { reason: 'Montant contesté' }, '2026-11-25');
    expect(dossier.montant).toBeNull();
    expect(dossier.echeance).toBe('');
    expect(dossier.enRetard).toBeNull();
    expect(dossier.joursRestants).toBeNull();
  });

  it('calcule le retard depuis la date saisie', () => {
    const dossier = dossierFrom(dispute(), { montant: 250000, devise: 'xof', echeance: '2026-11-20' }, '2026-11-25');
    expect(dossier.enRetard).toBe(true);
    expect(dossier.joursRestants).toBe(-5);
    expect(dossier.devise).toBe('XOF');
  });

  it('ignore une date mal formée plutôt que d’inventer une échéance', () => {
    const dossier = dossierFrom(dispute(), { echeance: '20/11/2026' }, '2026-11-25');
    expect(dossier.echeance).toBe('');
    expect(dossier.joursRestants).toBeNull();
  });

  it('ignore un montant négatif ou non numérique', () => {
    expect(dossierFrom(dispute(), { montant: -100 }, '2026-11-25').montant).toBeNull();
    expect(dossierFrom(dispute(), { montant: '250000' }, '2026-11-25').montant).toBeNull();
  });

  it('alerte selon l’échéance, sans conclure', () => {
    expect(alerteEcheance(dossierFrom(dispute(), { echeance: '2026-11-20' }, '2026-11-25')).niveau).toBe('depassee');
    expect(alerteEcheance(dossierFrom(dispute(), { echeance: '2026-11-25' }, '2026-11-25')).niveau).toBe('aujourdhui');
    expect(alerteEcheance(dossierFrom(dispute(), { echeance: '2026-11-28' }, '2026-11-25')).niveau).toBe('proche');
    const sansDate = alerteEcheance(dossierFrom(dispute(), {}, '2026-11-25'));
    expect(sansDate.niveau).toBe('aucune');
    expect(sansDate.label).toContain('Aucune échéance');
  });

  it('trie les dossiers à traiter par urgence réelle, sans priorité inventée', () => {
    const urgent = dossierFrom(dispute({ id: 'a' }), { echeance: '2026-11-01' }, '2026-11-25');
    const moyen = dossierFrom(dispute({ id: 'b' }), { echeance: '2026-11-28' }, '2026-11-25');
    const sansDate = dossierFrom(dispute({ id: 'c' }), {}, '2026-11-25');
    const clos = dossierFrom(dispute({ id: 'd', status: 'resolu' }), { echeance: '2026-10-01' }, '2026-11-25');
    const tries = dossiersAQctiver([sansDate, moyen, clos, urgent]).map((d) => d.dispute.id);
    expect(tries).toEqual(['a', 'b', 'c']);
  });
});

describe('Preuves — jamais inventées', () => {
  it('marque absente une preuve qui n’existe pas dans les données', () => {
    const preuves = inventorierPreuves(sources({ paiements: 0, echanges: 0, relances: 0, commande: null }));
    const absentes = preuvesManquantes(preuves).map((p) => p.type).sort();
    expect(absentes).toEqual(['echanges', 'livraison', 'paiements', 'relances']);
    for (const preuve of preuvesManquantes(preuves)) expect(preuve.detail).toBe('');
  });

  it('décrit la preuve avec sa source réelle quand elle existe', () => {
    const preuves = inventorierPreuves(sources({ commande: { numero: 'CMD-7', statut: 'livre' } }));
    const facture = preuves.find((p) => p.type === 'facture');
    expect(facture?.disponible).toBe(true);
    expect(facture?.detail).toContain('FAC-0042');
    expect(preuves.find((p) => p.type === 'livraison')?.detail).toContain('CMD-7');
    expect(preuves.every((p) => p.source.length > 0)).toBe(true);
  });

  it('n’affirme jamais qu’une preuve existe sans créance liée', () => {
    const preuves = inventorierPreuves(sources({ creance: null }));
    expect(preuves.find((p) => p.type === 'facture')?.disponible).toBe(false);
    expect(preuves.find((p) => p.type === 'echeances')?.disponible).toBe(false);
  });
});

describe('Brouillon de réponse — relu par l’utilisateur, sans promesse', () => {
  it('cite la facture et le motif réels, et seulement les preuves disponibles', () => {
    const dossier = dossierFrom(dispute(), { montant: 250000, devise: 'XOF', echeance: '2026-11-20' }, '2026-11-25');
    const brouillon = brouillonReponse(dossier, inventorierPreuves(sources({ commande: null, paiements: 0 })));
    expect(brouillon.objet).toContain('FAC-0042');
    expect(brouillon.corps).toContain('250');
    expect(brouillon.corps).toContain('Montant contesté');
    expect(brouillon.corps).not.toContain('Preuve de livraison :');
  });

  it('avertit quand aucune preuve n’est disponible, au lieu de combler le vide', () => {
    const dossier = dossierFrom(dispute(), {}, '2026-11-25');
    const brouillon = brouillonReponse(dossier, inventorierPreuves(sources({
      creance: null, paiements: 0, echanges: 0, relances: 0, commande: null,
    })));
    expect(brouillon.corps).toContain('Aucun élément n’est encore disponible');
    expect(brouillon.avertissements.some((a) => a.includes('réunissez-les'))).toBe(true);
  });

  it('ne promet aucune victoire et ne menace pas', () => {
    const dossier = dossierFrom(dispute(), { montant: 250000, devise: 'XOF' }, '2026-11-25');
    const brouillon = brouillonReponse(dossier, inventorierPreuves(sources()));
    const texte = `${brouillon.objet} ${brouillon.corps} ${brouillon.avertissements.join(' ')}`;
    expect(texte).not.toMatch(/gagn|victoire|assur[ée]|garanti|poursuites|avocat|tribunal/i);
    expect(brouillon.avertissements.some((a) => a.includes('conseil juridique'))).toBe(true);
    expect(brouillon.avertissements.some((a) => a.includes('brouillon'))).toBe(true);
  });

  it('borne la longueur du brouillon', () => {
    const long = dossierFrom(dispute({ reason: 'x'.repeat(5000) }), {}, '2026-11-25');
    expect(brouillonReponse(long, inventorierPreuves(sources())).corps.length).toBeLessThanOrEqual(4000);
  });
});
