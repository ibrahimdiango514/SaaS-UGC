import { describe, expect, it } from 'vitest';
import { construireBriefing, totalEnJeu, MAX_PRIORITES, type DonneesBriefing } from '../src/business/agent/socle/briefing';

function donnees(partiel: Partial<DonneesBriefing> = {}): DonneesBriefing {
  return {
    aujourdhui: '2026-11-25',
    creances: [], taches: [], litiges: [], contacts: [],
    ...partiel,
  };
}

describe('Briefing quotidien — trois priorités, jamais inventées', () => {
  it('ne rend rien quand il n’y a aucune donnée', () => {
    expect(construireBriefing(donnees())).toEqual([]);
  });

  it('ne dépasse jamais trois priorités', () => {
    const briefing = construireBriefing(donnees({
      creances: Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`, reference: `FAC-${i}`, solde: 100000 + i, devise: 'XOF', joursDeRetard: 10 + i,
        statut: 'en_retard', contactId: 'k1',
      })),
      taches: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, titre: `Tâche ${i}`, echeance: '2026-11-20', fait: false })),
    }));
    expect(briefing.length).toBe(MAX_PRIORITES);
    expect(MAX_PRIORITES).toBe(3);
  });

  it('place un litige dont l’échéance est dépassée avant une relance ordinaire', () => {
    const briefing = construireBriefing(donnees({
      creances: [{ id: 'c1', reference: 'FAC-001', solde: 50000, devise: 'XOF', joursDeRetard: 5, statut: 'en_retard', contactId: 'k1' }],
      litiges: [{ id: 'l1', creanceId: 'c1', montant: 250000, devise: 'XOF', echeance: '2026-11-20', statut: 'ouvert' }],
    }));
    expect(briefing[0]?.cle).toBe('litige:l1');
    expect(briefing[0]?.gravite).toBe('critique');
    expect(briefing[0]?.justification).toContain('a dépassé son échéance');
  });

  it('prépare une relance réelle avec arguments validables, sans l’exécuter', () => {
    const briefing = construireBriefing(donnees({
      creances: [{ id: 'c1', reference: 'FAC-001', solde: 120000, devise: 'XOF', joursDeRetard: 40, statut: 'en_retard', contactId: 'k1' }],
    }));
    expect(briefing[0]?.outil).toBe('planifier_relance');
    expect(briefing[0]?.argumentsOutil).toMatchObject({ creanceId: 'c1', ton: 'ferme' });
    expect(briefing[0]?.argumentsOutil.date).toBe('2026-11-27');
  });

  it('ignore une créance soldée ou annulée', () => {
    const briefing = construireBriefing(donnees({
      creances: [
        { id: 'c1', reference: 'FAC-1', solde: 0, devise: 'XOF', joursDeRetard: 30, statut: 'payee', contactId: 'k' },
        { id: 'c2', reference: 'FAC-2', solde: 90000, devise: 'XOF', joursDeRetard: 30, statut: 'annulee', contactId: 'k' },
      ],
    }));
    expect(briefing).toEqual([]);
  });

  it('ne signale pas un litige résolu, ni une échéance lointaine', () => {
    const briefing = construireBriefing(donnees({
      litiges: [
        { id: 'l1', creanceId: 'c1', montant: 100, devise: 'XOF', echeance: '2026-11-20', statut: 'resolu' },
        { id: 'l2', creanceId: 'c2', montant: 100, devise: 'XOF', echeance: '2027-06-01', statut: 'ouvert' },
      ],
    }));
    expect(briefing).toEqual([]);
  });

  it('n’invente aucun montant : une tâche n’a pas de montant en jeu', () => {
    const briefing = construireBriefing(donnees({
      taches: [{ id: 't1', titre: 'Appeler le fournisseur', echeance: '2026-11-20', fait: false }],
    }));
    expect(briefing[0]?.montantEnJeu).toBeNull();
    expect(briefing[0]?.devise).toBeNull();
  });

  it('est déterministe : mêmes données, même ordre', () => {
    const jeu = donnees({
      creances: [
        { id: 'c1', reference: 'A', solde: 100000, devise: 'XOF', joursDeRetard: 12, statut: 'en_retard', contactId: 'k' },
        { id: 'c2', reference: 'B', solde: 100000, devise: 'XOF', joursDeRetard: 12, statut: 'en_retard', contactId: 'k' },
      ],
    });
    const a = construireBriefing(jeu).map((p) => p.cle);
    const b = construireBriefing(jeu).map((p) => p.cle);
    expect(a).toEqual(b);
    expect(a[0]).toBe('creance:c1');
  });

  it('n’additionne pas des devises différentes', () => {
    const total = totalEnJeu([
      { cle: 'a', titre: '', justification: '', gravite: 'haute', montantEnJeu: 1000, devise: 'XOF', outil: null, argumentsOutil: {} },
      { cle: 'b', titre: '', justification: '', gravite: 'haute', montantEnJeu: 50, devise: 'EUR', outil: null, argumentsOutil: {} },
      { cle: 'c', titre: '', justification: '', gravite: 'haute', montantEnJeu: 500, devise: 'XOF', outil: null, argumentsOutil: {} },
    ]);
    expect(total).toEqual({ montant: 1500, devise: 'XOF' });
  });

  it('rend un total nul et sans devise quand aucun montant n’est connu', () => {
    expect(totalEnJeu([])).toEqual({ montant: 0, devise: null });
  });

  it('signale une prochaine action CRM due', () => {
    const briefing = construireBriefing(donnees({
      contacts: [{ id: 'k1', nom: 'Awa Traoré', prochaineAction: 'Envoyer le devis', prochaineActionAt: '2026-11-24' }],
    }));
    expect(briefing[0]?.titre).toBe('Prochaine action due : Awa Traoré');
  });
});
