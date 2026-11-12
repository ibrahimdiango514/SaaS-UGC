export function formatDate(value: string | null | undefined, withTime = false): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

export function relativeDate(value: string | null | undefined): string {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  return formatDate(value);
}

export function formatMoney(minor: number, currency = 'XOF'): string {
  const amount = minor / 100;
  if (amount === 0) return 'Sur devis';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Brouillon', queued: 'En file', reserved: 'Réservé', generating: 'En cours',
  processing: 'En cours', completed: 'Terminé', succeeded: 'Réussi', failed: 'Échoué',
  cancelled: 'Annulé', archived: 'Archivé', approved: 'Approuvé', superseded: 'Remplacé',
  active: 'Actif', inactive: 'Inactif', suspended: 'Suspendu', pending: 'En attente',
  pending_payment: 'Paiement en attente', paid: 'Payé', ready: 'Prêt',
  todo: 'À effectuer', confirmed: 'Confirmé', refunded: 'Remboursé',
};

export const STATUS_TONES: Record<string, string> = {
  draft: 'neutral', archived: 'neutral', superseded: 'neutral', inactive: 'neutral',
  queued: 'warning', reserved: 'warning', generating: 'info', processing: 'info', pending: 'warning',
  pending_payment: 'warning', completed: 'success', succeeded: 'success', approved: 'success',
  paid: 'success', active: 'success', ready: 'success',
  failed: 'danger', cancelled: 'danger', suspended: 'danger',
  todo: 'neutral', confirmed: 'success', refunded: 'neutral',
};

/** Opérations du grand livre de crédits, en clair. */
export const LEDGER_OPERATION_LABELS: Record<string, string> = {
  recharge: 'Achat de crédits', purchase: 'Achat de crédits', topup: 'Achat de crédits',
  refund: 'Remboursement', reserve: 'Réservation', release: 'Restitution', capture: 'Consommation',
  consume: 'Consommation', signup_bonus: 'Crédits de bienvenue', bonus: 'Crédits offerts',
  promo: 'Code promotionnel', admin_adjustment: 'Ajustement', adjustment: 'Ajustement',
  monthly_grant: 'Dotation mensuelle', expiration: 'Expiration',
};

export function ledgerOperationLabel(type: string | null | undefined): string {
  return LEDGER_OPERATION_LABELS[type ?? ''] ?? type ?? '—';
}

export function statusLabel(status: string | null | undefined): string {
  return STATUS_LABELS[status ?? ''] ?? status ?? '—';
}

export function statusTone(status: string | null | undefined): string {
  return STATUS_TONES[status ?? ''] ?? 'neutral';
}

export function truncate(text: string | null | undefined, max = 120): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

export function initials(name: string | null | undefined, email?: string | null): string {
  const source = name?.trim() || email?.split('@')[0] || 'R';
  return source.slice(0, 2).toUpperCase();
}

export function extractVariables(template: string): string[] {
  const matches = template.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g);
  return Array.from(new Set(Array.from(matches, (m) => m[1])));
}

export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, key: string) => values[key] ?? `{{${key}}}`);
}
