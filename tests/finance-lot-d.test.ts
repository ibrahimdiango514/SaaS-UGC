import { describe, expect, it } from 'vitest';
import {
  agingBuckets, buildReceipt, computeFinanceDashboard, computeReceivableView, computeRecoveryRisk,
  effectivePromiseStatus, groupSchedule, monthlyCollections, paymentFromRecord, receivableFromRecord,
  validateCancellation, validatePayment, type Payment, type PaymentPromise, type Receivable,
  type ReceivableDispute,
} from '../src/business/finance/model';

const TODAY = '2026-11-22';

function receivable(overrides: Partial<Receivable> = {}): Receivable {
  return {
    id: 'r1', reference: 'FAC-001', contactId: 'c1', description: 'Prestation',
    initialAmount: 500_000, issuedAt: '2026-10-01', dueDate: '2026-11-01', terms: '30 jours',
    status: 'en_attente', notes: '', owner: 'Ibrahim',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...overrides,
  };
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'p1', receivableId: 'r1', amount: 100_000, paidAt: '2026-11-10', method: 'mobile_money',
    reference: 'MM-1', note: '', author: 'Ibrahim', clientRequestId: 'req-1',
    cancelled: false, cancellationReason: '', cancelledAt: '',
    createdAt: '2026-11-10T00:00:00.000Z', ...overrides,
  };
}

function promise(overrides: Partial<PaymentPromise> = {}): PaymentPromise {
  return {
    id: 'pr1', contactId: 'c1', receivableId: 'r1', amount: 200_000,
    promisedAt: '2026-11-15', note: '', status: 'a_venir', outcome: '',
    createdAt: '2026-11-05T00:00:00.000Z', ...overrides,
  };
}

describe('Créances — statuts cohérents', () => {
  it('passe en retard quand la date est dépassée', () => {
    const view = computeReceivableView(receivable(), [], TODAY);
    expect(view.effectiveStatus).toBe('en_retard');
    expect(view.daysOverdue).toBe(21);
    expect(view.balance).toBe(500_000);
  });

  it('reste payée même après l’échéance quand le solde est nul', () => {
    const view = computeReceivableView(receivable(), [payment({ amount: 500_000 })], TODAY);
    expect(view.effectiveStatus).toBe('payee');
    expect(view.balance).toBe(0);
    expect(view.overdueAmount).toBe(0);
  });

  it('affiche partiellement payée avant échéance', () => {
    const view = computeReceivableView(receivable({ dueDate: '2026-12-15' }), [payment()], TODAY);
    expect(view.effectiveStatus).toBe('partiellement_payee');
    expect(view.balance).toBe(400_000);
    expect(view.paidRatio).toBe(20);
  });

  it('ne compte jamais un paiement annulé dans le solde', () => {
    const view = computeReceivableView(receivable(), [payment({ cancelled: true })], TODAY);
    expect(view.paid).toBe(0);
    expect(view.balance).toBe(500_000);
  });

  it('respecte le litige et le brouillon comme statuts explicites', () => {
    expect(computeReceivableView(receivable({ status: 'litige' }), [], TODAY).effectiveStatus).toBe('litige');
    expect(computeReceivableView(receivable({ status: 'brouillon' }), [], TODAY).effectiveStatus).toBe('brouillon');
  });

  it('ne fabrique pas un solde à partir d’un montant inconnu', () => {
    const view = computeReceivableView(receivable({ initialAmount: null }), [], TODAY);
    expect(view.effectiveStatus).toBe('en_attente');
    expect(view.balance).toBe(0);
  });
});

describe('Paiements — validation et protections', () => {
  it('accepte un paiement partiel valide', () => {
    const view = computeReceivableView(receivable(), [], TODAY);
    expect(validatePayment({ receivableId: 'r1', amount: 100_000, paidAt: '2026-11-22' }, view, [], TODAY).ok).toBe(true);
  });

  it('refuse un montant nul, négatif ou supérieur au solde', () => {
    const view = computeReceivableView(receivable(), [payment()], TODAY);
    expect(validatePayment({ receivableId: 'r1', amount: 0, paidAt: TODAY }, view, [], TODAY).ok).toBe(false);
    expect(validatePayment({ receivableId: 'r1', amount: -5, paidAt: TODAY }, view, [], TODAY).ok).toBe(false);
    expect(validatePayment({ receivableId: 'r1', amount: 400_001, paidAt: TODAY }, view, [], TODAY).ok).toBe(false);
  });

  it('refuse une date future et une créance déjà soldée', () => {
    const view = computeReceivableView(receivable({ dueDate: '2026-12-30' }), [], TODAY);
    expect(validatePayment({ receivableId: 'r1', amount: 10, paidAt: '2026-11-30' }, view, [], TODAY).ok).toBe(false);
    const paid = computeReceivableView(receivable(), [payment({ amount: 500_000 })], TODAY);
    expect(validatePayment({ receivableId: 'r1', amount: 10, paidAt: TODAY }, paid, [], TODAY).ok).toBe(false);
  });

  it('empêche une double soumission via la clé d’idempotence', () => {
    const view = computeReceivableView(receivable(), [payment()], TODAY);
    const result = validatePayment(
      { receivableId: 'r1', amount: 100_000, paidAt: '2026-11-10', clientRequestId: 'req-1' },
      view, [payment()], TODAY,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/déjà été enregistré/);
  });

  it('détecte un doublon évident même sans clé d’idempotence', () => {
    const view = computeReceivableView(receivable(), [payment()], TODAY);
    const result = validatePayment({ receivableId: 'r1', amount: 100_000, paidAt: '2026-11-10', reference: 'MM-1' }, view, [payment()], TODAY);
    expect(result.ok).toBe(false);
  });

  it('exige un motif pour annuler un paiement', () => {
    expect(validateCancellation('').ok).toBe(false);
    expect(validateCancellation('Erreur de saisie').ok).toBe(true);
  });

  it('lit un paiement annulé sans perte d’historique', () => {
    const parsed = paymentFromRecord({ id: 'p2', data: { receivableId: 'r1', amount: 50_000, status: 'annule', cancellationReason: 'Doublon' } });
    expect(parsed.cancelled).toBe(true);
    expect(parsed.amount).toBe(50_000);
    expect(parsed.cancellationReason).toBe('Doublon');
  });
});

describe('Promesses de paiement', () => {
  it('dérive une promesse non respectée sans créer de paiement', () => {
    expect(effectivePromiseStatus(promise(), TODAY)).toBe('non_respectee');
    expect(effectivePromiseStatus(promise({ promisedAt: '2026-12-01' }), TODAY)).toBe('a_venir');
    expect(effectivePromiseStatus(promise({ status: 'respectee' }), TODAY)).toBe('respectee');
  });
});

describe('Risque de recouvrement explicable', () => {
  it('classe un retard avec promesse cassée et litige en critique', () => {
    const view = computeReceivableView(receivable(), [payment()], TODAY);
    const risk = computeRecoveryRisk({
      view,
      promises: [promise(), promise({ id: 'pr2', promisedAt: '2026-11-18' })],
      reminders: [],
      disputes: [{ id: 'd1', receivableId: 'r1', contactId: 'c1', reason: 'Désaccord', description: '', openedAt: TODAY, owner: '', status: 'ouvert', resolution: '', createdAt: '' }] as ReceivableDispute[],
      today: TODAY,
    });
    expect(risk.category).toBe('critique');
    expect(risk.score).toBeGreaterThanOrEqual(75);
    expect(risk.reasons.some((reason) => reason.label === 'Litige ouvert')).toBe(true);
  });

  it('ne signale aucun risque sur une créance soldée', () => {
    const view = computeReceivableView(receivable(), [payment({ amount: 500_000 })], TODAY);
    expect(computeRecoveryRisk({ view, promises: [], reminders: [], disputes: [], today: TODAY }).category).toBe('faible');
  });
});

describe('Tableau de bord et échéancier', () => {
  it('calcule encours, retard, recouvrement et encaissements du mois', () => {
    const dashboard = computeFinanceDashboard({
      receivables: [receivable(), receivable({ id: 'r2', reference: 'FAC-002', contactId: 'c2', initialAmount: 200_000, dueDate: '2026-12-05' })],
      payments: [payment(), payment({ id: 'p2', receivableId: 'r2', amount: 100_000, paidAt: '2026-11-20' })],
      promises: [promise()],
      reminders: [],
      today: TODAY,
    });
    expect(dashboard.initialTotal).toBe(700_000);
    expect(dashboard.paidTotal).toBe(200_000);
    expect(dashboard.balanceTotal).toBe(500_000);
    expect(dashboard.overdueTotal).toBe(400_000);
    expect(dashboard.recoveryRate).toBe(29);
    expect(dashboard.debtorCount).toBe(2);
    expect(dashboard.monthCollected).toBe(200_000);
    expect(dashboard.promisesBroken).toBe(1);
  });

  it('regroupe correctement l’échéancier', () => {
    const views = [
      computeReceivableView(receivable(), [], TODAY),
      computeReceivableView(receivable({ id: 'r2', dueDate: TODAY }), [], TODAY),
      computeReceivableView(receivable({ id: 'r3', dueDate: '2026-11-27' }), [], TODAY),
      computeReceivableView(receivable({ id: 'r4', dueDate: '2026-12-20' }), [], TODAY),
      computeReceivableView(receivable({ id: 'r5', dueDate: '2027-03-01' }), [], TODAY),
    ];
    const groups = groupSchedule(views, TODAY);
    expect(groups.retard).toHaveLength(1);
    expect(groups.aujourdhui).toHaveLength(1);
    expect(groups.semaine).toHaveLength(1);
    expect(groups.mois).toHaveLength(1);
    expect(groups.futur).toHaveLength(1);
  });

  it('répartit les retards en tranches d’ancienneté', () => {
    const buckets = agingBuckets([
      computeReceivableView(receivable(), [], TODAY),
      computeReceivableView(receivable({ id: 'r2', dueDate: '2026-08-01' }), [], TODAY),
    ]);
    expect(buckets.retard_1_30).toBe(500_000);
    expect(buckets.retard_90_plus).toBe(500_000);
  });

  it('produit six mois d’encaissements réels', () => {
    const series = monthlyCollections([payment(), payment({ id: 'p2', paidAt: '2026-10-15', amount: 50_000 })], 6, TODAY);
    expect(series).toHaveLength(6);
    expect(series.at(-1)).toEqual({ month: '2026-11', amount: 100_000 });
    expect(series.at(-2)).toEqual({ month: '2026-10', amount: 50_000 });
  });
});

describe('Reçus', () => {
  it('reprend les données réelles du paiement et le solde restant', () => {
    const view = computeReceivableView(receivable(), [payment()], TODAY);
    const receipt = buildReceipt({ payment: payment(), view, contactName: 'Awa Traoré', company: 'Boutique Awa' });
    expect(receipt.amount).toBe(100_000);
    expect(receipt.balanceAfter).toBe(400_000);
    expect(receipt.method).toBe('Mobile Money');
    expect(receipt.reference).toMatch(/^REC-/);
  });
});

describe('Lecture d’une créance', () => {
  it('normalise les champs et conserve une référence', () => {
    const parsed = receivableFromRecord({ id: 'r9', data: { reference: 'FAC-9', initialAmount: '1000', dueDate: '2026-12-01', status: 'en_attente' } });
    expect(parsed.initialAmount).toBe(1000);
    expect(parsed.dueDate).toBe('2026-12-01');
  });
});
