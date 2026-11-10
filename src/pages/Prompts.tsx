import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, Copy, Pencil, Plus, Sparkles, Star, Trash2, Wand2, Variable } from 'lucide-react';
import { PageHeader, Card, Button, Input, Textarea, Select, Badge, Modal, LoadingState, ErrorState, EmptyState, ConfirmDialog, Banner } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { extractVariables, formatDate, interpolate, truncate } from '../lib/format';
import { createPrompt, deletePrompt, improvePrompt, listPrompts, updatePrompt } from '../lib/api';
import type { PromptTemplate } from '../lib/types';

const CATEGORIES: PromptTemplate['category'][] = ['script', 'hook', 'cta', 'scene', 'visual', 'system'];
const CATEGORY_LABELS: Record<string, string> = {
  script: 'Script', hook: 'Accroche', cta: 'Appel à l’action', scene: 'Scène', visual: 'Visuel', system: 'Système',
};

const EMPTY = { title: '', category: 'script' as PromptTemplate['category'], content: '', is_favorite: false };
const PROMPT_PAGE_SIZE = 24;

export default function Prompts() {
  const toast = useToast();
  const { user, workspaceId, refreshQuota } = useAuth();
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [loadMoreError, setLoadMoreError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [improving, setImproving] = useState(false);
  const [toDelete, setToDelete] = useState<PromptTemplate | null>(null);
  const [testValues, setTestValues] = useState<Record<string, string>>({});
  const [categoryFilter, setCategoryFilter] = useState<'all' | PromptTemplate['category']>('all');
  const requestId = useRef(0);
  const loadMoreRequestId = useRef(0);
  const categoryRef = useRef(categoryFilter);
  categoryRef.current = categoryFilter;

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    ++loadMoreRequestId.current;
    setLoadingMore(false); setLoading(true); setError(''); setLoadMoreError('');
    try {
      const page = await listPrompts(categoryFilter === 'all' ? undefined : categoryFilter, PROMPT_PAGE_SIZE + 1);
      if (currentRequest !== requestId.current) return;
      setPrompts(page.slice(0, PROMPT_PAGE_SIZE));
      setHasMore(page.length > PROMPT_PAGE_SIZE);
    } catch (err) {
      if (currentRequest === requestId.current) setError(asAppError(err).message);
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [categoryFilter]);

  useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    const currentRequest = ++loadMoreRequestId.current;
    const currentLoad = requestId.current;
    const currentCategory = categoryRef.current;
    setLoadingMore(true); setLoadMoreError('');
    try {
      const page = await listPrompts(currentCategory === 'all' ? undefined : currentCategory, PROMPT_PAGE_SIZE + 1, prompts.length);
      if (currentRequest !== loadMoreRequestId.current || currentLoad !== requestId.current || currentCategory !== categoryRef.current) return;
      setPrompts((current) => [...current, ...page.slice(0, PROMPT_PAGE_SIZE)]);
      setHasMore(page.length > PROMPT_PAGE_SIZE);
    } catch (err) {
      if (currentRequest === loadMoreRequestId.current && currentLoad === requestId.current && currentCategory === categoryRef.current) {
        setLoadMoreError(asAppError(err).message);
      }
    } finally {
      if (currentRequest === loadMoreRequestId.current) setLoadingMore(false);
    }
  };

  const openCreate = () => { setEditing(null); setForm(EMPTY); setTestValues({}); setModal(true); };
  const openEdit = (p: PromptTemplate) => { setEditing(p); setForm({ title: p.title, category: p.category, content: p.content, is_favorite: p.is_favorite }); setTestValues({}); setModal(true); };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.content.trim()) { toast.warning('Le titre et le contenu sont obligatoires.'); return; }
    if (!workspaceId || !user) { toast.error('Espace de travail indisponible.'); return; }
    setSaving(true);
    try {
      const variables = extractVariables(form.content);
      if (editing) {
        await updatePrompt(editing.id, { ...form, variables });
        toast.success('Prompt mis à jour.');
      } else {
        await createPrompt({ workspace_id: workspaceId, created_by: user.id, ...form, variables, is_system: false, usage_count: 0 });
        toast.success('Prompt créé.');
      }
      setModal(false); await load();
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setSaving(false); }
  };

  const onImprove = async () => {
    if (!form.content.trim()) { toast.warning('Écrivez d’abord un prompt à améliorer.'); return; }
    setImproving(true);
    try {
      const data = await improvePrompt(form.content);
      setForm({ ...form, content: data.content });
      toast.success('Prompt enrichi par Groq.'); await refreshQuota();
    } catch (err) {
      const e = asAppError(err);
      toast.error(e.code === 'GROQ_NOT_CONFIGURED' ? 'GROQ_API_KEY est requis côté serveur pour cette fonction.' : e.message);
    } finally { setImproving(false); }
  };

  const onDelete = async () => {
    if (!toDelete) return;
    try { await deletePrompt(toDelete.id); toast.success('Prompt supprimé.'); setToDelete(null); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  const onToggleFavorite = async (p: PromptTemplate) => {
    try { await updatePrompt(p.id, { is_favorite: !p.is_favorite }); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  const onCopy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success('Prompt copié.'); }
    catch { toast.error('Copie impossible.'); }
  };

  const variables = extractVariables(form.content);
  const filtered = prompts;

  return (
    <>
      <PageHeader eyebrow="Bibliothèque de prompts" title="Mes prompts" description="Créez, organisez et réutilisez vos modèles de prompts avec variables dynamiques."
        actions={<Button icon={<Plus size={15} />} onClick={openCreate}>Nouveau prompt</Button>} />

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      <Card className="mb-5 flex flex-wrap items-center gap-3 p-4">
        <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value === 'all' ? 'all' : CATEGORIES.find((category) => category === e.target.value) ?? 'all')} className="w-auto min-w-[180px]" aria-label="Filtrer par catégorie">
          <option value="all">Toutes les catégories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
        </Select>
        <span className="text-xs text-slate-500">{filtered.length} prompt(s) chargé(s){hasMore ? ' · d’autres résultats sont disponibles' : ''}</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void load()}>Actualiser</Button>
      </Card>

      {loading ? <LoadingState /> : error ? null : filtered.length === 0 ? (
        <EmptyState icon={<BookOpen size={24} />} title="Aucun prompt" description="Créez votre premier modèle ou utilisez les modèles système fournis." action={<Button icon={<Plus size={15} />} onClick={openCreate}>Créer un prompt</Button>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => (
            <Card key={p.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <Badge tone={p.is_system ? 'info' : 'neutral'}>{p.is_system ? 'Modèle système' : CATEGORY_LABELS[p.category]}</Badge>
                <button onClick={() => void onToggleFavorite(p)} className="text-slate-500 hover:text-amber-300" title={p.is_favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}>
                  <Star size={16} fill={p.is_favorite ? 'currentColor' : 'none'} className={p.is_favorite ? 'text-amber-300' : ''} />
                </button>
              </div>
              <h3 className="mt-3 text-sm font-semibold text-white">{p.title}</h3>
              <p className="mt-2 line-clamp-4 min-h-[70px] whitespace-pre-wrap text-xs leading-relaxed text-slate-400">{truncate(p.content, 260)}</p>
              {p.variables?.length > 0 && <div className="mt-3 flex flex-wrap gap-1">{p.variables.map((v) => <span key={v} className="rounded bg-brand-500/10 px-1.5 py-0.5 text-[10px] text-brand-200">{`{{${v}}}`}</span>)}</div>}
              <p className="mt-3 text-[11px] text-slate-600">{formatDate(p.created_at)} · {p.usage_count} utilisation(s)</p>
              <div className="mt-auto flex gap-1.5 pt-4">
                <Button size="sm" variant="outline" className="flex-1" icon={<Copy size={13} />} onClick={() => void onCopy(p.content)}>Copier</Button>
                {!p.is_system && <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openEdit(p)} title="Modifier" />}
                {!p.is_system && <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setToDelete(p)} title="Supprimer" />}
              </div>
            </Card>
          ))}
        </div>
      )}
      {!loading && !error && filtered.length > 0 && (
        <>
          {loadMoreError && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-4 py-3" role="alert">
              <p className="text-sm text-rose-100">{loadMoreError}</p>
              <Button size="sm" variant="outline" onClick={() => void loadMore()}>Réessayer</Button>
            </div>
          )}
          {hasMore && (
            <div className="mt-6 flex justify-center">
              <Button variant="outline" loading={loadingMore} onClick={() => void loadMore()}>Charger plus de prompts</Button>
            </div>
          )}
        </>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? 'Modifier le prompt' : 'Nouveau prompt'} description="Utilisez {{variable}} pour rendre le modèle réutilisable." size="lg"
        footer={<><Button variant="ghost" onClick={() => setModal(false)}>Annuler</Button><Button type="submit" form="prompt-form" loading={saving}>{editing ? 'Enregistrer' : 'Créer'}</Button></>}>
        <form id="prompt-form" onSubmit={(e) => void onSubmit(e)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Titre" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Script UGC témoignage" />
            <Select label="Catégorie" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as PromptTemplate['category'] })}>
              {CATEGORIES.filter((c) => c !== 'system').map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </Select>
          </div>
          <Textarea label="Contenu du prompt" required value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} className="min-h-[180px] font-mono text-xs"
            placeholder="Écris un script UGC de {{duree}} secondes pour {{produit}} destiné à {{audience}}…" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">{variables.length > 0 ? variables.map((v) => <span key={v} className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[11px] text-brand-200"><Variable size={11} /> {v}</span>) : <span className="text-xs text-slate-500">Aucune variable détectée</span>}</div>
            <Button type="button" size="sm" variant="outline" icon={<Sparkles size={13} />} loading={improving} onClick={() => void onImprove()}>Améliorer avec l’IA</Button>
          </div>
          {variables.length > 0 && (
            <div className="rounded-xl border border-line bg-white/[0.025] p-4">
              <p className="mb-3 text-xs font-semibold text-slate-400">Aperçu avec variables</p>
              <div className="mb-3 grid gap-2 sm:grid-cols-2">{variables.map((v) => <Input key={v} label={v} value={testValues[v] ?? ''} onChange={(e) => setTestValues({ ...testValues, [v]: e.target.value })} placeholder={`Valeur de ${v}`} />)}</div>
              <p className="whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-xs leading-relaxed text-slate-300">{interpolate(form.content, testValues)}</p>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={form.is_favorite} onChange={(e) => setForm({ ...form, is_favorite: e.target.checked })} className="h-4 w-4 accent-brand-500" /> Ajouter aux favoris</label>
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(toDelete)} title="Supprimer ce prompt ?" danger confirmLabel="Supprimer" onClose={() => setToDelete(null)} onConfirm={() => void onDelete()} message="Ce modèle de prompt sera définitivement supprimé." />
      <div className="mt-6"><Banner tone="info" title="Modèles système"><Wand2 size={12} className="inline" /> Les modèles fournis par Reelora sont en lecture seule. Dupliquez-les en copiant leur contenu pour les personnaliser.</Banner></div>
    </>
  );
}
