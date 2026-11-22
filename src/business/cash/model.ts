/**
 * VYORA Growth OS — Lot G : trésorerie et dépenses.
 *
 * Distinction stricte entre facturé, encaissé, engagé et payé. Les encaissements
 * proviennent uniquement des paiements Finance validés et non annulés : une
 * facture émise ne devient jamais de l'argent disponible par elle-même.
 */

import { dateOnly, todayIso } from '../crm/model';
import type { PaymentMethod } from '../finance/model';

export type ExpenseStatus = 'engagee' | 'payee' | 'annulee';
export type ExpenseRecurrence = 'aucune' | 'mensuelle' | 'trimestrielle' | 'annuelle';

export interface Expense {
  id: string;
  label: string;
  category: string;
  supplier: string;
  amount: number;
  incurredAt: string;
  paidAt: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
  status: ExpenseStatus;
  recurrence: ExpenseRecurrence;
  createdAt: string;
}

export const EXPENSE_STATUSES: readonly { value: ExpenseStatus; label: string }[] = [
  { value: 'engagee', label: 'Engagée (non payée)' },
  { value: 'payee', label: 'Payée' },
  { value: 'annulee', label: 'Annulée' },
];

export const EXPENSE_RECURRENCES: readonly { value: ExpenseRecurrence; label: string }[] = [
  { value: 'aucune', label: 'Ponctuelle' },
  { value: 'mensuelle', label: 'Mensuelle' },
  { value: 'trimestrielle', label: 'Trimestrielle' },
  { value: 'annuelle', label: 'Annuelle' },
];

export const EXPENSE_CATEGORIES = [
  'Loyer', 'Salaires', 'Fournisseurs', 'Transport', 'Marketing', 'Logiciels', 'Impôts et taxes',
  'Énergie', 'Télécommunications', 'Entretien', 'Autre',
] as const;

export const CASH_CATEGORIES = {
  expenses: 'bg_module_cash_expenses',
} as const;

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function money(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(',', '.')) : NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1_000_000_000_000, parsed)) : 0;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function expenseFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): Expense {
  const data = record.data ?? {};
  return {
    id: record.id,
    label: str(data.label, 200) || 'Dépense sans libellé',
    category: str(data.category, 80) || 'Autre',
    supplier: str(data.supplier, 160),
    amount: money(data.amount),
    incurredAt: dateOnly(data.incurredAt) || (record.created_at ?? '').slice(0, 10),
    paidAt: dateOnly(data.paidAt),
    method: oneOf<PaymentMethod>(data.method, ['especes', 'mobile_money', 'virement', 'carte', 'cheque', 'autre'], 'especes'),
    reference: str(data.reference, 120),
    notes: str(data.notes, 1000),
    status: oneOf<ExpenseStatus>(data.status, ['engagee', 'payee', 'annulee'], 'payee'),
    recurrence: oneOf<ExpenseRecurrence>(data.recurrence, ['aucune', 'mensuelle', 'trimestrielle', 'annuelle'], 'aucune'),
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

export function expenseToData(expense: Expense): Record<string, unknown> {
  return {
    label: expense.label, category: expense.category, supplier: expense.supplier, amount: expense.amount,
    incurredAt: expense.incurredAt, paidAt: expense.paidAt, method: expense.method,
    reference: expense.reference, notes: expense.notes, status: expense.status, recurrence: expense.recurrence,
  };
}

export interface CashPayment {
  id: string;
  amount: number;
  paidAt: string;
  method: PaymentMethod;
  cancelled: boolean;
  reference?: string;
}

export interface CashMovement {
  id: string;
  kind: 'encaissement' | 'depense';
  date: string;
  label: string;
  category: string;
  amount: number;
  method: PaymentMethod;
}

export function cashMovements(payments: readonly CashPayment[], expenses: readonly Expense[]): CashMovement[] {
  const incoming: CashMovement[] = payments
    .filter((payment) => !payment.cancelled && payment.amount > 0)
    .map((payment) => ({
      id: `pay-${payment.id}`, kind: 'encaissement', date: dateOnly(payment.paidAt),
      label: 'Paiement client', category: 'Encaissements', amount: payment.amount,
      method: payment.method,
    }));
  const outgoing: CashMovement[] = expenses
    .filter((expense) => expense.status === 'payee')
    .map((expense) => ({
      id: `exp-${expense.id}`, kind: 'depense', date: expense.paidAt || expense.incurredAt,
      label: expense.label, category: expense.category, amount: expense.amount, method: expense.method,
    }));
  return [...incoming, ...outgoing]
    .filter((movement) => movement.date)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export interface CashSummary {
  collected: number;
  paidExpenses: number;
  committedExpenses: number;
  balance: number;
  billedRevenue: number | null;
  cashOnly: boolean;
}

export function computeCashSummary(input: {
  payments: readonly CashPayment[];
  expenses: readonly Expense[];
  invoicesTotal?: number | null;
}): CashSummary {
  const collected = input.payments.filter((payment) => !payment.cancelled).reduce((sum, payment) => sum + payment.amount, 0);
  const paidExpenses = input.expenses.filter((expense) => expense.status === 'payee').reduce((sum, expense) => sum + expense.amount, 0);
  const committed = input.expenses.filter((expense) => expense.status === 'engagee').reduce((sum, expense) => sum + expense.amount, 0);
  return {
    collected: Math.round(collected * 100) / 100,
    paidExpenses: Math.round(paidExpenses * 100) / 100,
    committedExpenses: Math.round(committed * 100) / 100,
    balance: Math.round((collected - paidExpenses) * 100) / 100,
    billedRevenue: input.invoicesTotal ?? null,
    cashOnly: true,
  };
}

export interface MonthPoint { month: string; income: number; expense: number; net: number }

export function monthlyCashflow(payments: readonly CashPayment[], expenses: readonly Expense[], months = 6, today = todayIso()): MonthPoint[] {
  const base = new Date(`${dateOnly(today) || todayIso()}T00:00:00Z`);
  const points: MonthPoint[] = [];
  for (let offset = months - 1; offset >= 0; offset--) {
    const date = new Date(base);
    date.setUTCMonth(date.getUTCMonth() - offset, 1);
    const month = date.toISOString().slice(0, 7);
    const income = payments
      .filter((payment) => !payment.cancelled && payment.paidAt.slice(0, 7) === month)
      .reduce((sum, payment) => sum + payment.amount, 0);
    const expense = expenses
      .filter((entry) => entry.status === 'payee' && (entry.paidAt || entry.incurredAt).slice(0, 7) === month)
      .reduce((sum, entry) => sum + entry.amount, 0);
    points.push({ month, income: Math.round(income), expense: Math.round(expense), net: Math.round(income - expense) });
  }
  return points;
}

export function expensesByCategory(expenses: readonly Expense[]): Array<{ category: string; amount: number; count: number }> {
  const map = new Map<string, { amount: number; count: number }>();
  for (const expense of expenses.filter((entry) => entry.status !== 'annulee')) {
    const entry = map.get(expense.category) ?? { amount: 0, count: 0 };
    entry.amount += expense.amount;
    entry.count += 1;
    map.set(expense.category, entry);
  }
  return Array.from(map.entries())
    .map(([category, value]) => ({ category, ...value }))
    .sort((a, b) => b.amount - a.amount);
}

export interface UnusualExpense {
  expense: Expense;
  categoryMedian: number;
  ratio: number;
  reason: string;
}

/** Règle transparente : > 2,5 × la médiane de sa catégorie et > 25 000. */
export function detectUnusualExpenses(expenses: readonly Expense[], minimumAmount = 25_000): UnusualExpense[] {
  const active = expenses.filter((expense) => expense.status !== 'annulee');
  const byCategory = new Map<string, number[]>();
  for (const expense of active) {
    const list = byCategory.get(expense.category) ?? [];
    list.push(expense.amount);
    byCategory.set(expense.category, list);
  }
  const result: UnusualExpense[] = [];
  for (const expense of active) {
    const values = (byCategory.get(expense.category) ?? []).slice().sort((a, b) => a - b);
    if (values.length < 3 || expense.amount < minimumAmount) continue;
    const median = values[Math.floor(values.length / 2)] ?? 0;
    if (median <= 0) continue;
    const ratio = expense.amount / median;
    if (ratio >= 2.5) {
      result.push({
        expense,
        categoryMedian: median,
        ratio: Math.round(ratio * 10) / 10,
        reason: `${ratio.toFixed(1)} × la dépense médiane de la catégorie ${expense.category}`,
      });
    }
  }
  return result.sort((a, b) => b.ratio - a.ratio).slice(0, 20);
}

export function validateExpense(expense: Pick<Expense, 'label' | 'amount' | 'incurredAt' | 'paidAt' | 'status'>): string[] {
  const errors: string[] = [];
  if (!expense.label.trim()) errors.push('Le libellé est obligatoire.');
  if (!(expense.amount > 0)) errors.push('Le montant doit être supérieur à zéro.');
  if (!dateOnly(expense.incurredAt)) errors.push('La date de la dépense est invalide.');
  if (expense.status === 'payee' && !dateOnly(expense.paidAt)) errors.push('Une dépense payée doit avoir une date de paiement.');
  if (expense.status === 'payee' && expense.paidAt < expense.incurredAt) errors.push('Le paiement ne peut pas précéder la dépense.');
  return errors;
}

/** Prochaine échéance d'une dépense récurrente, sans exécution automatique. */
export function nextRecurrenceDate(expense: Expense): string {
  if (expense.recurrence === 'aucune') return '';
  const base = new Date(`${expense.incurredAt || todayIso()}T00:00:00Z`);
  if (expense.recurrence === 'mensuelle') base.setUTCMonth(base.getUTCMonth() + 1);
  if (expense.recurrence === 'trimestrielle') base.setUTCMonth(base.getUTCMonth() + 3);
  if (expense.recurrence === 'annuelle') base.setUTCFullYear(base.getUTCFullYear() + 1);
  return base.toISOString().slice(0, 10);
}

export function expensesToCsv(expenses: readonly Expense[]): string {
  const esc = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['Date', 'Libellé', 'Catégorie', 'Fournisseur', 'Montant', 'Payée le', 'Moyen', 'Statut', 'Référence'];
  return [header.join(','), ...expenses.map((expense) => [
    expense.incurredAt, expense.label, expense.category, expense.supplier, expense.amount,
    expense.paidAt, expense.method, expense.status, expense.reference,
  ].map(esc).join(','))].join('\r\n');
}
