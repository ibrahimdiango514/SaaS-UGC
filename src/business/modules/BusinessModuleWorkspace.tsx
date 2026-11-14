import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, ArrowUpRight, Check, ChevronDown, CircleHelp,
  Database, Loader2, Pencil, Play, Plus, RefreshCw, Search, ShieldCheck,
  Sparkles, Trash2, Wand2, Zap,
} from 'lucide-react';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Input,
  LoadingState, Modal, PageHeader, Select, Textarea, cn,
} from '../../components/ui';
import { buildBusinessGrowLocationState } from '../../contracts/business-grow';
import { useAuth } from '../../context/AuthContext';
import { businessGrowApi } from '../api';
import type { AutomationTaskConfirmation, BusinessModuleRecord } from '../api';
import {
  AUTOMATION_TRIGGERS, MODULE_GROUPS, automationTaskFromCandidate, iterateAutomationCandidates,
  computeRevenueLeaks, dateFrom, displayFieldValue, formatModuleMoney,
  getModuleDefinition, measuredNumber, moduleKeyToCategory, numberFrom, statusOf,
  textFrom,
  type AutomationTaskDraft, type DetectedLeak, type ModuleDefinition, type ModuleField, type ModuleRecord,
} from './registry';

const ACCENTS: Record<ModuleDefinition['accent'], { tile: string; ring: string; text: string; glow: string }> = {
  cyan: { tile: 'bg-cyan-400/10 text-cyan-300', ring: 'ring-cyan-400/20', text: 'text-cyan-200', glow: 'bg-cyan-400/10' },
  violet: { tile: 'bg-violet-400/10 text-violet-300', ring: 'ring-violet-400/20', text: 'text-violet-200', glow: 'bg-violet-400/10' },
  amber: { tile: 'bg-amber-400/10 text-amber-300', ring: 'ring-amber-400/20', text: 'text-amber-200', glow: 'bg-amber-400/10' },
  emerald: { tile: 'bg-emerald-400/10 text-emerald-300', ring: 'ring-emerald-400/20', text: 'text-emerald-200', glow: 'bg-emerald-400/10' },
  rose: { tile: 'bg-rose-400/10 text-rose-300', ring: 'ring-rose-400/20', text: 'text-rose-200', glow: 'bg-rose-400/10' },
};

type SortMode = 'recent' | 'amount' | 'date';
type Notice = { tone: 'success' | 'warning' | 'danger'; text: string };

type AutomationPreview = {
  day: string;
  items: Array<{ draft: AutomationTaskDraft; confirmation: AutomationTaskConfirmation }>;
  already: number;
  remaining: number;
  capacity: number;
  atLimit: boolean;
};

function toModuleRecord(record: BusinessModuleRecord): ModuleRecord {
  return {
    id: record.id,
    category: record.category,
    data: record.data ?? {},
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function initialValues(definition: ModuleDefinition, record?: ModuleRecord | null): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of definition.fields) {
    const current = record?.data[field.key];
    if (current !== undefined && current !== null && current !== '') {
      values[field.key] = String(current);
    } else if (field.type === 'select') {
      values[field.key] = field.options?.[0]?.value ?? '';
    } else {
      values[field.key] = '';
    }
  }
  values.status = record ? textFrom(record.data.status) || definition.statuses[0].value : definition.statuses[0].value;
  return values;
}

function renderInput(field: ModuleField, value: string, onChange: (value: string) => void) {
  const label = `${field.label}${field.required ? ' *' : ''}`;
  if (field.type === 'textarea') {
    return <Textarea label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} hint={field.help} rows={3} />;
  }
  if (field.type === 'select') {
    return (
      <Select label={label} value={value} onChange={(event) => onChange(event.target.value)} hint={field.help}>
        {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
    );
  }
  return (
    <Input
      label={label}
      type={field.type === 'number' ? 'number' : field.type === 'email' ? 'email' : field.type === 'tel' ? 'tel' : field.type === 'url' ? 'url' : field.type === 'date' ? 'date' : 'text'}
      value={value}
      min={field.min}
      max={field.max}
      step={field.step}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder}
      hint={field.help}
    />
  );
}

export default function BusinessModuleWorkspace() {
  const { user, workspaceId } = useAuth();
  const { moduleKey } = useParams<{ moduleKey: string }>();
  return <ScopedModuleWorkspace key={`${user?.id ?? ''}:${workspaceId ?? ''}:${moduleKey ?? ''}`} />;
}

function ScopedModuleWorkspace() {
  const { moduleKey } = useParams<{ moduleKey: string }>();
  const { workspaceId } = useAuth();
  const definition = getModuleDefinition(moduleKey);
  const navigate = useNavigate();

  const [records, setRecords] = useState<ModuleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState<SortMode>('recent');
  const [visible, setVisible] = useState(20);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ModuleRecord | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<ModuleRecord | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [leaks, setLeaks] = useState<DetectedLeak[]>([]);
  const [leaksLoading, setLeaksLoading] = useState(false);
  const [leaksError, setLeaksError] = useState<string | null>(null);
  const [automationRunning, setAutomationRunning] = useState(false);
  const [automationPreview, setAutomationPreview] = useState<AutomationPreview | null>(null);
  const [automationResult, setAutomationResult] = useState<Notice | null>(null);
  const activeRef = useRef(true);
  const automationBusyRef = useRef(false);
  const loadSequence = useRef(0);
  const leaksSequence = useRef(0);
  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false; loadSequence.current++; leaksSequence.current++; }; }, []);

  const load = useCallback(async () => {
    if (!definition) return;
    const sequence = ++loadSequence.current;
    if (!workspaceId) { setRecords([]); setLoading(false); setError('Aucune entreprise active.'); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await businessGrowApi.listModuleRecords(definition.category, workspaceId);
      if (activeRef.current && sequence === loadSequence.current) setRecords(result.records.map(toModuleRecord));
    } catch (cause) {
      if (activeRef.current && sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : 'Impossible de charger ce module.');
    } finally {
      if (activeRef.current && sequence === loadSequence.current) setLoading(false);
    }
  }, [definition, workspaceId]);

  useEffect(() => {
    setRecords([]);
    setQuery('');
    setStatusFilter('all');
    setVisible(20);
    setNotice(null);
    setFormOpen(false);
    setEditing(null);
    setValues(definition ? initialValues(definition) : {});
    void load();
  }, [definition, load]);

  const loadLeaks = useCallback(async () => {
    if (!definition || definition.key !== 'revenue-leak' || !workspaceId) return;
    const sequence = ++leaksSequence.current;
    setLeaksLoading(true);
    setLeaksError(null);
    try {
      const sourceKeys = ['payment-recovery', 'lead-rescue', 'customer-recovery', 'order-cart-recovery', 'smart-inventory', 'dispute-shield'];
      const results = await Promise.all(sourceKeys.map(async (key) => {
        const module = getModuleDefinition(key)!;
        const response = await businessGrowApi.listModuleRecords(module.category, workspaceId);
        return [key, response.records.map(toModuleRecord)] as const;
      }));
      if (activeRef.current && sequence === leaksSequence.current) setLeaks(computeRevenueLeaks(Object.fromEntries(results)));
    } catch (cause) {
      if (activeRef.current && sequence === leaksSequence.current) setLeaksError(cause instanceof Error ? cause.message : 'Le détecteur transversal est momentanément indisponible.');
    } finally {
      if (activeRef.current && sequence === leaksSequence.current) setLeaksLoading(false);
    }
  }, [definition, workspaceId]);

  useEffect(() => {
    setLeaks([]);
    void loadLeaks();
  }, [loadLeaks]);

  const groups = useMemo(() => MODULE_GROUPS.find((group) => group.id === definition?.group), [definition]);

  const displayKpis = useMemo(() => {
    if (!definition) return [];
    if (definition.key === 'revenue-leak') {
      return [
        { label: 'Fuites détectées', hint: 'Calcul transversal sur vos modules', value: leaksLoading ? '…' : String(leaks.length) },
        { label: 'Montants', hint: 'Non cumulés : les sources peuvent se recouper', value: '—' },
        { label: 'Colmatées', hint: 'Fuites marquées résolues', value: loading ? '…' : String(records.filter((record) => record.data.status === 'colmate').length) },
      ];
    }
    return definition.kpis.map((kpi) => ({
      label: kpi.label,
      hint: kpi.hint,
      value: loading ? '…' : kpi.compute(records),
    }));
  }, [definition, leaks, leaksLoading, loading, records]);

  const filtered = useMemo(() => {
    if (!definition) return [];
    const needle = query.trim().toLowerCase();
    const list = records.filter((record) => {
      if (statusFilter !== 'all' && textFrom(record.data.status) !== statusFilter) return false;
      if (!needle) return true;
      return Object.values(record.data).some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
    });
    const sorted = [...list];
    if (sort === 'amount' && definition.valueField) {
      sorted.sort((a, b) => numberFrom(b.data[definition.valueField!]) - numberFrom(a.data[definition.valueField!]));
    } else if (sort === 'date' && definition.dateField) {
      sorted.sort((a, b) => dateFrom(a.data[definition.dateField!]).localeCompare(dateFrom(b.data[definition.dateField!])));
    } else {
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return sorted;
  }, [definition, query, records, sort, statusFilter]);

  if (!definition) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Business Growth" title="Module introuvable" description="Ce module n’existe pas ou n’est pas encore disponible dans votre espace." />
        <Link to="/app/business/modules" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line px-4 text-sm text-slate-200 hover:bg-white/5">
          <ArrowLeft size={16} /> Revenir aux modules
        </Link>
      </div>
    );
  }

  const accent = ACCENTS[definition.accent];
  const columns = definition.fields
    .filter((field) => field.inList !== false && field.key !== definition.primaryField)
    .slice(0, 4);

  const openCreate = () => {
    setEditing(null);
    setValues(initialValues(definition));
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (record: ModuleRecord) => {
    setEditing(record);
    setValues(initialValues(definition, record));
    setFormError(null);
    setFormOpen(true);
  };

  const submit = async () => {
    if (!workspaceId) { setFormError('Aucune entreprise active.'); return; }
    const payload: Record<string, unknown> = {};
    for (const field of definition.fields) {
      const raw = (values[field.key] ?? '').trim();
      if (field.required && !raw) {
        setFormError(`Le champ « ${field.label} » est obligatoire.`);
        return;
      }
      if (field.type === 'number') {
        const value = raw ? measuredNumber(raw) : null;
        if (raw && (value === null || value < (field.min ?? 0) || (field.max !== undefined && value > field.max))) {
          setFormError(`Le champ « ${field.label} » doit être un nombre valide entre ${field.min ?? 0} et ${field.max ?? '1 000 000 000 000'}.`);
          return;
        }
        if (value !== null && field.step === 1 && !Number.isInteger(value)) {
          setFormError(`Le champ « ${field.label} » doit être un nombre entier.`);
          return;
        }
        payload[field.key] = value;
      } else {
        payload[field.key] = raw;
      }
    }
    payload.status = values.status || definition.statuses[0].value;

    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await businessGrowApi.updateModuleRecord(definition.category, editing.id, payload, workspaceId);
        setNotice({ tone: 'success', text: 'Enregistrement mis à jour.' });
      } else {
        await businessGrowApi.createModuleRecord(definition.category, payload, null, workspaceId);
        setNotice({ tone: 'success', text: 'Enregistrement créé.' });
      }
      if (!activeRef.current) return;
      setFormOpen(false);
      await load();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Enregistrement impossible.');
    } finally {
      setSaving(false);
    }
  };

  const applyQuickAction = async (record: ModuleRecord, actionId: string) => {
    const action = definition.quickActions?.find((item) => item.id === actionId);
    if (!action || !workspaceId) return;
    setBusyId(record.id);
    setNotice(null);
    try {
      await businessGrowApi.updateModuleRecord(definition.category, record.id, action.patch(record.data), workspaceId);
      await load();
      setNotice({ tone: 'success', text: `${action.label} : enregistré.` });
    } catch (cause) {
      setNotice({ tone: 'danger', text: cause instanceof Error ? cause.message : 'Action impossible.' });
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting || !workspaceId) return;
    setDeleteLoading(true);
    try {
      await businessGrowApi.deleteModuleRecord(definition.category, deleting.id, workspaceId);
      setDeleting(null);
      await load();
      setNotice({ tone: 'success', text: 'Enregistrement supprimé.' });
    } catch (cause) {
      setNotice({ tone: 'danger', text: cause instanceof Error ? cause.message : 'Suppression impossible.' });
    } finally {
      setDeleteLoading(false);
    }
  };

  const prepareAutomation = async () => {
    if (automationBusyRef.current) return;
    if (!workspaceId) { setAutomationResult({ tone: 'danger', text: 'Aucune entreprise active.' }); return; }
    automationBusyRef.current = true;
    setAutomationRunning(true);
    setAutomationResult(null);
    try {
      const sourceKeys = Array.from(new Set(AUTOMATION_TRIGGERS.map((trigger) => trigger.sourceModule)));
      const [freshRules, existing, sourceEntries] = await Promise.all([
        businessGrowApi.listModuleRecords(moduleKeyToCategory('sales-automation'), workspaceId),
        businessGrowApi.listModuleRecords(moduleKeyToCategory('operations-manager'), workspaceId),
        Promise.all(sourceKeys.map(async (key) => {
          const module = getModuleDefinition(key)!;
          const response = await businessGrowApi.listModuleRecords(module.category, workspaceId);
          return [key, response.records.map(toModuleRecord)] as const;
        })),
      ]);
      if (!activeRef.current) return;
      const rules = freshRules.records.map(toModuleRecord);
      const sources = Object.fromEntries(sourceEntries);
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const known = new Set(existing.records.map((record) => `${textFrom(record.data.sourcePlaybookId)}:${textFrom(record.data.sourceRecordId)}`));
      const capacity = Math.max(0, 500 - existing.records.length);
      if (!capacity) {
        setAutomationResult({ tone: 'warning', text: 'Operations Manager a atteint sa limite de 500 fiches. Supprimez une tâche avant de préparer de nouvelles créations.' });
        return;
      }
      const atLimit = freshRules.records.length >= 500 || sourceEntries.some(([, rows]) => rows.length >= 500);
      const items: AutomationPreview['items'] = [];
      let already = 0;
      let eligibleNew = 0;
      // On compte tous les candidats, mais seuls les 25 premiers nouveaux
      // brouillons sont matérialisés (au maximum 500 règles × 500 sources).
      for (const candidate of iterateAutomationCandidates(rules, sources, now)) {
        const { playbook: rule, record: source, sourceModule } = candidate;
        if (known.has(`${rule.id}:${source.id}`)) { already += 1; continue; }
        eligibleNew += 1;
        if (items.length >= Math.min(25, capacity)) continue;
        const draft = automationTaskFromCandidate(candidate);
        items.push({
          draft,
          confirmation: {
            playbookId: rule.id,
            sourceCategory: moduleKeyToCategory(sourceModule),
            sourceId: source.id,
            previewDay: day,
            expectedPlaybook: rule.data,
            expectedSource: source.data,
            task: { ...draft, status: 'a_faire' },
          },
        });
      }
      if (!items.length) {
        setAutomationResult({ tone: 'warning', text: `Aucune nouvelle tâche à générer : aucune règle applicable ou toutes les tâches sont déjà présentes.${atLimit ? ' Limite de 500 enregistrements atteinte pour au moins un module : l’aperçu peut être incomplet.' : ''}` });
        return;
      }
      setAutomationPreview({ day, items, already, remaining: eligibleNew - items.length, capacity, atLimit });
    } catch (cause) {
      if (activeRef.current) setAutomationResult({ tone: 'danger', text: cause instanceof Error ? cause.message : 'Impossible de préparer l’aperçu.' });
    } finally {
      automationBusyRef.current = false;
      if (activeRef.current) setAutomationRunning(false);
    }
  };

  const confirmAutomation = async (preview: AutomationPreview) => {
    if (automationBusyRef.current || !workspaceId || !activeRef.current) return;
    automationBusyRef.current = true;
    setAutomationRunning(true);
    setAutomationPreview(null);
    setAutomationResult(null);
    let created = 0;
    let already = 0;
    try {
      for (const item of preview.items) {
        // Si l'entreprise ou le composant change, ne pas démarrer de nouvelle
        // écriture après celle éventuellement déjà en vol.
        if (!activeRef.current) return;
        const result = await businessGrowApi.confirmAutomationTask(workspaceId, item.confirmation);
        if (!result || typeof result.taskId !== 'string' || !result.taskId || typeof result.created !== 'boolean') {
          throw new Error('Réponse de confirmation invalide : résultat de la dernière tâche inconnu.');
        }
        if (result.created) created += 1;
        else already += 1;
      }
      if (!activeRef.current) return;
      setAutomationResult({
        tone: created ? 'success' : 'warning',
        text: `${created} tâche(s) créée(s), ${already} déjà présente(s) au moment de la confirmation${preview.already ? ` ; ${preview.already} déjà présentes avant l’aperçu` : ''}${preview.remaining ? ` ; ${preview.remaining} restantes au-delà du lot ou de la capacité disponible` : ''}.${preview.atLimit ? ' Limite de 500 enregistrements atteinte pour au moins un module : l’aperçu peut être incomplet.' : ''}`,
      });
    } catch (cause) {
      if (activeRef.current) {
        const message = cause instanceof Error ? cause.message : 'Génération impossible.';
        setAutomationResult({ tone: 'danger', text: `${created} tâche(s) créée(s) et ${already} déjà présente(s) confirmées avant l’interruption. ${message} Si la réponse a été perdue, le résultat de la dernière tâche est inconnu. Vérifiez Operations Manager avant de recalculer ; aucune écriture n’a été rejouée automatiquement.` });
      }
    } finally {
      automationBusyRef.current = false;
      if (activeRef.current) setAutomationRunning(false);
    }
  };

  const prepareAgentBrief = () => {
    // N'ajouter au brouillon que les indicateurs et statuts connus, jamais les
    // libellés ou coordonnées des enregistrements ni leur contenu libre.
    const statuses = definition.statuses.map((status) => ({
      label: status.label, count: records.filter((record) => record.data.status === status.value).length,
    }));
    const unknown = records.length - statuses.reduce((sum, status) => sum + status.count, 0);
    const draft = [
      definition.agentPrompt,
      '',
      `Module : ${definition.title} (${records.length} enregistrement(s) chargé(s)${records.length >= 500 ? ' ; limite de 500 atteinte' : ''}).`,
      `Statuts déclarés : ${statuses.map((status) => `${status.label} : ${status.count}`).join(' ; ')}${unknown ? ` ; non reconnus : ${unknown}` : ''}.`,
      ...displayKpis.map((kpi) => `${kpi.label} : ${kpi.value}.`),
      '',
      'Aucun nom, contact, message ou note de fiche n’a été copié. Si une donnée individuelle est nécessaire, demande un résumé anonymisé. Appuie-toi sur les données disponibles et ne fabrique aucun chiffre.',
    ].join('\n');
    navigate('/app/business', { state: buildBusinessGrowLocationState({ section: 'chat', initialDraft: draft }) });
  };

  const prepareSupportReply = (record: ModuleRecord) => {
    const optionLabel = (key: string) => definition.fields.find((field) => field.key === key)?.options
      ?.find((option) => option.value === record.data[key])?.label ?? 'non renseigné';
    const status = definition.statuses.find((item) => item.value === record.data.status)?.label ?? 'non renseigné';
    const draft = [
      'Aide-moi à préparer une réponse de support professionnelle et empathique, sans envoyer de message.',
      `Statut : ${status} ; canal : ${optionLabel('channel')} ; priorité : ${optionLabel('priority')}.`,
      'L’identité, l’objet et le message du client n’ont pas été copiés. Si nécessaire, demande-moi un résumé anonymisé ; ne suppose pas le contenu de la demande.',
    ].join('\n');
    navigate('/app/business', { state: buildBusinessGrowLocationState({ section: 'chat', initialDraft: draft }) });
  };
  return (
    <div className="space-y-5 pb-8" data-testid="business-module-workspace">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link to="/app/business" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-slate-400 hover:text-white">
          <ArrowLeft size={15} /> Business Growth
        </Link>
        <span className="text-slate-600">/</span>
        <Link to="/app/business/modules" className="inline-flex min-h-11 items-center rounded-lg px-2 text-slate-400 hover:text-white">Modules</Link>
        <span className="text-slate-600">/</span>
        <span className="inline-flex min-h-11 items-center px-2 text-slate-300">{definition.title}</span>
      </div>

      <section className="relative isolate overflow-hidden rounded-2xl border border-line bg-panel px-5 py-5 sm:px-6">
        <div aria-hidden="true" className={cn('pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full blur-[80px]', accent.glow)} />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-xl ring-1', accent.tile, accent.ring)}>
              <definition.icon size={22} />
            </span>
            <div className="min-w-0">
              <p className={cn('text-[11px] font-semibold uppercase tracking-[0.18em]', accent.text)}>{groups?.label ?? 'Business Growth'}</p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">{definition.title}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">{definition.description}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="secondary" disabled={!workspaceId || loading || Boolean(error)} onClick={prepareAgentBrief} icon={<Wand2 size={16} />} className="min-h-11">
              Demander à l’agent
            </Button>
            <Button onClick={openCreate} disabled={!workspaceId} icon={<Plus size={16} />} className="min-h-11">Nouvel enregistrement</Button>
          </div>
        </div>
        <div className="relative mt-4 grid gap-2 border-t border-line pt-4 text-xs text-slate-500 sm:grid-cols-2">
          <span className="inline-flex items-start gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-400" /> Données Business Growth isolées, aucun crédit Studio consommé.</span>
          <span className="inline-flex items-start gap-2"><Database size={14} className="mt-0.5 shrink-0 text-brand-300" /> Le brouillon agent contient des indicateurs, pas les noms ni messages clients. Relisez-le avant envoi au fournisseur IA.</span>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        {displayKpis.map((kpi) => (
          <Card key={kpi.label} className="p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{kpi.label}</p>
            <p className="mt-1.5 text-2xl font-bold tracking-tight text-white">{kpi.value}</p>
            {kpi.hint && <p className="mt-1 text-xs leading-relaxed text-slate-500">{kpi.hint}</p>}
          </Card>
        ))}
      </div>

      <Card className="p-4 text-sm text-slate-400">
        <div className="flex items-start gap-3">
          <CircleHelp size={17} className="mt-0.5 shrink-0 text-slate-500" />
          <p className="leading-relaxed">{definition.purpose}</p>
        </div>
      </Card>

      {notice && (
        <div className={cn('flex items-start gap-2 rounded-xl border px-4 py-3 text-sm',
          notice.tone === 'success' && 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200',
          notice.tone === 'warning' && 'border-amber-400/25 bg-amber-500/10 text-amber-100',
          notice.tone === 'danger' && 'border-rose-400/25 bg-rose-500/10 text-rose-200')}>
          {notice.tone === 'success' ? <Check size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
          <span className="min-w-0 break-words">{notice.text}</span>
          <button onClick={() => setNotice(null)} className="ml-auto shrink-0 rounded p-1 text-current/70 hover:text-current" aria-label="Masquer le message">×</button>
        </div>
      )}

      {definition.key === 'sales-automation' && (
        <Card className="p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-base font-semibold text-white"><Zap size={17} className="text-violet-300" /> Exécution des automatisations</h2>
              <p className="mt-1 text-sm leading-relaxed text-slate-400">
                Préparez un aperçu des tâches issues des règles et enregistrements actuels. Après confirmation, jusqu’à 25 tâches sont créées dans Operations Manager, sans envoi externe. Chaque source est revérifiée avant sa création.
              </p>
            </div>
            <Button onClick={() => void prepareAutomation()} disabled={!workspaceId || loading || Boolean(error)} loading={automationRunning} icon={<Play size={15} />} className="shrink-0">
              Générer les tâches
            </Button>
          </div>
          {automationResult && (
            <p className={cn('mt-3 rounded-lg border px-3 py-2 text-sm',
              automationResult.tone === 'success' && 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200',
              automationResult.tone === 'warning' && 'border-amber-400/20 bg-amber-500/10 text-amber-100',
              automationResult.tone === 'danger' && 'border-rose-400/20 bg-rose-500/10 text-rose-200')}>
              {automationResult.text}
            </p>
          )}
        </Card>
      )}

      {definition.key === 'revenue-leak' && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold text-white"><Sparkles size={17} className="text-emerald-300" /> Détecteur transversal</h2>
              <p className="mt-1 text-sm text-slate-400">Calculé en direct à partir de vos factures, leads, clients, paniers, stocks et litiges.</p>
            </div>
            <Button variant="ghost" size="sm" className="min-h-11" onClick={() => void loadLeaks()} loading={leaksLoading} icon={<RefreshCw size={14} />}>Recalculer</Button>
          </div>
          {leaksError ? (
            <p className="px-5 py-4 text-sm text-rose-200">{leaksError}</p>
          ) : leaksLoading ? (
            <div className="flex items-center gap-2 px-5 py-6 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Analyse des modules…</div>
          ) : leaks.length === 0 ? (
            <p className="px-5 py-6 text-sm text-slate-400">Aucune alerte détectée parmi les données disponibles. Les modules vides ne permettent pas de conclure à une absence de risque.</p>
          ) : (
            <ul className="divide-y divide-line">
              {leaks.map((leak) => (
                <li key={leak.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-white">{leak.title}</p>
                      <Badge tone={leak.severity === 'haute' ? 'danger' : 'warning'}>{leak.severity === 'haute' ? 'Priorité haute' : 'À surveiller'}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-slate-400">{leak.detail}</p>
                    <p className="mt-1 text-xs text-slate-500">Source : {leak.moduleTitle}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-sm font-semibold text-white">{leak.amount === null ? 'Montant inconnu' : leak.id === 'leak-customers' ? `Valeur historique : ${formatModuleMoney(leak.amount)}` : formatModuleMoney(leak.amount)}</span>
                    <Button variant="outline" size="sm" className="min-h-11" onClick={() => navigate(`/app/business/modules/${leak.moduleKey}`)} icon={<ArrowUpRight size={14} />}>Traiter</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">Enregistrements</h2>
              <p className="mt-1 text-sm text-slate-400">
                {loading ? 'Chargement…' : `${filtered.length} sur ${records.length} enregistrement(s)`}
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <label className="relative block">
                <span className="sr-only">Rechercher</span>
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Rechercher…"
                  className="input min-h-11 pl-9"
                />
              </label>
              <label className="block">
                <span className="sr-only">Filtrer par statut</span>
                <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="min-h-11">
                  <option value="all">Tous les statuts</option>
                  {definition.statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
                </Select>
              </label>
              <label className="block">
                <span className="sr-only">Trier</span>
                <Select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} className="min-h-11">
                  <option value="recent">Plus récents</option>
                  {definition.valueField && <option value="amount">Montant décroissant</option>}
                  {definition.dateField && <option value="date">Date la plus ancienne</option>}
                </Select>
              </label>
            </div>
          </div>
        </div>

        {loading ? (
          <LoadingState label={`Chargement de ${definition.title}…`} />
        ) : error ? (
          <div className="p-5"><ErrorState message={error} onRetry={() => void load()} /></div>
        ) : filtered.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={records.length ? 'Aucun enregistrement ne correspond' : definition.emptyTitle}
              description={records.length ? 'Modifiez la recherche ou le filtre de statut.' : definition.emptyDescription}
              icon={<definition.icon size={24} />}
              action={<Button onClick={openCreate} icon={<Plus size={15} />}>Créer un enregistrement</Button>}
            />
          </div>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {filtered.slice(0, visible).map((record) => {
                const status = statusOf(definition, record.data.status);
                const busy = busyId === record.id;
                return (
                  <li key={record.id} className="px-4 py-4 sm:px-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-words text-base font-semibold text-white">
                          {textFrom(record.data[definition.primaryField]) || 'Sans titre'}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          Mis à jour le {new Date(record.updatedAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </p>
                      </div>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>

                    <dl className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                      {columns.map((field) => (
                        <div key={field.key} className="min-w-0 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                          <dt className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{field.label}</dt>
                          <dd className="mt-0.5 break-words text-sm text-slate-200">{displayFieldValue(definition, record, field)}</dd>
                        </div>
                      ))}
                    </dl>

                    {textFrom(record.data.notes) && (
                      <p className="mt-3 whitespace-pre-line break-words rounded-lg bg-white/[0.02] px-3 py-2 text-sm leading-relaxed text-slate-400">{textFrom(record.data.notes)}</p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {definition.quickActions?.map((action) => (
                        <Button
                          key={action.id}
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          disabled={busy}
                          onClick={() => void applyQuickAction(record, action.id)}
                        >
                          {action.label}
                        </Button>
                      ))}
                      {definition.key === 'customer-support-ai' && (
                        <Button size="sm" variant="secondary" className="min-h-11" icon={<Wand2 size={14} />} onClick={() => prepareSupportReply(record)}>
                          Préparer avec l’agent
                        </Button>
                      )}
                      <div className="ml-auto flex items-center gap-1">
                        <button onClick={() => openEdit(record)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white" aria-label={`Modifier ${textFrom(record.data[definition.primaryField]) || 'l’enregistrement'}`}>
                          <Pencil size={15} />
                        </button>
                        <button onClick={() => setDeleting(record)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-500/10 hover:text-rose-200" aria-label={`Supprimer ${textFrom(record.data[definition.primaryField]) || 'l’enregistrement'}`}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {filtered.length > visible && (
              <div className="border-t border-line px-5 py-4 text-center">
                <Button variant="ghost" onClick={() => setVisible((count) => count + 20)} icon={<ChevronDown size={15} />}>
                  Afficher {Math.min(20, filtered.length - visible)} enregistrement(s) de plus
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel/60 px-4 py-3 text-sm">
        <span className="text-slate-500">Chaque action est enregistrée dans votre espace Business Growth.</span>
        <Link to="/app/business/modules" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-slate-300 hover:text-white">
          Tous les modules <ArrowUpRight size={14} />
        </Link>
      </div>

      <Modal
        open={formOpen}
        onClose={() => !saving && setFormOpen(false)}
        title={editing ? `Modifier · ${definition.title}` : `Nouvel enregistrement · ${definition.title}`}
        description={definition.description}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>Annuler</Button>
            <Button onClick={() => void submit()} loading={saving} icon={<Check size={15} />}>
              {editing ? 'Enregistrer les modifications' : 'Créer l’enregistrement'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {formError && (
            <p className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{formError}</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {definition.fields.map((field) => (
              <div key={field.key} className={cn(field.full && 'sm:col-span-2')}>
                {renderInput(field, values[field.key] ?? '', (value) => setValues((current) => ({ ...current, [field.key]: value })))}
              </div>
            ))}
            <Select
              label="Statut *"
              value={values.status ?? definition.statuses[0].value}
              onChange={(event) => setValues((current) => ({ ...current, status: event.target.value }))}
            >
              {definition.statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
            </Select>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            Les champs marqués d’un astérisque sont obligatoires. Les montants sont exprimés en FCFA et restent modifiables.
          </p>
        </div>
      </Modal>

      <Modal
        open={Boolean(automationPreview)}
        title="Vérifier les tâches proposées"
        description="Vérifiez cet aperçu avant de créer des tâches internes dans Operations Manager."
        size="lg"
        onClose={() => setAutomationPreview(null)}
        footer={<>
          <Button variant="ghost" onClick={() => setAutomationPreview(null)}>Annuler</Button>
          <Button onClick={() => { if (automationPreview) void confirmAutomation(automationPreview); }}>Confirmer la génération</Button>
        </>}
      >
        {automationPreview && <div className="space-y-4">
          <p className="text-sm leading-relaxed text-slate-300">
            {automationPreview.items.length} tâche(s) à créer ou à retrouver si elles ont été créées entre-temps. Date de l’aperçu : {automationPreview.day} UTC. Aucun message ni action externe ne sera envoyé.
          </p>
          <p className="text-sm leading-relaxed text-slate-400">
            La capacité estimée peut changer avant la confirmation. Les tâches sont créées une par une : en cas d’interruption, celles déjà créées restent enregistrées.
          </p>
          {(automationPreview.already > 0 || automationPreview.remaining > 0 || automationPreview.capacity < 25 || automationPreview.atLimit) && <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-sm text-amber-100">
            {automationPreview.already > 0 && <span>{automationPreview.already} tâche(s) déjà présentes avant l’aperçu. </span>}
            {automationPreview.remaining > 0 && <span>{automationPreview.remaining} tâche(s) restantes au-delà du lot ou de la capacité disponible. </span>}
            {automationPreview.capacity < 25 && <span>Capacité estimée : {automationPreview.capacity} fiche(s) disponible(s) dans Operations Manager. </span>}
            {automationPreview.atLimit && <span>Limite de 500 enregistrements atteinte pour au moins un module : l’aperçu peut être incomplet.</span>}
          </p>}
          <ul className="space-y-2" aria-label="Tâches proposées">
            {automationPreview.items.map(({ draft }) => <li key={`${draft.sourcePlaybookId}:${draft.sourceRecordId}`} className="rounded-xl border border-line bg-white/[0.02] px-4 py-3">
              <p className="break-words font-medium text-white">{draft.title}</p>
              <p className="mt-1 text-sm text-slate-300">Échéance : {draft.dueDate} · Priorité : {draft.priority === 'haute' ? 'haute' : 'moyenne'} · À faire · Non assignée</p>
              <p className="mt-1 break-words text-xs text-slate-400">{draft.notes}</p>
            </li>)}
          </ul>
          <p className="text-xs leading-relaxed text-slate-400">Les créations sont séquentielles, pas atomiques en lot : si une règle ou sa source change, l’exécution s’arrête et les tâches déjà créées restent enregistrées.</p>
        </div>}
      </Modal>
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Supprimer cet enregistrement ?"
        message={`« ${deleting ? textFrom(deleting.data[definition.primaryField]) || 'Sans titre' : ''} » sera définitivement supprimé de ${definition.title}. Cette action ne touche ni vos crédits Studio ni votre abonnement.`}
        confirmLabel="Supprimer"
        danger
        loading={deleteLoading}
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
