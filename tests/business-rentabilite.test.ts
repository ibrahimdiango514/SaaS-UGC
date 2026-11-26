import { describe, expect, it } from 'vitest';
import {
  abonnementsEnDoublon, fuitesDetectees, lignesFacturees, rapportRentabilite,
  type DepenseRecurrente, type LigneVendue,
} from '../src/business/catalog/rentabilite';
import type { Product } from '../src/business/catalog/model';
import type { Invoice } from '../src/business/sales/model';

const produit = (partiel: Partial<Product> & { id: string }): Product => ({
  name: 'Produit', sku: 'SKU-1', category: 'Divers', kind: 'produit', description: '',
  price: 10000, cost: 6000, unit: 'pièce', trackStock: true, stock: 10, reorderLevel: 2,
  supplierId: '', barcode: '', notes: '', createdAt: '', updatedAt: '',
  ...partiel,
} as Product);

const ligne = (partiel: Partial<LigneVendue> & { productId: string }): LigneVendue => ({
  quantite: 1, prixUnitaire: 10000, remisePct: 0, taxePct: 0, ...partiel,
});

describe('Rentabilité — marge réelle, jamais supposée', () => {
  it('calcule une marge simple', () => {
    const rapport = rapportRentabilite([produit({ id: 'p1' })], [ligne({ productId: 'p1', quantite: 3 })]);
    expect(rapport.produits[0].revenu).toBe(30000);
    expect(rapport.produits[0].cout).toBe(18000);
    expect(rapport.produits[0].marge).toBe(12000);
    expect(rapport.produits[0].tauxMarge).toBe(40);
    expect(rapport.produits[0].venteAPerte).toBe(false);
  });

  it('retire la remise ET la taxe du revenu (la taxe n’appartient pas à l’entreprise)', () => {
    // 11 000 TTC à 10 % de TVA = 10 000 HT ; remise 20 % = 8 000 net.
    const rapport = rapportRentabilite(
      [produit({ id: 'p1', cost: 5000 })],
      [ligne({ productId: 'p1', prixUnitaire: 11000, remisePct: 20, taxePct: 10 })],
    );
    expect(rapport.produits[0].revenu).toBe(8000);
    expect(rapport.produits[0].marge).toBe(3000);
  });

  it('n’invente JAMAIS de marge quand le coût est inconnu', () => {
    const rapport = rapportRentabilite([produit({ id: 'p1', cost: null })], [ligne({ productId: 'p1' })]);
    expect(rapport.produits[0].cout).toBeNull();
    expect(rapport.produits[0].marge).toBeNull();
    expect(rapport.produits[0].tauxMarge).toBeNull();
    expect(rapport.produits[0].venteAPerte).toBe(false);
    expect(rapport.produitsSansCout).toEqual(['Produit']);
    expect(rapport.couvertureCout).toBe(0);
  });

  it('traite un produit absent du catalogue comme coût inconnu, pas comme coût nul', () => {
    const rapport = rapportRentabilite([], [ligne({ productId: 'inconnu' })]);
    expect(rapport.produits[0].marge).toBeNull();
    expect(rapport.produits[0].nom).toContain('supprimé');
    expect(rapport.produits[0].venteAPerte).toBe(false);
  });

  it('détecte une vente à perte seulement si le coût est connu', () => {
    const rapport = rapportRentabilite(
      [produit({ id: 'p1', cost: 12000 }), produit({ id: 'p2', cost: null })],
      [ligne({ productId: 'p1' }), ligne({ productId: 'p2' })],
    );
    const p1 = rapport.produits.find((p) => p.productId === 'p1')!;
    expect(p1.venteAPerte).toBe(true);
    expect(p1.marge).toBe(-2000);
    expect(rapport.ventesAPerte).toBe(1);
  });

  it('mesure la couverture du coût, pour ne pas cacher l’angle mort', () => {
    const rapport = rapportRentabilite(
      [produit({ id: 'p1', cost: 6000 }), produit({ id: 'p2', cost: null })],
      [ligne({ productId: 'p1' }), ligne({ productId: 'p2' })],
    );
    expect(rapport.revenuTotal).toBe(20000);
    expect(rapport.couvertureCout).toBe(50);
  });

  it('ne mélange pas deux devises', () => {
    const factures = [
      { status: 'payee', currency: 'XOF', lines: [{ productId: 'p1', quantity: 2, unitPrice: 10000, discountPct: 0, taxPct: 0 }] },
      { status: 'payee', currency: 'EUR', lines: [{ productId: 'p1', quantity: 1, unitPrice: 900, discountPct: 0, taxPct: 0 }] },
    ] as unknown as Invoice[];
    const lignes = lignesFacturees(factures, 'XOF');
    expect(lignes.length).toBe(1);
    expect(lignes[0].quantite).toBe(2);
  });

  it('exclut les factures brouillon et annulées (ce ne sont pas des ventes)', () => {
    const factures = [
      { status: 'brouillon', currency: 'XOF', lines: [{ productId: 'p1', quantity: 5, unitPrice: 10000, discountPct: 0, taxPct: 0 }] },
      { status: 'annulee', currency: 'XOF', lines: [{ productId: 'p1', quantity: 5, unitPrice: 10000, discountPct: 0, taxPct: 0 }] },
      { status: 'payee', currency: 'XOF', lines: [{ productId: 'p1', quantity: 1, unitPrice: 10000, discountPct: 0, taxPct: 0 }] },
    ] as unknown as Invoice[];
    expect(lignesFacturees(factures, 'XOF').length).toBe(1);
  });

  it('classe les produits les plus rentables en premier', () => {
    const rapport = rapportRentabilite(
      [produit({ id: 'p1', name: 'Faible', cost: 9000 }), produit({ id: 'p2', name: 'Forte', cost: 1000 })],
      [ligne({ productId: 'p1' }), ligne({ productId: 'p2' })],
    );
    expect(rapport.produits[0].nom).toBe('Forte');
  });

  it('ne divise pas par zéro quand le revenu est nul', () => {
    const rapport = rapportRentabilite([produit({ id: 'p1' })], [ligne({ productId: 'p1', prixUnitaire: 0 })]);
    expect(rapport.produits[0].tauxMarge).toBeNull();
  });
});

describe('Fuites — signalées, jamais affirmées', () => {
  const depense = (partiel: Partial<DepenseRecurrente> & { id: string }): DepenseRecurrente => ({
    label: 'Abonnement', amount: 10000, recurrence: 'mensuelle', status: 'payee', ...partiel,
  });

  it('détecte un abonnement au même libellé, avec le montant mensuel', () => {
    const doublons = abonnementsEnDoublon([
      depense({ id: 'a', label: 'Internet Bureau' }),
      depense({ id: 'b', label: 'internet  bureau', amount: 15000 }),
      depense({ id: 'c', label: 'Loyer' }),
    ]);
    expect(doublons.length).toBe(1);
    expect(doublons[0].libelles.length).toBe(2);
    expect(doublons[0].montantMensuelEstime).toBe(25000);
  });

  it('mensualise correctement une dépense annuelle', () => {
    const doublons = abonnementsEnDoublon([
      depense({ id: 'a', label: 'Assurance', amount: 120000, recurrence: 'annuelle' }),
      depense({ id: 'b', label: 'Assurance', amount: 120000, recurrence: 'annuelle' }),
    ]);
    expect(doublons[0].montantMensuelEstime).toBe(20000);
  });

  it('ignore les dépenses ponctuelles et annulées', () => {
    expect(abonnementsEnDoublon([
      depense({ id: 'a', label: 'Achat', recurrence: 'aucune' }),
      depense({ id: 'b', label: 'Achat', recurrence: 'aucune' }),
      depense({ id: 'c', label: 'Taxe', status: 'annulee' }),
      depense({ id: 'd', label: 'Taxe', status: 'annulee' }),
    ])).toEqual([]);
  });

  it('liste les fuites avec un montant avant celles qui n’en ont pas', () => {
    const rapport = rapportRentabilite(
      [produit({ id: 'p1', name: 'Perte', cost: 12000 }), produit({ id: 'p2', name: 'SansCoût', cost: null })],
      [ligne({ productId: 'p1' }), ligne({ productId: 'p2' })],
    );
    const fuites = fuitesDetectees(rapport, [depense({ id: 'a', label: 'Net' }), depense({ id: 'b', label: 'Net' })]);
    expect(fuites.length).toBeGreaterThanOrEqual(3);
    expect(fuites[0].montant).not.toBeNull();
    expect(fuites[fuites.length - 1].montant).toBeNull();
    expect(fuites.some((f) => f.type === 'produit_sans_cout')).toBe(true);
  });

  it('n’affirme pas qu’un abonnement est un doublon', () => {
    const rapport = rapportRentabilite([produit({ id: 'p1' })], [ligne({ productId: 'p1' })]);
    const fuites = fuitesDetectees(rapport, [depense({ id: 'a', label: 'Internet' }), depense({ id: 'b', label: 'Internet' })]);
    const doublon = fuites.find((f) => f.type === 'abonnement_doublon');
    expect(doublon?.detail).toContain('seul vous savez');
  });
});
