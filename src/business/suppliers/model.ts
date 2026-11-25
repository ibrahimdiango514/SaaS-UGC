/**
 * SORAHNEX Growth OS — Lot J : fournisseurs, achats et réceptions.
 *
 * Les achats réutilisent les lignes de vente, le stock et les dépenses. Une
 * réception crée un mouvement d'entrée par ligne ; les clés d'idempotence
 * empêchent de comptabiliser deux fois la même réception. Aucune dépense n'est
 * créée sans confirmation explicite.
 */

import { dateOnly, todayIso } from '../crm/model';
import { computeTotals, type SalesLine } from '../sales/model';

export type SupplierStatus = 'actif' | 'inactif';
export type PurchaseStatus = 'brouillon' | 'confirme' | 'recu_partiel' | 'recu' | 'annule';

export interface Supplier {
  id: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  country: string;
  category: string;
  notes: string;
  status: SupplierStatus;
  createdAt: string;
}

export interface PurchaseLine extends SalesLine {
  /** Produit suivi en stock, vide pour une prestation. */
  productId: string;
}

export interface PurchaseOrder {
  id: string;
  number: string;
  supplierId: string;
  status: PurchaseStatus;
  orderedAt: string;
  expectedAt: string;
  receivedAt: string;
  notes: string;
  currency: string;
  lines: PurchaseLine[];
  expenseId: string;
  createdAt: string;
}

export interface GoodsReceipt {
  id: string;
  purchaseOrderId: string;
  supplierId: string;
  receivedAt: string;
  note: string;
  lines: Array<{ id: string; productId: string; description: string; quantity: number }>;
  createdAt: string;
}

export const PURCHASE_STATUSES: readonly { value: PurchaseStatus; label: string; tone: string }[] = [
  { value: 'brouillon', label: 'Brouillon', tone: 'neutral' },
  { value: 'confirme', label: 'Confirmée', tone: 'info' },
  { value: 'recu_partiel', label: 'Reçue partiellement', tone: 'warning' },
  { value: 'recu', label: 'Reçue', tone: 'success' },
  { value: 'annule', label: 'Annulée', tone: 'danger' },
];

export const SUPPLIER_CATEGORIES = {
  suppliers: 'bg_module_suppliers',
  purchases: 'bg_module_purchase_orders',
  receipts: 'bg_module_goods_receipts',
} as const;

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function supplierFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): Supplier {
  const data = record.data ?? {};
  return {
    id: record.id,
    name: str(data.name, 200) || 'Fournisseur sans nom',
    contactName: str(data.contactName, 160),
    phone: str(data.phone, 60),
    email: str(data.email, 200).toLowerCase(),
    address: str(data.address, 240),
    city: str(data.city, 80),
    country: str(data.country, 80),
    category: str(data.category, 80),
    notes: str(data.notes, 2000),
    status: oneOf<SupplierStatus>(data.status, ['actif', 'inactif'], 'actif'),
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

export function supplierToData(supplier: Supplier): Record<string, unknown> {
  return {
    name: supplier.name, contactName: supplier.contactName, phone: supplier.phone,
    email: supplier.email, address: supplier.address, city: supplier.city,
    country: supplier.country, category: supplier.category, notes: supplier.notes,
    status: supplier.status,
  };
}

function purchaseLines(value: unknown): PurchaseLine[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const quantity = Number(data.quantity);
    const unitPrice = Number(data.unitPrice);
    return {
      id: str(data.id, 64) || `line-${index + 1}`,
      productId: str(data.productId, 64),
      description: str(data.description, 300) || 'Ligne sans libellé',
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
      discountPct: Number.isFinite(Number(data.discountPct)) ? Math.min(100, Math.max(0, Number(data.discountPct))) : 0,
      taxPct: Number.isFinite(Number(data.taxPct)) ? Math.min(100, Math.max(0, Number(data.taxPct))) : 0,
    };
  }).slice(0, 60);
}

export function purchaseFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): PurchaseOrder {
  const data = record.data ?? {};
  return {
    id: record.id,
    number: str(data.number, 40) || 'ACH-—',
    supplierId: str(data.supplierId, 64),
    status: oneOf<PurchaseStatus>(data.status, PURCHASE_STATUSES.map((entry) => entry.value), 'brouillon'),
    orderedAt: dateOnly(data.orderedAt) || (record.created_at ?? '').slice(0, 10),
    expectedAt: dateOnly(data.expectedAt),
    receivedAt: dateOnly(data.receivedAt),
    notes: str(data.notes, 2000),
    currency: str(data.currency, 8).toUpperCase() || 'XOF',
    lines: purchaseLines(data.lines),
    expenseId: str(data.expenseId, 64),
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

export function purchaseToData(purchase: PurchaseOrder): Record<string, unknown> {
  return {
    number: purchase.number, supplierId: purchase.supplierId, status: purchase.status,
    orderedAt: purchase.orderedAt, expectedAt: purchase.expectedAt, receivedAt: purchase.receivedAt,
    notes: purchase.notes, currency: purchase.currency, lines: purchase.lines, expenseId: purchase.expenseId,
  };
}

export function receiptFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): GoodsReceipt {
  const data = record.data ?? {};
  return {
    id: record.id,
    purchaseOrderId: str(data.purchaseOrderId, 64),
    supplierId: str(data.supplierId, 64),
    receivedAt: dateOnly(data.receivedAt) || (record.created_at ?? '').slice(0, 10),
    note: str(data.note, 1000),
    lines: Array.isArray(data.lines) ? data.lines.map((raw, index) => {
      const line = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return {
        id: str(line.id, 64) || `receipt-${index + 1}`,
        productId: str(line.productId, 64),
        description: str(line.description, 300),
        quantity: Math.max(0, Number(line.quantity) || 0),
      };
    }) : [],
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

export function nextPurchaseNumber(existing: readonly string[], now = new Date()): string {
  const year = now.getFullYear();
  const pattern = new RegExp(`^ACH-${year}-(\\d+)$`);
  const max = existing.reduce((highest, value) => {
    const match = pattern.exec(value);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `ACH-${year}-${String(max + 1).padStart(4, '0')}`;
}

export function buildReceipt(order: PurchaseOrder, receivedAt = todayIso(), note = ''): Omit<GoodsReceipt, 'id' | 'createdAt'> {
  return {
    purchaseOrderId: order.id,
    supplierId: order.supplierId,
    receivedAt,
    note,
    lines: order.lines
      .filter((line) => line.productId)
      .map((line) => ({ id: line.id, productId: line.productId, description: line.description, quantity: line.quantity })),
  };
}

/** Un mouvement d'entrée par ligne reçue, dédupliqué par réception + ligne. */
export function receiptStockMovements(receipt: GoodsReceipt) {
  return receipt.lines
    .filter((line) => line.productId && line.quantity > 0)
    .map((line) => ({
      data: {
        productId: line.productId,
        type: 'entree',
        quantity: line.quantity,
        reason: `Réception achat ${receipt.purchaseOrderId}`,
        reference: receipt.id,
        occurredAt: receipt.receivedAt,
      },
      dedupeKey: `receipt:${receipt.id}:line:${line.id}`,
    }));
}

export function purchaseToExpenseData(order: PurchaseOrder, supplierName: string, paid: boolean) {
  return {
    label: `Achat ${order.number}${supplierName ? ` · ${supplierName}` : ''}`,
    category: 'Fournisseurs',
    supplier: supplierName,
    amount: computeTotals(order.lines).total,
    incurredAt: order.orderedAt || todayIso(),
    paidAt: paid ? todayIso() : '',
    method: 'virement',
    reference: order.number,
    notes: `Créée depuis la commande fournisseur ${order.number}`,
    status: paid ? 'payee' : 'engagee',
    recurrence: 'aucune',
    purchaseOrderId: order.id,
  };
}

export interface PurchaseSummary {
  suppliers: number;
  openOrders: number;
  openAmount: number | null;
  receivedOrders: number;
  purchasesTotal: number | null;
  expensesLinked: number;
}

export function computePurchaseSummary(suppliers: readonly Supplier[], orders: readonly PurchaseOrder[]): PurchaseSummary {
  const total = (order: PurchaseOrder) => computeTotals(order.lines).total;
  const active = orders.filter((order) => order.status !== 'annule');
  return {
    suppliers: suppliers.filter((supplier) => supplier.status === 'actif').length,
    openOrders: orders.filter((order) => order.status === 'brouillon' || order.status === 'confirme' || order.status === 'recu_partiel').length,
    openAmount: active.reduce((sum, order) => sum + (order.status === 'recu' ? 0 : total(order)), 0),
    receivedOrders: orders.filter((order) => order.status === 'recu').length,
    purchasesTotal: active.reduce((sum, order) => sum + total(order), 0),
    expensesLinked: orders.filter((order) => Boolean(order.expenseId)).length,
  };
}

export function ordersToCsv(orders: readonly PurchaseOrder[], supplierName: (id: string) => string): string {
  const esc = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['Numéro', 'Fournisseur', 'Statut', 'Commande', 'Livraison prévue', 'Total'];
  return [header.join(','), ...orders.map((order) => [
    order.number, supplierName(order.supplierId), order.status, order.orderedAt,
    order.expectedAt, computeTotals(order.lines).total,
  ].map(esc).join(','))].join('\r\n');
}
