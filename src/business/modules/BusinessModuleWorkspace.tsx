import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { businessGrowApi } from '../api';
import type { BusinessModuleRecord } from '../api';
import {
  AUTOMATION_TRIGGERS, MODULE_GROUPS, buildAutomationTasks,
  computeRevenueLeaks, dateFrom, displayFieldValue, formatModuleMoney,
  getModuleDefinition, moduleKeyToCategory, numberFrom, statusOf,
  textFrom, todayIso,
  type DetectedLeak, type ModuleDefinition, type ModuleField, type ModuleRecord,
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
    } else if (field.type === 'date') {
      values[field.key] = todayIso();
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
      step={field.step}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder}
      hint={field.help}
    />
  );
}

export default function BusinessModuleWorkspace() {
  const { moduleKey } = useParams<{ moduleKey: string }>();
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
  const [automationResult, setAutomationResult] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    if (!definition) return;
    setLoading(true);
    setError(null);
    try {
      const result = await businessGrowApi.listModuleRecords(definition.category);
      setRecords(result.records.map(toModuleRecord));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Impossible de charger ce module.');
    } finally {
      setLoading(false);
    }
  }, [definition]);

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
    if (!definition || definition.key !== 'revenue-leak') return;
    setLeaksLoading(true);
    setLeaksError(null);
    try {
      const sourceKeys = ['payment-recovery', 'lead-rescue', 'customer-recovery', 'order-cart-recovery', 'smart-inventory', 'dispute-shield'];
      const results = await Promise.all(sourceKeys.map(async (key) => {
        const module = getModuleDefinition(key)!;
        const response = await businessGrowApi.listModuleRecords(module.category);
        return [key, response.records.map(toModuleRecord)] as const;
      }));
      setLeaks(computeRevenueLeaks(Object.fromEntries(results)));
    } catch (cause) {
      setLeaksError(cause instanceof Error ? cause.message : 'Le détecteur transversal est momentanément indisponible.');
    } finally {
      setLeaksLoading(false);
    }
  }, [definition]);

  useEffect(() => {
    setLeaks([]);
    void loadLeaks();
  }, [loadLeaks]);

  const groups = useMemo(() => MODULE_GROUPS.find((group) => group.id === definition?.group), [definition]);

  const displayKpis = useMemo(() => {
    if (!definition) return [];
    if (definition.key === 'revenue-leak') {
      const exposed = leaks.reduce((total, leak) => total + leak.amount, 0);
      return [
        { label: 'Fuites détectées', hint: 'Calcul transversal sur vos modules', value: leaksLoading ? '…' : String(leaks.length) },
        { label: 'Montant exposé', hint: 'Somme des fuites calculées', value: leaksLoading ? '…' : formatModuleMoney(exposed) },
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
    const payload: Record<string, unknown> = {};
    for (const field of definition.fields) {
      const raw = (values[field.key] ?? '').trim();
      if (field.required && !raw) {
        setFormError(`Le champ « ${field.label} » est obligatoire.`);
        return;
      }
      payload[field.key] = field.type === 'number'
        ? Math.max(field.min ?? 0, numberFrom(raw))
        : raw;
    }
    payload.status = values.status || definition.statuses[0].value;

    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await businessGrowApi.updateModuleRecord(definition.category, editing.id, payload);
        setNotice({ tone: 'success', text: 'Enregistrement mis à jour.' });
      } else {
        await businessGrowApi.createModuleRecord(definition.category, payload);
        setNotice({ tone: 'success', text: 'Enregistrement créé.' });
      }
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
    if (!action) return;
    setBusyId(record.id);
    setNotice(null);
    try {
      await businessGrowApi.updateModuleRecord(definition.category, record.id, action.patch(record.data));
      await load();
      setNotice({ tone: 'success', text: `${action.label} : enregistré.` });
    } catch (cause) {
      setNotice({ tone: 'danger', text: cause instanceof Error ? cause.message : 'Action impossible.' });
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteLoading(true);
    try {
      await businessGrowApi.deleteModuleRecord(definition.category, deleting.id);
      setDeleting(null);
      await load();
      setNotice({ tone: 'success', text: 'Enregistrement supprimé.' });
    } catch (cause) {
      setNotice({ tone: 'danger', text: cause instanceof Error ? cause.message : 'Suppression impossible.' });
    } finally {
      setDeleteLoading(false);
    }
  };

  const runAutomation = async () => {
    setAutomationRunning(true);
    setAutomationResult(null);
    try {
      const sourceKeys = Array.from(new Set(AUTOMATION_TRIGGERS.map((trigger) => trigger.sourceModule)));
      const sourceEntries = await Promise.all(sourceKeys.map(async (key) => {
        const module = getModuleDefinition(key)!;
        const response = await businessGrowApi.listModuleRecords(module.category);
        return [key, response.records.map(toModuleRecord)] as const;
      }));
      const drafts = buildAutomationTasks(records, Object.fromEntries(sourceEntries));
      const existing = await businessGrowApi.listModuleRecords(moduleKeyToCategory('operations-manager'));
      const known = new Set(existing.records.map((record) => `${textFrom(record.data.sourcePlaybookId)}:${textFrom(record.data.sourceRecordId)}`));
      const pending = drafts
        .filter((draft) => !known.has(`${draft.sourcePlaybookId}:${draft.sourceRecordId}`))
        .slice(0, 25);
      let created = 0;
      for (const draft of pending) {
        await businessGrowApi.createModuleRecord(
          moduleKeyToCategory('operations-manager'),
          { ...draft, status: 'a_faire' },
          `${draft.sourcePlaybookId}:${draft.sourceRecordId}`,
        );
        created += 1;
      }
      const skipped = drafts.length - pending.length;
      setAutomationResult({
        tone: created ? 'success' : 'warning',
        text: created
          ? `${created} tâche(s) créée(s) dans Operations Manager${skipped ? `, ${skipped} déjà présente(s)` : ''}.`
          : 'Aucune nouvelle tâche à générer : tout est déjà à jour dans Operations Manager.',
      });
    } catch (cause) {
      setAutomationResult({ tone: 'danger', text: cause instanceof Error ? cause.message : 'Génération impossible.' });
    } finally {
      setAutomationRunning(false);
    }
  };

  const prepareAgentBrief = () => {
    const sample = records.slice(0, 8).map((record) => {
      const primary = textFrom(record.data[definition.primaryField]) || record.id;
      const status = statusOf(definition, record.data.status).label;
      const details = definition.fields
        .filter((field) => field.inList && field.key !== definition.primaryField)
        .slice(0, 3)
        .map((field) => `${field.label} : ${displayFieldValue(definition, record, field)}`)
        .join(' · ');
      return `- ${primary} · ${status}${details ? ` · ${details}` : ''}`;
    });
    const draft = [
      definition.agentPrompt,
      '',
      `Module : ${definition.title} (${records.length} enregistrement${records.length > 1 ? 's' : ''})`,
      ...(sample.length ? sample : ['- Aucun enregistrement pour le moment.']),
      '',
      'Appuie-toi uniquement sur ces données réelles. Si elles ne suffisent pas, dis-le au lieu d’inventer un chiffre.',
    ].join('\n');
    navigate('/app/business', { state: buildBusinessGrowLocationState({ section: 'chat', initialDraft: draft }) });
  };

  const prepareSupportReply = (record: ModuleRecord) => {
    const draft = [
      'Tu es mon agent de support Business Growth. Rédige une réponse professionnelle, empathique et concise à ce client.',
      `Objet : ${textFrom(record.data.subject)}`,
      `Client : ${textFrom(record.data.customer)}`,
      `Canal : ${textFrom(record.data.channel)}`,
      `Priorité : ${textFrom(record.data.priority)}`,
      `Message reçu : ${textFrom(record.data.message)}`,
      'Propose une réponse prête à envoyer et l’action concrète à réaliser. N’invente aucune information.',
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
            <Button variant="secondary" onClick={prepareAgentBrief} icon={<Wand2 size={16} />} className="min-h-11">
              Demander à l’agent
            </Button>
            <Button onClick={openCreate} icon={<Plus size={16} />} className="min-h-11">Nouvel enregistrement</Button>
          </div>
        </div>
        <div className="relative mt-4 grid gap-2 border-t border-line pt-4 text-xs text-slate-500 sm:grid-cols-2">
          <span className="inline-flex items-start gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-400" /> Données Business Growth isolées, aucun crédit Studio consommé.</span>
          <span className="inline-flex items-start gap-2"><Database size={14} className="mt-0.5 shrink-0 text-brand-300" /> Enregistrements réels synchronisés via la fonction sécurisée business-grow.</span>
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
                Chaque règle active est confrontée à vos enregistrements réels. Les tâches dues sont créées dans Operations Manager, sans doublon,
                avec un maximum de 25 tâches par exécution. Aucun envoi externe n’est simulé.
              </p>
            </div>
            <Button onClick={() => void runAutomation()} loading={automationRunning} icon={<Play size={15} />} className="shrink-0">
              Générer les tâches dues
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
            <p className="px-5 py-6 text-sm text-slate-400">Aucune fuite calculée : vos modules ne contiennent pas encore d’élément à risque.</p>
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
                    <span className="text-sm font-semibold text-white">{formatModuleMoney(leak.amount)}</span>
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
