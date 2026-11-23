import { describe, expect, it } from 'vitest';
import {
  addDays, computeInvoiceView, computeSalesDashboard, computeTotals, conversionErrors,
  invoiceToReceivableData, invoiceFromRecord, nextNumber, orderFromRecord, orderToInvoiceDraft,
  quoteFromRecord, quoteToOrderDraft, quotesToCsv,
} from '../src/business/sales/model';
import {
  buildProductsFromRows, computeCatalogSummary, guessProductMapping, movementFromRecord,
  orderReturnMovements, orderStockMovements, productFromRecord, stockLevel, stockOf, validateMovement,
} from '../src/business/catalog/model';
import {
  cashMovements, computeCashSummary, detectUnusualExpenses, expenseFromRecord,
  monthlyCashflow, validateExpense,
} from '../src/business/cash/model';
import { buildSignals, pendingRuns, ruleFromRecord, runFromRecord, automationDedupeKey, buildTaskFromRun } from '../src/business/automation/model';
import { buildRecipients, campaignFromRecord, renderCampaignMessage, whatsappLink } from '../src/business/marketing/model';

const lines = [
  { id: 'l1', productId: '', description: 'Savon', quantity: 2, unitPrice: 10_000, discountPct: 10, taxPct: 18 },
  { id: 'l2', productId: '', description: 'Livraison', quantity: 1, unitPrice: 5_000, discountPct: 0, taxPct: 0 },
];

describe('Vente → stock', () => {
  const tracked = productFromRecord({ id: 'p1', data: { name: 'Savon', trackStock: true, initialStock: 10 } });
  const service = productFromRecord({ id: 'p2', data: { name: 'Pose', kind: 'service', price: 5000 } });

  it('crée une sortie par produit et agrège les lignes avant contrôle', () => {
    const order = { id: 'o1', number: 'CMD-2026-0001', lines: [
      { id: 'l1', productId: 'p1', quantity: 4 },
      { id: 'l2', productId: 'p1', quantity: 4 },
      { id: 'l3', productId: 'p2', quantity: 1 },
    ] };
    const result = orderStockMovements(order, [tracked, service], [], '2026-11-23');
    expect(result.shortages).toEqual([]);
    expect(result.movements).toHaveLength(1);
    expect(result.movements[0].data).toMatchObject({ productId: 'p1', type: 'sortie', quantity: 8, orderId: 'o1' });
  });

  it('refuse une sortie supérieure au stock disponible', () => {
    const result = orderStockMovements(
      { id: 'o1', number: 'CMD-2026-0001', lines: [{ id: 'l1', productId: 'p1', quantity: 11 }] },
      [tracked], [], '2026-11-23',
    );
    expect(result.movements).toEqual([]);
    expect(result.shortages[0]).toContain('11 demandé');
  });

  it('ne recrée pas une sortie déjà enregistrée et prépare le retour à l’annulation', () => {
    const movement = movementFromRecord({ id: 'm1', data: {
      productId: 'p1', type: 'sortie', quantity: 3, orderId: 'o1', lineId: 'l1', reference: 'CMD-2026-0001', occurredAt: '2026-11-23',
    } });
    expect(orderStockMovements(
      { id: 'o1', number: 'CMD-2026-0001', lines: [{ id: 'l1', productId: 'p1', quantity: 3 }] },
      [tracked], [movement],
    ).movements).toEqual([]);
    expect(orderReturnMovements({ id: 'o1', number: 'CMD-2026-0001' }, [movement])[0]).toMatchObject({
      dedupeKey: 'order:o1:return:l1',
      data: { productId: 'p1', type: 'entree', quantity: 3 },
    });
  });
});

describe('Lot E — devis, commandes et factures', () => {
  it('calcule sous-total, remise, taxes et total au centime', () => {
    expect(computeTotals(lines)).toEqual({ subtotal: 25_000, discount: 2_000, tax: 3_240, total: 26_240 });
  });

  it('génère une numérotation professionnelle par année et par type', () => {
    expect(nextNumber('devis', [], new Date('2026-11-22T00:00:00Z'))).toBe('DEV-2026-0001');
    expect(nextNumber('devis', ['DEV-2026-0001', 'DEV-2026-0009'], new Date('2026-11-22T00:00:00Z'))).toBe('DEV-2026-0010');
    expect(nextNumber('facture', ['FAC-2025-0042'], new Date('2026-01-02T00:00:00Z'))).toBe('FAC-2026-0001');
    expect(nextNumber('commande', [], new Date('2026-11-22T00:00:00Z'))).toBe('CMD-2026-0001');
  });

  it('refuse une conversion vide ou sans client', () => {
    expect(conversionErrors('devis', { lines: [], contactId: '' })).toContain('Ajoutez au moins une ligne.');
    expect(conversionErrors('devis', { lines, contactId: '' })).toContain('Sélectionnez un client CRM.');
    expect(conversionErrors('devis', { lines, contactId: 'c1' })).toEqual([]);
  });

  it('convertit un devis en commande sans modifier les montants', () => {
    const quote = quoteFromRecord({ id: 'q1', data: { number: 'DEV-2026-0001', contactId: 'c1', status: 'accepte', lines, currency: 'XOF' } });
    const draft = quoteToOrderDraft(quote, 'CMD-2026-0001');
    expect(draft.quoteId).toBe('q1');
    expect(draft.status).toBe('confirme');
    expect(computeTotals(draft.lines)).toEqual(computeTotals(quote.lines));
  });

  it('convertit une commande en facture avec échéance à 30 jours', () => {
    const order = orderFromRecord({ id: 'o1', data: { number: 'CMD-2026-0001', contactId: 'c1', lines, orderedAt: '2026-11-01' } });
    const draft = orderToInvoiceDraft(order, 'FAC-2026-0001', '2026-11-22');
    expect(draft.orderId).toBe('o1');
    expect(draft.dueDate).toBe('2026-12-22');
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('ne solde une facture qu’avec des paiements validés non annulés', () => {
    const invoice = invoiceFromRecord({
      id: 'i1', data: { number: 'FAC-2026-0001', contactId: 'c1', status: 'envoyee', lines, dueDate: '2026-11-01', receivableId: 'r1' },
    });
    const partial = computeInvoiceView(invoice, [
      { receivableId: 'r1', amount: 10_000, paidAt: '2026-11-05', cancelled: false },
      { receivableId: 'r1', amount: 50_000, paidAt: '2026-11-06', cancelled: true },
    ], '2026-11-10');
    expect(partial.paid).toBe(10_000);
    expect(partial.balance).toBe(16_240);
    expect(partial.effectiveStatus).toBe('en_retard');
    expect(partial.daysOverdue).toBe(9);

    const paid = computeInvoiceView(invoice, [
      { receivableId: 'r1', amount: 26_240, paidAt: '2026-11-05', cancelled: false },
    ], '2026-11-10');
    expect(paid.balance).toBe(0);
    expect(paid.effectiveStatus).toBe('payee');
  });

  it('prépare une créance Finance explicite avec la référence de facture', () => {
    const invoice = invoiceFromRecord({ id: 'i1', data: { number: 'FAC-2026-0001', contactId: 'c1', lines, issuedAt: '2026-11-01', dueDate: '2026-12-01', terms: '30 jours' } });
    const data = invoiceToReceivableData(invoice);
    expect(data).toMatchObject({ reference: 'FAC-2026-0001', contactId: 'c1', initialAmount: 26_240, dueDate: '2026-12-01', invoiceId: 'i1' });
  });

  it('calcule le dashboard commercial sans compter les brouillons comme facturé', () => {
    const quote = quoteFromRecord({ id: 'q1', data: { number: 'DEV-1', contactId: 'c1', status: 'envoye', lines } });
    const order = orderFromRecord({ id: 'o1', data: { number: 'CMD-1', contactId: 'c1', status: 'confirme', lines } });
    const draft = invoiceFromRecord({ id: 'i1', data: { number: 'FAC-1', contactId: 'c1', status: 'brouillon', lines } });
    const real = invoiceFromRecord({ id: 'i2', data: { number: 'FAC-2', contactId: 'c1', status: 'envoyee', lines, dueDate: '2026-12-01', receivableId: 'r1' } });
    const views = [draft, real].map((invoice) => computeInvoiceView(invoice, [
      { receivableId: 'r1', amount: 6_240, paidAt: '2026-11-05', cancelled: false },
    ], '2026-11-10'));
    const dashboard = computeSalesDashboard({ quotes: [quote], orders: [order], invoiceViews: views });
    expect(dashboard.pendingQuotes).toBe(1);
    expect(dashboard.openOrders).toBe(1);
    expect(dashboard.invoicedTotal).toBe(26_240);
    expect(dashboard.collectedTotal).toBe(6_240);
    expect(dashboard.unpaidAmount).toBe(20_000);
  });

  it('exporte des CSV échappés', () => {
    const quote = quoteFromRecord({ id: 'q1', data: { number: 'DEV,1', contactId: 'c1', lines } });
    const csv = quotesToCsv([quote], () => 'Awa "Boutique"').split('\r\n')[1];
    expect(csv).toContain('"DEV,1"');
    expect(csv).toContain('"Awa ""Boutique"""');
  });
});

describe('Lot F — catalogue et stock', () => {
  const product = productFromRecord({
    id: 'p1', data: { name: 'Savon', kind: 'produit', trackStock: true, initialStock: 10, lowStockThreshold: 3, cost: 500, unit: 'pièce' },
  });

  it('dérive le stock des mouvements sans compteur modifiable', () => {
    const movements = [
      movementFromRecord({ id: 'm1', data: { productId: 'p1', type: 'entree', quantity: 5 } }),
      movementFromRecord({ id: 'm2', data: { productId: 'p1', type: 'sortie', quantity: 12 } }),
      movementFromRecord({ id: 'm3', data: { productId: 'p1', type: 'ajustement', quantity: -1 } }),
    ];
    expect(movements[1].quantity).toBe(-12);
    expect(stockOf(product, movements)).toBe(2);
    expect(stockLevel(product, 2)).toBe('faible');
  });

  it('refuse une sortie supérieure au stock disponible', () => {
    expect(validateMovement(product, { type: 'sortie', quantity: 11 }, 10)).toContain('Stock insuffisant : 10 pièce disponible(s).');
    expect(validateMovement(product, { type: 'sortie', quantity: 10 }, 10)).toEqual([]);
  });

  it('ne calcule pas de stock pour un service', () => {
    const service = productFromRecord({ id: 's1', data: { name: 'Conseil', kind: 'service', trackStock: true } });
    expect(service.trackStock).toBe(false);
    expect(stockLevel(service, 0)).toBe('non_suivi');
  });

  it('calcule la valeur du stock seulement si tous les coûts sont connus', () => {
    const movements = [movementFromRecord({ id: 'm1', data: { productId: 'p1', type: 'sortie', quantity: 3 } })];
    expect(computeCatalogSummary([product], movements).inventoryValue).toBe(3_500);
    const noCost = productFromRecord({ id: 'p2', data: { name: 'Autre', kind: 'produit', trackStock: true, initialStock: 1 } });
    expect(computeCatalogSummary([product, noCost], movements).inventoryValue).toBeNull();
  });

  it('importe un CSV avec mapping détecté et signale les lignes invalides', () => {
    const mapping = guessProductMapping(['Nom', 'Prix', 'Stock', 'Type']);
    expect(mapping[0]).toBe('name');
    expect(mapping[1]).toBe('price');
    const rows = buildProductsFromRows([
      ['Savon', '1500', '10', 'service'],
      ['', 'abc', '', 'produit'],
    ], mapping);
    expect(rows[0].data).toMatchObject({ name: 'Savon', price: 1500, initialStock: 10, kind: 'service' });
    expect(rows[1].errors.length).toBeGreaterThan(0);
  });
});

describe('Lot G — trésorerie et dépenses', () => {
  const expense = expenseFromRecord({
    id: 'e1', data: { label: 'Loyer', category: 'Loyer', amount: 150_000, incurredAt: '2026-11-01', paidAt: '2026-11-02', status: 'payee', method: 'virement' },
  });

  it('distingue encaissé, engagé et payé', () => {
    const summary = computeCashSummary({
      payments: [
        { id: 'p1', amount: 200_000, paidAt: '2026-11-05', method: 'especes', cancelled: false },
        { id: 'p2', amount: 90_000, paidAt: '2026-11-06', method: 'especes', cancelled: true },
      ],
      expenses: [expense, expenseFromRecord({ id: 'e2', data: { label: 'Fournisseur', amount: 50_000, incurredAt: '2026-11-03', status: 'engagee' } })],
    });
    expect(summary).toMatchObject({ collected: 200_000, paidExpenses: 150_000, committedExpenses: 50_000, balance: 50_000 });
  });

  it('ne compte que les dépenses payées dans les mouvements', () => {
    const movements = cashMovements([], [expense, expenseFromRecord({ id: 'e2', data: { label: 'Engagée', amount: 9_000, incurredAt: '2026-11-03', status: 'engagee' } })]);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ kind: 'depense', amount: 150_000, date: '2026-11-02' });
  });

  it('détecte une dépense inhabituelle avec une règle explicable', () => {
    const entries = [
      expenseFromRecord({ id: 'a', data: { label: 'A', category: 'Transport', amount: 10_000, incurredAt: '2026-11-01', status: 'payee' } }),
      expenseFromRecord({ id: 'b', data: { label: 'B', category: 'Transport', amount: 12_000, incurredAt: '2026-11-02', status: 'payee' } }),
      expenseFromRecord({ id: 'c', data: { label: 'C', category: 'Transport', amount: 11_000, incurredAt: '2026-11-03', status: 'payee' } }),
      expenseFromRecord({ id: 'd', data: { label: 'Exceptionnel', category: 'Transport', amount: 90_000, incurredAt: '2026-11-04', status: 'payee' } }),
    ];
    const unusual = detectUnusualExpenses(entries);
    expect(unusual).toHaveLength(1);
    expect(unusual[0].expense.id).toBe('d');
    expect(unusual[0].reason).toContain('médiane');
  });

  it('valide une dépense payée et produit un flux mensuel', () => {
    expect(validateExpense(expense)).toEqual([]);
    expect(validateExpense({ ...expense, paidAt: '', status: 'payee' })).toContain('Une dépense payée doit avoir une date de paiement.');
    const flow = monthlyCashflow(
      [{ id: 'p1', amount: 100_000, paidAt: '2026-11-05', method: 'especes', cancelled: false }],
      [expense], 2, '2026-11-22',
    );
    expect(flow.map((point) => point.month)).toEqual(['2026-10', '2026-11']);
    expect(flow[1]).toMatchObject({ income: 100_000, expense: 150_000, net: -50_000 });
  });
});

describe('Lot H — automatisations', () => {
  const rule = ruleFromRecord({
    id: 'rule1', data: { name: 'Tâches en retard', trigger: 'tache_retard', thresholdDays: 1, action: 'creer_tache', enabled: true },
  });
  const dataset = {
    contacts: [], opportunities: [], receivables: [], promises: [], quotes: [], invoices: [], products: [], unusualExpenses: [],
    tasks: [
      { id: 't1', title: 'Rappeler Awa', contactId: 'c1', dueDate: '2026-11-15', status: 'a_faire' },
      { id: 't2', title: 'Tâche future', contactId: 'c1', dueDate: '2026-11-21', status: 'a_faire' },
      { id: 't3', title: 'Terminée', contactId: 'c1', dueDate: '2026-11-01', status: 'termine' },
    ],
    today: '2026-11-22',
  };

  it('ne propose que les signaux réels au-delà du seuil', () => {
    const signals = buildSignals('tache_retard', dataset, 1);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ itemKey: 'task:t1', contactId: 'c1' });
  });

  it('déduplique une proposition déjà journalisée', () => {
    const signals = buildSignals('tache_retard', dataset, 1);
    const run = runFromRecord({ id: 'r1', data: { ruleId: 'rule1', itemKey: 'task:t1', status: 'confirme' } });
    expect(pendingRuns(rule, signals, [])).toHaveLength(1);
    expect(pendingRuns(rule, signals, [run])).toHaveLength(0);
    expect(pendingRuns({ ...rule, enabled: false }, signals, [])).toHaveLength(0);
    expect(automationDedupeKey('rule1', 'task:t1')).toBe('rule1:task:t1');
  });

  it('prépare une tâche CRM confirmée avec la priorité adaptée', () => {
    const signal = buildSignals('tache_retard', dataset, 1)[0];
    const task = buildTaskFromRun(rule, signal, '2026-11-22');
    expect(task).toMatchObject({ title: 'Rappeler Awa', contactId: 'c1', dueDate: '2026-11-22', status: 'a_faire' });
    expect(task.notes).toContain('Automatisation');
  });
});

describe('Lot I — marketing', () => {
  const campaign = campaignFromRecord({
    id: 'camp1', data: {
      name: 'Réactivation', channel: 'whatsapp', status: 'prete',
      message: 'Bonjour {{contact}}, {{entreprise}} vous attend.',
    },
  });
  const contacts = [
    { id: 'c1', firstName: 'Awa', lastName: 'Traoré', company: 'Boutique Awa', whatsapp: '+223 70 00 00 00', email: 'awa@example.com', status: 'actif', type: 'client' },
    { id: 'c2', firstName: 'Sans', lastName: 'Numéro', company: '', whatsapp: '', email: 'x@example.com', status: 'actif', type: 'prospect' },
  ] as never;

  it('personnalise le message par contact et filtre par canal', () => {
    const recipients = buildRecipients(campaign, contacts, 'VYORA', null);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].message).toBe('Bonjour Awa Traoré, VYORA vous attend.');
  });

  it('génère un lien WhatsApp sans envoi automatique', () => {
    expect(whatsappLink('+223 70 00 00 00', 'Bonjour')).toBe('https://wa.me/22370000000?text=Bonjour');
  });

  it('remplace les variables connues sans laisser de gabarit', () => {
    expect(renderCampaignMessage('{{contact}} · {{ville}} · {{produit}}', { firstName: 'Awa', lastName: '', company: '', city: 'Bamako' }, 'VYORA', { produit: 'Savon' }))
      .toBe('Awa · Bamako · Savon');
  });
});
