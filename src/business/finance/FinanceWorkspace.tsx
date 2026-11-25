import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3, BellRing, CalendarClock, Check, ChevronRight, Download, FileText, HandCoins,
  Plus, RefreshCw, Scale, ShieldAlert, Users, Wallet,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Modal, ProgressBar, Select, Textarea, cn } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { CRM_CATEGORIES, FINANCE_CATEGORIES, useRecords } from '../records/useRecords';
import { contactDisplayName, contactFromRecord, todayIso, type Contact } from '../crm/model';
import {
  PAYMENT_METHODS, PROMISE_STATUSES, RECEIVABLE_STATUSES, RECOVERY_TEMPLATES, agingBuckets,
  buildReceipt, computeFinanceDashboard, computeReceivableView, computeRecoveryRisk,
  disputeFromRecord, effectivePromiseStatus, groupSchedule, monthlyCollections,
  overdueReportToCsv, paymentFromRecord, paymentToData, paymentsToCsv, promiseFromRecord,
  promiseToData, receivableFromRecord, receivableToData, receivablesToCsv,
  recoveryMailtoLink, recoveryWhatsappLink, reminderFromRecord, reminderToData,
  renderRecoveryTemplate, validateCancellation, validatePayment,
  type CollectionReminder, type DisputeStatus, type Payment, type PaymentMethod,
  type PaymentPromise, type PromiseStatus, type Receivable, type ReceivableDispute,
  type ReceivableView, type RecoveryRisk,
} from './model';
import { useGrandEcran } from '../../lib/media-query';

export type FinanceTab = 'dashboard' | 'creances' | 'echeancier' | 'recouvrement' | 'promesses' | 'litiges';

const TABS: { id: FinanceTab; label: string; icon: typeof Wallet }[] = [
  { id: 'dashboard', label: 'Tableau de bord', icon: BarChart3 },
  { id: 'creances', label: 'Créances', icon: FileText },
  { id: 'echeancier', label: 'Échéancier', icon: CalendarClock },
  { id: 'recouvrement', label: 'Recouvrement', icon: BellRing },
  { id: 'promesses', label: 'Promesses', icon: HandCoins },
  { id: 'litiges', label: 'Litiges', icon: Scale },
];

const money = (value: number | null, currency = 'XOF') => value === null
  ? '—'
  : new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);

function statusLabel(status: string): string {
  return RECEIVABLE_STATUSES.find((entry) => entry.value === status)?.label ?? status;
}

function statusTone(status: string): string {
  return RECEIVABLE_STATUSES.find((entry) => entry.value === status)?.tone ?? 'neutral';
}

function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([`\uFEFF${content}`], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function defaultDueDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().slice(0, 10);
}

function emptyReceivableForm(contactId = '') {
  return {
    reference: '', contactId, description: '', initialAmount: '', issuedAt: todayIso(),
    dueDate: defaultDueDate(), terms: 'Paiement à 30 jours', status: 'en_attente', owner: '', notes: '',
  };
}

export default function FinanceWorkspace({
  workspaceId, initialContactId, onInitialContactHandled, onOpenContact,
  initialTab = 'dashboard', lockTab = false,
}: {
  workspaceId: string | null;
  initialContactId?: string | null;
  onInitialContactHandled?: () => void;
  onOpenContact: (contactId: string) => void;
  /** Module Growth OS : l'onglet interne peut être imposé par la route. */
  initialTab?: FinanceTab;
  lockTab?: boolean;
}) {
  // Une seule vue montée à la fois : liste tactile ou tableau.
  const grandEcran = useGrandEcran();
  const toast = useToast();
  const [tab, setTab] = useState<FinanceTab>(initialTab);
  const contactsStore = useRecords(CRM_CATEGORIES.contacts, workspaceId);
  const receivablesStore = useRecords(FINANCE_CATEGORIES.receivables, workspaceId);
  const paymentsStore = useRecords(FINANCE_CATEGORIES.payments, workspaceId);
  const remindersStore = useRecords(FINANCE_CATEGORIES.reminders, workspaceId);
  const promisesStore = useRecords(FINANCE_CATEGORIES.promises, workspaceId);
  const disputesStore = useRecords(FINANCE_CATEGORIES.disputes, workspaceId);

  const contacts = useMemo(() => contactsStore.records.map(contactFromRecord), [contactsStore.records]);
  const receivables = useMemo(() => receivablesStore.records.map(receivableFromRecord), [receivablesStore.records]);
  const payments = useMemo(() => paymentsStore.records.map(paymentFromRecord), [paymentsStore.records]);
  const reminders = useMemo(() => remindersStore.records.map(reminderFromRecord), [remindersStore.records]);
  const promises = useMemo(() => promisesStore.records.map(promiseFromRecord), [promisesStore.records]);
  const disputes = useMemo(() => disputesStore.records.map(disputeFromRecord), [disputesStore.records]);

  const loading = contactsStore.loading || receivablesStore.loading || paymentsStore.loading;
  const loadError = receivablesStore.error || paymentsStore.error;
  const now = todayIso();

  const contactById = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact])), [contacts]);
  const contactName = (id: string) => {
    const contact = contactById.get(id);
    return contact ? contactDisplayName(contact) : 'Client non relié';
  };
  const views = useMemo(() => receivables.map((receivable) => computeReceivableView(receivable, payments, now)), [now, payments, receivables]);
  const viewById = useMemo(() => new Map(views.map((view) => [view.receivable.id, view])), [views]);
  const riskById = useMemo(() => new Map(views.map((view) => [view.receivable.id, computeRecoveryRisk({ view, promises, reminders, disputes, today: now })])), [disputes, now, promises, reminders, views]);
  const dashboard = useMemo(() => computeFinanceDashboard({ receivables, payments, promises, reminders, today: now }), [now, payments, promises, receivables, reminders]);
  const collections = useMemo(() => monthlyCollections(payments, 6, now), [now, payments]);
  const aging = useMemo(() => agingBuckets(views), [views]);
  const schedule = useMemo(() => groupSchedule(views, now), [now, views]);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'toutes' | string>('toutes');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [receivableModal, setReceivableModal] = useState<{ open: boolean; editing: Receivable | null }>({ open: false, editing: null });
  const [receivableForm, setReceivableForm] = useState(emptyReceivableForm());
  const [paymentModal, setPaymentModal] = useState<{ view: ReceivableView; requestId: string } | null>(null);
  const [paymentForm, setPaymentForm] = useState({ amount: '', paidAt: todayIso(), method: 'mobile_money' as PaymentMethod, reference: '', note: '' });
  const [cancelPayment, setCancelPayment] = useState<{ payment: Payment; view: ReceivableView } | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [receipt, setReceipt] = useState<ReturnType<typeof buildReceipt> | null>(null);
  const [promiseModal, setPromiseModal] = useState<{ view: ReceivableView; editing: PaymentPromise | null } | null>(null);
  const [promiseForm, setPromiseForm] = useState({ amount: '', promisedAt: todayIso(), note: '', status: 'a_venir' as PromiseStatus, outcome: '' });
  const [reminderModal, setReminderModal] = useState<{ view: ReceivableView; editing: CollectionReminder | null } | null>(null);
  const [reminderForm, setReminderForm] = useState({ template: RECOVERY_TEMPLATES[0].id, channel: 'whatsapp' as CollectionReminder['channel'], dueDate: todayIso(), message: '', note: '' });
  const [disputeModal, setDisputeModal] = useState<{ view: ReceivableView; editing: ReceivableDispute | null } | null>(null);
  const [disputeForm, setDisputeForm] = useState({ reason: '', description: '', openedAt: todayIso(), owner: '', status: 'ouvert' as DisputeStatus, resolution: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialContactId) {
      setReceivableForm(emptyReceivableForm(initialContactId));
      setReceivableModal({ open: true, editing: null });
      setTab('creances');
      onInitialContactHandled?.();
    }
  }, [initialContactId, onInitialContactHandled]);

  const reloadAll = async () => {
    await Promise.all([
      contactsStore.reload(), receivablesStore.reload(), paymentsStore.reload(),
      remindersStore.reload(), promisesStore.reload(), disputesStore.reload(),
    ]);
  };

  const filteredViews = views.filter((view) => {
    if (statusFilter !== 'toutes' && view.effectiveStatus !== statusFilter) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${view.receivable.reference} ${view.receivable.description} ${view.receivable.owner} ${contactName(view.receivable.contactId)}`
      .toLowerCase().includes(needle);
  }).sort((a, b) => b.balance - a.balance);

  const selected = selectedId ? viewById.get(selectedId) ?? null : null;

  const openReceivable = (receivable?: Receivable) => {
    setReceivableForm(receivable ? {
      reference: receivable.reference, contactId: receivable.contactId, description: receivable.description,
      initialAmount: receivable.initialAmount === null ? '' : String(receivable.initialAmount),
      issuedAt: receivable.issuedAt, dueDate: receivable.dueDate, terms: receivable.terms,
      status: receivable.status, owner: receivable.owner, notes: receivable.notes,
    } : emptyReceivableForm());
    setReceivableModal({ open: true, editing: receivable ?? null });
  };

  const saveReceivable = async () => {
    if (!receivableForm.contactId) { toast.warning('Reliez la créance à un contact CRM.'); return; }
    if (!receivableForm.description.trim()) { toast.warning('Décrivez la créance.'); return; }
    const initial = Number(receivableForm.initialAmount);
    if (!Number.isFinite(initial) || initial <= 0) { toast.warning('Le montant initial doit être positif.'); return; }
    if (!receivableForm.dueDate) { toast.warning('L’échéance est obligatoire.'); return; }
    setBusy(true);
    try {
      const payload = {
        ...receivableForm,
        reference: receivableForm.reference.trim() || `FAC-${now.replace(/-/g, '').slice(0, 6)}-${receivables.length + 1}`,
        initialAmount: initial,
      };
      if (receivableModal.editing) {
        await receivablesStore.update(receivableModal.editing.id, payload);
        toast.success('Créance mise à jour.');
      } else {
        await receivablesStore.create(payload);
        toast.success('Créance créée. Aucun paiement n’est enregistré automatiquement.');
      }
      setReceivableModal({ open: false, editing: null });
    } catch (error) { toast.error(asAppError(error).message); } finally { setBusy(false); }
  };

  const openPayment = (view: ReceivableView) => {
    setPaymentForm({
      amount: String(view.balance), paidAt: todayIso(), method: 'mobile_money',
      reference: '', note: '',
    });
    setPaymentModal({ view, requestId: crypto.randomUUID() });
  };

  const submitPayment = async () => {
    if (!paymentModal) return;
    const input = {
      receivableId: paymentModal.view.receivable.id,
      amount: paymentForm.amount === '' ? null : Number(paymentForm.amount),
      paidAt: paymentForm.paidAt,
      reference: paymentForm.reference.trim(),
      clientRequestId: paymentModal.requestId,
    };
    const validation = validatePayment(input, viewById.get(paymentModal.view.receivable.id) ?? paymentModal.view, payments, now);
    if (!validation.ok) { toast.warning(validation.errors[0]); return; }
    setBusy(true);
    try {
      const createdId = await paymentsStore.create({
        receivableId: input.receivableId, amount: input.amount, paidAt: input.paidAt,
        method: paymentForm.method, reference: input.reference, note: paymentForm.note.trim(),
        author: '', clientRequestId: paymentModal.requestId, status: 'valide', cancelled: false,
      }, paymentModal.requestId);
      if (payments.some((payment) => payment.id === createdId)) {
        toast.warning('Ce paiement avait déjà été enregistré. Aucun doublon n’a été créé.');
        setPaymentModal(null);
        return;
      }
      const refreshedPayments = [...payments, {
        id: `tmp-${paymentModal.requestId}`, receivableId: input.receivableId, amount: input.amount ?? 0,
        paidAt: input.paidAt, method: paymentForm.method, reference: input.reference, note: '',
        author: '', clientRequestId: paymentModal.requestId, cancelled: false,
        cancellationReason: '', cancelledAt: '', createdAt: new Date().toISOString(),
      } as Payment];
      const refreshed = computeReceivableView(paymentModal.view.receivable, refreshedPayments, now);
      const contact = contactById.get(paymentModal.view.receivable.contactId);
      setReceipt(buildReceipt({
        payment: refreshedPayments[refreshedPayments.length - 1], view: refreshed,
        contactName: contact ? contactDisplayName(contact) : 'Client', company: contact?.company ?? '',
      }));
      setPaymentModal(null);
      toast.success('Paiement enregistré.');
    } catch (error) { toast.error(asAppError(error).message); } finally { setBusy(false); }
  };

  const confirmCancelPayment = async () => {
    if (!cancelPayment) return;
    const validation = validateCancellation(cancelReason);
    if (!validation.ok) { toast.warning(validation.errors[0]); return; }
    setBusy(true);
    try {
      await paymentsStore.update(cancelPayment.payment.id, {
        ...paymentToData(cancelPayment.payment), cancelled: true,
        cancellationReason: cancelReason.trim(), cancelledAt: todayIso(), status: 'annule',
      });
      toast.success('Paiement annulé. Le solde de la créance a été recalculé.');
      setCancelPayment(null);
      setCancelReason('');
    } catch (error) { toast.error(asAppError(error).message); } finally { setBusy(false); }
  };

  const openPromise = (view: ReceivableView, editing: PaymentPromise | null = null) => {
    setPromiseForm(editing ? {
      amount: editing.amount === null ? '' : String(editing.amount), promisedAt: editing.promisedAt,
      note: editing.note, status: editing.status, outcome: editing.outcome,
    } : { amount: String(view.balance), promisedAt: todayIso(), note: '', status: 'a_venir', outcome: '' });
    setPromiseModal({ view, editing });
  };

  const savePromise = async () => {
    if (!promiseModal) return;
    if (!promiseForm.promisedAt) { toast.warning('La date promise est obligatoire.'); return; }
    setBusy(true);
    try {
      const payload = {
        contactId: promiseModal.view.receivable.contactId,
        receivableId: promiseModal.view.receivable.id,
        amount: promiseForm.amount === '' ? null : Number(promiseForm.amount),
        promisedAt: promiseForm.promisedAt, note: promiseForm.note, status: promiseForm.status,
        outcome: promiseForm.outcome,
      };
      if (promiseModal.editing) await promisesStore.update(promiseModal.editing.id, payload);
      else await promisesStore.create(payload);
      toast.success('Promesse de paiement enregistrée. Aucun paiement n’est créé automatiquement.');
      setPromiseModal(null);
    } catch (error) { toast.error(asAppError(error).message); } finally { setBusy(false); }
  };

  const openReminder = (view: ReceivableView, templateId = RECOVERY_TEMPLATES[0].id) => {
    const template = RECOVERY_TEMPLATES.find((entry) => entry.id === templateId) ?? RECOVERY_TEMPLATES[0];
    const contact = contactById.get(view.receivable.contactId);
    setReminderForm({
      template: template.id, channel: template.channel, dueDate: todayIso(),
      message: renderRecoveryTemplate(template.body, {
        contact: contact ? contactDisplayName(contact) : 'Client',
        reference: view.receivable.reference || 'sans référence',
        montant: money(view.balance, view.receivable.initialAmount === null ? 'XOF' : 'XOF'),
        date: view.receivable.dueDate || now,
        responsable: view.receivable.owner || 'Votre équipe',
      }),
      note: '',
    });
    setReminderModal({ view, editing: null });
  };

  const saveReminder = async () => {
    if (!reminderModal) return;
    setBusy(true);
    try {
      await remindersStore.create({
        receivableId: reminderModal.view.receivable.id,
        contactId: reminderModal.view.receivable.contactId,
        dueDate: reminderForm.dueDate, channel: reminderForm.channel, template: reminderForm.template,
        message: reminderForm.message, note: reminderForm.note, status: 'a_faire', outcome: '',
      });
      toast.success('Relance programmée. Aucun message n’a été envoyé automatiquement.');
      setReminderModal(null);
    } catch (error) { toast.error(asAppError(error).message); } finally { setBusy(false); }
  };

  const openDispute = (view: ReceivableView, editing: ReceivableDispute | null = null) => {
    setDisputeForm(editing ? {
      reason: editing.reason, description: editing.description, openedAt: editing.openedAt,
      owner: editing.owner, status: editing.status, resolution: editing.resolution,
    } : { reason: '', description: '', openedAt: todayIso(), owner: view.receivable.owner, status: 'ouvert', resolution: '' });
    setDisputeModal({ view, editing });
  };

  const saveDispute = async () => {
    if (!disputeModal) return;
    if (!disputeForm.reason.trim()) { toast.warning('Le motif du litige est obligatoire.'); return; }
    setBusy(true);
    try {
      const payload = {
        receivableId: disputeModal.view.receivable.id,
        contactId: disputeModal.view.receivable.contactId,
        reason: disputeForm.reason, description: disputeForm.description, openedAt: disputeForm.openedAt,
        owner: disputeForm.owner, status: disputeForm.status, resolution: disputeForm.resolution,
      };
      if (disputeModal.editing) await disputesStore.update(disputeModal.editing.id, payload);
      else {
        await disputesStore.create(payload);
        if (disputeForm.status === 'ouvert' && disputeModal.view.receivable.status !== 'litige') {
          await receivablesStore.update(disputeModal.view.receivable.id, { ...receivableToData(disputeModal.view.receivable), status: 'litige' });
        }
      }
      toast.success('Litige enregistré.');
      setDisputeModal(null);
    } catch (error) { toast.error(asAppError(error).message); } finally { setBusy(false); }
  };

  const markReminderDone = async (reminder: CollectionReminder) => {
    try {
      await remindersStore.update(reminder.id, { ...reminderToData(reminder), status: 'termine', outcome: 'Relance effectuée' });
      toast.success('Relance marquée terminée.');
    } catch (error) { toast.error(asAppError(error).message); }
  };

  const setPromiseStatus = async (promise: PaymentPromise, status: PromiseStatus) => {
    try {
      await promisesStore.update(promise.id, { ...promiseToData(promise), status });
      toast.success('Statut de la promesse mis à jour.');
    } catch (error) { toast.error(asAppError(error).message); }
  };

  if (loading && !receivables.length) return <LoadingState label="Chargement des finances…" />;
  if (loadError && !receivables.length) return <ErrorState message={loadError} onRetry={() => void reloadAll()} />;

  const maxCollection = Math.max(1, ...collections.map((entry) => entry.amount));
  const urgentViews = views.filter((view) => view.balance > 0 && !['payee', 'annulee'].includes(view.effectiveStatus))
    .sort((a, b) => (riskById.get(b.receivable.id)?.score ?? 0) - (riskById.get(a.receivable.id)?.score ?? 0));

  return (
    <div className="space-y-4" data-testid="finance-workspace">
      <header className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#080d15] px-4 py-5 sm:px-6">
        <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-emerald-400/15 blur-[70px]" />
        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-200">SORAHNEX · Finances & recouvrement</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-white sm:text-2xl">Chaque créance, chaque encaissement, sans double comptage</h2>
            <p className="mt-1 max-w-2xl text-xs text-slate-400">Les soldes sont recalculés depuis les paiements validés. Les relances restent préparées : aucun message n’est envoyé automatiquement.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void reloadAll()}>Actualiser</Button>
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => openReceivable()}>Nouvelle créance</Button>
          </div>
        </div>
        <div className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['Solde restant', money(dashboard.balanceTotal), `${dashboard.openCount} créance(s) ouverte(s)`],
            ['En retard', money(dashboard.overdueTotal), `${dashboard.overdueCount} créance(s)`],
            ['Encaissé ce mois', money(dashboard.monthCollected), `${dashboard.recoveryRate === null ? '—' : `${dashboard.recoveryRate} %`} de recouvrement`],
            ['Promesses non tenues', String(dashboard.promisesBroken), `${dashboard.promisesUpcoming} à venir`],
          ].map(([label, value, hint]) => (
            <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
              <p className="text-[10px] text-slate-500">{label}</p>
              <p className="mt-0.5 truncate text-sm font-semibold text-white">{value}</p>
              <p className="truncate text-[9px] text-slate-600">{hint}</p>
            </div>
          ))}
        </div>
      </header>

      {!lockTab && <div className="no-scrollbar flex gap-1.5 overflow-x-auto rounded-xl border border-white/[0.06] bg-white/[0.02] p-1">
        {TABS.map((entry) => {
          const Icon = entry.icon;
          return (
            <button key={entry.id} type="button" onClick={() => setTab(entry.id)}
              className={cn('flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium',
                tab === entry.id ? 'bg-emerald-400/15 text-emerald-100' : 'text-slate-400 hover:bg-white/5 hover:text-white')}>
              <Icon size={12} />{entry.label}
            </button>
          );
        })}
      </div>}

      {tab === 'dashboard' && (
        <div className="space-y-3" data-testid="finance-dashboard">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Montant initial', money(dashboard.initialTotal), 'Créances actives, montants tous renseignés'],
              ['Total encaissé', money(dashboard.paidTotal), 'Paiements validés uniquement'],
              ['Clients débiteurs', String(dashboard.debtorCount), 'Contacts CRM avec solde restant'],
              ['Échéances ≤ 7 jours', money(dashboard.dueSoonTotal), 'Encours arrivant à échéance'],
              ['Relances à traiter', String(dashboard.urgentReminders), 'Programmées dans les 48 h'],
              ['Créances en litige', String(views.filter((view) => view.effectiveStatus === 'litige').length), 'Statut explicite'],
              ['Paiements reçus', String(payments.filter((payment) => !payment.cancelled).length), `${payments.filter((payment) => payment.cancelled).length} annulé(s)`],
              ['Promesses à venir', String(dashboard.promisesUpcoming), `${dashboard.promisesBroken} non tenue(s)`],
            ].map(([label, value, hint]) => (
              <div key={label} className="vyora-card p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
                <p className="mt-1 text-lg font-semibold text-white">{value}</p>
                <p className="text-[10px] text-slate-600">{hint}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <section className="vyora-card p-4">
              <h3 className="text-sm font-semibold text-white">Encaissements des six derniers mois</h3>
              <p className="text-[10px] text-slate-500">Paiements validés uniquement.</p>
              <div className="mt-3 flex h-32 items-end gap-2">
                {collections.map((entry) => (
                  <div key={entry.month} className="flex h-full flex-1 flex-col items-center gap-1">
                    <div className="flex w-full flex-1 items-end">
                      <div className="w-full rounded-t bg-emerald-400/70" style={{ height: `${Math.max(3, Math.round((entry.amount / maxCollection) * 100))}%` }} title={money(entry.amount)} />
                    </div>
                    <span className="text-[9px] text-slate-500">{entry.month.slice(5)}</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="vyora-card p-4">
              <h3 className="text-sm font-semibold text-white">Répartition des retards</h3>
              <div className="mt-3 space-y-2">
                {([
                  ['Non échu', aging.non_echu], ['1–30 jours', aging.retard_1_30], ['31–60 jours', aging.retard_31_60],
                  ['61–90 jours', aging.retard_61_90], ['Plus de 90 jours', aging.retard_90_plus],
                ] as const).map(([label, value]) => (
                  <div key={label}>
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-slate-400">{label}</span><span className="text-slate-300">{money(value)}</span>
                    </div>
                    <ProgressBar value={value} max={Math.max(1, ...Object.values(aging))} tone={label === 'Non échu' ? 'emerald' : 'amber'} />
                  </div>
                ))}
              </div>
            </section>
          </div>
          <section className="vyora-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Créances prioritaires</h3>
              <Button size="sm" variant="ghost" onClick={() => setTab('recouvrement')}>Centre de recouvrement <ChevronRight size={11} /></Button>
            </div>
            <div className="mt-2 space-y-1.5">
              {urgentViews.slice(0, 5).map((view) => {
                const risk = riskById.get(view.receivable.id);
                return (
                  <button key={view.receivable.id} type="button" onClick={() => setSelectedId(view.receivable.id)}
                    className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] px-2 py-1.5 text-left hover:bg-white/[0.03]">
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-medium text-white">{view.receivable.reference || 'Sans référence'} · {contactName(view.receivable.contactId)}</p>
                      <p className="text-[10px] text-slate-500">{view.daysOverdue > 0 ? `${view.daysOverdue} j de retard` : `échéance ${view.receivable.dueDate || '—'}`} · risque {risk?.category ?? '—'}</p>
                    </div>
                    <span className="text-[11px] font-semibold text-amber-200">{money(view.balance)}</span>
                  </button>
                );
              })}
              {urgentViews.length === 0 && <p className="text-xs text-slate-500">Aucune créance ouverte.</p>}
            </div>
          </section>
        </div>
      )}

      {tab === 'creances' && (
        <div className="space-y-3" data-testid="finance-receivables">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-[180px] flex-1 items-center gap-1.5 rounded-lg border border-white/10 px-2">
              <span className="text-slate-500"><Users size={12} /></span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher une référence, un client…" aria-label="Rechercher une créance"
                className="w-full bg-transparent py-1.5 text-xs text-white outline-none placeholder:text-slate-600" />
            </div>
            <Select aria-label="Statut" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="w-auto py-1.5 text-xs">
              <option value="toutes">Tous les statuts</option>
              {RECEIVABLE_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
            </Select>
            <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={() => downloadFile(`creances-${now}.csv`, receivablesToCsv(views, contactName), 'text/csv;charset=utf-8')}>Export créances</Button>
            <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={() => downloadFile(`paiements-${now}.csv`, paymentsToCsv(payments, (id) => viewById.get(id)?.receivable.reference ?? id), 'text/csv;charset=utf-8')}>Export paiements</Button>
            <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={() => downloadFile(`retards-${now}.csv`, overdueReportToCsv(views, contactName), 'text/csv;charset=utf-8')}>Rapport de retard</Button>
          </div>
          {filteredViews.length === 0 ? (
            <EmptyState icon={<Wallet size={22} />} title={receivables.length ? 'Aucune créance dans cette vue' : 'Aucune créance'}
              description={receivables.length ? 'Ajustez le filtre de statut ou la recherche.' : 'Créez une créance reliée à un contact CRM.'}
              action={<Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => openReceivable()}>Nouvelle créance</Button>} />
          ) : (
            /*
             * Sur téléphone, une créance = une ligne lisible : référence,
             * client, solde, statut et échéance. Le tableau desktop imposait
             * `min-w-[560px]`, donc un défilement horizontal sur tout écran
             * Android, avec des colonnes masquées (`hidden sm:table-cell`) dont
             * l'information n'était alors **inaccessible nulle part**.
             *
             * Le bouton « Paiement » reste sur la ligne : c'est l'action
             * fréquente, elle ne doit pas demander d'ouvrir la fiche.
             */
            !grandEcran ? (
              <ul className="liste-mobile overflow-hidden rounded-xl border border-white/[0.07]" data-testid="creances-liste">
                {filteredViews.map((view) => (
                  <li key={view.receivable.id} className="px-3 py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedId(view.receivable.id)}
                        className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-white"
                      >
                        {view.receivable.reference || 'Sans référence'}
                      </button>
                      <span className="shrink-0 text-[13px] font-semibold text-white">{money(view.balance)}</span>
                    </div>
                    <p className="mt-0.5 truncate text-[11.5px] text-slate-400">
                      {contactName(view.receivable.contactId)}
                      {view.receivable.dueDate ? ` · échéance ${view.receivable.dueDate}` : ''}
                    </p>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <Badge status={view.effectiveStatus} tone={statusTone(view.effectiveStatus)}>{statusLabel(view.effectiveStatus)}</Badge>
                      {view.balance > 0 && !['annulee', 'litige', 'brouillon'].includes(view.effectiveStatus)
                        && <Button size="sm" variant="outline" onClick={() => openPayment(view)}>Paiement</Button>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
            <div className="table-defile rounded-xl border border-white/[0.07]">
              <table className="w-full min-w-[560px] text-left text-[11px]">
                <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-3 py-2">Référence</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Échéance</th><th className="px-3 py-2">Solde</th><th className="px-3 py-2">Statut</th><th className="px-3 py-2" /></tr>
                </thead>
                <tbody>
                  {filteredViews.map((view) => (
                    <tr key={view.receivable.id} className="border-t border-white/[0.05] hover:bg-white/[0.02]">
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => setSelectedId(view.receivable.id)} className="text-left font-semibold text-white">{view.receivable.reference || 'Sans référence'}</button>
                        <span className="block text-[10px] text-slate-500">{view.receivable.description || '—'}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-300">{contactName(view.receivable.contactId)}</td>
                      <td className="px-3 py-2 text-slate-400">{view.receivable.dueDate || '—'}</td>
                      <td className="px-3 py-2 font-semibold text-white">{money(view.balance)}</td>
                      <td className="px-3 py-2"><Badge status={view.effectiveStatus} tone={statusTone(view.effectiveStatus)}>{statusLabel(view.effectiveStatus)}</Badge></td>
                      <td className="px-3 py-2 text-right">
                        {view.balance > 0 && !['annulee', 'litige', 'brouillon'].includes(view.effectiveStatus)
                          && <Button size="sm" variant="outline" onClick={() => openPayment(view)}>Paiement</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )
          )}
        </div>
      )}

      {tab === 'echeancier' && (
        <div className="space-y-3" data-testid="finance-schedule">
          <h2 className="font-display text-lg font-semibold text-white">Échéancier</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {([
              ['retard', 'En retard'], ['aujourdhui', 'Aujourd’hui'], ['semaine', 'Cette semaine'],
              ['mois', 'Ce mois'], ['futur', 'Futur'],
            ] as const).map(([bucket, label]) => {
              const list = schedule[bucket];
              const total = list.reduce((sum, view) => sum + view.balance, 0);
              return (
                <section key={bucket} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between">
                    <p className={cn('text-[11px] font-semibold', bucket === 'retard' ? 'text-rose-200' : 'text-slate-200')}>{label}</p>
                    <span className="text-[10px] text-slate-500">{list.length}</span>
                  </div>
                  <p className="text-[10px] text-slate-500">{money(total)}</p>
                  <div className="mt-2 space-y-1.5">
                    {list.map((view) => (
                      <button key={view.receivable.id} type="button" onClick={() => setSelectedId(view.receivable.id)}
                        className="w-full rounded-lg border border-white/[0.06] p-1.5 text-left text-[10px] hover:bg-white/[0.03]">
                        <span className="block truncate font-medium text-white">{contactName(view.receivable.contactId)}</span>
                        <span className="block text-slate-500">{money(view.balance)} · {view.receivable.dueDate}</span>
                      </button>
                    ))}
                    {!list.length && <p className="text-[10px] text-slate-600">Aucune créance.</p>}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'recouvrement' && (
        <div className="space-y-3" data-testid="finance-recovery">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="font-display text-lg font-semibold text-white">Centre de recouvrement</h2>
              <p className="text-xs text-slate-400">Priorisé par score de risque explicable. Les messages sont préparés et copiés, jamais envoyés automatiquement.</p>
            </div>
            <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={() => downloadFile(`recouvrement-${now}.csv`, overdueReportToCsv(views, contactName), 'text/csv;charset=utf-8')}>Rapport de recouvrement</Button>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="space-y-2 lg:col-span-2">
              {urgentViews.map((view) => {
                const risk = riskById.get(view.receivable.id);
                const contact = contactById.get(view.receivable.contactId);
                return (
                  <article key={view.receivable.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white">{view.receivable.reference || 'Sans référence'} · {money(view.balance)}</p>
                        <p className="text-[11px] text-slate-400">{contactName(view.receivable.contactId)} · échéance {view.receivable.dueDate || '—'}{view.daysOverdue > 0 ? ` · ${view.daysOverdue} j de retard` : ''}</p>
                      </div>
                      <RiskChip risk={risk} />
                    </div>
                    <p className="mt-1 text-[10px] text-slate-500">{risk?.reasons.slice(0, 3).map((reason) => reason.label).join(' · ')}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => openReminder(view)}>Préparer une relance</Button>
                      <Button size="sm" variant="ghost" onClick={() => openPromise(view)}>Promesse</Button>
                      <Button size="sm" variant="ghost" onClick={() => setSelectedId(view.receivable.id)}>Fiche</Button>
                      <Button size="sm" variant="ghost" onClick={() => onOpenContact(view.receivable.contactId)}>Contact CRM</Button>
                      {contact?.whatsapp || contact?.phone ? (
                        <a className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer"
                          href={recoveryWhatsappLink(contact.whatsapp || contact.phone, renderRecoveryTemplate(RECOVERY_TEMPLATES[2].body, {
                            contact: contactDisplayName(contact), reference: view.receivable.reference,
                            montant: money(view.balance), date: view.receivable.dueDate, responsable: view.receivable.owner,
                          }))}>
                          WhatsApp
                        </a>
                      ) : null}
                      {contact?.email ? (
                        <a className="btn btn-ghost btn-sm" href={recoveryMailtoLink(contact.email, view.receivable.reference, `Bonjour ${contactDisplayName(contact)},\n\nLa facture ${view.receivable.reference} de ${money(view.balance)} reste due.`)}>E-mail</a>
                      ) : null}
                    </div>
                  </article>
                );
              })}
              {urgentViews.length === 0 && <EmptyState icon={<Check size={22} />} title="Aucun encours à recouvrer" description="Les créances soldées ou annulées n’apparaissent pas ici." />}
            </div>
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Relances programmées</p>
              {reminders.filter((reminder) => reminder.status === 'a_faire').sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((reminder) => {
                const view = viewById.get(reminder.receivableId);
                return (
                  <article key={reminder.id} className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
                    <p className="text-[11px] font-semibold text-white">{view ? contactName(view.receivable.contactId) : 'Client'} · {reminder.channel}</p>
                    <p className="text-[10px] text-slate-500">Prévue le {reminder.dueDate}{reminder.dueDate < now ? ' · en retard' : ''}</p>
                    <div className="mt-1 flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => void markReminderDone(reminder)}>Terminer</Button>
                      <Button size="sm" variant="ghost" onClick={() => {
                        const next = { ...reminder, dueDate: now };
                        void remindersStore.update(reminder.id, { ...reminderToData(next), dueDate: now });
                      }}>Reprogrammer</Button>
                    </div>
                  </article>
                );
              })}
              {!reminders.some((reminder) => reminder.status === 'a_faire') && <p className="text-[10px] text-slate-600">Aucune relance programmée.</p>}
            </div>
          </div>
        </div>
      )}

      {tab === 'promesses' && (
        <div className="space-y-3" data-testid="finance-promises">
          <h2 className="font-display text-lg font-semibold text-white">Promesses de paiement</h2>
          {promises.length === 0 ? (
            <EmptyState icon={<HandCoins size={22} />} title="Aucune promesse enregistrée" description="Une promesse non respectée crée une alerte mais ne crée jamais de paiement." />
          ) : (
            <div className="space-y-2">
              {[...promises].sort((a, b) => b.promisedAt.localeCompare(a.promisedAt)).map((promise) => {
                const status = effectivePromiseStatus(promise, now);
                const view = viewById.get(promise.receivableId);
                return (
                  <article key={promise.id} className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{money(promise.amount)} · {view ? contactName(view.receivable.contactId) : contactName(promise.contactId)}</p>
                      <p className="text-[11px] text-slate-400">Promise pour le {promise.promisedAt}{view ? ` · ${view.receivable.reference}` : ''}</p>
                      {promise.note && <p className="text-[10px] text-slate-500">{promise.note}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge status={status} tone={status === 'non_respectee' ? 'danger' : status === 'respectee' ? 'success' : 'neutral'}>
                        {PROMISE_STATUSES.find((entry) => entry.value === status)?.label}
                      </Badge>
                      {status === 'a_venir' && <Button size="sm" variant="outline" onClick={() => void setPromiseStatus(promise, 'respectee')}>Respectée</Button>}
                      {status === 'a_venir' && <Button size="sm" variant="ghost" onClick={() => void setPromiseStatus(promise, 'non_respectee')}>Non respectée</Button>}
                      {status === 'non_respectee' && view && <Button size="sm" variant="outline" onClick={() => openReminder(view, 'retard_important')}>Relancer</Button>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'litiges' && (
        <div className="space-y-3" data-testid="finance-disputes">
          <h2 className="font-display text-lg font-semibold text-white">Litiges</h2>
          {disputes.length === 0 ? (
            <EmptyState icon={<Scale size={22} />} title="Aucun litige" description="Les créances litigieuses restent traçables et sortent du recouvrement courant." />
          ) : (
            <div className="space-y-2">
              {disputes.map((dispute) => {
                const view = viewById.get(dispute.receivableId);
                return (
                  <article key={dispute.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-white">{dispute.reason} · {view ? money(view.balance) : '—'}</p>
                        <p className="text-[11px] text-slate-400">{view ? contactName(view.receivable.contactId) : contactName(dispute.contactId)} · ouvert le {dispute.openedAt}</p>
                        {dispute.description && <p className="mt-1 text-[10px] text-slate-500">{dispute.description}</p>}
                        {dispute.resolution && <p className="mt-1 text-[10px] text-emerald-200">Résolution : {dispute.resolution}</p>}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Badge status={dispute.status} tone={dispute.status === 'resolu' ? 'success' : 'danger'}>{dispute.status}</Badge>
                        <Button size="sm" variant="ghost" onClick={() => view && openDispute(view, dispute)}>Modifier</Button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Fiche créance */}
      <Modal open={Boolean(selected)} onClose={() => setSelectedId(null)} size="lg"
        title={selected ? `Créance ${selected.receivable.reference || 'sans référence'}` : 'Créance'}
        description={selected ? `${contactName(selected.receivable.contactId)} · ${statusLabel(selected.effectiveStatus)}` : undefined}
        footer={selected ? (
          <>
            <Button variant="ghost" onClick={() => setSelectedId(null)}>Fermer</Button>
            <Button variant="outline" onClick={() => onOpenContact(selected.receivable.contactId)}>Fiche client CRM</Button>
            <Button variant="outline" onClick={() => openReceivable(selected.receivable)}>Modifier</Button>
            {selected.balance > 0 && !['annulee', 'litige', 'brouillon'].includes(selected.effectiveStatus)
              && <Button variant="primary" onClick={() => openPayment(selected)}>Enregistrer un paiement</Button>}
          </>
        ) : undefined}>
        {selected && (() => {
          const view = selected;
          const risk = riskById.get(view.receivable.id)!;
          const contact = contactById.get(view.receivable.contactId);
          const linkedPayments = payments.filter((payment) => payment.receivableId === view.receivable.id).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
          const linkedPromises = promises.filter((promise) => promise.receivableId === view.receivable.id);
          const linkedReminders = reminders.filter((reminder) => reminder.receivableId === view.receivable.id);
          const linkedDisputes = disputes.filter((dispute) => dispute.receivableId === view.receivable.id);
          return (
            <div className="space-y-4" data-testid="finance-receivable-detail">
              <div className="flex flex-wrap items-center gap-2">
                <Badge status={view.effectiveStatus} tone={statusTone(view.effectiveStatus)}>{statusLabel(view.effectiveStatus)}</Badge>
                <RiskChip risk={risk} />
                {view.daysOverdue > 0 && <span className="text-[10px] text-rose-300">{view.daysOverdue} jour(s) de retard</span>}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[['Montant initial', money(view.receivable.initialAmount)], ['Payé', money(view.paid)], ['Solde', money(view.balance)], ['Échéance', view.receivable.dueDate || '—']].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-white/[0.07] px-2 py-1.5">
                    <p className="text-[9px] text-slate-500">{label}</p>
                    <p className="text-[11px] font-semibold text-white">{value}</p>
                  </div>
                ))}
              </div>
              <ProgressBar value={view.paid} max={Math.max(1, view.receivable.initialAmount ?? 1)} tone="emerald" />
              <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Pourquoi ce niveau de risque</p>
                <ul className="mt-1 space-y-0.5">
                  {risk.reasons.map((reason) => (
                    <li key={reason.label} className="flex justify-between gap-2 text-[11px] text-slate-300">
                      <span>{reason.label}{reason.detail ? ` · ${reason.detail}` : ''}</span><span>{reason.points > 0 ? '+' : ''}{reason.points}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Paiements ({linkedPayments.filter((payment) => !payment.cancelled).length} validés)</p>
                  <div className="mt-1 space-y-1">
                    {linkedPayments.map((payment) => (
                      <div key={payment.id} className={cn('rounded border border-white/[0.06] px-2 py-1 text-[10px]', payment.cancelled && 'opacity-60')}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-slate-300">{payment.paidAt} · {money(payment.amount)} · {PAYMENT_METHODS.find((method) => method.value === payment.method)?.label}</span>
                          {payment.cancelled ? <span className="text-rose-300">Annulé</span>
                            : <div className="flex gap-1">
                              <button type="button" className="text-slate-500 hover:text-white" aria-label="Reçu de paiement"
                                onClick={() => setReceipt(buildReceipt({ payment, view, contactName: contact ? contactDisplayName(contact) : 'Client', company: contact?.company ?? '' }))}>Reçu</button>
                              <button type="button" className="text-slate-500 hover:text-rose-300" aria-label="Annuler le paiement"
                                onClick={() => { setCancelPayment({ payment, view }); setCancelReason(''); }}>Annuler</button>
                            </div>}
                        </div>
                        {payment.reference && <span className="text-slate-500">Réf. {payment.reference}</span>}
                        {payment.cancelled && payment.cancellationReason && <span className="block text-slate-500">Motif : {payment.cancellationReason}</span>}
                      </div>
                    ))}
                    {!linkedPayments.length && <p className="text-[10px] text-slate-600">Aucun paiement.</p>}
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">Suivi</p>
                    <div className="flex gap-1">
                      <button type="button" className="text-[10px] text-cyan-200" onClick={() => openPromise(view)}>+ Promesse</button>
                      <button type="button" className="text-[10px] text-cyan-200" onClick={() => openReminder(view)}>+ Relance</button>
                      <button type="button" className="text-[10px] text-cyan-200" onClick={() => openDispute(view)}>+ Litige</button>
                    </div>
                  </div>
                  <div className="mt-1 space-y-1 text-[10px] text-slate-400">
                    {linkedPromises.map((promise) => (
                      <p key={promise.id}>Promesse {money(promise.amount)} · {promise.promisedAt} · {PROMISE_STATUSES.find((entry) => entry.value === effectivePromiseStatus(promise, now))?.label}</p>
                    ))}
                    {linkedReminders.slice(0, 3).map((reminder) => <p key={reminder.id}>Relance {reminder.dueDate} · {reminder.status}</p>)}
                    {linkedDisputes.map((dispute) => <p key={dispute.id} className="text-rose-200">Litige : {dispute.reason} ({dispute.status})</p>)}
                    {!linkedPromises.length && !linkedReminders.length && !linkedDisputes.length && <p className="text-slate-600">Aucun suivi enregistré.</p>}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {contact && <Button size="sm" variant="ghost" onClick={() => onOpenContact(contact.id)}>Contact : {contactDisplayName(contact)}</Button>}
                {contact?.phone && <a className="btn btn-ghost btn-sm" href={`tel:${contact.phone}`}>Appeler</a>}
                {contact?.email && <a className="btn btn-ghost btn-sm" href={recoveryMailtoLink(contact.email, view.receivable.reference, `Bonjour,\n\nNous revenons vers vous au sujet de la créance ${view.receivable.reference} (${money(view.balance)}).`)}>E-mail</a>}
              </div>
              {view.receivable.notes && <p className="rounded-lg border border-white/[0.07] p-2 text-[11px] text-slate-300"><span className="text-slate-500">Notes : </span>{view.receivable.notes}</p>}
            </div>
          );
        })()}
      </Modal>

      {/* Formulaire créance */}
      <Modal open={receivableModal.open} onClose={() => setReceivableModal({ open: false, editing: null })}
        title={receivableModal.editing ? 'Modifier la créance' : 'Nouvelle créance'} size="lg"
        footer={<>
          <Button variant="ghost" onClick={() => setReceivableModal({ open: false, editing: null })}>Annuler</Button>
          <Button variant="primary" loading={busy} onClick={() => void saveReceivable()}>Enregistrer</Button>
        </>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Client CRM" value={receivableForm.contactId} onChange={(event) => setReceivableForm({ ...receivableForm, contactId: event.target.value })} hint="Le CRM reste la source unique des clients.">
            <option value="">Choisir un contact…</option>
            {contacts.map((contact: Contact) => <option key={contact.id} value={contact.id}>{contactDisplayName(contact)}{contact.company ? ` · ${contact.company}` : ''}</option>)}
          </Select>
          <Input label="Référence" value={receivableForm.reference} onChange={(event) => setReceivableForm({ ...receivableForm, reference: event.target.value })} placeholder="Générée automatiquement si vide" />
          <div className="sm:col-span-2"><Input label="Description" value={receivableForm.description} onChange={(event) => setReceivableForm({ ...receivableForm, description: event.target.value })} /></div>
          <Input label="Montant initial" type="number" min={0} value={receivableForm.initialAmount} onChange={(event) => setReceivableForm({ ...receivableForm, initialAmount: event.target.value })} />
          <Input label="Date d’émission" type="date" value={receivableForm.issuedAt} onChange={(event) => setReceivableForm({ ...receivableForm, issuedAt: event.target.value })} />
          <Input label="Échéance" type="date" value={receivableForm.dueDate} onChange={(event) => setReceivableForm({ ...receivableForm, dueDate: event.target.value })} />
          <Input label="Conditions" value={receivableForm.terms} onChange={(event) => setReceivableForm({ ...receivableForm, terms: event.target.value })} />
          <Select label="Statut de gestion" value={receivableForm.status} onChange={(event) => setReceivableForm({ ...receivableForm, status: event.target.value })} hint="En attente, partiellement payée et en retard sont calculés depuis les paiements et l’échéance.">
            <option value="en_attente">En attente</option>
            <option value="brouillon">Brouillon</option>
            <option value="litige">En litige</option>
            <option value="annulee">Annulée</option>
          </Select>
          <Input label="Responsable" value={receivableForm.owner} onChange={(event) => setReceivableForm({ ...receivableForm, owner: event.target.value })} />
          <div className="sm:col-span-2"><Textarea label="Notes" rows={3} value={receivableForm.notes} onChange={(event) => setReceivableForm({ ...receivableForm, notes: event.target.value })} /></div>
        </div>
      </Modal>

      {/* Paiement */}
      <Modal open={Boolean(paymentModal)} onClose={() => setPaymentModal(null)} title="Enregistrer un paiement" size="md"
        description={paymentModal ? `Solde restant : ${money(paymentModal.view.balance)}` : undefined}
        footer={<><Button variant="ghost" onClick={() => setPaymentModal(null)}>Annuler</Button><Button variant="primary" loading={busy} onClick={() => void submitPayment()}>Valider le paiement</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Montant" type="number" min={0} value={paymentForm.amount} onChange={(event) => setPaymentForm({ ...paymentForm, amount: event.target.value })} hint="Le solde ne peut jamais devenir négatif." />
          <Input label="Date" type="date" value={paymentForm.paidAt} max={now} onChange={(event) => setPaymentForm({ ...paymentForm, paidAt: event.target.value })} />
          <Select label="Mode" value={paymentForm.method} onChange={(event) => setPaymentForm({ ...paymentForm, method: event.target.value as PaymentMethod })}>
            {PAYMENT_METHODS.map((method) => <option key={method.value} value={method.value}>{method.label}</option>)}
          </Select>
          <Input label="Référence" value={paymentForm.reference} onChange={(event) => setPaymentForm({ ...paymentForm, reference: event.target.value })} placeholder="Numéro de transaction, chèque…" />
          <div className="sm:col-span-2"><Textarea label="Note" rows={2} value={paymentForm.note} onChange={(event) => setPaymentForm({ ...paymentForm, note: event.target.value })} /></div>
          <p className="sm:col-span-2 text-[10px] text-slate-500">Une clé d’idempotence unique protège contre une double soumission. Un paiement enregistré ne peut être supprimé : il ne peut qu’être annulé avec un motif.</p>
        </div>
      </Modal>

      {/* Annulation de paiement */}
      <Modal open={Boolean(cancelPayment)} onClose={() => setCancelPayment(null)} title="Annuler ce paiement" size="sm"
        footer={<><Button variant="ghost" onClick={() => setCancelPayment(null)}>Retour</Button><Button variant="danger" loading={busy} onClick={() => void confirmCancelPayment()}>Confirmer l’annulation</Button></>}>
        <p className="mb-2 text-xs text-slate-400">Le paiement reste dans l’historique avec son motif. Le solde de la créance sera recalculé.</p>
        {cancelPayment && <p className="mb-2 text-sm text-white">{money(cancelPayment.payment.amount)} · {cancelPayment.payment.paidAt}</p>}
        <Textarea label="Motif d’annulation (obligatoire)" rows={3} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} />
      </Modal>

      {/* Reçu */}
      <Modal open={Boolean(receipt)} onClose={() => setReceipt(null)} title="Reçu de paiement" size="sm"
        footer={<>
          <Button variant="ghost" onClick={() => setReceipt(null)}>Fermer</Button>
          {receipt && <Button variant="outline" icon={<Download size={12} />} onClick={() => downloadFile(`recu-${receipt.reference}.html`, receiptHtml(receipt), 'text/html;charset=utf-8')}>Télécharger</Button>}
        </>}>
        {receipt && (
          <div className="space-y-1 text-[12px] text-slate-300">
            <p className="text-base font-semibold text-white">Reçu {receipt.reference}</p>
            {receipt.cancelled && <p className="text-rose-300">Ce paiement est annulé.</p>}
            <p>Client : <strong className="text-white">{receipt.contactName}</strong>{receipt.company ? ` · ${receipt.company}` : ''}</p>
            <p>Créance : {receipt.receivableReference}</p>
            <p>Montant : <strong className="text-white">{money(receipt.amount)}</strong></p>
            <p>Date : {receipt.paidAt} · Mode : {receipt.method}</p>
            {receipt.paymentReference && <p>Référence : {receipt.paymentReference}</p>}
            <p>Solde restant après paiement : {money(receipt.balanceAfter)}</p>
          </div>
        )}
      </Modal>

      {/* Promesse */}
      <Modal open={Boolean(promiseModal)} onClose={() => setPromiseModal(null)} title="Promesse de paiement" size="md"
        footer={<><Button variant="ghost" onClick={() => setPromiseModal(null)}>Annuler</Button><Button variant="primary" loading={busy} onClick={() => void savePromise()}>Enregistrer</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Montant promis" type="number" min={0} value={promiseForm.amount} onChange={(event) => setPromiseForm({ ...promiseForm, amount: event.target.value })} />
          <Input label="Date promise" type="date" value={promiseForm.promisedAt} onChange={(event) => setPromiseForm({ ...promiseForm, promisedAt: event.target.value })} />
          <Select label="Statut" value={promiseForm.status} onChange={(event) => setPromiseForm({ ...promiseForm, status: event.target.value as PromiseStatus })}>
            {PROMISE_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
          </Select>
          <Input label="Résultat" value={promiseForm.outcome} onChange={(event) => setPromiseForm({ ...promiseForm, outcome: event.target.value })} />
          <div className="sm:col-span-2"><Textarea label="Note" rows={2} value={promiseForm.note} onChange={(event) => setPromiseForm({ ...promiseForm, note: event.target.value })} /></div>
          <p className="sm:col-span-2 text-[10px] text-slate-500">Une promesse non respectée déclenche une alerte et propose une relance. Elle ne crée jamais de paiement.</p>
        </div>
      </Modal>

      {/* Relance */}
      <Modal open={Boolean(reminderModal)} onClose={() => setReminderModal(null)} title="Préparer une relance" size="md"
        footer={<><Button variant="ghost" onClick={() => setReminderModal(null)}>Annuler</Button><Button variant="primary" loading={busy} onClick={() => void saveReminder()}>Programmer</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Modèle" value={reminderForm.template} onChange={(event) => {
            const template = RECOVERY_TEMPLATES.find((entry) => entry.id === event.target.value) ?? RECOVERY_TEMPLATES[0];
            const view = reminderModal?.view;
            const contact = view ? contactById.get(view.receivable.contactId) : undefined;
            setReminderForm({
              ...reminderForm, template: template.id, channel: template.channel,
              message: view ? renderRecoveryTemplate(template.body, {
                contact: contact ? contactDisplayName(contact) : 'Client', reference: view.receivable.reference,
                montant: money(view.balance), date: view.receivable.dueDate, responsable: view.receivable.owner,
              }) : reminderForm.message,
            });
          }}>
            {RECOVERY_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}
          </Select>
          <Select label="Canal" value={reminderForm.channel} onChange={(event) => setReminderForm({ ...reminderForm, channel: event.target.value as CollectionReminder['channel'] })}>
            <option value="whatsapp">WhatsApp</option><option value="email">E-mail</option>
            <option value="sms">SMS</option><option value="appel">Appel</option>
          </Select>
          <Input label="Date de relance" type="date" value={reminderForm.dueDate} onChange={(event) => setReminderForm({ ...reminderForm, dueDate: event.target.value })} />
          <Input label="Note" value={reminderForm.note} onChange={(event) => setReminderForm({ ...reminderForm, note: event.target.value })} />
          <div className="sm:col-span-2"><Textarea label="Message préparé" rows={5} value={reminderForm.message} onChange={(event) => setReminderForm({ ...reminderForm, message: event.target.value })} /></div>
        </div>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(reminderForm.message).then(() => toast.success('Message copié.')).catch(() => toast.warning('Copie impossible.')); }}>Copier</Button>
          {reminderModal && (() => {
            const contact = contactById.get(reminderModal.view.receivable.contactId);
            if (contact?.whatsapp || contact?.phone) return <a className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer" href={recoveryWhatsappLink(contact.whatsapp || contact.phone, reminderForm.message)}>Ouvrir WhatsApp</a>;
            return null;
          })()}
        </div>
      </Modal>

      {/* Litige */}
      <Modal open={Boolean(disputeModal)} onClose={() => setDisputeModal(null)} title="Litige" size="md"
        footer={<><Button variant="ghost" onClick={() => setDisputeModal(null)}>Annuler</Button><Button variant="primary" loading={busy} onClick={() => void saveDispute()}>Enregistrer</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Motif" value={disputeForm.reason} onChange={(event) => setDisputeForm({ ...disputeForm, reason: event.target.value })} placeholder="Désaccord sur le montant, prestation contestée…" />
          <Input label="Responsable" value={disputeForm.owner} onChange={(event) => setDisputeForm({ ...disputeForm, owner: event.target.value })} />
          <Input label="Date d’ouverture" type="date" value={disputeForm.openedAt} onChange={(event) => setDisputeForm({ ...disputeForm, openedAt: event.target.value })} />
          <Select label="Statut" value={disputeForm.status} onChange={(event) => setDisputeForm({ ...disputeForm, status: event.target.value as DisputeStatus })}>
            <option value="ouvert">Ouvert</option><option value="en_cours">En cours</option>
            <option value="resolu">Résolu</option><option value="annule">Annulé</option>
          </Select>
          <div className="sm:col-span-2"><Textarea label="Description" rows={3} value={disputeForm.description} onChange={(event) => setDisputeForm({ ...disputeForm, description: event.target.value })} /></div>
          <div className="sm:col-span-2"><Textarea label="Résolution" rows={2} value={disputeForm.resolution} onChange={(event) => setDisputeForm({ ...disputeForm, resolution: event.target.value })} /></div>
        </div>
      </Modal>
    </div>
  );
}

function RiskChip({ risk }: { risk?: RecoveryRisk }) {
  if (!risk) return null;
  const tone = risk.category === 'critique' ? 'bg-rose-400/15 text-rose-200'
    : risk.category === 'eleve' ? 'bg-amber-400/15 text-amber-200'
      : risk.category === 'modere' ? 'bg-cyan-400/15 text-cyan-200' : 'bg-emerald-400/15 text-emerald-200';
  return <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', tone)}><ShieldAlert size={10} className="mr-1 inline" />Risque {risk.category} · {risk.score}</span>;
}

function receiptHtml(receipt: ReturnType<typeof buildReceipt>): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Reçu ${receipt.reference}</title>
  <style>body{font-family:system-ui,sans-serif;max-width:620px;margin:40px auto;color:#111}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin-top:20px}td{padding:8px;border-bottom:1px solid #ddd}strong{text-align:right}</style></head>
  <body><h1>Reçu de paiement ${receipt.reference}</h1>${receipt.cancelled ? '<p style="color:#b91c1c">Ce paiement est annulé.</p>' : ''}
  <table>
  <tr><td>Client</td><td><strong>${escapeHtml(receipt.contactName)}${receipt.company ? ` · ${escapeHtml(receipt.company)}` : ''}</strong></td></tr>
  <tr><td>Créance</td><td><strong>${escapeHtml(receipt.receivableReference)}</strong></td></tr>
  <tr><td>Montant</td><td><strong>${escapeHtml(money(receipt.amount))}</strong></td></tr>
  <tr><td>Date</td><td><strong>${escapeHtml(receipt.paidAt)}</strong></td></tr>
  <tr><td>Mode</td><td><strong>${escapeHtml(receipt.method)}</strong></td></tr>
  <tr><td>Référence</td><td><strong>${escapeHtml(receipt.paymentReference || '—')}</strong></td></tr>
  <tr><td>Solde restant</td><td><strong>${escapeHtml(money(receipt.balanceAfter))}</strong></td></tr>
  </table></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}
