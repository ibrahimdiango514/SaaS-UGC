/**
 * SORAHNEX Grow — CRM : modèle métier pur.
 *
 * Aucune dépendance React ni Supabase. Toutes les décisions commerciales
 * (score, priorité, doublons, actions, segments, tableau de bord) sont
 * calculées ici à partir de données réelles et restent explicables.
 */

export type ContactType = 'prospect' | 'client' | 'partenaire' | 'fournisseur' | 'autre';
export type ContactStatus = 'actif' | 'inactif' | 'archive';
export type OpportunityStage =
  | 'nouveau' | 'contacte' | 'qualifie' | 'besoin'
  | 'proposition' | 'negociation' | 'gagne' | 'perdu';
export type TaskType =
  | 'appel' | 'whatsapp' | 'email' | 'rendez_vous' | 'demonstration'
  | 'relance' | 'proposition' | 'suivi' | 'autre';
export type TaskStatus = 'a_faire' | 'termine' | 'annule';
export type Priority = 'faible' | 'normale' | 'elevee' | 'urgente';

export const CONTACT_TYPES: readonly { value: ContactType; label: string }[] = [
  { value: 'prospect', label: 'Prospect' },
  { value: 'client', label: 'Client' },
  { value: 'partenaire', label: 'Partenaire' },
  { value: 'fournisseur', label: 'Fournisseur' },
  { value: 'autre', label: 'Autre' },
];

export const CONTACT_STATUSES: readonly { value: ContactStatus; label: string }[] = [
  { value: 'actif', label: 'Actif' },
  { value: 'inactif', label: 'Inactif' },
  { value: 'archive', label: 'Archivé' },
];

export const CONTACT_SOURCES: readonly { value: string; label: string }[] = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'site', label: 'Site web' },
  { value: 'boutique', label: 'Boutique' },
  { value: 'recommandation', label: 'Recommandation' },
  { value: 'import', label: 'Import' },
  { value: 'autre', label: 'Autre' },
];

export const OPPORTUNITY_STAGES: readonly {
  value: OpportunityStage; label: string; tone: string; probability: number; open: boolean;
}[] = [
  { value: 'nouveau', label: 'Nouveau prospect', tone: 'text-slate-300', probability: 10, open: true },
  { value: 'contacte', label: 'Contacté', tone: 'text-cyan-200', probability: 20, open: true },
  { value: 'qualifie', label: 'Qualifié', tone: 'text-sky-200', probability: 35, open: true },
  { value: 'besoin', label: 'Besoin identifié', tone: 'text-violet-200', probability: 50, open: true },
  { value: 'proposition', label: 'Proposition envoyée', tone: 'text-amber-200', probability: 65, open: true },
  { value: 'negociation', label: 'Négociation', tone: 'text-orange-200', probability: 80, open: true },
  { value: 'gagne', label: 'Gagné', tone: 'text-emerald-300', probability: 100, open: false },
  { value: 'perdu', label: 'Perdu', tone: 'text-rose-300', probability: 0, open: false },
];

export const TASK_TYPES: readonly { value: TaskType; label: string }[] = [
  { value: 'appel', label: 'Appel' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'E-mail' },
  { value: 'rendez_vous', label: 'Rendez-vous' },
  { value: 'demonstration', label: 'Démonstration' },
  { value: 'relance', label: 'Relance' },
  { value: 'proposition', label: 'Proposition' },
  { value: 'suivi', label: 'Suivi' },
  { value: 'autre', label: 'Autre' },
];

export const TASK_STATUSES: readonly { value: TaskStatus; label: string }[] = [
  { value: 'a_faire', label: 'À faire' },
  { value: 'termine', label: 'Terminé' },
  { value: 'annule', label: 'Annulé' },
];

export const PRIORITY_LABELS: Record<Priority, string> = {
  faible: 'Priorité faible',
  normale: 'Priorité normale',
  elevee: 'Priorité élevée',
  urgente: 'Priorité urgente',
};

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  company: string;
  jobTitle: string;
  phone: string;
  whatsapp: string;
  email: string;
  address: string;
  city: string;
  country: string;
  source: string;
  type: ContactType;
  tags: string[];
  notes: string;
  owner: string;
  lastContactAt: string;
  nextAction: string;
  nextActionAt: string;
  status: ContactStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Opportunity {
  id: string;
  title: string;
  contactId: string;
  stage: OpportunityStage;
  amount: number | null;
  currency: string;
  probability: number | null;
  expectedCloseAt: string;
  owner: string;
  product: string;
  source: string;
  notes: string;
  lostReason: string;
  nextAction: string;
  nextActionAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrmTask {
  id: string;
  title: string;
  type: TaskType;
  contactId: string;
  opportunityId: string;
  owner: string;
  priority: Priority;
  dueDate: string;
  dueTime: string;
  status: TaskStatus;
  notes: string;
  outcome: string;
  nextAction: string;
  nextActionAt: string;
  completedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrmActivity {
  id: string;
  contactId: string;
  opportunityId: string;
  type: string;
  summary: string;
  occurredAt: string;
  author: string;
  createdAt: string;
}

export interface SegmentFilters {
  query: string;
  type: ContactType | 'tous';
  source: string;
  tag: string;
  owner: string;
  city: string;
  country: string;
  status: ContactStatus | 'tous';
  /** Nombre de jours minimum depuis le dernier contact. */
  inactiveDays: number | null;
  /** Score minimum. */
  minScore: number | null;
  priority: Priority | 'toutes';
  /** Montant minimum des opportunités ouvertes. */
  minOpenValue: number | null;
  hasOverdueTask: boolean;
  hasOpenOpportunity: boolean;
  atRisk: boolean;
}

export interface CrmSegment {
  id: string;
  name: string;
  filters: SegmentFilters;
  createdAt: string;
}

export const EMPTY_SEGMENT_FILTERS: SegmentFilters = {
  query: '', type: 'tous', source: '', tag: '', owner: '', city: '', country: '',
  status: 'tous', inactiveDays: null, minScore: null, priority: 'toutes',
  minOpenValue: null, hasOverdueTask: false, hasOpenOpportunity: false, atRisk: false,
};

export function todayIso(now = new Date()): string {
  // Date locale : un utilisateur à 23 h ne doit pas basculer sur le lendemain
  // UTC pour ses relances et échéances.
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

export function daysAgo(value: string, now = todayIso()): number | null {
  const days = daysBetween(value, now);
  return days === null ? null : Math.max(0, days);
}

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function tags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;]/)
      : [];
  return Array.from(new Set(raw
    .map((entry) => str(entry, 40).toLowerCase())
    .filter(Boolean)))
    .slice(0, 20);
}

function optionalAmount(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(value))) return null;
  const parsed = typeof value === 'number' ? value : Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000_000_000 ? parsed : null;
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

export function normalizePhone(value: unknown): string {
  const raw = str(value, 60).replace(/[\s().-]/g, '');
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '').replace(/^00/, '');
  if (!digits) return '';
  // Le numéro national est conservé tel quel ; un indicatif international
  // ajouté (+223, 00223) est retiré s'il allonge le numéro au-delà de 9
  // chiffres, pour comparer le même abonné sans dépendre de l'indicatif.
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/** Deux numéros désignent le même abonné si leur partie nationale coïncide. */
export function phonesMatch(left: string, right: string): boolean {
  const a = normalizePhone(left);
  const b = normalizePhone(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // Les longueurs nationales varient (8 chiffres au Mali, 9 ailleurs) : on
  // compare alors les 8 derniers chiffres, jamais moins.
  return a.slice(-8) === b.slice(-8);
}

export function normalizeEmail(value: unknown): string {
  return str(value, 200).toLowerCase();
}

export function normalizeName(value: unknown): string {
  return str(value, 200)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function contactFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string; updated_at?: string }): Contact {
  const data = record.data ?? {};
  return {
    id: record.id,
    firstName: str(data.firstName, 80),
    lastName: str(data.lastName, 80),
    company: str(data.company, 160),
    jobTitle: str(data.jobTitle, 120),
    phone: str(data.phone, 60),
    whatsapp: str(data.whatsapp, 60),
    email: normalizeEmail(data.email),
    address: str(data.address, 240),
    city: str(data.city, 80),
    country: str(data.country, 80),
    source: str(data.source, 40),
    type: oneOf<ContactType>(data.type, ['prospect', 'client', 'partenaire', 'fournisseur', 'autre'], 'prospect'),
    tags: tags(data.tags),
    notes: str(data.notes, 4000),
    owner: str(data.owner, 120),
    lastContactAt: dateOnly(data.lastContactAt),
    nextAction: str(data.nextAction, 240),
    nextActionAt: dateOnly(data.nextActionAt),
    status: oneOf<ContactStatus>(data.status, ['actif', 'inactif', 'archive'], 'actif'),
    createdAt: isoOrEmpty(record.created_at ?? data.createdAt) || new Date(0).toISOString(),
    updatedAt: isoOrEmpty(record.updated_at ?? data.updatedAt) || new Date(0).toISOString(),
  };
}

export function contactToData(contact: Contact): Record<string, unknown> {
  return {
    firstName: contact.firstName, lastName: contact.lastName, company: contact.company,
    jobTitle: contact.jobTitle, phone: contact.phone, whatsapp: contact.whatsapp,
    email: contact.email, address: contact.address, city: contact.city, country: contact.country,
    source: contact.source, type: contact.type, tags: contact.tags, notes: contact.notes,
    owner: contact.owner, lastContactAt: contact.lastContactAt, nextAction: contact.nextAction,
    nextActionAt: contact.nextActionAt, status: contact.status,
  };
}

export function contactDisplayName(contact: Pick<Contact, 'firstName' | 'lastName' | 'company' | 'email' | 'phone'>): string {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  return name || contact.company || contact.email || contact.phone || 'Contact sans nom';
}

export function opportunityFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string; updated_at?: string }): Opportunity {
  const data = record.data ?? {};
  const stage = oneOf<OpportunityStage>(data.stage, OPPORTUNITY_STAGES.map((entry) => entry.value), 'nouveau');
  const probability = optionalAmount(data.probability);
  return {
    id: record.id,
    title: str(data.title, 200),
    contactId: str(data.contactId, 64),
    stage,
    amount: optionalAmount(data.amount),
    currency: str(data.currency, 8).toUpperCase() || 'XOF',
    probability: probability === null ? OPPORTUNITY_STAGES.find((entry) => entry.value === stage)?.probability ?? null : Math.min(100, probability),
    expectedCloseAt: dateOnly(data.expectedCloseAt),
    owner: str(data.owner, 120),
    product: str(data.product, 160),
    source: str(data.source, 40),
    notes: str(data.notes, 4000),
    lostReason: str(data.lostReason, 400),
    nextAction: str(data.nextAction, 240),
    nextActionAt: dateOnly(data.nextActionAt),
    createdAt: isoOrEmpty(record.created_at ?? data.createdAt) || new Date(0).toISOString(),
    updatedAt: isoOrEmpty(record.updated_at ?? data.updatedAt) || new Date(0).toISOString(),
  };
}

export function opportunityToData(opportunity: Opportunity): Record<string, unknown> {
  return {
    title: opportunity.title, contactId: opportunity.contactId, stage: opportunity.stage,
    amount: opportunity.amount, currency: opportunity.currency, probability: opportunity.probability,
    expectedCloseAt: opportunity.expectedCloseAt, owner: opportunity.owner,
    product: opportunity.product, source: opportunity.source, notes: opportunity.notes,
    lostReason: opportunity.lostReason, nextAction: opportunity.nextAction,
    nextActionAt: opportunity.nextActionAt,
  };
}

export function taskFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string; updated_at?: string }): CrmTask {
  const data = record.data ?? {};
  return {
    id: record.id,
    title: str(data.title, 200),
    type: oneOf<TaskType>(data.type, TASK_TYPES.map((entry) => entry.value), 'suivi'),
    contactId: str(data.contactId, 64),
    opportunityId: str(data.opportunityId, 64),
    owner: str(data.owner, 120),
    priority: oneOf<Priority>(data.priority, ['faible', 'normale', 'elevee', 'urgente'], 'normale'),
    dueDate: dateOnly(data.dueDate),
    dueTime: /^\d{2}:\d{2}$/.test(str(data.dueTime, 5)) ? str(data.dueTime, 5) : '',
    status: oneOf<TaskStatus>(data.status, ['a_faire', 'termine', 'annule'], 'a_faire'),
    notes: str(data.notes, 2000),
    outcome: str(data.outcome, 1000),
    nextAction: str(data.nextAction, 240),
    nextActionAt: dateOnly(data.nextActionAt),
    completedAt: dateOnly(data.completedAt),
    createdAt: isoOrEmpty(record.created_at ?? data.createdAt) || new Date(0).toISOString(),
    updatedAt: isoOrEmpty(record.updated_at ?? data.updatedAt) || new Date(0).toISOString(),
  };
}

export function taskToData(task: CrmTask): Record<string, unknown> {
  return {
    title: task.title, type: task.type, contactId: task.contactId,
    opportunityId: task.opportunityId, owner: task.owner, priority: task.priority,
    dueDate: task.dueDate, dueTime: task.dueTime, status: task.status, notes: task.notes,
    outcome: task.outcome, nextAction: task.nextAction, nextActionAt: task.nextActionAt,
    completedAt: task.completedAt,
  };
}

export function activityFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): CrmActivity {
  const data = record.data ?? {};
  return {
    id: record.id,
    contactId: str(data.contactId, 64),
    opportunityId: str(data.opportunityId, 64),
    type: str(data.type, 40) || 'note',
    summary: str(data.summary, 1000),
    occurredAt: dateOnly(data.occurredAt) || (record.created_at ?? '').slice(0, 10),
    author: str(data.author, 120),
    createdAt: isoOrEmpty(record.created_at),
  };
}

export function segmentFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): CrmSegment {
  const data = record.data ?? {};
  const raw = (data.filters && typeof data.filters === 'object' ? data.filters : {}) as Record<string, unknown>;
  return {
    id: record.id,
    name: str(data.name, 120) || 'Segment sans nom',
    filters: {
      ...EMPTY_SEGMENT_FILTERS,
      query: str(raw.query, 120),
      type: oneOf<ContactType | 'tous'>(raw.type, ['tous', 'prospect', 'client', 'partenaire', 'fournisseur', 'autre'], 'tous'),
      source: str(raw.source, 40),
      tag: str(raw.tag, 40),
      owner: str(raw.owner, 120),
      city: str(raw.city, 80),
      country: str(raw.country, 80),
      status: oneOf<ContactStatus | 'tous'>(raw.status, ['tous', 'actif', 'inactif', 'archive'], 'tous'),
      inactiveDays: optionalAmount(raw.inactiveDays),
      minScore: optionalAmount(raw.minScore),
      priority: oneOf<Priority | 'toutes'>(raw.priority, ['toutes', 'faible', 'normale', 'elevee', 'urgente'], 'toutes'),
      minOpenValue: optionalAmount(raw.minOpenValue),
      hasOverdueTask: raw.hasOverdueTask === true,
      hasOpenOpportunity: raw.hasOpenOpportunity === true,
      atRisk: raw.atRisk === true,
    },
    createdAt: isoOrEmpty(record.created_at),
  };
}

/* -------------------------------------------------------------------------- */
/* Scoring commercial explicable                                              */
/* -------------------------------------------------------------------------- */

export interface ScoreReason {
  label: string;
  points: number;
  detail?: string;
}

export interface ContactScore {
  score: number;
  priority: Priority;
  reasons: ScoreReason[];
  openValue: number;
  openOpportunityCount: number;
  overdueTaskCount: number;
  daysSinceContact: number | null;
  heat: 'chaud' | 'tiede' | 'froid' | 'inconnu';
}

export interface ScoreContext {
  opportunities: readonly Opportunity[];
  tasks: readonly CrmTask[];
  /** Nombre de créances en retard liées au contact, si le module finances est chargé. */
  overdueReceivables?: number;
  now?: string;
}

function priorityOf(score: number): Priority {
  if (score >= 75) return 'urgente';
  if (score >= 55) return 'elevee';
  if (score >= 30) return 'normale';
  return 'faible';
}

export function scoreContact(contact: Contact, context: ScoreContext): ContactScore {
  const now = context.now ?? todayIso();
  const reasons: ScoreReason[] = [];
  const open = context.opportunities.filter((opportunity) => opportunity.contactId === contact.id
    && OPPORTUNITY_STAGES.find((entry) => entry.value === opportunity.stage)?.open);
  const openValue = open.reduce((total, opportunity) => total + (opportunity.amount ?? 0), 0);
  const openOpportunityCount = open.length;
  const contactTasks = context.tasks.filter((task) => task.contactId === contact.id && task.status === 'a_faire');
  const overdueTaskCount = contactTasks.filter((task) => {
    const days = daysBetween(task.dueDate, now);
    return days !== null && days > 0;
  }).length;
  const daysSinceContact = contact.lastContactAt ? daysBetween(contact.lastContactAt, now) : null;
  let score = 0;

  if (contact.type === 'client') { score += 12; reasons.push({ label: 'Client existant', points: 12 }); }
  if (contact.type === 'prospect') { score += 4; reasons.push({ label: 'Prospect identifié', points: 4 }); }
  if (contact.status === 'archive') { score -= 25; reasons.push({ label: 'Contact archivé', points: -25 }); }

  if (daysSinceContact === null) {
    reasons.push({ label: 'Dernier contact inconnu', points: 0, detail: 'Renseignez une date pour affiner la priorité.' });
  } else if (daysSinceContact <= 3) {
    score += 20; reasons.push({ label: 'Contact très récent', points: 20, detail: `${daysSinceContact} jour(s)` });
  } else if (daysSinceContact <= 14) {
    score += 10; reasons.push({ label: 'Contact récent', points: 10, detail: `${daysSinceContact} jours` });
  } else if (daysSinceContact <= 30) {
    score += 2; reasons.push({ label: 'Contact qui vieillit', points: 2, detail: `${daysSinceContact} jours` });
  } else {
    score -= 12; reasons.push({ label: 'Aucun contact depuis longtemps', points: -12, detail: `${daysSinceContact} jours` });
  }

  if (openOpportunityCount) {
    score += Math.min(20, 6 * openOpportunityCount);
    reasons.push({ label: 'Opportunité(s) ouverte(s)', points: Math.min(20, 6 * openOpportunityCount), detail: `${openOpportunityCount}` });
  }
  const strongest = [...open].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))[0];
  if (strongest) {
    const stageIndex = OPPORTUNITY_STAGES.findIndex((entry) => entry.value === strongest.stage);
    const stagePoints = Math.min(24, Math.max(0, stageIndex) * 4);
    if (stagePoints) { score += stagePoints; reasons.push({ label: 'Avancement du pipeline', points: stagePoints, detail: OPPORTUNITY_STAGES[stageIndex]?.label }); }
    if ((strongest.amount ?? 0) >= 1_000_000) { score += 12; reasons.push({ label: 'Montant élevé', points: 12 }); }
    else if ((strongest.amount ?? 0) >= 250_000) { score += 7; reasons.push({ label: 'Montant significatif', points: 7 }); }
    const closeIn = strongest.expectedCloseAt ? daysBetween(now, strongest.expectedCloseAt) : null;
    if (closeIn !== null && closeIn <= 7 && closeIn >= -3) { score += 10; reasons.push({ label: 'Conclusion proche', points: 10, detail: strongest.expectedCloseAt }); }
    else if (closeIn !== null && closeIn < -3) { score -= 6; reasons.push({ label: 'Conclusion dépassée', points: -6 }); }
  }

  if (overdueTaskCount) { score += Math.min(12, 4 * overdueTaskCount); reasons.push({ label: 'Relance(s) en retard', points: Math.min(12, 4 * overdueTaskCount), detail: `${overdueTaskCount}` }); }
  else if (contactTasks.length) { score += 4; reasons.push({ label: 'Action planifiée', points: 4 }); }

  if (contact.nextActionAt) {
    const nextIn = daysBetween(contact.nextActionAt, now);
    if (nextIn !== null && nextIn < 0) { score += 8; reasons.push({ label: 'Prochaine action due', points: 8, detail: contact.nextActionAt }); }
  }

  if (context.overdueReceivables) {
    score += Math.min(10, 3 * context.overdueReceivables);
    reasons.push({ label: 'Créance(s) en retard', points: Math.min(10, 3 * context.overdueReceivables), detail: `${context.overdueReceivables}` });
  }

  score = Math.max(0, Math.min(100, score));
  const heat: ContactScore['heat'] = daysSinceContact === null
    ? 'inconnu'
    : daysSinceContact <= 7 && score >= 55
      ? 'chaud'
      : daysSinceContact <= 30
        ? 'tiede'
        : 'froid';

  return { score, priority: priorityOf(score), reasons, openValue, openOpportunityCount, overdueTaskCount, daysSinceContact, heat };
}

export function isOpenStage(stage: OpportunityStage): boolean {
  return OPPORTUNITY_STAGES.find((entry) => entry.value === stage)?.open === true;
}

/* -------------------------------------------------------------------------- */
/* Doublons et fusion                                                          */
/* -------------------------------------------------------------------------- */

export interface DuplicateCandidate {
  left: Contact;
  right: Contact;
  confidence: number;
  reasons: string[];
}

function nameSimilarity(a: string, b: string): number {
  const left = normalizeName(a).split(' ').filter(Boolean);
  const right = normalizeName(b).split(' ').filter(Boolean);
  if (!left.length || !right.length) return 0;
  const common = left.filter((token) => right.includes(token)).length;
  const ratio = (2 * common) / (left.length + right.length);
  return Math.round(ratio * 100);
}

export function detectDuplicates(contacts: readonly Contact[], minimumConfidence = 45): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];
  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const left = contacts[i];
      const right = contacts[j];
      let confidence = 0;
      const reasons: string[] = [];
      const leftPhone = left.phone || left.whatsapp;
      const rightPhone = right.phone || right.whatsapp;
      if (leftPhone && rightPhone && phonesMatch(leftPhone, rightPhone)) {
        confidence += 55; reasons.push('Téléphone identique (numéro normalisé)');
      }
      if (left.email && right.email && normalizeEmail(left.email) === normalizeEmail(right.email)) {
        confidence += 60; reasons.push('E-mail identique');
      }
      const name = nameSimilarity(contactDisplayName(left), contactDisplayName(right));
      if (name >= 80) { confidence += 30; reasons.push(`Nom très proche (${name} %)`); }
      else if (name >= 55) { confidence += 15; reasons.push(`Nom proche (${name} %)`); }
      const company = nameSimilarity(left.company, right.company);
      if (left.company && right.company && company >= 70) { confidence += 15; reasons.push('Entreprise similaire'); }
      if (left.city && right.city && normalizeName(left.city) === normalizeName(right.city)) { confidence += 3; reasons.push('Même ville'); }

      if (reasons.length === 0) continue;
      const capped = Math.min(100, confidence);
      if (capped >= minimumConfidence) candidates.push({ left, right, confidence: capped, reasons });
    }
  }
  return candidates.sort((a, b) => b.confidence - a.confidence);
}

export type MergeFieldChoice = 'left' | 'right' | 'combine';

/**
 * Fusion contrôlée : l'utilisateur choisit le contact conservé et, champ par
 * champ, la valeur retenue. Aucune fusion n'est automatique.
 */
export function mergeContactData(
  kept: Contact,
  duplicate: Contact,
  choices: Partial<Record<keyof Contact, MergeFieldChoice>> = {},
): Contact {
  const merged: Contact = { ...kept };
  const fields: (keyof Contact)[] = [
    'firstName', 'lastName', 'company', 'jobTitle', 'phone', 'whatsapp', 'email',
    'address', 'city', 'country', 'source', 'type', 'owner', 'lastContactAt',
    'nextAction', 'nextActionAt', 'notes', 'status',
  ];
  const target = merged as unknown as Record<string, unknown>;
  const source = duplicate as unknown as Record<string, unknown>;
  for (const field of fields) {
    const choice = choices[field] ?? (kept[field] ? 'left' : 'right');
    if (choice === 'right') {
      target[field] = source[field];
    } else if (choice === 'combine' && typeof kept[field] === 'string' && typeof duplicate[field] === 'string') {
      const a = String(kept[field]).trim();
      const b = String(duplicate[field]).trim();
      target[field] = a && b && a !== b ? `${a} · ${b}`.slice(0, 1000) : (a || b);
    }
  }
  merged.tags = Array.from(new Set([...kept.tags, ...duplicate.tags])).slice(0, 20);
  if (!merged.lastContactAt || (duplicate.lastContactAt && duplicate.lastContactAt > merged.lastContactAt)) {
    merged.lastContactAt = duplicate.lastContactAt || merged.lastContactAt;
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Centre d'action                                                            */
/* -------------------------------------------------------------------------- */

export type ActionKind =
  | 'relance_retard' | 'rappeler_aujourdhui' | 'prospect_chaud' | 'opportunite_stagnante'
  | 'sans_prochaine_action' | 'client_inactif' | 'client_a_risque' | 'nouveau_contact'
  | 'tache_aujourdhui' | 'promesse_non_respectee' | 'creance_en_retard';

export interface ActionItem {
  id: string;
  kind: ActionKind;
  title: string;
  detail: string;
  severity: 'urgente' | 'elevee' | 'normale';
  contactId: string;
  opportunityId?: string;
  dueDate?: string;
  amount?: number | null;
  actionLabel: string;
}

export interface FinanceActionInput {
  id: string;
  contactId: string;
  label: string;
  amount: number | null;
  dueDate: string;
  kind: 'creance_en_retard' | 'promesse_non_respectee';
}

export interface ActionCenterInput {
  contacts: readonly Contact[];
  opportunities: readonly Opportunity[];
  tasks: readonly CrmTask[];
  finance?: readonly FinanceActionInput[];
  now?: string;
}

export function buildActionCenter(input: ActionCenterInput): ActionItem[] {
  const now = input.now ?? todayIso();
  const items: ActionItem[] = [];
  const contactById = new Map(input.contacts.map((contact) => [contact.id, contact]));
  const scores = new Map(input.contacts.map((contact) => [contact.id, scoreContact(contact, {
    opportunities: input.opportunities, tasks: input.tasks, now,
  })]));

  for (const task of input.tasks) {
    if (task.status !== 'a_faire' || !task.dueDate) continue;
    const days = daysBetween(task.dueDate, now);
    if (days === null) continue;
    const contact = contactById.get(task.contactId);
    if (days > 0) {
      items.push({
        id: `task-${task.id}`, kind: 'relance_retard', severity: 'urgente',
        title: task.title || 'Tâche en retard', detail: `${days} jour(s) de retard${contact ? ` · ${contactDisplayName(contact)}` : ''}`,
        contactId: task.contactId, opportunityId: task.opportunityId || undefined, dueDate: task.dueDate,
        actionLabel: 'Reprogrammer',
      });
    } else if (days === 0) {
      items.push({
        id: `task-today-${task.id}`, kind: 'tache_aujourdhui', severity: task.priority === 'urgente' ? 'urgente' : 'elevee',
        title: task.title || 'Tâche du jour', detail: `À faire aujourd'hui${contact ? ` · ${contactDisplayName(contact)}` : ''}`,
        contactId: task.contactId, opportunityId: task.opportunityId || undefined, dueDate: task.dueDate,
        actionLabel: 'Terminer',
      });
    }
  }

  for (const contact of input.contacts) {
    if (contact.status === 'archive') continue;
    const score = scores.get(contact.id)!;
    if (contact.nextActionAt) {
      const days = daysBetween(contact.nextActionAt, now);
      if (days !== null && days < 0) {
        items.push({
          id: `next-${contact.id}`, kind: 'rappeler_aujourdhui', severity: days < -2 ? 'urgente' : 'elevee',
          title: contact.nextAction || 'Prochaine action à réaliser',
          detail: `${contactDisplayName(contact)} · prévue le ${contact.nextActionAt}`,
          contactId: contact.id, dueDate: contact.nextActionAt, actionLabel: 'Traiter',
        });
      }
    }
    if (score.heat === 'chaud' && score.openOpportunityCount > 0) {
      items.push({
        id: `hot-${contact.id}`, kind: 'prospect_chaud', severity: 'elevee',
        title: `Prospect chaud : ${contactDisplayName(contact)}`,
        detail: score.reasons.slice(0, 3).map((reason) => reason.label).join(' · '),
        contactId: contact.id, amount: score.openValue || null, actionLabel: 'Ouvrir la fiche',
      });
    }
    if (contact.nextActionAt === '' && contact.nextAction === '' && score.openOpportunityCount === 0 && contact.status === 'actif') {
      items.push({
        id: `nonext-${contact.id}`, kind: 'sans_prochaine_action', severity: 'normale',
        title: `Aucune prochaine action : ${contactDisplayName(contact)}`,
        detail: 'Planifiez une relance pour ne pas perdre le contact.',
        contactId: contact.id, actionLabel: 'Planifier',
      });
    }
    if (contact.type === 'client' && score.daysSinceContact !== null && score.daysSinceContact >= 60) {
      items.push({
        id: `inactive-${contact.id}`, kind: score.daysSinceContact >= 120 ? 'client_a_risque' : 'client_inactif',
        severity: score.daysSinceContact >= 120 ? 'elevee' : 'normale',
        title: `${score.daysSinceContact >= 120 ? 'Client à risque' : 'Client inactif'} : ${contactDisplayName(contact)}`,
        detail: `${score.daysSinceContact} jours sans contact`,
        contactId: contact.id, actionLabel: 'Réactiver',
      });
    }
    if (contact.createdAt && Date.parse(contact.createdAt) > 0) {
      const age = daysBetween(contact.createdAt.slice(0, 10), now);
      if (age !== null && age <= 2 && contact.type === 'prospect') {
        items.push({
          id: `new-${contact.id}`, kind: 'nouveau_contact', severity: 'normale',
          title: `Nouveau prospect : ${contactDisplayName(contact)}`,
          detail: 'Premier contact à qualifier.', contactId: contact.id, actionLabel: 'Qualifier',
        });
      }
    }
  }

  for (const opportunity of input.opportunities) {
    if (!isOpenStage(opportunity.stage)) continue;
    const last = opportunity.updatedAt ? Date.parse(opportunity.updatedAt) : 0;
    const updatedDays = last ? Math.floor((Date.parse(`${now}T00:00:00Z`) - last) / 86_400_000) : null;
    const contact = contactById.get(opportunity.contactId);
    if (updatedDays !== null && updatedDays >= 14) {
      items.push({
        id: `stagnant-${opportunity.id}`, kind: 'opportunite_stagnante', severity: updatedDays >= 30 ? 'urgente' : 'elevee',
        title: `Opportunité stagnante : ${opportunity.title}`,
        detail: `${updatedDays} jours sans mise à jour${contact ? ` · ${contactDisplayName(contact)}` : ''}`,
        contactId: opportunity.contactId, opportunityId: opportunity.id, amount: opportunity.amount,
        actionLabel: 'Relancer',
      });
    }
  }

  for (const finance of input.finance ?? []) {
    items.push({
      id: `fin-${finance.id}`, kind: finance.kind, severity: 'urgente',
      title: finance.label,
      detail: finance.kind === 'promesse_non_respectee' ? 'Promesse de paiement non respectée' : `Créance en retard depuis le ${finance.dueDate}`,
      contactId: finance.contactId, dueDate: finance.dueDate, amount: finance.amount,
      actionLabel: 'Recouvrer',
    });
  }

  const order: Record<ActionItem['severity'], number> = { urgente: 0, elevee: 1, normale: 2 };
  return items
    .sort((a, b) => order[a.severity] - order[b.severity] || (b.amount ?? -1) - (a.amount ?? -1))
    .slice(0, 200);
}

/* -------------------------------------------------------------------------- */
/* Tableau de bord commercial                                                 */
/* -------------------------------------------------------------------------- */

export interface CrmDashboard {
  totalContacts: number;
  prospects: number;
  clients: number;
  newContacts: number;
  openOpportunities: number;
  wonOpportunities: number;
  lostOpportunities: number;
  pipelineValue: number | null;
  weightedPipeline: number | null;
  wonValue: number | null;
  conversionRate: number | null;
  winRate: number | null;
  overdueTasks: number;
  todayTasks: number;
  overdueFollowUps: number;
  hotProspects: number;
  stagnantOpportunities: number;
  topSources: Array<{ source: string; count: number; won: number }>;
}

export function computeCrmDashboard(input: {
  contacts: readonly Contact[];
  opportunities: readonly Opportunity[];
  tasks: readonly CrmTask[];
  now?: string;
  periodDays?: number;
}): CrmDashboard {
  const now = input.now ?? todayIso();
  const period = input.periodDays ?? 30;
  const open = input.opportunities.filter((opportunity) => isOpenStage(opportunity.stage));
  const won = input.opportunities.filter((opportunity) => opportunity.stage === 'gagne');
  const lost = input.opportunities.filter((opportunity) => opportunity.stage === 'perdu');
  const closed = won.length + lost.length;
  const scores = input.contacts.map((contact) => scoreContact(contact, { opportunities: input.opportunities, tasks: input.tasks, now }));
  const openAmounts = open.map((opportunity) => opportunity.amount);
  const wonAmounts = won.map((opportunity) => opportunity.amount);
  const allKnown = (values: Array<number | null>) => values.length > 0 && values.every((value) => value !== null);
  const pipelineValue = allKnown(openAmounts) ? openAmounts.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const weightedPipeline = allKnown(open.map((opportunity) => opportunity.amount === null ? null : opportunity.amount * ((opportunity.probability ?? 0) / 100)))
    ? open.reduce((sum, opportunity) => sum + (opportunity.amount ?? 0) * ((opportunity.probability ?? 0) / 100), 0)
    : null;
  const wonValue = allKnown(wonAmounts) ? wonAmounts.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const sources = new Map<string, { count: number; won: number }>();
  for (const contact of input.contacts) {
    const key = contact.source || 'non renseignée';
    const entry = sources.get(key) ?? { count: 0, won: 0 };
    entry.count += 1;
    sources.set(key, entry);
  }
  for (const opportunity of won) {
    const contact = input.contacts.find((item) => item.id === opportunity.contactId);
    const key = contact?.source || opportunity.source || 'non renseignée';
    const entry = sources.get(key) ?? { count: 0, won: 0 };
    entry.won += 1;
    sources.set(key, entry);
  }

  const nowMs = Date.parse(`${now}T00:00:00Z`);
  const tasksToday = input.tasks.filter((task) => task.status === 'a_faire' && task.dueDate === now).length;
  const overdueTasks = input.tasks.filter((task) => {
    if (task.status !== 'a_faire') return false;
    const days = daysBetween(task.dueDate, now);
    return days !== null && days > 0;
  }).length;
  const overdueFollowUps = input.contacts.filter((contact) => {
    if (!contact.nextActionAt) return false;
    const days = daysBetween(contact.nextActionAt, now);
    return days !== null && days < 0;
  }).length;

  return {
    totalContacts: input.contacts.length,
    prospects: input.contacts.filter((contact) => contact.type === 'prospect').length,
    clients: input.contacts.filter((contact) => contact.type === 'client').length,
    newContacts: input.contacts.filter((contact) => {
      const age = contact.createdAt ? daysBetween(contact.createdAt.slice(0, 10), now) : null;
      return age !== null && age <= period;
    }).length,
    openOpportunities: open.length,
    wonOpportunities: won.length,
    lostOpportunities: lost.length,
    pipelineValue,
    weightedPipeline,
    wonValue,
    conversionRate: input.contacts.length ? Math.round((input.contacts.filter((contact) => contact.type === 'client').length / input.contacts.length) * 100) : null,
    winRate: closed ? Math.round((won.length / closed) * 100) : null,
    overdueTasks,
    todayTasks: tasksToday,
    overdueFollowUps,
    hotProspects: scores.filter((score) => score.heat === 'chaud').length,
    stagnantOpportunities: open.filter((opportunity) => {
      const last = opportunity.updatedAt ? Date.parse(opportunity.updatedAt) : 0;
      return last && Number.isFinite(nowMs) ? (nowMs - last) / 86_400_000 >= 14 : false;
    }).length,
    topSources: Array.from(sources.entries())
      .map(([source, entry]) => ({ source, ...entry }))
      .sort((a, b) => b.count - a.count || b.won - a.won)
      .slice(0, 5),
  };
}

/* -------------------------------------------------------------------------- */
/* Segments                                                                   */
/* -------------------------------------------------------------------------- */

export function contactMatchesFilters(contact: Contact, filters: SegmentFilters, score: ContactScore, openValue: number, overdueTasks: number): boolean {
  const needle = filters.query.trim().toLowerCase();
  if (needle) {
    const haystack = [
      contactDisplayName(contact), contact.company, contact.email, contact.phone,
      contact.whatsapp, contact.city, contact.country, contact.owner, contact.tags.join(' '),
    ].join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (filters.type !== 'tous' && contact.type !== filters.type) return false;
  if (filters.status !== 'tous' && contact.status !== filters.status) return false;
  if (filters.source && contact.source !== filters.source) return false;
  if (filters.tag && !contact.tags.includes(filters.tag.toLowerCase())) return false;
  if (filters.owner && !normalizeName(contact.owner).includes(normalizeName(filters.owner))) return false;
  if (filters.city && normalizeName(contact.city) !== normalizeName(filters.city)) return false;
  if (filters.country && normalizeName(contact.country) !== normalizeName(filters.country)) return false;
  if (filters.inactiveDays !== null && (score.daysSinceContact === null || score.daysSinceContact < filters.inactiveDays)) return false;
  if (filters.minScore !== null && score.score < filters.minScore) return false;
  if (filters.priority !== 'toutes' && score.priority !== filters.priority) return false;
  if (filters.minOpenValue !== null && openValue < filters.minOpenValue) return false;
  if (filters.hasOverdueTask && overdueTasks === 0) return false;
  if (filters.hasOpenOpportunity && score.openOpportunityCount === 0) return false;
  if (filters.atRisk && !(contact.type === 'client' && score.daysSinceContact !== null && score.daysSinceContact >= 90)) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Import CSV                                                                 */
/* -------------------------------------------------------------------------- */

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
        if (source[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',' || char === ';' || char === '\t') {
      row.push(field); field = '';
    } else if (char === '\n') {
      row.push(field); field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else if (char !== '\r') {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

export const CSV_FIELDS: readonly { key: keyof Contact; label: string; aliases: readonly string[] }[] = [
  { key: 'firstName', label: 'Prénom', aliases: ['prenom', 'first name', 'firstname', 'first'] },
  { key: 'lastName', label: 'Nom', aliases: ['nom', 'last name', 'lastname', 'name', 'nom complet'] },
  { key: 'company', label: 'Entreprise', aliases: ['entreprise', 'societe', 'company', 'organisation'] },
  { key: 'jobTitle', label: 'Fonction', aliases: ['fonction', 'poste', 'job', 'title'] },
  { key: 'phone', label: 'Téléphone', aliases: ['telephone', 'tel', 'phone', 'mobile'] },
  { key: 'whatsapp', label: 'WhatsApp', aliases: ['whatsapp', 'wa'] },
  { key: 'email', label: 'E-mail', aliases: ['email', 'e-mail', 'mail', 'courriel'] },
  { key: 'address', label: 'Adresse', aliases: ['adresse', 'address', 'rue'] },
  { key: 'city', label: 'Ville', aliases: ['ville', 'city'] },
  { key: 'country', label: 'Pays', aliases: ['pays', 'country'] },
  { key: 'source', label: 'Source', aliases: ['source', 'origine', 'provenance'] },
  { key: 'type', label: 'Type', aliases: ['type', 'categorie', 'category'] },
  { key: 'tags', label: 'Tags', aliases: ['tags', 'etiquettes', 'labels'] },
  { key: 'owner', label: 'Responsable', aliases: ['responsable', 'owner', 'commercial'] },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'commentaire'] },
  { key: 'lastContactAt', label: 'Dernier contact', aliases: ['dernier contact', 'last contact', 'date contact'] },
];

function normalizeHeader(value: string): string {
  return normalizeName(value).replace(/\s+/g, ' ');
}

/** Détection automatique des colonnes ; l'utilisateur peut toujours la corriger. */
export function guessMapping(headers: readonly string[]): Record<number, keyof Contact | 'ignore'> {
  const mapping: Record<number, keyof Contact | 'ignore'> = {};
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const match = CSV_FIELDS.find((field) => field.aliases.some((alias) => normalizeHeader(alias) === normalized)
      || normalizeHeader(field.label) === normalized);
    mapping[index] = match ? match.key : 'ignore';
  });
  return mapping;
}

export interface ImportRowResult {
  row: number;
  data: Record<string, unknown> | null;
  errors: string[];
}

export function buildContactsFromRows(rows: readonly string[][], mapping: Record<number, keyof Contact | 'ignore'>, fallbackSource = 'import'): ImportRowResult[] {
  return rows.map((cells, index) => {
    const errors: string[] = [];
    const data: Record<string, unknown> = {};
    const tagList: string[] = [];
    cells.forEach((cell, column) => {
      const key = mapping[column];
      if (!key || key === 'ignore') return;
      const value = cell.trim();
      if (!value) return;
      if (key === 'tags') { tagList.push(...value.split(/[,;|]/).map((tag) => tag.trim())); return; }
      if (key === 'firstName' || key === 'lastName' || key === 'company' || key === 'jobTitle'
        || key === 'address' || key === 'city' || key === 'country' || key === 'owner' || key === 'notes'
        || key === 'phone' || key === 'whatsapp' || key === 'email') {
        data[key] = value.slice(0, key === 'notes' ? 4000 : 240);
        return;
      }
      if (key === 'lastContactAt') {
        const normalized = value.replace(/\//g, '-');
        const [a, b, c] = normalized.split('-');
        const iso = a && b && c ? (a.length === 4 ? `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}` : `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`) : '';
        if (iso && dateOnly(iso)) data.lastContactAt = iso;
        else errors.push('Date de dernier contact invalide');
        return;
      }
      if (key === 'source') { data.source = value.toLowerCase().slice(0, 40); return; }
      if (key === 'type') {
        const normalizedType = normalizeName(value);
        const type = CONTACT_TYPES.find((entry) => normalizeName(entry.value) === normalizedType || normalizeName(entry.label) === normalizedType);
        data.type = type?.value ?? 'prospect';
      }
    });
    if (tagList.length) data.tags = tagList.map((tag) => tag.toLowerCase()).slice(0, 20);
    if (!data.type) data.type = 'prospect';
    if (!data.source) data.source = fallbackSource;
    if (!data.firstName && !data.lastName && !data.company && !data.email && !data.phone) {
      errors.push('Ligne sans nom, entreprise, e-mail ni téléphone');
    }
    if (errors.length) return { row: index + 2, data: null, errors };
    return { row: index + 2, data, errors: [] };
  });
}

export function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function contactsToCsv(contacts: readonly Contact[]): string {
  const headers = ['Prénom', 'Nom', 'Entreprise', 'Fonction', 'Téléphone', 'WhatsApp', 'E-mail', 'Ville', 'Pays', 'Source', 'Type', 'Tags', 'Responsable', 'Dernier contact', 'Prochaine action', 'Statut'];
  const lines = contacts.map((contact) => [
    contact.firstName, contact.lastName, contact.company, contact.jobTitle, contact.phone,
    contact.whatsapp, contact.email, contact.city, contact.country, contact.source, contact.type,
    contact.tags.join('|'), contact.owner, contact.lastContactAt, contact.nextAction, contact.status,
  ].map(csvEscape).join(','));
  return [headers.join(','), ...lines].join('\r\n');
}

export function opportunitiesToCsv(opportunities: readonly Opportunity[]): string {
  const headers = ['Titre', 'Contact', 'Étape', 'Montant', 'Devise', 'Probabilité', 'Conclusion prévue', 'Responsable', 'Produit', 'Source', 'Motif de perte'];
  return [headers.join(','), ...opportunities.map((opportunity) => [
    opportunity.title, opportunity.contactId, opportunity.stage, opportunity.amount ?? '',
    opportunity.currency, opportunity.probability ?? '', opportunity.expectedCloseAt, opportunity.owner,
    opportunity.product, opportunity.source, opportunity.lostReason,
  ].map(csvEscape).join(','))].join('\r\n');
}

export function tasksToCsv(tasks: readonly CrmTask[]): string {
  const headers = ['Tâche', 'Type', 'Contact', 'Responsable', 'Priorité', 'Échéance', 'Heure', 'Statut', 'Résultat'];
  return [headers.join(','), ...tasks.map((task) => [
    task.title, task.type, task.contactId, task.owner, task.priority, task.dueDate,
    task.dueTime, task.status, task.outcome,
  ].map(csvEscape).join(','))].join('\r\n');
}

/* -------------------------------------------------------------------------- */
/* Relances CRM                                                               */
/* -------------------------------------------------------------------------- */

export const MESSAGE_TEMPLATES: readonly { id: string; label: string; channel: 'whatsapp' | 'email' | 'sms'; body: string }[] = [
  { id: 'premier_contact', label: 'Premier contact', channel: 'whatsapp', body: 'Bonjour {{contact}}, je me permets de vous contacter au sujet de {{entreprise}}. Seriez-vous disponible pour un échange rapide cette semaine ? — {{responsable}}' },
  { id: 'apres_interet', label: 'Réponse après intérêt', channel: 'whatsapp', body: 'Merci pour votre intérêt, {{contact}}. Voici la proposition pour {{produit}} ({{montant}}). Je reste disponible pour l’ajuster. — {{responsable}}' },
  { id: 'rappel_rdv', label: 'Rappel de rendez-vous', channel: 'sms', body: 'Rappel : rendez-vous prévu le {{date}}. À bientôt, {{responsable}}.' },
  { id: 'relance_proposition', label: 'Relance après proposition', channel: 'email', body: 'Bonjour {{contact}},\n\nJe reviens vers vous concernant la proposition {{produit}} ({{montant}}). Avez-vous pu en prendre connaissance ?\n\nBien cordialement,\n{{responsable}}' },
  { id: 'sans_reponse', label: 'Relance sans réponse', channel: 'whatsapp', body: 'Bonjour {{contact}}, je n’ai pas eu de retour à mon précédent message. Souhaitez-vous que nous en reparlions ? — {{responsable}}' },
  { id: 'negociation', label: 'Relance de négociation', channel: 'email', body: 'Bonjour {{contact}},\n\nSuite à nos échanges, je vous propose de finaliser les points ouverts sur {{produit}}. Êtes-vous disponible cette semaine ?\n\n{{responsable}}' },
  { id: 'reactivation', label: 'Réactivation client', channel: 'whatsapp', body: 'Bonjour {{contact}}, cela fait un moment ! J’espère que tout va bien chez {{entreprise}}. Nous avons de nouvelles choses qui pourraient vous intéresser. — {{responsable}}' },
  { id: 'fidelisation', label: 'Fidélisation', channel: 'email', body: 'Bonjour {{contact}},\n\nMerci pour votre confiance. Nous serions ravis de recueillir votre avis et de vous présenter nos nouveautés.\n\n{{responsable}}' },
  { id: 'anniversaire', label: 'Anniversaire client', channel: 'whatsapp', body: 'Joyeux anniversaire {{contact}} ! Toute l’équipe vous souhaite une excellente journée.' },
  { id: 'feedback', label: 'Demande de feedback', channel: 'email', body: 'Bonjour {{contact}},\n\nVotre avis nous aide à progresser. Auriez-vous quelques minutes pour nous partager votre retour ?\n\nMerci,\n{{responsable}}' },
];

export interface TemplateVariables {
  contact?: string;
  entreprise?: string;
  produit?: string;
  montant?: string;
  proposition?: string;
  date?: string;
  responsable?: string;
}

export function renderTemplate(body: string, variables: TemplateVariables): string {
  return body.replace(/{{\s*([a-z_]+)\s*}}/gi, (_match, key: string) => {
    const value = variables[key.toLowerCase() as keyof TemplateVariables];
    return value && value.trim() ? value : `[${key}]`;
  });
}

export function whatsappLink(phone: string, message: string): string {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export function mailtoLink(email: string, subject: string, message: string): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
}
