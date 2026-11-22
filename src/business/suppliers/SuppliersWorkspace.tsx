import { useMemo, useState } from 'react';
import {
  Building2, Download, PackageCheck, Plus, Truck,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Modal, Select, Textarea, cn } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { useRecords } from '../records/useRecords';
import { CASH_CATEGORIES } from '../cash/model';
import { CATALOG_CATEGORIES, productFromRecord } from '../catalog/model';
import { computeTotals } from '../sales/model';
import { todayIso } from '../crm/model';
import {
  PURCHASE_STATUSES, SUPPLIER_CATEGORIES, buildReceipt, computePurchaseSummary, nextPurchaseNumber,
  ordersToCsv, purchaseFromRecord, purchaseToData, purchaseToExpenseData, receiptFromRecord,
  receiptStockMovements, supplierFromRecord,
  type GoodsReceipt, type PurchaseLine, type PurchaseOrder, type PurchaseStatus, type Supplier,
} from './model';

const money = (value: number | null) => value === null
  ? '—'
  : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'XOF', maximumFractionDigits: 0 }).format(value);

const uid = () => {
  try { return crypto.randomUUID(); } catch { return `line-${Date.now()}`; }
};

function downloadFile(name: string, content: string) {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  URL.revokeObjectURL(url);
}

function emptySupplier() {
  return { name: '', contactName: '', phone: '', email: '', address: '', city: '', country: '', category: '', notes: '', status: 'actif' };
}

function SupplierForm({ open, initial, onClose, onSubmit }: {
  open: boolean; initial: Supplier | null; onClose: () => void; onSubmit: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState(() => initial ? {
    name: initial.name, contactName: initial.contactName, phone: initial.phone, email: initial.email,
    address: initial.address, city: initial.city, country: initial.country,
    category: initial.category, notes: initial.notes, status: initial.status,
  } : emptySupplier());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const submit = async () => {
    if (!form.name.trim()) { setError('Le nom du fournisseur est obligatoire.'); return; }
    setBusy(true); setError('');
    try { await onSubmit(form); onClose(); } catch (cause) { setError(asAppError(cause).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Modifier le fournisseur' : 'Nouveau fournisseur'} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={() => void submit()}>{initial ? 'Enregistrer' : 'Créer'}</Button></>}>
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Nom" value={form.name} onChange={(event) => set({ name: event.target.value })} />
          <Input label="Contact" value={form.contactName} onChange={(event) => set({ contactName: event.target.value })} />
          <Input label="Téléphone" value={form.phone} onChange={(event) => set({ phone: event.target.value })} />
          <Input label="E-mail" type="email" value={form.email} onChange={(event) => set({ email: event.target.value })} />
          <Input label="Catégorie" value={form.category} onChange={(event) => set({ category: event.target.value })} placeholder="Matières premières, transport…" />
          <Select label="Statut" value={form.status} onChange={(event) => set({ status: event.target.value as Supplier['status'] })}>
            <option value="actif">Actif</option><option value="inactif">Inactif</option>
          </Select>
          <Input label="Ville" value={form.city} onChange={(event) => set({ city: event.target.value })} />
          <Input label="Pays" value={form.country} onChange={(event) => set({ country: event.target.value })} />
        </div>
        <Input label="Adresse" value={form.address} onChange={(event) => set({ address: event.target.value })} />
        <Textarea label="Notes" value={form.notes} onChange={(event) => set({ notes: event.target.value })} />
      </div>
    </Modal>
  );
}

function PurchaseForm({ open, suppliers, products, existingNumbers, initial, onClose, onSubmit }: {
  open: boolean;
  suppliers: Supplier[];
  products: Array<{ id: string; name: string; cost: number | null }>;
  existingNumbers: string[];
  initial: PurchaseOrder | null;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? suppliers[0]?.id ?? '');
  const [number, setNumber] = useState(initial?.number ?? nextPurchaseNumber(existingNumbers));
  const [orderedAt, setOrderedAt] = useState(initial?.orderedAt ?? todayIso());
  const [expectedAt, setExpectedAt] = useState(initial?.expectedAt ?? '');
  const [status, setStatus] = useState<PurchaseStatus>(initial?.status ?? 'brouillon');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [lines, setLines] = useState<PurchaseLine[]>(initial?.lines ?? [{ id: uid(), productId: '', description: '', quantity: 1, unitPrice: 0, discountPct: 0, taxPct: 0 }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (id: string, patch: Partial<PurchaseLine>) => setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line));
  const totals = computeTotals(lines);
  const submit = async () => {
    if (!supplierId) { setError('Sélectionnez un fournisseur.'); return; }
    if (!lines.length || lines.some((line) => !line.description.trim() || line.quantity <= 0)) { setError('Chaque ligne doit avoir une désignation et une quantité positive.'); return; }
    setBusy(true); setError('');
    try { await onSubmit({ supplierId, number, orderedAt, expectedAt, status, notes, lines, currency: 'XOF' }); onClose(); }
    catch (cause) { setError(asAppError(cause).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Modifier la commande fournisseur' : 'Nouvelle commande fournisseur'} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={() => void submit()}>{initial ? 'Enregistrer' : 'Créer la commande'}</Button></>}>
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Fournisseur" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
            <option value="">Sélectionner</option>
            {suppliers.filter((supplier) => supplier.status === 'actif').map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
          </Select>
          <Input label="Numéro" value={number} onChange={(event) => setNumber(event.target.value)} />
          <Input label="Date de commande" type="date" value={orderedAt} onChange={(event) => setOrderedAt(event.target.value)} />
          <Input label="Livraison prévue" type="date" value={expectedAt} onChange={(event) => setExpectedAt(event.target.value)} />
          <Select label="Statut" value={status} onChange={(event) => setStatus(event.target.value as PurchaseStatus)}>
            {PURCHASE_STATUSES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </Select>
        </div>
        <div className="space-y-2">
          {lines.map((line) => (
            <div key={line.id} className="grid gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2 sm:grid-cols-[1.1fr_1.5fr_65px_90px_32px]">
              <Select aria-label="Produit acheté" value={line.productId} onChange={(event) => {
                const product = products.find((entry) => entry.id === event.target.value);
                update(line.id, { productId: event.target.value, description: product?.name ?? line.description, unitPrice: product?.cost ?? line.unitPrice });
              }}>
                <option value="">Prestation / libre</option>
                {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
              </Select>
              <Input aria-label="Désignation achat" value={line.description} placeholder="Désignation" onChange={(event) => update(line.id, { description: event.target.value })} />
              <Input aria-label="Quantité achat" type="number" min={0.01} value={line.quantity} onChange={(event) => update(line.id, { quantity: Number(event.target.value) })} />
              <Input aria-label="Prix achat" type="number" min={0} value={line.unitPrice} onChange={(event) => update(line.id, { unitPrice: Number(event.target.value) })} />
              <button type="button" aria-label="Supprimer la ligne d’achat" className="rounded p-2 text-slate-500 hover:text-rose-200" onClick={() => setLines((current) => current.filter((entry) => entry.id !== line.id))}>×</button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button size="sm" variant="outline" icon={<Plus size={12} />} onClick={() => setLines((current) => [...current, { id: uid(), productId: '', description: '', quantity: 1, unitPrice: 0, discountPct: 0, taxPct: 0 }])}>Ligne</Button>
            <span className="text-[11px] text-slate-300">Total <strong>{money(totals.total)}</strong></span>
          </div>
        </div>
        <Textarea label="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </div>
    </Modal>
  );
}

export default function SuppliersWorkspace({ workspaceId }: { workspaceId: string | null }) {
  const toast = useToast();
  const suppliersStore = useRecords(SUPPLIER_CATEGORIES.suppliers, workspaceId);
  const purchasesStore = useRecords(SUPPLIER_CATEGORIES.purchases, workspaceId);
  const receiptsStore = useRecords(SUPPLIER_CATEGORIES.receipts, workspaceId);
  const productsStore = useRecords(CATALOG_CATEGORIES.products, workspaceId);
  const movementsStore = useRecords(CATALOG_CATEGORIES.movements, workspaceId);
  const expensesStore = useRecords(CASH_CATEGORIES.expenses, workspaceId);
  const suppliers = useMemo(() => suppliersStore.records.map(supplierFromRecord), [suppliersStore.records]);
  const purchases = useMemo(() => purchasesStore.records.map(purchaseFromRecord), [purchasesStore.records]);
  const receipts = useMemo(() => receiptsStore.records.map(receiptFromRecord), [receiptsStore.records]);
  const products = useMemo(() => productsStore.records.map(productFromRecord), [productsStore.records]);
  const summary = useMemo(() => computePurchaseSummary(suppliers, purchases), [purchases, suppliers]);

  const [tab, setTab] = useState<'fournisseurs' | 'achats' | 'receptions'>('fournisseurs');
  const [supplierEditor, setSupplierEditor] = useState<Supplier | null | 'new'>(null);
  const [purchaseEditor, setPurchaseEditor] = useState<PurchaseOrder | null | 'new'>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const supplierName = (id: string) => suppliers.find((supplier) => supplier.id === id)?.name ?? 'Fournisseur inconnu';
  const loading = suppliersStore.loading || purchasesStore.loading || productsStore.loading;
  const loadError = suppliersStore.error || purchasesStore.error;

  const saveSupplier = async (data: Record<string, unknown>) => {
    if (supplierEditor && supplierEditor !== 'new') await suppliersStore.update(supplierEditor.id, data);
    else await suppliersStore.create(data, null);
    toast.success('Fournisseur enregistré.');
  };

  const savePurchase = async (data: Record<string, unknown>) => {
    if (purchaseEditor && purchaseEditor !== 'new') await purchasesStore.update(purchaseEditor.id, data);
    else await purchasesStore.create(data, `number:${String(data.number)}`);
    toast.success('Commande fournisseur enregistrée.');
  };

  const receive = async (order: PurchaseOrder) => {
    setBusy(order.id);
    try {
      const draft = buildReceipt(order);
      if (!draft.lines.length) { toast.error('Aucune ligne liée à un produit : rien à entrer en stock.'); return; }
      const receiptId = await receiptsStore.create(draft as unknown as Record<string, unknown>, `purchase:${order.id}`);
      const receipt: GoodsReceipt = { ...draft, id: receiptId, createdAt: '' };
      const movements = receiptStockMovements(receipt);
      for (const movement of movements) {
        await movementsStore.create(movement.data, movement.dedupeKey);
      }
      await purchasesStore.update(order.id, { ...purchaseToData(order), status: 'recu', receivedAt: draft.receivedAt });
      toast.success(`Réception enregistrée : ${movements.length} entrée(s) de stock.`);
    } catch (cause) { toast.error(asAppError(cause).message); } finally { setBusy(null); }
  };

  const createExpense = async (order: PurchaseOrder, paid: boolean) => {
    setBusy(`expense-${order.id}`);
    try {
      if (order.expenseId) { toast.info('Une dépense est déjà reliée à cette commande.'); return; }
      const data = purchaseToExpenseData(order, supplierName(order.supplierId), paid);
      const expenseId = await expensesStore.create(data, `purchase:${order.id}`);
      await purchasesStore.update(order.id, { ...purchaseToData(order), expenseId });
      toast.success(`Dépense ${paid ? 'payée' : 'engagée'} créée dans la trésorerie.`);
    } catch (cause) { toast.error(asAppError(cause).message); } finally { setBusy(null); }
  };

  if (loading) return <LoadingState label="Chargement des achats…" />;
  if (loadError) return <ErrorState message={loadError} onRetry={() => { void suppliersStore.reload(); void purchasesStore.reload(); }} />;

  return (
    <div className="space-y-4" data-testid="suppliers-workspace">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {[
          ['Fournisseurs actifs', String(summary.suppliers)],
          ['Commandes ouvertes', String(summary.openOrders)],
          ['Montant engagé', money(summary.openAmount)],
          ['Commandes reçues', String(summary.receivedOrders)],
          ['Achats totaux', money(summary.purchasesTotal)],
          ['Dépenses reliées', String(summary.expensesLinked)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
            <p className="text-[9.5px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 font-display text-[16px] font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
          {(['fournisseurs', 'achats', 'receptions'] as const).map((entry) => (
            <button key={entry} type="button" onClick={() => setTab(entry)} className={cn('rounded-lg px-3 py-1.5 text-[11px] font-medium', tab === entry ? 'bg-violet-400/15 text-white' : 'text-slate-400 hover:text-white')}>
              {entry === 'fournisseurs' ? 'Fournisseurs' : entry === 'achats' ? 'Commandes' : 'Réceptions'}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" icon={<Download size={13} />} onClick={() => downloadFile('achats.csv', ordersToCsv(purchases, supplierName))}>Exporter</Button>
          {tab === 'fournisseurs'
            ? <Button size="sm" icon={<Plus size={13} />} onClick={() => setSupplierEditor('new')}>Nouveau fournisseur</Button>
            : <Button size="sm" icon={<Plus size={13} />} onClick={() => setPurchaseEditor('new')}>Nouvelle commande</Button>}
        </div>
      </div>

      {tab === 'fournisseurs' && (
        suppliers.length === 0
          ? <EmptyState icon={<Building2 size={24} />} title="Aucun fournisseur" description="Créez un fournisseur pour relier achats, réceptions, stock et dépenses." action={<Button size="sm" onClick={() => setSupplierEditor('new')}>Créer</Button>} />
          : <div className="overflow-hidden rounded-xl border border-white/[0.07]">
            {suppliers.map((supplier) => (
              <div key={supplier.id} className="grid gap-1 border-b border-white/[0.04] px-3 py-2.5 text-[11.5px] last:border-0 hover:bg-white/[0.02] md:grid-cols-[1.5fr_1fr_1fr_0.7fr_auto] md:items-center">
                <div className="min-w-0">
                  <button type="button" className="truncate text-left font-medium text-white hover:text-violet-200" onClick={() => setSupplierEditor(supplier)}>{supplier.name}</button>
                  <p className="truncate text-[10px] text-slate-500">{supplier.category || 'Sans catégorie'} · {supplier.city || 'Ville non renseignée'}</p>
                </div>
                <span className="text-slate-300">{supplier.contactName || '—'}</span>
                <span className="text-slate-400">{supplier.phone || supplier.email || '—'}</span>
                <Badge tone={supplier.status === 'actif' ? 'success' : 'neutral'}>{supplier.status === 'actif' ? 'Actif' : 'Inactif'}</Badge>
                <Button size="sm" variant="ghost" onClick={() => setSupplierEditor(supplier)}>Modifier</Button>
              </div>
            ))}
          </div>
      )}

      {tab === 'achats' && (
        purchases.length === 0
          ? <EmptyState icon={<Truck size={24} />} title="Aucune commande fournisseur" description="Commandez des produits ou services, puis réceptionnez-les pour alimenter le stock." action={<Button size="sm" onClick={() => setPurchaseEditor('new')}>Créer</Button>} />
          : <div className="overflow-hidden rounded-xl border border-white/[0.07]">
            {purchases.map((order) => (
              <div key={order.id} className="grid gap-1 border-b border-white/[0.04] px-3 py-2.5 text-[11.5px] last:border-0 hover:bg-white/[0.02] md:grid-cols-[1fr_1.2fr_0.8fr_0.8fr_0.8fr_auto] md:items-center">
                <button type="button" className="text-left font-medium text-white hover:text-violet-200" onClick={() => setPurchaseEditor(order)}>{order.number}</button>
                <span className="truncate text-slate-300">{supplierName(order.supplierId)}</span>
                <span><Badge tone={PURCHASE_STATUSES.find((entry) => entry.value === order.status)?.tone}>{PURCHASE_STATUSES.find((entry) => entry.value === order.status)?.label}</Badge></span>
                <span className="text-slate-400">{order.orderedAt}</span>
                <span className="text-slate-200">{money(computeTotals(order.lines).total)}</span>
                <div className="flex flex-wrap gap-1">
                  {order.status !== 'recu' && order.status !== 'annule' && <Button size="sm" variant="outline" loading={busy === order.id} onClick={() => void receive(order)}>Réceptionner</Button>}
                  {!order.expenseId && order.status !== 'annule' && <Button size="sm" variant="ghost" loading={busy === `expense-${order.id}`} onClick={() => void createExpense(order, false)}>Créer dépense</Button>}
                </div>
              </div>
            ))}
          </div>
      )}

      {tab === 'receptions' && (
        receipts.length === 0
          ? <EmptyState icon={<PackageCheck size={24} />} title="Aucune réception" description="Une réception crée les entrées de stock liées à la commande fournisseur." />
          : <div className="overflow-hidden rounded-xl border border-white/[0.07]">
            {receipts.map((receipt) => (
              <div key={receipt.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.04] px-3 py-2.5 text-[11.5px] last:border-0">
                <span className="text-white">{receipt.receivedAt}</span>
                <span className="text-slate-300">{supplierName(receipt.supplierId)}</span>
                <span className="text-slate-400">{receipt.lines.reduce((sum, line) => sum + line.quantity, 0)} unité(s) · {receipt.lines.length} ligne(s)</span>
                <Badge tone="success">Stock entré</Badge>
              </div>
            ))}
          </div>
      )}

      {supplierEditor && <SupplierForm open initial={supplierEditor === 'new' ? null : supplierEditor} onClose={() => setSupplierEditor(null)} onSubmit={saveSupplier} />}
      {purchaseEditor && (
        <PurchaseForm open suppliers={suppliers} products={products.map((product) => ({ id: product.id, name: product.name, cost: product.cost }))}
          existingNumbers={purchases.map((order) => order.number)} initial={purchaseEditor === 'new' ? null : purchaseEditor}
          onClose={() => setPurchaseEditor(null)} onSubmit={savePurchase} />
      )}
    </div>
  );
}
