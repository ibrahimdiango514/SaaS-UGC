/**
 * SORAHNEX Growth OS — Lot H : intelligence et automatisations.
 *
 * Aucune IA n'est simulée : les signaux sont des règles déterministes sur des
 * données réelles. Une automatisation propose une action ; seule une action
 * confirmée par l'utilisateur est exécutée (création de tâche, préparation de
 * message). Les exécutions sont journalisées et dédupliquées par élément.
 */

import { daysBetween, todayIso } from '../crm/model';
import type { ActionItem } from '../crm/model';

export type AutomationTrigger =
  | 'tache_retard' | 'opportunite_stagnante' | 'creance_retard' | 'promesse_non_respectee'
  | 'devis_sans_suivi' | 'facture_retard' | 'stock_faible' | 'depense_inhabituelle';
export type AutomationAction = 'creer_tache' | 'preparer_relance' | 'notifier';
export type RunStatus = 'propose' | 'confirme' | 'ignore';

export interface AutomationRule {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  /** Seuil en jours pour les déclencheurs datés. */
  thresholdDays: number;
  action: AutomationAction;
  channel: 'whatsapp' | 'email' | 'sms' | 'appel';
  enabled: boolean;
  lastRunAt: string;
  createdAt: string;
}

export interface AutomationRun {
  id: string;
  ruleId: string;
  itemKey: string;
  label: string;
  detail: string;
  contactId: string;
  status: RunStatus;
  createdAt: string;
}

export const AUTOMATION_TRIGGERS: readonly { value: AutomationTrigger; label: string; description: string }[] = [
  { value: 'tache_retard', label: 'Tâche en retard', description: 'Une tâche commerciale non terminée a dépassé son échéance.' },
  { value: 'opportunite_stagnante', label: 'Opportunité stagnante', description: 'Une opportunité ouverte n’a pas bougé depuis N jours.' },
  { value: 'creance_retard', label: 'Créance en retard', description: 'Une créance ouverte a dépassé son échéance.' },
  { value: 'promesse_non_respectee', label: 'Promesse non respectée', description: 'Une promesse de paiement arrive à échéance sans règlement.' },
  { value: 'devis_sans_suivi', label: 'Devis sans suivi', description: 'Un devis envoyé n’a pas changé de statut depuis N jours.' },
  { value: 'facture_retard', label: 'Facture en retard', description: 'Une facture non soldée a dépassé son échéance.' },
  { value: 'stock_faible', label: 'Stock faible', description: 'Un produit suivi est au niveau ou sous son seuil d’alerte.' },
  { value: 'depense_inhabituelle', label: 'Dépense inhabituelle', description: 'Une dépense dépasse nettement la médiane de sa catégorie.' },
];

export const AUTOMATION_ACTIONS: readonly { value: AutomationAction; label: string }[] = [
  { value: 'creer_tache', label: 'Créer une tâche commerciale' },
  { value: 'preparer_relance', label: 'Préparer une relance' },
  { value: 'notifier', label: 'Signaler dans le centre d’action' },
];

export const AUTOMATION_CATEGORIES = {
  rules: 'bg_module_automation_rules',
  runs: 'bg_module_automation_runs',
} as const;

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function ruleFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): AutomationRule {
  const data = record.data ?? {};
  return {
    id: record.id,
    name: str(data.name, 160) || 'Automatisation sans nom',
    trigger: oneOf<AutomationTrigger>(data.trigger, AUTOMATION_TRIGGERS.map((entry) => entry.value), 'tache_retard'),
    thresholdDays: Math.max(0, Math.min(365, Number(data.thresholdDays) || 0)),
    action: oneOf<AutomationAction>(data.action, ['creer_tache', 'preparer_relance', 'notifier'], 'creer_tache'),
    channel: oneOf(data.channel, ['whatsapp', 'email', 'sms', 'appel'] as const, 'whatsapp'),
    enabled: data.enabled !== false,
    lastRunAt: str(data.lastRunAt, 40),
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

export function ruleToData(rule: AutomationRule): Record<string, unknown> {
  return {
    name: rule.name, trigger: rule.trigger, thresholdDays: rule.thresholdDays,
    action: rule.action, channel: rule.channel, enabled: rule.enabled, lastRunAt: rule.lastRunAt,
  };
}

export function runFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): AutomationRun {
  const data = record.data ?? {};
  return {
    id: record.id,
    ruleId: str(data.ruleId, 64),
    itemKey: str(data.itemKey, 200),
    label: str(data.label, 240),
    detail: str(data.detail, 500),
    contactId: str(data.contactId, 64),
    status: oneOf<RunStatus>(data.status, ['propose', 'confirme', 'ignore'], 'propose'),
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

export function runToData(run: AutomationRun): Record<string, unknown> {
  return {
    ruleId: run.ruleId, itemKey: run.itemKey, label: run.label,
    detail: run.detail, contactId: run.contactId, status: run.status,
  };
}

/** Données minimales, volontairement indépendantes des composants React. */
export interface AutomationDataset {
  contacts: ReadonlyArray<{ id: string; name: string; type: string; lastContactAt: string }>;
  opportunities: ReadonlyArray<{ id: string; title: string; contactId: string; stage: string; updatedAt: string; amount: number | null }>;
  tasks: ReadonlyArray<{ id: string; title: string; contactId: string; dueDate: string; status: string }>;
  receivables: ReadonlyArray<{ id: string; reference: string; contactId: string; dueDate: string; balance: number; status: string }>;
  promises: ReadonlyArray<{ id: string; contactId: string; amount: number | null; promisedAt: string; status: string }>;
  quotes: ReadonlyArray<{ id: string; number: string; contactId: string; status: string; issuedAt: string }>;
  invoices: ReadonlyArray<{ id: string; number: string; contactId: string; dueDate: string; balance: number; effectiveStatus: string }>;
  products: ReadonlyArray<{ id: string; name: string; stock: number; threshold: number; trackStock: boolean }>;
  unusualExpenses: ReadonlyArray<{ id: string; label: string; reason: string }>;
  actionItems?: readonly ActionItem[];
  today?: string;
}

export interface AutomationSignal {
  itemKey: string;
  label: string;
  detail: string;
  contactId: string;
  trigger: AutomationTrigger;
}

export function buildSignals(trigger: AutomationTrigger, dataset: AutomationDataset, thresholdDays = 0): AutomationSignal[] {
  const today = dataset.today ?? todayIso();
  const signals: AutomationSignal[] = [];
  const threshold = Math.max(0, thresholdDays);
  if (trigger === 'tache_retard') {
    for (const task of dataset.tasks) {
      if (task.status !== 'a_faire') continue;
      const days = daysBetween(task.dueDate, today);
      if (days === null || days <= threshold) continue;
      signals.push({ itemKey: `task:${task.id}`, label: task.title || 'Tâche en retard', detail: `${days} jour(s) de retard`, contactId: task.contactId, trigger });
    }
  }
  if (trigger === 'opportunite_stagnante') {
    for (const opportunity of dataset.opportunities) {
      if (opportunity.stage === 'gagne' || opportunity.stage === 'perdu') continue;
      const days = daysBetween(opportunity.updatedAt.slice(0, 10), today);
      if (days === null || days <= threshold) continue;
      signals.push({ itemKey: `opp:${opportunity.id}`, label: `Opportunité stagnante : ${opportunity.title}`, detail: `${days} jours sans mise à jour`, contactId: opportunity.contactId, trigger });
    }
  }
  if (trigger === 'creance_retard') {
    for (const receivable of dataset.receivables) {
      if (receivable.status === 'payee' || receivable.status === 'annulee' || receivable.balance <= 0) continue;
      const days = daysBetween(receivable.dueDate, today);
      if (days === null || days <= threshold) continue;
      signals.push({ itemKey: `recv:${receivable.id}`, label: `Créance en retard : ${receivable.reference}`, detail: `${days} jours de retard · solde ${receivable.balance}`, contactId: receivable.contactId, trigger });
    }
  }
  if (trigger === 'promesse_non_respectee') {
    for (const promise of dataset.promises) {
      if (promise.status !== 'a_venir') continue;
      const days = daysBetween(promise.promisedAt, today);
      if (days === null || days <= threshold) continue;
      signals.push({ itemKey: `promise:${promise.id}`, label: 'Promesse de paiement non respectée', detail: `Promise le ${promise.promisedAt}${promise.amount ? ` · ${promise.amount}` : ''}`, contactId: promise.contactId, trigger });
    }
  }
  if (trigger === 'devis_sans_suivi') {
    for (const quote of dataset.quotes) {
      if (quote.status !== 'envoye') continue;
      const days = daysBetween(quote.issuedAt, today);
      if (days === null || days <= threshold) continue;
      signals.push({ itemKey: `quote:${quote.id}`, label: `Devis sans suivi : ${quote.number}`, detail: `${days} jours depuis l’envoi`, contactId: quote.contactId, trigger });
    }
  }
  if (trigger === 'facture_retard') {
    for (const invoice of dataset.invoices) {
      if (invoice.effectiveStatus === 'payee' || invoice.effectiveStatus === 'annulee' || invoice.balance <= 0) continue;
      const days = daysBetween(invoice.dueDate, today);
      if (days === null || days <= threshold) continue;
      signals.push({ itemKey: `invoice:${invoice.id}`, label: `Facture en retard : ${invoice.number}`, detail: `${days} jours de retard · solde ${invoice.balance}`, contactId: invoice.contactId, trigger });
    }
  }
  if (trigger === 'stock_faible') {
    for (const product of dataset.products) {
      if (!product.trackStock || product.stock > product.threshold) continue;
      signals.push({ itemKey: `product:${product.id}`, label: `Stock faible : ${product.name}`, detail: `${product.stock} restant(s), seuil ${product.threshold}`, contactId: '', trigger });
    }
  }
  if (trigger === 'depense_inhabituelle') {
    for (const expense of dataset.unusualExpenses) {
      signals.push({ itemKey: `expense:${expense.id}`, label: `Dépense inhabituelle : ${expense.label}`, detail: expense.reason, contactId: '', trigger });
    }
  }
  return signals;
}

/** Une exécution n'est proposée qu'une fois par couple règle + élément. */
export function pendingRuns(rule: AutomationRule, signals: readonly AutomationSignal[], runs: readonly AutomationRun[]): AutomationSignal[] {
  if (!rule.enabled) return [];
  const known = new Set(runs.filter((run) => run.ruleId === rule.id).map((run) => run.itemKey));
  return signals.filter((signal) => !known.has(signal.itemKey));
}

export function automationDedupeKey(ruleId: string, itemKey: string): string {
  return `${ruleId}:${itemKey}`;
}

export function buildTaskFromRun(rule: AutomationRule, signal: AutomationSignal, today = todayIso()) {
  return {
    title: signal.label.slice(0, 200),
    type: rule.channel === 'appel' ? 'appel' : rule.channel === 'email' ? 'email' : rule.channel === 'sms' ? 'relance' : 'whatsapp',
    contactId: signal.contactId,
    opportunityId: '',
    owner: '',
    priority: rule.trigger === 'creance_retard' || rule.trigger === 'facture_retard' ? 'urgente' : 'elevee',
    dueDate: today,
    dueTime: '',
    status: 'a_faire',
    notes: `${signal.detail}\nAutomatisation : ${rule.name}`,
    outcome: '',
    nextAction: '',
    nextActionAt: '',
    completedAt: '',
  };
}

export function messageFromSignal(signal: AutomationSignal, contactName: string): string {
  return `Bonjour ${contactName || 'Madame, Monsieur'}, nous revenons vers vous au sujet de : ${signal.label.toLowerCase()}. ${signal.detail}. Pouvez-vous nous indiquer la suite à donner ?`;
}

export interface AutomationAudit {
  proposed: number;
  confirmed: number;
  ignored: number;
  enabledRules: number;
  lastRunAt: string;
}

export function automationAudit(rules: readonly AutomationRule[], runs: readonly AutomationRun[]): AutomationAudit {
  return {
    proposed: runs.filter((run) => run.status === 'propose').length,
    confirmed: runs.filter((run) => run.status === 'confirme').length,
    ignored: runs.filter((run) => run.status === 'ignore').length,
    enabledRules: rules.filter((rule) => rule.enabled).length,
    lastRunAt: runs.map((run) => run.createdAt).sort().at(-1) ?? '',
  };
}
