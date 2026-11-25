/**
 * SORAHNEX Growth OS — Lot K : vitrine commerciale.
 *
 * Fondations honnêtes : le catalogue peut être configuré, prévisualisé, exporté
 * en HTML autonome et partagé. Les demandes de commande sont saisies ou
 * importées et converties explicitement en prospect CRM. Aucun paiement en ligne
 * n'est simulé et aucune URL publique n'est annoncée sans backend public.
 */

import { dateOnly, todayIso, phonesMatch } from '../crm/model';
import type { Product } from '../catalog/model';

export type StorefrontRequestStatus = 'nouveau' | 'traite' | 'converti' | 'annule';

export interface StorefrontSettings {
  id: string;
  slug: string;
  headline: string;
  description: string;
  contactEmail: string;
  contactPhone: string;
  visibleProductIds: string[];
  published: boolean;
  updatedAt: string;
}

export interface StorefrontRequestLine {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number | null;
}

export interface StorefrontRequest {
  id: string;
  customerName: string;
  phone: string;
  email: string;
  message: string;
  lines: StorefrontRequestLine[];
  status: StorefrontRequestStatus;
  requestedAt: string;
  contactId: string;
  orderId: string;
  createdAt: string;
}

export const STOREFRONT_REQUEST_STATUSES: readonly { value: StorefrontRequestStatus; label: string }[] = [
  { value: 'nouveau', label: 'Nouvelle' },
  { value: 'traite', label: 'Traitée' },
  { value: 'converti', label: 'Convertie en prospect' },
  { value: 'annule', label: 'Annulée' },
];

export const STOREFRONT_CATEGORIES = {
  settings: 'bg_module_storefront_settings',
  requests: 'bg_module_storefront_requests',
} as const;

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function slugify(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function settingsFromRecord(record: { id: string; data: Record<string, unknown>; updated_at?: string }): StorefrontSettings {
  const data = record.data ?? {};
  return {
    id: record.id,
    slug: str(data.slug, 60) || 'ma-boutique',
    headline: str(data.headline, 160) || 'Notre catalogue',
    description: str(data.description, 1000),
    contactEmail: str(data.contactEmail, 200).toLowerCase(),
    contactPhone: str(data.contactPhone, 60),
    visibleProductIds: Array.isArray(data.visibleProductIds) ? data.visibleProductIds.filter((id): id is string => typeof id === 'string').slice(0, 500) : [],
    published: data.published === true,
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : '',
  };
}

export function settingsToData(settings: StorefrontSettings): Record<string, unknown> {
  return {
    slug: settings.slug, headline: settings.headline, description: settings.description,
    contactEmail: settings.contactEmail, contactPhone: settings.contactPhone,
    visibleProductIds: settings.visibleProductIds, published: settings.published,
  };
}

export function requestFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): StorefrontRequest {
  const data = record.data ?? {};
  return {
    id: record.id,
    customerName: str(data.customerName, 160) || 'Client sans nom',
    phone: str(data.phone, 60),
    email: str(data.email, 200).toLowerCase(),
    message: str(data.message, 2000),
    lines: Array.isArray(data.lines) ? data.lines.map((raw) => {
      const line = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return {
        productId: str(line.productId, 64),
        name: str(line.name, 200) || 'Produit',
        quantity: Math.max(1, Number(line.quantity) || 1),
        unitPrice: typeof line.unitPrice === 'number' ? line.unitPrice : null,
      };
    }) : [],
    status: oneOf<StorefrontRequestStatus>(data.status, ['nouveau', 'traite', 'converti', 'annule'], 'nouveau'),
    requestedAt: dateOnly(data.requestedAt) || (record.created_at ?? '').slice(0, 10),
    contactId: str(data.contactId, 64),
    orderId: str(data.orderId, 64),
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

export function requestToData(request: StorefrontRequest): Record<string, unknown> {
  return {
    customerName: request.customerName, phone: request.phone, email: request.email,
    message: request.message, lines: request.lines, status: request.status,
    requestedAt: request.requestedAt, contactId: request.contactId, orderId: request.orderId,
  };
}

export function visibleProducts(products: readonly Product[], settings: StorefrontSettings): Product[] {
  const selected = new Set(settings.visibleProductIds);
  return products.filter((product) => product.active && (selected.size === 0 || selected.has(product.id)));
}

/**
 * Nouvelle sélection après un clic sur un produit.
 *
 * Une liste vide signifie « tous les produits actifs ». Sans cette conversion,
 * le premier clic sur un produit dans cet état enregistrait `[id]` et masquait
 * silencieusement tous les autres. On matérialise donc la sélection complète
 * avant de retirer le produit, et on revient à `[]` quand tout est visible.
 */
export function toggleVisibleSelection(
  products: readonly Product[],
  settings: Pick<StorefrontSettings, 'visibleProductIds'>,
  productId: string,
): string[] {
  const activeIds = products.filter((product) => product.active).map((product) => product.id);
  if (!activeIds.includes(productId)) return settings.visibleProductIds;
  const current = settings.visibleProductIds.length
    ? activeIds.filter((id) => settings.visibleProductIds.includes(id))
    : activeIds;
  const next = current.includes(productId)
    ? current.filter((id) => id !== productId)
    : [...current, productId];
  return next.length === activeIds.length ? [] : next;
}

export function requestTotal(request: StorefrontRequest): number | null {
  if (!request.lines.length || request.lines.some((line) => line.unitPrice === null)) return null;
  return request.lines.reduce((sum, line) => sum + (line.unitPrice ?? 0) * line.quantity, 0);
}

/** Conversion explicite en prospect : aucun doublon téléphone/e-mail. */
/**
 * Retrouve un contact déjà présent, avec la MÊME règle que la conversion :
 * téléphone normalisé (indicatifs, espaces, ponctuation) ou e-mail insensible
 * à la casse. L'interface doit utiliser cette fonction plutôt qu'une égalité
 * de chaînes, sinon un doublon détecté par le modèle n'est pas retrouvé et la
 * demande reste bloquée sans conversion ni message explicite.
 */
export function findDuplicateContact<T extends { phone: string; email: string }>(
  request: Pick<StorefrontRequest, 'phone' | 'email'>,
  existing: readonly T[],
): T | null {
  const email = request.email.trim().toLowerCase();
  return existing.find((contact) =>
    (request.phone && contact.phone && phonesMatch(contact.phone, request.phone))
    || (email && contact.email.trim().toLowerCase() === email)) ?? null;
}

export function requestToContactData(request: StorefrontRequest, existing: ReadonlyArray<{ phone: string; email: string }>) {
  const duplicate = findDuplicateContact(request, existing);
  if (duplicate) return { duplicate: true as const, data: null };
  const [firstName, ...rest] = request.customerName.split(/\s+/);
  return {
    duplicate: false as const,
    data: {
      firstName: firstName ?? '',
      lastName: rest.join(' '),
      company: '',
      phone: request.phone,
      whatsapp: request.phone,
      email: request.email,
      source: 'boutique',
      type: 'prospect',
      status: 'actif',
      notes: `Demande boutique du ${request.requestedAt}\n${request.lines.map((line) => `- ${line.quantity} × ${line.name}`).join('\n')}${request.message ? `\n${request.message}` : ''}`,
      lastContactAt: todayIso(),
      nextAction: 'Traiter la demande boutique',
    },
  };
}

export function requestToOrderLines(request: StorefrontRequest) {
  return request.lines.map((line, index) => ({
    id: `storefront-${request.id}-${index}`,
    productId: line.productId,
    description: line.name,
    quantity: line.quantity,
    unitPrice: line.unitPrice ?? 0,
    discountPct: 0,
    taxPct: 0,
  }));
}

/** Catalogue HTML autonome : partageable, sans paiement ni dépendance serveur. */
export function catalogHtml(settings: StorefrontSettings, products: readonly Product[], workspaceName: string): string {
  const escape = (value: string) => value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char));
  const cards = products.filter((product) => product.active).map((product) => `<article><h2>${escape(product.name)}</h2><p>${escape(product.description || '')}</p><p class="price">${product.price === null ? 'Prix sur demande' : `${product.price.toLocaleString('fr-FR')} XOF`}</p></article>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(settings.headline)} — ${escape(workspaceName)}</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#faf8f5;color:#161616}header{padding:48px 24px;background:#111;color:#fff}main{max-width:980px;margin:0 auto;padding:32px 24px;display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}article{background:#fff;border:1px solid #e8e2d8;border-radius:16px;padding:20px}h1,h2{margin:0 0 8px}.price{font-weight:700;color:#7c3aed}footer{padding:24px;text-align:center;color:#666;font-size:13px}</style></head><body><header><h1>${escape(settings.headline)}</h1><p>${escape(settings.description)}</p></header><main>${cards || '<p>Aucun produit publié.</p>'}</main><footer>${escape(workspaceName)} · ${escape(settings.contactPhone)} · ${escape(settings.contactEmail)}<br>Catalogue informatif — aucune commande ni paiement en ligne.</footer></body></html>`;
}

export interface StorefrontSummary {
  visibleProducts: number;
  requests: number;
  newRequests: number;
  convertedRequests: number;
  potentialValue: number | null;
}

export function computeStorefrontSummary(products: readonly Product[], settings: StorefrontSettings | null, requests: readonly StorefrontRequest[]): StorefrontSummary {
  const visible = settings ? visibleProducts(products, settings) : [];
  const totals = requests.map(requestTotal);
  return {
    visibleProducts: visible.length,
    requests: requests.length,
    newRequests: requests.filter((request) => request.status === 'nouveau').length,
    convertedRequests: requests.filter((request) => request.status === 'converti').length,
    potentialValue: totals.length && totals.every((value) => value !== null) ? totals.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null,
  };
}
