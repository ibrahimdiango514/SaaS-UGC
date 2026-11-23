import { useMemo, useRef, useState } from 'react';
import {
  Boxes, Download, Package, Plus, Search, Trash2, Upload,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Modal, Select, Textarea, cn } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { useRecords } from '../records/useRecords';
import {
  CATALOG_CATEGORIES, MOVEMENT_TYPES, PRODUCT_KINDS, STOCK_LEVEL_LABELS, buildProductsFromRows,
  computeCatalogSummary, findProductDuplicate, guessProductMapping, movementFromRecord, movementsToCsv,
  parseCsv, productFromRecord, productsToCsv, stockLevel, stockOf, validateMovement,
  type MovementType, type Product, type ProductKind, type StockMovement,
} from './model';

const uid = () => {
  try { return crypto.randomUUID(); } catch { return `m-${Date.now()}`; }
};

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

function emptyProduct() {
  return {
    name: '', sku: '', category: '', kind: 'produit' as ProductKind, description: '', price: '',
    cost: '', unit: 'unité', active: true, trackStock: true, initialStock: '0', lowStockThreshold: '5',
  };
}

function ProductForm({ open, initial, onClose, onSubmit, onDelete }: {
  open: boolean;
  initial: Product | null;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [form, setForm] = useState(() => initial ? {
    name: initial.name, sku: initial.sku, category: initial.category, kind: initial.kind,
    description: initial.description, price: initial.price ?? '', cost: initial.cost ?? '',
    unit: initial.unit, active: initial.active, trackStock: initial.trackStock,
    initialStock: String(initial.initialStock), lowStockThreshold: String(initial.lowStockThreshold),
  } : emptyProduct());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  const submit = async () => {
    if (!form.name.trim()) { setError('Le nom est obligatoire.'); return; }
    if (form.price !== '' && Number(form.price) < 0) { setError('Le prix ne peut pas être négatif.'); return; }
    setBusy(true); setError('');
    try {
      await onSubmit({
        ...form,
        price: form.price === '' ? null : Number(form.price),
        cost: form.cost === '' ? null : Number(form.cost),
        initialStock: Number(form.initialStock) || 0,
        lowStockThreshold: Number(form.lowStockThreshold) || 0,
        trackStock: form.kind === 'produit' ? form.trackStock : false,
      });
      onClose();
    } catch (cause) { setError(asAppError(cause).message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Modifier le produit' : 'Nouveau produit ou service'} size="lg"
      footer={<>{initial && onDelete && (
        <Button variant="danger" icon={<Trash2 size={13} />} disabled={busy} onClick={() => void onDelete()}>Supprimer</Button>
      )}<span className="flex-1" /><Button variant="ghost" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={() => void submit()}>{initial ? 'Enregistrer' : 'Créer'}</Button></>}>
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Nom" value={form.name} onChange={(event) => set({ name: event.target.value })} />
          <Input label="Référence SKU" value={form.sku} onChange={(event) => set({ sku: event.target.value })} />
          <Input label="Catégorie" value={form.category} onChange={(event) => set({ category: event.target.value })} />
          <Select label="Type" value={form.kind} onChange={(event) => set({ kind: event.target.value as ProductKind })}>
            {PRODUCT_KINDS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </Select>
          <Input label="Prix de vente" type="number" min={0} value={form.price} onChange={(event) => set({ price: event.target.value })} />
          <Input label="Coût d’achat" type="number" min={0} value={form.cost} onChange={(event) => set({ cost: event.target.value })} />
          <Input label="Unité de vente" value={form.unit} onChange={(event) => set({ unit: event.target.value })} />
          <Select label="Actif" value={form.active ? 'oui' : 'non'} onChange={(event) => set({ active: event.target.value === 'oui' })}>
            <option value="oui">Actif</option><option value="non">Inactif</option>
          </Select>
          {form.kind === 'produit' && (
            <>
              <Select label="Gestion du stock" value={form.trackStock ? 'oui' : 'non'} onChange={(event) => set({ trackStock: event.target.value === 'oui' })}>
                <option value="oui">Stock suivi</option><option value="non">Non suivi</option>
              </Select>
              <Input label="Stock initial" type="number" min={0} value={form.initialStock} onChange={(event) => set({ initialStock: event.target.value })} />
              <Input label="Seuil d’alerte" type="number" min={0} value={form.lowStockThreshold} onChange={(event) => set({ lowStockThreshold: event.target.value })} />
            </>
          )}
        </div>
        <Textarea label="Description" value={form.description} onChange={(event) => set({ description: event.target.value })} />
      </div>
    </Modal>
  );
}

function MovementForm({ open, products, movements, initialProductId, onClose, onSubmit }: {
  open: boolean;
  products: Product[];
  movements: StockMovement[];
  initialProductId?: string;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>, dedupeKey: string) => Promise<void>;
}) {
  const tracked = products.filter((product) => product.trackStock);
  const [productId, setProductId] = useState(initialProductId ?? tracked[0]?.id ?? '');
  const [type, setType] = useState<MovementType>('entree');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const product = products.find((entry) => entry.id === productId);
  const stock = product ? stockOf(product, movements) : 0;

  const submit = async () => {
    if (!product) { setError('Sélectionnez un produit suivi.'); return; }
    const qty = Number(quantity);
    const errors = validateMovement(product, { type, quantity: qty }, stock);
    if (errors.length) { setError(errors.join(' ')); return; }
    setBusy(true); setError('');
    try {
      await onSubmit(
        { productId, type, quantity: qty, reason, reference, occurredAt },
        `movement:${productId}:${type}:${occurredAt}:${reference || reason || uid()}`,
      );
      onClose();
    } catch (cause) { setError(asAppError(cause).message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Mouvement de stock"
      description={product ? `Stock actuel : ${stock} ${product.unit}` : 'Sélectionnez un produit suivi.'}
      footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={() => void submit()}>Enregistrer le mouvement</Button></>}>
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{error}</p>}
        {tracked.length === 0 ? <p className="text-sm text-slate-400">Aucun produit ne suit de stock. Activez « Stock suivi » sur un produit physique.</p> : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Produit" value={productId} onChange={(event) => setProductId(event.target.value)}>
              {tracked.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </Select>
            <Select label="Type" value={type} onChange={(event) => setType(event.target.value as MovementType)}>
              {MOVEMENT_TYPES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </Select>
            <Input label="Quantité" type="number" min={type === 'ajustement' ? undefined : 0.01} step="0.01" value={quantity} onChange={(event) => setQuantity(event.target.value)} hint={type === 'sortie' ? 'Sera enregistrée comme une sortie.' : type === 'ajustement' ? 'Une valeur négative retire du stock.' : undefined} />
            <Input label="Date" type="date" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} />
            <Input label="Motif" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Réception, vente, casse…" />
            <Input label="Référence" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Commande, bon de livraison…" />
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function CatalogWorkspace({ workspaceId }: { workspaceId: string | null }) {
  const toast = useToast();
  const productsStore = useRecords(CATALOG_CATEGORIES.products, workspaceId);
  const movementsStore = useRecords(CATALOG_CATEGORIES.movements, workspaceId);
  const products = useMemo(() => productsStore.records.map(productFromRecord), [productsStore.records]);
  const movements = useMemo(() => movementsStore.records.map(movementFromRecord), [movementsStore.records]);
  const summary = useMemo(() => computeCatalogSummary(products, movements), [movements, products]);
  const [tab, setTab] = useState<'produits' | 'mouvements'>('produits');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('tous');
  const [stockFilter, setStockFilter] = useState('tous');
  const [editor, setEditor] = useState<Product | null | 'new'>(null);
  const [movementFor, setMovementFor] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importRows, setImportRows] = useState<string[][] | null>(null);
  const [importMapping, setImportMapping] = useState<Record<number, string>>({});
  const [importBusy, setImportBusy] = useState(false);
  const [importMode, setImportMode] = useState<'ignorer' | 'mettre_a_jour'>('ignorer');
  const [importReport, setImportReport] = useState<{ created: number; updated: number; skipped: number; errors: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = products.filter((product) => {
    if (kindFilter !== 'tous' && product.kind !== kindFilter) return false;
    const stock = stockOf(product, movements);
    const level = stockLevel(product, stock);
    if (stockFilter === 'faible' && level !== 'faible') return false;
    if (stockFilter === 'rupture' && level !== 'rupture') return false;
    if (stockFilter === 'suivi' && !product.trackStock) return false;
    const needle = query.trim().toLowerCase();
    return !needle || [product.name, product.sku, product.category, product.description].join(' ').toLowerCase().includes(needle);
  });

  const saveProduct = async (data: Record<string, unknown>) => {
    if (editor && editor !== 'new') await productsStore.update(editor.id, data);
    else await productsStore.create(data, data.sku ? `sku:${String(data.sku).toLowerCase()}` : null);
    toast.success(editor && editor !== 'new' ? 'Produit mis à jour.' : 'Produit créé.');
  };

  const saveMovement = async (data: Record<string, unknown>, dedupeKey: string) => {
    await movementsStore.create(data, dedupeKey);
    toast.success('Mouvement enregistré ; le stock est recalculé.');
  };

  const deleteProduct = async (product: Product) => {
    if (!window.confirm(`Supprimer « ${product.name} » ? Son historique de mouvements restera visible.`)) return;
    try {
      await productsStore.remove(product.id);
      setEditor(null);
      toast.success('Produit supprimé.');
    } catch (cause) { toast.error(asAppError(cause).message); }
  };

  const readImport = async (file: File) => {
    try {
      const rows = parseCsv(await file.text());
      if (!rows.length) { toast.error('Fichier vide.'); return; }
      setImportRows(rows);
      setImportMapping(guessProductMapping(rows[0]) as Record<number, string>);
      setImportReport(null);
      setImportOpen(true);
    } catch (cause) { toast.error(asAppError(cause).message); }
  };

  const importResults = useMemo(
    () => importRows
      ? buildProductsFromRows(importRows.slice(1), importMapping as Parameters<typeof buildProductsFromRows>[1])
      : [],
    [importRows, importMapping],
  );
  const importDuplicateCount = useMemo(
    () => importResults.filter((result) => result.data && findProductDuplicate(result.data, products)).length,
    [importResults, products],
  );

  const runImport = async () => {
    if (!importRows) return;
    const results = buildProductsFromRows(importRows.slice(1), importMapping as Parameters<typeof buildProductsFromRows>[1]);
    const errors = results.flatMap((result) => result.data ? [] : result.errors.map((error) => `Ligne ${result.row} : ${error}`));
    let created = 0; let updated = 0; let skipped = 0;
    // L'état local sert à détecter les doublons DANS le fichier aussi, pas
    // seulement contre les produits déjà en base.
    const known = products.map((product) => ({ id: product.id, name: product.name, sku: product.sku }));
    setImportBusy(true);
    try {
      for (const result of results) {
        if (!result.data) continue;
        const duplicate = findProductDuplicate(result.data, known);
        if (duplicate) {
          if (importMode === 'ignorer') { skipped += 1; continue; }
          try {
            await productsStore.update(duplicate.id, result.data);
            updated += 1;
            const index = known.findIndex((entry) => entry.id === duplicate.id);
            if (index >= 0) known[index] = { ...known[index], name: String(result.data.name ?? known[index].name), sku: String(result.data.sku ?? known[index].sku) };
          } catch (cause) {
            errors.push(`Ligne ${result.row} : ${asAppError(cause).message}`);
          }
          continue;
        }
        try {
          const recordId = await productsStore.create(result.data, result.data.sku ? `sku:${String(result.data.sku).toLowerCase()}` : null);
          created += 1;
          known.push({ id: recordId, name: String(result.data.name ?? ''), sku: String(result.data.sku ?? '') });
        } catch (cause) {
          errors.push(`Ligne ${result.row} : ${asAppError(cause).message}`);
        }
      }
      setImportReport({ created, updated, skipped, errors });
      toast.success(`${created} créé(s), ${updated} mis à jour, ${skipped} doublon(s) ignoré(s).`);
    } finally { setImportBusy(false); }
  };

  if (productsStore.loading || movementsStore.loading) return <LoadingState label="Chargement du catalogue…" />;
  const loadError = productsStore.error || movementsStore.error;
  if (loadError) return <ErrorState message={loadError} onRetry={() => { void productsStore.reload(); void movementsStore.reload(); }} />;

  return (
    <div className="space-y-4" data-testid="catalog-workspace">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {[
          ['Produits et services', String(summary.totalProducts)],
          ['Actifs', String(summary.activeProducts)],
          ['Services', String(summary.services)],
          ['Stock faible', String(summary.lowStock)],
          ['Ruptures', String(summary.outOfStock)],
          ['Valeur du stock', money(summary.inventoryValue)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
            <p className="text-[9.5px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 font-display text-[17px] font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
          {(['produits', 'mouvements'] as const).map((entry) => (
            <button key={entry} type="button" onClick={() => setTab(entry)} className={cn('rounded-lg px-3 py-1.5 text-[11.5px] font-medium', tab === entry ? 'bg-violet-400/15 text-white' : 'text-slate-400 hover:text-white')}>
              {entry === 'produits' ? 'Catalogue' : 'Mouvements'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" icon={<Download size={13} />} onClick={() => downloadFile('produits.csv', productsToCsv(products, movements))}>Exporter</Button>
          <Button size="sm" variant="outline" icon={<Upload size={13} />} onClick={() => fileRef.current?.click()}>Importer CSV</Button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readImport(file); event.target.value = ''; }} />
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor('new')}>Nouveau produit</Button>
        </div>
      </div>

      {tab === 'produits' ? (
        <>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_150px]">
            <label className="relative block">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input aria-label="Rechercher un produit" className="pl-8" placeholder="Rechercher un produit, un SKU, une catégorie…" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <Select aria-label="Filtrer par type" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
              <option value="tous">Tous les types</option>
              {PRODUCT_KINDS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </Select>
            <Select aria-label="Filtrer par stock" value={stockFilter} onChange={(event) => setStockFilter(event.target.value)}>
              <option value="tous">Tout le stock</option><option value="suivi">Stock suivi</option><option value="faible">Stock faible</option><option value="rupture">Ruptures</option>
            </Select>
          </div>
          {filtered.length === 0 ? (
            <EmptyState icon={<Package size={24} />} title="Aucun produit" description="Créez un produit ou un service, ou importez un catalogue CSV." action={<Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor('new')}>Créer</Button>} />
          ) : (
            <div className="overflow-hidden rounded-xl border border-white/[0.07]">
              <div className="hidden grid-cols-[1.6fr_0.8fr_0.8fr_0.8fr_0.7fr_auto] gap-2 border-b border-white/[0.06] bg-white/[0.03] px-3 py-2 text-[9.5px] uppercase tracking-wide text-slate-500 md:grid">
                <span>Produit</span><span>Type</span><span>Prix</span><span>Stock</span><span>Alerte</span><span />
              </div>
              {filtered.map((product) => {
                const stock = stockOf(product, movements);
                const level = stockLevel(product, stock);
                return (
                  <div key={product.id} className="grid gap-1 border-b border-white/[0.04] px-3 py-2.5 text-[11.5px] last:border-0 hover:bg-white/[0.02] md:grid-cols-[1.6fr_0.8fr_0.8fr_0.8fr_0.7fr_auto] md:items-center">
                    <div className="min-w-0">
                      <button type="button" onClick={() => setEditor(product)} className="truncate text-left font-medium text-white hover:text-violet-200">{product.name}</button>
                      <p className="truncate text-[10px] text-slate-500">{[product.sku, product.category, product.active ? '' : 'inactif'].filter(Boolean).join(' · ') || '—'}</p>
                    </div>
                    <span className="text-slate-400">{PRODUCT_KINDS.find((entry) => entry.value === product.kind)?.label}</span>
                    <span className="text-slate-200">{money(product.price)}</span>
                    <span className="text-slate-300">{product.trackStock ? `${stock} ${product.unit}` : 'Non suivi'}</span>
                    <span><Badge tone={level === 'rupture' || level === 'faible' ? 'danger' : level === 'ok' ? 'success' : 'neutral'}>{STOCK_LEVEL_LABELS[level]}</Badge></span>
                    <div className="flex gap-1">
                      {product.trackStock && <Button size="sm" variant="outline" onClick={() => setMovementFor(product.id)}>Mouvement</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setEditor(product)}>Modifier</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-slate-500">Chaque mouvement est conservé ; le stock est recalculé, jamais saisi directement.</p>
            <Button size="sm" variant="outline" icon={<Download size={13} />} onClick={() => downloadFile('mouvements-stock.csv', movementsToCsv(products, movements))}>Exporter</Button>
          </div>
          {movements.length === 0 ? <EmptyState icon={<Boxes size={24} />} title="Aucun mouvement" description="Enregistrez une réception, une sortie ou un ajustement." action={<Button size="sm" onClick={() => setMovementFor(null)}>Nouveau mouvement</Button>} /> : (
            <div className="overflow-hidden rounded-xl border border-white/[0.07]">
              {movements.slice().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).map((movement) => {
                const product = products.find((entry) => entry.id === movement.productId);
                return (
                  <div key={movement.id} className="grid gap-1 border-b border-white/[0.04] px-3 py-2 text-[11.5px] last:border-0 md:grid-cols-[90px_1.5fr_0.7fr_0.7fr_1fr] md:items-center">
                    <span className="text-slate-500">{movement.occurredAt}</span>
                    <span className="text-white">{product?.name ?? 'Produit supprimé'}</span>
                    <span className="text-slate-400">{MOVEMENT_TYPES.find((entry) => entry.value === movement.type)?.label}</span>
                    <span className={movement.quantity < 0 ? 'text-rose-200' : 'text-emerald-200'}>{movement.quantity > 0 ? '+' : ''}{movement.quantity} {product?.unit}</span>
                    <span className="truncate text-slate-500">{[movement.reason, movement.reference].filter(Boolean).join(' · ') || '—'}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {editor && <ProductForm open initial={editor === 'new' ? null : editor} onClose={() => setEditor(null)} onSubmit={saveProduct} onDelete={editor === 'new' ? undefined : () => deleteProduct(editor)} />}
      {movementFor !== null && <MovementForm open products={products} movements={movements} initialProductId={movementFor || undefined} onClose={() => setMovementFor(null)} onSubmit={saveMovement} />}

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Importer un catalogue CSV" size="lg"
        description="Associez les colonnes, vérifiez l’aperçu, puis importez. Les lignes invalides sont signalées."
        footer={<><Button variant="ghost" onClick={() => setImportOpen(false)}>Fermer</Button><Button loading={importBusy} disabled={!importRows} onClick={() => void runImport()}>Importer les lignes valides</Button></>}>
        {importRows && (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {importRows[0].map((header, index) => (
                <label key={`${header}-${index}`} className="text-[10px] text-slate-400">{header || `Colonne ${index + 1}`}
                  <Select aria-label={`Colonne ${header}`} value={importMapping[index] ?? 'ignore'} onChange={(event) => setImportMapping((current) => ({ ...current, [index]: event.target.value }))}>
                    <option value="ignore">Ignorer</option>
                    {['name', 'sku', 'category', 'kind', 'description', 'price', 'cost', 'unit', 'active', 'trackStock', 'initialStock', 'lowStockThreshold'].map((field) => <option key={field} value={field}>{field}</option>)}
                  </Select>
                </label>
              ))}
            </div>
            <Select label="Doublons (même SKU ou même nom)" value={importMode} onChange={(event) => setImportMode(event.target.value as typeof importMode)}>
              <option value="ignorer">Ignorer les lignes en doublon</option>
              <option value="mettre_a_jour">Mettre à jour le produit existant</option>
            </Select>
            <p className="text-[10px] text-slate-400">
              {importResults.filter((result) => result.data).length} ligne(s) valide(s) · {importDuplicateCount} doublon(s) détecté(s) · {importResults.filter((result) => !result.data).length} ligne(s) en erreur
            </p>
            <div className="max-h-56 overflow-auto rounded-lg border border-white/[0.06]">
              <table className="w-full text-left text-[10.5px]">
                <thead className="bg-white/[0.03] text-slate-500"><tr>{importRows[0].map((header, index) => <th key={index} className="px-2 py-1">{header}</th>)}</tr></thead>
                <tbody>{importRows.slice(1, 6).map((row, index) => <tr key={index} className="border-t border-white/[0.04]">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-2 py-1 text-slate-300">{cell}</td>)}</tr>)}</tbody>
              </table>
            </div>
            {importReport && (
              <div className="rounded-lg border border-white/[0.07] p-3 text-[11px]">
                <p className="font-medium text-white">{importReport.created} créé(s) · {importReport.updated} mis à jour · {importReport.skipped} doublon(s) ignoré(s)</p>
                {importReport.errors.length > 0 && <ul className="mt-1 list-inside list-disc text-rose-200">{importReport.errors.slice(0, 12).map((error) => <li key={error}>{error}</li>)}</ul>}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
