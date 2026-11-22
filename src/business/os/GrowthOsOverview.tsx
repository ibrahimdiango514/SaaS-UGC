import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, ArrowUpRight, BarChart3, BellRing, CalendarClock,
  CheckCircle2, Download, Flame, HandCoins, Target, TrendingUp, Users, Wallet,
} from 'lucide-react';
import { Button, cn } from '../../components/ui';
import { CRM_CATEGORIES, FINANCE_CATEGORIES, useRecords } from '../records/useRecords';
import {
  buildActionCenter, computeCrmDashboard, contactDisplayName, contactFromRecord,
  contactsToCsv, opportunityFromRecord, opportunitiesToCsv, taskFromRecord, tasksToCsv,
  todayIso, type ActionItem,
} from '../crm/model';
import {
  agingBuckets, computeFinanceDashboard, computeReceivableView, effectivePromiseStatus,
  monthlyCollections, overdueReportToCsv, paymentFromRecord, paymentsToCsv, promiseFromRecord,
  receivableFromRecord, receivablesToCsv, reminderFromRecord,
} from '../finance/model';
import type { GrowthOsModule } from './modules';

const money = (value: number | null | undefined, currency = 'XOF') => value === null || value === undefined
  ? '—'
  : new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);

function downloadCsv(name: string, content: string) {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function useGrowthOsData(workspaceId: string | null) {
  const contactsStore = useRecords(CRM_CATEGORIES.contacts, workspaceId);
  const opportunitiesStore = useRecords(CRM_CATEGORIES.opportunities, workspaceId);
  const tasksStore = useRecords(CRM_CATEGORIES.tasks, workspaceId);
  const receivablesStore = useRecords(FINANCE_CATEGORIES.receivables, workspaceId);
  const paymentsStore = useRecords(FINANCE_CATEGORIES.payments, workspaceId);
  const promisesStore = useRecords(FINANCE_CATEGORIES.promises, workspaceId);
  const remindersStore = useRecords(FINANCE_CATEGORIES.reminders, workspaceId);

  const contacts = useMemo(() => contactsStore.records.map(contactFromRecord), [contactsStore.records]);
  const opportunities = useMemo(() => opportunitiesStore.records.map(opportunityFromRecord), [opportunitiesStore.records]);
  const tasks = useMemo(() => tasksStore.records.map(taskFromRecord), [tasksStore.records]);
  const receivables = useMemo(() => receivablesStore.records.map(receivableFromRecord), [receivablesStore.records]);
  const payments = useMemo(() => paymentsStore.records.map(paymentFromRecord), [paymentsStore.records]);
  const promises = useMemo(() => promisesStore.records.map(promiseFromRecord), [promisesStore.records]);
  const reminders = useMemo(() => remindersStore.records.map(reminderFromRecord), [remindersStore.records]);
  const today = todayIso();

  const views = useMemo(
    () => receivables.map((receivable) => computeReceivableView(receivable, payments, today)),
    [receivables, payments, today],
  );
  const crm = useMemo(
    () => computeCrmDashboard({ contacts, opportunities, tasks, now: today }),
    [contacts, opportunities, tasks, today],
  );
  const finance = useMemo(
    () => computeFinanceDashboard({ receivables, payments, promises, reminders, today }),
    [receivables, payments, promises, reminders, today],
  );
  const actions = useMemo<ActionItem[]>(() => buildActionCenter({
    contacts,
    opportunities,
    tasks,
    now: today,
    finance: [
      ...views.filter((view) => view.balance > 0 && view.effectiveStatus === 'en_retard').map((view) => ({
        id: view.receivable.id,
        contactId: view.receivable.contactId,
        label: `Créance ${view.receivable.reference || ''} en retard`,
        amount: view.balance,
        dueDate: view.receivable.dueDate,
        kind: 'creance_en_retard' as const,
      })),
      ...promises
        .filter((promise) => effectivePromiseStatus(promise, today) === 'non_respectee')
        .map((promise) => ({
          id: promise.id,
          contactId: promise.contactId,
          label: 'Promesse de paiement non tenue',
          amount: promise.amount,
          dueDate: promise.promisedAt,
          kind: 'promesse_non_respectee' as const,
        })),
    ],
  }), [contacts, opportunities, tasks, promises, views, today]);

  const loading = contactsStore.loading || opportunitiesStore.loading || tasksStore.loading
    || receivablesStore.loading || paymentsStore.loading || promisesStore.loading || remindersStore.loading;
  const error = contactsStore.error || opportunitiesStore.error || tasksStore.error
    || receivablesStore.error || paymentsStore.error || promisesStore.error || remindersStore.error;

  return {
    contacts, opportunities, tasks, receivables, payments, promises, views, crm, finance,
    actions, loading, error, today,
  };
}

function ModuleIntro({ module, workspaceId }: { module: string; workspaceId: string | null }) {
  if (workspaceId) return null;
  return (
    <section role="status" className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.05] p-4 text-[12px] leading-relaxed text-amber-100">
      Aucune entreprise active. Créez ou sélectionnez une entreprise pour afficher les données réelles du module « {module} ».
    </section>
  );
}

function EmptyHint({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-center">
      <p className="text-[11.5px] font-medium text-slate-300">{title}</p>
      <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500">{text}</p>
    </div>
  );
}

const SEVERITY_TONE: Record<ActionItem['severity'], string> = {
  urgente: 'border-rose-400/25 bg-rose-400/[0.06] text-rose-100',
  elevee: 'border-amber-400/25 bg-amber-400/[0.06] text-amber-100',
  normale: 'border-white/[0.08] bg-white/[0.02] text-slate-300',
};

export function GrowthOsOverview({
  workspaceId, onNavigate,
}: {
  workspaceId: string | null;
  onNavigate: (module: GrowthOsModule) => void;
}) {
  const { contacts, opportunities, tasks, payments, promises, views, crm, finance, actions, loading, error, today } =
    useGrowthOsData(workspaceId);
  const contactById = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact])), [contacts]);
  const nameOf = (id: string) => contactById.get(id) ? contactDisplayName(contactById.get(id)!) : 'Client non relié';

  const warm = useMemo(() => contacts
    .filter((contact) => contact.status !== 'archive')
    .map((contact) => ({ contact, open: opportunities.filter((op) => op.contactId === contact.id && !['gagne', 'perdu'].includes(op.stage)) }))
    .filter((entry) => entry.open.length > 0)
    .slice(0, 4), [contacts, opportunities]);

  const collections = useMemo(() => monthlyCollections(payments, 6, today), [payments, today]);
  const maxCollection = Math.max(1, ...collections.map((entry) => entry.amount));
  const priorityViews = useMemo(
    () => [...views].filter((view) => view.balance > 0).sort((a, b) => b.daysOverdue - a.daysOverdue || b.balance - a.balance).slice(0, 4),
    [views],
  );
  const stageRows = useMemo(() => {
    const open = opportunities.filter((op) => !['gagne', 'perdu'].includes(op.stage));
    const groups = [
      ['Nouveau', 'nouveau'], ['Contacté', 'contacte'], ['Qualifié', 'qualifie'], ['Besoin', 'besoin'],
      ['Proposition', 'proposition'], ['Négociation', 'negociation'],
    ] as const;
    return groups.map(([label, key]) => ({ label, count: open.filter((op) => op.stage === key).length }));
  }, [opportunities]);
  const maxStage = Math.max(1, ...stageRows.map((row) => row.count));

  return (
    <div className="space-y-4" data-testid="growth-os-overview">
      <ModuleIntro module="Vue générale" workspaceId={workspaceId} />

      {error && (
        <section className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] p-3 text-[11.5px] text-rose-100" role="alert">
          Une partie des données n’a pas pu être chargée : {error}
        </section>
      )}

      <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {[
          { label: 'Pipeline pondéré', value: money(crm.weightedPipeline), hint: `${crm.openOpportunities} opportunité(s) ouverte(s)`, icon: Target, tone: 'text-violet-200' },
          { label: 'Encaissé ce mois', value: money(finance.monthCollected), hint: finance.recoveryRate === null ? 'Taux indisponible' : `${finance.recoveryRate} % de recouvrement`, icon: Wallet, tone: 'text-emerald-200' },
          { label: 'Solde restant', value: money(finance.balanceTotal), hint: `${finance.openCount} créance(s) ouverte(s)`, icon: HandCoins, tone: 'text-cyan-200' },
          { label: 'Montant en retard', value: money(finance.overdueTotal), hint: `${finance.overdueCount} créance(s) en retard`, icon: BellRing, tone: 'text-rose-200' },
        ].map((card) => (
          <div key={card.label} className="vyora-card p-3.5">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">{card.label}</p>
              <card.icon size={14} className={card.tone} />
            </div>
            <p className="mt-1.5 truncate text-[17px] font-semibold text-white">{loading ? '…' : card.value}</p>
            <p className="mt-0.5 truncate text-[10px] text-slate-500">{card.hint}</p>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Prospects', String(crm.prospects)],
          ['Clients', String(crm.clients)],
          ['Tâches du jour', String(crm.todayTasks)],
          ['Tâches en retard', String(crm.overdueTasks)],
          ['Promesses non tenues', String(finance.promisesBroken)],
          ['Prospects chauds', String(crm.hotProspects)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
            <p className="text-[9.5px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 text-[15px] font-semibold text-white">{loading ? '…' : value}</p>
          </div>
        ))}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)]">
        <section className="vyora-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white"><Flame size={14} className="text-amber-200" /> À traiter maintenant</h2>
              <p className="mt-0.5 text-[10.5px] text-slate-500">Actions calculées depuis vos contacts, tâches, créances et promesses réels.</p>
            </div>
            <Link to="/app/business/crm" className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-200 hover:text-violet-100">
              Centre d’action CRM <ArrowUpRight size={12} />
            </Link>
          </div>
          <div className="mt-3 space-y-1.5">
            {!loading && actions.length === 0 && (
              <EmptyHint title="Rien d’urgent pour l’instant" text="Ajoutez des contacts, des tâches ou des créances : les priorités apparaîtront ici automatiquement." />
            )}
            {loading && <p className="text-[11px] text-slate-500">Chargement des priorités…</p>}
            {actions.slice(0, 7).map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => onNavigate('crm')}
                className={cn('flex w-full items-start justify-between gap-2 rounded-xl border px-3 py-2 text-left transition hover:brightness-110', SEVERITY_TONE[action.severity])}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[11.5px] font-medium">{action.title}</span>
                  <span className="mt-0.5 block truncate text-[10px] opacity-70">{action.detail}</span>
                </span>
                <span className="shrink-0 text-[10px] font-semibold">{action.amount ? money(action.amount) : action.actionLabel}</span>
              </button>
            ))}
          </div>
        </section>

        <div className="space-y-4">
          <section className="vyora-card p-4">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white"><TrendingUp size={14} className="text-emerald-200" /> Encaissements — 6 mois</h2>
            <p className="mt-0.5 text-[10.5px] text-slate-500">Paiements validés uniquement, hors annulations.</p>
            <div className="mt-3 flex h-28 items-end gap-2">
              {collections.map((entry) => (
                <div key={entry.month} className="flex h-full flex-1 flex-col items-center gap-1">
                  <div className="flex w-full flex-1 items-end" title={money(entry.amount)}>
                    <div className="w-full rounded-t bg-emerald-400/70" style={{ height: `${Math.max(3, Math.round((entry.amount / maxCollection) * 100))}%` }} />
                  </div>
                  <span className="text-[9px] text-slate-500">{entry.month.slice(5)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="vyora-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white"><BellRing size={14} className="text-rose-200" /> Créances prioritaires</h2>
              <button type="button" onClick={() => onNavigate('recouvrement')} className="text-[11px] text-violet-200 hover:text-violet-100">Recouvrement</button>
            </div>
            <div className="mt-2 space-y-1.5">
              {!loading && priorityViews.length === 0 && <p className="text-[11px] text-slate-500">Aucune créance ouverte.</p>}
              {priorityViews.map((view) => (
                <div key={view.receivable.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] px-2.5 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate text-[11px] text-slate-200">{nameOf(view.receivable.contactId)}</span>
                    <span className="block text-[9.5px] text-slate-500">{view.receivable.reference || 'Sans référence'} · échéance {view.receivable.dueDate || '—'}</span>
                  </span>
                  <span className={cn('shrink-0 text-[11px] font-semibold', view.daysOverdue > 0 ? 'text-rose-200' : 'text-slate-300')}>{money(view.balance)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="vyora-card p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white"><BarChart3 size={14} className="text-violet-200" /> Pipeline par étape</h2>
            <button type="button" onClick={() => onNavigate('pipeline')} className="text-[11px] text-violet-200 hover:text-violet-100">Ouvrir le pipeline</button>
          </div>
          <div className="mt-3 space-y-2">
            {stageRows.map((row) => (
              <div key={row.label}>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-slate-400">{row.label}</span>
                  <span className="text-slate-300">{row.count}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-white/[0.06]">
                  <div className="h-full rounded-full bg-gradient-to-r from-violet-400/80 to-cyan-300/70" style={{ width: `${Math.round((row.count / maxStage) * 100)}%` }} />
                </div>
              </div>
            ))}
            {!loading && opportunities.length === 0 && <p className="text-[11px] text-slate-500">Aucune opportunité enregistrée.</p>}
          </div>
        </section>

        <section className="vyora-card p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white"><Users size={14} className="text-cyan-200" /> Opportunités à suivre</h2>
            <button type="button" onClick={() => onNavigate('tasks')} className="text-[11px] text-violet-200 hover:text-violet-100">Tâches</button>
          </div>
          <div className="mt-2 space-y-1.5">
            {!loading && warm.length === 0 && <p className="text-[11px] text-slate-500">Aucun contact avec une opportunité ouverte.</p>}
            {warm.map(({ contact, open }) => (
              <button key={contact.id} type="button" onClick={() => onNavigate('crm')} className="flex w-full items-center justify-between gap-2 rounded-lg border border-white/[0.06] px-2.5 py-1.5 text-left hover:bg-white/[0.03]">
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-medium text-slate-200">{contactDisplayName(contact)}</span>
                  <span className="block truncate text-[9.5px] text-slate-500">{open.length} opportunité(s) · {contact.company || 'Entreprise non renseignée'}</span>
                </span>
                <span className="shrink-0 text-[10px] text-cyan-200">{money(open.reduce((sum, op) => sum + (op.amount ?? 0), 0))}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { label: 'Nouveau contact', to: '/app/business/crm', icon: Users },
          { label: 'Nouvelle créance', to: '/app/business/finance', icon: Wallet },
          { label: 'Relancer un client', to: '/app/business/relances', icon: BellRing },
          { label: 'Demander à l’IA', to: '/app/business/assistant', icon: BarChart3 },
        ].map((item) => (
          <Link key={item.label} to={item.to} className="group flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-[11.5px] font-medium text-slate-300 transition hover:border-violet-300/25 hover:text-white">
            <item.icon size={14} className="text-violet-200" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <ArrowRight size={12} className="text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-violet-200" />
          </Link>
        ))}
      </section>

      <p className="flex items-center gap-1.5 px-1 text-[10px] text-slate-600">
        <CheckCircle2 size={11} className="text-emerald-300/70" /> Tous les chiffres sont calculés depuis les enregistrements de cet espace. {tasks.filter((task) => task.status === 'a_faire').length} tâche(s) active(s), {promises.length} promesse(s) suivie(s).
      </p>
    </div>
  );
}

export function GrowthOsReports({ workspaceId }: { workspaceId: string | null }) {
  const { contacts, opportunities, tasks, payments, promises, receivables, views, crm, finance, loading, error, today } =
    useGrowthOsData(workspaceId);
  const contactById = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact])), [contacts]);
  const nameOf = (id: string) => contactById.get(id) ? contactDisplayName(contactById.get(id)!) : 'Client non relié';
  const aging = useMemo(() => agingBuckets(views), [views]);
  const collections = useMemo(() => monthlyCollections(payments, 6, today), [payments, today]);
  const maxCollection = Math.max(1, ...collections.map((entry) => entry.amount));
  const debtors = useMemo(() => {
    const totals = new Map<string, number>();
    for (const view of views) {
      if (view.balance <= 0) continue;
      totals.set(view.receivable.contactId, (totals.get(view.receivable.contactId) ?? 0) + view.balance);
    }
    return [...totals.entries()].map(([id, balance]) => ({ id, balance })).sort((a, b) => b.balance - a.balance).slice(0, 6);
  }, [views]);
  const brokenPromises = promises.filter((promise) => effectivePromiseStatus(promise, today) === 'non_respectee').length;

  return (
    <div className="space-y-4" data-testid="growth-os-reports">
      <ModuleIntro module="Rapports et analyses" workspaceId={workspaceId} />
      {error && (
        <section className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] p-3 text-[11.5px] text-rose-100" role="alert">
          Données partielles : {error}
        </section>
      )}

      <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {[
          ['Taux de conversion', crm.conversionRate === null ? '—' : `${crm.conversionRate} %`, `${crm.clients} client(s) / ${crm.totalContacts} contact(s)`],
          ['Taux de victoire', crm.winRate === null ? '—' : `${crm.winRate} %`, `${crm.wonOpportunities} gagnée(s) · ${crm.lostOpportunities} perdue(s)`],
          ['CA gagné (connu)', money(crm.wonValue), 'Opportunités gagnées avec montant renseigné'],
          ['Taux de recouvrement', finance.recoveryRate === null ? '—' : `${finance.recoveryRate} %`, `${money(finance.paidTotal)} encaissé(s)`],
        ].map(([label, value, hint]) => (
          <div key={label} className="vyora-card p-3.5">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1.5 text-[17px] font-semibold text-white">{loading ? '…' : value}</p>
            <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{hint}</p>
          </div>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="vyora-card p-4">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white"><TrendingUp size={14} className="text-emerald-200" /> Recouvrement mensuel</h2>
          <p className="mt-0.5 text-[10.5px] text-slate-500">Paiements validés sur les six derniers mois.</p>
          <div className="mt-3 flex h-36 items-end gap-2">
            {collections.map((entry) => (
              <div key={entry.month} className="flex h-full flex-1 flex-col items-center gap-1">
                <span className="text-[9px] text-slate-400">{entry.amount ? money(entry.amount) : ''}</span>
                <div className="flex w-full flex-1 items-end">
                  <div className="w-full rounded-t bg-emerald-400/70" style={{ height: `${Math.max(3, Math.round((entry.amount / maxCollection) * 100))}%` }} title={money(entry.amount)} />
                </div>
                <span className="text-[9px] text-slate-500">{entry.month.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="vyora-card p-4">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white"><AlertTriangle size={14} className="text-amber-200" /> Répartition des retards</h2>
          <div className="mt-3 space-y-2">
            {([
              ['Non échu', aging.non_echu, 'bg-emerald-400/70'],
              ['1–30 jours', aging.retard_1_30, 'bg-amber-300/80'],
              ['31–60 jours', aging.retard_31_60, 'bg-orange-400/75'],
              ['61–90 jours', aging.retard_61_90, 'bg-rose-400/70'],
              ['Plus de 90 jours', aging.retard_90_plus, 'bg-rose-500/80'],
            ] as const).map(([label, value, tone]) => (
              <div key={label}>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-slate-400">{label}</span>
                  <span className="text-slate-300">{money(value)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-white/[0.06]">
                  <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.round((value / Math.max(1, ...Object.values(aging))) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] text-slate-500">{finance.overdueCount} créance(s) en retard · {brokenPromises} promesse(s) non tenue(s).</p>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="vyora-card p-4">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white"><BarChart3 size={14} className="text-violet-200" /> Sources d’acquisition</h2>
          <div className="mt-2 space-y-1.5">
            {!loading && crm.topSources.length === 0 && <EmptyHint title="Aucune source renseignée" text="Renseignez la source d’un contact pour alimenter cette analyse." />}
            {crm.topSources.slice(0, 8).map((source) => (
              <div key={source.source} className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] px-2.5 py-1.5 text-[11px]">
                <span className="truncate text-slate-300">{source.source}</span>
                <span className="shrink-0 text-slate-500">{source.count} contact(s) · {source.won} gagnée(s)</span>
              </div>
            ))}
          </div>
        </section>

        <section className="vyora-card p-4">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white"><Users size={14} className="text-cyan-200" /> Principaux débiteurs</h2>
          <div className="mt-2 space-y-1.5">
            {!loading && debtors.length === 0 && <EmptyHint title="Aucun solde restant" text="Toutes les créances actives sont soldées ou aucune créance n’existe." />}
            {debtors.map((debtor) => (
              <div key={debtor.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] px-2.5 py-1.5 text-[11px]">
                <span className="truncate text-slate-300">{nameOf(debtor.id)}</span>
                <span className="shrink-0 font-semibold text-rose-200">{money(debtor.balance)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="vyora-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white"><Download size={14} className="text-emerald-200" /> Exports réels</h2>
            <p className="mt-0.5 text-[10.5px] text-slate-500">Fichiers CSV générés depuis les enregistrements de cet espace uniquement.</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => downloadCsv('contacts-crm.csv', contactsToCsv(contacts))}>Contacts</Button>
            <Button size="sm" variant="ghost" onClick={() => downloadCsv('opportunites-crm.csv', opportunitiesToCsv(opportunities))}>Opportunités</Button>
            <Button size="sm" variant="ghost" onClick={() => downloadCsv('creances.csv', receivablesToCsv(views, nameOf))}>Créances</Button>
            <Button size="sm" variant="ghost" onClick={() => downloadCsv('paiements.csv', paymentsToCsv(payments, (id) => receivables.find((receivable) => receivable.id === id)?.reference ?? ''))}>Paiements</Button>
            <Button size="sm" variant="ghost" onClick={() => downloadCsv('rapport-retard.csv', overdueReportToCsv(views, nameOf))}>Retards</Button>
            <Button size="sm" variant="ghost" onClick={() => downloadCsv('taches-crm.csv', tasksToCsv(tasks))}>Tâches</Button>
          </div>
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[10px] text-slate-500">
          <CalendarClock size={11} className="text-violet-200" /> Les exports n’incluent ni mot de passe, ni jeton, ni donnée d’un autre espace.
        </p>
      </section>
    </div>
  );
}
