import { describe, expect, it } from 'vitest';
import {
  actionsContreTrouDeCash, HORIZONS, prevoirTresorerie, probabiliteEncaissement,
  type EntreePrevision,
} from '../src/business/cash/prevision';

function entree(partiel: Partial<EntreePrevision> = {}): EntreePrevision {
  return {
    aujourdhui: '2026-11-25', devise: 'XOF', tresorerieActuelle: 500000,
    creances: [], depenses: [],
    ...partiel,
  };
}

describe('Prévision de trésorerie — ne jamais inventer un chiffre', () => {
  it('annonce le vide au lieu d’afficher un zéro trompeur', () => {
    const prevision = prevoirTresorerie(entree(), 8);
    expect(prevision.vide).toBe(true);
    expect(prevision.creancesNonDatees).toBe(0);
  });

  it('projette une créance future dans la semaine de son échéance', () => {
    const prevision = prevoirTresorerie(entree({
      creances: [{ id: 'c1', reference: 'FAC-001', solde: 100000, devise: 'XOF', echeance: '2026-12-10', joursDeRetard: 0, statut: 'en_attente' }],
    }), 8);
    const semaineEcheance = prevision.semaines.find((s) => s.fin >= '2026-12-10');
    expect(semaineEcheance?.entrees).toBe(90000); // 100 000 × 0,9
    expect(prevision.semaines[0].entrees).toBe(0);
  });

  it('place une créance déjà en retard dans la semaine 1', () => {
    const prevision = prevoirTresorerie(entree({
      creances: [{ id: 'c1', reference: 'FAC-001', solde: 100000, devise: 'XOF', echeance: '2026-11-10', joursDeRetard: 15, statut: 'en_retard' }],
    }), 4);
    expect(prevision.semaines[0].entrees).toBe(80000); // 100 000 × 0,8
  });

  it('exclut les créances soldées, annulées ou en brouillon', () => {
    const prevision = prevoirTresorerie(entree({
      creances: [
        { id: 'a', reference: 'A', solde: 0, devise: 'XOF', echeance: '2026-12-01', joursDeRetard: 0, statut: 'payee' },
        { id: 'b', reference: 'B', solde: 50000, devise: 'XOF', echeance: '2026-12-01', joursDeRetard: 0, statut: 'annulee' },
        { id: 'c', reference: 'C', solde: 50000, devise: 'XOF', echeance: '2026-12-01', joursDeRetard: 0, statut: 'brouillon' },
      ],
    }), 4);
    expect(prevision.vide).toBe(true);
  });

  it('n’additionne jamais deux devises', () => {
    const prevision = prevoirTresorerie(entree({
      creances: [
        { id: 'a', reference: 'A', solde: 100000, devise: 'XOF', echeance: '2026-12-01', joursDeRetard: 0, statut: 'en_attente' },
        { id: 'b', reference: 'B', solde: 900, devise: 'EUR', echeance: '2026-12-01', joursDeRetard: 0, statut: 'en_attente' },
      ],
    }), 4);
    const totalEntrees = prevision.semaines.reduce((s, w) => s + w.entrees, 0);
    expect(totalEntrees).toBe(90000); // la créance EUR est ignorée
  });

  it('signale les créances sans échéance au lieu de les projeter', () => {
    const prevision = prevoirTresorerie(entree({
      creances: [{ id: 'a', reference: 'A', solde: 75000, devise: 'XOF', echeance: '', joursDeRetard: 0, statut: 'en_attente' }],
    }), 4);
    expect(prevision.creancesNonDatees).toBe(1);
    expect(prevision.montantNonDate).toBe(75000);
    expect(prevision.semaines.every((s) => s.entrees === 0)).toBe(true);
  });

  it('détecte la première semaine où la trésorerie passe sous zéro', () => {
    const prevision = prevoirTresorerie(entree({
      tresorerieActuelle: 50000,
      depenses: [{ id: 'd1', label: 'Loyer', montant: 300000, date: '2026-12-05', statut: 'engagee', recurrence: 'aucune' }],
    }), 4);
    expect(prevision.premiereSemaineNegative).not.toBeNull();
    expect(prevision.semaines[prevision.premiereSemaineNegative! - 1].cumul).toBeLessThan(0);
  });

  it('ne signale aucun trou quand la trésorerie reste positive', () => {
    const prevision = prevoirTresorerie(entree({
      tresorerieActuelle: 1000000,
      depenses: [{ id: 'd1', label: 'Loyer', montant: 30000, date: '2026-12-05', statut: 'engagee', recurrence: 'aucune' }],
    }), 4);
    expect(prevision.premiereSemaineNegative).toBeNull();
  });

  it('compte une dépense engagée déjà échue sur la semaine 1', () => {
    const prevision = prevoirTresorerie(entree({
      depenses: [{ id: 'd1', label: 'Fournisseur', montant: 120000, date: '2026-11-01', statut: 'engagee', recurrence: 'aucune' }],
    }), 4);
    expect(prevision.semaines[0].sorties).toBe(120000);
  });

  it('ne compte pas deux fois une dépense engagée future', () => {
    const prevision = prevoirTresorerie(entree({
      depenses: [{ id: 'd1', label: 'Fournisseur', montant: 120000, date: '2026-12-03', statut: 'engagee', recurrence: 'aucune' }],
    }), 8);
    const total = prevision.semaines.reduce((s, w) => s + w.sorties, 0);
    expect(total).toBe(120000);
  });

  it('répète une dépense mensuelle sur l’horizon', () => {
    const prevision = prevoirTresorerie(entree({
      depenses: [{ id: 'd1', label: 'Logiciel', montant: 20000, date: '2026-11-01', statut: 'payee', recurrence: 'mensuelle' }],
    }), 12);
    const occurrences = prevision.semaines.reduce((s, w) => s + Math.round(w.sorties / 20000), 0);
    expect(occurrences).toBeGreaterThanOrEqual(2); // sur ~3 mois
    expect(occurrences).toBeLessThanOrEqual(4);
  });

  it('ignore les dépenses annulées', () => {
    const prevision = prevoirTresorerie(entree({
      depenses: [{ id: 'd1', label: 'Annulée', montant: 999999, date: '2026-12-01', statut: 'annulee', recurrence: 'aucune' }],
    }), 4);
    expect(prevision.vide).toBe(true);
  });

  it('expose les trois horizons 4/8/12', () => {
    expect(HORIZONS).toEqual([4, 8, 12]);
    for (const horizon of HORIZONS) {
      expect(prevoirTresorerie(entree(), horizon).semaines.length).toBe(horizon);
    }
  });

  it('décroît la probabilité d’encaissement avec l’ancienneté du retard', () => {
    const valeurs = [0, 10, 30, 60, 90, 120].map(probabiliteEncaissement);
    for (let i = 1; i < valeurs.length; i += 1) {
      expect(valeurs[i]).toBeLessThan(valeurs[i - 1]);
    }
    expect(valeurs.every((v) => v > 0 && v <= 1)).toBe(true);
  });
});

describe('Actions contre un trou de cash — chiffrées et fondées', () => {
  it('ne propose rien quand il n’y a pas de trou', () => {
    const donnees = entree();
    expect(actionsContreTrouDeCash(prevoirTresorerie(donnees, 4), donnees)).toEqual([]);
  });

  it('propose des actions chiffrées, chacune avec son fondement', () => {
    const donnees = entree({
      tresorerieActuelle: 10000,
      creances: [
        { id: 'a', reference: 'A', solde: 200000, devise: 'XOF', echeance: '2026-11-01', joursDeRetard: 24, statut: 'en_retard' },
        { id: 'b', reference: 'B', solde: 30000, devise: 'XOF', echeance: '', joursDeRetard: 0, statut: 'en_attente' },
      ],
      depenses: [{ id: 'd', label: 'Loyer', montant: 400000, date: '2026-11-30', statut: 'engagee', recurrence: 'aucune' }],
    });
    const prevision = prevoirTresorerie(donnees, 4);
    const actions = actionsContreTrouDeCash(prevision, donnees);
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions.length).toBeLessThanOrEqual(3);
    for (const action of actions) {
      expect(action.fondement.length).toBeGreaterThan(10);
      expect(Number.isFinite(action.effet)).toBe(true);
    }
  });

  it('ne promet aucun résultat dans le libellé', () => {
    const donnees = entree({
      tresorerieActuelle: 0,
      depenses: [{ id: 'd', label: 'Loyer', montant: 400000, date: '2026-11-30', statut: 'engagee', recurrence: 'aucune' }],
    });
    for (const action of actionsContreTrouDeCash(prevoirTresorerie(donnees, 4), donnees)) {
      expect(action.label).not.toMatch(/garanti|assur[ée]|certain|vous allez/i);
    }
  });
});
