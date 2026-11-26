import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowDownLeft, ArrowUpRight, Banknote, Download, Plus, Receipt, Wallet,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Modal, Select, Textarea, cn } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { FINANCE_CATEGORIES, useRecords } from '../records/useRecords';
import { PAYMENT_METHODS, computeReceivableView, paymentFromRecord, receivableFromRecord, todayIso } from '../finance/model';
import { SALES_CATEGORIES, invoiceFromRecord } from '../sales/model';
import {
  CASH_CATEGORIES, EXPENSE_CATEGORIES, EXPENSE_RECURRENCES, EXPENSE_STATUSES,
  cashMovements, computeCashSummary, detectUnusualExpenses, expenseFromRecord,
  expensesByCategory, expensesToCsv, monthlyCashflow, nextRecurrenceDate, validateExpense,
  type Expense, type ExpenseRecurrence, type ExpenseStatus,
} from './model';
import { useGrandEcran } from '../../lib/media-query';
import {
  HORIZONS, actionsContreTrouDeCash, prevoirTresorerie, probabiliteEncaissement,
  type SemainesHorizon,
} from './prevision';

const money = (value: number | null) => value === null
  ? '—'
  : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'XOF', maximumFractionDigits: 0 }).format(value);

function downloadFile(name: string, content: string) {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  URL.revokeObjectURL(url);
}

function emptyExpense() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    label: '', category: 'Fournisseurs', supplier: '', amount: '', incurredAt: today, paidAt: today,
    method: 'especes', reference: '', notes: '', status: 'payee' as ExpenseStatus,
    recurrence: 'aucune' as ExpenseRecurrence,
  };
}

function ExpenseForm({ open, initial, onClose, onSubmit }: {
  open: boolean;
  initial: Expense | null;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState(() => initial ? {
    label: initial.label, category: initial.category, supplier: initial.supplier, amount: String(initial.amount),
    incurredAt: initial.incurredAt, paidAt: initial.paidAt, method: initial.method, reference: initial.reference,
    notes: initial.notes, status: initial.status, recurrence: initial.recurrence,
  } : emptyExpense());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  const submit = async () => {
    const draft: Expense = {
      id: initial?.id ?? 'draft', label: form.label, category: form.category, supplier: form.supplier,
      amount: Number(form.amount), incurredAt: form.incurredAt, paidAt: form.status === 'payee' ? form.paidAt : '',
      method: form.method as Expense['method'], reference: form.reference, notes: form.notes, status: form.status,
      recurrence: form.recurrence, createdAt: initial?.createdAt ?? '',
    };
    const errors = validateExpense(draft);
    if (errors.length) { setError(errors.join(' ')); return; }
    setBusy(true); setError('');
    try {
      await onSubmit({ ...form, amount: Number(form.amount) });
      onClose();
    } catch (cause) { setError(asAppError(cause).message); } finally { setBusy(false); }
  };

  const next = initial ? nextRecurrenceDate({ ...initial, recurrence: form.recurrence, incurredAt: form.incurredAt }) : '';

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Modifier la dépense' : 'Nouvelle dépense'} size="lg"
      description="Une dépense engagée n’est pas encore sortie de la trésorerie. Seules les dépenses payées sont déduites."
      footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={() => void submit()}>{initial ? 'Enregistrer' : 'Créer la dépense'}</Button></>}>
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Libellé" value={form.label} onChange={(event) => set({ label: event.target.value })} />
          <Input label="Montant" type="number" min={0} value={form.amount} onChange={(event) => set({ amount: event.target.value })} />
          <Select label="Catégorie" value={form.category} onChange={(event) => set({ category: event.target.value })}>
            {EXPENSE_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
          </Select>
          <Input label="Fournisseur" value={form.supplier} onChange={(event) => set({ supplier: event.target.value })} />
          <Input label="Date de la dépense" type="date" value={form.incurredAt} onChange={(event) => set({ incurredAt: event.target.value })} />
          <Select label="Statut" value={form.status} onChange={(event) => set({ status: event.target.value as ExpenseStatus })}>
            {EXPENSE_STATUSES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </Select>
          {form.status === 'payee' && <Input label="Date de paiement" type="date" value={form.paidAt} onChange={(event) => set({ paidAt: event.target.value })} />}
          <Select label="Moyen de paiement" value={form.method} onChange={(event) => set({ method: event.target.value })}>
            {PAYMENT_METHODS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </Select>
          <Select label="Récurrence" value={form.recurrence} onChange={(event) => set({ recurrence: event.target.value as ExpenseRecurrence })}>
            {EXPENSE_RECURRENCES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </Select>
          <Input label="Référence" value={form.reference} onChange={(event) => set({ reference: event.target.value })} />
        </div>
        {next && <p className="text-[11px] text-slate-400">Prochaine occurrence prévue le {next}. Aucune dépense n’est créée automatiquement.</p>}
        <Textarea label="Notes" value={form.notes} onChange={(event) => set({ notes: event.target.value })} />
      </div>
    </Modal>
  );
}

export default function CashWorkspace({ workspaceId, onOpenFinance }: { workspaceId: string | null; onOpenFinance: () => void }) {
  // Une seule vue montée à la fois : liste tactile ou tableau.
  const grandEcran = useGrandEcran();
  // Horizon de prévision : 8 semaines par défaut (deux mois, le plus lisible).
  const [horizon, setHorizon] = useState<SemainesHorizon>(8);
  const toast = useToast();
  const expensesStore = useRecords(CASH_CATEGORIES.expenses, workspaceId);
  const paymentsStore = useRecords(FINANCE_CATEGORIES.payments, workspaceId);
  const invoicesStore = useRecords(SALES_CATEGORIES.invoices, workspaceId);
  // Les créances sont la source des ENTRÉES attendues : sans elles, la
  // prévision ne serait qu'une extrapolation du passé.
  const receivablesStore = useRecords(FINANCE_CATEGORIES.receivables, workspaceId);
  const expenses = useMemo(() => expensesStore.records.map(expenseFromRecord), [expensesStore.records]);
  const payments = useMemo(() => paymentsStore.records.map(paymentFromRecord), [paymentsStore.records]);
  const invoices = useMemo(() => invoicesStore.records.map(invoiceFromRecord), [invoicesStore.records]);
  const [filter, setFilter] = useState('tous');
  const [editor, setEditor] = useState<Expense | null | 'new'>(null);
  const [monthlyOpen, setMonthlyOpen] = useState(false);

  const summary = useMemo(() => computeCashSummary({ payments, expenses }), [expenses, payments]);
  const movements = useMemo(() => cashMovements(payments, expenses), [expenses, payments]);
  const flow = useMemo(() => monthlyCashflow(payments, expenses), [expenses, payments]);
  const categories = useMemo(() => expensesByCategory(expenses), [expenses]);
  /**
   * Prévision de trésorerie construite depuis les données réelles.
   * La devise est celle de la majorité des créances ; les créances d'une autre
   * devise sont ignorées par `prevoirTresorerie` (jamais additionnées).
   */
  const prevision = useMemo(() => {
    const creances = receivablesStore.records.map((record) => {
      const view = computeReceivableView(receivableFromRecord(record), payments);
      const devise = typeof record.data.devise === 'string' && record.data.devise ? String(record.data.devise).toUpperCase() : 'XOF';
      return {
        id: view.receivable.id,
        reference: view.receivable.reference,
        solde: view.balance,
        devise,
        echeance: view.receivable.dueDate,
        joursDeRetard: Math.max(0, view.daysOverdue),
        statut: view.effectiveStatus,
      };
    });
    const frequences: Record<string, number> = {};
    for (const creance of creances) frequences[creance.devise] = (frequences[creance.devise] ?? 0) + 1;
    const devise = Object.entries(frequences).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'XOF';
    const entree = {
      aujourdhui: todayIso(),
      devise,
      tresorerieActuelle: summary.balance,
      creances,
      depenses: expenses.map((expense) => ({
        id: expense.id, label: expense.label, montant: expense.amount,
        date: expense.paidAt || expense.incurredAt,
        statut: expense.status, recurrence: expense.recurrence,
      })),
    };
    const projection = prevoirTresorerie(entree, horizon);
    /*
     * Traçabilité : l'utilisateur doit VOIR quelles créances entrent dans la
     * projection, avec le montant attendu. Une prévision qu'on ne peut pas
     * auditer n'inspire pas confiance — et masquer une créance oubliée est
     * exactement le genre d'erreur que ce panneau doit rendre visible.
     */
    const creancesProjetees = creances
      .filter((creance) => creance.solde > 0 && creance.devise === devise
        && creance.echeance && !['payee', 'annulee', 'brouillon'].includes(creance.statut))
      .map((creance) => ({
        ...creance,
        probabilite: probabiliteEncaissement(creance.joursDeRetard),
        attendu: Math.round(creance.solde * probabiliteEncaissement(creance.joursDeRetard)),
      }))
      .sort((a, b) => b.attendu - a.attendu);
    return { entree, projection, actions: actionsContreTrouDeCash(projection, entree), creancesProjetees };
  }, [expenses, horizon, payments, receivablesStore.records, summary.balance]);
  const unusual = useMemo(() => detectUnusualExpenses(expenses), [expenses]);
  const billed = useMemo(() => invoices
    .filter((invoice) => invoice.status !== 'brouillon' && invoice.status !== 'annulee')
    .reduce((sum, invoice) => sum + invoice.lines.reduce((total, line) => total + line.quantity * line.unitPrice * (1 - line.discountPct / 100) * (1 + line.taxPct / 100), 0), 0), [invoices]);
  const filteredMovements = movements.filter((movement) => filter === 'tous' || movement.kind === filter);
  const maxFlow = Math.max(1, ...flow.map((point) => Math.max(point.income, point.expense)));

  useEffect(() => { if (!editor) return; }, [editor]);

  const save = async (data: Record<string, unknown>) => {
    if (editor && editor !== 'new') await expensesStore.update(editor.id, data);
    else await expensesStore.create(data, null);
    toast.success(editor && editor !== 'new' ? 'Dépense mise à jour.' : 'Dépense enregistrée.');
  };

  if (expensesStore.loading || paymentsStore.loading) return <LoadingState label="Chargement de la trésorerie…" />;
  const loadError = expensesStore.error || paymentsStore.error;
  if (loadError) return <ErrorState message={loadError} onRetry={() => { void expensesStore.reload(); void paymentsStore.reload(); }} />;

  return (
    <div className="space-y-4" data-testid="cash-workspace">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {[
          ['Facturé', money(billed), 'Factures émises, pas encore de l’argent'],
          ['Encaissé', money(summary.collected), 'Paiements validés'],
          ['Dépenses payées', money(summary.paidExpenses), 'Sorties réelles'],
          ['Dépenses engagées', money(summary.committedExpenses), 'Pas encore décaissées'],
          ['Solde de trésorerie', money(summary.balance), 'Encaissé − dépenses payées'],
          ['Marge de trésorerie', money(summary.collected - summary.paidExpenses), 'Avant engagements'],
        ].map(([label, value, hint]) => (
          <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
            <p className="text-[9.5px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 font-display text-[16px] font-semibold text-white">{value}</p>
            <p className="text-[9.5px] text-slate-500">{hint}</p>
          </div>
        ))}
      </div>

      {/*
        Prévision de trésorerie — fonctionnalité 3.
        Mobile d'abord : une semaine = une ligne lisible, pas un graphique.
        Trois états d'honnêteté explicites : vide, prévision présente, trou de cash.
      */}
      <section className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3" data-testid="cash-prevision">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-[11px] font-semibold text-white">Prévision de trésorerie</p>
            <p className="text-[10px] text-slate-500">
              Créances attendues et dépenses connues, pondérées par l’ancienneté du retard. Ce sont des hypothèses, pas des garanties.
            </p>
          </div>
          <div className="flex gap-1" role="group" aria-label="Horizon de prévision">
            {HORIZONS.map((valeur) => (
              <Button
                key={valeur}
                size="sm"
                variant={horizon === valeur ? 'primary' : 'ghost'}
                aria-pressed={horizon === valeur}
                onClick={() => setHorizon(valeur)}
              >
                {valeur} sem.
              </Button>
            ))}
          </div>
        </div>

        {prevision.projection.vide ? (
          <p className="mt-3 rounded-lg border border-white/[0.06] px-3 py-2 text-[11px] text-slate-400">
            Aucune créance ni dépense exploitable : la prévision ne peut rien affirmer. Enregistrez une créance ou une dépense pour la voir apparaître.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            <ul className="liste-mobile overflow-hidden rounded-lg border border-white/[0.06]">
              {prevision.projection.semaines.map((semaine) => (
                <li key={semaine.semaine} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium text-white">Semaine {semaine.semaine}</p>
                    <p className="truncate text-[10px] text-slate-500">jusqu’au {semaine.fin}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={cn('text-[12px] font-semibold', semaine.cumul < 0 ? 'text-rose-300' : 'text-white')}>
                      {money(semaine.cumul)}
                    </p>
                    <p className="text-[9.5px] text-slate-500">
                      +{money(semaine.entrees)} / −{money(semaine.sorties)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>

            {prevision.creancesProjetees.length > 0 && (
              <details className="rounded-lg border border-white/[0.06] px-3 py-2" data-testid="cash-prevision-creances">
                <summary className="cursor-pointer text-[10.5px] text-slate-400">
                  Créances prises en compte ({prevision.creancesProjetees.length})
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {prevision.creancesProjetees.map((creance) => (
                    <li key={creance.id} className="flex items-baseline justify-between gap-2 text-[10.5px]">
                      <span className="min-w-0 truncate text-slate-300">{creance.reference || 'Sans référence'}</span>
                      <span className="shrink-0 text-slate-400">
                        {money(creance.solde)} · attendu {money(creance.attendu)} ({Math.round(creance.probabilite * 100)} %)
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {prevision.projection.creancesNonDatees > 0 && (
              <p className="text-[10.5px] text-amber-200">
                {prevision.projection.creancesNonDatees} créance(s) sans échéance ({money(prevision.projection.montantNonDate)}) ne sont pas projetées : fixez une date pour les compter.
              </p>
            )}

            {prevision.projection.premiereSemaineNegative !== null && (
              <div className="rounded-lg border border-rose-400/30 bg-rose-500/[0.06] p-3">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-rose-200">
                  <AlertTriangle size={12} /> Trésorerie sous zéro dès la semaine {prevision.projection.premiereSemaineNegative}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {prevision.actions.map((action) => (
                    <li key={action.label} className="text-[10.5px] text-slate-300">
                      <span className="font-medium text-white">{action.label}</span> · effet estimé {money(action.effet)}
                      <span className="block text-[9.5px] text-slate-500">{action.fondement}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[9.5px] text-slate-500">
                  Estimation automatique, à relire : elle ne garantit aucun résultat.
                </p>
              </div>
            )}

            <details className="rounded-lg border border-white/[0.06] px-3 py-2">
              <summary className="cursor-pointer text-[10.5px] text-slate-400">Comment l’encaissement est pondéré</summary>
              <ul className="mt-2 space-y-1 text-[10px] text-slate-500">
                {[0, 7, 15, 30, 60, 90].map((jours) => (
                  <li key={jours}>Retard de {jours} jour(s) : {Math.round(probabiliteEncaissement(jours) * 100)} % attendu</li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold text-white">Flux de trésorerie — 6 mois</p>
              <p className="text-[10px] text-slate-500">Encaissements réels et dépenses payées uniquement.</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setMonthlyOpen(true)}>Détail mensuel</Button>
          </div>
          <div className="flex h-40 items-end gap-3">
            {flow.map((point) => (
              <div key={point.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <div className="flex h-32 w-full items-end justify-center gap-1">
                  <div className="flex h-full w-1/2 flex-col justify-end" title={`Encaissements ${money(point.income)}`}>
                    <div className="w-full rounded-t bg-emerald-400/70" style={{ height: `${Math.max(1, (point.income / maxFlow) * 100)}%` }} />
                  </div>
                  <div className="flex h-full w-1/2 flex-col justify-end" title={`Dépenses ${money(point.expense)}`}>
                    <div className="w-full rounded-t bg-rose-400/60" style={{ height: `${Math.max(1, (point.expense / maxFlow) * 100)}%` }} />
                  </div>
                </div>
                <span className="text-[9px] text-slate-500">{point.month.slice(5)}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-3 text-[10px] text-slate-400"><span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-400/70" /> Encaissé</span><span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-rose-400/60" /> Dépensé</span></div>
        </div>

        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
          <p className="text-[11px] font-semibold text-white">Dépenses par catégorie</p>
          {categories.length === 0 ? <p className="mt-3 text-[11px] text-slate-500">Aucune dépense enregistrée.</p> : (
            <div className="mt-3 space-y-2">
              {categories.slice(0, 6).map((category) => (
                <div key={category.category}>
                  <div className="flex items-center justify-between text-[10.5px]"><span className="text-slate-300">{category.category}</span><span className="text-slate-400">{money(category.amount)}</span></div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-amber-300/70" style={{ width: `${category.amount / Math.max(1, summary.paidExpenses) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {unusual.length > 0 && (
        <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-100"><AlertTriangle size={13} /> Dépenses inhabituelles — règle explicable</p>
          <ul className="mt-2 space-y-1 text-[10.5px] text-amber-100/80">
            {unusual.slice(0, 4).map((entry) => <li key={entry.expense.id}>{entry.expense.label} · {entry.reason}</li>)}
          </ul>
          <p className="mt-1 text-[9.5px] text-amber-100/60">Seuil : dépense ≥ 2,5 × la médiane de sa catégorie et ≥ 25 000, sur au moins 3 dépenses.</p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
          {['tous', 'encaissement', 'depense'].map((entry) => (
            <button key={entry} type="button" onClick={() => setFilter(entry)} className={cn('rounded-lg px-3 py-1.5 text-[11px] font-medium', filter === entry ? 'bg-violet-400/15 text-white' : 'text-slate-400 hover:text-white')}>
              {entry === 'tous' ? 'Tout' : entry === 'encaissement' ? 'Encaissements' : 'Dépenses'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={onOpenFinance}>Voir Finance</Button>
          <Button size="sm" variant="outline" icon={<Download size={13} />} onClick={() => downloadFile('depenses.csv', expensesToCsv(expenses))}>Exporter</Button>
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor('new')}>Nouvelle dépense</Button>
        </div>
      </div>

      {expenses.length === 0 && payments.length === 0 ? (
        <EmptyState icon={<Wallet size={24} />} title="Aucun mouvement de trésorerie" description="Les paiements clients validés apparaissent ici. Enregistrez aussi vos dépenses pour calculer un solde réel." action={<Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor('new')}>Enregistrer une dépense</Button>} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/[0.07]">
          {filteredMovements.map((movement) => (
            <div key={movement.id} className="grid gap-1 border-b border-white/[0.04] px-3 py-2.5 text-[11.5px] last:border-0 hover:bg-white/[0.02] md:grid-cols-[90px_1.6fr_1fr_0.8fr_1fr] md:items-center">
              <span className="text-slate-500">{movement.date}</span>
              <span className="inline-flex min-w-0 items-center gap-1.5 text-white">{movement.kind === 'encaissement' ? <ArrowDownLeft size={13} className="text-emerald-300" /> : <ArrowUpRight size={13} className="text-rose-300" />}<span className="truncate">{movement.label}</span></span>
              <span className="text-slate-400">{movement.category}</span>
              <span className="text-slate-500">{PAYMENT_METHODS.find((entry) => entry.value === movement.method)?.label}</span>
              <span className={cn('font-medium', movement.kind === 'encaissement' ? 'text-emerald-200' : 'text-rose-200')}>{movement.kind === 'encaissement' ? '+' : '−'}{money(movement.amount)}</span>
            </div>
          ))}
          {filteredMovements.length === 0 && <p className="px-3 py-6 text-center text-[11px] text-slate-500">Aucun mouvement pour ce filtre.</p>}
        </div>
      )}

      {expenses.length > 0 && (
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
          <p className="mb-2 text-[11px] font-semibold text-white">Dépenses enregistrées</p>
          <div className="space-y-1">
            {expenses.slice().sort((a, b) => b.incurredAt.localeCompare(a.incurredAt)).slice(0, 8).map((expense) => (
              <button key={expense.id} type="button" onClick={() => setEditor(expense)} className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] hover:bg-white/[0.03]">
                <span className="text-slate-300">{expense.label} · {expense.category}</span>
                <span className="flex items-center gap-2"><Badge tone={expense.status === 'payee' ? 'success' : expense.status === 'engagee' ? 'warning' : 'neutral'}>{EXPENSE_STATUSES.find((entry) => entry.value === expense.status)?.label}</Badge><span className="text-slate-200">{money(expense.amount)}</span></span>
              </button>
            ))}
          </div>
        </div>
      )}

      {editor && <ExpenseForm open initial={editor === 'new' ? null : editor} onClose={() => setEditor(null)} onSubmit={save} />}

      <Modal open={monthlyOpen} onClose={() => setMonthlyOpen(false)} title="Rapport mensuel de trésorerie" size="md">
        {/* Sur téléphone, une carte par mois : quatre colonnes dans 360 px
            coupaient les montants. Les mêmes valeurs restent présentes. */}
        {!grandEcran && <ul className="liste-mobile">
          {flow.map((point) => (
            <li key={point.month} className="px-1 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-white">{point.month}</span>
                <span className={point.net >= 0 ? 'text-[13px] font-semibold text-emerald-200' : 'text-[13px] font-semibold text-rose-200'}>
                  {money(point.net)}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11.5px]">
                <span className="text-emerald-200">Entrées {money(point.income)}</span>
                <span className="text-rose-200">Sorties {money(point.expense)}</span>
              </div>
            </li>
          ))}
        </ul>}
        {grandEcran && <div className="table-defile">
            <table className="w-full text-left text-[11.5px]">
              <thead className="bg-white/[0.03] text-[9.5px] uppercase text-slate-500"><tr><th className="px-2 py-2">Mois</th><th>Encaissements</th><th>Dépenses</th><th>Net</th></tr></thead>
              <tbody>{flow.map((point) => <tr key={point.month} className="border-t border-white/[0.05]"><td className="px-2 py-2">{point.month}</td><td className="text-emerald-200">{money(point.income)}</td><td className="text-rose-200">{money(point.expense)}</td><td className={point.net >= 0 ? 'text-emerald-200' : 'text-rose-200'}>{money(point.net)}</td></tr>)}</tbody>
            </table>
          </div>}
        <p className="mt-3 text-[10px] text-slate-500"><Banknote size={11} className="mr-1 inline" />Le solde de trésorerie ne représente pas le chiffre d’affaires facturé. <Receipt size={11} className="mx-1 inline" />Les factures impayées restent dans Finance.</p>
      </Modal>
    </div>
  );
}
