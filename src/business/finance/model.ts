/**
 * SORAHNEX Grow — Lot D : créances, paiements et recouvrement.
 *
 * Modèle pur, sans React ni Supabase. Le solde et le statut sont toujours
 * recalculés à partir des paiements validés : une créance soldée ne peut pas
 * être affichée impayée, et un paiement ne peut jamais dépasser le solde.
 */

export type ReceivableStatus =
  | 'brouillon' | 'en_attente' | 'partiellement_payee' | 'payee'
  | 'en_retard' | 'litige' | 'annulee';
export type PaymentMethod = 'especes' | 'mobile_money' | 'virement' | 'carte' | 'cheque' | 'autre';
export type PromiseStatus = 'a_venir' | 'respectee' | 'non_respectee' | 'reprogrammee' | 'annulee';
export type ReminderStatus = 'a_faire' | 'termine' | 'annule';
export type DisputeStatus = 'ouvert' | 'en_cours' | 'resolu' | 'annule';
export type RiskCategory = 'faible' | 'modere' | 'eleve' | 'critique';

export const RECEIVABLE_STATUSES: readonly { value: ReceivableStatus; label: string; tone: string }[] = [
  { value: 'brouillon', label: 'Brouillon', tone: 'neutral' },
  { value: 'en_attente', label: 'En attente', tone: 'info' },
  { value: 'partiellement_payee', label: 'Partiellement payée', tone: 'warning' },
  { value: 'payee', label: 'Payée', tone: 'success' },
  { value: 'en_retard', label: 'En retard', tone: 'danger' },
  { value: 'litige', label: 'En litige', tone: 'danger' },
  { value: 'annulee', label: 'Annulée', tone: 'neutral' },
];

export const PAYMENT_METHODS: readonly { value: PaymentMethod; label: string }[] = [
  { value: 'especes', label: 'Espèces' },
  { value: 'mobile_money', label: 'Mobile Money' },
  { value: 'virement', label: 'Virement' },
  { value: 'carte', label: 'Carte bancaire' },
  { value: 'cheque', label: 'Chèque' },
  { value: 'autre', label: 'Autre' },
];

export const PROMISE_STATUSES: readonly { value: PromiseStatus; label: string }[] = [
  { value: 'a_venir', label: 'À venir' },
  { value: 'respectee', label: 'Respectée' },
  { value: 'non_respectee', label: 'Non respectée' },
  { value: 'reprogrammee', label: 'Reprogrammée' },
  { value: 'annulee', label: 'Annulée' },
];

export const DISPUTE_STATUSES: readonly { value: DisputeStatus; label: string }[] = [
  { value: 'ouvert', label: 'Ouvert' },
  { value: 'en_cours', label: 'En cours' },
  { value: 'resolu', label: 'Résolu' },
  { value: 'annule', label: 'Annulé' },
];

export interface Receivable {
  id: string;
  reference: string;
  contactId: string;
  description: string;
  initialAmount: number | null;
  issuedAt: string;
  dueDate: string;
  terms: string;
  status: ReceivableStatus;
  notes: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  receivableId: string;
  amount: number;
  paidAt: string;
  method: PaymentMethod;
  reference: string;
  note: string;
  author: string;
  clientRequestId: string;
  cancelled: boolean;
  cancellationReason: string;
  cancelledAt: string;
  createdAt: string;
}

export interface PaymentPromise {
  id: string;
  contactId: string;
  receivableId: string;
  amount: number | null;
  promisedAt: string;
  note: string;
  status: PromiseStatus;
  outcome: string;
  createdAt: string;
}

export interface CollectionReminder {
  id: string;
  receivableId: string;
  contactId: string;
  dueDate: string;
  channel: 'whatsapp' | 'email' | 'sms' | 'appel';
  template: string;
  message: string;
  status: ReminderStatus;
  note: string;
  outcome: string;
  createdAt: string;
}

export interface ReceivableDispute {
  id: string;
  receivableId: string;
  contactId: string;
  reason: string;
  description: string;
  openedAt: string;
  owner: string;
  status: DisputeStatus;
  resolution: string;
  createdAt: string;
}

export interface ReceivableView {
  receivable: Receivable;
  paid: number;
  balance: number;
  effectiveStatus: ReceivableStatus;
  daysOverdue: number;
  overdueAmount: number;
  paidRatio: number;
  lastPaymentAt: string;
}

export function todayIso(now = new Date()): string {
  // Date locale, cohérente avec l'échéancier affiché à l'utilisateur.
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function dateOnly(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(`${text}T00:00:00Z`)) ? text : '';
}

export function daysBetween(fromIso: string, toIso = todayIso()): number | null {
  const from = dateOnly(fromIso);
  const to = dateOnly(toIso);
  if (!from || !to) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function amount(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(value))) return null;
  const parsed = typeof value === 'number' ? value : Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000_000_000 ? parsed : null;
}

function positiveAmount(value: unknown): number {
  const parsed = amount(value);
  return parsed === null ? 0 : parsed;
}

function isoOrEmpty(value: unknown): string {
  const text = str(value, 40);
  if (!text) return '';
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function receivableFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string; updated_at?: string }): Receivable {
  const data = record.data ?? {};
  return {
    id: record.id,
    reference: str(data.reference, 80),
    contactId: str(data.contactId, 64),
    description: str(data.description, 1000),
    initialAmount: amount(data.initialAmount),
    issuedAt: dateOnly(data.issuedAt),
    dueDate: dateOnly(data.dueDate),
    terms: str(data.terms, 240),
    status: oneOf<ReceivableStatus>(data.status, RECEIVABLE_STATUSES.map((entry) => entry.value), 'en_attente'),
    notes: str(data.notes, 4000),
    owner: str(data.owner, 120),
    createdAt: isoOrEmpty(record.created_at) || new Date(0).toISOString(),
    updatedAt: isoOrEmpty(record.updated_at) || new Date(0).toISOString(),
  };
}

export function receivableToData(receivable: Receivable): Record<string, unknown> {
  return {
    reference: receivable.reference, contactId: receivable.contactId,
    description: receivable.description, initialAmount: receivable.initialAmount,
    issuedAt: receivable.issuedAt, dueDate: receivable.dueDate, terms: receivable.terms,
    status: receivable.status, notes: receivable.notes, owner: receivable.owner,
  };
}

export function paymentFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): Payment {
  const data = record.data ?? {};
  return {
    id: record.id,
    receivableId: str(data.receivableId, 64),
    amount: positiveAmount(data.amount),
    paidAt: dateOnly(data.paidAt),
    method: oneOf<PaymentMethod>(data.method, PAYMENT_METHODS.map((entry) => entry.value), 'especes'),
    reference: str(data.reference, 120),
    note: str(data.note, 1000),
    author: str(data.author, 120),
    clientRequestId: str(data.clientRequestId, 80),
    cancelled: data.cancelled === true || data.status === 'annule',
    cancellationReason: str(data.cancellationReason, 400),
    cancelledAt: dateOnly(data.cancelledAt),
    createdAt: isoOrEmpty(record.created_at) || new Date(0).toISOString(),
  };
}

export function paymentToData(payment: Payment): Record<string, unknown> {
  return {
    receivableId: payment.receivableId, amount: payment.amount, paidAt: payment.paidAt,
    method: payment.method, reference: payment.reference, note: payment.note,
    author: payment.author, clientRequestId: payment.clientRequestId,
    cancelled: payment.cancelled, cancellationReason: payment.cancellationReason,
    cancelledAt: payment.cancelledAt,
    status: payment.cancelled ? 'annule' : 'valide',
  };
}

export function promiseFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): PaymentPromise {
  const data = record.data ?? {};
  return {
    id: record.id,
    contactId: str(data.contactId, 64),
    receivableId: str(data.receivableId, 64),
    amount: amount(data.amount),
    promisedAt: dateOnly(data.promisedAt),
    note: str(data.note, 1000),
    status: oneOf<PromiseStatus>(data.status, PROMISE_STATUSES.map((entry) => entry.value), 'a_venir'),
    outcome: str(data.outcome, 1000),
    createdAt: isoOrEmpty(record.created_at) || new Date(0).toISOString(),
  };
}

export function promiseToData(promise: PaymentPromise): Record<string, unknown> {
  return {
    contactId: promise.contactId, receivableId: promise.receivableId,
    amount: promise.amount, promisedAt: promise.promisedAt, note: promise.note,
    status: promise.status, outcome: promise.outcome,
  };
}

export function reminderFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): CollectionReminder {
  const data = record.data ?? {};
  return {
    id: record.id,
    receivableId: str(data.receivableId, 64),
    contactId: str(data.contactId, 64),
    dueDate: dateOnly(data.dueDate),
    channel: oneOf<'whatsapp' | 'email' | 'sms' | 'appel'>(data.channel, ['whatsapp', 'email', 'sms', 'appel'], 'whatsapp'),
    template: str(data.template, 80),
    message: str(data.message, 4000),
    status: oneOf<ReminderStatus>(data.status, ['a_faire', 'termine', 'annule'], 'a_faire'),
    note: str(data.note, 1000),
    outcome: str(data.outcome, 1000),
    createdAt: isoOrEmpty(record.created_at) || new Date(0).toISOString(),
  };
}

export function reminderToData(reminder: CollectionReminder): Record<string, unknown> {
  return {
    receivableId: reminder.receivableId, contactId: reminder.contactId, dueDate: reminder.dueDate,
    channel: reminder.channel, template: reminder.template, message: reminder.message,
    status: reminder.status, note: reminder.note, outcome: reminder.outcome,
  };
}

export function disputeFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): ReceivableDispute {
  const data = record.data ?? {};
  return {
    id: record.id,
    receivableId: str(data.receivableId, 64),
    contactId: str(data.contactId, 64),
    reason: str(data.reason, 240),
    description: str(data.description, 4000),
    openedAt: dateOnly(data.openedAt),
    owner: str(data.owner, 120),
    status: oneOf<DisputeStatus>(data.status, DISPUTE_STATUSES.map((entry) => entry.value), 'ouvert'),
    resolution: str(data.resolution, 2000),
    createdAt: isoOrEmpty(record.created_at) || new Date(0).toISOString(),
  };
}

export function disputeToData(dispute: ReceivableDispute): Record<string, unknown> {
  return {
    receivableId: dispute.receivableId, contactId: dispute.contactId, reason: dispute.reason,
    description: dispute.description, openedAt: dispute.openedAt, owner: dispute.owner,
    status: dispute.status, resolution: dispute.resolution,
  };
}

/* -------------------------------------------------------------------------- */
/* Solde, statut et garde-fous                                                */
/* -------------------------------------------------------------------------- */

export function validPayments(payments: readonly Payment[], receivableId?: string): Payment[] {
  return payments.filter((payment) => !payment.cancelled && (!receivableId || payment.receivableId === receivableId));
}

export function computeReceivableView(
  receivable: Receivable,
  payments: readonly Payment[],
  today = todayIso(),
): ReceivableView {
  const linked = validPayments(payments, receivable.id);
  const paid = linked.reduce((sum, payment) => sum + payment.amount, 0);
  const initial = receivable.initialAmount ?? 0;
  const rawBalance = Math.max(0, initial - paid);
  // Une créance soldée reste soldée même si l'échéance est passée.
  const balance = rentedGuard(rawBalance);
  const daysOverdue = balance > 0 && receivable.dueDate ? Math.max(0, daysBetween(receivable.dueDate, today) ?? 0) : 0;
  const stored = receivable.status;
  let effective: ReceivableStatus;
  if (stored === 'annulee' || stored === 'brouillon') effective = stored;
  else if (stored === 'litige') effective = 'litige';
  else if (receivable.initialAmount === null) effective = stored;
  else if (balance <= 0) effective = 'payee';
  else if (daysOverdue > 0) effective = 'en_retard';
  else if (paid > 0) effective = 'partiellement_payee';
  else effective = 'en_attente';
  return {
    receivable,
    paid,
    balance,
    effectiveStatus: effective,
    daysOverdue,
    overdueAmount: effective === 'en_retard' ? balance : 0,
    paidRatio: initial > 0 ? Math.min(100, Math.round((paid / initial) * 100)) : 0,
    lastPaymentAt: linked.map((payment) => payment.paidAt).sort().at(-1) ?? '',
  };
}

/** Évite les artefacts binaires (0.30000000000000004) sans arrondir la devise. */
function rentedGuard(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface PaymentValidation {
  ok: boolean;
  errors: string[];
}

export function validatePayment(input: {
  receivableId: string;
  amount: number | null;
  paidAt: string;
  reference?: string;
  clientRequestId?: string;
}, view: ReceivableView, payments: readonly Payment[], today = todayIso()): PaymentValidation {
  const errors: string[] = [];
  if (!input.receivableId) errors.push('Créance obligatoire.');
  if (input.amount === null || !Number.isFinite(input.amount) || input.amount <= 0) errors.push('Le montant doit être strictement positif.');
  if (!dateOnly(input.paidAt)) errors.push('Date de paiement invalide.');
  if (dateOnly(input.paidAt) && dateOnly(input.paidAt) > today) errors.push('Un paiement ne peut pas être daté dans le futur.');
  if (['payee', 'annulee'].includes(view.effectiveStatus)) errors.push('Cette créance est déjà soldée ou annulée.');
  if (view.receivable.status === 'litige') errors.push('Cette créance est en litige : le paiement doit être traité après résolution.');
  if (input.amount !== null && input.amount > view.balance + 0.001) {
    errors.push(`Le montant dépasse le solde restant (${view.balance.toFixed(2)}).`);
  }
  if (input.clientRequestId) {
    const duplicate = validPayments(payments, input.receivableId)
      .find((payment) => payment.clientRequestId && payment.clientRequestId === input.clientRequestId);
    if (duplicate) errors.push('Ce paiement a déjà été enregistré.');
  }
  if (input.reference && input.amount !== null) {
    const duplicate = validPayments(payments, input.receivableId).find((payment) =>
      payment.reference
      && payment.reference.toLowerCase() === input.reference!.trim().toLowerCase()
      && payment.amount === input.amount
      && payment.paidAt === dateOnly(input.paidAt));
    if (duplicate) errors.push('Un paiement identique (même référence, montant et date) existe déjà.');
  }
  return { ok: errors.length === 0, errors };
}

/** Une annulation est toujours motivée et n'efface jamais le paiement. */
export function validateCancellation(reason: string): PaymentValidation {
  return reason.trim().length >= 5
    ? { ok: true, errors: [] }
    : { ok: false, errors: ['Un motif d’annulation d’au moins 5 caractères est obligatoire.'] };
}

/* -------------------------------------------------------------------------- */
/* Promesses                                                                  */
/* -------------------------------------------------------------------------- */

export function effectivePromiseStatus(promise: PaymentPromise, today = todayIso()): PromiseStatus {
  if (promise.status !== 'a_venir') return promise.status;
  const days = daysBetween(promise.promisedAt, today);
  return days !== null && days > 0 ? 'non_respectee' : promise.status;
}

export function promiseMatchesReceivable(promise: PaymentPromise, receivableId: string): boolean {
  return promise.receivableId === receivableId;
}

/* -------------------------------------------------------------------------- */
/* Risque de recouvrement                                                     */
/* -------------------------------------------------------------------------- */

export interface RiskReason {
  label: string;
  points: number;
  detail?: string;
}

export interface RecoveryRisk {
  score: number;
  category: RiskCategory;
  reasons: RiskReason[];
}

export function computeRecoveryRisk(input: {
  view: ReceivableView;
  promises: readonly PaymentPromise[];
  reminders: readonly CollectionReminder[];
  disputes: readonly ReceivableDispute[];
  today?: string;
}): RecoveryRisk {
  const today = input.today ?? todayIso();
  const { view } = input;
  const linkedPromises = input.promises.filter((promise) => promise.receivableId === view.receivable.id);
  const broken = linkedPromises.filter((promise) => effectivePromiseStatus(promise, today) === 'non_respectee');
  const openDispute = input.disputes.some((dispute) => dispute.receivableId === view.receivable.id && ['ouvert', 'en_cours'].includes(dispute.status));
  const reminders = input.reminders.filter((reminder) => reminder.receivableId === view.receivable.id);
  const reasons: RiskReason[] = [];
  let score = 0;

  if (view.effectiveStatus === 'payee' || view.effectiveStatus === 'annulee') {
    return { score: 0, category: 'faible', reasons: [{ label: 'Aucun encours à recouvrer', points: 0 }] };
  }
  if (view.daysOverdue > 0) {
    const points = Math.min(35, 5 + Math.floor(view.daysOverdue / 5) * 4);
    score += points;
    reasons.push({ label: 'Retard de paiement', points, detail: `${view.daysOverdue} jour(s)` });
  } else if (view.receivable.dueDate) {
    const remaining = daysBetween(today, view.receivable.dueDate);
    if (remaining !== null && remaining <= 3 && remaining >= 0) {
      score += 8; reasons.push({ label: 'Échéance imminente', points: 8, detail: `${remaining} jour(s)` });
    }
  }
  if (view.balance >= 1_000_000) { score += 20; reasons.push({ label: 'Montant important', points: 20 }); }
  else if (view.balance >= 250_000) { score += 10; reasons.push({ label: 'Montant significatif', points: 10 }); }
  if (broken.length) {
    const points = Math.min(25, 10 * broken.length);
    score += points; reasons.push({ label: 'Promesse(s) non respectée(s)', points, detail: `${broken.length}` });
  }
  const lateReminders = reminders.filter((reminder) => {
    const days = daysBetween(reminder.dueDate, today);
    return reminder.status === 'a_faire' && days !== null && days > 0;
  }).length;
  if (lateReminders) { score += Math.min(10, 3 * lateReminders); reasons.push({ label: 'Relance(s) en retard', points: Math.min(10, 3 * lateReminders), detail: `${lateReminders}` }); }
  if (openDispute) { score += 25; reasons.push({ label: 'Litige ouvert', points: 25 }); }
  if (view.paid > 0 && view.balance > 0) { score += 5; reasons.push({ label: 'Paiement partiel déjà reçu', points: 5 }); }
  if (view.receivable.contactId === '') { score += 5; reasons.push({ label: 'Client non relié au CRM', points: 5 }); }

  score = Math.max(0, Math.min(100, score));
  const category: RiskCategory = score >= 75 ? 'critique' : score >= 50 ? 'eleve' : score >= 25 ? 'modere' : 'faible';
  if (!reasons.length) reasons.push({ label: 'Aucun signal de risque particulier', points: 0 });
  return { score, category, reasons };
}

/* -------------------------------------------------------------------------- */
/* Tableau de bord financier                                                  */
/* -------------------------------------------------------------------------- */

export interface FinanceDashboard {
  initialTotal: number | null;
  paidTotal: number;
  balanceTotal: number | null;
  overdueTotal: number;
  dueSoonTotal: number;
  overdueCount: number;
  debtorCount: number;
  recoveryRate: number | null;
  monthCollected: number;
  openCount: number;
  promisesUpcoming: number;
  promisesBroken: number;
  urgentReminders: number;
}

export function computeFinanceDashboard(input: {
  receivables: readonly Receivable[];
  payments: readonly Payment[];
  promises: readonly PaymentPromise[];
  reminders: readonly CollectionReminder[];
  today?: string;
}): FinanceDashboard {
  const today = input.today ?? todayIso();
  const active = input.receivables.filter((receivable) => !['annulee', 'brouillon'].includes(receivable.status));
  const views = active.map((receivable) => computeReceivableView(receivable, input.payments, today));
  const knownInitial = active.every((receivable) => receivable.initialAmount !== null);
  const initialTotal = knownInitial && active.length ? active.reduce((sum, receivable) => sum + (receivable.initialAmount ?? 0), 0) : null;
  const paidTotal = views.reduce((sum, view) => sum + view.paid, 0);
  const balanceTotal = knownInitial ? views.reduce((sum, view) => sum + view.balance, 0) : null;
  const overdue = views.filter((view) => view.effectiveStatus === 'en_retard');
  const dueSoon = views.filter((view) => {
    if (view.balance <= 0) return false;
    const remaining = daysBetween(today, view.receivable.dueDate);
    return remaining !== null && remaining >= 0 && remaining <= 7;
  });
  const monthPrefix = today.slice(0, 7);
  const monthCollected = validPayments(input.payments)
    .filter((payment) => payment.paidAt.startsWith(monthPrefix))
    .reduce((sum, payment) => sum + payment.amount, 0);
  const linkedPromises = input.promises.filter((promise) => !['annulee', 'reprogrammee'].includes(promise.status));
  return {
    initialTotal,
    paidTotal,
    balanceTotal,
    overdueTotal: overdue.reduce((sum, view) => sum + view.balance, 0),
    dueSoonTotal: dueSoon.reduce((sum, view) => sum + view.balance, 0),
    overdueCount: overdue.length,
    debtorCount: new Set(views.filter((view) => view.balance > 0).map((view) => view.receivable.contactId).filter(Boolean)).size,
    recoveryRate: initialTotal && initialTotal > 0 ? Math.round((paidTotal / initialTotal) * 100) : null,
    monthCollected,
    openCount: views.filter((view) => view.balance > 0 && !['payee', 'annulee'].includes(view.effectiveStatus)).length,
    promisesUpcoming: linkedPromises.filter((promise) => effectivePromiseStatus(promise, today) === 'a_venir').length,
    promisesBroken: linkedPromises.filter((promise) => effectivePromiseStatus(promise, today) === 'non_respectee').length,
    urgentReminders: input.reminders.filter((reminder) => {
      if (reminder.status !== 'a_faire') return false;
      const days = daysBetween(reminder.dueDate, today);
      return days !== null && days >= 0 && days <= 2;
    }).length,
  };
}

export type ScheduleBucket = 'aujourdhui' | 'semaine' | 'mois' | 'futur' | 'retard';

export function scheduleBucket(dueDate: string, today = todayIso()): ScheduleBucket | null {
  const days = daysBetween(today, dueDate);
  if (days === null) return null;
  if (days < 0) return 'retard';
  if (days === 0) return 'aujourdhui';
  if (days <= 7) return 'semaine';
  if (days <= 31) return 'mois';
  return 'futur';
}

export function groupSchedule(views: readonly ReceivableView[], today = todayIso()): Record<ScheduleBucket, ReceivableView[]> {
  const groups: Record<ScheduleBucket, ReceivableView[]> = { aujourdhui: [], semaine: [], mois: [], futur: [], retard: [] };
  for (const view of views) {
    if (view.balance <= 0 || ['annulee', 'brouillon'].includes(view.effectiveStatus)) continue;
    const bucket = scheduleBucket(view.receivable.dueDate, today);
    if (bucket) groups[bucket].push(view);
  }
  return groups;
}

export interface MonthlyCollection {
  month: string;
  amount: number;
}

export function monthlyCollections(payments: readonly Payment[], months = 6, today = todayIso()): MonthlyCollection[] {
  const result: MonthlyCollection[] = [];
  const base = new Date(`${today}T00:00:00Z`);
  for (let index = months - 1; index >= 0; index--) {
    const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - index, 1));
    const month = date.toISOString().slice(0, 7);
    const total = validPayments(payments)
      .filter((payment) => payment.paidAt.startsWith(month))
      .reduce((sum, payment) => sum + payment.amount, 0);
    result.push({ month, amount: total });
  }
  return result;
}

export interface AgingBuckets {
  non_echu: number;
  retard_1_30: number;
  retard_31_60: number;
  retard_61_90: number;
  retard_90_plus: number;
}

export function agingBuckets(views: readonly ReceivableView[]): AgingBuckets {
  const buckets: AgingBuckets = { non_echu: 0, retard_1_30: 0, retard_31_60: 0, retard_61_90: 0, retard_90_plus: 0 };
  for (const view of views) {
    if (view.balance <= 0 || ['annulee', 'brouillon'].includes(view.effectiveStatus)) continue;
    if (view.daysOverdue === 0) buckets.non_echu += view.balance;
    else if (view.daysOverdue <= 30) buckets.retard_1_30 += view.balance;
    else if (view.daysOverdue <= 60) buckets.retard_31_60 += view.balance;
    else if (view.daysOverdue <= 90) buckets.retard_61_90 += view.balance;
    else buckets.retard_90_plus += view.balance;
  }
  return buckets;
}

/* -------------------------------------------------------------------------- */
/* Modèles de recouvrement                                                    */
/* -------------------------------------------------------------------------- */

export const RECOVERY_TEMPLATES: readonly {
  id: string; label: string; channel: 'whatsapp' | 'email' | 'sms'; body: string;
}[] = [
  { id: 'rappel_preventif', label: 'Rappel préventif', channel: 'whatsapp', body: 'Bonjour {{contact}}, petit rappel amical : la facture {{reference}} de {{montant}} arrive à échéance le {{date}}. Merci d’avance. — {{responsable}}' },
  { id: 'rappel_echeance', label: 'Rappel d’échéance', channel: 'email', body: 'Bonjour {{contact}},\n\nLa facture {{reference}} d’un montant de {{montant}} arrive à échéance le {{date}}. Vous trouverez le détail ci-dessous.\n\nBien cordialement,\n{{responsable}}' },
  { id: 'retard_leger', label: 'Retard léger', channel: 'whatsapp', body: 'Bonjour {{contact}}, la facture {{reference}} ({{montant}}) est arrivée à échéance le {{date}}. Pouvez-vous nous indiquer quand le règlement est prévu ? — {{responsable}}' },
  { id: 'retard_important', label: 'Retard important', channel: 'email', body: 'Bonjour {{contact}},\n\nMalgré notre relance, la facture {{reference}} de {{montant}} reste impayée (échéance {{date}}). Merci de régulariser ou de nous proposer un échéancier.\n\n{{responsable}}' },
  { id: 'relance_ferme', label: 'Relance ferme', channel: 'email', body: 'Bonjour {{contact}},\n\nSans règlement de la facture {{reference}} ({{montant}}, échue le {{date}}), nous serons contraints de suspendre nos prestations. Merci de votre retour rapide.\n\n{{responsable}}' },
  { id: 'dernier_rappel', label: 'Dernier rappel', channel: 'sms', body: 'Dernier rappel : facture {{reference}} {{montant}} impayée depuis le {{date}}. Sans règlement sous 48 h, le dossier sera transmis. {{responsable}}' },
];

export interface RecoveryVariables {
  contact?: string;
  reference?: string;
  montant?: string;
  date?: string;
  responsable?: string;
}

export function renderRecoveryTemplate(body: string, variables: RecoveryVariables): string {
  return body.replace(/{{\s*([a-z_]+)\s*}}/gi, (_match, key: string) => {
    const value = variables[key.toLowerCase() as keyof RecoveryVariables];
    return value && value.trim() ? value : `[${key}]`;
  });
}

export function recoveryWhatsappLink(phone: string, message: string): string {
  return `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
}

export function recoveryMailtoLink(email: string, reference: string, message: string): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`Facture ${reference}`)}&body=${encodeURIComponent(message)}`;
}

/* -------------------------------------------------------------------------- */
/* Reçus et exports                                                           */
/* -------------------------------------------------------------------------- */

export interface ReceiptData {
  reference: string;
  paidAt: string;
  amount: number;
  method: string;
  paymentReference: string;
  contactName: string;
  company: string;
  receivableReference: string;
  balanceAfter: number;
  cancelled: boolean;
}

export function buildReceipt(input: {
  payment: Payment;
  view: ReceivableView;
  contactName: string;
  company: string;
}): ReceiptData {
  return {
    reference: `REC-${input.payment.id.slice(0, 8).toUpperCase()}`,
    paidAt: input.payment.paidAt,
    amount: input.payment.amount,
    method: PAYMENT_METHODS.find((method) => method.value === input.payment.method)?.label ?? input.payment.method,
    paymentReference: input.payment.reference,
    contactName: input.contactName,
    company: input.company,
    receivableReference: input.view.receivable.reference,
    balanceAfter: input.view.balance,
    cancelled: input.payment.cancelled,
  };
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function receivablesToCsv(views: readonly ReceivableView[], contactName: (id: string) => string): string {
  const headers = ['Référence', 'Client', 'Description', 'Montant initial', 'Payé', 'Solde', 'Émise le', 'Échéance', 'Statut', 'Jours de retard', 'Responsable'];
  return [headers.join(','), ...views.map((view) => [
    view.receivable.reference, contactName(view.receivable.contactId), view.receivable.description,
    view.receivable.initialAmount ?? '', view.paid, view.balance, view.receivable.issuedAt,
    view.receivable.dueDate, view.effectiveStatus, view.daysOverdue, view.receivable.owner,
  ].map(csvEscape).join(','))].join('\r\n');
}

export function paymentsToCsv(payments: readonly Payment[], receivableReference: (id: string) => string): string {
  const headers = ['Identifiant', 'Créance', 'Montant', 'Date', 'Mode', 'Référence', 'Auteur', 'Annulé', 'Motif d’annulation'];
  return [headers.join(','), ...payments.map((payment) => [
    payment.id, receivableReference(payment.receivableId), payment.amount, payment.paidAt,
    payment.method, payment.reference, payment.author, payment.cancelled ? 'oui' : 'non',
    payment.cancellationReason,
  ].map(csvEscape).join(','))].join('\r\n');
}

export function overdueReportToCsv(views: readonly ReceivableView[], contactName: (id: string) => string): string {
  const overdue = views.filter((view) => view.effectiveStatus === 'en_retard');
  const headers = ['Client', 'Référence', 'Solde', 'Échéance', 'Jours de retard'];
  return [headers.join(','), ...overdue.map((view) => [
    contactName(view.receivable.contactId), view.receivable.reference, view.balance,
    view.receivable.dueDate, view.daysOverdue,
  ].map(csvEscape).join(','))].join('\r\n');
}
