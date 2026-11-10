import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Copy, FileText, Sparkles, Trash2, Wand2, Layers, Save } from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Input, Textarea, Select, Badge, Banner, LoadingState, ErrorState, EmptyState, Tabs, ConfirmDialog } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { formatDate, statusLabel, truncate } from '../lib/format';
import { deleteScript, generateHooks, generateScript, listProjects, listPrompts, listScripts, saveScenes, saveScript, updateScript } from '../lib/api';
import type { AiScriptResult, Project, PromptTemplate, Script } from '../lib/types';

const SCRIPTS_PAGE_SIZE = 24;

export default function Scripts() {
  const toast = useToast();
  const { refreshQuota } = useAuth();
  const [params] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [result, setResult] = useState<AiScriptResult | null>(null);
  const [hooks, setHooks] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loadMoreError, setLoadMoreError] = useState('');
  const [hasMoreScripts, setHasMoreScripts] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('generer');
  const [toDelete, setToDelete] = useState<Script | null>(null);
  const [form, setForm] = useState({
    project_id: params.get('projet') ?? '', product: '', audience: '', platform: 'TikTok',
    tone: 'naturel et authentique', duration: 20, objective: 'conversion', market: '',
    brief: '', template_id: '', language: 'fr',
  });

  const load = useCallback(async () => {
    setLoading(true); setLoadError(''); setLoadMoreError('');
    try {
      const [p, s, t] = await Promise.all([
        listProjects(), listScripts(undefined, SCRIPTS_PAGE_SIZE + 1), listPrompts(),
      ]);
      setProjects(p); setScripts(s.slice(0, SCRIPTS_PAGE_SIZE));
      setHasMoreScripts(s.length > SCRIPTS_PAGE_SIZE);
      setTemplates(t.filter((x) => x.category === 'script' || x.category === 'hook'));
      if (params.get('projet')) {
        const found = p.find((x) => x.id === params.get('projet'));
        if (found) setForm((f) => ({ ...f, project_id: found.id, product: found.title, audience: f.audience || found.target_audience || '', brief: f.brief || found.brief || '' }));
      }
    } catch (err) { setLoadError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [params]);

  useEffect(() => { void load(); }, [load]);

  const loadMoreScripts = async () => {
    if (loadingMore || !hasMoreScripts) return;
    setLoadingMore(true); setLoadMoreError('');
    try {
      const next = await listScripts(undefined, SCRIPTS_PAGE_SIZE + 1, scripts.length);
      setScripts((current) => [...current, ...next.slice(0, SCRIPTS_PAGE_SIZE)]);
      setHasMoreScripts(next.length > SCRIPTS_PAGE_SIZE);
    } catch (err) {
      setLoadMoreError(asAppError(err).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const scriptTemplates = useMemo(() => templates.filter((t) => t.category === 'script'), [templates]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setResult(null);
    if (!form.product.trim()) { setError('Décrivez le produit ou la marque à mettre en avant.'); return; }
    setGenerating(true);
    try {
      const data = await generateScript({
        project_id: form.project_id || null, product: form.product, audience: form.audience,
        platform: form.platform, tone: form.tone, duration: form.duration, objective: form.objective,
        market: form.market, brief: form.brief, template_id: form.template_id || null, language: form.language,
      });
      setResult(data); setHooks([]); toast.success('Script généré.');
      await refreshQuota(); await load();
    } catch (err) {
      const appErr = asAppError(err);
      setError(appErr.code === 'GROQ_NOT_CONFIGURED'
        ? 'Le secret serveur GROQ_API_KEY n’est pas configuré. Ajoutez-le dans Supabase → Edge Functions → Secrets pour activer la génération IA.'
        : appErr.message);
    } finally { setGenerating(false); }
  };

  const onSaveResult = async () => {
    if (!result) return;
    if (!form.project_id) { toast.warning('Sélectionnez un projet pour enregistrer ce script.'); return; }
    setSaving(true);
    try {
      const scriptId = await saveScript({
        project_id: form.project_id, script_text: result.script_text, hook: result.hook,
        call_to_action: result.call_to_action, marketing_angle: result.marketing_angle,
        language: form.language, claims_to_avoid: result.claims_to_avoid || [],
      });
      if (result.scenes?.length) await saveScenes(form.project_id, result.scenes, scriptId);
      toast.success('Script et scènes enregistrés dans le projet.');
      setResult((r) => r ? { ...r, script_id: scriptId, scenes_saved: result.scenes?.length ?? 0 } : r);
      await load();
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setSaving(false); }
  };

  const onGenerateHooks = async () => {
    if (!form.product.trim()) { toast.warning('Renseignez d’abord le produit.'); return; }
    setGenerating(true); setError('');
    try {
      const data = await generateHooks(form.product, form.audience);
      setHooks(data.hooks || []); await refreshQuota();
    } catch (err) {
      const e = asAppError(err);
      setError(e.code === 'GROQ_NOT_CONFIGURED' ? 'GROQ_API_KEY n’est pas configuré côté serveur.' : e.message);
    } finally { setGenerating(false); }
  };

  const onCopy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success('Copié dans le presse-papiers.'); }
    catch { toast.error('Copie impossible depuis ce navigateur.'); }
  };

  const onDelete = async () => {
    if (!toDelete) return;
    try { await deleteScript(toDelete.id); toast.success('Script supprimé.'); setToDelete(null); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  const onApprove = async (s: Script) => {
    try { await updateScript(s.id, { status: 'approved' }); toast.success('Script approuvé.'); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  return (
    <>
      <PageHeader eyebrow="Intelligence artificielle" title="Générateur de scripts" description="Rédigez des scripts UGC structurés avec Groq. Chaque génération consomme un quota et un crédit." />

      <Tabs active={tab} onChange={setTab} tabs={[
        { id: 'generer', label: 'Générer', icon: <Wand2 size={14} /> },
        { id: 'bibliotheque', label: 'Mes scripts', icon: <FileText size={14} /> },
      ]} />
      {loadError && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-4 py-3" role="alert">
          <p className="text-sm text-rose-100">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>Réessayer</Button>
        </div>
      )}

      {tab === 'generer' && (
        <div className="grid gap-5 lg:grid-cols-5">
          <Card className="lg:col-span-2"><CardHeader title="Brief créatif" description="Plus le brief est précis, plus le script est pertinent." />
            <form id="script-form" onSubmit={(e) => void onSubmit(e)} className="space-y-4 p-5">
              <Select label="Projet associé" value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
                <option value="">Aucun projet (génération libre)</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </Select>
              <Input label="Produit ou marque" required value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })} placeholder="Ex. Sérum visage Éclat+" />
              <Textarea label="Brief / bénéfices" value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} placeholder="Problème résolu, bénéfices, preuves, ton…" />
              <Input label="Audience cible" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} placeholder="Ex. Femmes 25-35 ans en milieu urbain" />
              <div className="grid grid-cols-2 gap-3">
                <Select label="Plateforme" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>{['TikTok', 'Instagram Reels', 'YouTube Shorts', 'Facebook', 'LinkedIn'].map((x) => <option key={x}>{x}</option>)}</Select>
                <Select label="Objectif" value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })}><option value="conversion">Conversion</option><option value="notoriete">Notoriété</option><option value="lancement">Lancement</option><option value="engagement">Engagement</option></Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Durée (secondes)" type="number" min={5} max={60} value={form.duration} onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })} />
                <Input label="Marché" value={form.market} onChange={(e) => setForm({ ...form, market: e.target.value })} placeholder="Mali, France…" />
              </div>
              <Input label="Ton" value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} placeholder="naturel, dynamique, premium…" />
              <Select label="Modèle de prompt (optionnel)" value={form.template_id} onChange={(e) => setForm({ ...form, template_id: e.target.value })}>
                <option value="">Prompt système par défaut</option>
                {scriptTemplates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </Select>
              {error && <ErrorState message={error} />}
              <Button type="submit" form="script-form" size="lg" className="w-full" loading={generating} icon={<Sparkles size={16} />}>Générer le script</Button>
              <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => void onGenerateHooks()} loading={generating}>Proposer 5 accroches</Button>
            </form>
          </Card>

          <Card className="lg:col-span-3"><CardHeader title="Résultat" description="Le script, les scènes et les précautions de conformité."
            action={result && <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void onCopy(result.script_text)}>Copier</Button>} />
            {generating ? <LoadingState label="Groq rédige votre script…" /> : !result ? (
              <EmptyState icon={<Wand2 size={24} />} title="Aucun script généré" description="Renseignez le brief puis lancez la génération. Aucun résultat fictif n’est affiché." />
            ) : (
              <div className="space-y-5 p-5">
                {result.hook && <div className="rounded-xl border border-brand-400/25 bg-brand-500/10 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-brand-300">Accroche</p><p className="mt-1 text-base font-semibold text-white">{result.hook}</p></div>}
                <div><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Script</p><p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">{result.script_text}</p></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-line bg-white/[0.025] p-3"><p className="text-xs text-slate-500">Appel à l’action</p><p className="mt-1 text-sm text-emerald-300">{result.call_to_action || '—'}</p></div>
                  <div className="rounded-xl border border-line bg-white/[0.025] p-3"><p className="text-xs text-slate-500">Angle marketing</p><p className="mt-1 text-sm text-white">{result.marketing_angle || '—'}</p></div>
                </div>
                {(result.claims_to_avoid?.length ?? 0) > 0 && <Banner tone="warning" title="Allégations à éviter"><ul className="list-inside list-disc">{result.claims_to_avoid.map((c, i) => <li key={i}>{c}</li>)}</ul></Banner>}
                {(result.scenes?.length ?? 0) > 0 && (
                  <div><p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><Layers size={13} /> Storyboard ({result.scenes.length} scènes)</p>
                    <div className="space-y-2">{result.scenes.map((s, i) => (
                      <div key={i} className="rounded-xl border border-line bg-white/[0.025] p-3">
                        <div className="flex items-center justify-between text-xs"><Badge tone="info">{s.scene_type}</Badge><span className="text-slate-500">{s.duration_seconds}s</span></div>
                        <p className="mt-2 text-sm text-white">{s.spoken_text || s.subtitle_text}</p>
                        {s.visual_prompt && <p className="mt-1 text-xs text-slate-500">{truncate(s.visual_prompt, 160)}</p>}
                      </div>
                    ))}</div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                  <Button icon={<Save size={15} />} loading={saving} onClick={() => void onSaveResult()}>Enregistrer dans le projet</Button>
                  <Button variant="outline" icon={<Copy size={15} />} onClick={() => void onCopy(JSON.stringify(result, null, 2))}>Copier le JSON</Button>
                  {result.script_id && <Badge tone="success"><Check size={12} /> Enregistré</Badge>}
                </div>
              </div>
            )}
            {hooks.length > 0 && <div className="border-t border-line p-5"><p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Accroches proposées</p>
              <div className="space-y-2">{hooks.map((h, i) => <button key={i} onClick={() => void onCopy(h)} className="flex w-full items-start gap-2 rounded-lg border border-line bg-white/[0.025] px-3 py-2 text-left text-sm text-slate-200 hover:border-brand-400/30"><span className="text-brand-300">{i + 1}.</span><span className="flex-1">{h}</span><Copy size={13} className="mt-0.5 text-slate-500" /></button>)}</div>
            </div>}
          </Card>
        </div>
      )}

      {tab === 'bibliotheque' && (
        <Card><CardHeader title="Scripts enregistrés" description={loading ? 'Chargement…' : `${scripts.length} script(s) chargés${hasMoreScripts ? ' · d’autres scripts sont disponibles' : ''}`} />
          {loading ? <LoadingState /> : loadError ? null : scripts.length === 0 ? <EmptyState icon={<FileText size={22} />} title="Aucun script enregistré" description="Générez puis enregistrez un script pour le retrouver ici." /> : (
            <>
              <div className="divide-y divide-white/[0.06]">{scripts.map((s) => (
              <div key={s.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2"><Badge status={s.status}>{statusLabel(s.status)}</Badge><span className="text-xs text-slate-500">v{s.version} · {formatDate(s.created_at, true)}</span></div>
                {s.hook && <p className="mt-2 text-sm font-semibold text-brand-200">{s.hook}</p>}
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{truncate(s.script_text, 500)}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {s.status !== 'approved' && <Button size="sm" variant="outline" icon={<Check size={13} />} onClick={() => void onApprove(s)}>Approuver</Button>}
                  <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => void onCopy(s.script_text)}>Copier</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setToDelete(s)}>Supprimer</Button>
                </div>
              </div>
              ))}</div>
              {loadMoreError && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3" role="alert">
                  <p className="text-sm text-rose-200">{loadMoreError}</p>
                  <Button size="sm" variant="outline" onClick={() => void loadMoreScripts()}>Réessayer</Button>
                </div>
              )}
              {hasMoreScripts && (
                <div className="flex justify-center border-t border-line p-4">
                  <Button variant="outline" loading={loadingMore} onClick={() => void loadMoreScripts()}>Charger plus de scripts</Button>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      <ConfirmDialog open={Boolean(toDelete)} title="Supprimer ce script ?" danger confirmLabel="Supprimer" onClose={() => setToDelete(null)} onConfirm={() => void onDelete()} message="Cette version du script sera définitivement supprimée." />
    </>
  );
}
