import { useMemo, useState } from 'react';
import {
  Check, Download, Globe, Plus, Share2, ShoppingBag, UserPlus,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Modal, Select, Textarea, cn } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { CRM_CATEGORIES, useRecords } from '../records/useRecords';
import { contactFromRecord } from '../crm/model';
import { CATALOG_CATEGORIES, productFromRecord } from '../catalog/model';
import { SALES_CATEGORIES, nextNumber, orderFromRecord } from '../sales/model';
import {
  STOREFRONT_CATEGORIES, STOREFRONT_REQUEST_STATUSES, catalogHtml, computeStorefrontSummary,
  findDuplicateContact, requestFromRecord, requestToContactData, requestToData, requestToOrderLines,
  settingsFromRecord, settingsToData, slugify, toggleVisibleSelection, visibleProducts,
  type StorefrontRequest, type StorefrontSettings,
} from './model';

const money = (value: number | null) => value === null
  ? '—'
  : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'XOF', maximumFractionDigits: 0 }).format(value);

function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  URL.revokeObjectURL(url);
}

export default function StorefrontWorkspace({ workspaceId, workspaceName, onOpenContact }: {
  workspaceId: string | null;
  workspaceName: string;
  onOpenContact: (id: string) => void;
}) {
  const toast = useToast();
  const settingsStore = useRecords(STOREFRONT_CATEGORIES.settings, workspaceId);
  const requestsStore = useRecords(STOREFRONT_CATEGORIES.requests, workspaceId);
  const productsStore = useRecords(CATALOG_CATEGORIES.products, workspaceId);
  const contactsStore = useRecords(CRM_CATEGORIES.contacts, workspaceId);
  const ordersStore = useRecords(SALES_CATEGORIES.orders, workspaceId);
  const settings = useMemo(() => settingsStore.records.map(settingsFromRecord)[0] ?? null, [settingsStore.records]);
  const requests = useMemo(() => requestsStore.records.map(requestFromRecord), [requestsStore.records]);
  const products = useMemo(() => productsStore.records.map(productFromRecord), [productsStore.records]);
  const contacts = useMemo(() => contactsStore.records.map(contactFromRecord), [contactsStore.records]);
  const orders = useMemo(() => ordersStore.records.map(orderFromRecord), [ordersStore.records]);
  const summary = useMemo(() => computeStorefrontSummary(products, settings, requests), [products, requests, settings]);

  const [tab, setTab] = useState<'vitrine' | 'demandes'>('vitrine');
  const [editor, setEditor] = useState<'settings' | 'request' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const draft = settings ?? {
    id: '', slug: slugify(workspaceName) || 'ma-boutique', headline: `${workspaceName} — notre catalogue`,
    description: 'Découvrez nos produits et services. Contactez-nous pour commander.',
    contactEmail: '', contactPhone: '', visibleProductIds: [], published: false, updatedAt: '',
  } as StorefrontSettings;

  const saveSettings = async (data: Record<string, unknown>) => {
    if (settings) await settingsStore.update(settings.id, data);
    else await settingsStore.create(data, 'storefront:settings');
    toast.success('Vitrine enregistrée.');
  };

  const toggleProduct = async (productId: string) => {
    if (busy) return;
    setBusy(productId);
    try {
      const ids = toggleVisibleSelection(products, draft, productId);
      await saveSettings({ ...settingsToData(draft), visibleProductIds: ids });
    } catch (cause) { toast.error(asAppError(cause).message); } finally { setBusy(null); }
  };

  const convertRequest = async (request: StorefrontRequest) => {
    setBusy(request.id);
    try {
      if (request.contactId) { toast.info('Cette demande est déjà reliée à un contact.'); return; }
      const result = requestToContactData(request, contacts);
      if (result.duplicate) {
        const existing = findDuplicateContact(request, contacts);
        if (!existing) throw new Error('Un doublon a été détecté mais le contact correspondant est introuvable. Rechargez la page avant de réessayer.');
        await requestsStore.update(request.id, { ...requestToData(request), status: 'converti', contactId: existing.id });
        toast.info('Contact existant retrouvé : aucun doublon créé.');
        return;
      }
      const contactId = await contactsStore.create(result.data as Record<string, unknown>, `storefront:${request.id}`);
      await requestsStore.update(request.id, { ...requestToData(request), status: 'converti', contactId });
      toast.success('Prospect créé dans le CRM.');
    } catch (cause) { toast.error(asAppError(cause).message); } finally { setBusy(null); }
  };

  const createOrder = async (request: StorefrontRequest) => {
    if (!request.contactId) { toast.error('Convertissez d’abord la demande en prospect CRM.'); return; }
    setBusy(`order-${request.id}`);
    try {
      if (request.orderId) { toast.info('Une commande est déjà liée à cette demande.'); return; }
      const number = nextNumber('commande', orders.map((order) => order.number));
      const orderId = await ordersStore.create({
        number, contactId: request.contactId, quoteId: '', status: 'brouillon',
        orderedAt: request.requestedAt, expectedAt: '', notes: `Demande boutique ${request.id}\n${request.message}`,
        currency: 'XOF', lines: requestToOrderLines(request), invoiceId: '',
      }, `storefront:${request.id}`);
      await requestsStore.update(request.id, { ...requestToData(request), status: 'traite', orderId });
      toast.success(`Commande ${number} créée dans Ventes.`);
    } catch (cause) { toast.error(asAppError(cause).message); } finally { setBusy(null); }
  };

  const loading = settingsStore.loading || requestsStore.loading || productsStore.loading;
  const loadError = settingsStore.error || requestsStore.error;
  if (loading) return <LoadingState label="Chargement de la vitrine…" />;
  if (loadError) return <ErrorState message={loadError} onRetry={() => void settingsStore.reload()} />;

  const visible = visibleProducts(products, draft);

  return (
    <div className="space-y-4" data-testid="storefront-workspace">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {[
          ['Produits visibles', String(summary.visibleProducts)],
          ['Demandes', String(summary.requests)],
          ['Nouvelles', String(summary.newRequests)],
          ['Converties', String(summary.convertedRequests)],
          ['Valeur potentielle', money(summary.potentialValue)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
            <p className="text-[9.5px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 font-display text-[16px] font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-violet-300/15 bg-violet-400/[0.04] p-3">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-100"><Globe size={13} /> Catalogue partageable, sans paiement en ligne</p>
        <p className="mt-1 text-[10.5px] text-violet-100/70">Exportez un catalogue HTML autonome ou préparez un lien. Aucune URL publique ni commande en ligne n’est simulée : les demandes se saisissent ici et se convertissent explicitement en prospect ou commande.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
          {(['vitrine', 'demandes'] as const).map((entry) => (
            <button key={entry} type="button" onClick={() => setTab(entry)} className={cn('rounded-lg px-3 py-1.5 text-[11px] font-medium', tab === entry ? 'bg-violet-400/15 text-white' : 'text-slate-400 hover:text-white')}>
              {entry === 'vitrine' ? 'Catalogue' : `Demandes (${summary.newRequests})`}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" icon={<Download size={13} />} onClick={() => downloadFile(`catalogue-${draft.slug}.html`, catalogHtml(draft, visible, workspaceName), 'text/html')}>Exporter le catalogue</Button>
          <Button size="sm" variant="outline" icon={<Share2 size={13} />} onClick={() => {
            void navigator.clipboard?.writeText(`${window.location.origin}/boutique/${draft.slug}`);
            toast.info('Lien préparé. Aucune page publique n’est encore servie sans backend dédié.');
          }}>Copier le lien</Button>
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor(tab === 'vitrine' ? 'settings' : 'request')}>{tab === 'vitrine' ? 'Configurer' : 'Nouvelle demande'}</Button>
        </div>
      </div>

      {tab === 'vitrine' ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-display text-lg font-semibold text-white">{draft.headline}</p>
                <p className="mt-1 max-w-lg text-[11px] text-slate-400">{draft.description}</p>
              </div>
              <Badge tone={draft.published ? 'success' : 'neutral'}>{draft.published ? 'Configurée' : 'Brouillon'}</Badge>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {products.filter((product) => product.active).map((product) => {
                const shown = draft.visibleProductIds.length === 0 || draft.visibleProductIds.includes(product.id);
                return (
                  <button key={product.id} type="button" onClick={() => void toggleProduct(product.id)} disabled={busy === product.id}
                    className={cn('rounded-xl border p-3 text-left transition', shown ? 'border-violet-300/25 bg-violet-400/[0.06]' : 'border-white/[0.06] bg-white/[0.01] opacity-60')}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[11.5px] font-medium text-white">{product.name}</span>
                      {shown && <Check size={13} className="shrink-0 text-violet-200" />}
                    </div>
                    <p className="mt-1 text-[10px] text-slate-500">{product.category || 'Sans catégorie'} · {money(product.price)}{product.kind === 'service' ? ' · service' : ''}</p>
                  </button>
                );
              })}
            </div>
            {products.length === 0 && <p className="mt-4 text-[11px] text-slate-500">Créez d’abord des produits dans le module Produits et stock.</p>}
          </div>

          <div className="rounded-2xl border border-white/[0.07] bg-[#faf8f5] p-4 text-[#161616]">
            <p className="text-[10px] uppercase tracking-widest text-[#7c3aed]">Aperçu client</p>
            <h2 className="mt-1 font-display text-xl font-semibold">{draft.headline}</h2>
            <p className="mt-1 text-[11px] text-[#555]">{draft.description}</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {visible.slice(0, 6).map((product) => (
                <div key={product.id} className="rounded-xl border border-[#e8e2d8] bg-white p-2.5">
                  <p className="text-[11px] font-semibold">{product.name}</p>
                  <p className="mt-0.5 line-clamp-2 text-[9.5px] text-[#777]">{product.description || '—'}</p>
                  <p className="mt-1 text-[10px] font-bold text-[#7c3aed]">{money(product.price)}</p>
                </div>
              ))}
              {visible.length === 0 && <p className="col-span-2 text-[11px] text-[#777]">Aucun produit visible.</p>}
            </div>
            <p className="mt-4 text-[9px] text-[#888]">{workspaceName} · {draft.contactPhone || 'Téléphone à renseigner'} · Catalogue informatif</p>
          </div>
        </div>
      ) : requests.length === 0 ? (
        <EmptyState icon={<ShoppingBag size={24} />} title="Aucune demande" description="Les demandes reçues (ou saisies) peuvent devenir un prospect CRM, puis une commande Ventes." action={<Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor('request')}>Saisir une demande</Button>} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/[0.07]">
          {requests.slice().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).map((request) => (
            <div key={request.id} className="grid gap-2 border-b border-white/[0.04] px-3 py-3 text-[11.5px] last:border-0 md:grid-cols-[1.2fr_1fr_0.8fr_0.8fr_auto] md:items-center">
              <div className="min-w-0">
                <p className="truncate font-medium text-white">{request.customerName}</p>
                <p className="truncate text-[10px] text-slate-500">{[request.phone, request.email].filter(Boolean).join(' · ') || 'Sans coordonnées'}</p>
              </div>
              <span className="truncate text-slate-300">{request.lines.map((line) => `${line.quantity} × ${line.name}`).join(', ') || 'Demande générale'}</span>
              <span className="text-slate-400">{request.requestedAt}</span>
              <Badge tone={request.status === 'converti' ? 'success' : request.status === 'nouveau' ? 'warning' : 'neutral'}>{STOREFRONT_REQUEST_STATUSES.find((entry) => entry.value === request.status)?.label}</Badge>
              <div className="flex flex-wrap gap-1">
                {!request.contactId && <Button size="sm" variant="outline" icon={<UserPlus size={12} />} loading={busy === request.id} onClick={() => void convertRequest(request)}>Prospect</Button>}
                {request.contactId && <Button size="sm" variant="ghost" onClick={() => onOpenContact(request.contactId)}>Fiche CRM</Button>}
                {request.contactId && !request.orderId && <Button size="sm" variant="outline" icon={<ShoppingBag size={12} />} loading={busy === `order-${request.id}`} onClick={() => void createOrder(request)}>Commande</Button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {editor === 'settings' && <SettingsForm open initial={settings} fallback={draft} onClose={() => setEditor(null)} onSubmit={saveSettings} />}
      {editor === 'request' && <RequestForm open products={products.map((product) => ({ id: product.id, name: product.name, price: product.price }))} onClose={() => setEditor(null)} onSubmit={async (data) => {
        await requestsStore.create(data, null);
        toast.success('Demande enregistrée.');
      }} />}
    </div>
  );
}

function SettingsForm({ open, initial, fallback, onClose, onSubmit }: {
  open: boolean;
  initial: StorefrontSettings | null;
  fallback: StorefrontSettings;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}) {
  const base = initial ?? fallback;
  const [form, setForm] = useState({
    slug: base.slug, headline: base.headline, description: base.description,
    contactEmail: base.contactEmail, contactPhone: base.contactPhone,
    published: base.published, visibleProductIds: base.visibleProductIds,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const submit = async () => {
    if (!form.headline.trim()) { setError('Le titre est obligatoire.'); return; }
    setBusy(true); setError('');
    try { await onSubmit({ ...form, slug: slugify(form.slug) || 'ma-boutique' }); onClose(); }
    catch (cause) { setError(asAppError(cause).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Configurer la vitrine" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={() => void submit()}>Enregistrer</Button></>}>
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Titre" value={form.headline} onChange={(event) => set({ headline: event.target.value })} />
          <Input label="Adresse courte" value={form.slug} onChange={(event) => set({ slug: event.target.value })} hint="Utilisée dans le lien partagé." />
          <Input label="Téléphone public" value={form.contactPhone} onChange={(event) => set({ contactPhone: event.target.value })} />
          <Input label="E-mail public" type="email" value={form.contactEmail} onChange={(event) => set({ contactEmail: event.target.value })} />
        </div>
        <Textarea label="Description" value={form.description} onChange={(event) => set({ description: event.target.value })} />
        <label className="flex items-center gap-2 text-[11px] text-slate-300"><input type="checkbox" checked={form.published} onChange={(event) => set({ published: event.target.checked })} /> Catalogue configuré et prêt à être partagé</label>
      </div>
    </Modal>
  );
}

function RequestForm({ open, products, onClose, onSubmit }: {
  open: boolean;
  products: Array<{ id: string; name: string; price: number | null }>;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (!name.trim() || (!phone.trim() && !email.trim())) { setError('Indiquez un nom et au moins un téléphone ou un e-mail.'); return; }
    const product = products.find((entry) => entry.id === productId);
    setBusy(true); setError('');
    try {
      await onSubmit({
        customerName: name, phone, email, message, status: 'nouveau', requestedAt: new Date().toISOString().slice(0, 10),
        lines: product ? [{ productId: product.id, name: product.name, quantity: Number(quantity) || 1, unitPrice: product.price }] : [],
      });
      onClose();
    } catch (cause) { setError(asAppError(cause).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Saisir une demande boutique"
      footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={() => void submit()}>Enregistrer la demande</Button></>}>
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{error}</p>}
        <Input label="Nom du client" value={name} onChange={(event) => setName(event.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Téléphone" value={phone} onChange={(event) => setPhone(event.target.value)} />
          <Input label="E-mail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_100px]">
          <Select label="Produit demandé" value={productId} onChange={(event) => setProductId(event.target.value)}>
            <option value="">Demande générale</option>
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </Select>
          <Input label="Quantité" type="number" min={1} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </div>
        <Textarea label="Message" value={message} onChange={(event) => setMessage(event.target.value)} />
      </div>
    </Modal>
  );
}
