import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, BarChart3, CalendarClock, ChevronRight, ClipboardList, Download, Layers, Mail,
  Phone, Plus, RefreshCw, Sparkles, Target, Users,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Modal, Select, Textarea, cn } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { FINANCE_CATEGORIES, CRM_CATEGORIES, useRecords } from '../records/useRecords';
import { useGrandEcran } from '../../lib/media-query';
import {
  OPPORTUNITY_STAGES, PRIORITY_LABELS, TASK_TYPES, contactDisplayName, contactFromRecord,
  contactMatchesFilters, contactToData, computeCrmDashboard, contactsToCsv,
  buildActionCenter, mergeContactData, opportunityFromRecord, opportunityToData, opportunitiesToCsv,
  scoreContact, segmentFromRecord, taskFromRecord, taskToData, tasksToCsv, todayIso,
  EMPTY_SEGMENT_FILTERS, CONTACT_SOURCES, CONTACT_STATUSES, CONTACT_TYPES, activityFromRecord,
  type ActionItem, type Contact, type CrmTask, type Opportunity, type OpportunityStage,
  type SegmentFilters, type TaskType,
} from './model';
import {
  computeReceivableView, effectivePromiseStatus, paymentFromRecord, promiseFromRecord,
  promiseToData, receivableFromRecord, receivableToData, reminderFromRecord, reminderToData,
  disputeFromRecord, disputeToData,
} from '../finance/model';
import {
  ActionCenterPanel, DuplicatesPanel, ImportPanel, PipelinePanel, RemindersPanel,
  ScoreChip, SegmentBar, SegmentExport, TasksPanel, contactOptionLabel, downloadCsv,
} from './CrmPanels';

export type CrmTab = 'dashboard' | 'contacts' | 'pipeline' | 'actions' | 'tasks' | 'relances' | 'segments' | 'import' | 'doublons';

const TABS: { id: CrmTab; label: string; icon: typeof Users }[] = [
  { id: 'dashboard', label: 'Tableau de bord', icon: BarChart3 },
  { id: 'contacts', label: 'Contacts', icon: Users },
  { id: 'pipeline', label: 'Pipeline', icon: Target },
  { id: 'actions', label: 'À faire', icon: AlertTriangle },
  { id: 'tasks', label: 'Tâches', icon: ClipboardList },
  { id: 'relances', label: 'Relances', icon: Mail },
  { id: 'segments', label: 'Segments', icon: Layers },
  { id: 'doublons', label: 'Doublons', icon: Users },
  { id: 'import', label: 'Import / Export', icon: Download },
];

const money = (value: number | null, currency = 'XOF') => value === null
  ? '—'
  : new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);

function emptyContactForm() {
  return {
    firstName: '', lastName: '', company: '', jobTitle: '', phone: '', whatsapp: '', email: '',
    address: '', city: '', country: '', source: 'instagram', type: 'prospect', tags: '',
    notes: '', owner: '', lastContactAt: todayIso(), nextAction: '', nextActionAt: '', status: 'actif',
  };
}

function emptyOpportunityForm() {
  return {
    title: '', contactId: '', stage: 'nouveau' as OpportunityStage, amount: '', currency: 'XOF',
    probability: '10', expectedCloseAt: '', owner: '', product: '', source: '', notes: '', nextAction: '', nextActionAt: '',
  };
}

function emptyTaskForm() {
  return {
    title: '', type: 'appel' as TaskType, contactId: '', opportunityId: '', owner: '',
    priority: 'normale', dueDate: todayIso(), dueTime: '', notes: '', outcome: '', nextAction: '', nextActionAt: '',
  };
}

export interface LegacyProspect {
  id: string; name: string; company: string; email: string; phone: string; stage: string;
  value: number | null; currency: string; nextAction: string; nextActionAt: string; notes: string;
}

export default function CrmWorkspace({
  workspaceId, legacyProspects, initialContactId, onInitialContactHandled, onCreateReceivable, onOpenFinance, onOpenAssistant,
  initialTab = 'dashboard', lockTab = false,
}: {
  workspaceId: string | null;
  legacyProspects: LegacyProspect[];
  initialContactId?: string | null;
  onInitialContactHandled?: () => void;
  onCreateReceivable: (contactId: string) => void;
  onOpenFinance: () => void;
  onOpenAssistant: (prompt: string) => void;
  /** Module Growth OS : l'onglet interne peut être imposé par la route. */
  initialTab?: CrmTab;
  lockTab?: boolean;
}) {
  const toast = useToast();
  // Une seule vue montée à la fois : liste tactile (téléphone) ou tableau.
  const grandEcran = useGrandEcran();
  const [tab, setTab] = useState<CrmTab>(initialTab);
  const contactsStore = useRecords(CRM_CATEGORIES.contacts, workspaceId);
  const opportunitiesStore = useRecords(CRM_CATEGORIES.opportunities, workspaceId);
  const tasksStore = useRecords(CRM_CATEGORIES.tasks, workspaceId);
  const activitiesStore = useRecords(CRM_CATEGORIES.activities, workspaceId);
  const segmentsStore = useRecords(CRM_CATEGORIES.segments, workspaceId);
  const receivablesStore = useRecords(FINANCE_CATEGORIES.receivables, workspaceId);
  const paymentsStore = useRecords(FINANCE_CATEGORIES.payments, workspaceId);
  const promisesStore = useRecords(FINANCE_CATEGORIES.promises, workspaceId);
  const remindersStore = useRecords(FINANCE_CATEGORIES.reminders, workspaceId);
  const disputesStore = useRecords(FINANCE_CATEGORIES.disputes, workspaceId);

  const contacts = useMemo(() => contactsStore.records.map(contactFromRecord), [contactsStore.records]);
  const opportunities = useMemo(() => opportunitiesStore.records.map(opportunityFromRecord), [opportunitiesStore.records]);
  const tasks = useMemo(() => tasksStore.records.map(taskFromRecord), [tasksStore.records]);
  const activities = useMemo(() => activitiesStore.records.map(activityFromRecord), [activitiesStore.records]);
  const segments = useMemo(() => segmentsStore.records.map(segmentFromRecord), [segmentsStore.records]);
  const receivables = useMemo(() => receivablesStore.records.map(receivableFromRecord), [receivablesStore.records]);
  const payments = useMemo(() => paymentsStore.records.map(paymentFromRecord), [paymentsStore.records]);
  const promises = useMemo(() => promisesStore.records.map(promiseFromRecord), [promisesStore.records]);
  const reminders = useMemo(() => remindersStore.records.map(reminderFromRecord), [remindersStore.records]);
  const disputes = useMemo(() => disputesStore.records.map(disputeFromRecord), [disputesStore.records]);

  const loading = contactsStore.loading || opportunitiesStore.loading || tasksStore.loading;
  const loadError = contactsStore.error || opportunitiesStore.error || tasksStore.error;

  const [filters, setFilters] = useState<SegmentFilters>(EMPTY_SEGMENT_FILTERS);

  useEffect(() => {
    if (!initialContactId) return;
    setSelectedContactId(initialContactId);
    setTab('contacts');
    onInitialContactHandled?.();
  }, [initialContactId, onInitialContactHandled]);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [contactModal, setContactModal] = useState<{ open: boolean; editing: Contact | null }>({ open: false, editing: null });
  const [contactForm, setContactForm] = useState(emptyContactForm());
  const [opportunityModal, setOpportunityModal] = useState<{ open: boolean; editing: Opportunity | null }>({ open: false, editing: null });
  const [opportunityForm, setOpportunityForm] = useState(emptyOpportunityForm());
  const [lostModal, setLostModal] = useState<Opportunity | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [wonModal, setWonModal] = useState<Opportunity | null>(null);
  const [taskModal, setTaskModal] = useState<{ open: boolean; editing: CrmTask | null; prefill?: Partial<ReturnType<typeof emptyTaskForm>> }>({ open: false, editing: null });
  const [taskForm, setTaskForm] = useState(emptyTaskForm());
  const [completeTask, setCompleteTask] = useState<CrmTask | null>(null);
  const [completeForm, setCompleteForm] = useState({ outcome: '', nextAction: '', nextActionAt: '' });
  const [saving, setSaving] = useState(false);

  const now = todayIso();
  const scores = useMemo(() => new Map(contacts.map((contact) => [contact.id, scoreContact(contact, {
    opportunities, tasks, now,
    overdueReceivables: receivables.filter((receivable) => receivable.contactId === contact.id
      && computeReceivableView(receivable, payments, now).effectiveStatus === 'en_retard').length,
  })])), [contacts, now, opportunities, payments, receivables, tasks]);

  const dashboard = useMemo(() => computeCrmDashboard({ contacts, opportunities, tasks, now }), [contacts, now, opportunities, tasks]);
  const actionInputs = useMemo(() => {
    const input: Array<{ id: string; contactId: string; label: string; amount: number | null; dueDate: string; kind: 'creance_en_retard' | 'promesse_non_respectee' }> = [];
    for (const receivable of receivables) {
      const view = computeReceivableView(receivable, payments, now);
      if (view.effectiveStatus === 'en_retard' && receivable.contactId) {
        input.push({ id: receivable.id, contactId: receivable.contactId, label: `Créance ${receivable.reference || 'sans référence'} en retard`, amount: view.balance, dueDate: receivable.dueDate, kind: 'creance_en_retard' });
      }
    }
    for (const promise of promises) {
      if (effectivePromiseStatus(promise, now) === 'non_respectee' && promise.contactId) {
        input.push({ id: promise.id, contactId: promise.contactId, label: `Promesse de paiement non tenue (${promise.promisedAt})`, amount: promise.amount, dueDate: promise.promisedAt, kind: 'promesse_non_respectee' });
      }
    }
    return input;
  }, [now, payments, promises, receivables]);
  const actions = useMemo(() => buildActionCenter({ contacts, opportunities, tasks, finance: actionInputs, now }), [actionInputs, contacts, now, opportunities, tasks]);

  const filteredContacts = useMemo(() => contacts
    .filter((contact) => contactMatchesFilters(contact, filters, scores.get(contact.id)!, scores.get(contact.id)!.openValue, scores.get(contact.id)!.overdueTaskCount))
    .sort((a, b) => (scores.get(b.id)?.score ?? 0) - (scores.get(a.id)?.score ?? 0)), [contacts, filters, scores]);

  const linkedForContact = useCallback((contactId: string) => ({
    opportunities: opportunities.filter((opportunity) => opportunity.contactId === contactId),
    tasks: tasks.filter((task) => task.contactId === contactId),
    activities: activities.filter((activity) => activity.contactId === contactId).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    receivables: receivables.filter((receivable) => receivable.contactId === contactId),
    promises: promises.filter((promise) => promise.contactId === contactId),
  }), [activities, opportunities, promises, receivables, tasks]);

  const reloadAll = useCallback(async () => {
    await Promise.all([
      contactsStore.reload(), opportunitiesStore.reload(), tasksStore.reload(), activitiesStore.reload(),
      segmentsStore.reload(), receivablesStore.reload(), paymentsStore.reload(), promisesStore.reload(),
      remindersStore.reload(), disputesStore.reload(),
    ]);
  }, [activitiesStore, contactsStore, disputesStore, opportunitiesStore, paymentsStore, promisesStore, receivablesStore, remindersStore, segmentsStore, tasksStore]);

  const logActivity = useCallback(async (data: Record<string, unknown>) => {
    try { await activitiesStore.create({ occurredAt: todayIso(), ...data }); }
    catch { /* L'historique est secondaire : une écriture ratée ne doit pas masquer l'action principale. */ }
  }, [activitiesStore]);

  const openContact = (contact?: Contact) => {
    setContactForm(contact ? {
      firstName: contact.firstName, lastName: contact.lastName, company: contact.company,
      jobTitle: contact.jobTitle, phone: contact.phone, whatsapp: contact.whatsapp, email: contact.email,
      address: contact.address, city: contact.city, country: contact.country, source: contact.source,
      type: contact.type, tags: contact.tags.join(', '), notes: contact.notes, owner: contact.owner,
      lastContactAt: contact.lastContactAt, nextAction: contact.nextAction,
      nextActionAt: contact.nextActionAt, status: contact.status,
    } : emptyContactForm());
    setContactModal({ open: true, editing: contact ?? null });
  };

  const saveContact = async () => {
    if (!contactForm.firstName.trim() && !contactForm.lastName.trim() && !contactForm.company.trim() && !contactForm.email.trim() && !contactForm.phone.trim()) {
      toast.warning('Renseignez au moins un nom, une entreprise, un e-mail ou un téléphone.'); return;
    }
    setSaving(true);
    try {
      const data = {
        ...contactForm,
        tags: contactForm.tags.split(/[,;]/).map((tag) => tag.trim().toLowerCase()).filter(Boolean),
      };
      if (contactModal.editing) {
        await contactsStore.update(contactModal.editing.id, data);
        await logActivity({ contactId: contactModal.editing.id, type: 'modification', summary: 'Fiche contact mise à jour' });
        toast.success('Contact mis à jour.');
      } else {
        const id = await contactsStore.create(data);
        await logActivity({ contactId: id, type: 'creation', summary: 'Contact créé' });
        toast.success('Contact créé.');
      }
      setContactModal({ open: false, editing: null });
    } catch (error) { toast.error(asAppError(error).message); } finally { setSaving(false); }
  };

  const archiveContact = async (contact: Contact) => {
    const linked = linkedForContact(contact.id);
    if (linked.opportunities.length || linked.tasks.length || linked.receivables.length) {
      toast.warning('Ce contact est relié à des opportunités, tâches ou créances. Archivez-le plutôt que de le supprimer.');
      return;
    }
    if (!window.confirm('Supprimer définitivement ce contact sans historique lié ?')) return;
    try {
      await contactsStore.remove(contact.id);
      setSelectedContactId(null);
      toast.success('Contact supprimé.');
    } catch (error) { toast.error(asAppError(error).message); }
  };

  const convertToClient = async (contact: Contact) => {
    try {
      await contactsStore.update(contact.id, { ...contactToData(contact), type: 'client' });
      await logActivity({ contactId: contact.id, type: 'conversion', summary: 'Prospect converti en client' });
      toast.success('Contact converti en client. Aucune créance n’a été créée automatiquement.');
    } catch (error) { toast.error(asAppError(error).message); }
  };

  const openOpportunity = (opportunity?: Opportunity) => {
    setOpportunityForm(opportunity ? {
      title: opportunity.title, contactId: opportunity.contactId, stage: opportunity.stage,
      amount: opportunity.amount === null ? '' : String(opportunity.amount), currency: opportunity.currency,
      probability: String(opportunity.probability ?? 0), expectedCloseAt: opportunity.expectedCloseAt,
      owner: opportunity.owner, product: opportunity.product, source: opportunity.source,
      notes: opportunity.notes, nextAction: opportunity.nextAction, nextActionAt: opportunity.nextActionAt,
    } : { ...emptyOpportunityForm(), contactId: selectedContactId ?? '' });
    setOpportunityModal({ open: true, editing: opportunity ?? null });
  };

  const saveOpportunity = async () => {
    if (!opportunityForm.title.trim()) { toast.warning('Donnez un titre à l’opportunité.'); return; }
    if (opportunityForm.stage === 'perdu' && !opportunityForm.notes.trim()) { toast.warning('Documentez le motif de perte dans les notes.'); return; }
    setSaving(true);
    try {
      const payload = {
        ...opportunityForm,
        amount: opportunityForm.amount === '' ? null : Number(opportunityForm.amount),
        probability: opportunityForm.probability === '' ? null : Number(opportunityForm.probability),
      };
      if (opportunityModal.editing) {
        await opportunitiesStore.update(opportunityModal.editing.id, payload);
        await logActivity({ contactId: opportunityForm.contactId, opportunityId: opportunityModal.editing.id, type: 'opportunite', summary: `Opportunité mise à jour : ${opportunityForm.title}` });
      } else {
        const id = await opportunitiesStore.create(payload);
        await logActivity({ contactId: opportunityForm.contactId, opportunityId: id, type: 'opportunite', summary: `Opportunité créée : ${opportunityForm.title}` });
        if (opportunityForm.nextActionAt) {
          await tasksStore.create({
            title: opportunityForm.nextAction || `Relancer ${opportunityForm.title}`,
            type: 'relance', contactId: opportunityForm.contactId, opportunityId: id,
            dueDate: opportunityForm.nextActionAt, status: 'a_faire', priority: 'normale',
          });
        }
      }
      toast.success('Opportunité enregistrée.');
      setOpportunityModal({ open: false, editing: null });
    } catch (error) { toast.error(asAppError(error).message); } finally { setSaving(false); }
  };

  const changeStage = async (opportunity: Opportunity, stage: OpportunityStage) => {
    if (opportunity.stage === stage) return;
    if (stage === 'perdu') { setLostModal(opportunity); setLostReason(''); return; }
    try {
      await opportunitiesStore.update(opportunity.id, { ...opportunityToData(opportunity), stage });
      await logActivity({ contactId: opportunity.contactId, opportunityId: opportunity.id, type: 'etape', summary: `Étape : ${OPPORTUNITY_STAGES.find((entry) => entry.value === stage)?.label}` });
      if (stage === 'gagne') setWonModal({ ...opportunity, stage });
      else toast.success('Étape mise à jour.');
    } catch (error) { toast.error(asAppError(error).message); }
  };

  const confirmLost = async () => {
    if (!lostModal || lostReason.trim().length < 3) { toast.warning('Le motif de perte est obligatoire.'); return; }
    setSaving(true);
    try {
      await opportunitiesStore.update(lostModal.id, { ...opportunityToData(lostModal), stage: 'perdu', lostReason: lostReason.trim() });
      await logActivity({ contactId: lostModal.contactId, opportunityId: lostModal.id, type: 'etape', summary: `Opportunité perdue : ${lostReason.trim()}` });
      toast.success('Opportunité marquée perdue.');
      setLostModal(null);
    } catch (error) { toast.error(asAppError(error).message); } finally { setSaving(false); }
  };

  const openTask = (task?: CrmTask, prefill?: Partial<ReturnType<typeof emptyTaskForm>>) => {
    setTaskForm(task ? {
      title: task.title, type: task.type, contactId: task.contactId, opportunityId: task.opportunityId,
      owner: task.owner, priority: task.priority, dueDate: task.dueDate, dueTime: task.dueTime,
      notes: task.notes, outcome: task.outcome, nextAction: task.nextAction, nextActionAt: task.nextActionAt,
    } : { ...emptyTaskForm(), contactId: selectedContactId ?? '', ...prefill });
    setTaskModal({ open: true, editing: task ?? null });
  };

  const saveTask = async () => {
    if (!taskForm.title.trim()) { toast.warning('Le titre de la tâche est obligatoire.'); return; }
    setSaving(true);
    try {
      if (taskModal.editing) await tasksStore.update(taskModal.editing.id, { ...taskForm, status: taskModal.editing.status, completedAt: taskModal.editing.completedAt });
      else await tasksStore.create({ ...taskForm, status: 'a_faire' });
      toast.success('Tâche enregistrée.');
      setTaskModal({ open: false, editing: null });
    } catch (error) { toast.error(asAppError(error).message); } finally { setSaving(false); }
  };

  const finishTask = async (planNext: boolean) => {
    if (!completeTask) return;
    setSaving(true);
    try {
      await tasksStore.update(completeTask.id, {
        ...taskToData(completeTask), status: 'termine', outcome: completeForm.outcome.trim(), completedAt: todayIso(),
      });
      if (planNext && completeForm.nextAction.trim() && completeForm.nextActionAt) {
        await tasksStore.create({
          title: completeForm.nextAction.trim(), type: 'suivi', contactId: completeTask.contactId,
          opportunityId: completeTask.opportunityId, owner: completeTask.owner, priority: completeTask.priority,
          dueDate: completeForm.nextActionAt, status: 'a_faire',
        });
        toast.success('Tâche terminée et prochaine action planifiée.');
      } else {
        toast.success('Tâche terminée.');
      }
      await logActivity({ contactId: completeTask.contactId, opportunityId: completeTask.opportunityId, type: 'tache', summary: `Tâche terminée : ${completeTask.title}${completeForm.outcome ? ` — ${completeForm.outcome}` : ''}` });
      setCompleteTask(null);
      setCompleteForm({ outcome: '', nextAction: '', nextActionAt: '' });
    } catch (error) { toast.error(asAppError(error).message); } finally { setSaving(false); }
  };

  const planAction = (action: ActionItem) => {
    openTask(undefined, {
      title: action.title, contactId: action.contactId, opportunityId: action.opportunityId ?? '',
      dueDate: todayIso(), type: action.kind === 'relance_retard' ? 'relance' : 'suivi',
      priority: action.severity === 'urgente' ? 'urgente' : action.severity === 'elevee' ? 'elevee' : 'normale',
    });
  };

  const saveSegment = async (name: string) => {
    try {
      await segmentsStore.create({ name, filters });
      toast.success('Segment sauvegardé. Il se recalcule sur les données actuelles.');
    } catch (error) { toast.error(asAppError(error).message); throw error; }
  };

  const mergeContacts = async (kept: Contact, duplicate: Contact, choices: Record<string, 'left' | 'right' | 'combine'>) => {
    const merged = mergeContactData(kept, duplicate, choices as Partial<Record<keyof Contact, 'left' | 'right' | 'combine'>>);
    try {
      await contactsStore.update(kept.id, contactToData(merged));
      const linkedOpportunities = opportunities.filter((item) => item.contactId === duplicate.id);
      const linkedTasks = tasks.filter((item) => item.contactId === duplicate.id);
      const linkedReceivables = receivables.filter((item) => item.contactId === duplicate.id);
      const linkedPromises = promises.filter((item) => item.contactId === duplicate.id);
      for (const opportunity of linkedOpportunities) await opportunitiesStore.update(opportunity.id, { ...opportunityToData(opportunity), contactId: kept.id });
      for (const task of linkedTasks) await tasksStore.update(task.id, { ...taskToData(task), contactId: kept.id });
      for (const receivable of linkedReceivables) await receivablesStore.update(receivable.id, { ...receivableToData(receivable), contactId: kept.id });
      for (const promise of linkedPromises) await promisesStore.update(promise.id, { ...promiseToData(promise), contactId: kept.id });
      const linkedReminders = reminders.filter((item) => item.contactId === duplicate.id);
      const linkedDisputes = disputes.filter((item) => item.contactId === duplicate.id);
      for (const reminder of linkedReminders) await remindersStore.update(reminder.id, { ...reminderToData(reminder), contactId: kept.id });
      for (const dispute of linkedDisputes) await disputesStore.update(dispute.id, { ...disputeToData(dispute), contactId: kept.id });
      await activitiesStore.create({ contactId: kept.id, type: 'fusion', summary: `Fiche fusionnée avec ${contactDisplayName(duplicate)}` });
      await contactsStore.remove(duplicate.id);
      toast.success(`Fiches fusionnées. ${linkedOpportunities.length} opportunité(s), ${linkedTasks.length} tâche(s) et ${linkedReceivables.length} créance(s) réaffectée(s).`);
      setSelectedContactId(kept.id);
    } catch (error) {
      toast.error(`Fusion interrompue : ${asAppError(error).message}. Certaines liaisons ont pu être réaffectées.`);
      await reloadAll();
      throw error;
    }
  };

  const importLegacy = async () => {
    let created = 0; let opportunitiesCreated = 0;
    try {
      for (const prospect of legacyProspects) {
        const existing = contacts.find((contact) => (prospect.email && contact.email.toLowerCase() === prospect.email.toLowerCase())
          || (prospect.phone && contact.phone.replace(/\D/g, '').slice(-8) === prospect.phone.replace(/\D/g, '').slice(-8)));
        let contactId = existing?.id;
        if (!contactId) {
          contactId = await contactsStore.create({
            firstName: prospect.name, company: prospect.company, email: prospect.email, phone: prospect.phone,
            type: 'prospect', source: 'autre', notes: prospect.notes, lastContactAt: prospect.nextActionAt,
            nextAction: prospect.nextAction, nextActionAt: prospect.nextActionAt, status: 'actif',
          });
          created += 1;
        }
        if (prospect.stage !== 'perdu' && prospect.stage !== 'gagne') {
          const stage: OpportunityStage = prospect.stage === 'prospect' ? 'nouveau'
            : OPPORTUNITY_STAGES.some((entry) => entry.value === prospect.stage) ? prospect.stage as OpportunityStage : 'nouveau';
          await opportunitiesStore.create({
            title: `${prospect.company || prospect.name} · ${prospect.nextAction || 'Opportunité'}`.slice(0, 190),
            contactId, stage, amount: prospect.value, currency: prospect.currency || 'XOF',
            nextAction: prospect.nextAction, nextActionAt: prospect.nextActionAt, source: 'autre',
          });
          opportunitiesCreated += 1;
        }
      }
      toast.success(`Prospects importés : ${created} contact(s), ${opportunitiesCreated} opportunité(s).`);
      setTab('contacts');
    } catch (error) { toast.error(asAppError(error).message); }
  };

  const selected = contacts.find((contact) => contact.id === selectedContactId) ?? null;

  if (loading && !contacts.length) return <LoadingState label="Chargement du CRM…" />;
  if (loadError && !contacts.length) return <ErrorState message={loadError} onRetry={() => void reloadAll()} />;

  return (
    <div className="space-y-4" data-testid="crm-workspace">
      <header className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#080d15] px-4 py-5 sm:px-6">
        <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-cyan-400/15 blur-[70px]" />
        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">SORAHNEX · CRM intelligent</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-white sm:text-2xl">Votre relation client, priorisée</h2>
            <p className="mt-1 max-w-2xl text-xs text-slate-400">Contacts, pipeline, actions et relances reliés à vos créances réelles. Les scores sont des estimations explicables, jamais des certitudes.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void reloadAll()}>Actualiser</Button>
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => openContact()}>Nouveau contact</Button>
          </div>
        </div>
        <div className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['Pipeline ouvert', money(dashboard.pipelineValue), `${dashboard.openOpportunities} opportunité(s)`],
            ['Pipeline pondéré', money(dashboard.weightedPipeline), 'Selon la probabilité de chaque étape'],
            ['Clients', String(dashboard.clients), `${dashboard.prospects} prospect(s)`],
            ['Actions urgentes', String(actions.filter((action) => action.severity === 'urgente').length), `${dashboard.overdueTasks} tâche(s) en retard`],
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
                tab === entry.id ? 'bg-cyan-400/15 text-cyan-100' : 'text-slate-400 hover:bg-white/5 hover:text-white')}>
              <Icon size={12} />{entry.label}
              {entry.id === 'actions' && actions.length > 0 && <span className="rounded-full bg-rose-400/20 px-1 text-[9px] text-rose-200">{actions.length}</span>}
            </button>
          );
        })}
      </div>}

      {tab === 'dashboard' && (
        <div className="space-y-3" data-testid="crm-dashboard">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Taux de conversion', dashboard.conversionRate === null ? '—' : `${dashboard.conversionRate} %`, 'Clients sur total contacts'],
              ['Taux de victoire', dashboard.winRate === null ? '—' : `${dashboard.winRate} %`, `${dashboard.wonOpportunities} gagnée(s) · ${dashboard.lostOpportunities} perdue(s)`],
              ['Gagné (montants connus)', money(dashboard.wonValue), 'Uniquement les opportunités gagnées'],
              ['Nouveaux contacts (30 j)', String(dashboard.newContacts), `${dashboard.totalContacts} contact(s) au total`],
              ['Prospects chauds', String(dashboard.hotProspects), 'Score et actualité du contact'],
              ['Opportunités stagnantes', String(dashboard.stagnantOpportunities), 'Sans mise à jour depuis 14 jours'],
              ['Relances en retard', String(dashboard.overdueFollowUps), 'Prochaine action dépassée'],
              ['Tâches du jour', String(dashboard.todayTasks), `${dashboard.overdueTasks} en retard`],
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
              <h3 className="text-sm font-semibold text-white">Meilleures sources</h3>
              <p className="text-[10px] text-slate-500">Contacts réels et opportunités gagnées, sans extrapolation.</p>
              <div className="mt-2 space-y-1.5">
                {dashboard.topSources.length === 0 && <p className="text-xs text-slate-500">Aucune source renseignée.</p>}
                {dashboard.topSources.map((source) => (
                  <div key={source.source} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate text-slate-300">{source.source}</span>
                    <span className="text-slate-500">{source.count} contact(s) · {source.won} gagnée(s)</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="vyora-card p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-white">À traiter maintenant</h3>
                  <p className="text-[10px] text-slate-500">Les cinq actions les plus prioritaires.</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setTab('actions')}>Tout voir <ChevronRight size={11} /></Button>
              </div>
              <div className="mt-2 space-y-1.5">
                {actions.slice(0, 5).map((action) => (
                  <button key={action.id} type="button" onClick={() => setSelectedContactId(action.contactId)}
                    className="flex w-full items-start justify-between gap-2 rounded-lg border border-white/[0.06] px-2 py-1.5 text-left hover:bg-white/[0.03]">
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-medium text-white">{action.title}</p>
                      <p className="truncate text-[10px] text-slate-500">{action.detail}</p>
                    </div>
                    {action.amount !== null && action.amount !== undefined && <span className="shrink-0 text-[10px] text-cyan-200">{money(action.amount)}</span>}
                  </button>
                ))}
                {actions.length === 0 && <p className="text-xs text-slate-500">Aucune action en attente.</p>}
              </div>
            </section>
          </div>
          <section className="vyora-card p-4">
            <h3 className="text-sm font-semibold text-white">Prospects et clients prioritaires</h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {[...contacts].sort((a, b) => (scores.get(b.id)?.score ?? 0) - (scores.get(a.id)?.score ?? 0)).slice(0, 6).map((contact) => {
                const score = scores.get(contact.id)!;
                return (
                  <button key={contact.id} type="button" onClick={() => setSelectedContactId(contact.id)}
                    className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-left hover:border-cyan-400/30">
                    <p className="truncate text-xs font-semibold text-white">{contactDisplayName(contact)}</p>
                    <p className="truncate text-[10px] text-slate-500">{contact.company || contact.city || contact.email || 'Coordonnées à compléter'}</p>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <ScoreChip score={score.score} priority={score.priority} />
                      <span className="text-[10px] text-slate-400">{money(score.openValue || null)}</span>
                    </div>
                  </button>
                );
              })}
              {contacts.length === 0 && <p className="text-xs text-slate-500">Ajoutez votre premier contact pour démarrer.</p>}
            </div>
          </section>
        </div>
      )}

      {tab === 'contacts' && (
        <div className="space-y-3" data-testid="crm-contacts">
          <SegmentBar filters={filters} onChange={setFilters} resultCount={filteredContacts.length} segments={segments}
            onSave={saveSegment} onApply={(segment) => setFilters(segment.filters)}
            onDelete={(segment) => { if (window.confirm(`Supprimer le segment « ${segment.name} » ?`)) void segmentsStore.remove(segment.id); }} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-slate-500">Cliquez une fiche pour ouvrir son historique, ses opportunités et sa situation financière.</p>
            <div className="flex gap-1.5">
              <SegmentExport contacts={filteredContacts} filename={`contacts-${now}.csv`} />
              <Button size="sm" variant="ghost" icon={<Download size={12} />}
                onClick={() => downloadCsv(`contacts-complet-${now}.csv`, contactsToCsv(contacts))}>Export complet</Button>
            </div>
          </div>
          {filteredContacts.length === 0 ? (
            <EmptyState icon={<Users size={22} />} title={contacts.length ? 'Aucun contact dans ce segment' : 'Aucun contact'}
              description={contacts.length ? 'Ajustez vos filtres ou enregistrez un autre segment.' : 'Créez un contact, importez un CSV ou reprenez vos prospects existants.'}
              action={<Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => openContact()}>Nouveau contact</Button>} />
          ) : (
            /* Sur téléphone, une ligne par contact : entreprise, prochaine
               action et valeur du pipeline étaient MASQUÉES (hidden sm:table-cell),
               donc invisibles sur Android. Elles sont maintenant toutes lisibles
               sans ouvrir la fiche, et la ligne entière est cliquable.
               Une seule vue est montée à la fois (voir `useGrandEcran`). */
            !grandEcran ? (
            <>
            <ul className="liste-mobile overflow-hidden rounded-xl border border-white/[0.07]">
              {filteredContacts.map((contact) => {
                const score = scores.get(contact.id)!;
                return (
                  <li key={contact.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedContactId(contact.id)}
                      className="liste-mobile-ligne w-full items-start"
                    >
                      <ScoreChip score={score.score} priority={score.priority} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-white">{contactDisplayName(contact)}</span>
                        <span className="mt-0.5 block truncate text-[11.5px] text-slate-400">
                          {[contact.company, contact.phone || contact.email].filter(Boolean).join(' · ') || '—'}
                        </span>
                        {contact.nextAction && (
                          <span className="mt-0.5 block truncate text-[11px] text-cyan-100">
                            {contact.nextAction}{contact.nextActionAt ? ` · ${contact.nextActionAt}` : ''}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-right">
                        {score.openValue ? <span className="block text-[11.5px] font-semibold text-cyan-100">{money(score.openValue)}</span> : null}
                        <ChevronRight size={13} className="ml-auto mt-0.5 text-slate-500" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            </>
            ) : (
            <div className="table-defile rounded-xl border border-white/[0.07]">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-3 py-2">Contact</th><th className="hidden px-3 py-2 sm:table-cell">Entreprise</th><th className="px-3 py-2">Score</th><th className="hidden px-3 py-2 md:table-cell">Prochaine action</th><th className="hidden px-3 py-2 lg:table-cell">Pipeline</th><th className="px-3 py-2" /></tr>
                </thead>
                <tbody>
                  {filteredContacts.map((contact) => {
                    const score = scores.get(contact.id)!;
                    return (
                      <tr key={contact.id} className="border-t border-white/[0.05] hover:bg-white/[0.02]">
                        <td className="px-3 py-2">
                          <button type="button" onClick={() => setSelectedContactId(contact.id)} className="text-left">
                            <span className="block font-semibold text-white">{contactDisplayName(contact)}</span>
                            <span className="block text-[10px] text-slate-500">{contact.phone || contact.email || '—'}</span>
                          </button>
                        </td>
                        <td className="hidden px-3 py-2 text-slate-400 sm:table-cell">{contact.company || '—'}</td>
                        <td className="px-3 py-2"><ScoreChip score={score.score} priority={score.priority} /></td>
                        <td className="hidden px-3 py-2 text-slate-400 md:table-cell">{contact.nextAction || '—'}{contact.nextActionAt ? ` · ${contact.nextActionAt}` : ''}</td>
                        <td className="hidden px-3 py-2 text-cyan-100 lg:table-cell">{score.openValue ? money(score.openValue) : '—'}</td>
                        <td className="px-3 py-2 text-right"><ChevronRight size={13} className="inline text-slate-500" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )
          )}
        </div>
      )}

      {tab === 'pipeline' && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" icon={<Download size={12} />}
              onClick={() => downloadCsv(`pipeline-${now}.csv`, opportunitiesToCsv(opportunities))}>Exporter le pipeline</Button>
          </div>
          <PipelinePanel opportunities={opportunities} contacts={contacts}
            onStageChange={(opportunity, stage) => void changeStage(opportunity, stage)}
            onCreate={() => openOpportunity()} onEdit={openOpportunity} />
        </div>
      )}

      {tab === 'actions' && (
        <ActionCenterPanel actions={actions} contacts={contacts}
          onOpenContact={(contactId) => setSelectedContactId(contactId)}
          onPlan={planAction} onOpenFinance={onOpenFinance} />
      )}

      {tab === 'tasks' && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" icon={<Download size={12} />}
              onClick={() => downloadCsv(`taches-${now}.csv`, tasksToCsv(tasks))}>Exporter les tâches</Button>
          </div>
          <TasksPanel tasks={tasks} contacts={contacts}
          onComplete={(task) => { setCompleteTask(task); setCompleteForm({ outcome: '', nextAction: '', nextActionAt: '' }); }}
            onReopen={(task) => void tasksStore.update(task.id, { ...taskToData(task), status: 'a_faire', completedAt: '' })}
            onCreate={() => openTask()} onEdit={(task) => openTask(task)}
            onDelete={(task) => { if (window.confirm('Supprimer cette tâche ?')) void tasksStore.remove(task.id); }} />
        </div>
      )}

      {tab === 'relances' && <RemindersPanel contacts={contacts} />}

      {tab === 'segments' && (
        <div className="space-y-3" data-testid="crm-segment-page">
          <SegmentBar filters={filters} onChange={setFilters} resultCount={filteredContacts.length} segments={segments}
            onSave={saveSegment} onApply={(segment) => setFilters(segment.filters)}
            onDelete={(segment) => { if (window.confirm(`Supprimer le segment « ${segment.name} » ?`)) void segmentsStore.remove(segment.id); }} />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {segments.map((segment) => (
              <article key={segment.id} className="vyora-card p-3">
                <p className="text-sm font-semibold text-white">{segment.name}</p>
                <p className="mt-1 text-[10px] text-slate-500">{segment.filters.type === 'tous' ? 'Tous types' : segment.filters.type}
                  {segment.filters.inactiveDays !== null ? ` · inactif ${segment.filters.inactiveDays} j` : ''}
                  {segment.filters.minOpenValue !== null ? ` · ≥ ${money(segment.filters.minOpenValue)}` : ''}</p>
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => setFilters(segment.filters)}>Appliquer</Button>
              </article>
            ))}
            {segments.length === 0 && <p className="text-xs text-slate-500">Aucun segment sauvegardé.</p>}
          </div>
        </div>
      )}

      {tab === 'doublons' && <DuplicatesPanel contacts={contacts} onMerge={mergeContacts} />}

      {tab === 'import' && (
        <ImportPanel contacts={contacts} onCreate={(data) => contactsStore.create(data)}
          onUpdate={(id, data) => contactsStore.update(id, data)}
          legacyProspects={legacyProspects} onImportLegacy={importLegacy}
          onExport={() => downloadCsv(`contacts-${now}.csv`, contactsToCsv(contacts))} />
      )}

      {/* Fiche contact détaillée */}
      <Modal open={Boolean(selected)} onClose={() => setSelectedContactId(null)} size="lg"
        title={selected ? contactDisplayName(selected) : 'Contact'}
        description={selected ? [selected.jobTitle, selected.company, selected.city].filter(Boolean).join(' · ') || 'Coordonnées à compléter' : undefined}
        footer={selected ? (
          <>
            <Button variant="ghost" onClick={() => setSelectedContactId(null)}>Fermer</Button>
            {selected.type !== 'client' && <Button variant="outline" onClick={() => void convertToClient(selected)}>Convertir en client</Button>}
            <Button variant="outline" onClick={() => onCreateReceivable(selected.id)}>Créer une créance</Button>
            <Button variant="primary" onClick={() => openContact(selected)}>Modifier</Button>
          </>
        ) : undefined}>
        {selected && (() => {
          const score = scores.get(selected.id)!;
          const linked = linkedForContact(selected.id);
          const views = linked.receivables.map((receivable) => computeReceivableView(receivable, payments, now));
          const totalInitial = views.every((view) => view.receivable.initialAmount !== null) && views.length
            ? views.reduce((sum, view) => sum + (view.receivable.initialAmount ?? 0), 0) : null;
          const totalPaid = views.reduce((sum, view) => sum + view.paid, 0);
          const balance = views.reduce((sum, view) => sum + view.balance, 0);
          const overdue = views.filter((view) => view.effectiveStatus === 'en_retard').reduce((sum, view) => sum + view.balance, 0);
          const nextDue = views.filter((view) => view.balance > 0 && view.receivable.dueDate).sort((a, b) => a.receivable.dueDate.localeCompare(b.receivable.dueDate))[0];
          return (
            <div className="space-y-4" data-testid="crm-contact-detail">
              <div className="flex flex-wrap items-center gap-2">
                <ScoreChip score={score.score} priority={score.priority} />
                <Badge status={selected.type} tone={selected.type === 'client' ? 'success' : 'info'}>{CONTACT_TYPES.find((type) => type.value === selected.type)?.label}</Badge>
                <Badge status={selected.status}>{CONTACT_STATUSES.find((status) => status.value === selected.status)?.label}</Badge>
                {selected.tags.map((tag) => <span key={tag} className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[9px] text-slate-300">#{tag}</span>)}
              </div>
              <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Pourquoi cette priorité</p>
                <ul className="mt-1 grid gap-1 sm:grid-cols-2">
                  {score.reasons.map((reason) => (
                    <li key={reason.label} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-slate-300">{reason.label}{reason.detail ? ` · ${reason.detail}` : ''}</span>
                      <span className={reason.points >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{reason.points > 0 ? '+' : ''}{reason.points}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[9px] text-slate-600">Estimation : le score aide à prioriser, il ne garantit pas une vente.</p>
              </div>
              <div className="grid gap-2 text-[11px] sm:grid-cols-2">
                <p><span className="text-slate-500">Téléphone : </span>{selected.phone || '—'}</p>
                <p><span className="text-slate-500">WhatsApp : </span>{selected.whatsapp || '—'}</p>
                <p className="truncate"><span className="text-slate-500">E-mail : </span>{selected.email || '—'}</p>
                <p><span className="text-slate-500">Responsable : </span>{selected.owner || '—'}</p>
                <p><span className="text-slate-500">Dernier contact : </span>{selected.lastContactAt || '—'}</p>
                <p><span className="text-slate-500">Prochaine action : </span>{selected.nextAction || '—'}{selected.nextActionAt ? ` · ${selected.nextActionAt}` : ''}</p>
                <p className="sm:col-span-2"><span className="text-slate-500">Adresse : </span>{[selected.address, selected.city, selected.country].filter(Boolean).join(', ') || '—'}</p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ['Total créances', money(totalInitial)], ['Encaissé', money(totalPaid)],
                  ['Solde restant', money(balance)], ['En retard', money(overdue)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-white/[0.07] px-2 py-1.5">
                    <p className="text-[9px] text-slate-500">{label}</p>
                    <p className="text-[11px] font-semibold text-white">{views.length ? value : '—'}</p>
                  </div>
                ))}
              </div>
              {views.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">Créances liées</p>
                    <button type="button" onClick={onOpenFinance} className="text-[10px] text-cyan-200 hover:underline">Ouvrir le recouvrement</button>
                  </div>
                  {views.slice(0, 4).map((view) => (
                    <div key={view.receivable.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] px-2 py-1.5 text-[11px]">
                      <span className="text-slate-300">{view.receivable.reference || 'Sans référence'} · échéance {view.receivable.dueDate || '—'}</span>
                      <span className="text-slate-500">{money(view.balance)} · {RECEIVABLE_LABEL(view.effectiveStatus)}</span>
                    </div>
                  ))}
                  {nextDue && <p className="text-[10px] text-slate-500">Prochaine échéance ouverte : {nextDue.receivable.dueDate} · {money(nextDue.balance)}</p>}
                </div>
              )}
              {(() => {
                const contactReminders = reminders.filter((reminder) => reminder.contactId === selected.id);
                const contactDisputes = disputes.filter((dispute) => dispute.contactId === selected.id);
                const contactPromises = promises.filter((promise) => promise.contactId === selected.id);
                if (!contactPromises.length && !contactReminders.length && !contactDisputes.length) return null;
                return (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">Suivi financier</p>
                    {contactPromises.map((promise) => (
                      <div key={promise.id} className="flex items-center justify-between gap-2 rounded border border-white/[0.06] px-2 py-1 text-[10px]">
                        <span className="text-slate-300">Promesse {money(promise.amount)} · {promise.promisedAt}</span>
                        <span className={cn(effectivePromiseStatus(promise, now) === 'non_respectee' ? 'text-rose-300' : 'text-slate-500')}>
                          {effectivePromiseStatus(promise, now) === 'non_respectee' ? 'Non respectée' : promise.status === 'respectee' ? 'Respectée' : 'À venir'}
                        </span>
                      </div>
                    ))}
                    {contactReminders.slice(0, 3).map((reminder) => (
                      <div key={reminder.id} className="flex items-center justify-between gap-2 rounded border border-white/[0.06] px-2 py-1 text-[10px]">
                        <span className="text-slate-300">Relance {reminder.channel} · {reminder.dueDate}</span>
                        <span className={reminder.status === 'a_faire' && reminder.dueDate < now ? 'text-amber-300' : 'text-slate-500'}>{reminder.status === 'a_faire' ? 'À faire' : reminder.status}</span>
                      </div>
                    ))}
                    {contactDisputes.map((dispute) => (
                      <div key={dispute.id} className="rounded border border-rose-400/20 px-2 py-1 text-[10px] text-rose-200">
                        Litige : {dispute.reason} ({dispute.status})
                      </div>
                    ))}
                  </div>
                );
              })()}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Opportunités ({linked.opportunities.length})</p>
                  <div className="mt-1 space-y-1">
                    {linked.opportunities.map((opportunity) => (
                      <button key={opportunity.id} type="button" onClick={() => openOpportunity(opportunity)} className="flex w-full items-center justify-between gap-2 rounded border border-white/[0.06] px-2 py-1 text-left text-[11px] hover:bg-white/[0.03]">
                        <span className="truncate text-slate-300">{opportunity.title}</span>
                        <span className={OPPORTUNITY_STAGES.find((stage) => stage.value === opportunity.stage)?.tone}>{money(opportunity.amount, opportunity.currency)}</span>
                      </button>
                    ))}
                    {!linked.opportunities.length && <p className="text-[10px] text-slate-600">Aucune opportunité.</p>}
                  </div>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Tâches ouvertes ({linked.tasks.filter((task) => task.status === 'a_faire').length})</p>
                  <div className="mt-1 space-y-1">
                    {linked.tasks.filter((task) => task.status === 'a_faire').map((task) => (
                      <div key={task.id} className="flex items-center justify-between gap-2 rounded border border-white/[0.06] px-2 py-1 text-[11px]">
                        <span className="truncate text-slate-300">{task.title}</span>
                        <span className="text-slate-500">{task.dueDate}</span>
                      </div>
                    ))}
                    {!linked.tasks.some((task) => task.status === 'a_faire') && <p className="text-[10px] text-slate-600">Aucune tâche ouverte.</p>}
                  </div>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Historique ({linked.activities.length})</p>
                  <button type="button" className="text-[10px] text-cyan-200 hover:underline"
                    onClick={() => onOpenAssistant(`Résume l’historique commercial de ${contactDisplayName(selected)} (${selected.company || 'sans entreprise'}) à partir de ces éléments : ${linked.activities.slice(0, 10).map((activity) => `${activity.occurredAt} ${activity.summary}`).join(' ; ') || 'aucun historique'}. Propose la prochaine action la plus utile, sans inventer de fait.`)}>
                    <Sparkles size={10} className="mr-1 inline" />Résumer avec l’IA
                  </button>
                </div>
                <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
                  {linked.activities.map((activity) => (
                    <p key={activity.id} className="text-[10px] text-slate-400"><span className="text-slate-600">{activity.occurredAt}</span> · {activity.summary}</p>
                  ))}
                  {!linked.activities.length && <p className="text-[10px] text-slate-600">Aucun historique enregistré.</p>}
                </div>
              </div>
              {selected.notes && <div className="rounded-lg border border-white/[0.07] p-2 text-[11px] text-slate-300"><span className="text-slate-500">Notes : </span>{selected.notes}</div>}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" icon={<CalendarClock size={12} />} onClick={() => openTask(undefined, { contactId: selected.id, title: selected.nextAction || 'Suivre le contact', dueDate: todayIso() })}>Planifier une action</Button>
                <Button size="sm" variant="ghost" icon={<Phone size={12} />} onClick={() => { if (selected.phone) window.location.href = `tel:${selected.phone.replace(/\s/g, '')}`; else toast.warning('Aucun téléphone renseigné.'); }}>Appeler</Button>
                <Button size="sm" variant="ghost" onClick={() => void archiveContact(selected)}>Supprimer</Button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Formulaire contact */}
      <Modal open={contactModal.open} onClose={() => setContactModal({ open: false, editing: null })}
        title={contactModal.editing ? 'Modifier le contact' : 'Nouveau contact'} size="lg"
        footer={<>
          <Button variant="ghost" onClick={() => setContactModal({ open: false, editing: null })}>Annuler</Button>
          <Button variant="primary" loading={saving} onClick={() => void saveContact()}>Enregistrer</Button>
        </>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Prénom" value={contactForm.firstName} onChange={(event) => setContactForm({ ...contactForm, firstName: event.target.value })} />
          <Input label="Nom" value={contactForm.lastName} onChange={(event) => setContactForm({ ...contactForm, lastName: event.target.value })} />
          <Input label="Entreprise" value={contactForm.company} onChange={(event) => setContactForm({ ...contactForm, company: event.target.value })} />
          <Input label="Fonction" value={contactForm.jobTitle} onChange={(event) => setContactForm({ ...contactForm, jobTitle: event.target.value })} />
          <Input label="Téléphone" type="tel" value={contactForm.phone} onChange={(event) => setContactForm({ ...contactForm, phone: event.target.value })} />
          <Input label="WhatsApp" type="tel" value={contactForm.whatsapp} onChange={(event) => setContactForm({ ...contactForm, whatsapp: event.target.value })} />
          <Input label="E-mail" type="email" value={contactForm.email} onChange={(event) => setContactForm({ ...contactForm, email: event.target.value })} />
          <Input label="Responsable commercial" value={contactForm.owner} onChange={(event) => setContactForm({ ...contactForm, owner: event.target.value })} />
          <Input label="Adresse" value={contactForm.address} onChange={(event) => setContactForm({ ...contactForm, address: event.target.value })} />
          <Input label="Ville" value={contactForm.city} onChange={(event) => setContactForm({ ...contactForm, city: event.target.value })} />
          <Input label="Pays" value={contactForm.country} onChange={(event) => setContactForm({ ...contactForm, country: event.target.value })} />
          <Select label="Source" value={contactForm.source} onChange={(event) => setContactForm({ ...contactForm, source: event.target.value })}>
            {CONTACT_SOURCES.map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}
          </Select>
          <Select label="Type de contact" value={contactForm.type} onChange={(event) => setContactForm({ ...contactForm, type: event.target.value })}>
            {CONTACT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </Select>
          <Select label="Statut" value={contactForm.status} onChange={(event) => setContactForm({ ...contactForm, status: event.target.value })}>
            {CONTACT_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
          </Select>
          <Input label="Tags (séparés par des virgules)" value={contactForm.tags} onChange={(event) => setContactForm({ ...contactForm, tags: event.target.value })} />
          <Input label="Dernier contact" type="date" value={contactForm.lastContactAt} onChange={(event) => setContactForm({ ...contactForm, lastContactAt: event.target.value })} />
          <Input label="Prochaine action" value={contactForm.nextAction} onChange={(event) => setContactForm({ ...contactForm, nextAction: event.target.value })} />
          <Input label="Date de la prochaine action" type="date" value={contactForm.nextActionAt} onChange={(event) => setContactForm({ ...contactForm, nextActionAt: event.target.value })} />
          <div className="sm:col-span-2"><Textarea label="Notes" rows={3} value={contactForm.notes} onChange={(event) => setContactForm({ ...contactForm, notes: event.target.value })} /></div>
        </div>
      </Modal>

      {/* Formulaire opportunité */}
      <Modal open={opportunityModal.open} onClose={() => setOpportunityModal({ open: false, editing: null })}
        title={opportunityModal.editing ? 'Modifier l’opportunité' : 'Nouvelle opportunité'} size="lg"
        footer={<>
          <Button variant="ghost" onClick={() => setOpportunityModal({ open: false, editing: null })}>Annuler</Button>
          <Button variant="primary" loading={saving} onClick={() => void saveOpportunity()}>Enregistrer</Button>
        </>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Input label="Titre" value={opportunityForm.title} onChange={(event) => setOpportunityForm({ ...opportunityForm, title: event.target.value })} placeholder="Pack boutique — proposition de septembre" /></div>
          <Select label="Contact" value={opportunityForm.contactId} onChange={(event) => setOpportunityForm({ ...opportunityForm, contactId: event.target.value })}>
            <option value="">Sans contact</option>
            {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contactOptionLabel(contact)}</option>)}
          </Select>
          <Select label="Étape" value={opportunityForm.stage} onChange={(event) => {
            const stage = event.target.value as OpportunityStage;
            setOpportunityForm({ ...opportunityForm, stage, probability: String(OPPORTUNITY_STAGES.find((entry) => entry.value === stage)?.probability ?? 0) });
          }}>
            {OPPORTUNITY_STAGES.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}
          </Select>
          <Input label="Montant estimé" type="number" min={0} value={opportunityForm.amount} onChange={(event) => setOpportunityForm({ ...opportunityForm, amount: event.target.value })} />
          <Input label="Devise" value={opportunityForm.currency} onChange={(event) => setOpportunityForm({ ...opportunityForm, currency: event.target.value.toUpperCase() })} />
          <Input label="Probabilité (%)" type="number" min={0} max={100} value={opportunityForm.probability} onChange={(event) => setOpportunityForm({ ...opportunityForm, probability: event.target.value })} />
          <Input label="Conclusion prévue" type="date" value={opportunityForm.expectedCloseAt} onChange={(event) => setOpportunityForm({ ...opportunityForm, expectedCloseAt: event.target.value })} />
          <Input label="Responsable" value={opportunityForm.owner} onChange={(event) => setOpportunityForm({ ...opportunityForm, owner: event.target.value })} />
          <Input label="Produit ou service" value={opportunityForm.product} onChange={(event) => setOpportunityForm({ ...opportunityForm, product: event.target.value })} />
          <Input label="Source" value={opportunityForm.source} onChange={(event) => setOpportunityForm({ ...opportunityForm, source: event.target.value })} />
          <Input label="Prochaine action" value={opportunityForm.nextAction} onChange={(event) => setOpportunityForm({ ...opportunityForm, nextAction: event.target.value })} />
          <Input label="Date de la prochaine action" type="date" value={opportunityForm.nextActionAt} onChange={(event) => setOpportunityForm({ ...opportunityForm, nextActionAt: event.target.value })} />
          <div className="sm:col-span-2"><Textarea label="Notes" rows={3} value={opportunityForm.notes} onChange={(event) => setOpportunityForm({ ...opportunityForm, notes: event.target.value })} /></div>
        </div>
      </Modal>

      {/* Motif de perte */}
      <Modal open={Boolean(lostModal)} onClose={() => setLostModal(null)} title="Marquer l’opportunité perdue" size="sm"
        footer={<><Button variant="ghost" onClick={() => setLostModal(null)}>Annuler</Button><Button variant="danger" loading={saving} onClick={() => void confirmLost()}>Confirmer la perte</Button></>}>
        <p className="mb-2 text-xs text-slate-400">Le motif est obligatoire et restera visible dans l’historique.</p>
        <Textarea label="Motif de perte" rows={3} value={lostReason} onChange={(event) => setLostReason(event.target.value)} placeholder="Prix trop élevé, projet reporté, concurrent retenu…" />
      </Modal>

      {/* Opportunité gagnée : proposition explicite de créance */}
      <Modal open={Boolean(wonModal)} onClose={() => setWonModal(null)} title="Opportunité gagnée" size="sm"
        footer={<>
          <Button variant="ghost" onClick={() => setWonModal(null)}>Plus tard</Button>
          <Button variant="primary" disabled={!wonModal?.contactId}
            onClick={() => { if (!wonModal) return; const contactId = wonModal.contactId; setWonModal(null); onCreateReceivable(contactId); }}>
            Créer une créance
          </Button>
        </>}>
        <p className="text-sm text-slate-300">Félicitations. Aucune créance n’a été créée automatiquement.</p>
        <p className="mt-2 text-xs text-slate-500">Vous pouvez ouvrir le module Finances pour enregistrer la créance correspondante ; elle sera reliée au même contact CRM.</p>
      </Modal>

      {/* Formulaire tâche */}
      <Modal open={taskModal.open} onClose={() => setTaskModal({ open: false, editing: null })}
        title={taskModal.editing ? 'Modifier la tâche' : 'Nouvelle tâche'} size="lg"
        footer={<>
          <Button variant="ghost" onClick={() => setTaskModal({ open: false, editing: null })}>Annuler</Button>
          <Button variant="primary" loading={saving} onClick={() => void saveTask()}>Enregistrer</Button>
        </>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Input label="Titre" value={taskForm.title} onChange={(event) => setTaskForm({ ...taskForm, title: event.target.value })} placeholder="Appeler le client pour confirmer la proposition" /></div>
          <Select label="Type" value={taskForm.type} onChange={(event) => setTaskForm({ ...taskForm, type: event.target.value as TaskType })}>
            {TASK_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </Select>
          <Select label="Priorité" value={taskForm.priority} onChange={(event) => setTaskForm({ ...taskForm, priority: event.target.value })}>
            {Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
          <Select label="Contact" value={taskForm.contactId} onChange={(event) => setTaskForm({ ...taskForm, contactId: event.target.value })}>
            <option value="">Sans contact</option>
            {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contactOptionLabel(contact)}</option>)}
          </Select>
          <Select label="Opportunité" value={taskForm.opportunityId} onChange={(event) => setTaskForm({ ...taskForm, opportunityId: event.target.value })}>
            <option value="">Sans opportunité</option>
            {opportunities.filter((opportunity) => !taskForm.contactId || opportunity.contactId === taskForm.contactId)
              .map((opportunity) => <option key={opportunity.id} value={opportunity.id}>{opportunity.title}</option>)}
          </Select>
          <Input label="Responsable" value={taskForm.owner} onChange={(event) => setTaskForm({ ...taskForm, owner: event.target.value })} />
          <Input label="Date" type="date" value={taskForm.dueDate} onChange={(event) => setTaskForm({ ...taskForm, dueDate: event.target.value })} />
          <Input label="Heure" type="time" value={taskForm.dueTime} onChange={(event) => setTaskForm({ ...taskForm, dueTime: event.target.value })} />
          <Input label="Prochaine action" value={taskForm.nextAction} onChange={(event) => setTaskForm({ ...taskForm, nextAction: event.target.value })} />
          <Input label="Date de la prochaine action" type="date" value={taskForm.nextActionAt} onChange={(event) => setTaskForm({ ...taskForm, nextActionAt: event.target.value })} />
          <div className="sm:col-span-2"><Textarea label="Description" rows={3} value={taskForm.notes} onChange={(event) => setTaskForm({ ...taskForm, notes: event.target.value })} /></div>
        </div>
      </Modal>

      {/* Terminer une tâche */}
      <Modal open={Boolean(completeTask)} onClose={() => setCompleteTask(null)} title="Terminer la tâche" size="md"
        footer={<>
          <Button variant="ghost" onClick={() => setCompleteTask(null)}>Annuler</Button>
          <Button variant="outline" loading={saving} onClick={() => void finishTask(false)}>Terminer sans suite</Button>
          <Button variant="primary" loading={saving} onClick={() => void finishTask(true)}>Terminer et planifier</Button>
        </>}>
        <p className="mb-2 text-sm text-white">{completeTask?.title}</p>
        <Textarea label="Résultat" rows={3} value={completeForm.outcome} onChange={(event) => setCompleteForm({ ...completeForm, outcome: event.target.value })} placeholder="Réponse obtenue, décision, prochaine étape…" />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Input label="Prochaine action proposée" value={completeForm.nextAction} onChange={(event) => setCompleteForm({ ...completeForm, nextAction: event.target.value })} placeholder="Envoyer la proposition finale" />
          <Input label="Date de la prochaine action" type="date" value={completeForm.nextActionAt} onChange={(event) => setCompleteForm({ ...completeForm, nextActionAt: event.target.value })} />
        </div>
      </Modal>
    </div>
  );
}

function RECEIVABLE_LABEL(status: string): string {
  return ({ brouillon: 'Brouillon', en_attente: 'En attente', partiellement_payee: 'Partiellement payée', payee: 'Payée', en_retard: 'En retard', litige: 'En litige', annulee: 'Annulée' } as Record<string, string>)[status] ?? status;
}

