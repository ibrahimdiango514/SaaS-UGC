/**
 * Analyse déterministe des données Business Growth. Aucun SQL, aucun appel IA,
 * aucune donnée de démonstration. Les stocks/encours sont un instantané ; les
 * mouvements financiers sont filtrés sur la période explicitement demandée.
 */
export type ReportType = 'commercial' | 'financial' | 'customers' | 'recovery' | 'operations' | 'health';
export type Priority = 'critique' | 'élevée' | 'moyenne' | 'faible';
export interface SourceRecord { id: string; data: Record<string, unknown>; updated_at?: string }
export interface BusinessSnapshot { modules: Record<string, SourceRecord[]>; crm: SourceRecord[]; crmConsent: boolean }
export interface Recommendation {
  id: string; kind: string; module: string; priority: Priority; problem: string;
  evidence: string[]; potentialImpact: string; action: string;
  sourceCategory: string; sourceRecordId: string;
  facts: Record<string, number | string>;
}
export interface Coverage { module: string; category: string; count: number; status: 'available' | 'empty' | 'consent_required'; truncated: boolean }
export interface ReportMetric { label: string; value: number; unit: string; basis: string }
export interface BusinessReport {
  type: ReportType; period: { from: string; to: string }; asOf: string;
  coverage: Coverage[]; metrics: ReportMetric[]; recommendations: Recommendation[];
  totalRecommendations: number; warnings: string[];
}

const CATEGORIES: Record<string, string> = {
  growth_prospect: 'Smart CRM', bg_module_lead_rescue: 'Lead Rescue',
  bg_module_sales_automation: 'Sales Automation', bg_module_customer_recovery: 'Customer Recovery',
  bg_module_payment_recovery: 'Payment Recovery', bg_module_order_cart_recovery: 'Order & Cart Recovery',
  bg_module_social_growth: 'Social Growth', bg_module_smart_inventory: 'Smart Inventory',
  bg_module_finance_intelligence: 'Finance Intelligence', bg_module_operations_manager: 'Operations Manager',
  bg_module_customer_support_ai: 'Customer Support AI', bg_module_supplier_delivery: 'Supplier & Delivery',
  bg_module_dispute_shield: 'Dispute Shield', bg_module_revenue_leak: 'Revenue Leak Detector',
};
const ALL = Object.keys(CATEGORIES);
const REPORT_CATEGORIES: Record<ReportType, string[]> = {
  commercial: ['growth_prospect','bg_module_lead_rescue','bg_module_sales_automation','bg_module_order_cart_recovery'],
  financial: ['bg_module_finance_intelligence','bg_module_payment_recovery','bg_module_dispute_shield'],
  customers: ['growth_prospect','bg_module_customer_recovery','bg_module_customer_support_ai','bg_module_dispute_shield'],
  recovery: ['bg_module_lead_rescue','bg_module_payment_recovery','bg_module_order_cart_recovery','bg_module_customer_recovery','bg_module_revenue_leak'],
  operations: ['bg_module_smart_inventory','bg_module_operations_manager','bg_module_customer_support_ai','bg_module_supplier_delivery','bg_module_sales_automation','bg_module_social_growth'],
  health: ALL,
};
const PRIORITY_ORDER: Record<Priority, number> = { critique: 0, élevée: 1, moyenne: 2, faible: 3 };
// Projection fermée pour le modèle : uniquement des nombres et dates validés,
// jamais de nom, note, contact ou texte arbitraire fourni dans une fiche.
const MODEL_FACT_FIELDS: Record<string, { numbers?: string[]; dates?: string[] }> = {
  crm_overdue: { dates: ['nextActionAt'] }, lead_stale: { numbers: ['estimatedValue'], dates: ['lastContactAt'] },
  invoice_overdue: { numbers: ['amount','reminderLevel'], dates: ['dueDate'] },
  cart_open: { numbers: ['amount'], dates: ['abandonedAt'] }, customer_risk: { numbers: ['totalSpent'], dates: ['lastOrderAt'] },
  stock_low: { numbers: ['stock','threshold'] }, task_blocked: { dates: ['dueDate'] },
  delivery_late: { dates: ['expectedAt'] }, dispute_open: { numbers: ['amount'], dates: ['openedAt'] },
  leak_recorded: { numbers: ['amount'], dates: ['detectedAt'] }, content_late: { dates: ['scheduledAt'] },
  finance_duplicate: { numbers: ['amount'], dates: ['occurredAt'] },
};
const DAY = 86_400_000;

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}
function numeric(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000_000_000 ? n : null;
}
export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function age(date: unknown, asOf: string): number | null {
  if (!validDate(date)) return null;
  return Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY);
}
function money(value: number): string { return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(value)} FCFA`; }
function label(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) { const s = text(data[key]); if (s) return `« ${s} »`; }
  return 'sans libellé';
}
function valueImpact(data: Record<string, unknown>, key: string, basis: string): string {
  const value = numeric(data[key]);
  return value === null ? 'Impact financier non quantifiable avec les données disponibles.' : `${basis} : ${money(value)}. Ce montant n’est pas une récupération garantie.`;
}
function sourceRows(snapshot: BusinessSnapshot, category: string): SourceRecord[] {
  const source = category === 'growth_prospect' ? (snapshot.crmConsent ? snapshot.crm : []) : snapshot.modules?.[category];
  return Array.isArray(source) ? source.slice(0, 500).filter((r) => r && typeof r.id === 'string') : [];
}
export function isReportType(value: unknown): value is ReportType {
  return typeof value === 'string' && Object.hasOwn(REPORT_CATEGORIES, value);
}
export function validPeriod(from: unknown, to: unknown): from is string {
  return validDate(from) && validDate(to) && from <= to
    && Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) <= 365 * DAY;
}
export function defaultPeriod(now = new Date()): { from: string; to: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from: new Date(end.getTime() - 29 * DAY).toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export function buildBusinessReport(snapshot: BusinessSnapshot, type: ReportType, from: string, to: string, now = new Date()): BusinessReport {
  if (!isReportType(type) || !validPeriod(from, to)) throw new Error('Invalid report type or period');
  const asOf = now.toISOString().slice(0, 10);
  const selected = REPORT_CATEGORIES[type];
  const coverage: Coverage[] = selected.map((category) => {
    const rows = sourceRows(snapshot, category);
    return { module: CATEGORIES[category], category, count: rows.length,
      status: category === 'growth_prospect' && !snapshot.crmConsent ? 'consent_required' : rows.length ? 'available' : 'empty',
      truncated: rows.length >= 500 };
  });
  const warnings: string[] = [
    'Les encours, stocks et tâches sont un instantané à la date du diagnostic, indépendamment de la période financière.',
    'Données saisies dans VYORA uniquement ; les connecteurs externes ne sont pas présumés actifs. Les montants de modules différents peuvent se recouper.',
  ];
  if (coverage.some((c) => c.status === 'consent_required')) warnings.push('Smart CRM indisponible : le consentement mémoire de cette entreprise est désactivé.');
  if (coverage.some((c) => c.status === 'empty')) warnings.push('Certains modules sont vides : absence de données ne signifie pas absence de problème.');
  if (coverage.some((c) => c.truncated)) warnings.push('Au moins un module atteint 500 lignes : résultats potentiellement incomplets.');
  const recommendations: Recommendation[] = [];
  const metrics: ReportMetric[] = [];
  let missingDates = 0; let invalidAmounts = 0;
  const add = (record: SourceRecord, category: string, kind: string, priority: Priority, problem: string,
    evidence: string[], potentialImpact: string, action: string) => {
    const fields = MODEL_FACT_FIELDS[kind]; const data = obj(record.data); const facts: Record<string, number | string> = {};
    for (const key of fields?.numbers ?? []) { const value = numeric(data[key]); if (value !== null) facts[key] = value; }
    for (const key of fields?.dates ?? []) if (validDate(data[key])) facts[key] = data[key] as string;
    recommendations.push({ id: `${kind}:${record.id}`, kind, module: CATEGORIES[category], priority,
      problem, evidence, potentialImpact, action, sourceCategory: category, sourceRecordId: record.id, facts });
  };
  const each = (category: string, fn: (record: SourceRecord, data: Record<string, unknown>) => void) => {
    if (selected.includes(category)) for (const record of sourceRows(snapshot, category)) fn(record, obj(record.data));
  };

  each('growth_prospect', (r, d) => {
    const name = label(d,'name','company'); const stage = text(d.stage,30); const nextAge = age(d.nextActionAt,asOf);
    if (stage === 'perdu') add(r,'growth_prospect','crm_lost','moyenne',`Opportunité perdue ${name}`,
      ['Étape CRM : perdu.'], 'Valeur de l’opportunité non assimilée à un revenu perdu certain.', 'Examiner le motif de perte et planifier un suivi si pertinent.');
    else if (['prospect','contacte','qualifie','proposition'].includes(stage) && nextAge !== null && nextAge > 0)
      add(r,'growth_prospect','crm_overdue','élevée',`Suivi CRM en retard ${name}`,
        [`Prochaine action prévue le ${text(d.nextActionAt,10)} ; étape : ${stage}.`], 'Impact commercial non quantifiable avec certitude.', 'Créer une tâche de suivi et préparer la prochaine action.');
    else if (['prospect','contacte','qualifie','proposition'].includes(stage) && d.nextActionAt && nextAge === null) missingDates++;
  });
  each('bg_module_lead_rescue', (r,d) => {
    const days = age(d.lastContactAt,asOf); const status=text(d.status,30);
    if (['nouveau','relance','qualifie'].includes(status) && days !== null && days >= 3)
      add(r,'bg_module_lead_rescue','lead_stale','élevée',`Lead sans contact récent ${label(d,'name','company')}`,
        [`Dernier contact : ${text(d.lastContactAt,10)} (${days} jours) ; statut : ${status}.`],valueImpact(d,'estimatedValue','Valeur estimée du lead'), 'Préparer une relance et créer une tâche de suivi.');
    else if (['nouveau','relance','qualifie'].includes(status) && days === null) missingDates++;
  });
  each('bg_module_sales_automation', (r,d) => {
    if (d.status === 'actif' && (!text(d.trigger) || !text(d.action)))
      add(r,'bg_module_sales_automation','automation_incomplete','moyenne',`Règle active incomplète ${label(d,'name')}`,
        ['Déclencheur ou action manquant dans la règle active.'], 'Impact non quantifiable ; aucune exécution automatique supposée.', 'Compléter la règle avant de générer des tâches.');
  });
  each('bg_module_payment_recovery', (r,d) => {
    const status=text(d.status,30); const days=age(d.dueDate,asOf);
    if (status !== 'paye' && ((days !== null && days > 0 && ['a_echeance','en_retard','relance','litige'].includes(status)) || status === 'en_retard'))
      add(r,'bg_module_payment_recovery','invoice_overdue',status === 'litige' ? 'critique' : 'élevée',`Facture impayée en retard ${label(d,'invoiceRef')}`,
        [`Statut : ${status}.`, days !== null ? `Échéance : ${text(d.dueDate,10)}${days > 0 ? ` (${days} jours de retard)` : status === 'en_retard' ? ' (date non échue malgré le statut déclaré)' : ''}.` : 'Échéance non renseignée ; retard indiqué par le statut.'],
        valueImpact(d,'amount','Montant de la facture'), 'Vérifier la facture et préparer une relance ; ne rien envoyer sans accord.');
    else if (['a_echeance','relance'].includes(status) && days === null) missingDates++;
  });
  each('bg_module_order_cart_recovery',(r,d) => {
    if (['panier','commande','relance'].includes(text(d.status,30)))
      add(r,'bg_module_order_cart_recovery','cart_open','moyenne',`Panier ou commande à suivre ${label(d,'reference')}`,
        [`Statut : ${text(d.status,30)}.`, ...(validDate(d.abandonedAt) ? [`Date d’abandon : ${d.abandonedAt}.`] : [])],
        valueImpact(d,'amount','Valeur indiquée'), 'Préparer un suivi et un brouillon de relance, sans envoi.');
  });
  each('bg_module_customer_recovery',(r,d) => {
    if (['a_risque','contacte'].includes(text(d.status,30)))
      add(r,'bg_module_customer_recovery','customer_risk','moyenne',`Client à réactiver ${label(d,'name')}`,
        [`Statut : ${text(d.status,30)}.`, ...(validDate(d.lastOrderAt) ? [`Dernière commande : ${d.lastOrderAt}.`] : [])],
        numeric(d.totalSpent) === null ? 'Valeur historique non renseignée.' : `Valeur historique déclarée : ${money(numeric(d.totalSpent)!)} ; ce n’est pas un revenu à récupérer garanti.`,
        'Préparer une démarche de réactivation et vérifier son consentement avant tout contact.');
  });
  each('bg_module_smart_inventory',(r,d) => {
    const stock=numeric(d.stock); const threshold=numeric(d.threshold);
    if (stock !== null && (stock === 0 || (threshold !== null && stock <= threshold)))
      add(r,'bg_module_smart_inventory','stock_low',stock === 0 ? 'critique' : 'élevée',`${stock === 0 ? 'Rupture' : 'Stock sous le seuil'} ${label(d,'product','sku')}`,
        [`Stock déclaré : ${stock}.`, ...(threshold !== null ? [`Seuil d’alerte : ${threshold}.`] : ['Seuil non renseigné.'])],
        'Risque de ventes manquées non chiffrable sans historique de demande.', 'Préparer une tâche de réapprovisionnement ; ne pas commander automatiquement.');
    else if (stock === null || threshold === null) invalidAmounts++;
  });
  each('bg_module_operations_manager',(r,d) => {
    const status=text(d.status,30); const days=age(d.dueDate,asOf);
    if (['a_faire','en_cours','bloque'].includes(status) && (status === 'bloque' || (days !== null && days > 0)))
      add(r,'bg_module_operations_manager','task_blocked',status === 'bloque' ? 'élevée' : 'moyenne',`Tâche ${status === 'bloque' ? 'bloquée' : 'en retard'} ${label(d,'title')}`,
        [`Statut : ${status}.`, ...(days !== null ? [`Échéance : ${text(d.dueDate,10)}.`] : [])], 'Impact opérationnel à qualifier.', 'Clarifier le blocage, le responsable et la prochaine étape.');
    else if (['a_faire','en_cours'].includes(status) && days === null) missingDates++;
  });
  each('bg_module_customer_support_ai',(r,d) => {
    if (['ouvert','en_cours'].includes(text(d.status,30)))
      add(r,'bg_module_customer_support_ai','support_open',d.priority === 'haute' ? 'élevée' : 'moyenne',`Ticket client ouvert ${label(d,'subject')}`,
        [`Statut : ${text(d.status,30)} ; priorité : ${text(d.priority,30) || 'non renseignée'}.`, (d.hasDraftReply === true || text(d.draftReply)) ? 'Un brouillon est enregistré.' : 'Aucun brouillon de réponse enregistré.'],
        'Impact client non quantifiable.', 'Examiner la demande et préparer une réponse à valider, sans l’envoyer.');
  });
  each('bg_module_supplier_delivery',(r,d) => {
    const days=age(d.expectedAt,asOf); const status=text(d.status,30);
    if (['commande','expedie','transit','retard'].includes(status) && (status === 'retard' || (days !== null && days > 0)))
      add(r,'bg_module_supplier_delivery','delivery_late','élevée',`Livraison à vérifier ${label(d,'supplier','orderRef')}`,
        [`Statut : ${status}.`, ...(days !== null ? [`Date attendue : ${text(d.expectedAt,10)}.`] : [])], 'Risque opérationnel non quantifiable.', 'Vérifier le suivi fournisseur et préparer une relance.');
    else if (['commande','expedie','transit'].includes(status) && days === null) missingDates++;
  });
  each('bg_module_dispute_shield',(r,d) => {
    if (['ouvert','negociation','escalade'].includes(text(d.status,30)))
      add(r,'bg_module_dispute_shield','dispute_open',d.status === 'escalade' ? 'critique' : 'élevée',`Litige ouvert ${label(d,'reference')}`,
        [`Statut : ${text(d.status,30)}.`,(d.hasEvidence === true || text(d.evidence)) ? 'Des preuves sont renseignées.' : 'Aucune preuve renseignée dans le dossier.'],
        valueImpact(d,'amount','Montant déclaré en litige'), 'Rassembler les preuves et préparer un plan de résolution.');
  });
  each('bg_module_revenue_leak',(r,d) => {
    if (['identifie','en_traitement'].includes(text(d.status,30)))
      add(r,'bg_module_revenue_leak','leak_recorded','moyenne',`Fuite signalée ${label(d,'title')}`,
        [`Statut : ${text(d.status,30)} ; source déclarée : ${text(d.source,30) || 'non renseignée'}.`],
        valueImpact(d,'amount','Montant estimé saisi'), 'Vérifier la source et suivre le traitement ; éviter de cumuler les doublons entre modules.');
  });
  each('bg_module_social_growth',(r,d) => {
    const days=age(d.scheduledAt,asOf); const status=text(d.status,30);
    if (['idee','a_produire','pret'].includes(status) && days !== null && days > 0)
      add(r,'bg_module_social_growth','content_late','faible',`Contenu planifié non marqué publié ${label(d,'title')}`,
        [`Date prévue : ${text(d.scheduledAt,10)} ; statut : ${status}.`], 'Aucune métrique sociale externe disponible.', 'Revoir le calendrier et préparer le contenu ; aucune publication automatique.');
  });

  if (selected.includes('bg_module_finance_intelligence')) {
    let income=0, expense=0, incomeCount=0, expenseCount=0;
    const seen=new Map<string,SourceRecord>();
    each('bg_module_finance_intelligence',(r,d) => {
      if (d.status !== 'realise') return;
      if (!validDate(d.occurredAt)) { missingDates++; return; }
      if (d.occurredAt < from || d.occurredAt > to) return;
      const amount=numeric(d.amount);
      if (amount === null) { invalidAmounts++; return; }
      if (d.kind === 'revenu') { income+=amount; incomeCount++; }
      else if (d.kind === 'depense') { expense+=amount; expenseCount++; }
      else return;
      const key = `${text(d.label).toLowerCase()}|${d.kind}|${d.occurredAt}|${amount}`;
      if (text(d.label) && seen.has(key)) add(r,'bg_module_finance_intelligence','finance_duplicate','moyenne',`Mouvement potentiellement en double ${label(d,'label')}`,
        [`Même libellé, nature, date et montant qu’une autre ligne : ${d.occurredAt}, ${money(amount)}.`], 'Un doublon est possible mais non confirmé.', 'Vérifier les pièces justificatives avant toute correction.');
      else seen.set(key,r);
    });
    if (incomeCount) metrics.push({ label:'Revenus réalisés saisis',value:income,unit:'FCFA',basis:`${incomeCount} mouvement(s) dans la période` });
    if (expenseCount) metrics.push({ label:'Dépenses réalisées saisies',value:expense,unit:'FCFA',basis:`${expenseCount} mouvement(s) dans la période` });
    if (incomeCount && expenseCount) {
      metrics.push({ label:'Solde des mouvements saisis',value:income-expense,unit:'FCFA',basis:'Revenus moins dépenses réalisés, données saisies uniquement' });
      if (expense > income) warnings.push('Les dépenses réalisées saisies dépassent les revenus réalisés saisis sur la période ; ce solde ne représente pas nécessairement la trésorerie totale.');
    } else warnings.push('Solde financier non calculé : revenus ou dépenses réalisés insuffisamment renseignés pour la période.');
  }
  if (missingDates) warnings.push(`${missingDates} enregistrement(s) avec une date manquante ou invalide : certains retards ne peuvent pas être déterminés.`);
  if (invalidAmounts) warnings.push(`${invalidAmounts} enregistrement(s) avec quantité ou montant manquant/invalide : calcul partiel.`);
  recommendations.sort((a,b) => PRIORITY_ORDER[a.priority]-PRIORITY_ORDER[b.priority] || a.id.localeCompare(b.id));
  const totalRecommendations=recommendations.length;
  if (totalRecommendations > 40) warnings.push(`Les 40 premières recommandations sur ${totalRecommendations} sont affichées.`);
  return { type,period:{from,to},asOf,coverage,metrics,recommendations:recommendations.slice(0,40),totalRecommendations,warnings };
}

/** Résumé minimal transmis au modèle : pas de notes, noms, contacts ou instructions contenues dans les fiches. */
export function reportForModel(report: BusinessReport): string {
  const counts = new Map<string, { kind: string; module: string; priority: Priority; count: number }>();
  for (const finding of report.recommendations) {
    const key=`${finding.kind}:${finding.priority}`; const found=counts.get(key);
    if (found) found.count++; else counts.set(key,{kind:finding.kind,module:finding.module,priority:finding.priority,count:1});
  }
  return JSON.stringify({ period:report.period,asOf:report.asOf,coverage:report.coverage.map(({module,count,status,truncated}) => ({module,count,status,truncated})),
    metrics:report.metrics, findingsSample:[...counts.values()], findingsSampleSize:report.recommendations.length,
    evidenceSamples:report.recommendations.slice(0,15).map(({kind,module,priority,facts}) => ({kind,module,priority,facts})), totalRecommendations:report.totalRecommendations,warnings:report.warnings });
}
