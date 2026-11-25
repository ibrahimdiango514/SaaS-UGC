/**
 * SORAHNEX Growth OS — Lot E : ventes, devis, commandes et factures.
 *
 * Modèle pur, sans React ni Supabase. Les totaux, statuts et conversions sont
 * calculés ici afin de rester testables et explicables. Le stockage générique
 * des modules métier reste l'autorité : aucune écriture locale n'est présentée
 * comme enregistrée avant la réponse du serveur.
 */

import { dateOnly, daysBetween, todayIso } from '../crm/model';

export type QuoteStatus = 'brouillon' | 'envoye' | 'accepte' | 'refuse' | 'expire' | 'converti';
export type OrderStatus = 'brouillon' | 'confirme' | 'en_preparation' | 'expedie' | 'livre' | 'annule';
export type InvoiceStatus = 'brouillon' | 'envoyee' | 'partiellement_payee' | 'payee' | 'en_retard' | 'annulee';
export type DocumentKind = 'devis' | 'commande' | 'facture';

export interface SalesLine {
  id: string;
  productId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
}

export interface SalesTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

export interface Quote {
  id: string;
  number: string;
  contactId: string;
  status: QuoteStatus;
  issuedAt: string;
  expiresAt: string;
  terms: string;
  notes: string;
  currency: string;
  lines: SalesLine[];
  orderId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SalesOrder {
  id: string;
  number: string;
  contactId: string;
  quoteId: string;
  status: OrderStatus;
  orderedAt: string;
  expectedAt: string;
  notes: string;
  currency: string;
  lines: SalesLine[];
  invoiceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Invoice {
  id: string;
  number: string;
  contactId: string;
  orderId: string;
  quoteId: string;
  status: InvoiceStatus;
  issuedAt: string;
  dueDate: string;
  terms: string;
  notes: string;
  currency: string;
  lines: SalesLine[];
  receivableId: string;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceView {
  invoice: Invoice;
  totals: SalesTotals;
  paid: number;
  balance: number;
  effectiveStatus: InvoiceStatus;
  daysOverdue: number;
}

export const QUOTE_STATUSES: readonly { value: QuoteStatus; label: string; tone: string }[] = [
  { value: 'brouillon', label: 'Brouillon', tone: 'neutral' },
  { value: 'envoye', label: 'Envoyé', tone: 'info' },
  { value: 'accepte', label: 'Accepté', tone: 'success' },
  { value: 'refuse', label: 'Refusé', tone: 'danger' },
  { value: 'expire', label: 'Expiré', tone: 'warning' },
  { value: 'converti', label: 'Converti en commande', tone: 'success' },
];

export const ORDER_STATUSES: readonly { value: OrderStatus; label: string; tone: string }[] = [
  { value: 'brouillon', label: 'Brouillon', tone: 'neutral' },
  { value: 'confirme', label: 'Confirmée', tone: 'info' },
  { value: 'en_preparation', label: 'En préparation', tone: 'warning' },
  { value: 'expedie', label: 'Expédiée', tone: 'info' },
  { value: 'livre', label: 'Livrée', tone: 'success' },
  { value: 'annule', label: 'Annulée', tone: 'danger' },
];

export const INVOICE_STATUSES: readonly { value: InvoiceStatus; label: string; tone: string }[] = [
  { value: 'brouillon', label: 'Brouillon', tone: 'neutral' },
  { value: 'envoyee', label: 'Envoyée', tone: 'info' },
  { value: 'partiellement_payee', label: 'Partiellement payée', tone: 'warning' },
  { value: 'payee', label: 'Payée', tone: 'success' },
  { value: 'en_retard', label: 'En retard', tone: 'danger' },
  { value: 'annulee', label: 'Annulée', tone: 'neutral' },
];

export const SALES_CATEGORIES = {
  quotes: 'bg_module_sales_quotes',
  orders: 'bg_module_sales_orders',
  invoices: 'bg_module_sales_invoices',
} as const;

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function num(value: unknown, min = 0, max = 1_000_000_000_000): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(',', '.')) : NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : 0;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function isoOrNow(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function lineFromRaw(value: unknown, index: number): SalesLine | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const quantity = num(raw.quantity, 0.01, 1_000_000);
  const unitPrice = num(raw.unitPrice, 0, 1_000_000_000);
  if (!quantity) return null;
  return {
    id: str(raw.id, 64) || `line-${index + 1}`,
    productId: str(raw.productId, 64),
    description: str(raw.description, 300) || 'Ligne sans libellé',
    quantity,
    unitPrice,
    discountPct: num(raw.discountPct, 0, 100),
    taxPct: num(raw.taxPct, 0, 100),
  };
}

export function linesFrom(value: unknown): SalesLine[] {
  return Array.isArray(value)
    ? value.map(lineFromRaw).filter((line): line is SalesLine => line !== null).slice(0, 60)
    : [];
}

export function computeTotals(lines: readonly SalesLine[]): SalesTotals {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  for (const line of lines) {
    const gross = line.quantity * line.unitPrice;
    const lineDiscount = gross * (line.discountPct / 100);
    const net = gross - lineDiscount;
    subtotal += gross;
    discount += lineDiscount;
    tax += net * (line.taxPct / 100);
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    subtotal: round(subtotal),
    discount: round(discount),
    tax: round(tax),
    total: round(subtotal - discount + tax),
  };
}

/** Numérotation professionnelle stable, une séquence par type et par année. */
export function nextNumber(kind: DocumentKind, existing: readonly string[], now = new Date()): string {
  const prefix = kind === 'devis' ? 'DEV' : kind === 'commande' ? 'CMD' : 'FAC';
  const year = now.getFullYear();
  const pattern = new RegExp(`^${prefix}-${year}-(\\d+)$`);
  const max = existing.reduce((highest, value) => {
    const match = pattern.exec(value);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `${prefix}-${year}-${String(max + 1).padStart(4, '0')}`;
}

export function quoteFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string; updated_at?: string }): Quote {
  const data = record.data ?? {};
  return {
    id: record.id,
    number: str(data.number, 40) || 'DEV-—',
    contactId: str(data.contactId, 64),
    status: oneOf<QuoteStatus>(data.status, QUOTE_STATUSES.map((entry) => entry.value), 'brouillon'),
    issuedAt: dateOnly(data.issuedAt) || (record.created_at ?? '').slice(0, 10),
    expiresAt: dateOnly(data.expiresAt),
    terms: str(data.terms, 1000),
    notes: str(data.notes, 2000),
    currency: str(data.currency, 8).toUpperCase() || 'XOF',
    lines: linesFrom(data.lines),
    orderId: str(data.orderId, 64),
    createdAt: isoOrNow(record.created_at),
    updatedAt: isoOrNow(record.updated_at),
  };
}

export function quoteToData(quote: Quote): Record<string, unknown> {
  return {
    number: quote.number, contactId: quote.contactId, status: quote.status,
    issuedAt: quote.issuedAt, expiresAt: quote.expiresAt, terms: quote.terms,
    notes: quote.notes, currency: quote.currency, lines: quote.lines, orderId: quote.orderId,
  };
}

export function orderFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string; updated_at?: string }): SalesOrder {
  const data = record.data ?? {};
  return {
    id: record.id,
    number: str(data.number, 40) || 'CMD-—',
    contactId: str(data.contactId, 64),
    quoteId: str(data.quoteId, 64),
    status: oneOf<OrderStatus>(data.status, ORDER_STATUSES.map((entry) => entry.value), 'brouillon'),
    orderedAt: dateOnly(data.orderedAt) || (record.created_at ?? '').slice(0, 10),
    expectedAt: dateOnly(data.expectedAt),
    notes: str(data.notes, 2000),
    currency: str(data.currency, 8).toUpperCase() || 'XOF',
    lines: linesFrom(data.lines),
    invoiceId: str(data.invoiceId, 64),
    createdAt: isoOrNow(record.created_at),
    updatedAt: isoOrNow(record.updated_at),
  };
}

export function orderToData(order: SalesOrder): Record<string, unknown> {
  return {
    number: order.number, contactId: order.contactId, quoteId: order.quoteId,
    status: order.status, orderedAt: order.orderedAt, expectedAt: order.expectedAt,
    notes: order.notes, currency: order.currency, lines: order.lines, invoiceId: order.invoiceId,
  };
}

export function invoiceFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string; updated_at?: string }): Invoice {
  const data = record.data ?? {};
  return {
    id: record.id,
    number: str(data.number, 40) || 'FAC-—',
    contactId: str(data.contactId, 64),
    orderId: str(data.orderId, 64),
    quoteId: str(data.quoteId, 64),
    status: oneOf<InvoiceStatus>(data.status, INVOICE_STATUSES.map((entry) => entry.value), 'brouillon'),
    issuedAt: dateOnly(data.issuedAt) || (record.created_at ?? '').slice(0, 10),
    dueDate: dateOnly(data.dueDate),
    terms: str(data.terms, 1000),
    notes: str(data.notes, 2000),
    currency: str(data.currency, 8).toUpperCase() || 'XOF',
    lines: linesFrom(data.lines),
    receivableId: str(data.receivableId, 64),
    createdAt: isoOrNow(record.created_at),
    updatedAt: isoOrNow(record.updated_at),
  };
}

export function invoiceToData(invoice: Invoice): Record<string, unknown> {
  return {
    number: invoice.number, contactId: invoice.contactId, orderId: invoice.orderId,
    quoteId: invoice.quoteId, status: invoice.status, issuedAt: invoice.issuedAt,
    dueDate: invoice.dueDate, terms: invoice.terms, notes: invoice.notes,
    currency: invoice.currency, lines: invoice.lines, receivableId: invoice.receivableId,
  };
}

/** Paiements Finance validés, rapprochés par créance. Aucun double comptage. */
export interface InvoicePaymentInput {
  receivableId: string;
  amount: number;
  paidAt: string;
  cancelled: boolean;
}

export function computeInvoiceView(invoice: Invoice, payments: readonly InvoicePaymentInput[], today = todayIso()): InvoiceView {
  const totals = computeTotals(invoice.lines);
  const paid = invoice.receivableId
    ? payments
      .filter((payment) => payment.receivableId === invoice.receivableId && !payment.cancelled)
      .reduce((sum, payment) => sum + Math.max(0, payment.amount), 0)
    : 0;
  const balance = Math.max(0, Math.round((totals.total - paid) * 100) / 100);
  const overdueDays = invoice.dueDate ? daysBetween(invoice.dueDate, today) : null;
  let effectiveStatus = invoice.status;
  if (invoice.status !== 'annulee' && invoice.status !== 'brouillon') {
    if (balance <= 0 && totals.total > 0) effectiveStatus = 'payee';
    else if (paid > 0) effectiveStatus = overdueDays !== null && overdueDays > 0 ? 'en_retard' : 'partiellement_payee';
    else if (overdueDays !== null && overdueDays > 0) effectiveStatus = 'en_retard';
  }
  return {
    invoice,
    totals,
    paid: Math.round(paid * 100) / 100,
    balance,
    effectiveStatus,
    daysOverdue: Math.max(0, overdueDays ?? 0),
  };
}

export function quoteIsExpired(quote: Quote, today = todayIso()): boolean {
  const days = quote.expiresAt ? daysBetween(quote.expiresAt, today) : null;
  return quote.status === 'envoye' && days !== null && days > 0;
}

export interface SalesDashboard {
  draftQuotes: number;
  pendingQuotes: number;
  pendingQuoteValue: number | null;
  acceptedQuotes: number;
  acceptedQuoteValue: number | null;
  openOrders: number;
  openOrderValue: number | null;
  invoicedTotal: number | null;
  collectedTotal: number | null;
  unpaidInvoices: number;
  unpaidAmount: number | null;
  overdueInvoices: number;
}

export function computeSalesDashboard(input: {
  quotes: readonly Quote[];
  orders: readonly SalesOrder[];
  invoiceViews: readonly InvoiceView[];
}): SalesDashboard {
  const pending = input.quotes.filter((quote) => quote.status === 'envoye');
  const accepted = input.quotes.filter((quote) => quote.status === 'accepte' || quote.status === 'converti');
  const openOrders = input.orders.filter((order) => order.status !== 'annule' && order.status !== 'livre');
  const sumTotals = (lines: readonly SalesLine[]) => computeTotals(lines).total;
  const invoicesActive = input.invoiceViews.filter((view) => view.invoice.status !== 'annulee' && view.invoice.status !== 'brouillon');
  const unpaid = input.invoiceViews.filter((view) => view.effectiveStatus !== 'payee' && view.effectiveStatus !== 'annulee' && view.invoice.status !== 'brouillon');
  return {
    draftQuotes: input.quotes.filter((quote) => quote.status === 'brouillon').length,
    pendingQuotes: pending.length,
    pendingQuoteValue: pending.reduce((sum, quote) => sum + sumTotals(quote.lines), 0),
    acceptedQuotes: accepted.length,
    acceptedQuoteValue: accepted.reduce((sum, quote) => sum + sumTotals(quote.lines), 0),
    openOrders: openOrders.length,
    openOrderValue: openOrders.reduce((sum, order) => sum + sumTotals(order.lines), 0),
    invoicedTotal: invoicesActive.reduce((sum, view) => sum + view.totals.total, 0),
    collectedTotal: invoicesActive.reduce((sum, view) => sum + view.paid, 0),
    unpaidInvoices: unpaid.length,
    unpaidAmount: unpaid.reduce((sum, view) => sum + view.balance, 0),
    overdueInvoices: input.invoiceViews.filter((view) => view.effectiveStatus === 'en_retard').length,
  };
}

/** Contrôles avant conversion : on ne convertit jamais un document vide. */
export function conversionErrors(kind: DocumentKind, document: { lines: readonly SalesLine[]; contactId: string }): string[] {
  const errors: string[] = [];
  if (!document.lines.length) errors.push('Ajoutez au moins une ligne.');
  if (!document.contactId) errors.push('Sélectionnez un client CRM.');
  if (document.lines.some((line) => line.quantity <= 0)) errors.push('Chaque quantité doit être supérieure à zéro.');
  if (document.lines.some((line) => line.unitPrice < 0)) errors.push('Un prix ne peut pas être négatif.');
  if (kind === 'devis' && computeTotals(document.lines).total <= 0) errors.push('Le total du devis doit être supérieur à zéro.');
  return errors;
}

export function invoiceToReceivableData(invoice: Invoice, fallbackOwner = '') {
  const totals = computeTotals(invoice.lines);
  return {
    reference: invoice.number,
    contactId: invoice.contactId,
    description: `Facture ${invoice.number}`,
    initialAmount: totals.total,
    issuedAt: invoice.issuedAt || todayIso(),
    dueDate: invoice.dueDate || invoice.issuedAt || todayIso(),
    terms: invoice.terms,
    status: 'en_attente',
    owner: fallbackOwner,
    notes: `Créée depuis la facture ${invoice.number}`,
    invoiceId: invoice.id,
  };
}

export function quoteToOrderDraft(quote: Quote, number: string, today = todayIso()): Omit<SalesOrder, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    number,
    contactId: quote.contactId,
    quoteId: quote.id,
    status: 'confirme',
    orderedAt: today,
    expectedAt: '',
    notes: quote.notes,
    currency: quote.currency,
    lines: quote.lines,
    invoiceId: '',
  };
}

export function orderToInvoiceDraft(order: SalesOrder, number: string, today = todayIso(), dueDate = ''): Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    number,
    contactId: order.contactId,
    orderId: order.id,
    quoteId: order.quoteId,
    status: 'brouillon',
    issuedAt: today,
    dueDate: dueDate || addDays(today, 30),
    terms: 'Paiement à 30 jours',
    notes: order.notes,
    currency: order.currency,
    lines: order.lines,
    receivableId: '',
  };
}

export function addDays(dateIso: string, days: number): string {
  const base = dateOnly(dateIso) || todayIso();
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function statusLabel(kind: DocumentKind, status: string): string {
  const source = kind === 'devis' ? QUOTE_STATUSES : kind === 'commande' ? ORDER_STATUSES : INVOICE_STATUSES;
  return source.find((entry) => entry.value === status)?.label ?? status;
}

export function statusTone(kind: DocumentKind, status: string): string {
  const source = kind === 'devis' ? QUOTE_STATUSES : kind === 'commande' ? ORDER_STATUSES : INVOICE_STATUSES;
  return source.find((entry) => entry.value === status)?.tone ?? 'neutral';
}

export function quotesToCsv(quotes: readonly Quote[], contactName: (id: string) => string): string {
  const esc = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['Numéro', 'Client', 'Statut', 'Émission', 'Expiration', 'Total', 'Devise'];
  return [header.join(','), ...quotes.map((quote) => [
    quote.number, contactName(quote.contactId), quote.status, quote.issuedAt, quote.expiresAt,
    computeTotals(quote.lines).total, quote.currency,
  ].map(esc).join(','))].join('\r\n');
}

export function invoicesToCsv(views: readonly InvoiceView[], contactName: (id: string) => string): string {
  const esc = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['Numéro', 'Client', 'Statut', 'Émission', 'Échéance', 'Total', 'Encaissé', 'Solde'];
  return [header.join(','), ...views.map((view) => [
    view.invoice.number, contactName(view.invoice.contactId), view.effectiveStatus,
    view.invoice.issuedAt, view.invoice.dueDate, view.totals.total, view.paid, view.balance,
  ].map(esc).join(','))].join('\r\n');
}

/** Document imprimable : mêmes montants que l'écran, pas de recalcul divergent. */
export function printableDocument(kind: DocumentKind, document: Quote | SalesOrder | Invoice, contactName: string, workspaceName: string): string {
  const totals = computeTotals(document.lines);
  const title = kind === 'devis' ? 'Devis' : kind === 'commande' ? 'Commande' : 'Facture';
  const escape = (value: string) => value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char));
  const rows = document.lines.map((line) => `<tr><td>${escape(line.description)}</td><td>${line.quantity}</td><td>${line.unitPrice.toLocaleString('fr-FR')}</td><td>${line.discountPct}%</td><td>${line.taxPct}%</td><td>${(line.quantity * line.unitPrice * (1 - line.discountPct / 100) * (1 + line.taxPct / 100)).toLocaleString('fr-FR')}</td></tr>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title} ${escape(document.number)}</title><style>body{font-family:system-ui,sans-serif;padding:32px;color:#111}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left;font-size:13px}tfoot td{font-weight:700}.meta{color:#555;font-size:13px}</style></head><body><h1>${title} ${escape(document.number)}</h1><p class="meta">${escape(workspaceName)} · ${escape(contactName)}</p><p class="meta">Émis le ${escape(('issuedAt' in document ? document.issuedAt : '') || '')}</p><table><thead><tr><th>Désignation</th><th>Qté</th><th>Prix</th><th>Remise</th><th>TVA</th><th>Total</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="5">Sous-total</td><td>${totals.subtotal.toLocaleString('fr-FR')} ${document.currency}</td></tr><tr><td colspan="5">Remise</td><td>${totals.discount.toLocaleString('fr-FR')} ${document.currency}</td></tr><tr><td colspan="5">Taxes</td><td>${totals.tax.toLocaleString('fr-FR')} ${document.currency}</td></tr><tr><td colspan="5">Total</td><td>${totals.total.toLocaleString('fr-FR')} ${document.currency}</td></tr></tfoot></table>${'terms' in document && document.terms ? `<p class="meta">${escape(document.terms)}</p>` : ''}</body></html>`;
}
