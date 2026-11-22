/**
 * VYORA Growth OS — Lot F : produits, services et stock.
 *
 * Le stock n'est jamais stocké comme un compteur modifiable : il est dérivé des
 * mouvements, ce qui rend l'historique auditable et évite les écarts silencieux.
 */

import { dateOnly, todayIso } from '../crm/model';

export type ProductKind = 'produit' | 'service' | 'numerique';
export type MovementType = 'entree' | 'sortie' | 'ajustement';

export interface Product {
  id: string;
  name: string;
  sku: string;
  category: string;
  kind: ProductKind;
  description: string;
  price: number | null;
  cost: number | null;
  unit: string;
  active: boolean;
  trackStock: boolean;
  initialStock: number;
  lowStockThreshold: number;
  createdAt: string;
}

export interface StockMovement {
  id: string;
  productId: string;
  type: MovementType;
  /** Entrée positive, sortie négative, ajustement signé. */
  quantity: number;
  reason: string;
  reference: string;
  occurredAt: string;
  createdAt: string;
}

export const PRODUCT_KINDS: readonly { value: ProductKind; label: string }[] = [
  { value: 'produit', label: 'Produit physique' },
  { value: 'service', label: 'Service' },
  { value: 'numerique', label: 'Produit numérique' },
];

export const MOVEMENT_TYPES: readonly { value: MovementType; label: string }[] = [
  { value: 'entree', label: 'Entrée' },
  { value: 'sortie', label: 'Sortie' },
  { value: 'ajustement', label: 'Ajustement' },
];

export const CATALOG_CATEGORIES = {
  products: 'bg_module_catalog_products',
  movements: 'bg_module_stock_movements',
} as const;

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function optionalNumber(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\s*-?\d+(?:[.,]\d+)?\s*$/.test(value))) return null;
  const parsed = typeof value === 'number' ? value : Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && Math.abs(parsed) <= 1_000_000_000_000 ? parsed : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function productFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): Product {
  const data = record.data ?? {};
  return {
    id: record.id,
    name: str(data.name, 200) || 'Produit sans nom',
    sku: str(data.sku, 60),
    category: str(data.category, 100),
    kind: oneOf<ProductKind>(data.kind, ['produit', 'service', 'numerique'], 'produit'),
    description: str(data.description, 2000),
    price: optionalNumber(data.price),
    cost: optionalNumber(data.cost),
    unit: str(data.unit, 20) || 'unité',
    active: data.active !== false,
    // Un service ou un produit numérique ne peut pas porter un stock physique,
    // même si un ancien enregistrement prétend le contraire.
    trackStock: data.trackStock === true && oneOf<ProductKind>(data.kind, ['produit', 'service', 'numerique'], 'produit') === 'produit',
    initialStock: optionalNumber(data.initialStock) ?? 0,
    lowStockThreshold: Math.max(0, optionalNumber(data.lowStockThreshold) ?? 0),
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

export function productToData(product: Product): Record<string, unknown> {
  return {
    name: product.name, sku: product.sku, category: product.category, kind: product.kind,
    description: product.description, price: product.price, cost: product.cost, unit: product.unit,
    active: product.active, trackStock: product.trackStock, initialStock: product.initialStock,
    lowStockThreshold: product.lowStockThreshold,
  };
}

export function movementFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): StockMovement {
  const data = record.data ?? {};
  const type = oneOf<MovementType>(data.type, ['entree', 'sortie', 'ajustement'], 'entree');
  const raw = optionalNumber(data.quantity) ?? 0;
  const signed = type === 'sortie' ? -Math.abs(raw) : type === 'entree' ? Math.abs(raw) : raw;
  return {
    id: record.id,
    productId: str(data.productId, 64),
    type,
    quantity: signed,
    reason: str(data.reason, 300),
    reference: str(data.reference, 120),
    occurredAt: dateOnly(data.occurredAt) || (record.created_at ?? '').slice(0, 10),
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

export function movementToData(movement: StockMovement): Record<string, unknown> {
  return {
    productId: movement.productId, type: movement.type, quantity: movement.quantity,
    reason: movement.reason, reference: movement.reference, occurredAt: movement.occurredAt,
  };
}

export function stockOf(product: Product, movements: readonly StockMovement[]): number {
  if (!product.trackStock) return 0;
  const total = movements
    .filter((movement) => movement.productId === product.id)
    .reduce((sum, movement) => sum + movement.quantity, 0);
  return Math.round((product.initialStock + total) * 1000) / 1000;
}

export type StockLevel = 'rupture' | 'faible' | 'ok' | 'non_suivi';

export function stockLevel(product: Product, stock: number): StockLevel {
  if (!product.trackStock) return 'non_suivi';
  if (stock <= 0) return 'rupture';
  if (stock <= product.lowStockThreshold) return 'faible';
  return 'ok';
}

export const STOCK_LEVEL_LABELS: Record<StockLevel, string> = {
  rupture: 'Rupture', faible: 'Stock faible', ok: 'Disponible', non_suivi: 'Non suivi',
};

export function validateMovement(product: Product, movement: Pick<StockMovement, 'type' | 'quantity'>, currentStock: number): string[] {
  const errors: string[] = [];
  if (!product.trackStock) errors.push('Ce produit ne suit pas de stock.');
  if (!Number.isFinite(movement.quantity) || movement.quantity === 0) errors.push('La quantité doit être différente de zéro.');
  if (movement.type === 'sortie' && Math.abs(movement.quantity) > currentStock) {
    errors.push(`Stock insuffisant : ${currentStock} ${product.unit} disponible(s).`);
  }
  if (movement.type !== 'sortie' && movement.quantity < 0) errors.push('Une entrée ou un ajustement positif attend une quantité positive.');
  return errors;
}

export function stockValue(products: readonly Product[], movements: readonly StockMovement[]): number {
  return products.reduce((sum, product) => {
    if (!product.trackStock) return sum;
    const stock = stockOf(product, movements);
    return sum + Math.max(0, stock) * (product.cost ?? 0);
  }, 0);
}

export interface CatalogSummary {
  totalProducts: number;
  activeProducts: number;
  services: number;
  lowStock: number;
  outOfStock: number;
  inventoryValue: number | null;
}

export function computeCatalogSummary(products: readonly Product[], movements: readonly StockMovement[]): CatalogSummary {
  const tracked = products.filter((product) => product.active && product.trackStock);
  const levels = tracked.map((product) => stockLevel(product, stockOf(product, movements)));
  const costsKnown = products.filter((product) => product.trackStock).every((product) => product.cost !== null);
  return {
    totalProducts: products.length,
    activeProducts: products.filter((product) => product.active).length,
    services: products.filter((product) => product.kind === 'service').length,
    lowStock: levels.filter((level) => level === 'faible').length,
    outOfStock: levels.filter((level) => level === 'rupture').length,
    inventoryValue: costsKnown ? Math.round(stockValue(products, movements)) : null,
  };
}

export function movementIsStockOut(movement: StockMovement): boolean {
  return movement.type === 'sortie';
}

export function movementsToCsv(products: readonly Product[], movements: readonly StockMovement[]): string {
  const names = new Map(products.map((product) => [product.id, product.name]));
  const esc = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['Date', 'Produit', 'Type', 'Quantité', 'Motif', 'Référence'];
  return [header.join(','), ...movements.map((movement) => [
    movement.occurredAt, names.get(movement.productId) ?? movement.productId, movement.type,
    movement.quantity, movement.reason, movement.reference,
  ].map(esc).join(','))].join('\r\n');
}

export function productsToCsv(products: readonly Product[], movements: readonly StockMovement[]): string {
  const esc = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['Nom', 'SKU', 'Catégorie', 'Type', 'Prix', 'Coût', 'Unité', 'Actif', 'Stock suivi', 'Stock initial', 'Stock disponible', 'Seuil'];
  return [header.join(','), ...products.map((product) => [
    product.name, product.sku, product.category, product.kind, product.price ?? '', product.cost ?? '',
    product.unit, product.active ? 'oui' : 'non', product.trackStock ? 'oui' : 'non', product.initialStock,
    product.trackStock ? stockOf(product, movements) : '', product.lowStockThreshold,
  ].map(esc).join(','))].join('\r\n');
}

/* ------------------------------- Import CSV ------------------------------- */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',' || char === ';' || char === '\t') { row.push(field); field = ''; }
    else if (char === '\n') {
      row.push(field); field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else if (char !== '\r') field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

export type ProductCsvField =
  | 'name' | 'sku' | 'category' | 'kind' | 'description' | 'price' | 'cost'
  | 'unit' | 'active' | 'trackStock' | 'initialStock' | 'lowStockThreshold' | 'ignore';

const HEADER_ALIASES: readonly { key: ProductCsvField; aliases: readonly string[] }[] = [
  { key: 'name', aliases: ['nom', 'produit', 'name', 'libelle', 'désignation', 'designation'] },
  { key: 'sku', aliases: ['sku', 'reference', 'référence', 'code'] },
  { key: 'category', aliases: ['categorie', 'catégorie', 'category', 'famille'] },
  { key: 'kind', aliases: ['type', 'kind', 'nature'] },
  { key: 'description', aliases: ['description', 'details', 'détails'] },
  { key: 'price', aliases: ['prix', 'prix de vente', 'price', 'tarif', 'montant'] },
  { key: 'cost', aliases: ['cout', 'coût', 'prix achat', "prix d'achat", 'cost'] },
  { key: 'unit', aliases: ['unite', 'unité', 'unit', 'uom'] },
  { key: 'active', aliases: ['actif', 'active', 'statut'] },
  { key: 'trackStock', aliases: ['stock suivi', 'suivi stock', 'track stock', 'gestion stock'] },
  { key: 'initialStock', aliases: ['stock initial', 'stock', 'quantite', 'quantité'] },
  { key: 'lowStockThreshold', aliases: ['seuil', 'seuil alerte', 'stock faible', 'low stock'] },
];

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function guessProductMapping(headers: readonly string[]): Record<number, ProductCsvField> {
  return Object.fromEntries(headers.map((header, index) => {
    const normalized = normalize(header);
    const match = HEADER_ALIASES.find((entry) => entry.aliases.some((alias) => normalize(alias) === normalized));
    return [index, match?.key ?? 'ignore'];
  }));
}

function boolean(value: string, fallback: boolean): boolean {
  const normalized = normalize(value);
  if (['oui', 'yes', 'true', '1', 'actif'].includes(normalized)) return true;
  if (['non', 'no', 'false', '0', 'inactif'].includes(normalized)) return false;
  return fallback;
}

export interface ProductImportResult {
  row: number;
  data: Record<string, unknown> | null;
  errors: string[];
}

export function buildProductsFromRows(rows: readonly string[][], mapping: Record<number, ProductCsvField>): ProductImportResult[] {
  return rows.map((cells, index) => {
    const errors: string[] = [];
    const data: Record<string, unknown> = { kind: 'produit', active: true, trackStock: false, unit: 'unité', initialStock: 0, lowStockThreshold: 0 };
    cells.forEach((cell, column) => {
      const key = mapping[column];
      const value = cell.trim();
      if (!key || key === 'ignore' || !value) return;
      if (key === 'price' || key === 'cost' || key === 'initialStock' || key === 'lowStockThreshold') {
        const parsed = optionalNumber(value);
        if (parsed === null || parsed < 0) errors.push(`Valeur numérique invalide pour ${key}`);
        else data[key] = parsed;
        return;
      }
      if (key === 'active') { data.active = boolean(value, true); return; }
      if (key === 'trackStock') { data.trackStock = boolean(value, false); return; }
      if (key === 'kind') {
        const normalized = normalize(value);
        data.kind = normalized.includes('service') ? 'service' : normalized.includes('numer') ? 'numerique' : 'produit';
        return;
      }
      data[key] = value.slice(0, key === 'description' ? 2000 : 200);
    });
    if (!data.name) errors.push('Nom du produit manquant');
    if (data.trackStock === true && data.kind !== 'produit') data.trackStock = false;
    return errors.length ? { row: index + 2, data: null, errors } : { row: index + 2, data, errors: [] };
  });
}

/** Lien commande → stock : une sortie par ligne, jamais deux fois la même. */
export function orderStockDedupeKey(orderId: string, lineId: string): string {
  return `order:${orderId}:line:${lineId}`;
}

export function defaultStockDate(): string {
  return todayIso();
}
