import {
  Bot, CheckSquare, CreditCard, LifeBuoy, Megaphone, MessageSquare, Package,
  Plug, Radar, ShoppingCart, Shield, Truck, Users, Wallet, Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/* -------------------------------------------------------------------------- */
/* Contrats des modules métier Business Growth                                */
/* -------------------------------------------------------------------------- */

export type ModuleFieldType = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'email' | 'tel' | 'url';
export type ModuleTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface ModuleOption {
  value: string;
  label: string;
}

export interface ModuleField {
  key: string;
  label: string;
  type: ModuleFieldType;
  required?: boolean;
  options?: readonly ModuleOption[];
  placeholder?: string;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  full?: boolean;
  inList?: boolean;
  suffix?: string;
}

export interface ModuleStatus extends ModuleOption {
  tone: ModuleTone;
}

export interface ModuleQuickAction {
  id: string;
  label: string;
  tone?: 'neutral' | 'success' | 'warning';
  patch: (data: Record<string, unknown>) => Record<string, unknown>;
}

export interface ModuleKpi {
  label: string;
  hint?: string;
  compute: (records: ModuleRecord[]) => string;
}

export type ModuleGroupId = 'revenue' | 'intelligence' | 'operations' | 'protection';

export interface ModuleDefinition {
  key: string;
  category: string;
  title: string;
  shortTitle: string;
  description: string;
  purpose: string;
  group: ModuleGroupId;
  icon: LucideIcon;
  accent: 'cyan' | 'violet' | 'amber' | 'emerald' | 'rose';
  fields: readonly ModuleField[];
  statuses: readonly ModuleStatus[];
  openStatuses: readonly string[];
  primaryField: string;
  valueField?: string;
  dateField?: string;
  kpis: readonly ModuleKpi[];
  quickActions?: readonly ModuleQuickAction[];
  emptyTitle: string;
  emptyDescription: string;
  agentPrompt: string;
}

export interface ModuleRecord {
  id: string;
  category: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const MODULE_GROUPS: readonly { id: ModuleGroupId; label: string; description: string }[] = [
  { id: 'revenue', label: 'Récupérer les revenus', description: 'Relances, encaissements et commandes à ne pas perdre.' },
  { id: 'intelligence', label: 'Intelligence commerciale', description: 'Visibilité, stock et lecture financière de l’activité.' },
  { id: 'operations', label: 'Opérations', description: 'Exécution quotidienne, support et approvisionnement.' },
  { id: 'protection', label: 'Protection des revenus', description: 'Litiges et fuites de revenus détectées puis traitées.' },
];

export const FOUNDATION_MODULES = [
  {
    key: 'ai-agent',
    title: 'AI Business Agent',
    description: 'Conversation contextualisée, mémoire consentie et propositions d’actions à valider.',
    to: '/app/business',
    icon: Bot,
    status: 'Opérationnel',
  },
  {
    key: 'integrations-hub',
    title: 'Integrations Hub',
    description: 'Six connecteurs préparés, états honnêtes et lecture des données autorisées.',
    to: '/app/business?section=integrations',
    icon: Plug,
    status: 'Fondations',
  },
  {
    key: 'smart-crm',
    title: 'Smart CRM',
    description: 'Prospects, étapes, relances et valeur du pipeline, déjà reliés à votre mémoire métier.',
    to: '/app/business?section=growth&growthTab=crm',
    icon: Users,
    status: 'Opérationnel',
  },
] as const;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function moduleKeyToCategory(key: string): string {
  return `bg_module_${key.replace(/-/g, '_')}`;
}

export function isModuleKey(value: string | undefined): boolean {
  return Boolean(value && MODULE_DEFINITIONS.some((module) => module.key === value));
}

export function getModuleDefinition(key: string | undefined): ModuleDefinition | undefined {
  return MODULE_DEFINITIONS.find((module) => module.key === key);
}

export function statusOf(module: ModuleDefinition, value: unknown): ModuleStatus {
  const status = module.statuses.find((item) => item.value === value);
  return status ?? module.statuses[0];
}

export function fieldOf(module: ModuleDefinition, key: string): ModuleField | undefined {
  return module.fields.find((field) => field.key === key);
}

export function numberFrom(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A missing or invalid measurement is not the number zero. */
export function measuredNumber(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000_000_000 ? parsed : null;
}

export function textFrom(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function dateFrom(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

export function daysSince(value: unknown, now = Date.now()): number | null {
  const text = dateFrom(value);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== text) return null;
  const today = new Date(now).toISOString().slice(0, 10);
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - date) / 86_400_000);
}

export function formatModuleMoney(value: unknown, currency = 'XOF'): string {
  const amount = numberFrom(value);
  if (!amount) return '0 FCFA';
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount.toLocaleString('fr-FR')} FCFA`;
  }
}

export function formatModuleDate(value: unknown): string {
  const text = dateFrom(value);
  if (!text) return '—';
  const date = Date.parse(`${text}T12:00:00`);
  if (!Number.isFinite(date)) return '—';
  return new Date(date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function displayFieldValue(_module: ModuleDefinition, record: ModuleRecord, field: ModuleField): string {
  const value = record.data[field.key];
  if (field.type === 'number') {
    const numeric = measuredNumber(value);
    if (numeric === null) return '—';
    if (field.suffix === 'FCFA') return formatModuleMoney(numeric);
    return `${numeric.toLocaleString('fr-FR')}${field.suffix ? ` ${field.suffix}` : ''}`;
  }
  if (field.type === 'date') return formatModuleDate(value);
  if (field.type === 'select') return field.options?.find((option) => option.value === value)?.label ?? (textFrom(value) || '—');
  const text = textFrom(value).trim();
  return text || '—';
}

export function sumBy(records: readonly ModuleRecord[], key: string, predicate?: (record: ModuleRecord) => boolean): number {
  return records.reduce((total, record) => {
    if (predicate && !predicate(record)) return total;
    return total + numberFrom(record.data[key]);
  }, 0);
}

/** Show a total only when all relevant amounts are known; empty data isn't a financial zero. */
function knownSum(records: readonly ModuleRecord[], key: string, predicate: (record: ModuleRecord) => boolean = () => true): number | null {
  const selected = records.filter(predicate);
  if (!selected.length) return null;
  const values = selected.map((record) => measuredNumber(record.data[key]));
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}
function knownMoney(records: readonly ModuleRecord[], key: string, predicate?: (record: ModuleRecord) => boolean): string {
  const amount = knownSum(records, key, predicate);
  return amount === null ? '—' : formatModuleMoney(amount);
}
function lowStock(record: ModuleRecord): boolean {
  const stock = measuredNumber(record.data.stock), threshold = measuredNumber(record.data.threshold);
  return stock !== null && (stock === 0 || (threshold !== null && stock <= threshold));
}

export function countBy(records: readonly ModuleRecord[], predicate: (record: ModuleRecord) => boolean): number {
  return records.filter(predicate).length;
}

export function isOpen(module: ModuleDefinition, record: ModuleRecord): boolean {
  return module.openStatuses.includes(textFrom(record.data.status));
}

/* -------------------------------------------------------------------------- */
/* Champs réutilisables                                                       */
/* -------------------------------------------------------------------------- */

const NOTES: ModuleField = { key: 'notes', label: 'Notes internes', type: 'textarea', placeholder: 'Contexte, prochaine étape, informations utiles…', full: true, inList: false };

const CLIENT_SOURCE: readonly ModuleOption[] = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'site', label: 'Site web' },
  { value: 'boutique', label: 'Boutique' },
  { value: 'recommandation', label: 'Recommandation' },
  { value: 'autre', label: 'Autre' },
];

const CHANNELS: readonly ModuleOption[] = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'E-mail' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'site', label: 'Site web' },
  { value: 'telephone', label: 'Téléphone' },
];

const PRIORITIES: readonly ModuleOption[] = [
  { value: 'basse', label: 'Basse' },
  { value: 'moyenne', label: 'Moyenne' },
  { value: 'haute', label: 'Haute' },
];

/* -------------------------------------------------------------------------- */
/* Définitions                                                                */
/* -------------------------------------------------------------------------- */

export const MODULE_DEFINITIONS: readonly ModuleDefinition[] = [
  {
    key: 'lead-rescue',
    category: moduleKeyToCategory('lead-rescue'),
    title: 'Lead Rescue',
    shortTitle: 'Leads',
    description: 'Repérez les prospects laissés sans réponse et relancez-les avant qu’ils ne disparaissent.',
    purpose: 'Chaque lead garde sa source, sa valeur estimée et sa dernière date de contact. Les relances en retard remontent en premier.',
    group: 'revenue',
    icon: LifeBuoy,
    accent: 'cyan',
    primaryField: 'name',
    valueField: 'estimatedValue',
    dateField: 'lastContactAt',
    fields: [
      { key: 'name', label: 'Prospect', type: 'text', required: true, placeholder: 'Nom du contact', inList: true },
      { key: 'company', label: 'Entreprise', type: 'text', placeholder: 'Société ou activité', inList: true },
      { key: 'source', label: 'Source', type: 'select', options: CLIENT_SOURCE },
      { key: 'estimatedValue', label: 'Valeur estimée', type: 'number', min: 0, step: 1000, suffix: 'FCFA', inList: true },
      { key: 'lastContactAt', label: 'Dernier contact', type: 'date', required: true, inList: true },
      { key: 'nextAction', label: 'Prochaine action', type: 'text', placeholder: 'Rappeler, envoyer un devis, proposer une offre…', full: true },
      NOTES,
    ],
    statuses: [
      { value: 'nouveau', label: 'Nouveau', tone: 'info' },
      { value: 'relance', label: 'Relancé', tone: 'warning' },
      { value: 'qualifie', label: 'Qualifié', tone: 'info' },
      { value: 'converti', label: 'Converti', tone: 'success' },
      { value: 'perdu', label: 'Perdu', tone: 'danger' },
    ],
    openStatuses: ['nouveau', 'relance', 'qualifie'],
    kpis: [
      { label: 'À relancer', hint: 'Sans contact depuis 3 jours', compute: (records) => String(countBy(records, (r) => isOpen(getModuleDefinition('lead-rescue')!, r) && (daysSince(r.data.lastContactAt) ?? 0) >= 3)) },
      { label: 'Valeur en jeu', hint: 'Leads encore ouverts', compute: (records) => knownMoney(records, 'estimatedValue', (r) => isOpen(getModuleDefinition('lead-rescue')!, r)) },
      { label: 'Convertis', hint: 'Sur l’ensemble des leads', compute: (records) => String(countBy(records, (r) => r.data.status === 'converti')) },
    ],
    quickActions: [
      { id: 'relance', label: 'Marquer relancé', tone: 'warning', patch: () => ({ status: 'relance', lastContactAt: todayIso() }) },
      { id: 'converti', label: 'Marquer converti', tone: 'success', patch: () => ({ status: 'converti' }) },
    ],
    emptyTitle: 'Aucun lead à sauver pour le moment',
    emptyDescription: 'Ajoutez un prospect ou branchez votre premier connecteur pour alimenter ce module.',
    agentPrompt: 'Analyse mes leads en attente et propose un ordre de relance avec un message court pour chacun.',
  },
  {
    key: 'sales-automation',
    category: moduleKeyToCategory('sales-automation'),
    title: 'Sales Automation',
    shortTitle: 'Automatisations',
    description: 'Définissez des règles de relance et générez les tâches réellement dues à partir de vos autres modules.',
    purpose: 'Une règle relie un déclencheur métier à une action. L’exécution est déclenchée manuellement et crée des tâches dans Operations Manager, sans doublon.',
    group: 'revenue',
    icon: Workflow,
    accent: 'violet',
    primaryField: 'name',
    fields: [
      { key: 'name', label: 'Nom de la règle', type: 'text', required: true, placeholder: 'Relancer les paniers abandonnés', inList: true },
      { key: 'trigger', label: 'Déclencheur', type: 'select', required: true, options: [
        { value: 'nouveau_prospect', label: 'Nouveau prospect sans contact' },
        { value: 'panier_abandonne', label: 'Panier ou commande abandonné' },
        { value: 'facture_echue', label: 'Facture échue' },
        { value: 'client_inactif', label: 'Client à risque' },
        { value: 'stock_bas', label: 'Stock bas ou rupture' },
      ], inList: true },
      { key: 'action', label: 'Action générée', type: 'select', required: true, options: [
        { value: 'tache_relance', label: 'Tâche de relance' },
        { value: 'brief_studio', label: 'Tâche de brief Studio' },
        { value: 'alerte_interne', label: 'Alerte interne' },
        { value: 'email_validation', label: 'Message à valider' },
      ], inList: true },
      { key: 'delayDays', label: 'Délai avant action', type: 'number', min: 0, max: 3650, step: 1, suffix: 'jours', help: 'En jours entiers à partir de la génération ; vide ou 0 signifie aujourd’hui.' },
      NOTES,
    ],
    statuses: [
      { value: 'actif', label: 'Active', tone: 'success' },
      { value: 'pause', label: 'En pause', tone: 'warning' },
      { value: 'brouillon', label: 'Brouillon', tone: 'neutral' },
    ],
    openStatuses: ['actif'],
    kpis: [
      { label: 'Règles actives', compute: (records) => String(countBy(records, (r) => r.data.status === 'actif')) },
      { label: 'Règles en pause', compute: (records) => String(countBy(records, (r) => r.data.status === 'pause')) },
      { label: 'Brouillons', compute: (records) => String(countBy(records, (r) => r.data.status === 'brouillon')) },
    ],
    emptyTitle: 'Aucune règle de vente',
    emptyDescription: 'Créez une règle simple : un déclencheur, une action, un délai. Vous pourrez générer les tâches en un clic.',
    agentPrompt: 'Propose trois automatisations commerciales prioritaires pour mon activité et les tâches qu’elles devraient générer.',
  },
  {
    key: 'customer-recovery',
    category: moduleKeyToCategory('customer-recovery'),
    title: 'Customer Recovery',
    shortTitle: 'Clients',
    description: 'Identifiez les clients qui s’éloignent et préparez leur réactivation avec une offre claire.',
    purpose: 'La base conserve la valeur historique du client, sa dernière commande et l’état de la relance pour prioriser les efforts.',
    group: 'revenue',
    icon: Users,
    accent: 'violet',
    primaryField: 'name',
    valueField: 'totalSpent',
    dateField: 'lastOrderAt',
    fields: [
      { key: 'name', label: 'Client', type: 'text', required: true, placeholder: 'Nom du client', inList: true },
      { key: 'contact', label: 'Contact', type: 'text', placeholder: 'Téléphone, e-mail ou @', inList: true },
      { key: 'totalSpent', label: 'Valeur historique', type: 'number', min: 0, step: 1000, suffix: 'FCFA', inList: true },
      { key: 'lastOrderAt', label: 'Dernière commande', type: 'date', required: true, inList: true },
      { key: 'offer', label: 'Offre de réactivation', type: 'text', placeholder: 'Remise, nouveauté, accompagnement…', full: true },
      NOTES,
    ],
    statuses: [
      { value: 'a_risque', label: 'À risque', tone: 'warning' },
      { value: 'contacte', label: 'Contacté', tone: 'info' },
      { value: 'reactive', label: 'Réactivé', tone: 'success' },
      { value: 'perdu', label: 'Perdu', tone: 'danger' },
    ],
    openStatuses: ['a_risque', 'contacte'],
    kpis: [
      { label: 'À risque', hint: 'Clients sans commande récente', compute: (records) => String(countBy(records, (r) => r.data.status === 'a_risque')) },
      { label: 'Valeur historique', hint: 'Dépenses passées des clients à risque, pas un revenu garanti', compute: (records) => knownMoney(records, 'totalSpent', (r) => r.data.status === 'a_risque') },
      { label: 'Réactivés', compute: (records) => String(countBy(records, (r) => r.data.status === 'reactive')) },
    ],
    quickActions: [
      { id: 'contacte', label: 'Marquer contacté', tone: 'warning', patch: () => ({ status: 'contacte' }) },
      { id: 'reactive', label: 'Marquer réactivé', tone: 'success', patch: () => ({ status: 'reactive' }) },
    ],
    emptyTitle: 'Aucun client à réactiver',
    emptyDescription: 'Ajoutez un client ou laissez les connecteurs alimenter la liste dès qu’ils seront actifs.',
    agentPrompt: 'Analyse mes clients à risque et propose une séquence de réactivation avec un message personnalisé.',
  },
  {
    key: 'payment-recovery',
    category: moduleKeyToCategory('payment-recovery'),
    title: 'Payment Recovery',
    shortTitle: 'Encaissements',
    description: 'Suivez les factures, les relances et les encaissements pour ne plus laisser d’argent dormir.',
    purpose: 'Chaque facture porte son montant, son échéance et son niveau de relance. Les impayés et retards sont calculés en temps réel.',
    group: 'revenue',
    icon: CreditCard,
    accent: 'amber',
    primaryField: 'invoiceRef',
    valueField: 'amount',
    dateField: 'dueDate',
    fields: [
      { key: 'invoiceRef', label: 'Référence facture', type: 'text', required: true, placeholder: 'FAC-2026-001', inList: true },
      { key: 'customer', label: 'Client', type: 'text', required: true, placeholder: 'Nom du client', inList: true },
      { key: 'amount', label: 'Montant', type: 'number', required: true, min: 0, step: 1000, suffix: 'FCFA', inList: true },
      { key: 'dueDate', label: 'Échéance', type: 'date', required: true, inList: true },
      { key: 'reminderLevel', label: 'Niveau de relance', type: 'number', min: 0, step: 1, help: '0 = aucune relance, 1 = rappel doux, 2 = relance ferme, 3 = mise en demeure.' },
      NOTES,
    ],
    statuses: [
      { value: 'a_echeance', label: 'À échéance', tone: 'neutral' },
      { value: 'en_retard', label: 'En retard', tone: 'danger' },
      { value: 'relance', label: 'Relancé', tone: 'warning' },
      { value: 'paye', label: 'Payé', tone: 'success' },
      { value: 'litige', label: 'En litige', tone: 'danger' },
    ],
    openStatuses: ['a_echeance', 'en_retard', 'relance', 'litige'],
    kpis: [
      { label: 'Encours', hint: 'Factures non payées', compute: (records) => knownMoney(records, 'amount', (r) => r.data.status !== 'paye') },
      { label: 'En retard', compute: (records) => knownMoney(records, 'amount', (r) => r.data.status === 'en_retard') },
      { label: 'Encaissé', compute: (records) => knownMoney(records, 'amount', (r) => r.data.status === 'paye') },
    ],
    quickActions: [
      { id: 'relance', label: 'Relancer', tone: 'warning', patch: (data) => ({ status: 'relance', reminderLevel: Math.min(3, numberFrom(data.reminderLevel) + 1) }) },
      { id: 'paye', label: 'Marquer payé', tone: 'success', patch: () => ({ status: 'paye' }) },
    ],
    emptyTitle: 'Aucune facture suivie',
    emptyDescription: 'Ajoutez une facture pour suivre son échéance, déclencher des relances et mesurer l’encours.',
    agentPrompt: 'Analyse mes factures impayées et propose un plan de relance par ordre de priorité, avec un message pour chaque client.',
  },
  {
    key: 'order-cart-recovery',
    category: moduleKeyToCategory('order-cart-recovery'),
    title: 'Order & Cart Recovery',
    shortTitle: 'Paniers',
    description: 'Repérez les paniers et commandes abandonnés, puis relancez avec le bon angle.',
    purpose: 'Le suivi distingue panier, commande, relance et récupération. La valeur ouverte indique ce qui reste à sauver.',
    group: 'revenue',
    icon: ShoppingCart,
    accent: 'cyan',
    primaryField: 'reference',
    valueField: 'amount',
    dateField: 'abandonedAt',
    fields: [
      { key: 'reference', label: 'Référence', type: 'text', required: true, placeholder: 'CMD-1042', inList: true },
      { key: 'customer', label: 'Client', type: 'text', placeholder: 'Nom ou identifiant', inList: true },
      { key: 'amount', label: 'Valeur', type: 'number', min: 0, step: 1000, suffix: 'FCFA', inList: true },
      { key: 'abandonedAt', label: 'Date d’abandon', type: 'date', required: true, inList: true },
      { key: 'channel', label: 'Canal', type: 'select', options: CLIENT_SOURCE },
      NOTES,
    ],
    statuses: [
      { value: 'panier', label: 'Panier abandonné', tone: 'warning' },
      { value: 'commande', label: 'Commande bloquée', tone: 'danger' },
      { value: 'relance', label: 'Relancé', tone: 'info' },
      { value: 'recupere', label: 'Récupéré', tone: 'success' },
      { value: 'perdu', label: 'Perdu', tone: 'danger' },
    ],
    openStatuses: ['panier', 'commande', 'relance'],
    kpis: [
      { label: 'Valeur ouverte', compute: (records) => knownMoney(records, 'amount', (r) => isOpen(getModuleDefinition('order-cart-recovery')!, r)) },
      { label: 'À relancer', compute: (records) => String(countBy(records, (r) => ['panier', 'commande'].includes(textFrom(r.data.status)))) },
      { label: 'Récupérés', compute: (records) => String(countBy(records, (r) => r.data.status === 'recupere')) },
    ],
    quickActions: [
      { id: 'relance', label: 'Marquer relancé', tone: 'warning', patch: () => ({ status: 'relance' }) },
      { id: 'recupere', label: 'Marquer récupéré', tone: 'success', patch: () => ({ status: 'recupere' }) },
    ],
    emptyTitle: 'Aucun panier abandonné',
    emptyDescription: 'Ajoutez un panier ou une commande bloquée pour préparer la relance et suivre sa récupération.',
    agentPrompt: 'Propose des messages de relance pour mes paniers abandonnés, adaptés au canal et au montant.',
  },
  {
    key: 'social-growth',
    category: moduleKeyToCategory('social-growth'),
    title: 'Social Growth',
    shortTitle: 'Social',
    description: 'Planifiez un calendrier éditorial réaliste et suivez la production jusqu’à la publication.',
    purpose: 'Aucune publication automatique n’est simulée : vous gérez les idées, la production et le statut réel de chaque contenu.',
    group: 'intelligence',
    icon: Megaphone,
    accent: 'rose',
    primaryField: 'title',
    dateField: 'scheduledAt',
    fields: [
      { key: 'title', label: 'Titre du contenu', type: 'text', required: true, placeholder: 'Série UGC “routine éclat”', inList: true },
      { key: 'channel', label: 'Canal', type: 'select', options: [
        { value: 'instagram', label: 'Instagram' }, { value: 'tiktok', label: 'TikTok' },
        { value: 'facebook', label: 'Facebook' }, { value: 'youtube', label: 'YouTube' },
        { value: 'linkedin', label: 'LinkedIn' },
      ], inList: true },
      { key: 'format', label: 'Format', type: 'select', options: [
        { value: 'reel', label: 'Reel / Short' }, { value: 'post', label: 'Post' },
        { value: 'story', label: 'Story' }, { value: 'video', label: 'Vidéo longue' },
      ], inList: true },
      { key: 'scheduledAt', label: 'Date prévue', type: 'date', inList: true },
      { key: 'hook', label: 'Accroche', type: 'text', placeholder: 'Première phrase ou angle', full: true },
      NOTES,
    ],
    statuses: [
      { value: 'idee', label: 'Idée', tone: 'neutral' },
      { value: 'a_produire', label: 'À produire', tone: 'warning' },
      { value: 'pret', label: 'Prêt', tone: 'info' },
      { value: 'publie', label: 'Publié', tone: 'success' },
    ],
    openStatuses: ['idee', 'a_produire', 'pret'],
    kpis: [
      { label: 'À produire', compute: (records) => String(countBy(records, (r) => r.data.status === 'a_produire')) },
      { label: 'Prêts', compute: (records) => String(countBy(records, (r) => r.data.status === 'pret')) },
      { label: 'Publiés', compute: (records) => String(countBy(records, (r) => r.data.status === 'publie')) },
    ],
    quickActions: [
      { id: 'pret', label: 'Marquer prêt', tone: 'warning', patch: () => ({ status: 'pret' }) },
      { id: 'publie', label: 'Marquer publié', tone: 'success', patch: () => ({ status: 'publie' }) },
    ],
    emptyTitle: 'Calendrier vide',
    emptyDescription: 'Ajoutez une première idée de contenu. Le Studio pourra ensuite produire la vidéo correspondante.',
    agentPrompt: 'Propose un calendrier de contenu sur deux semaines pour mes canaux, avec un angle et une accroche par publication.',
  },
  {
    key: 'smart-inventory',
    category: moduleKeyToCategory('smart-inventory'),
    title: 'Smart Inventory',
    shortTitle: 'Stock',
    description: 'Surveillez les seuils de stock, la valeur immobilisée et les produits à réapprovisionner.',
    purpose: 'Le stock et le seuil sont saisis par produit. Les alertes se calculent à partir de vos quantités réelles, sans inventer de vente.',
    group: 'intelligence',
    icon: Package,
    accent: 'amber',
    primaryField: 'product',
    valueField: 'price',
    fields: [
      { key: 'sku', label: 'Référence', type: 'text', required: true, placeholder: 'SERUM-30', inList: true },
      { key: 'product', label: 'Produit', type: 'text', required: true, placeholder: 'Sérum éclat 30 ml', inList: true },
      { key: 'stock', label: 'Stock disponible', type: 'number', required: true, min: 0, step: 1, inList: true },
      { key: 'threshold', label: 'Seuil d’alerte', type: 'number', min: 0, step: 1, inList: true },
      { key: 'price', label: 'Prix de vente', type: 'number', min: 0, step: 100, suffix: 'FCFA' },
      { key: 'unitCost', label: 'Coût unitaire', type: 'number', min: 0, step: 100, suffix: 'FCFA', help: 'Sert au calcul de la marge potentielle.' },
      NOTES,
    ],
    statuses: [
      { value: 'disponible', label: 'Disponible', tone: 'success' },
      { value: 'stock_bas', label: 'Stock bas', tone: 'warning' },
      { value: 'rupture', label: 'Rupture', tone: 'danger' },
      { value: 'reapprovisionnement', label: 'Réapprovisionnement', tone: 'info' },
    ],
    openStatuses: ['stock_bas', 'rupture', 'reapprovisionnement'],
    kpis: [
      { label: 'Alertes stock', hint: 'Rupture ou stock ≤ seuil renseigné', compute: (records) => String(countBy(records, lowStock)) },
      { label: 'Ruptures', compute: (records) => String(countBy(records, (r) => measuredNumber(r.data.stock) === 0)) },
      { label: 'Stock au coût', hint: 'Coût unitaire × quantité, si tous les coûts sont renseignés', compute: (records) => {
        if (!records.length || records.some((r) => measuredNumber(r.data.stock) === null || measuredNumber(r.data.unitCost) === null)) return '—';
        return formatModuleMoney(records.reduce((total, r) => total + measuredNumber(r.data.stock)! * measuredNumber(r.data.unitCost)!, 0));
      } },
    ],
    quickActions: [
      { id: 'reappro', label: 'Marquer réapprovisionné', tone: 'success', patch: () => ({ status: 'reapprovisionnement' }) },
    ],
    emptyTitle: 'Aucun produit suivi',
    emptyDescription: 'Ajoutez vos produits pour suivre les seuils, les ruptures et la valeur immobilisée.',
    agentPrompt: 'Analyse mon stock et priorise les produits à réapprovisionner selon leur valeur et leur seuil d’alerte.',
  },
  {
    key: 'finance-intelligence',
    category: moduleKeyToCategory('finance-intelligence'),
    title: 'Finance Intelligence',
    shortTitle: 'Finance',
    description: 'Suivez les revenus et dépenses saisis pour lire le solde des mouvements renseignés.',
    purpose: 'Chaque ligne est un mouvement réel saisi ou importé. Les totaux se recalculent immédiatement, sans extrapolation.',
    group: 'intelligence',
    icon: Wallet,
    accent: 'emerald',
    primaryField: 'label',
    valueField: 'amount',
    dateField: 'occurredAt',
    fields: [
      { key: 'label', label: 'Libellé', type: 'text', required: true, placeholder: 'Ventes boutique — semaine 45', inList: true },
      { key: 'kind', label: 'Nature', type: 'select', required: true, options: [
        { value: 'revenu', label: 'Revenu' }, { value: 'depense', label: 'Dépense' },
      ], inList: true },
      { key: 'amount', label: 'Montant', type: 'number', required: true, min: 0, step: 100, suffix: 'FCFA', inList: true },
      { key: 'occurredAt', label: 'Date', type: 'date', required: true, inList: true },
      { key: 'category', label: 'Catégorie', type: 'select', options: [
        { value: 'ventes', label: 'Ventes' }, { value: 'marketing', label: 'Marketing' },
        { value: 'operations', label: 'Opérations' }, { value: 'salaires', label: 'Salaires' },
        { value: 'achats', label: 'Achats' }, { value: 'autres', label: 'Autres' },
      ] },
      NOTES,
    ],
    statuses: [
      { value: 'prevu', label: 'Prévu', tone: 'neutral' },
      { value: 'realise', label: 'Réalisé', tone: 'success' },
    ],
    openStatuses: ['prevu'],
    kpis: [
      { label: 'Revenus réalisés', compute: (records) => knownMoney(records, 'amount', (r) => r.data.kind === 'revenu' && r.data.status === 'realise') },
      { label: 'Dépenses réalisées', compute: (records) => knownMoney(records, 'amount', (r) => r.data.kind === 'depense' && r.data.status === 'realise') },
      { label: 'Solde saisi', hint: 'Mouvements renseignés ; pas la trésorerie totale', compute: (records) => {
        const income = knownSum(records, 'amount', (r) => r.data.kind === 'revenu' && r.data.status === 'realise');
        const expense = knownSum(records, 'amount', (r) => r.data.kind === 'depense' && r.data.status === 'realise');
        return income === null || expense === null ? '—' : formatModuleMoney(income - expense);
      } },
    ],
    emptyTitle: 'Aucun mouvement financier',
    emptyDescription: 'Ajoutez un revenu ou une dépense réalisée pour construire votre lecture financière.',
    agentPrompt: 'Analyse mes revenus et dépenses réalisés et identifie les postes à optimiser sans inventer de chiffre.',
  },
  {
    key: 'operations-manager',
    category: moduleKeyToCategory('operations-manager'),
    title: 'Operations Manager',
    shortTitle: 'Opérations',
    description: 'Centralisez les tâches du quotidien, leurs responsables et leurs échéances.',
    purpose: 'Les tâches créées manuellement ou par Sales Automation arrivent ici avec leur source, leur priorité et leur statut.',
    group: 'operations',
    icon: CheckSquare,
    accent: 'cyan',
    primaryField: 'title',
    dateField: 'dueDate',
    fields: [
      { key: 'title', label: 'Tâche', type: 'text', required: true, placeholder: 'Appeler le client et confirmer la commande', inList: true },
      { key: 'owner', label: 'Responsable', type: 'text', placeholder: 'Qui exécute ?', inList: true },
      { key: 'dueDate', label: 'Échéance', type: 'date', required: true, inList: true },
      { key: 'priority', label: 'Priorité', type: 'select', options: PRIORITIES, inList: true },
      { key: 'source', label: 'Source', type: 'select', options: [
        { value: 'manuel', label: 'Manuel' }, { value: 'sales_automation', label: 'Sales Automation' },
        { value: 'lead_rescue', label: 'Lead Rescue' }, { value: 'payment_recovery', label: 'Payment Recovery' },
        { value: 'customer_recovery', label: 'Customer Recovery' }, { value: 'order_cart_recovery', label: 'Order & Cart Recovery' },
        { value: 'smart_inventory', label: 'Smart Inventory' }, { value: 'support', label: 'Support' },
      ] },
      { key: 'sourcePlaybookId', label: 'Règle source', type: 'text', inList: false, help: 'Rempli automatiquement par Sales Automation.' },
      { key: 'sourceRecordId', label: 'Enregistrement source', type: 'text', inList: false },
      NOTES,
    ],
    statuses: [
      { value: 'a_faire', label: 'À faire', tone: 'warning' },
      { value: 'en_cours', label: 'En cours', tone: 'info' },
      { value: 'bloque', label: 'Bloqué', tone: 'danger' },
      { value: 'termine', label: 'Terminé', tone: 'success' },
    ],
    openStatuses: ['a_faire', 'en_cours', 'bloque'],
    kpis: [
      { label: 'Ouvertes', compute: (records) => String(countBy(records, (r) => isOpen(getModuleDefinition('operations-manager')!, r))) },
      { label: 'En retard', compute: (records) => String(countBy(records, (r) => isOpen(getModuleDefinition('operations-manager')!, r) && (daysSince(r.data.dueDate) ?? 0) > 0)) },
      { label: 'Terminées', compute: (records) => String(countBy(records, (r) => r.data.status === 'termine')) },
    ],
    quickActions: [
      { id: 'encours', label: 'Démarrer', tone: 'warning', patch: () => ({ status: 'en_cours' }) },
      { id: 'termine', label: 'Terminer', tone: 'success', patch: () => ({ status: 'termine' }) },
    ],
    emptyTitle: 'Aucune tâche planifiée',
    emptyDescription: 'Ajoutez une tâche ou générez-en depuis Sales Automation pour démarrer votre exécution.',
    agentPrompt: 'Priorise mes tâches opérationnelles selon l’échéance, la priorité et l’impact commercial.',
  },
  {
    key: 'customer-support-ai',
    category: moduleKeyToCategory('customer-support-ai'),
    title: 'Customer Support AI',
    shortTitle: 'Support',
    description: 'Suivez les demandes clients et préparez une réponse assistée par l’agent Business Growth.',
    purpose: 'Chaque ticket garde le message du client et un brouillon de réponse. L’IA propose, vous validez et enregistrez.',
    group: 'operations',
    icon: MessageSquare,
    accent: 'violet',
    primaryField: 'subject',
    fields: [
      { key: 'subject', label: 'Objet', type: 'text', required: true, placeholder: 'Demande de suivi de commande', inList: true },
      { key: 'customer', label: 'Client', type: 'text', required: true, placeholder: 'Nom du client', inList: true },
      { key: 'channel', label: 'Canal', type: 'select', options: CHANNELS, inList: true },
      { key: 'priority', label: 'Priorité', type: 'select', options: PRIORITIES, inList: true },
      { key: 'message', label: 'Message du client', type: 'textarea', placeholder: 'Collez le message reçu…', full: true },
      { key: 'draftReply', label: 'Brouillon de réponse', type: 'textarea', placeholder: 'Rédigez ou générez une proposition…', full: true },
      NOTES,
    ],
    statuses: [
      { value: 'ouvert', label: 'Ouvert', tone: 'warning' },
      { value: 'en_cours', label: 'En cours', tone: 'info' },
      { value: 'resolu', label: 'Résolu', tone: 'success' },
    ],
    openStatuses: ['ouvert', 'en_cours'],
    kpis: [
      { label: 'Ouverts', compute: (records) => String(countBy(records, (r) => isOpen(getModuleDefinition('customer-support-ai')!, r))) },
      { label: 'Haute priorité', compute: (records) => String(countBy(records, (r) => isOpen(getModuleDefinition('customer-support-ai')!, r) && r.data.priority === 'haute')) },
      { label: 'Résolus', compute: (records) => String(countBy(records, (r) => r.data.status === 'resolu')) },
    ],
    quickActions: [
      { id: 'encours', label: 'Prendre en charge', tone: 'warning', patch: () => ({ status: 'en_cours' }) },
      { id: 'resolu', label: 'Marquer résolu', tone: 'success', patch: () => ({ status: 'resolu' }) },
    ],
    emptyTitle: 'Aucun ticket de support',
    emptyDescription: 'Ajoutez une demande client pour suivre sa résolution et préparer une réponse.',
    agentPrompt: 'Rédige une réponse professionnelle et empathique au message client, en proposant une action concrète.',
  },
  {
    key: 'supplier-delivery',
    category: moduleKeyToCategory('supplier-delivery'),
    title: 'Supplier & Delivery',
    shortTitle: 'Fournisseurs',
    description: 'Suivez les fournisseurs, les commandes et les livraisons attendues.',
    purpose: 'Les retards se calculent à partir de la date attendue. Vous savez ce qui est en transit et ce qui doit être relancé.',
    group: 'operations',
    icon: Truck,
    accent: 'amber',
    primaryField: 'supplier',
    valueField: 'amount',
    dateField: 'expectedAt',
    fields: [
      { key: 'supplier', label: 'Fournisseur', type: 'text', required: true, placeholder: 'Nom du fournisseur', inList: true },
      { key: 'orderRef', label: 'Référence commande', type: 'text', placeholder: 'PO-2026-08', inList: true },
      { key: 'expectedAt', label: 'Livraison attendue', type: 'date', required: true, inList: true },
      { key: 'amount', label: 'Montant', type: 'number', min: 0, step: 1000, suffix: 'FCFA' },
      NOTES,
    ],
    statuses: [
      { value: 'commande', label: 'Commandé', tone: 'neutral' },
      { value: 'expedie', label: 'Expédié', tone: 'info' },
      { value: 'transit', label: 'En transit', tone: 'info' },
      { value: 'livre', label: 'Livré', tone: 'success' },
      { value: 'retard', label: 'En retard', tone: 'danger' },
    ],
    openStatuses: ['commande', 'expedie', 'transit', 'retard'],
    kpis: [
      { label: 'En transit', compute: (records) => String(countBy(records, (r) => ['expedie', 'transit'].includes(textFrom(r.data.status)))) },
      { label: 'En retard', compute: (records) => String(countBy(records, (r) => r.data.status === 'retard' || (isOpen(getModuleDefinition('supplier-delivery')!, r) && (daysSince(r.data.expectedAt) ?? 0) > 0))) },
      { label: 'Livrés', compute: (records) => String(countBy(records, (r) => r.data.status === 'livre')) },
    ],
    quickActions: [
      { id: 'transit', label: 'Marquer en transit', tone: 'warning', patch: () => ({ status: 'transit' }) },
      { id: 'livre', label: 'Marquer livré', tone: 'success', patch: () => ({ status: 'livre' }) },
    ],
    emptyTitle: 'Aucune livraison suivie',
    emptyDescription: 'Ajoutez une commande fournisseur pour anticiper les retards et sécuriser votre stock.',
    agentPrompt: 'Analyse mes commandes fournisseurs et signale les livraisons à relancer en priorité.',
  },
  {
    key: 'dispute-shield',
    category: moduleKeyToCategory('dispute-shield'),
    title: 'Dispute Shield',
    shortTitle: 'Litiges',
    description: 'Documentez les litiges, les preuves et les étapes de résolution.',
    purpose: 'Chaque dossier conserve le motif, le montant et les preuves. Le statut suit la négociation jusqu’à la clôture.',
    group: 'protection',
    icon: Shield,
    accent: 'rose',
    primaryField: 'reference',
    valueField: 'amount',
    dateField: 'openedAt',
    fields: [
      { key: 'reference', label: 'Référence', type: 'text', required: true, placeholder: 'LIT-2026-03', inList: true },
      { key: 'customer', label: 'Client / partie', type: 'text', required: true, placeholder: 'Nom de la partie', inList: true },
      { key: 'amount', label: 'Montant concerné', type: 'number', required: true, min: 0, step: 1000, suffix: 'FCFA', inList: true },
      { key: 'openedAt', label: 'Date d’ouverture', type: 'date', required: true, inList: true },
      { key: 'reason', label: 'Motif', type: 'text', placeholder: 'Retard, produit non conforme, désaccord…', full: true },
      { key: 'evidence', label: 'Preuves et échanges', type: 'textarea', placeholder: 'Factures, captures, échanges, numéros de suivi…', full: true },
      NOTES,
    ],
    statuses: [
      { value: 'ouvert', label: 'Ouvert', tone: 'danger' },
      { value: 'negociation', label: 'En négociation', tone: 'warning' },
      { value: 'resolu', label: 'Résolu', tone: 'success' },
      { value: 'escalade', label: 'Escaladé', tone: 'danger' },
    ],
    openStatuses: ['ouvert', 'negociation', 'escalade'],
    kpis: [
      { label: 'Montant en litige', compute: (records) => knownMoney(records, 'amount', (r) => isOpen(getModuleDefinition('dispute-shield')!, r)) },
      { label: 'Ouverts', compute: (records) => String(countBy(records, (r) => isOpen(getModuleDefinition('dispute-shield')!, r))) },
      { label: 'Résolus', compute: (records) => String(countBy(records, (r) => r.data.status === 'resolu')) },
    ],
    quickActions: [
      { id: 'negociation', label: 'Passer en négociation', tone: 'warning', patch: () => ({ status: 'negociation' }) },
      { id: 'resolu', label: 'Marquer résolu', tone: 'success', patch: () => ({ status: 'resolu' }) },
    ],
    emptyTitle: 'Aucun litige ouvert',
    emptyDescription: 'Ajoutez un dossier si un désaccord survient. Vous garderez les preuves et les étapes au même endroit.',
    agentPrompt: 'Analyse mes litiges ouverts et propose une stratégie de résolution avec les preuves à réunir.',
  },
  {
    key: 'revenue-leak',
    category: moduleKeyToCategory('revenue-leak'),
    title: 'Revenue Leak Detector',
    shortTitle: 'Fuites',
    description: 'Croise vos modules pour révéler les revenus qui s’échappent et prioriser les actions.',
    purpose: 'Les fuites sont calculées à partir des factures, leads, paniers, clients, stocks et litiges réels. Aucun chiffre n’est inventé.',
    group: 'protection',
    icon: Radar,
    accent: 'emerald',
    primaryField: 'title',
    valueField: 'amount',
    dateField: 'detectedAt',
    fields: [
      { key: 'title', label: 'Fuite identifiée', type: 'text', required: true, placeholder: 'Factures échues non relancées', inList: true },
      { key: 'source', label: 'Source', type: 'select', options: [
        { value: 'facture', label: 'Factures' }, { value: 'prospect', label: 'Leads' },
        { value: 'panier', label: 'Paniers' }, { value: 'stock', label: 'Stock' },
        { value: 'client', label: 'Clients' }, { value: 'litige', label: 'Litiges' },
        { value: 'autre', label: 'Autre' },
      ], inList: true },
      { key: 'amount', label: 'Montant estimé', type: 'number', min: 0, step: 1000, suffix: 'FCFA', inList: true },
      { key: 'detectedAt', label: 'Date de détection', type: 'date', required: true, inList: true },
      NOTES,
    ],
    statuses: [
      { value: 'identifie', label: 'Identifié', tone: 'danger' },
      { value: 'en_traitement', label: 'En traitement', tone: 'warning' },
      { value: 'colmate', label: 'Colmaté', tone: 'success' },
      { value: 'ignore', label: 'Ignoré', tone: 'neutral' },
    ],
    openStatuses: ['identifie', 'en_traitement'],
    kpis: [
      { label: 'Fuites détectées', hint: 'Calcul transversal', compute: () => '—' },
      { label: 'Montant exposé', compute: () => '—' },
      { label: 'Colmatées', compute: (records) => String(countBy(records, (r) => r.data.status === 'colmate')) },
    ],
    quickActions: [
      { id: 'traitement', label: 'Prendre en charge', tone: 'warning', patch: () => ({ status: 'en_traitement' }) },
      { id: 'colmate', label: 'Marquer colmaté', tone: 'success', patch: () => ({ status: 'colmate' }) },
    ],
    emptyTitle: 'Aucune fuite saisie',
    emptyDescription: 'Le détecteur analyse automatiquement vos autres modules. Ajoutez une fuite manuelle si elle vient d’ailleurs.',
    agentPrompt: 'Analyse mes fuites de revenus et propose un plan d’action priorisé pour les colmater.',
  },
];

/* -------------------------------------------------------------------------- */
/* Détecteur transversal                                                      */
/* -------------------------------------------------------------------------- */

export interface DetectedLeak {
  id: string;
  title: string;
  detail: string;
  amount: number | null;
  severity: 'haute' | 'moyenne' | 'basse';
  moduleKey: string;
  moduleTitle: string;
}

export function computeRevenueLeaks(recordsByModule: Record<string, ModuleRecord[]>): DetectedLeak[] {
  const leaks: DetectedLeak[] = [];
  const list = (key: string) => recordsByModule[key] ?? [];
  const moduleOf = (key: string) => MODULE_DEFINITIONS.find((item) => item.key === key)!;

  const overdue = list('payment-recovery').filter((record) => record.data.status === 'en_retard' || (['a_echeance', 'relance', 'litige'].includes(textFrom(record.data.status)) && (daysSince(record.data.dueDate) ?? 0) > 0));
  if (overdue.length) {
    leaks.push({
      id: 'leak-invoices',
      title: `${overdue.length} facture(s) en retard`,
      detail: 'Encours non encaissé, relances à reprendre ou litige à traiter.',
      amount: knownSum(overdue, 'amount'),
      severity: 'haute',
      moduleKey: 'payment-recovery',
      moduleTitle: moduleOf('payment-recovery').title,
    });
  }

  const staleLeads = list('lead-rescue').filter((record) => isOpen(moduleOf('lead-rescue'), record) && (daysSince(record.data.lastContactAt) ?? 0) >= 3);
  if (staleLeads.length) {
    leaks.push({
      id: 'leak-leads',
      title: `${staleLeads.length} lead(s) sans contact récent`,
      detail: 'Opportunités ouvertes qui refroidissent faute de relance.',
      amount: knownSum(staleLeads, 'estimatedValue'),
      severity: 'haute',
      moduleKey: 'lead-rescue',
      moduleTitle: moduleOf('lead-rescue').title,
    });
  }

  const atRisk = list('customer-recovery').filter((record) => ['a_risque', 'contacte'].includes(textFrom(record.data.status)));
  if (atRisk.length) {
    leaks.push({
      id: 'leak-customers',
      title: `${atRisk.length} client(s) à réactiver`,
      detail: 'Valeur historique déclarée : elle ne représente pas un revenu récupérable garanti.',
      amount: knownSum(atRisk, 'totalSpent'),
      severity: 'moyenne',
      moduleKey: 'customer-recovery',
      moduleTitle: moduleOf('customer-recovery').title,
    });
  }

  const carts = list('order-cart-recovery').filter((record) => isOpen(moduleOf('order-cart-recovery'), record));
  if (carts.length) {
    leaks.push({
      id: 'leak-carts',
      title: `${carts.length} panier(s) ou commande(s) en attente`,
      detail: 'Valeur ouverte dont la récupération peut encore être tentée.',
      amount: knownSum(carts, 'amount'),
      severity: 'moyenne',
      moduleKey: 'order-cart-recovery',
      moduleTitle: moduleOf('order-cart-recovery').title,
    });
  }

  const lowStockItems = list('smart-inventory').filter(lowStock);
  if (lowStockItems.length) {
    leaks.push({
      id: 'leak-stock',
      title: `${lowStockItems.length} produit(s) en rupture ou sous le seuil`,
      detail: 'Risque de ventes manquées non chiffrable sans données de demande.',
      amount: null,
      severity: 'moyenne',
      moduleKey: 'smart-inventory',
      moduleTitle: moduleOf('smart-inventory').title,
    });
  }

  const disputes = list('dispute-shield').filter((record) => isOpen(moduleOf('dispute-shield'), record));
  if (disputes.length) {
    leaks.push({
      id: 'leak-disputes',
      title: `${disputes.length} litige(s) ouvert(s)`,
      detail: 'Montants bloqués en attente de résolution ou de preuve.',
      amount: knownSum(disputes, 'amount'),
      severity: 'haute',
      moduleKey: 'dispute-shield',
      moduleTitle: moduleOf('dispute-shield').title,
    });
  }

  const order: Record<DetectedLeak['severity'], number> = { haute: 0, moyenne: 1, basse: 2 };
  return leaks.sort((a, b) => order[a.severity] - order[b.severity] || (b.amount ?? -1) - (a.amount ?? -1));
}

/* -------------------------------------------------------------------------- */
/* Automatisation déterministe                                                */
/* -------------------------------------------------------------------------- */

export const AUTOMATION_TRIGGERS: readonly { value: string; label: string; sourceModule: string }[] = [
  { value: 'nouveau_prospect', label: 'Nouveau prospect sans contact', sourceModule: 'lead-rescue' },
  { value: 'panier_abandonne', label: 'Panier abandonné', sourceModule: 'order-cart-recovery' },
  { value: 'facture_echue', label: 'Facture échue', sourceModule: 'payment-recovery' },
  { value: 'client_inactif', label: 'Client à risque', sourceModule: 'customer-recovery' },
  { value: 'stock_bas', label: 'Stock bas ou rupture', sourceModule: 'smart-inventory' },
];

export interface AutomationTaskDraft {
  title: string;
  owner: string;
  dueDate: string;
  priority: string;
  source: string;
  sourcePlaybookId: string;
  sourceRecordId: string;
  notes: string;
}

export function automationCandidate(trigger: string, record: ModuleRecord, now = Date.now()): boolean {
  switch (trigger) {
    case 'nouveau_prospect':
      return record.data.status === 'nouveau';
    case 'panier_abandonne':
      return ['panier', 'commande'].includes(textFrom(record.data.status));
    case 'facture_echue':
      return record.data.status === 'en_retard' || (['a_echeance', 'relance'].includes(textFrom(record.data.status))
        && /^\d{4}-\d{2}-\d{2}$/.test(textFrom(record.data.dueDate)) && (daysSince(record.data.dueDate, now) ?? 0) > 0);
    case 'client_inactif':
      return ['a_risque', 'contacte'].includes(textFrom(record.data.status));
    case 'stock_bas':
      return lowStock(record);
    default:
      return false;
  }
}

export interface AutomationCandidate {
  playbook: ModuleRecord;
  record: ModuleRecord;
  sourceModule: string;
  trigger: string;
  dueDate: string;
}

/** Parcours paresseux : ne matérialise pas 500 × 500 brouillons en mémoire. */
export function* iterateAutomationCandidates(
  playbooks: readonly ModuleRecord[],
  recordsByModule: Record<string, ModuleRecord[]>,
  now = Date.now(),
): Generator<AutomationCandidate> {
  const today = new Date(now);
  if (!Number.isFinite(today.getTime())) return;
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const eligibleByTrigger = new Map<string, ModuleRecord[]>();
  for (const playbook of playbooks) {
    if (playbook.data.status !== 'actif') continue;
    const trigger = textFrom(playbook.data.trigger);
    const sourceModule = AUTOMATION_TRIGGERS.find((item) => item.value === trigger)?.sourceModule;
    if (!sourceModule) continue;
    // Un délai vide signifie 0 jour ; une ancienne valeur invalide ne doit
    // pas être convertie silencieusement en échéance inventée.
    const rawDelay = playbook.data.delayDays;
    const delay = rawDelay === null || rawDelay === undefined || rawDelay === '' ? 0 : measuredNumber(rawDelay);
    if (delay === null || !Number.isInteger(delay) || delay > 3650) continue;
    const dueDate = new Date(midnight + delay * 86_400_000).toISOString().slice(0, 10);
    if (!eligibleByTrigger.has(trigger)) {
      eligibleByTrigger.set(trigger, (recordsByModule[sourceModule] ?? []).filter((record) => automationCandidate(trigger, record, now)));
    }
    for (const record of eligibleByTrigger.get(trigger) ?? []) yield { playbook, record, sourceModule, trigger, dueDate };
  }
}

export function automationTaskFromCandidate({ playbook, record, trigger, dueDate }: AutomationCandidate): AutomationTaskDraft {
  const label = textFrom(record.data.name) || textFrom(record.data.customer) || textFrom(record.data.product)
    || textFrom(record.data.reference) || textFrom(record.data.invoiceRef) || textFrom(record.data.title)
    || record.id.slice(0, 8);
  return {
    title: `${textFrom(playbook.data.name) || 'Relance'} · ${label}`,
    owner: '',
    dueDate,
    priority: trigger === 'facture_echue' ? 'haute' : 'moyenne',
    source: 'sales_automation',
    sourcePlaybookId: playbook.id,
    sourceRecordId: record.id,
    notes: `Action : ${textFrom(playbook.data.action) || 'tache_relance'} · Déclencheur : ${trigger}.`,
  };
}

export function buildAutomationTasks(
  playbooks: readonly ModuleRecord[],
  recordsByModule: Record<string, ModuleRecord[]>,
  now = Date.now(),
): AutomationTaskDraft[] {
  return Array.from(iterateAutomationCandidates(playbooks, recordsByModule, now), automationTaskFromCandidate);
}
