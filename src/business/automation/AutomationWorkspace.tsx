import { useMemo, useState } from 'react';
import {
  BellRing, Copy, Plus, RefreshCw, Sparkles, ToggleLeft, ToggleRight, X,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Modal, Select, Textarea } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { CRM_CATEGORIES, FINANCE_CATEGORIES, useRecords } from '../records/useRecords';
import { CATALOG_CATEGORIES, movementFromRecord, productFromRecord, stockOf } from '../catalog/model';
import { CASH_CATEGORIES, detectUnusualExpenses, expenseFromRecord } from '../cash/model';
import { contactDisplayName, contactFromRecord, todayIso } from '../crm/model';
import { effectivePromiseStatus, paymentFromRecord, promiseFromRecord, receivableFromRecord, computeReceivableView } from '../finance/model';
import { SALES_CATEGORIES, computeInvoiceView, invoiceFromRecord, quoteFromRecord } from '../sales/model';
import {
  AUTOMATION_ACTIONS, AUTOMATION_CATEGORIES, AUTOMATION_TRIGGERS, automationAudit, automationDedupeKey,
  buildSignals, buildTaskFromRun, messageFromSignal, pendingRuns, ruleFromRecord, ruleToData,
  runFromRecord, runToData, type AutomationRule, type AutomationSignal, type AutomationTrigger,
} from './model';

export default function AutomationWorkspace({ workspaceId, onOpenContact }: { workspaceId: string | null; onOpenContact: (id: string) => void }) {
  const toast = useToast();
  const contactsStore = useRecords(CRM_CATEGORIES.contacts, workspaceId);
  const opportunitiesStore = useRecords(CRM_CATEGORIES.opportunities, workspaceId);
  const tasksStore = useRecords(CRM_CATEGORIES.tasks, workspaceId);
  const receivablesStore = useRecords(FINANCE_CATEGORIES.receivables, workspaceId);
  const paymentsStore = useRecords(FINANCE_CATEGORIES.payments, workspaceId);
  const promisesStore = useRecords(FINANCE_CATEGORIES.promises, workspaceId);
  const quotesStore = useRecords(SALES_CATEGORIES.quotes, workspaceId);
  const invoicesStore = useRecords(SALES_CATEGORIES.invoices, workspaceId);
  const productsStore = useRecords(CATALOG_CATEGORIES.products, workspaceId);
  const movementsStore = useRecords(CATALOG_CATEGORIES.movements, workspaceId);
  const expensesStore = useRecords(CASH_CATEGORIES.expenses, workspaceId);
  const rulesStore = useRecords(AUTOMATION_CATEGORIES.rules, workspaceId);
  const runsStore = useRecords(AUTOMATION_CATEGORIES.runs, workspaceId);

  const contacts = useMemo(() => contactsStore.records.map(contactFromRecord), [contactsStore.records]);
  const tasks = useMemo(() => tasksStore.records.map((record) => ({
    id: record.id, title: String(record.data?.title ?? ''), contactId: String(record.data?.contactId ?? ''),
    dueDate: String(record.data?.dueDate ?? ''), status: String(record.data?.status ?? 'a_faire'),
  })), [tasksStore.records]);
  const opportunities = useMemo(() => opportunitiesStore.records.map((record) => ({
    id: record.id, title: String(record.data?.title ?? ''), contactId: String(record.data?.contactId ?? ''),
    stage: String(record.data?.stage ?? 'nouveau'), updatedAt: record.updated_at ?? record.created_at ?? '',
    amount: typeof record.data?.amount === 'number' ? record.data.amount : null,
  })), [opportunitiesStore.records]);
  const payments = useMemo(() => paymentsStore.records.map(paymentFromRecord), [paymentsStore.records]);
  const receivables = useMemo(() => receivablesStore.records.map(receivableFromRecord).map((receivable) => {
    const view = computeReceivableView(receivable, payments);
    return { id: receivable.id, reference: receivable.reference, contactId: receivable.contactId, dueDate: receivable.dueDate, balance: view.balance, status: view.effectiveStatus };
  }), [payments, receivablesStore.records]);
  const promises = useMemo(() => promisesStore.records.map(promiseFromRecord).map((promise) => {
    const status = effectivePromiseStatus(promise, todayIso());
    return { id: promise.id, contactId: promise.contactId, amount: promise.amount, promisedAt: promise.promisedAt, status };
  }), [promisesStore.records]);
  const quotes = useMemo(() => quotesStore.records.map(quoteFromRecord).map((quote) => ({ id: quote.id, number: quote.number, contactId: quote.contactId, status: quote.status, issuedAt: quote.issuedAt })), [quotesStore.records]);
  const invoices = useMemo(() => invoicesStore.records.map(invoiceFromRecord).map((invoice) => {
    const view = computeInvoiceView(invoice, payments);
    return { id: invoice.id, number: invoice.number, contactId: invoice.contactId, dueDate: invoice.dueDate, balance: view.balance, effectiveStatus: view.effectiveStatus };
  }), [invoicesStore.records, payments]);
  const products = useMemo(() => productsStore.records.map(productFromRecord), [productsStore.records]);
  const movements = useMemo(() => movementsStore.records.map(movementFromRecord), [movementsStore.records]);
  const expenses = useMemo(() => expensesStore.records.map(expenseFromRecord), [expensesStore.records]);
  const rules = useMemo(() => rulesStore.records.map(ruleFromRecord), [rulesStore.records]);
  const runs = useMemo(() => runsStore.records.map(runFromRecord), [runsStore.records]);
  const audit = useMemo(() => automationAudit(rules, runs), [rules, runs]);

  const dataset = useMemo(() => ({
    contacts: contacts.map((contact) => ({ id: contact.id, name: contactDisplayName(contact), type: contact.type, lastContactAt: contact.lastContactAt })),
    opportunities, tasks, receivables, promises, quotes, invoices,
    products: products.map((product) => ({ id: product.id, name: product.name, stock: stockOf(product, movements), threshold: product.lowStockThreshold, trackStock: product.trackStock })),
    unusualExpenses: detectUnusualExpenses(expenses).map((entry) => ({ id: entry.expense.id, label: entry.expense.label, reason: entry.reason })),
  }), [contacts, expenses, invoices, movements, opportunities, products, promises, quotes, receivables, tasks]);

  const [editor, setEditor] = useState<AutomationRule | null | 'new'>(null);
  const [message, setMessage] = useState<{ signal: AutomationSignal; rule: AutomationRule } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  const suggestions = useMemo(() => rules.flatMap((rule) => {
    if (!rule.enabled) return [];
    const signals = buildSignals(rule.trigger, { ...dataset, today: todayIso() }, rule.thresholdDays);
    return pendingRuns(rule, signals, runs).map((signal) => ({ rule, signal }));
  }), [dataset, rules, runs]);

  const loading = rulesStore.loading || runsStore.loading || contactsStore.loading;
  const loadError = rulesStore.error || runsStore.error;

  const saveRule = async (data: Record<string, unknown>) => {
    if (editor && editor !== 'new') await rulesStore.update(editor.id, data);
    else await rulesStore.create(data, null);
    toast.success(editor && editor !== 'new' ? 'Automatisation mise à jour.' : 'Automatisation créée.');
  };

  const toggleRule = async (rule: AutomationRule) => {
    setBusy(rule.id);
    try {
      await rulesStore.update(rule.id, { ...ruleToData(rule), enabled: !rule.enabled });
      toast.success(rule.enabled ? 'Automatisation désactivée.' : 'Automatisation activée.');
    } catch (cause) { toast.error(asAppError(cause).message); } finally { setBusy(null); }
  };

  const logRun = async (rule: AutomationRule, signal: AutomationSignal, status: 'confirme' | 'ignore') => {
    await runsStore.create(runToData({
      id: '', ruleId: rule.id, itemKey: signal.itemKey, label: signal.label, detail: signal.detail,
      contactId: signal.contactId, status, createdAt: '',
    }), automationDedupeKey(rule.id, signal.itemKey));
  };

  const execute = async (rule: AutomationRule, signal: AutomationSignal) => {
    setBusy(signal.itemKey);
    try {
      if (rule.action === 'creer_tache') {
        const task = buildTaskFromRun(rule, signal);
        await tasksStore.create(task as unknown as Record<string, unknown>, automationDedupeKey(rule.id, signal.itemKey));
        await logRun(rule, signal, 'confirme');
        toast.success('Tâche créée dans le module Tâches.');
      } else if (rule.action === 'preparer_relance') {
        setMessage({ signal, rule });
      } else {
        await logRun(rule, signal, 'confirme');
        toast.success('Signal confirmé et journalisé.');
      }
    } catch (cause) { toast.error(asAppError(cause).message); } finally { setBusy(null); }
  };

  const ignore = async (rule: AutomationRule, signal: AutomationSignal) => {
    setBusy(signal.itemKey);
    try { await logRun(rule, signal, 'ignore'); toast.info('Signal ignoré et journalisé.'); }
    catch (cause) { toast.error(asAppError(cause).message); } finally { setBusy(null); }
  };

  if (loading) return <LoadingState label="Calcul des signaux…" />;
  if (loadError) return <ErrorState message={loadError} onRetry={() => void rulesStore.reload()} />;

  return (
    <div className="space-y-4" data-testid="automation-workspace">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {[
          ['Automatisations actives', `${audit.enabledRules}/${rules.length}`],
          ['Actions proposées', String(suggestions.length)],
          ['Confirmées', String(audit.confirmed)],
          ['Ignorées', String(audit.ignored)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
            <p className="text-[9.5px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 font-display text-[17px] font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-violet-300/15 bg-violet-400/[0.04] p-3">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-100"><Sparkles size={13} /> Règles déterministes, pas d’IA simulée</p>
        <p className="mt-1 text-[10.5px] text-violet-100/70">Chaque signal provient de données réelles. Une action externe (message) reste préparée, jamais envoyée automatiquement.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[12px] font-semibold text-white">Actions prioritaires</p>
          <p className="text-[10px] text-slate-500">Aucune proposition n’est répétée : chaque couple règle + élément est journalisé.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void runsStore.reload()}>Rafraîchir</Button>
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor('new')}>Nouvelle règle</Button>
        </div>
      </div>

      {suggestions.length === 0 ? (
        <EmptyState icon={<BellRing size={24} />} title="Aucune action proposée" description={rules.length ? 'Les données ne déclenchent aucune règle active pour le moment.' : 'Créez une première automatisation : tâche en retard, créance impayée, stock faible…'} action={<Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor('new')}>Créer une automatisation</Button>} />
      ) : (
        <div className="space-y-2">
          {suggestions.slice(0, 40).map(({ rule, signal }) => (
            <div key={`${rule.id}-${signal.itemKey}`} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[12px] font-medium text-white">{signal.label}</p>
                  <p className="mt-0.5 text-[10.5px] text-slate-400">{signal.detail}</p>
                  <p className="mt-1 text-[9.5px] text-slate-500">{rule.name} · {AUTOMATION_ACTIONS.find((entry) => entry.value === rule.action)?.label}</p>
                </div>
                <Badge tone={rule.trigger === 'creance_retard' || rule.trigger === 'facture_retard' ? 'danger' : 'warning'}>{AUTOMATION_TRIGGERS.find((entry) => entry.value === rule.trigger)?.label}</Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" loading={busy === signal.itemKey} onClick={() => void execute(rule, signal)}>{rule.action === 'preparer_relance' ? 'Préparer le message' : rule.action === 'notifier' ? 'Confirmer' : 'Créer la tâche'}</Button>
                {signal.contactId && <Button size="sm" variant="ghost" onClick={() => onOpenContact(signal.contactId)}>Fiche client</Button>}
                <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={() => void ignore(rule, signal)}>Ignorer</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
          <p className="text-[11px] font-semibold text-white">Automatisations configurées</p>
          <Button size="sm" variant="ghost" onClick={() => setPreview((value) => !value)}>{preview ? 'Masquer le journal' : 'Journal d’exécution'}</Button>
        </div>
        {rules.length === 0 ? <p className="px-3 py-5 text-center text-[11px] text-slate-500">Aucune règle configurée.</p> : (
          <div className="divide-y divide-white/[0.04]">
            {rules.map((rule) => (
              <div key={rule.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <button type="button" className="text-left text-[11.5px] font-medium text-white hover:text-violet-200" onClick={() => setEditor(rule)}>{rule.name}</button>
                  <p className="text-[10px] text-slate-500">{AUTOMATION_TRIGGERS.find((entry) => entry.value === rule.trigger)?.label}{rule.thresholdDays ? ` · ${rule.thresholdDays} j` : ''} · {AUTOMATION_ACTIONS.find((entry) => entry.value === rule.action)?.label}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={rule.enabled ? 'success' : 'neutral'}>{rule.enabled ? 'Active' : 'Désactivée'}</Badge>
                  <button type="button" onClick={() => void toggleRule(rule)} disabled={busy === rule.id} aria-label={rule.enabled ? `Désactiver ${rule.name}` : `Activer ${rule.name}`} className="text-slate-400 hover:text-white">
                    {rule.enabled ? <ToggleRight size={22} className="text-emerald-300" /> : <ToggleLeft size={22} />}
                  </button>
                  <Button size="sm" variant="ghost" onClick={() => setEditor(rule)}>Modifier</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {preview && (
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
          <p className="mb-2 text-[11px] font-semibold text-white">Journal d’exécution</p>
          {runs.length === 0 ? <p className="text-[10.5px] text-slate-500">Aucune exécution enregistrée.</p> : (
            <div className="space-y-1">
              {runs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((run) => (
                <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 text-[10.5px]">
                  <span className="min-w-0 truncate text-slate-300">{run.label}</span>
                  <span className="flex items-center gap-2"><Badge tone={run.status === 'confirme' ? 'success' : run.status === 'ignore' ? 'neutral' : 'warning'}>{{ propose: 'Proposé', confirme: 'Confirmé', ignore: 'Ignoré' }[run.status]}</Badge><span className="text-slate-500">{run.createdAt.slice(0, 10)}</span></span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {editor && <RuleForm open initial={editor === 'new' ? null : editor} onClose={() => setEditor(null)} onSubmit={saveRule} />}

      <Modal open={Boolean(message)} onClose={() => setMessage(null)} title="Relance préparée" description="Aucun message n’est envoyé. Copiez-le ou ouvrez votre application externe."
        footer={message && <><Button variant="ghost" onClick={() => setMessage(null)}>Fermer</Button><Button icon={<Copy size={13} />} onClick={() => {
          const contact = contacts.find((entry) => entry.id === message.signal.contactId);
          const text = messageFromSignal(message.signal, contact ? contactDisplayName(contact) : '');
          void navigator.clipboard?.writeText(text);
          toast.success('Message copié.');
        }}>Copier le message</Button></>}>
        {message && (() => {
          const contact = contacts.find((entry) => entry.id === message.signal.contactId);
          const text = messageFromSignal(message.signal, contact ? contactDisplayName(contact) : '');
          return <Textarea label="Message" readOnly value={text} hint={contact?.whatsapp ? `WhatsApp : ${contact.whatsapp}` : 'Aucun numéro WhatsApp renseigné.'} />;
        })()}
      </Modal>
    </div>
  );
}

function RuleForm({ open, initial, onClose, onSubmit }: {
  open: boolean;
  initial: AutomationRule | null;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [trigger, setTrigger] = useState<AutomationTrigger>(initial?.trigger ?? 'tache_retard');
  const [thresholdDays, setThresholdDays] = useState(String(initial?.thresholdDays ?? 2));
  const [action, setAction] = useState(initial?.action ?? 'creer_tache');
  const [channel, setChannel] = useState<'whatsapp' | 'email' | 'sms' | 'appel'>(initial?.channel ?? 'whatsapp');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) { setError('Le nom est obligatoire.'); return; }
    setBusy(true); setError('');
    try {
      await onSubmit({ name, trigger, thresholdDays: Number(thresholdDays) || 0, action, channel, enabled, lastRunAt: initial?.lastRunAt ?? '' });
      onClose();
    } catch (cause) { setError(asAppError(cause).message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Modifier l’automatisation' : 'Nouvelle automatisation'}
      footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={() => void submit()}>{initial ? 'Enregistrer' : 'Créer'}</Button></>}>
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{error}</p>}
        <Input label="Nom" value={name} onChange={(event) => setName(event.target.value)} placeholder="Relancer les devis oubliés" />
        <Select label="Déclencheur" value={trigger} onChange={(event) => setTrigger(event.target.value as AutomationTrigger)}>
          {AUTOMATION_TRIGGERS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
        </Select>
        <p className="-mt-2 text-[10px] text-slate-500">{AUTOMATION_TRIGGERS.find((entry) => entry.value === trigger)?.description}</p>
        {['tache_retard', 'opportunite_stagnante', 'creance_retard', 'promesse_non_respectee', 'devis_sans_suivi', 'facture_retard'].includes(trigger) && (
          <Input label="Seuil (jours)" type="number" min={0} value={thresholdDays} onChange={(event) => setThresholdDays(event.target.value)} />
        )}
        <Select label="Action" value={action} onChange={(event) => setAction(event.target.value as typeof action)}>
          {AUTOMATION_ACTIONS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
        </Select>
        {action === 'creer_tache' && (
          <Select label="Canal de la tâche" value={channel} onChange={(event) => setChannel(event.target.value as 'whatsapp' | 'email' | 'sms' | 'appel')}>
            <option value="whatsapp">WhatsApp</option><option value="email">E-mail</option><option value="sms">SMS</option><option value="appel">Appel</option>
          </Select>
        )}
        <label className="flex items-center gap-2 text-[11px] text-slate-300">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Activer immédiatement
        </label>
      </div>
    </Modal>
  );
}
