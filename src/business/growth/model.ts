/**
 * VYORA Business Growth — modèle de données du cockpit de croissance.
 *
 * Les enregistrements sont persistés dans la mémoire métier consentie
 * (`saas_business.memory_items`), qui est déjà isolée par utilisateur côté
 * serveur. Aucun enregistrement n'est créé localement : toute écriture passe
 * par l'Edge Function `business-grow` puis par les fonctions SQL dédiées.
 */

import type { BusinessMemory, BusinessMemoryItem } from '../api';

export const GROWTH_CATEGORY = {
  goal: 'growth_goal',
  competitor: 'growth_competitor',
  signal: 'growth_signal',
  prospect: 'growth_prospect',
  strategy: 'growth_strategy',
} as const;

export type GrowthRecordKind = keyof typeof GROWTH_CATEGORY;

export interface GrowthGoal {
  id: string;
  title: string;
  metric: string;
  target: number;
  current: number;
  unit: string;
  dueDate: string;
  priority: 'haute' | 'moyenne' | 'basse';
  status: 'en_cours' | 'atteint' | 'abandonne';
  updatedAt: string;
}

export type ProspectStage = 'prospect' | 'contacte' | 'qualifie' | 'proposition' | 'gagne' | 'perdu';

export interface GrowthProspect {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  stage: ProspectStage;
  value: number;
  currency: string;
  nextAction: string;
  nextActionAt: string;
  notes: string;
  updatedAt: string;
}

export interface GrowthCompetitor {
  id: string;
  name: string;
  url: string;
  positioning: string;
  strengths: string;
  weaknesses: string;
  notes: string;
  updatedAt: string;
}

export interface GrowthSignal {
  id: string;
  title: string;
  kind: 'tendance' | 'contenu' | 'produit' | 'publicite';
  platform: string;
  url: string;
  metricLabel: string;
  metricValue: number;
  observedAt: string;
  notes: string;
  updatedAt: string;
}

export interface GrowthStrategy {
  id: string;
  title: string;
  horizon: string;
  summary: string;
  actions: string[];
  source: 'utilisateur' | 'ia';
  createdAt: string;
}

export interface CompanyProfile {
  legalName: string;
  activity: string;
  description: string;
  market: string;
  audience: string;
  positioning: string;
  country: string;
  website: string;
  instagram: string;
  facebook: string;
  tiktok: string;
  youtube: string;
  whatsapp: string;
  storeUrl: string;
}

export const EMPTY_COMPANY_PROFILE: CompanyProfile = {
  legalName: '', activity: '', description: '', market: '', audience: '',
  positioning: '', country: '', website: '', instagram: '', facebook: '',
  tiktok: '', youtube: '', whatsapp: '', storeUrl: '',
};

export const PROSPECT_STAGES: { id: ProspectStage; label: string; tone: string }[] = [
  { id: 'prospect', label: 'Prospect', tone: 'text-slate-300' },
  { id: 'contacte', label: 'Contacté', tone: 'text-cyan-200' },
  { id: 'qualifie', label: 'Qualifié', tone: 'text-sky-200' },
  { id: 'proposition', label: 'Proposition', tone: 'text-violet-200' },
  { id: 'gagne', label: 'Gagné', tone: 'text-emerald-300' },
  { id: 'perdu', label: 'Perdu', tone: 'text-rose-300' },
];

export type GrowthCollection =
  | { kind: 'goal'; items: GrowthGoal[] }
  | { kind: 'prospect'; items: GrowthProspect[] }
  | { kind: 'competitor'; items: GrowthCompetitor[] }
  | { kind: 'signal'; items: GrowthSignal[] }
  | { kind: 'strategy'; items: GrowthStrategy[] };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, max = 800): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFrom(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

export function profileFromMemory(memory: BusinessMemory | null | undefined): CompanyProfile {
  const source = asRecord(memory?.profile);
  const profile = { ...EMPTY_COMPANY_PROFILE };
  for (const key of Object.keys(EMPTY_COMPANY_PROFILE) as (keyof CompanyProfile)[]) {
    profile[key] = text(source[key], 600);
  }
  return profile;
}

export function mergeCompanyProfile(
  existing: Record<string, unknown> | null | undefined,
  patch: Partial<CompanyProfile>,
): Record<string, unknown> {
  const base = { ...asRecord(existing) };
  for (const [key, value] of Object.entries(patch)) {
    const clean = typeof value === 'string' ? value.trim().slice(0, 600) : value;
    if (clean === '' || clean === null || clean === undefined) delete base[key];
    else base[key] = clean;
  }
  base.updatedAt = new Date().toISOString();
  return base;
}

function itemsByCategory(memory: BusinessMemory | null | undefined, category: string): BusinessMemoryItem[] {
  const items = Array.isArray(memory?.items) ? memory?.items ?? [] : [];
  return items.filter((item) => item && item.category === category);
}

function baseItem(item: BusinessMemoryItem): { id: string; updatedAt: string } {
  return {
    id: item.id,
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
  };
}

function goalStatus(value: unknown): GrowthGoal['status'] {
  return value === 'atteint' || value === 'abandonne' ? value : 'en_cours';
}

function goalPriority(value: unknown): GrowthGoal['priority'] {
  return value === 'haute' || value === 'basse' ? value : 'moyenne';
}

export function readGoals(memory: BusinessMemory | null | undefined): GrowthGoal[] {
  return itemsByCategory(memory, GROWTH_CATEGORY.goal).map((item) => {
    const content = asRecord(item.content);
    return {
      ...baseItem(item),
      title: text(content.title, 160),
      metric: text(content.metric, 120),
      target: numberValue(content.target),
      current: numberValue(content.current),
      unit: text(content.unit, 40),
      dueDate: text(content.dueDate, 40),
      priority: goalPriority(content.priority),
      status: goalStatus(content.status),
    };
  }).filter((goal) => goal.title.length > 0);
}

export function readProspects(memory: BusinessMemory | null | undefined): GrowthProspect[] {
  return itemsByCategory(memory, GROWTH_CATEGORY.prospect).map((item) => {
    const content = asRecord(item.content);
    const stageRaw = text(content.stage, 20);
    const stage = PROSPECT_STAGES.some((entry) => entry.id === stageRaw)
      ? stageRaw as ProspectStage
      : 'prospect';
    return {
      ...baseItem(item),
      name: text(content.name, 160),
      company: text(content.company, 160),
      email: text(content.email, 200),
      phone: text(content.phone, 60),
      stage,
      value: Math.max(0, numberValue(content.value)),
      currency: text(content.currency, 8) || 'XOF',
      nextAction: text(content.nextAction, 240),
      nextActionAt: text(content.nextActionAt, 40),
      notes: text(content.notes, 1200),
    };
  }).filter((prospect) => prospect.name.length > 0 || prospect.company.length > 0);
}

export function readCompetitors(memory: BusinessMemory | null | undefined): GrowthCompetitor[] {
  return itemsByCategory(memory, GROWTH_CATEGORY.competitor).map((item) => {
    const content = asRecord(item.content);
    return {
      ...baseItem(item),
      name: text(content.name, 160),
      url: text(content.url, 500),
      positioning: text(content.positioning, 600),
      strengths: text(content.strengths, 800),
      weaknesses: text(content.weaknesses, 800),
      notes: text(content.notes, 1200),
    };
  }).filter((competitor) => competitor.name.length > 0);
}

export function readSignals(memory: BusinessMemory | null | undefined): GrowthSignal[] {
  return itemsByCategory(memory, GROWTH_CATEGORY.signal).map((item) => {
    const content = asRecord(item.content);
    const kindRaw = text(content.kind, 20);
    const kind = ['tendance', 'contenu', 'produit', 'publicite'].includes(kindRaw)
      ? kindRaw as GrowthSignal['kind']
      : 'tendance';
    return {
      ...baseItem(item),
      title: text(content.title, 200),
      kind,
      platform: text(content.platform, 80),
      url: text(content.url, 500),
      metricLabel: text(content.metricLabel, 60),
      metricValue: Math.max(0, numberValue(content.metricValue)),
      observedAt: text(content.observedAt, 40),
      notes: text(content.notes, 1200),
    };
  }).filter((signal) => signal.title.length > 0);
}

export function readStrategies(memory: BusinessMemory | null | undefined): GrowthStrategy[] {
  return itemsByCategory(memory, GROWTH_CATEGORY.strategy).map((item) => {
    const content = asRecord(item.content);
    const actions = Array.isArray(content.actions)
      ? content.actions.map((entry) => text(entry, 400)).filter(Boolean).slice(0, 12)
      : [];
    return {
      ...baseItem(item),
      title: text(content.title, 200),
      horizon: text(content.horizon, 80),
      summary: text(content.summary, 4000),
      actions,
      source: (content.source === 'ia' ? 'ia' : 'utilisateur') as GrowthStrategy['source'],
      createdAt: text(content.createdAt, 40) || baseItem(item).updatedAt,
    };
  }).filter((strategy) => strategy.title.length > 0);
}

export function goalProgress(goal: GrowthGoal): number {
  if (goal.target <= 0) return goal.status === 'atteint' ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round((goal.current / goal.target) * 100)));
}

export interface PipelineSummary {
  openCount: number;
  openValue: number;
  wonValue: number;
  lostValue: number;
  totalCount: number;
  byStage: Record<ProspectStage, number>;
}

export function pipelineSummary(prospects: GrowthProspect[]): PipelineSummary {
  const byStage = PROSPECT_STAGES.reduce((acc, stage) => {
    acc[stage.id] = 0;
    return acc;
  }, {} as Record<ProspectStage, number>);
  let openValue = 0;
  let wonValue = 0;
  let lostValue = 0;
  let openCount = 0;
  for (const prospect of prospects) {
    byStage[prospect.stage] = (byStage[prospect.stage] ?? 0) + 1;
    if (prospect.stage === 'gagne') wonValue += prospect.value;
    else if (prospect.stage === 'perdu') lostValue += prospect.value;
    else {
      openValue += prospect.value;
      openCount += 1;
    }
  }
  return {
    openCount, openValue, wonValue, lostValue,
    totalCount: prospects.length, byStage,
  };
}

export function upcomingActions(prospects: GrowthProspect[], limit = 5): GrowthProspect[] {
  return prospects
    .filter((prospect) => prospect.nextAction.trim() && !['gagne', 'perdu'].includes(prospect.stage))
    .sort((a, b) => {
      const aTime = a.nextActionAt ? Date.parse(a.nextActionAt) : Number.POSITIVE_INFINITY;
      const bTime = b.nextActionAt ? Date.parse(b.nextActionAt) : Number.POSITIVE_INFINITY;
      return (Number.isFinite(aTime) ? aTime : Number.POSITIVE_INFINITY)
        - (Number.isFinite(bTime) ? bTime : Number.POSITIVE_INFINITY);
    })
    .slice(0, limit);
}

export function formatGrowthAmount(value: number, currency = 'XOF'): string {
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : 'XOF';
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency', currency: safeCurrency, maximumFractionDigits: 0,
    }).format(Number.isFinite(value) ? value : 0);
  } catch {
    return `${Math.round(value).toLocaleString('fr-FR')} ${safeCurrency}`;
  }
}

export interface CatalogImportProduct {
  name: string;
  description: string;
  priceAmount: number | null;
  priceCurrency: string;
  productUrl: string;
  benefits: string[];
}

export interface CatalogImportResult {
  ok: boolean;
  products: CatalogImportProduct[];
  errors: string[];
}

const CSV_COLUMNS = ['name', 'price', 'currency', 'description', 'url', 'benefits'];

/**
 * Import de catalogue à partir d'un JSON (tableau d'objets) ou d'un CSV
 * collé par l'utilisateur. Aucune donnée n'est inventée : les lignes
 * incomplètes sont signalées et ignorées.
 */
export function parseCatalogImport(raw: string): CatalogImportResult {
  const errors: string[] = [];
  const products: CatalogImportProduct[] = [];
  const input = raw.trim();
  if (!input) return { ok: false, products, errors: ['Collez un JSON ou un CSV de produits.'] };

  const push = (entry: Record<string, unknown>, index: number) => {
    const name = text(entry.name ?? entry.title ?? entry.nom ?? entry.produit, 160);
    if (!name) {
      errors.push(`Ligne ${index + 1} : le nom du produit est obligatoire.`);
      return;
    }
    const rawPrice = entry.price ?? entry.price_amount ?? entry.prix ?? null;
    const numericPrice = rawPrice === null || rawPrice === '' ? null : numberValue(rawPrice, Number.NaN);
    if (rawPrice !== null && rawPrice !== '' && !Number.isFinite(numericPrice)) {
      errors.push(`Ligne ${index + 1} : prix invalide pour « ${name} ».`);
      return;
    }
    const benefitsRaw = entry.benefits ?? entry.avantages ?? entry.key_benefits;
    const benefits = Array.isArray(benefitsRaw)
      ? benefitsRaw.map((value) => text(value, 200)).filter(Boolean).slice(0, 8)
      : text(benefitsRaw, 600).split(/[;|]/).map((value) => value.trim()).filter(Boolean).slice(0, 8);
    products.push({
      name,
      description: text(entry.description ?? entry.summary ?? entry.resume, 2000),
      priceAmount: Number.isFinite(numericPrice) ? numericPrice : null,
      priceCurrency: (text(entry.currency ?? entry.devise, 8) || 'XOF').toUpperCase(),
      productUrl: text(entry.url ?? entry.product_url ?? entry.link, 500),
      benefits,
    });
  };

  if (input.startsWith('[') || input.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, products, errors: ['Le JSON fourni est invalide.'] };
    }
    const list = Array.isArray(parsed) ? parsed : asRecord(parsed).products;
    if (!Array.isArray(list)) {
      return { ok: false, products, errors: ['Le JSON doit contenir un tableau de produits.'] };
    }
    list.slice(0, 200).forEach((entry, index) => push(asRecord(entry), index));
  } else {
    const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) return { ok: false, products, errors: ['Le CSV doit contenir un en-tête et au moins une ligne.'] };
    const header = lines[0].split(/[;,\t]/).map((value) => value.trim().toLowerCase());
    for (const column of ['name', 'price']) {
      if (!header.includes(column)) errors.push(`Colonne obligatoire manquante : ${column}.`);
    }
    if (errors.length) return { ok: false, products, errors };
    lines.slice(1, 201).forEach((line, index) => {
      const cells = line.split(/[;,\t]/);
      const entry: Record<string, unknown> = {};
      header.forEach((column, cellIndex) => {
        if (CSV_COLUMNS.includes(column)) entry[column] = cells[cellIndex]?.trim() ?? '';
      });
      push(entry, index);
    });
  }

  if (products.length === 0) errors.push('Aucun produit valide n’a été trouvé.');
  return { ok: products.length > 0, products, errors };
}

export interface GrowthSnapshot {
  company: CompanyProfile;
  goals: GrowthGoal[];
  prospects: GrowthProspect[];
  competitors: GrowthCompetitor[];
  signals: GrowthSignal[];
  products: Array<{ name: string; description?: string | null; price?: string | null }>;
  workspaceName?: string;
}

export type GrowthAiTask = 'diagnostic' | 'strategy' | 'competition' | 'content' | 'sales';

const TASK_BRIEF: Record<GrowthAiTask, string> = {
  diagnostic: 'Réalise un diagnostic business actionnable : forces observables, frictions, priorités et risques.',
  strategy: 'Propose un plan de croissance 30/60/90 jours avec actions concrètes, responsables et indicateurs.',
  competition: 'Analyse le positionnement face aux concurrents fournis, les écarts et les angles de différenciation.',
  content: 'Propose une stratégie de contenu UGC : angles, hooks, formats, plateformes et briefs prêts à produire.',
  sales: 'Analyse le pipeline commercial fourni, identifie les blocages et propose des actions de conversion.',
};

/**
 * Construit une demande IA à partir des DONNÉES RÉELLES de l'entreprise.
 * Le prompt interdit explicitement d'inventer des chiffres et précise que
 * l'analyse ne s'appuie pas sur une navigation web en temps réel.
 */
export function buildGrowthPrompt(task: GrowthAiTask, snapshot: GrowthSnapshot): string {
  const payload = {
    entreprise: snapshot.workspaceName ? { ...snapshot.company, espace: snapshot.workspaceName } : snapshot.company,
    objectifs: snapshot.goals.slice(0, 12),
    concurrents: snapshot.competitors.slice(0, 10),
    signaux_marche_et_contenus: snapshot.signals.slice(0, 15),
    prospects: snapshot.prospects.slice(0, 20),
    produits: snapshot.products.slice(0, 20),
  };
  return [
    'Tu es le moteur d’intelligence commerciale VYORA Business Grow.',
    TASK_BRIEF[task],
    'Règles strictes :',
    '- Appuie-toi UNIQUEMENT sur les données fournies ci-dessous et sur des connaissances générales clairement identifiables comme telles.',
    '- N’invente aucun chiffre, aucune statistique, aucun nom de concurrent ni aucune performance.',
    '- Si une donnée manque, dis-le explicitement et indique quelle information collecter.',
    '- Ne prétends pas avoir consulté le web, les réseaux sociaux ou une boutique : ce n’est pas le cas.',
    '- Réponds en français, structuré avec des titres courts, des listes et des prochaines actions concrètes.',
    `Données entreprise (JSON) : ${JSON.stringify(payload)}`,
  ].join('\n');
}

export function growthRecordCounts(memory: BusinessMemory | null | undefined) {
  return {
    goals: readGoals(memory).length,
    prospects: readProspects(memory).length,
    competitors: readCompetitors(memory).length,
    signals: readSignals(memory).length,
    strategies: readStrategies(memory).length,
  };
}

export function healthLabel(consent: boolean, recordCount: number): string {
  if (!consent) return 'Mémoire métier désactivée';
  if (recordCount === 0) return 'Contexte à compléter';
  return 'Contexte actif';
}

export function isGoalOverdue(goal: GrowthGoal, now = new Date()): boolean {
  if (!goal.dueDate || goal.status !== 'en_cours') return false;
  const due = Date.parse(goal.dueDate);
  return Number.isFinite(due) && due < now.getTime() && goalProgress(goal) < 100;
}

export function truthyFlag(value: unknown): boolean {
  return boolFrom(value);
}
