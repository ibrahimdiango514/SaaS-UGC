import { describe, expect, it } from 'vitest';
import { convertirPhrase, extraireJours, testerABlanc } from '../src/business/automation/phrase';

describe('Une phrase → une règle structurée', () => {
  it('convertit l’exemple canonique', () => {
    const conversion = convertirPhrase('si une facture a 7 jours de retard, prépare la relance');
    expect(conversion.ok).toBe(true);
    if (!conversion.ok) return;
    expect(conversion.regle.trigger).toBe('facture_retard');
    expect(conversion.regle.action).toBe('preparer_relance');
    expect(conversion.regle.thresholdDays).toBe(7);
    expect(conversion.regle.explication).toContain('valid');
  });

  it('accepte un seuil écrit en « 7j »', () => {
    expect(extraireJours('relance après 7j')).toBe(7);
  });

  it('comprend des expressions de temps courantes', () => {
    expect(extraireJours('dès aujourd’hui')).toBe(0);
    expect(extraireJours('la semaine prochaine')).toBe(7);
    expect(extraireJours('après un mois')).toBe(30);
  });

  it('refuse un seuil absurde plutôt que de le corriger en silence', () => {
    expect(extraireJours('après 999 jours')).toBeNull();
  });

  it('convertit un stock faible sans exiger de nombre de jours', () => {
    const conversion = convertirPhrase('quand le stock est bas, crée une tâche');
    expect(conversion.ok).toBe(true);
    if (!conversion.ok) return;
    expect(conversion.regle.trigger).toBe('stock_faible');
    expect(conversion.regle.action).toBe('creer_tache');
    expect(conversion.regle.thresholdDays).toBe(0);
  });

  it('reconnaît un devis, une créance, une opportunité, une promesse', () => {
    const cas: Array<[string, string]> = [
      ['si un devis n’a pas de réponse depuis 5 jours, prépare la relance', 'devis_sans_suivi'],
      ['quand une créance a 10 jours de retard, prépare la relance', 'creance_retard'],
      ['si une opportunité stagne 14 jours, crée une tâche', 'opportunite_stagnante'],
      ['si une promesse n’est pas respectée 3 jours après, notifie-moi', 'promesse_non_respectee'],
    ];
    for (const [phrase, attendu] of cas) {
      const conversion = convertirPhrase(phrase);
      expect(conversion.ok, phrase).toBe(true);
      if (conversion.ok) expect(conversion.regle.trigger).toBe(attendu);
    }
  });

  it('NE DEVINE PAS le déclencheur manquant : il pose la question', () => {
    const conversion = convertirPhrase('prépare la relance après 5 jours');
    expect(conversion.ok).toBe(false);
    if (conversion.ok) return;
    expect(conversion.questions.some((q) => q.includes('déclencher'))).toBe(true);
    expect(conversion.compris.action).toBe('preparer_relance');
    expect(conversion.compris.thresholdDays).toBe(5);
  });

  it('NE DEVINE PAS l’action manquante', () => {
    const conversion = convertirPhrase('si une facture a 7 jours de retard');
    expect(conversion.ok).toBe(false);
    if (conversion.ok) return;
    expect(conversion.questions.some((q) => q.includes('Que doit faire'))).toBe(true);
    expect(conversion.compris.trigger).toBe('facture_retard');
  });

  it('exige un délai pour un déclencheur daté', () => {
    const conversion = convertirPhrase('si une facture est en retard, prépare la relance');
    expect(conversion.ok).toBe(false);
    if (conversion.ok) return;
    expect(conversion.questions.some((q) => q.includes('combien de jours'))).toBe(true);
  });

  it('refuse une phrase vide sans planter', () => {
    for (const phrase of ['', '   ']) {
      const conversion = convertirPhrase(phrase);
      expect(conversion.ok).toBe(false);
    }
  });

  it('refuse une phrase incompréhensible au lieu d’inventer une règle', () => {
    const conversion = convertirPhrase('fais quelque chose de bien quand ça va mal');
    expect(conversion.ok).toBe(false);
    if (conversion.ok) return;
    expect(conversion.questions.length).toBeGreaterThanOrEqual(2);
  });

  it('borne la longueur du nom de règle', () => {
    const phrase = `si une facture a 7 jours de retard, prépare la relance ${'x'.repeat(1000)}`;
    const conversion = convertirPhrase(phrase);
    expect(conversion.ok).toBe(true);
    if (conversion.ok) expect(conversion.regle.name.length).toBeLessThanOrEqual(120);
  });
});

describe('Test à blanc — aperçu, jamais exécution', () => {
  it('liste les éléments qui déclencheraient, avec leur libellé réel', () => {
    const resultat = testerABlanc({ trigger: 'facture_retard', thresholdDays: 7 }, [
      { cle: 'f1', label: 'FAC-001', detail: '10 jours de retard', jours: 10 },
      { cle: 'f2', label: 'FAC-002', detail: '3 jours de retard', jours: 3 },
    ]);
    expect(resultat.declenchements.length).toBe(1);
    expect(resultat.declenchements[0].label).toBe('FAC-001');
    expect(resultat.message).toContain('Rien n’a été exécuté');
  });

  it('distingue « rien ne déclenche » de « rien à examiner »', () => {
    const rien = testerABlanc({ trigger: 'facture_retard', thresholdDays: 7 }, [
      { cle: 'f1', label: 'FAC-001', detail: '', jours: 2 },
    ]);
    expect(rien.message).toContain('aucun ne déclencherait');

    const vide = testerABlanc({ trigger: 'facture_retard', thresholdDays: 7 }, []);
    expect(vide.message).toContain('Aucune donnée à examiner');
    expect(vide.examines).toBe(0);
  });

  it('ignore un élément sans date plutôt que de le supposer en retard', () => {
    const resultat = testerABlanc({ trigger: 'facture_retard', thresholdDays: 0 }, [
      { cle: 'f1', label: 'Sans échéance', detail: '', jours: null },
    ]);
    expect(resultat.declenchements).toEqual([]);
    expect(resultat.examines).toBe(1);
  });
});
