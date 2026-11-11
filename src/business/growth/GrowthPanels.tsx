import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowUpRight, Building2, Check, Download, ExternalLink, FileText, Lightbulb, Package,
  Pencil, Plus, RefreshCw, Search, Target, Trash2, TrendingUp, Upload, Users, X, Link2,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Modal, Select, Textarea, cn } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { createProduct, deleteProduct, listProducts, updateProduct } from '../../lib/api';
import type { Product, Workspace } from '../../lib/types';
import {
  EMPTY_COMPANY_PROFILE, GROWTH_CATEGORY, PROSPECT_STAGES, formatGrowthAmount, goalProgress,
  isGoalOverdue, parseCatalogImport, pipelineSummary, type CompanyProfile, type GrowthCompetitor,
  type GrowthGoal, type GrowthProspect, type GrowthSignal, type GrowthStrategy, type ProspectStage,
} from './model';

export interface GrowthMutation {
  (category: string, content: unknown, itemId?: string | null): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Entreprise                                                                  */
/* -------------------------------------------------------------------------- */

export function CompanyPanel({
  profile, workspace, busy, consent, onSave, onConsent,
}: {
  profile: CompanyProfile;
  workspace: Workspace | null;
  busy: boolean;
  consent: boolean;
  onSave: (patch: Partial<CompanyProfile>) => Promise<void>;
  onConsent: (enabled: boolean) => Promise<void>;
}) {
  const [form, setForm] = useState<CompanyProfile>({ ...EMPTY_COMPANY_PROFILE, ...profile });
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!touched) setForm({ ...EMPTY_COMPANY_PROFILE, ...profile });
  }, [profile, touched]);

  const patch = (key: keyof CompanyProfile, value: string) => {
    setTouched(true);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.activity.trim()) {
      toast.warning('Renseignez au moins l’activité principale de l’entreprise.');
      return;
    }
    setSaving(true);
    try {
      await onSave(form);
      setTouched(false);
    } finally {
      setSaving(false);
    }
  };

  const fields: Array<{ key: keyof CompanyProfile; label: string; placeholder: string; hint?: string }> = [
    { key: 'legalName', label: 'Nom de l’entreprise', placeholder: 'Ex. Maison Nala' },
    { key: 'activity', label: 'Activité principale', placeholder: 'Ex. cosmétiques naturels' },
    { key: 'market', label: 'Marché / zone', placeholder: 'Ex. Bamako, Mali · Afrique de l’Ouest' },
    { key: 'audience', label: 'Clientèle cible', placeholder: 'Ex. femmes 20-35 ans, sensibles au naturel' },
    { key: 'positioning', label: 'Positionnement', placeholder: 'Ce qui vous différencie réellement' },
    { key: 'country', label: 'Pays', placeholder: 'Ex. ML' },
    { key: 'website', label: 'Site web', placeholder: 'https://…' },
    { key: 'storeUrl', label: 'Boutique en ligne', placeholder: 'https://… (Shopify, WooCommerce…)' },
    { key: 'instagram', label: 'Instagram', placeholder: '@compte' },
    { key: 'facebook', label: 'Facebook', placeholder: 'Page Facebook' },
    { key: 'tiktok', label: 'TikTok', placeholder: '@compte' },
    { key: 'youtube', label: 'YouTube', placeholder: 'Chaîne YouTube' },
    { key: 'whatsapp', label: 'WhatsApp Business', placeholder: '+223…' },
  ];

  return (
    <div className="space-y-4" data-testid="growth-company">
      <section className="vyora-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Contexte entreprise</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-white">{workspace?.name ?? 'Votre entreprise'}</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400">
              Ces informations alimentent la mémoire métier utilisée par l’IA. Elles restent privées et isolées à votre compte.
            </p>
          </div>
          {!consent && (
            <Button size="sm" variant="outline" icon={<Check size={13} />} onClick={() => void onConsent(true)} disabled={busy}>
              Activer la mémoire métier
            </Button>
          )}
        </div>

        <form onSubmit={submit} className="mt-5 grid gap-3 sm:grid-cols-2">
          {fields.map((field) => (
            <Input
              key={field.key}
              label={field.label}
              value={form[field.key]}
              placeholder={field.placeholder}
              hint={field.hint}
              onChange={(event) => patch(field.key, event.target.value)}
              disabled={!consent}
            />
          ))}
          <div className="sm:col-span-2">
            <Textarea
              label="Description de l’entreprise"
              rows={4}
              value={form.description}
              placeholder="Offre, histoire, preuves disponibles, canaux de vente, contraintes connues…"
              onChange={(event) => patch('description', event.target.value)}
              disabled={!consent}
            />
          </div>
          <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] text-slate-500">
              {consent
                ? 'Enregistrement réel dans votre mémoire métier VYORA.'
                : 'Activez la mémoire métier pour enregistrer ces informations.'}
            </p>
            <Button type="submit" variant="primary" loading={saving} disabled={!consent || busy} icon={<Check size={14} />}>
              Enregistrer l’entreprise
            </Button>
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-white"><Search size={13} className="text-cyan-300" /> Ce que VYORA ne fait pas encore</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
          L’import automatique de boutique (Shopify / WooCommerce) et la lecture des réseaux sociaux nécessitent une autorisation OAuth que vous devez accorder.
          Tant que ces connexions ne sont pas actives, aucun contenu ni aucune statistique externe n’est récupéré. Vous pouvez saisir les données manuellement dans les onglets Catalogue, Marché et Prospects.
        </p>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Objectifs                                                                   */
/* -------------------------------------------------------------------------- */

interface GoalForm {
  title: string; metric: string; target: string; current: string; unit: string; dueDate: string; priority: GrowthGoal['priority'];
}

const EMPTY_GOAL: GoalForm = { title: '', metric: '', target: '', current: '0', unit: '', dueDate: '', priority: 'moyenne' };

export function GoalsPanel({
  goals, busy, onPut, onDelete,
}: {
  goals: GrowthGoal[];
  busy: boolean;
  onPut: GrowthMutation;
  onDelete: (id: string) => Promise<void>;
}) {
  const toast = useToast();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<GrowthGoal | null>(null);
  const [form, setForm] = useState<GoalForm>(EMPTY_GOAL);
  const [saving, setSaving] = useState(false);
  const [progressFor, setProgressFor] = useState<string | null>(null);
  const [progressValue, setProgressValue] = useState('');

  const open = (goal?: GrowthGoal) => {
    setEditing(goal ?? null);
    setForm(goal ? {
      title: goal.title, metric: goal.metric, target: String(goal.target), current: String(goal.current),
      unit: goal.unit, dueDate: goal.dueDate, priority: goal.priority,
    } : EMPTY_GOAL);
    setModal(true);
  };

  const save = async () => {
    if (!form.title.trim()) { toast.warning('Le titre de l’objectif est obligatoire.'); return; }
    const target = Number(form.target);
    const current = Number(form.current);
    if (!Number.isFinite(target) || target <= 0) { toast.warning('La cible doit être un nombre supérieur à zéro.'); return; }
    setSaving(true);
    try {
      await onPut(GROWTH_CATEGORY.goal, {
        title: form.title.trim(), metric: form.metric.trim(), target,
        current: Number.isFinite(current) ? current : 0,
        unit: form.unit.trim(), dueDate: form.dueDate, priority: form.priority,
        status: editing?.status ?? 'en_cours',
      }, editing?.id ?? null);
      toast.success(editing ? 'Objectif mis à jour.' : 'Objectif enregistré.');
      setModal(false);
    } catch (error) {
      toast.error(asAppError(error).message);
    } finally {
      setSaving(false);
    }
  };

  const setProgress = async (goal: GrowthGoal) => {
    const value = Number(progressValue);
    if (!Number.isFinite(value)) { toast.warning('Valeur de progression invalide.'); return; }
    try {
      await onPut(GROWTH_CATEGORY.goal, {
        title: goal.title, metric: goal.metric, target: goal.target, current: value,
        unit: goal.unit, dueDate: goal.dueDate, priority: goal.priority,
        status: value >= goal.target ? 'atteint' : goal.status === 'atteint' ? 'en_cours' : goal.status,
      }, goal.id);
      toast.success('Progression enregistrée.');
      setProgressFor(null);
      setProgressValue('');
    } catch (error) {
      toast.error(asAppError(error).message);
    }
  };

  return (
    <div className="space-y-4" data-testid="growth-goals">
      <section className="vyora-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Objectifs commerciaux</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-white">Ce que vous voulez atteindre</h2>
            <p className="mt-1 text-xs text-slate-400">Suivez une cible mesurable, sa progression et son échéance.</p>
          </div>
          <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => open()} disabled={busy}>Nouvel objectif</Button>
        </div>
      </section>

      {goals.length === 0 ? (
        <EmptyState icon={<Target size={22} />} title="Aucun objectif enregistré" description="Ajoutez un objectif mesurable (ventes, prospects, panier moyen, abonnés…)." action={<Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => open()}>Créer un objectif</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {goals.map((goal) => {
            const progress = goalProgress(goal);
            const overdue = isGoalOverdue(goal);
            return (
              <article key={goal.id} className="vyora-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{goal.title}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{goal.metric || 'Indicateur non précisé'}{goal.dueDate ? ` · échéance ${goal.dueDate}` : ''}</p>
                  </div>
                  <Badge tone={goal.status === 'atteint' ? 'success' : overdue ? 'danger' : 'info'}>
                    {goal.status === 'atteint' ? 'Atteint' : overdue ? 'En retard' : goal.priority}
                  </Badge>
                </div>
                <div className="mt-3 flex items-end justify-between gap-2">
                  <p className="text-2xl font-semibold text-white">{goal.current}{goal.unit ? ` ${goal.unit}` : ''}<span className="ml-1 text-xs font-normal text-slate-500">/ {goal.target}{goal.unit ? ` ${goal.unit}` : ''}</span></p>
                  <span className="text-xs font-semibold text-cyan-200">{progress}%</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className={cn('h-full rounded-full transition-all duration-700', progress >= 100 ? 'bg-emerald-400' : 'bg-gradient-to-r from-cyan-400 to-violet-400')} style={{ width: `${Math.max(2, progress)}%` }} />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <Button size="sm" variant="ghost" icon={<TrendingUp size={12} />} onClick={() => { setProgressFor(goal.id); setProgressValue(String(goal.current)); }}>Mettre à jour</Button>
                  <Button size="sm" variant="ghost" icon={<Pencil size={12} />} onClick={() => open(goal)}>Modifier</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => { if (window.confirm(`Supprimer l’objectif « ${goal.title} » ?`)) void onDelete(goal.id).then(() => toast.success('Objectif supprimé.')).catch((error) => toast.error(asAppError(error).message)); }}>Supprimer</Button>
                </div>
                {progressFor === goal.id && (
                  <div className="mt-2 flex items-end gap-2 rounded-xl border border-white/[0.08] bg-black/20 p-2">
                    <Input label="Valeur actuelle" type="number" value={progressValue} onChange={(event) => setProgressValue(event.target.value)} className="text-xs" />
                    <Button size="sm" variant="primary" onClick={() => void setProgress(goal)}>OK</Button>
                    <Button size="sm" variant="ghost" onClick={() => setProgressFor(null)}><X size={12} /></Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? 'Modifier l’objectif' : 'Nouvel objectif'} size="md"
        description="Un objectif doit être mesurable et daté pour être suivi réellement."
        footer={<><Button variant="ghost" onClick={() => setModal(false)}>Annuler</Button><Button variant="primary" loading={saving} onClick={() => void save()}>{editing ? 'Enregistrer' : 'Créer'}</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Titre" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Ex. Atteindre 50 000 FCFA de ventes" />
          <Input label="Indicateur" value={form.metric} onChange={(event) => setForm({ ...form, metric: event.target.value })} placeholder="Ex. chiffre d’affaires" />
          <Input label="Cible" type="number" min={1} value={form.target} onChange={(event) => setForm({ ...form, target: event.target.value })} />
          <Input label="Valeur actuelle" type="number" value={form.current} onChange={(event) => setForm({ ...form, current: event.target.value })} />
          <Input label="Unité" value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} placeholder="FCFA, clients, %…" />
          <Input label="Échéance" type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} />
          <Select label="Priorité" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as GrowthGoal['priority'] })}>
            <option value="haute">Haute</option><option value="moyenne">Moyenne</option><option value="basse">Basse</option>
          </Select>
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Catalogue produits                                                          */
/* -------------------------------------------------------------------------- */

interface ProductForm {
  name: string; description: string; price: string; currency: string; url: string; benefits: string;
}

const EMPTY_PRODUCT: ProductForm = { name: '', description: '', price: '', currency: 'XOF', url: '', benefits: '' };

export function CatalogPanel({ workspaceId }: { workspaceId: string | null }) {
  const toast = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductForm>(EMPTY_PRODUCT);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);

  const load = async () => {
    if (!workspaceId) { setProducts([]); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      setProducts(await listProducts(workspaceId));
    } catch (loadError) {
      setError(asAppError(loadError).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [workspaceId]);

  const openForm = (product?: Product) => {
    setEditing(product ?? null);
    setForm(product ? {
      name: product.name,
      description: product.description ?? '',
      price: product.price_amount === null || product.price_amount === undefined ? '' : String(product.price_amount),
      currency: product.price_currency ?? 'XOF',
      url: product.product_url ?? '',
      benefits: (product.key_benefits ?? []).join('; '),
    } : EMPTY_PRODUCT);
    setModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) { toast.warning('Le nom du produit est obligatoire.'); return; }
    if (!workspaceId) { toast.error('Aucun espace de travail actif.'); return; }
    const price = form.price.trim() === '' ? null : Number(form.price);
    if (price !== null && !Number.isFinite(price)) { toast.warning('Prix invalide.'); return; }
    setSaving(true);
    try {
      const benefits = form.benefits.split(/[;|]/).map((value) => value.trim()).filter(Boolean);
      if (editing) {
        await updateProduct(editing.id, {
          name: form.name.trim(), description: form.description.trim() || null,
          price_amount: price, price_currency: form.currency.toUpperCase(),
          product_url: form.url.trim() || null, key_benefits: benefits,
        });
        toast.success('Produit mis à jour.');
      } else {
        await createProduct({
          workspace_id: workspaceId, name: form.name.trim(),
          description: form.description.trim() || null,
          price_amount: price, price_currency: form.currency.toUpperCase(),
          product_url: form.url.trim() || null, key_benefits: benefits,
        });
        toast.success('Produit ajouté au catalogue.');
      }
      setModal(false);
      await load();
    } catch (saveError) {
      toast.error(asAppError(saveError).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (product: Product) => {
    if (!window.confirm(`Supprimer « ${product.name} » du catalogue ?`)) return;
    try {
      await deleteProduct(product.id);
      toast.success('Produit supprimé.');
      await load();
    } catch (removeError) {
      toast.error(asAppError(removeError).message);
    }
  };

  const importCatalog = async () => {
    const parsed = parseCatalogImport(importText);
    if (!parsed.ok) {
      toast.error(parsed.errors[0] ?? 'Import impossible.');
      return;
    }
    if (!workspaceId) { toast.error('Aucun espace de travail actif.'); return; }
    setImporting(true);
    let created = 0;
    const failures: string[] = [];
    for (const product of parsed.products) {
      try {
        await createProduct({
          workspace_id: workspaceId, name: product.name,
          description: product.description || null,
          price_amount: product.priceAmount,
          price_currency: product.priceCurrency,
          product_url: product.productUrl || null,
          key_benefits: product.benefits,
        });
        created += 1;
      } catch (error) {
        failures.push(`${product.name} : ${asAppError(error).message}`);
      }
    }
    setImporting(false);
    await load();
    if (created > 0) toast.success(`${created} produit(s) importé(s).`);
    if (failures.length > 0) toast.error(`${failures.length} produit(s) non importé(s). ${failures[0]}`);
    if (created > 0 && failures.length === 0) { setImportOpen(false); setImportText(''); }
  };

  const totalValue = products.reduce((sum, product) => {
    const amount = Number(product.price_amount ?? 0);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);

  return (
    <div className="space-y-4" data-testid="growth-catalog">
      <section className="vyora-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Catalogue</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-white">Vos produits et offres</h2>
            <p className="mt-1 text-xs text-slate-400">{products.length} produit(s) · valeur cumulée affichée {formatGrowthAmount(totalValue, products[0]?.price_currency ?? 'XOF')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void load()} disabled={loading}>Actualiser</Button>
            <Button size="sm" variant="outline" icon={<Upload size={13} />} onClick={() => setImportOpen((value) => !value)}>Importer</Button>
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => openForm()} disabled={!workspaceId}>Ajouter</Button>
          </div>
        </div>
        {importOpen && (
          <div className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-400/[0.04] p-3">
            <p className="text-[11px] font-semibold text-cyan-100">Import catalogue (JSON ou CSV)</p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
              Collez un tableau JSON (<code className="text-cyan-200">[{'{'}&quot;name&quot;:&quot;…&quot;,&quot;price&quot;:1500{'}'}]</code>) ou un CSV avec l’en-tête
              <code className="text-cyan-200"> name,price,currency,description,url,benefits</code>. Aucun produit incomplet n’est créé.
            </p>
            <textarea
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              rows={5}
              className="studio-input mt-2 font-mono text-[11px]"
              placeholder={'name,price,currency,description,url,benefits\nSérum éclat,12000,XOF,Sérum vitamine C,https://…,hydratation;éclat'}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" loading={importing} onClick={() => void importCatalog()} icon={<Download size={12} />}>Importer les produits</Button>
              <Button size="sm" variant="ghost" onClick={() => { setImportOpen(false); setImportText(''); }}>Fermer</Button>
            </div>
          </div>
        )}
      </section>

      {loading ? <LoadingState label="Chargement du catalogue…" /> : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : products.length === 0 ? (
        <EmptyState icon={<Package size={22} />} title="Catalogue vide" description="Ajoutez vos produits ou importez votre catalogue pour que l’IA comprenne votre offre."
          action={<Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => openForm()}>Ajouter un produit</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {products.map((product) => (
            <article key={product.id} className="vyora-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{product.name}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {product.price_amount !== null && product.price_amount !== undefined
                      ? formatGrowthAmount(Number(product.price_amount), product.price_currency ?? 'XOF')
                      : 'Prix non renseigné'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" aria-label={`Modifier ${product.name}`} onClick={() => openForm(product)}><Pencil size={12} /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Supprimer ${product.name}`} onClick={() => void remove(product)}><Trash2 size={12} /></Button>
                </div>
              </div>
              {product.description && <p className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-slate-400">{product.description}</p>}
              {(product.key_benefits ?? []).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {(product.key_benefits ?? []).slice(0, 5).map((benefit) => <span key={benefit} className="vyora-badge-soft">{benefit}</span>)}
                </div>
              )}
              {product.product_url && (
                <a href={product.product_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[10px] text-cyan-200 hover:text-cyan-100">
                  <ExternalLink size={10} /> Voir la fiche produit
                </a>
              )}
            </article>
          ))}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? 'Modifier le produit' : 'Nouveau produit'} size="md"
        footer={<><Button variant="ghost" onClick={() => setModal(false)}>Annuler</Button><Button variant="primary" loading={saving} onClick={() => void save()}>{editing ? 'Enregistrer' : 'Ajouter'}</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Nom" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          <Input label="Prix" type="number" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} />
          <Input label="Devise" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} placeholder="XOF, USD, EUR…" />
          <Input label="Lien produit" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://…" />
          <div className="sm:col-span-2"><Textarea label="Description" rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></div>
          <div className="sm:col-span-2"><Input label="Bénéfices clés (séparés par ;)" value={form.benefits} onChange={(event) => setForm({ ...form, benefits: event.target.value })} placeholder="hydratation; éclat; absorption rapide" /></div>
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Marché, concurrence et signaux                                             */
/* -------------------------------------------------------------------------- */

interface CompetitorForm { name: string; url: string; positioning: string; strengths: string; weaknesses: string; notes: string }
const EMPTY_COMPETITOR: CompetitorForm = { name: '', url: '', positioning: '', strengths: '', weaknesses: '', notes: '' };

interface SignalForm { title: string; kind: GrowthSignal['kind']; platform: string; url: string; metricLabel: string; metricValue: string; observedAt: string; notes: string }
const EMPTY_SIGNAL: SignalForm = { title: '', kind: 'tendance', platform: '', url: '', metricLabel: '', metricValue: '', observedAt: '', notes: '' };

export function MarketPanel({
  competitors, signals, busy, onPut, onDelete, onAnalyze, analyzing,
}: {
  competitors: GrowthCompetitor[];
  signals: GrowthSignal[];
  busy: boolean;
  onPut: GrowthMutation;
  onDelete: (id: string) => Promise<void>;
  onAnalyze: () => Promise<void>;
  analyzing: boolean;
}) {
  const toast = useToast();
  const [competitorModal, setCompetitorModal] = useState(false);
  const [editingCompetitor, setEditingCompetitor] = useState<GrowthCompetitor | null>(null);
  const [competitorForm, setCompetitorForm] = useState<CompetitorForm>(EMPTY_COMPETITOR);
  const [signalModal, setSignalModal] = useState(false);
  const [editingSignal, setEditingSignal] = useState<GrowthSignal | null>(null);
  const [signalForm, setSignalForm] = useState<SignalForm>(EMPTY_SIGNAL);
  const [saving, setSaving] = useState(false);

  const saveCompetitor = async () => {
    if (!competitorForm.name.trim()) { toast.warning('Le nom du concurrent est obligatoire.'); return; }
    setSaving(true);
    try {
      await onPut(GROWTH_CATEGORY.competitor, { ...competitorForm, name: competitorForm.name.trim() }, editingCompetitor?.id ?? null);
      toast.success(editingCompetitor ? 'Concurrent mis à jour.' : 'Concurrent enregistré.');
      setCompetitorModal(false);
    } catch (error) { toast.error(asAppError(error).message); } finally { setSaving(false); }
  };

  const saveSignal = async () => {
    if (!signalForm.title.trim()) { toast.warning('Le titre du signal est obligatoire.'); return; }
    const value = signalForm.metricValue.trim() === '' ? 0 : Number(signalForm.metricValue);
    if (!Number.isFinite(value)) { toast.warning('Valeur de performance invalide.'); return; }
    setSaving(true);
    try {
      await onPut(GROWTH_CATEGORY.signal, { ...signalForm, title: signalForm.title.trim(), metricValue: value }, editingSignal?.id ?? null);
      toast.success(editingSignal ? 'Signal mis à jour.' : 'Signal enregistré.');
      setSignalModal(false);
    } catch (error) { toast.error(asAppError(error).message); } finally { setSaving(false); }
  };

  const remove = async (id: string, label: string) => {
    if (!window.confirm(`Supprimer « ${label} » ?`)) return;
    try { await onDelete(id); toast.success('Élément supprimé.'); }
    catch (error) { toast.error(asAppError(error).message); }
  };

  return (
    <div className="space-y-4" data-testid="growth-market">
      <section className="vyora-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Marché & concurrence</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-white">Ce qui se passe autour de vous</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400">
              Consignez vos observations réelles : concurrents, tendances, contenus performants, publicités repérées. L’IA analyse ensuite ces données sans prétendre avoir navigué sur le web.
            </p>
          </div>
          <Button size="sm" variant="outline" icon={<Lightbulb size={13} />} loading={analyzing} onClick={() => void onAnalyze()} disabled={busy || competitors.length + signals.length === 0}>
            Analyser avec l’IA
          </Button>
        </div>
      </section>

      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Users size={14} className="text-violet-300" /> Concurrents suivis <span className="text-xs font-normal text-slate-500">({competitors.length})</span></h3>
          <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => { setEditingCompetitor(null); setCompetitorForm(EMPTY_COMPETITOR); setCompetitorModal(true); }}>Ajouter</Button>
        </div>
        {competitors.length === 0 ? (
          <p className="mt-3 text-[11px] text-slate-500">Aucun concurrent enregistré. Ajoutez au moins un concurrent pour activer l’analyse comparative.</p>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {competitors.map((competitor) => (
              <article key={competitor.id} className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate text-sm font-semibold text-white">{competitor.name}</p>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" aria-label={`Modifier ${competitor.name}`} onClick={() => { setEditingCompetitor(competitor); setCompetitorForm({ name: competitor.name, url: competitor.url, positioning: competitor.positioning, strengths: competitor.strengths, weaknesses: competitor.weaknesses, notes: competitor.notes }); setCompetitorModal(true); }}><Pencil size={11} /></Button>
                    <Button size="sm" variant="ghost" aria-label={`Supprimer ${competitor.name}`} onClick={() => void remove(competitor.id, competitor.name)}><Trash2 size={11} /></Button>
                  </div>
                </div>
                {competitor.url && <a href={competitor.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[10px] text-cyan-200"><Link2 size={10} /> {competitor.url}</a>}
                {competitor.positioning && <p className="mt-1.5 line-clamp-2 text-[11px] text-slate-400">{competitor.positioning}</p>}
                {competitor.strengths && <p className="mt-1 text-[10px] text-emerald-200/80">Forces : {competitor.strengths}</p>}
                {competitor.weaknesses && <p className="mt-0.5 text-[10px] text-amber-200/80">Faiblesses : {competitor.weaknesses}</p>}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><TrendingUp size={14} className="text-cyan-300" /> Tendances & contenus repérés <span className="text-xs font-normal text-slate-500">({signals.length})</span></h3>
            <p className="mt-1 text-[10px] text-slate-500">Saisie manuelle : ces données ne proviennent pas d’une lecture automatique des réseaux sociaux.</p>
          </div>
          <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => { setEditingSignal(null); setSignalForm(EMPTY_SIGNAL); setSignalModal(true); }}>Ajouter</Button>
        </div>
        {signals.length === 0 ? (
          <p className="mt-3 text-[11px] text-slate-500">Aucun signal enregistré. Notez une tendance, une vidéo performante ou une publicité concurrente.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {signals.map((signal) => (
              <article key={signal.id} className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-cyan-400/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-cyan-200">{signal.kind}</span>
                    {signal.platform && <span className="text-[10px] text-slate-400">{signal.platform}</span>}
                    {signal.observedAt && <span className="text-[10px] text-slate-600">{signal.observedAt}</span>}
                  </div>
                  <p className="mt-1 text-sm font-medium text-white">{signal.title}</p>
                  {signal.metricLabel && <p className="mt-0.5 text-[11px] text-slate-400">{signal.metricLabel} : <strong className="text-slate-200">{signal.metricValue}</strong></p>}
                  {signal.notes && <p className="mt-1 line-clamp-2 text-[11px] text-slate-500">{signal.notes}</p>}
                  {signal.url && <a href={signal.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[10px] text-cyan-200">Ouvrir la source <ArrowUpRight size={10} /></a>}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" aria-label={`Modifier ${signal.title}`} onClick={() => { setEditingSignal(signal); setSignalForm({ title: signal.title, kind: signal.kind, platform: signal.platform, url: signal.url, metricLabel: signal.metricLabel, metricValue: String(signal.metricValue), observedAt: signal.observedAt, notes: signal.notes }); setSignalModal(true); }}><Pencil size={11} /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Supprimer ${signal.title}`} onClick={() => void remove(signal.id, signal.title)}><Trash2 size={11} /></Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <Modal open={competitorModal} onClose={() => setCompetitorModal(false)} title={editingCompetitor ? 'Modifier le concurrent' : 'Nouveau concurrent'} size="md"
        footer={<><Button variant="ghost" onClick={() => setCompetitorModal(false)}>Annuler</Button><Button variant="primary" loading={saving} onClick={() => void saveCompetitor()}>Enregistrer</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Nom" value={competitorForm.name} onChange={(event) => setCompetitorForm({ ...competitorForm, name: event.target.value })} />
          <Input label="Site / page" value={competitorForm.url} onChange={(event) => setCompetitorForm({ ...competitorForm, url: event.target.value })} placeholder="https://…" />
          <div className="sm:col-span-2"><Textarea label="Positionnement observé" rows={2} value={competitorForm.positioning} onChange={(event) => setCompetitorForm({ ...competitorForm, positioning: event.target.value })} /></div>
          <div className="sm:col-span-2"><Textarea label="Forces" rows={2} value={competitorForm.strengths} onChange={(event) => setCompetitorForm({ ...competitorForm, strengths: event.target.value })} /></div>
          <div className="sm:col-span-2"><Textarea label="Faiblesses / opportunités" rows={2} value={competitorForm.weaknesses} onChange={(event) => setCompetitorForm({ ...competitorForm, weaknesses: event.target.value })} /></div>
        </div>
      </Modal>

      <Modal open={signalModal} onClose={() => setSignalModal(false)} title={editingSignal ? 'Modifier le signal' : 'Nouveau signal marché'} size="md"
        footer={<><Button variant="ghost" onClick={() => setSignalModal(false)}>Annuler</Button><Button variant="primary" loading={saving} onClick={() => void saveSignal()}>Enregistrer</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Titre" value={signalForm.title} onChange={(event) => setSignalForm({ ...signalForm, title: event.target.value })} placeholder="Ex. Format « avant/après » très partagé" />
          <Select label="Type" value={signalForm.kind} onChange={(event) => setSignalForm({ ...signalForm, kind: event.target.value as GrowthSignal['kind'] })}>
            <option value="tendance">Tendance</option><option value="contenu">Contenu</option>
            <option value="produit">Produit</option><option value="publicite">Publicité</option>
          </Select>
          <Input label="Plateforme" value={signalForm.platform} onChange={(event) => setSignalForm({ ...signalForm, platform: event.target.value })} placeholder="TikTok, Instagram…" />
          <Input label="Lien source" value={signalForm.url} onChange={(event) => setSignalForm({ ...signalForm, url: event.target.value })} placeholder="https://…" />
          <Input label="Métrique observée" value={signalForm.metricLabel} onChange={(event) => setSignalForm({ ...signalForm, metricLabel: event.target.value })} placeholder="vues, likes, partages…" />
          <Input label="Valeur" type="number" value={signalForm.metricValue} onChange={(event) => setSignalForm({ ...signalForm, metricValue: event.target.value })} />
          <Input label="Date d’observation" type="date" value={signalForm.observedAt} onChange={(event) => setSignalForm({ ...signalForm, observedAt: event.target.value })} />
          <div className="sm:col-span-2"><Textarea label="Notes" rows={3} value={signalForm.notes} onChange={(event) => setSignalForm({ ...signalForm, notes: event.target.value })} /></div>
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Prospects et pipeline                                                       */
/* -------------------------------------------------------------------------- */

interface ProspectForm {
  name: string; company: string; email: string; phone: string; stage: ProspectStage;
  value: string; currency: string; nextAction: string; nextActionAt: string; notes: string;
}

const EMPTY_PROSPECT: ProspectForm = {
  name: '', company: '', email: '', phone: '', stage: 'prospect',
  value: '', currency: 'XOF', nextAction: '', nextActionAt: '', notes: '',
};

export function CrmPanel({
  prospects, busy, onPut, onDelete,
}: {
  prospects: GrowthProspect[];
  busy: boolean;
  onPut: GrowthMutation;
  onDelete: (id: string) => Promise<void>;
}) {
  const toast = useToast();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<GrowthProspect | null>(null);
  const [form, setForm] = useState<ProspectForm>(EMPTY_PROSPECT);
  const [saving, setSaving] = useState(false);
  const [stageFilter, setStageFilter] = useState<'tous' | ProspectStage>('tous');
  const summary = useMemo(() => pipelineSummary(prospects), [prospects]);
  const visible = stageFilter === 'tous' ? prospects : prospects.filter((prospect) => prospect.stage === stageFilter);

  const openForm = (prospect?: GrowthProspect) => {
    setEditing(prospect ?? null);
    setForm(prospect ? {
      name: prospect.name, company: prospect.company, email: prospect.email, phone: prospect.phone,
      stage: prospect.stage, value: String(prospect.value || ''), currency: prospect.currency,
      nextAction: prospect.nextAction, nextActionAt: prospect.nextActionAt, notes: prospect.notes,
    } : EMPTY_PROSPECT);
    setModal(true);
  };

  const payload = (source: ProspectForm) => ({
    name: source.name.trim(), company: source.company.trim(), email: source.email.trim(),
    phone: source.phone.trim(), stage: source.stage,
    value: Math.max(0, Number(source.value) || 0), currency: source.currency.toUpperCase(),
    nextAction: source.nextAction.trim(), nextActionAt: source.nextActionAt, notes: source.notes.trim(),
  });

  const save = async () => {
    if (!form.name.trim() && !form.company.trim()) { toast.warning('Renseignez au moins un nom ou une entreprise.'); return; }
    setSaving(true);
    try {
      await onPut(GROWTH_CATEGORY.prospect, payload(form), editing?.id ?? null);
      toast.success(editing ? 'Prospect mis à jour.' : 'Prospect ajouté.');
      setModal(false);
    } catch (error) { toast.error(asAppError(error).message); } finally { setSaving(false); }
  };

  const changeStage = async (prospect: GrowthProspect, stage: ProspectStage) => {
    try {
      await onPut(GROWTH_CATEGORY.prospect, {
        name: prospect.name, company: prospect.company, email: prospect.email, phone: prospect.phone,
        stage, value: prospect.value, currency: prospect.currency,
        nextAction: prospect.nextAction, nextActionAt: prospect.nextActionAt, notes: prospect.notes,
      }, prospect.id);
      toast.success(`Étape mise à jour : ${PROSPECT_STAGES.find((entry) => entry.id === stage)?.label}.`);
    } catch (error) { toast.error(asAppError(error).message); }
  };

  return (
    <div className="space-y-4" data-testid="growth-crm">
      <section className="vyora-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Prospects & opportunités</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-white">Votre pipeline commercial</h2>
            <p className="mt-1 text-xs text-slate-400">Les montants affichés sont ceux que vous avez saisis, dans leur devise d’origine.</p>
          </div>
          <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => openForm()} disabled={busy}>Nouveau prospect</Button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['Pipeline ouvert', formatGrowthAmount(summary.openValue, prospects[0]?.currency ?? 'XOF')],
            ['Opportunités ouvertes', String(summary.openCount)],
            ['Gagné', formatGrowthAmount(summary.wonValue, prospects[0]?.currency ?? 'XOF')],
            ['Total prospects', String(summary.totalCount)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
              <p className="text-[10px] text-slate-500">{label}</p>
              <p className="mt-1 truncate text-sm font-semibold text-white">{value}</p>
            </div>
          ))}
        </div>
        <div className="no-scrollbar mt-3 flex gap-1.5 overflow-x-auto">
          {(['tous', ...PROSPECT_STAGES.map((stage) => stage.id)] as const).map((stage) => (
            <button key={stage} type="button" onClick={() => setStageFilter(stage as typeof stageFilter)}
              className={cn('studio-chip shrink-0', stageFilter === stage && 'border-cyan-400/45 bg-cyan-400/10 text-cyan-100')}>
              {stage === 'tous' ? 'Tous' : PROSPECT_STAGES.find((entry) => entry.id === stage)?.label}
              <span className="text-[9px] opacity-70">{stage === 'tous' ? prospects.length : summary.byStage[stage as ProspectStage] ?? 0}</span>
            </button>
          ))}
        </div>
      </section>

      {visible.length === 0 ? (
        <EmptyState icon={<Users size={22} />} title="Aucun prospect dans cette vue" description="Ajoutez vos prospects pour suivre vos relances et vos opportunités."
          action={<Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => openForm()}>Ajouter un prospect</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((prospect) => {
            const stage = PROSPECT_STAGES.find((entry) => entry.id === prospect.stage);
            return (
              <article key={prospect.id} className="vyora-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{prospect.name || prospect.company}</p>
                    <p className="truncate text-[11px] text-slate-500">{prospect.company || prospect.email || 'Coordonnées non renseignées'}</p>
                  </div>
                  <span className={cn('shrink-0 text-[10px] font-semibold', stage?.tone)}>{stage?.label}</span>
                </div>
                <p className="mt-2 text-sm font-semibold text-white">{prospect.value > 0 ? formatGrowthAmount(prospect.value, prospect.currency) : 'Montant non renseigné'}</p>
                {prospect.nextAction && (
                  <p className="mt-1.5 rounded-lg border border-white/[0.06] bg-black/20 px-2 py-1.5 text-[10px] text-slate-300">
                    <span className="text-slate-500">Prochaine action : </span>{prospect.nextAction}
                    {prospect.nextActionAt && <span className="text-slate-500"> · {prospect.nextActionAt}</span>}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-1.5">
                  <Select aria-label={`Étape de ${prospect.name || prospect.company}`} value={prospect.stage}
                    onChange={(event) => void changeStage(prospect, event.target.value as ProspectStage)}
                    className="py-1 text-[11px]">
                    {PROSPECT_STAGES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                  </Select>
                  <Button size="sm" variant="ghost" aria-label="Modifier le prospect" onClick={() => openForm(prospect)}><Pencil size={12} /></Button>
                  <Button size="sm" variant="ghost" aria-label="Supprimer le prospect" onClick={() => { if (window.confirm('Supprimer ce prospect ?')) void onDelete(prospect.id).then(() => toast.success('Prospect supprimé.')).catch((error) => toast.error(asAppError(error).message)); }}><Trash2 size={12} /></Button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? 'Modifier le prospect' : 'Nouveau prospect'} size="lg"
        footer={<><Button variant="ghost" onClick={() => setModal(false)}>Annuler</Button><Button variant="primary" loading={saving} onClick={() => void save()}>Enregistrer</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Nom du contact" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          <Input label="Entreprise" value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} />
          <Input label="E-mail" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          <Input label="Téléphone / WhatsApp" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          <Select label="Étape" value={form.stage} onChange={(event) => setForm({ ...form, stage: event.target.value as ProspectStage })}>
            {PROSPECT_STAGES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </Select>
          <Input label="Valeur estimée" type="number" value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} />
          <Input label="Devise" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} />
          <Input label="Prochaine action" value={form.nextAction} onChange={(event) => setForm({ ...form, nextAction: event.target.value })} placeholder="Rappeler, envoyer un devis…" />
          <Input label="Date de relance" type="date" value={form.nextActionAt} onChange={(event) => setForm({ ...form, nextActionAt: event.target.value })} />
          <div className="sm:col-span-2"><Textarea label="Notes" rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></div>
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Stratégies                                                                  */
/* -------------------------------------------------------------------------- */

export function StrategyPanel({
  strategies, busy, answer, aiBusy, aiError, aiProvider, aiTask, onGenerate, onSaveAnswer, onPut, onDelete,
}: {
  strategies: GrowthStrategy[];
  busy: boolean;
  answer: string;
  aiBusy: boolean;
  aiError: string;
  aiProvider: string;
  aiTask: string;
  onGenerate: () => Promise<void>;
  onSaveAnswer: () => Promise<void>;
  onPut: GrowthMutation;
  onDelete: (id: string) => Promise<void>;
}) {
  const toast = useToast();
  const [manual, setManual] = useState(false);
  const [form, setForm] = useState({ title: '', horizon: '30 jours', summary: '', actions: '' });
  const [saving, setSaving] = useState(false);

  const saveManual = async () => {
    if (!form.title.trim() || !form.summary.trim()) { toast.warning('Titre et résumé requis.'); return; }
    setSaving(true);
    try {
      await onPut(GROWTH_CATEGORY.strategy, {
        title: form.title.trim(), horizon: form.horizon.trim(), summary: form.summary.trim(),
        actions: form.actions.split(/\r?\n/).map((line) => line.replace(/^[-•*]\s*/, '').trim()).filter(Boolean).slice(0, 12),
        source: 'utilisateur', createdAt: new Date().toISOString(),
      });
      toast.success('Plan enregistré.');
      setManual(false);
      setForm({ title: '', horizon: '30 jours', summary: '', actions: '' });
    } catch (error) { toast.error(asAppError(error).message); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4" data-testid="growth-strategy">
      <section className="vyora-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Stratégie & plans d’action</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-white">Passer de l’analyse à l’exécution</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400">
              L’IA s’appuie sur votre contexte réel (entreprise, objectifs, produits, concurrents, prospects). Elle ne consulte pas le web et n’invente aucun chiffre.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setManual(true)} disabled={busy}>Plan manuel</Button>
            <Button size="sm" variant="primary" icon={<TrendingUp size={13} />} loading={aiBusy} onClick={() => void onGenerate()} disabled={busy}>Générer avec l’IA</Button>
          </div>
        </div>
      </section>

      {(aiBusy || answer || aiError) && (
        <section className="vyora-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-xs font-semibold text-white"><Lightbulb size={13} className="text-amber-300" /> Réponse IA · {aiTask}</p>
            <div className="flex items-center gap-2">
              {aiProvider && <span className="vyora-badge-soft">Service : {aiProvider}</span>}
              {answer && !aiBusy && <Button size="sm" variant="outline" icon={<Check size={12} />} onClick={() => void onSaveAnswer()}>Enregistrer ce plan</Button>}
            </div>
          </div>
          {aiError && <p className="mt-3 rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-200">{aiError}</p>}
          {aiBusy && !answer && <p className="mt-3 text-xs text-slate-400">L’IA analyse vos données réelles…</p>}
          {answer && <div className="mt-3 max-h-[520px] overflow-y-auto whitespace-pre-wrap rounded-xl border border-white/[0.07] bg-black/25 p-4 text-[12px] leading-relaxed text-slate-200">{answer}</div>}
          <p className="mt-2 text-[10px] text-slate-500">Réponse générée par un fournisseur IA configuré côté serveur. Vérifiez les hypothèses avant décision.</p>
        </section>
      )}

      {strategies.length === 0 ? (
        <EmptyState icon={<FileText size={22} />} title="Aucun plan enregistré" description="Générez une stratégie IA à partir de votre contexte, ou rédigez votre propre plan."
          action={<Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => setManual(true)}>Créer un plan</Button>} />
      ) : (
        <div className="space-y-3">
          {strategies.map((strategy) => (
            <article key={strategy.id} className="vyora-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-white">{strategy.title}</p>
                  <p className="mt-0.5 text-[10px] text-slate-500">{strategy.horizon || 'Horizon non précisé'} · {strategy.source === 'ia' ? 'Généré par IA' : 'Créé manuellement'}</p>
                </div>
                <Button size="sm" variant="ghost" aria-label="Supprimer le plan" onClick={() => { if (window.confirm('Supprimer ce plan ?')) void onDelete(strategy.id).then(() => toast.success('Plan supprimé.')).catch((error) => toast.error(asAppError(error).message)); }}><Trash2 size={12} /></Button>
              </div>
              <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400">{strategy.summary}</p>
              {strategy.actions.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {strategy.actions.slice(0, 5).map((action) => <li key={action} className="flex items-start gap-1.5 text-[11px] text-slate-300"><Check size={11} className="mt-0.5 shrink-0 text-emerald-400" /> {action}</li>)}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}

      <Modal open={manual} onClose={() => setManual(false)} title="Nouveau plan d’action" size="lg"
        footer={<><Button variant="ghost" onClick={() => setManual(false)}>Annuler</Button><Button variant="primary" loading={saving} onClick={() => void saveManual()}>Enregistrer</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Titre" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          <Input label="Horizon" value={form.horizon} onChange={(event) => setForm({ ...form, horizon: event.target.value })} placeholder="30 jours, 90 jours…" />
          <div className="sm:col-span-2"><Textarea label="Résumé" rows={5} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></div>
          <div className="sm:col-span-2"><Textarea label="Actions (une par ligne)" rows={5} value={form.actions} onChange={(event) => setForm({ ...form, actions: event.target.value })} /></div>
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Petits blocs partagés                                                       */
/* -------------------------------------------------------------------------- */

export function GrowthKpi({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="vyora-dash-card">
      <div className="flex items-center gap-2 text-[11px] text-slate-400">{icon} {label}</div>
      <p className="vyora-stat mt-2">{value}</p>
      {hint && <p className="mt-1 text-[10px] text-slate-500">{hint}</p>}
    </div>
  );
}

export function CompanyBadge({ profile }: { profile: CompanyProfile }) {
  return (
    <span className="vyora-badge-soft">
      <Building2 size={10} /> {profile.legalName || 'Entreprise à compléter'}
    </span>
  );
}

