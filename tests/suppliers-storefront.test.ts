import { describe, expect, it } from 'vitest';
import {
  buildReceipt, computePurchaseSummary, nextPurchaseNumber, purchaseFromRecord, purchaseToExpenseData,
  receiptFromRecord, receiptStockMovements, supplierFromRecord,
} from '../src/business/suppliers/model';
import {
  catalogHtml, computeStorefrontSummary, requestFromRecord, requestToContactData,
  requestToOrderLines, requestTotal, settingsFromRecord, settingsToData, slugify, visibleProducts,
} from '../src/business/storefront/model';
import { productFromRecord } from '../src/business/catalog/model';

const purchase = purchaseFromRecord({
  id: 'po1',
  data: {
    number: 'ACH-2026-0001', supplierId: 's1', status: 'confirme', orderedAt: '2026-11-01',
    lines: [
      { id: 'l1', productId: 'p1', description: 'Savon brut', quantity: 10, unitPrice: 500, discountPct: 0, taxPct: 0 },
      { id: 'l2', productId: '', description: 'Transport', quantity: 1, unitPrice: 2_000, discountPct: 0, taxPct: 0 },
    ],
  },
});

const supplier = supplierFromRecord({
  id: 's1', data: { name: 'Grossiste Karité', contactName: 'Awa', phone: '+223 70 00 00 00', status: 'actif' },
});

describe('Lot J — fournisseurs et achats', () => {
  it('numérote les achats comme des documents professionnels', () => {
    expect(nextPurchaseNumber([], new Date('2026-11-22T00:00:00Z'))).toBe('ACH-2026-0001');
    expect(nextPurchaseNumber(['ACH-2026-0004'], new Date('2026-11-22T00:00:00Z'))).toBe('ACH-2026-0005');
  });

  it('prépare une réception uniquement pour les lignes liées à un produit', () => {
    const receipt = buildReceipt(purchase, '2026-11-15');
    expect(receipt.lines).toHaveLength(1);
    expect(receipt.lines[0]).toMatchObject({ productId: 'p1', quantity: 10 });
  });

  it('crée des entrées de stock dédupliquées par réception et ligne', () => {
    const receipt = receiptFromRecord({
      id: 'rec1', data: { purchaseOrderId: 'po1', supplierId: 's1', receivedAt: '2026-11-15', lines: [{ id: 'l1', productId: 'p1', quantity: 10 }] },
    });
    const movements = receiptStockMovements(receipt);
    expect(movements).toHaveLength(1);
    expect(movements[0].data).toMatchObject({ productId: 'p1', type: 'entree', quantity: 10 });
    expect(movements[0].dedupeKey).toBe('receipt:rec1:line:l1');
  });

  it('prépare une dépense fournisseur sans la créer automatiquement', () => {
    const data = purchaseToExpenseData(purchase, supplier.name, false);
    expect(data).toMatchObject({ category: 'Fournisseurs', supplier: 'Grossiste Karité', amount: 7_000, status: 'engagee', purchaseOrderId: 'po1' });
  });

  it('résume les achats ouverts et reçus', () => {
    const summary = computePurchaseSummary([supplier], [purchase, purchaseFromRecord({ id: 'po2', data: { ...purchase, status: 'recu' } })]);
    expect(summary.suppliers).toBe(1);
    expect(summary.openOrders).toBe(1);
    expect(summary.receivedOrders).toBe(1);
    expect(summary.openAmount).toBe(7_000);
  });
});

const settings = settingsFromRecord({
  id: 'set1',
  data: { slug: 'ma-boutique', headline: 'Nos savons', visibleProductIds: ['p1'], published: true },
});

const products = [
  productFromRecord({ id: 'p1', data: { name: 'Savon', active: true, price: 1_500 } }),
  productFromRecord({ id: 'p2', data: { name: 'Masque', active: true, price: 3_000 } }),
  productFromRecord({ id: 'p3', data: { name: 'Ancien', active: false, price: 1_000 } }),
];

const request = requestFromRecord({
  id: 'req1',
  data: {
    customerName: 'Awa Traoré', phone: '+223 76 12 34 56', email: 'AWA@example.com',
    lines: [{ productId: 'p1', name: 'Savon', quantity: 2, unitPrice: 1_500 }],
    status: 'nouveau', requestedAt: '2026-11-20',
  },
});

describe('Lot K — vitrine commerciale', () => {
  it('normalise l’adresse courte et ne sélectionne que les produits visibles', () => {
    expect(slugify('Boutique Awa — Bamako')).toBe('boutique-awa-bamako');
    expect(visibleProducts(products, settings).map((product) => product.id)).toEqual(['p1']);
    expect(settingsToData(settings)).toMatchObject({ slug: 'ma-boutique', published: true });
  });

  it('calcule le total d’une demande uniquement si les prix sont connus', () => {
    expect(requestTotal(request)).toBe(3_000);
    const unknown = requestFromRecord({ id: 'req2', data: { ...request, lines: [{ name: 'Sur devis', quantity: 1 }] } });
    expect(requestTotal(unknown)).toBeNull();
  });

  it('convertit une demande en prospect sans créer de doublon', () => {
    const result = requestToContactData(request, []);
    expect(result.duplicate).toBe(false);
    expect(result.data).toMatchObject({ firstName: 'Awa', lastName: 'Traoré', type: 'prospect', source: 'boutique' });
    const duplicate = requestToContactData(request, [{ phone: '76123456', email: 'autre@example.com' }]);
    expect(duplicate).toEqual({ duplicate: true, data: null });
  });

  it('crée les lignes de commande depuis la demande', () => {
    const lines = requestToOrderLines(request);
    expect(lines[0]).toMatchObject({ productId: 'p1', quantity: 2, unitPrice: 1_500 });
    expect(requestToOrderLines({ ...request, id: 'req3' })[0].id).toContain('storefront-req3');
  });

  it('exporte un catalogue HTML échappé, sans paiement', () => {
    const html = catalogHtml({ ...settings, headline: 'Savons & <soins>' }, products, 'Atelier VYORA');
    expect(html).toContain('Savons &amp; &lt;soins&gt;');
    expect(html).toContain('Savon');
    expect(html).toContain('aucune commande ni paiement en ligne');
    expect(html).not.toContain('Ancien');
  });

  it('résume la vitrine et ses demandes', () => {
    const summary = computeStorefrontSummary(products, settings, [request]);
    expect(summary).toMatchObject({ visibleProducts: 1, requests: 1, newRequests: 1, potentialValue: 3_000 });
  });
});
