import { describe, expect, it } from 'vitest';
import { analyserCsvDepenses } from '../src/business/cash/model';

/**
 * Import CSV des dépenses.
 *
 * Une dépense fausse ne se voit pas : elle fausse la trésorerie, la prévision et
 * la rentabilité. L'analyse doit donc être stricte et BRUYANTE : une ligne
 * douteuse est refusée avec sa raison, jamais corrigée en silence.
 */
describe('Import CSV des dépenses', () => {
  it('accepte un fichier propre en point-virgule', () => {
    const analyse = analyserCsvDepenses([
      'date;libelle;categorie;montant;statut',
      '2026-11-01;Loyer novembre;Loyer;250000;payee',
      '2026-11-03;Transport;Transport;15000;engagee',
    ].join('\n'));

    expect(analyse.erreurs).toHaveLength(0);
    expect(analyse.acceptees).toBe(2);
    expect(analyse.refusees).toBe(0);
    expect(analyse.lignes[0].depense).toMatchObject({
      label: 'Loyer novembre', category: 'Loyer', amount: 250000, incurredAt: '2026-11-01', status: 'payee',
    });
    // Une dépense engagée n'a pas de date de paiement inventée.
    expect(analyse.lignes[1].depense?.paidAt).toBe('');
  });

  it('accepte le format de date français et le séparateur virgule', () => {
    const analyse = analyserCsvDepenses('date,libelle,montant\n05/11/2026,Carburant,20000');
    expect(analyse.acceptees).toBe(1);
    expect(analyse.lignes[0].depense?.incurredAt).toBe('2026-11-05');
  });

  it('refuse une date impossible au lieu de la décaler', () => {
    const analyse = analyserCsvDepenses('date;libelle;montant\n31/02/2026;Erreur;1000');
    expect(analyse.acceptees).toBe(0);
    expect(analyse.refusees).toBe(1);
    expect(analyse.lignes[0].erreurs.join(' ')).toMatch(/Date illisible/);
  });

  it('refuse un montant nul, négatif ou illisible', () => {
    const analyse = analyserCsvDepenses([
      'date;libelle;montant',
      '2026-11-01;Gratuit;0',
      '2026-11-01;Negatif;-500',
      '2026-11-01;Illisible;abc',
    ].join('\n'));
    expect(analyse.acceptees).toBe(0);
    expect(analyse.refusees).toBe(3);
  });

  it('refuse une ligne sans libellé, en la gardant visible', () => {
    const analyse = analyserCsvDepenses('date;libelle;montant\n2026-11-01;;5000');
    expect(analyse.lignes[0].depense).toBeNull();
    expect(analyse.lignes[0].erreurs.join(' ')).toMatch(/Libellé manquant/);
    expect(analyse.lignes[0].brut.date).toBe('2026-11-01');
  });

  it('exige les trois colonnes indispensables', () => {
    const sansMontant = analyserCsvDepenses('date;libelle\n2026-11-01;Loyer');
    expect(sansMontant.erreurs[0]).toMatch(/obligatoires/);
    const vide = analyserCsvDepenses('');
    expect(vide.erreurs.length).toBeGreaterThan(0);
  });

  it('respecte les guillemets et les virgules internes', () => {
    const analyse = analyserCsvDepenses('date,libelle,montant\n2026-11-01,"Loyer, charges comprises",250000');
    expect(analyse.acceptees).toBe(1);
    expect(analyse.lignes[0].depense?.label).toBe('Loyer, charges comprises');
  });

  it('n’invente ni catégorie ni moyen de paiement', () => {
    const analyse = analyserCsvDepenses('date;libelle;montant\n2026-11-01;Divers;1000');
    expect(analyse.lignes[0].depense?.category).toBe('Autre');
    expect(analyse.lignes[0].depense?.method).toBe('especes');
  });

  it('compte séparément acceptées et refusées dans un fichier mixte', () => {
    const analyse = analyserCsvDepenses([
      'date;libelle;montant',
      '2026-11-01;Bon;5000',
      'pas-une-date;Mauvais;5000',
      '2026-11-02;Bon aussi;7000',
    ].join('\n'));
    expect(analyse.acceptees).toBe(2);
    expect(analyse.refusees).toBe(1);
    expect(analyse.lignes[1].ligne).toBe(3);
  });
});
