import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Download, FileText, Package, Plus, Printer, Receipt, ShoppingCart, Trash2,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Modal, Select, Textarea, cn } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { CRM_CATEGORIES, FINANCE_CATEGORIES, useRecords } from '../records/useRecords';
import { contactDisplayName, contactFromRecord, todayIso, type Contact } from '../crm/model';
import { CATALOG_CATEGORIES, productFromRecord } from '../catalog/model';
import { paymentFromRecord } from '../finance/model';
import {
  INVOICE_STATUSES, ORDER_STATUSES, QUOTE_STATUSES, SALES_CATEGORIES, addDays, computeInvoiceView,
  computeSalesDashboard, computeTotals, conversionErrors, invoiceFromRecord, invoiceToData,
  invoiceToReceivableData, invoicesToCsv, nextNumber, orderFromRecord, orderToData,
  orderToInvoiceDraft, printableDocument, quoteFromRecord, quoteToData,
  quoteToOrderDraft, quotesToCsv, statusLabel, statusTone,
  type Invoice, type Quote, type SalesLine, type SalesOrder,
} from './model';

export type SalesTab = 'devis' | 'commandes' | 'factures';

const TABS: { id: SalesTab; label: string; icon: typeof FileText }[] = [
  { id: 'devis', label: 'Devis', icon: FileText },
  { id: 'commandes', label: 'Commandes', icon: ShoppingCart },
  { id: 'factures', label: 'Factures', icon: Receipt },
];

const money = (value: number | null, currency = 'XOF') => value === null
  ? '—'
  : new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);

const uid = () => {
  try { return crypto.randomUUID(); } catch { return `line-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
};

function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([`\uFEFF${content}`], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function newLine(): SalesLine {
  return { id: uid(), productId: '', description: '', quantity: 1, unitPrice: 0, discountPct: 0, taxPct: 0 };
}

function LineEditor({ lines, onChange, products }: {
  lines: SalesLine[];
  onChange: (lines: SalesLine[]) => void;
  products: Array<{ id: string; name: string; price: number | null }>;
}) {
  const update = (id: string, patch: Partial<SalesLine>) => onChange(lines.map((line) => line.id === id ? { ...line, ...patch } : line));
  const totals = computeTotals(lines);
  return (
    <div className="space-y-2">
      <div className="hidden gap-2 text-[10px] uppercase tracking-wide text-slate-500 sm:grid sm:grid-cols-[minmax(0,2.2fr)_70px_100px_70px_60px_32px]">
        <span>Désignation</span><span>Qté</span><span>Prix unitaire</span><span>Remise %</span><span>TVA %</span><span />
      </div>
      {lines.map((line) => (
        <div key={line.id} className="grid gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2 sm:grid-cols-[minmax(0,2.2fr)_70px_100px_70px_60px_32px]">
          <div className="space-y-1">
            {products.length > 0 && (
              <Select
                aria-label="Produit du catalogue"
                value={line.productId}
                onChange={(event) => {
                  const product = products.find((entry) => entry.id === event.target.value);
                  update(line.id, { productId: event.target.value, description: product?.name ?? line.description, unitPrice: product?.price ?? line.unitPrice });
                }}
              >
                <option value="">Ligne libre</option>
                {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
              </Select>
            )}
            <Input aria-label="Désignation de la ligne" value={line.description} placeholder="Produit ou service" onChange={(event) => update(line.id, { description: event.target.value })} />
          </div>
          <Input aria-label="Quantité" type="number" min={0.01} step="0.01" value={line.quantity} onChange={(event) => update(line.id, { quantity: Number(event.target.value) })} />
          <Input aria-label="Prix unitaire" type="number" min={0} step="1" value={line.unitPrice} onChange={(event) => update(line.id, { unitPrice: Number(event.target.value) })} />
          <Input aria-label="Remise en pourcentage" type="number" min={0} max={100} value={line.discountPct} onChange={(event) => update(line.id, { discountPct: Number(event.target.value) })} />
          <Input aria-label="TVA en pourcentage" type="number" min={0} max={100} value={line.taxPct} onChange={(event) => update(line.id, { taxPct: Number(event.target.value) })} />
          <button type="button" aria-label="Supprimer la ligne" className="rounded-lg p-2 text-slate-500 hover:bg-rose-500/10 hover:text-rose-200" onClick={() => onChange(lines.filter((entry) => entry.id !== line.id))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => onChange([...lines, newLine()])}>Ajouter une ligne</Button>
        <div className="flex flex-wrap gap-3 text-[11px] text-slate-400">
          <span>Sous-total <strong className="text-slate-200">{money(totals.subtotal)}</strong></span>
          <span>Remise <strong className="text-slate-200">{money(totals.discount)}</strong></span>
          <span>Taxes <strong className="text-slate-200">{money(totals.tax)}</strong></span>
          <span>Total <strong className="text-white">{money(totals.total)}</strong></span>
        </div>
      </div>
    </div>
  );
}

function DocumentForm({ kind, open, initial, contacts, products, onClose, onSubmit }: {
  kind: SalesTab;
  open: boolean;
  initial: Quote | SalesOrder | Invoice | null;
  contacts: Contact[];
  products: Array<{ id: string; name: string; price: number | null }>;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}) {
  const singular = kind === 'devis' ? 'devis' : kind === 'commandes' ? 'commande' : 'facture';
  const [contactId, setContactId] = useState('');
  const [number, setNumber] = useState('');
  const [status, setStatus] = useState('');
  const [issuedAt, setIssuedAt] = useState(todayIso());
  const [secondDate, setSecondDate] = useState('');
  const [terms, setTerms] = useState('Paiement à 30 jours');
  const [notes, setNotes] = useState('');
  const [currency, setCurrency] = useState('XOF');
  const [lines, setLines] = useState<SalesLine[]>([newLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setContactId(initial?.contactId ?? '');
    setNumber(initial?.number ?? '');
    setStatus(initial?.status ?? 'brouillon');
    setIssuedAt(('issuedAt' in (initial ?? {}) ? (initial as Quote).issuedAt : (initial as SalesOrder | null)?.orderedAt) || todayIso());
    setSecondDate(kind === 'devis' ? ('expiresAt' in (initial ?? {}) ? (initial as Quote).expiresAt : addDays(todayIso(), 15)) : kind === 'commandes' ? ('expectedAt' in (initial ?? {}) ? (initial as SalesOrder).expectedAt : '') : ('dueDate' in (initial ?? {}) ? (initial as Invoice).dueDate : addDays(todayIso(), 30)));
    setTerms(('terms' in (initial ?? {}) ? (initial as Quote | Invoice).terms : '') || 'Paiement à 30 jours');
    setNotes(initial?.notes ?? '');
    setCurrency(initial?.currency ?? 'XOF');
    setLines(initial?.lines?.length ? initial.lines : [newLine()]);
  }, [initial, kind, open]);

  const submit = async () => {
    const validation = conversionErrors(kind === 'commandes' ? 'commande' : kind === 'factures' ? 'facture' : 'devis', { lines, contactId });
    if (validation.length) { setError(validation.join(' ')); return; }
    setBusy(true);
    try {
      const common = { number, contactId, status, lines, currency, notes };
      const payload = kind === 'devis'
        ? { ...common, issuedAt, expiresAt: secondDate, terms }
        : kind === 'commandes'
          ? { ...common, orderedAt: issuedAt, expectedAt: secondDate }
          : { ...common, issuedAt, dueDate: secondDate, terms };
      await onSubmit(payload);
      onClose();
    } catch (cause) {
      setError(asAppError(cause).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`${initial ? 'Modifier' : 'Nouveau'} ${singular}`}
      description="Les totaux sont recalculés à partir des lignes. Aucun envoi réel n’est déclenché."
      footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={() => void submit()}>{initial ? 'Enregistrer' : `Créer le ${singular}`}</Button></>}
    >
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Client (CRM)" value={contactId} onChange={(event) => setContactId(event.target.value)}>
            <option value="">Sélectionner un client</option>
            {contacts.filter((contact) => contact.status !== 'archive').map((contact) => (
              <option key={contact.id} value={contact.id}>{contactDisplayName(contact)}{contact.company ? ` · ${contact.company}` : ''}</option>
            ))}
          </Select>
          <Input label="Numéro" value={number} placeholder="Généré automatiquement" onChange={(event) => setNumber(event.target.value)} />
          <Select label="Statut" value={status} onChange={(event) => setStatus(event.target.value)}>
            {(kind === 'devis' ? QUOTE_STATUSES : kind === 'commandes' ? ORDER_STATUSES : INVOICE_STATUSES).map((entry) => (
              <option key={entry.value} value={entry.value}>{entry.label}</option>
            ))}
          </Select>
          <Input label={kind === 'commandes' ? 'Date de commande' : 'Date d’émission'} type="date" value={issuedAt} onChange={(event) => setIssuedAt(event.target.value)} />
          <Input label={kind === 'devis' ? 'Expiration' : kind === 'commandes' ? 'Livraison prévue' : 'Échéance'} type="date" value={secondDate} onChange={(event) => setSecondDate(event.target.value)} />
          <Select label="Devise" value={currency} onChange={(event) => setCurrency(event.target.value)}>
            <option value="XOF">XOF</option><option value="EUR">EUR</option><option value="USD">USD</option><option value="MAD">MAD</option>
          </Select>
        </div>
        <LineEditor lines={lines} onChange={setLines} products={products} />
        {kind !== 'commandes' && <Input label="Conditions" value={terms} onChange={(event) => setTerms(event.target.value)} />}
        <Textarea label="Notes internes" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </div>
    </Modal>
  );
}

export default function SalesWorkspace({
  workspaceId, initialTab = 'devis', lockTab = false, onOpenContact, onOpenFinance,
}: {
  workspaceId: string | null;
  initialTab?: SalesTab;
  lockTab?: boolean;
  onOpenContact: (contactId: string) => void;
  onOpenFinance: (contactId?: string) => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<SalesTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const contactsStore = useRecords(CRM_CATEGORIES.contacts, workspaceId);
  const quotesStore = useRecords(SALES_CATEGORIES.quotes, workspaceId);
  const ordersStore = useRecords(SALES_CATEGORIES.orders, workspaceId);
  const invoicesStore = useRecords(SALES_CATEGORIES.invoices, workspaceId);
  const paymentsStore = useRecords(FINANCE_CATEGORIES.payments, workspaceId);
  const receivablesStore = useRecords(FINANCE_CATEGORIES.receivables, workspaceId);
  const productsStore = useRecords(CATALOG_CATEGORIES.products, workspaceId);

  const contacts = useMemo(() => contactsStore.records.map(contactFromRecord), [contactsStore.records]);
  const quotes = useMemo(() => quotesStore.records.map(quoteFromRecord), [quotesStore.records]);
  const orders = useMemo(() => ordersStore.records.map(orderFromRecord), [ordersStore.records]);
  const invoices = useMemo(() => invoicesStore.records.map(invoiceFromRecord), [invoicesStore.records]);
  const payments = useMemo(() => paymentsStore.records.map(paymentFromRecord), [paymentsStore.records]);
  const products = useMemo(() => productsStore.records.map(productFromRecord).filter((product) => product.active), [productsStore.records]);
  const contactById = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact])), [contacts]);
  const contactName = (id: string) => contactById.get(id) ? contactDisplayName(contactById.get(id)!) : 'Client non relié';
  const invoiceViews = useMemo(() => invoices.map((invoice) => computeInvoiceView(invoice, payments)), [invoices, payments]);
  const dashboard = useMemo(() => computeSalesDashboard({ quotes, orders, invoiceViews }), [invoiceViews, orders, quotes]);

  const [editor, setEditor] = useState<{ kind: SalesTab; document: Quote | SalesOrder | Invoice | null } | null>(null);
  const [detail, setDetail] = useState<{ kind: SalesTab; id: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const loading = contactsStore.loading || quotesStore.loading || ordersStore.loading || invoicesStore.loading;
  const loadError = quotesStore.error || ordersStore.error || invoicesStore.error || contactsStore.error;

  const detailRecord = useMemo(() => {
    if (!detail) return null;
    if (detail.kind === 'devis') return quotes.find((entry) => entry.id === detail.id) ?? null;
    if (detail.kind === 'commandes') return orders.find((entry) => entry.id === detail.id) ?? null;
    return invoices.find((entry) => entry.id === detail.id) ?? null;
  }, [detail, invoices, orders, quotes]);

  const save = async (kind: SalesTab, record: Quote | SalesOrder | Invoice | null, payload: Record<string, unknown>) => {
    const store = kind === 'devis' ? quotesStore : kind === 'commandes' ? ordersStore : invoicesStore;
    const existingNumbers = (kind === 'devis' ? quotes.map((entry) => entry.number) : kind === 'commandes' ? orders.map((entry) => entry.number) : invoices.map((entry) => entry.number));
    const number = String(payload.number || '').trim() || nextNumber(kind === 'devis' ? 'devis' : kind === 'commandes' ? 'commande' : 'facture', existingNumbers);
    const data = { ...payload, number };
    if (record) {
      await store.update(record.id, data);
      toast.success(`${statusLabel(kind === 'devis' ? 'devis' : kind === 'commandes' ? 'commande' : 'facture', String(payload.status))} — ${number}`);
    } else {
      await store.create(data, `number:${number}`);
      toast.success(`${number} créé.`);
    }
  };

  const convertQuote = async (quote: Quote) => {
    setBusyId(quote.id);
    try {
      const number = nextNumber('commande', orders.map((entry) => entry.number));
      const orderId = await ordersStore.create(quoteToOrderDraft(quote, number) as unknown as Record<string, unknown>, `quote:${quote.id}`);
      await quotesStore.update(quote.id, { ...quoteToData(quote), status: 'converti', orderId });
      toast.success(`Commande ${number} créée depuis ${quote.number}.`);
      setTab('commandes');
    } catch (cause) {
      toast.error(asAppError(cause).message);
    } finally {
      setBusyId(null);
    }
  };

  const convertOrder = async (order: SalesOrder) => {
    setBusyId(order.id);
    try {
      const number = nextNumber('facture', invoices.map((entry) => entry.number));
      const invoiceId = await invoicesStore.create(orderToInvoiceDraft(order, number) as unknown as Record<string, unknown>, `order:${order.id}`);
      await ordersStore.update(order.id, { ...orderToData(order), invoiceId });
      toast.success(`Facture ${number} créée depuis ${order.number}.`);
      setTab('factures');
    } catch (cause) {
      toast.error(asAppError(cause).message);
    } finally {
      setBusyId(null);
    }
  };

  const createReceivable = async (invoice: Invoice) => {
    setBusyId(invoice.id);
    try {
      const existing = receivablesStore.records.find((record) => record.data?.invoiceId === invoice.id || record.id === invoice.receivableId);
      if (existing) {
        toast.info('Cette facture est déjà reliée à une créance.');
        return;
      }
      const data = invoiceToReceivableData(invoice);
      const receivableId = await receivablesStore.create(data, `invoice:${invoice.id}`);
      await invoicesStore.update(invoice.id, { ...invoiceToData(invoice), receivableId });
      toast.success(`Créance ${data.reference} créée dans Finance.`);
    } catch (cause) {
      toast.error(asAppError(cause).message);
    } finally {
      setBusyId(null);
    }
  };

  const openPrint = (kind: SalesTab, document: Quote | SalesOrder | Invoice) => {
    const html = printableDocument(kind === 'devis' ? 'devis' : kind === 'commandes' ? 'commande' : 'facture', document, contactName(document.contactId), 'VYORA Business');
    const win = window.open('', '_blank', 'noopener,noreferrer');
    if (!win) { toast.error('Autorisez les fenêtres contextuelles pour imprimer.'); return; }
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  };

  const deleteDraft = async (kind: SalesTab, document: Quote | SalesOrder | Invoice) => {
    const label = kind === 'devis' ? 'devis' : kind === 'commandes' ? 'commande' : 'facture';
    if (!window.confirm(`Supprimer définitivement le ${label} ${document.number} ? Cette action n’efface aucun paiement ni créance déjà liés.`)) return;
    setBusyId(document.id);
    try {
      const store = kind === 'devis' ? quotesStore : kind === 'commandes' ? ordersStore : invoicesStore;
      await store.remove(document.id);
      setDetail(null);
      toast.success(`${document.number} supprimé.`);
    } catch (cause) {
      toast.error(asAppError(cause).message);
    } finally { setBusyId(null); }
  };

  const setStatus = async (kind: SalesTab, document: Quote | SalesOrder | Invoice, status: string) => {
    setBusyId(document.id);
    try {
      const store = kind === 'devis' ? quotesStore : kind === 'commandes' ? ordersStore : invoicesStore;
      const data = kind === 'devis' ? quoteToData(document as Quote) : kind === 'commandes' ? orderToData(document as SalesOrder) : invoiceToData(document as Invoice);
      await store.update(document.id, { ...data, status });
      toast.success('Statut mis à jour.');
    } catch (cause) {
      toast.error(asAppError(cause).message);
    } finally {
      setBusyId(null);
    }
  };

  const kpis = [
    { label: 'Devis en attente', value: String(dashboard.pendingQuotes), sub: money(dashboard.pendingQuoteValue) },
    { label: 'Devis acceptés', value: String(dashboard.acceptedQuotes), sub: money(dashboard.acceptedQuoteValue) },
    { label: 'Commandes en cours', value: String(dashboard.openOrders), sub: money(dashboard.openOrderValue) },
    { label: 'Facturé', value: money(dashboard.invoicedTotal), sub: `Encaissé ${money(dashboard.collectedTotal)}` },
    { label: 'Factures impayées', value: String(dashboard.unpaidInvoices), sub: money(dashboard.unpaidAmount) },
    { label: 'En retard', value: String(dashboard.overdueInvoices), sub: 'Échéance dépassée' },
  ];

  if (loading) return <LoadingState label="Chargement des ventes…" />;
  if (loadError) return <ErrorState message={loadError} onRetry={() => { void quotesStore.reload(); void ordersStore.reload(); void invoicesStore.reload(); }} />;

  const rows = tab === 'devis' ? quotes : tab === 'commandes' ? orders : invoices;

  return (
    <div className="space-y-4" data-testid="sales-workspace">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
            <p className="text-[9.5px] uppercase tracking-wide text-slate-500">{kpi.label}</p>
            <p className="mt-1 font-display text-[17px] font-semibold text-white">{kpi.value}</p>
            <p className="truncate text-[10px] text-slate-500">{kpi.sub}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {!lockTab ? (
          <div className="flex gap-1 overflow-x-auto rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
            {TABS.map((entry) => {
              const Icon = entry.icon;
              return (
                <button key={entry.id} type="button" onClick={() => setTab(entry.id)} className={cn('flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-medium', tab === entry.id ? 'bg-violet-400/15 text-white' : 'text-slate-400 hover:text-white')}>
                  <Icon size={13} />{entry.label}
                </button>
              );
            })}
          </div>
        ) : <span className="text-[11px] text-slate-500">{TABS.find((entry) => entry.id === tab)?.label}</span>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" icon={<Download size={13} />} onClick={() => {
            if (tab === 'devis') downloadFile('devis.csv', quotesToCsv(quotes, contactName), 'text/csv');
            else downloadFile('factures.csv', invoicesToCsv(invoiceViews, contactName), 'text/csv');
          }}>Exporter</Button>
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor({ kind: tab, document: null })}>Nouveau</Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={tab === 'devis' ? <FileText size={24} /> : tab === 'commandes' ? <ShoppingCart size={24} /> : <Receipt size={24} />}
          title={tab === 'devis' ? 'Aucun devis' : tab === 'commandes' ? 'Aucune commande' : 'Aucune facture'}
          description={tab === 'devis' ? 'Créez un devis pour un client CRM, puis convertissez-le en commande une fois accepté.' : tab === 'commandes' ? 'Les commandes naissent d’un devis accepté ou peuvent être créées ici.' : 'Les factures se créent depuis une commande ; la créance Finance reste une action explicite.'}
          action={<Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor({ kind: tab, document: null })}>Créer</Button>}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/[0.07]">
          <div className="hidden grid-cols-[1.1fr_1.4fr_1fr_1fr_1fr_auto] gap-2 border-b border-white/[0.06] bg-white/[0.03] px-3 py-2 text-[9.5px] uppercase tracking-wide text-slate-500 md:grid">
            <span>Numéro</span><span>Client</span><span>Date</span><span>Statut</span><span>Montant</span><span />
          </div>
          {rows.map((row) => {
            const document = row as Quote | SalesOrder | Invoice;
            const view = tab === 'factures' ? invoiceViews.find((entry) => entry.invoice.id === document.id) : null;
            const total = view?.totals.total ?? computeTotals(document.lines).total;
            const status = view?.effectiveStatus ?? document.status;
            return (
              <div key={document.id} className="grid gap-1 border-b border-white/[0.04] px-3 py-2.5 text-[11.5px] last:border-0 hover:bg-white/[0.02] md:grid-cols-[1.1fr_1.4fr_1fr_1fr_1fr_auto] md:items-center">
                <button type="button" className="text-left font-medium text-white hover:text-violet-200" onClick={() => setDetail({ kind: tab, id: document.id })}>{document.number}</button>
                <button type="button" className="truncate text-left text-slate-300 hover:text-violet-200" onClick={() => document.contactId && onOpenContact(document.contactId)}>{document.contactId ? contactName(document.contactId) : 'Sans client'}</button>
                <span className="text-slate-400">{tab === 'devis' ? (document as Quote).issuedAt : tab === 'commandes' ? (document as SalesOrder).orderedAt : (document as Invoice).issuedAt}</span>
                <span><Badge tone={statusTone(tab === 'devis' ? 'devis' : tab === 'commandes' ? 'commande' : 'facture', status)}>{statusLabel(tab === 'devis' ? 'devis' : tab === 'commandes' ? 'commande' : 'facture', status)}</Badge></span>
                <span className="text-slate-200">{money(total, document.currency)}{view && view.balance > 0 ? <em className="ml-1 text-[10px] not-italic text-amber-200">reste {money(view.balance)}</em> : null}</span>
                <div className="flex flex-wrap gap-1">
                  {tab === 'devis' && (
                    <>
                      {document.status === 'brouillon' && <Button size="sm" variant="ghost" onClick={() => void setStatus('devis', document, 'envoye')} disabled={busyId === document.id}>Marquer envoyé</Button>}
                      {['accepte', 'envoye', 'brouillon'].includes(document.status) && <Button size="sm" variant="outline" icon={<ArrowRight size={12} />} onClick={() => void convertQuote(document as Quote)} disabled={busyId === document.id}>Commande</Button>}
                    </>
                  )}
                  {tab === 'commandes' && ['confirme', 'en_preparation', 'expedie', 'livre'].includes(document.status) && (
                    <Button size="sm" variant="outline" icon={<Receipt size={12} />} onClick={() => void convertOrder(document as SalesOrder)} disabled={busyId === document.id || Boolean((document as SalesOrder).invoiceId)}>Facturer</Button>
                  )}
                  {tab === 'factures' && (
                    <>
                      {!(document as Invoice).receivableId && <Button size="sm" variant="outline" icon={<Package size={12} />} onClick={() => void createReceivable(document as Invoice)} disabled={busyId === document.id}>Créer la créance</Button>}
                      {(document as Invoice).receivableId && <Button size="sm" variant="ghost" onClick={() => onOpenFinance(document.contactId)}>Finance</Button>}
                      <Button size="sm" variant="ghost" icon={<Printer size={12} />} onClick={() => openPrint('factures', document)}>Imprimer</Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editor && (
        <DocumentForm
          kind={editor.kind}
          open
          initial={editor.document}
          contacts={contacts}
          products={products.map((product) => ({ id: product.id, name: product.name, price: product.price }))}
          onClose={() => setEditor(null)}
          onSubmit={(data) => save(editor.kind, editor.document, data)}
        />
      )}

      <Modal open={Boolean(detail && detailRecord)} onClose={() => setDetail(null)} title={detailRecord?.number ?? 'Document'} size="lg"
        description={detailRecord ? contactName(detailRecord.contactId) : undefined}
        footer={detailRecord && detail ? (
          <>
            {detailRecord.status === 'brouillon' && (
              <Button variant="danger" icon={<Trash2 size={13} />} loading={busyId === detailRecord.id} onClick={() => void deleteDraft(detail.kind, detailRecord)}>Supprimer</Button>
            )}
            <Button variant="ghost" icon={<Printer size={13} />} onClick={() => openPrint(detail.kind, detailRecord)}>Imprimer</Button>
            <Button variant="outline" onClick={() => { setEditor({ kind: detail.kind, document: detailRecord }); setDetail(null); }}>Modifier</Button>
            {detail.kind === 'devis' && detailRecord.status !== 'converti' && (
              <Button onClick={() => void convertQuote(detailRecord as Quote)} loading={busyId === detailRecord.id}><ArrowRight size={13} /> Convertir en commande</Button>
            )}
          </>
        ) : undefined}>
        {detailRecord && (
          <div className="space-y-3 text-[12px]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(detail?.kind === 'devis' ? 'devis' : detail?.kind === 'commandes' ? 'commande' : 'facture', detail?.kind === 'factures' ? (invoiceViews.find((view) => view.invoice.id === detailRecord.id)?.effectiveStatus ?? detailRecord.status) : detailRecord.status)}>
                {statusLabel(detail?.kind === 'devis' ? 'devis' : detail?.kind === 'commandes' ? 'commande' : 'facture', detail?.kind === 'factures' ? (invoiceViews.find((view) => view.invoice.id === detailRecord.id)?.effectiveStatus ?? detailRecord.status) : detailRecord.status)}
              </Badge>
              {detail?.kind === 'factures' && (detailRecord as Invoice).receivableId && <span className="text-[11px] text-emerald-200">Créance Finance liée</span>}
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
              <table className="w-full text-left text-[11.5px]">
                <thead className="bg-white/[0.03] text-[9.5px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th>Qté</th><th>Prix</th><th>Remise</th><th>TVA</th><th>Total</th></tr></thead>
                <tbody>
                  {detailRecord.lines.map((line) => (
                    <tr key={line.id} className="border-t border-white/[0.04]"><td className="px-3 py-2">{line.description}</td><td>{line.quantity}</td><td>{line.unitPrice}</td><td>{line.discountPct}%</td><td>{line.taxPct}%</td><td>{money(line.quantity * line.unitPrice * (1 - line.discountPct / 100) * (1 + line.taxPct / 100), detailRecord.currency)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-4 font-medium text-white">
              <span>Sous-total {money(computeTotals(detailRecord.lines).subtotal, detailRecord.currency)}</span>
              <span>Total {money(computeTotals(detailRecord.lines).total, detailRecord.currency)}</span>
            </div>
            {detail?.kind === 'factures' && (() => {
              const view = invoiceViews.find((entry) => entry.invoice.id === detailRecord.id);
              return view ? <p className="text-slate-400">Encaissé {money(view.paid)} · Solde {money(view.balance)}{view.daysOverdue > 0 ? ` · ${view.daysOverdue} jour(s) de retard` : ''}</p> : null;
            })()}
            {detailRecord.notes && <p className="whitespace-pre-wrap text-slate-400">{detailRecord.notes}</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}
