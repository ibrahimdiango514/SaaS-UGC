import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Clapperboard, Coins, Download,
  Film, Image as ImageIcon, Loader2, Play, Plus, RefreshCw, Sparkles, Square, Wand2, XCircle,
} from 'lucide-react';
import {
  PageHeader, Card, CardHeader, Button, Input, Textarea, Select, Badge, Banner,
  ProgressBar, ConfirmDialog, Modal, LoadingState, ErrorState, EmptyState,
} from '../components/ui';
import { providerQuoteCostLabel } from '../studio/model';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { creditSummary } from '../studio/catalog';
import {
  cancelGeneration, createProject, estimateVideo, generateScenes, generateScript, healthCheck,
  listAssets, listAvatars, listJobs, listProjects, listScripts, listServices, listVideoModels,
  newGenerationIdempotencyKey, saveScript, saveScenes, startGeneration, videoStart, videoStatus,
} from '../lib/api';
import type {
  AiScene, Avatar, GeneratedAsset, GenerationJob, MuApiModel, Project, Script,
  ServiceCatalogItem, VideoActionResult, VideoCostEstimate,
} from '../lib/types';

type ParamValue = string | number | boolean;

const STEPS = [
  { n: 1, label: 'Projet & produit' },
  { n: 2, label: 'Script IA' },
  { n: 3, label: 'Scènes & prompts' },
  { n: 4, label: 'Modèle MuAPI' },
  { n: 5, label: 'Coût & lancement' },
] as const;

const OBJECTIVES = [
  'Notoriété de marque', 'Conversion / ventes', 'Lancement de produit',
  'Trafic qualifié', 'Démonstration produit', 'Preuve sociale / témoignage',
];

function defaultParams(model: MuApiModel | undefined): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, def] of Object.entries(model?.param_schema ?? {})) {
    if (def.default !== undefined) out[key] = def.default;
  }
  return out;
}

export default function Studio({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast();
  const { workspaceId, quota, refreshQuota } = useAuth();
  const [params] = useSearchParams();
  const [step, setStep] = useState(1);

  const [projects, setProjects] = useState<Project[]>([]);
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [services, setServices] = useState<ServiceCatalogItem[]>([]);
  const [models, setModels] = useState<MuApiModel[]>([]);
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [health, setHealth] = useState<Record<string, boolean> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // 1. Projet publicitaire, produit et objectif.
  const [projectId, setProjectId] = useState(params.get('projet') ?? '');
  const [productName, setProductName] = useState('');
  const [productInfo, setProductInfo] = useState('');
  const [objective, setObjective] = useState(OBJECTIVES[0]);
  const [audience, setAudience] = useState('');
  const [platform, setPlatform] = useState('TikTok');
  const [brief, setBrief] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  // 2. Script Groq.
  const [scriptText, setScriptText] = useState('');
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [generatingScript, setGeneratingScript] = useState(false);

  // 3. Scènes / prompts.
  const [scenes, setScenes] = useState<AiScene[]>([]);
  const [visualPrompt, setVisualPrompt] = useState('');
  const [generatingScenes, setGeneratingScenes] = useState(false);

  // 4. Modèle MuAPI + paramètres réellement supportés.
  const [modelId, setModelId] = useState('');
  const [paramValues, setParamValues] = useState<Record<string, ParamValue>>({});
  const [avatarId, setAvatarId] = useState('');
  const [imageUrl, setImageUrl] = useState('');

  // 5. Coût, confirmation, suivi.
  const [serviceKey, setServiceKey] = useState('');
  const [estimate, setEstimate] = useState<VideoCostEstimate | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(params.get('job') ?? null);
  const [status, setStatus] = useState('');
  const [providerState, setProviderState] = useState('');
  const [progress, setProgress] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [runError, setRunError] = useState('');
  const [starting, setStarting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newGenerationIdempotencyKey());
  const pollRef = useRef<number | null>(null);

  const selectedModel = useMemo(() => models.find((m) => m.model_id === modelId), [models, modelId]);
  const selectedService = useMemo(() => services.find((s) => s.service_key === serviceKey), [services, serviceKey]);
  const requiresExactQuote = Boolean(selectedModel?.dynamic_pricing);
  const summary = creditSummary(estimate, quota?.credits ?? 0, requiresExactQuote);
  const credits = summary.creditsCost;
  const creditsLabel = credits !== null ? `${credits} crédits` : 'devis en cours';
  const paramsKey = JSON.stringify(paramValues);
  const needsImage = Boolean(selectedModel?.required_fields.includes('image_url'));
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const [p, s, svc, m, a, j] = await Promise.all([
        listProjects(), listScripts(), listServices(), listVideoModels(),
        listAssets(6), listJobs(20),
      ]);
      setProjects(p); setScripts(s); setServices(svc.filter((x) => x.active));
      setModels(m.filter((x) => x.is_enabled && !x.is_coming_soon)); setAssets(a); setJobs(j);
      try { setHealth((await healthCheck()).configured); } catch { setHealth(null); }
      if (workspaceId) {
        const av = await listAvatars(workspaceId);
        setAvatars(av.filter((x) => x.status === 'active'));
      }
      const pid = params.get('projet') ?? '';
      if (pid) {
        const project = p.find((x) => x.id === pid);
        const latest = s.find((x) => x.project_id === pid && x.status === 'approved') ?? s.find((x) => x.project_id === pid);
        if (latest) { setScriptText(latest.script_text); setScriptId(latest.id); }
        if (project) {
          setBrief(project.brief ?? ''); setObjective(project.campaign_objective ?? OBJECTIVES[0]);
          setAudience(project.target_audience ?? ''); setPlatform(project.platform ?? 'TikTok');
        }
      }
      const def = svc.find((x) => x.service_key === 'ugc_clip_15s') ?? svc.find((x) => x.service_key.includes('clip'));
      if (def) setServiceKey(def.service_key);
      if (m.length) setModelId((current) => current || (m.find((x) => x.model_id === 'seedance-lite-t2v')?.model_id ?? m[0].model_id));
    } catch (err) { setLoadError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [workspaceId, params]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => { setParamValues(defaultParams(selectedModel)); }, [selectedModel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!serviceKey || !modelId) { setEstimate(null); return; }
    let active = true;
    estimateVideo(serviceKey, modelId, {
      params: paramValues, prompt: visualPrompt.trim() || scriptText.trim(),
      image_url: imageUrl.trim(), param_schema: selectedModel?.param_schema,
    }).then((e) => { if (active) setEstimate(e); }).catch(() => { if (active) setEstimate(null); });
    return () => { active = false; };
  }, [serviceKey, modelId, paramsKey, visualPrompt, scriptText, imageUrl, selectedModel?.param_schema]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => () => stopPolling(), [stopPolling]);

  const applyResult = useCallback((r: VideoActionResult) => {
    setStatus(r.status); setProviderState(r.provider_state ?? '');
    setProgress(r.progress ?? (r.status === 'succeeded' ? 100 : r.status === 'processing' ? 55 : 20));
    if (r.preview_url) setPreviewUrl(r.preview_url);
    if (r.status === 'failed') setRunError(r.error || r.message || 'La génération a échoué. Les crédits réservés ont été restitués.');
  }, []);

  const poll = useCallback(async (id: string) => {
    try {
      const r = await videoStatus(id);
      applyResult(r);
      if (['succeeded', 'failed', 'cancelled'].includes(r.status)) {
        stopPolling();
        await refreshQuota();
        if (r.status === 'succeeded') toast.success('Vidéo MuAPI générée et ajoutée à la bibliothèque.');
      }
    } catch (err) { setRunError(asAppError(err).message); }
  }, [applyResult, refreshQuota, stopPolling, toast]);

  const startPolling = useCallback((id: string) => {
    stopPolling(); void poll(id);
    pollRef.current = window.setInterval(() => void poll(id), 6000);
  }, [poll, stopPolling]);

  // Reprise sécurisée : un job déjà lancé est suivi même après rechargement de la page.
  const resumeJobId = params.get('job');
  const startPollingRef = useRef(startPolling);
  startPollingRef.current = startPolling;
  useEffect(() => {
    if (!resumeJobId) return;
    setJobId(resumeJobId); setStep(5);
    startPollingRef.current(resumeJobId);
    return () => stopPolling();
  }, [resumeJobId, stopPolling]);

  const onCreateProject = async () => {
    if (!newTitle.trim()) { toast.warning('Nommez votre projet publicitaire.'); return; }
    setCreating(true);
    try {
      const id = await createProject({
        title: newTitle, brief: brief || undefined, platform, language: 'fr', aspect_ratio: '9:16',
        campaign_objective: objective, target_audience: audience || undefined,
      });
      setProjectId(id); setCreateOpen(false); setNewTitle('');
      toast.success('Projet créé. Renseignez maintenant le produit et le script.');
      await load();
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setCreating(false); }
  };

  const onGenerateScript = async () => {
    if (!productName.trim()) { toast.warning('Renseignez le nom du produit.'); setStep(1); return; }
    setGeneratingScript(true);
    try {
      const r = await generateScript({
        project_id: projectId || null, product: productName, audience, platform,
        objective, market: '', brief: [productInfo, brief].filter(Boolean).join(' · '),
        duration: 15, tone: 'authentique UGC', language: 'fr',
      });
      setScriptText(r.script_text); setScriptId(r.script_id ?? null);
      if (r.scenes?.length) { setScenes(r.scenes); setVisualPrompt(r.scenes[0]?.visual_prompt ?? ''); }
      toast.success('Script généré avec Groq. Relisez-le avant de continuer.');
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setGeneratingScript(false); }
  };

  const onGenerateScenes = async () => {
    if (scriptText.trim().length < 20) { toast.warning('Un script est nécessaire.'); return; }
    setGeneratingScenes(true);
    try {
      const r = await generateScenes({ project_id: projectId || null, script_text: scriptText, duration: 15 });
      setScenes(r.scenes);
      if (!visualPrompt) setVisualPrompt(r.scenes[0]?.visual_prompt ?? '');
      toast.success(`${r.scenes.length} scènes préparées.`);
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setGeneratingScenes(false); }
  };

  const onPersist = async () => {
    if (!projectId) return;
    try {
      let sid = scriptId;
      if (scriptText.trim().length > 20) sid = await saveScript({ project_id: projectId, script_text: scriptText, language: 'fr' });
      setScriptId(sid);
      if (scenes.length) await saveScenes(projectId, scenes, sid);
      toast.success('Script et scènes enregistrés dans le projet.');
    } catch (err) { toast.error(asAppError(err).message); }
  };

  const checklist = useMemo(() => {
    const avatar = avatars.find((a) => a.id === avatarId);
    const hasImage = Boolean(imageUrl.trim() || avatar?.preview_url || avatar?.preview_storage_path);
    return [
      ['Projet publicitaire', Boolean(projectId)],
      ['Nom & infos produit', productName.trim().length > 1],
      ['Objectif publicitaire', Boolean(objective)],
      ['Script Groq ou manuel', scriptText.trim().length > 20],
      ['Scènes / prompt visuel', scenes.length > 0 || visualPrompt.trim().length > 20],
      ['Modèle MuAPI disponible', Boolean(modelId && selectedModel?.is_enabled && !selectedModel?.is_coming_soon)],
      ['Image de référence (si requise)', !needsImage || hasImage],
      ['Service & crédits suffisants', Boolean(serviceKey && selectedService?.active) && credits !== null && credits > 0 && (quota?.credits ?? 0) >= credits],
      ['Devis fournisseur confirmé', summary.canReserve && !summary.quoteToConfirm],
      ['Clé serveur MUAPI_API_KEY', Boolean(health?.muapi)],
    ] as Array<[string, boolean]>;
  }, [projectId, productName, objective, scriptText, scenes, visualPrompt, modelId, selectedModel, selectedService, needsImage, avatars, avatarId, imageUrl, serviceKey, quota, credits, health, summary.canReserve, summary.quoteToConfirm]);
  const canLaunch = checklist.every(([, ok]) => ok) && summary.canReserve && !summary.quoteToConfirm && !starting && !(jobId && !terminal);

  const onLaunch = async () => {
    if (!canLaunch || !estimate || !summary.canReserve || summary.quoteToConfirm) {
      toast.warning('Devis à confirmer ou check-list incomplète : génération non autorisée.');
      return;
    }
    setRunError(''); setPreviewUrl(null); setStarting(true);
    try {
      const payload = {
        provider: 'muapi', model_id: modelId, params: paramValues,
        script_text: scriptText, scenes, visual_prompt: visualPrompt,
        avatar_id: avatarId || null, image_url: imageUrl.trim() || null,
        product_name: productName, product_info: productInfo, campaign_objective: objective,
        target_audience: audience, platform, title: projects.find((p) => p.id === projectId)?.title ?? 'Reelora',
      };
      const id = await startGeneration(projectId, serviceKey, payload, idempotencyKey);
      setJobId(id); setStatus('reserved'); setProgress(20);
      const r = await videoStart(id);
      applyResult(r);
      if (r.status === 'failed') { await refreshQuota(); }
      else { toast.info('Génération soumise à MuAPI. Le suivi continue côté serveur.'); startPolling(id); }
    } catch (err) {
      setStatus('failed'); setRunError(asAppError(err).message); await refreshQuota();
    } finally { setStarting(false); setConfirmOpen(false); }
  };

  const onCancel = async () => {
    if (!jobId) return;
    try {
      await cancelGeneration(jobId); stopPolling(); setStatus('cancelled');
      toast.success('Génération annulée, crédits restitués.'); await refreshQuota();
    } catch (err) { toast.error(asAppError(err).message); }
  };

  const resetForNew = () => {
    stopPolling(); setJobId(null); setStatus(''); setProgress(0); setPreviewUrl(null);
    setRunError(''); setProviderState(''); setIdempotencyKey(newGenerationIdempotencyKey());
    setStep(4);
  };

  if (loading) return <LoadingState label="Préparation de l’UGC Studio…" />;
  if (loadError) return <ErrorState message={loadError} onRetry={() => void load()} />;

  const resumable = jobs.filter((j) => ['queued', 'reserved', 'processing'].includes(j.status)).slice(0, 3);

  return (
    <>
      {embedded ? (
        <div className="mb-4 flex flex-wrap justify-end gap-2">
          <Link to="/app/studio" className="btn btn-outline btn-sm">Nouveau Video Studio</Link>
          <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>Actualiser</Button>
        </div>
      ) : (
        <PageHeader eyebrow="Production · MuAPI" title="UGC Studio"
          description="Du brief produit à la vidéo réelle : script Groq, scènes, modèle MuAPI, crédits maîtrisés et suivi serveur."
          actions={<Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>Actualiser</Button>} />
      )}

      {/* Étapes — mobile-first, défilement horizontal */}
      <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
        {STEPS.map((s) => (
          <button key={s.n} type="button" onClick={() => setStep(s.n)}
            className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition ${step === s.n ? 'border-brand-400/40 bg-brand-500/15 text-brand-100' : step > s.n ? 'border-emerald-400/25 bg-emerald-400/[0.06] text-emerald-200' : 'border-line bg-white/[0.03] text-slate-500'}`}>
            <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] ${step === s.n ? 'bg-brand-500 text-white' : step > s.n ? 'bg-emerald-400/20 text-emerald-200' : 'bg-white/10'}`}>{step > s.n ? '✓' : s.n}</span>
            {s.label}
          </button>
        ))}
      </div>

      {health && !health.muapi && (
        <div className="mb-5"><Banner tone="warning" title="MuAPI n’est pas encore configuré">
          Ajoutez le secret serveur <code className="text-amber-100">MUAPI_API_KEY</code> dans les secrets Supabase Edge Functions. Il n’est jamais exposé au navigateur ni préfixé <code>VITE_</code>. Sans clé, la génération échoue explicitement et les crédits réservés sont restitués.
        </Banner></div>
      )}

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          {step === 1 && <Card>
            <CardHeader title="1 · Projet publicitaire, produit & objectif" description="Ces informations alimentent le script Groq et le prompt MuAPI."
              action={<Button size="sm" variant="outline" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>Nouveau projet</Button>} />
            <div className="space-y-4 p-5">
              <Select label="Projet" value={projectId} onChange={(e) => {
                const id = e.target.value; setProjectId(id);
                const p = projects.find((x) => x.id === id);
                const found = scripts.find((x) => x.project_id === id && x.status === 'approved') ?? scripts.find((x) => x.project_id === id);
                if (found) { setScriptText(found.script_text); setScriptId(found.id); }
                if (p) { setBrief(p.brief ?? ''); setObjective(p.campaign_objective ?? OBJECTIVES[0]); setAudience(p.target_audience ?? ''); setPlatform(p.platform ?? 'TikTok'); }
              }} hint="Le projet porte le statut brouillon → en attente → en cours → terminé.">
                <option value="">Sélectionner un projet</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.title} · {p.status}</option>)}
              </Select>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label="Nom du produit" value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="Ex. Sérum Éclat Mali" />
                <Select label="Objectif publicitaire" value={objective} onChange={(e) => setObjective(e.target.value)}>
                  {OBJECTIVES.map((o) => <option key={o}>{o}</option>)}
                </Select>
                <Input label="Audience cible" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Ex. femmes 25–40 ans, Bamako" />
                <Select label="Plateforme" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                  {['TikTok', 'Instagram Reels', 'YouTube Shorts', 'Facebook', 'LinkedIn'].map((x) => <option key={x}>{x}</option>)}
                </Select>
              </div>
              <Textarea label="Informations produit & arguments" value={productInfo} onChange={(e) => setProductInfo(e.target.value)}
                placeholder="Bénéfices, ingrédients, prix, preuves…" hint="Ces données sont transmises à Groq, jamais inventées." />
              <Textarea label="Brief de campagne" value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Ton, interdits, accroche souhaitée…" />
            </div>
          </Card>}

          {step === 2 && <Card>
            <CardHeader title="2 · Script avec Groq" description="Groq reste le fournisseur de texte : scripts, accroches, dialogues et contenus publicitaires." />
            <div className="space-y-4 p-5">
              <div className="flex flex-wrap gap-2">
                <Button icon={<Wand2 size={15} />} loading={generatingScript} onClick={() => void onGenerateScript()}>Générer le script avec Groq</Button>
                <Link to={projectId ? `/app/scripts?projet=${projectId}` : '/app/scripts'} className="btn btn-outline btn-sm"><Sparkles size={14} /> Ouvrir Scripts IA</Link>
              </div>
              <Textarea label="Script (modifiable)" value={scriptText} onChange={(e) => setScriptText(e.target.value)}
                className="min-h-[190px]" placeholder="Générez un script ou collez le vôtre…"
                hint={`${scriptText.length} caractères · minimum 20 pour lancer une vidéo`} />
              <Button variant="outline" size="sm" onClick={() => void onPersist()} disabled={!projectId}>Enregistrer dans le projet</Button>
              {!health?.groq && <Banner tone="info" title="GROQ_API_KEY absent">La génération automatique de script nécessite le secret serveur GROQ_API_KEY. Vous pouvez toujours saisir un script manuellement.</Banner>}
            </div>
          </Card>}

          {step === 3 && <Card>
            <CardHeader title="3 · Scènes & prompts visuels" description="Chaque plan devient une instruction visuelle envoyée à MuAPI." />
            <div className="space-y-4 p-5">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" icon={<Wand2 size={15} />} loading={generatingScenes} onClick={() => void onGenerateScenes()}>Découper en scènes avec Groq</Button>
                <Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={() => setScenes((s) => [...s, { scene_type: 'ugc', duration_seconds: 3, visual_prompt: '', spoken_text: '', subtitle_text: '' }])}>Ajouter un plan</Button>
              </div>
              {scenes.length === 0 && <EmptyState icon={<Film size={22} />} title="Aucune scène" description="Générez un découpage depuis le script ou ajoutez un plan manuellement." />}
              <div className="space-y-3">
                {scenes.map((s, i) => (
                  <div key={i} className="rounded-xl border border-line bg-white/[0.03] p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-brand-200">Plan {i + 1} · {s.scene_type}</span>
                      <button type="button" className="text-xs text-slate-500 hover:text-rose-300" onClick={() => setScenes((all) => all.filter((_, k) => k !== i))}>Supprimer</button>
                    </div>
                    <Textarea label="Prompt visuel" value={s.visual_prompt} onChange={(e) => setScenes((all) => all.map((x, k) => k === i ? { ...x, visual_prompt: e.target.value } : x))}
                      className="min-h-[70px]" placeholder="Ex. gros plan smartphone, main qui dévisse le flacon, lumière naturelle…" />
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      <Input label="Durée (s)" type="number" min={1} max={30} value={s.duration_seconds} onChange={(e) => setScenes((all) => all.map((x, k) => k === i ? { ...x, duration_seconds: Number(e.target.value) } : x))} />
                      <Input label="Texte parlé" value={s.spoken_text} onChange={(e) => setScenes((all) => all.map((x, k) => k === i ? { ...x, spoken_text: e.target.value } : x))} />
                    </div>
                  </div>
                ))}
              </div>
              <Textarea label="Prompt visuel global" value={visualPrompt} onChange={(e) => setVisualPrompt(e.target.value)}
                placeholder="Style général : UGC authentique, lumière naturelle, cadrage vertical…" hint="Combiné aux scènes pour construire le prompt MuAPI." />
            </div>
          </Card>}

          {step === 4 && <Card>
            <CardHeader title="4 · Modèle MuAPI & paramètres" description="Catalogue issu de GET /api/v1/models ; seuls les modèles vérifiés et actifs sont proposés." />
            <div className="space-y-4 p-5">
              {models.length === 0 && <Banner tone="warning" title="Catalogue indisponible">Le catalogue MuAPI n’a pas pu être chargé. Vérifiez le déploiement de reelora-video.</Banner>}
              <div className="grid gap-3 sm:grid-cols-2">
                {models.map((m) => (
                  <button key={m.model_id} type="button" onClick={() => setModelId(m.model_id)}
                    className={`rounded-xl border p-3 text-left transition ${modelId === m.model_id ? 'border-brand-400/60 bg-brand-500/[0.12]' : 'border-line bg-white/[0.02] hover:border-white/20'}`}>
                    <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-white">{m.display_name}</span>
                      {modelId === m.model_id && <CheckCircle2 size={15} className="text-brand-300" />}</div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{m.description}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone="info">{m.category}</Badge>
                      <Badge tone="neutral">≈ {Number(m.cost_usd ?? 0).toFixed(3)} {m.cost_currency}</Badge>
                      {m.required_fields.includes('image_url') && <Badge tone="warning">image requise</Badge>}
                    </div>
                  </button>
                ))}
              </div>

              {selectedModel && <>
                <div className="rounded-xl border border-line bg-white/[0.03] p-3 text-[11px] text-slate-400">
                  <p><span className="text-slate-300">Endpoint vérifié :</span> <code>POST {selectedModel.endpoint}</code></p>
                  <p className="mt-1"><span className="text-slate-300">Champs requis :</span> {selectedModel.required_fields.join(', ')}</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {Object.entries(selectedModel.param_schema).map(([key, def]) => (
                    <div key={key}>
                      {def.type === 'select' && <Select label={def.label ?? key} value={String(paramValues[key] ?? def.default ?? '')}
                        onChange={(e) => setParamValues((v) => ({ ...v, [key]: e.target.value }))}>
                        {(def.options ?? []).map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                      </Select>}
                      {def.type === 'number' && <Input label={def.label ?? key} type="number" min={def.min} max={def.max}
                        value={Number(paramValues[key] ?? def.default ?? def.min ?? 1)}
                        onChange={(e) => setParamValues((v) => ({ ...v, [key]: Number(e.target.value) }))} />}
                      {def.type === 'boolean' && <label className="field">
                        <span className="field-label">{def.label ?? key}</span>
                        <label className="flex items-center gap-2 text-xs text-slate-300">
                          <input type="checkbox" className="h-4 w-4 accent-brand-500" checked={Boolean(paramValues[key] ?? def.default)}
                            onChange={(e) => setParamValues((v) => ({ ...v, [key]: e.target.checked }))} /> Activer
                        </label>
                      </label>}
                    </div>
                  ))}
                </div>
              </>}

              <div className="grid gap-4 sm:grid-cols-2">
                <Select label="Image de référence (avatar / produit)" value={avatarId} onChange={(e) => { setAvatarId(e.target.value); setImageUrl(''); }}>
                  <option value="">Aucune</option>
                  {avatars.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
                <Input label="Ou URL d’image publique (HTTPS)" value={imageUrl} onChange={(e) => { setImageUrl(e.target.value); setAvatarId(''); }} placeholder="https://…" />
              </div>
              {needsImage && <p className="flex items-center gap-2 text-xs text-amber-200"><ImageIcon size={13} /> Ce modèle exige <code>image_url</code> : sélectionnez un avatar avec image ou collez une URL publique.</p>}
              {avatarId && !avatars.find((a) => a.id === avatarId)?.preview_storage_path && !avatars.find((a) => a.id === avatarId)?.preview_url && !imageUrl && (
                <Banner tone="warning" title="Image absente">Cet avatar n’a pas d’image de référence. <Link className="text-amber-100 underline" to="/app/avatars">Ajoutez-en une</Link> ou choisissez un modèle texte → vidéo.</Banner>
              )}
            </div>
          </Card>}

          {step === 5 && <Card>
            <CardHeader title="5 · Coût estimé, confirmation & lancement" description="Le coût est vérifié côté serveur et réservé atomiquement avant tout appel MuAPI." />
            <div className="space-y-4 p-5">
              <Select label="Service de génération (crédits Reelora)" value={serviceKey} onChange={(e) => setServiceKey(e.target.value)}>
                <option value="">Sélectionner un service</option>
                {services.map((s) => <option key={s.service_key} value={s.service_key}>{s.display_name} — {s.credits_cost} crédits</option>)}
              </Select>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  ['Solde disponible', `${quota?.credits ?? 0} crédits`, 'text-white'],
                  ['Coût de cette vidéo', creditsLabel, 'text-amber-300'],
                  ['Coût fournisseur estimé', providerQuoteCostLabel(estimate), estimate?.provider_quote_source === 'unavailable' ? 'text-amber-200' : 'text-cyan-300'],
                ].map(([label, value, tone]) => (
                  <div key={label} className="rounded-xl border border-line bg-white/[0.03] px-4 py-3">
                    <p className="text-[11px] text-slate-500">{label}</p>
                    <p className={`text-lg font-bold ${tone}`}>{value}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border border-brand-400/20 bg-brand-500/[0.06] px-4 py-3 text-xs leading-relaxed text-slate-300">
                Modèle : <span className="text-white">{selectedModel?.display_name ?? '—'}</span> · Réservation de <span className="text-white">{creditsLabel}</span> avant soumission.
                Débit définitif uniquement si MuAPI produit une vidéo ; restitution automatique si le fournisseur échoue, si la tâche expire ou si vous annulez à temps.
                Aucune génération ne sera facturée deux fois grâce à un identifiant d’idempotence propre à cette opération.
              </div>
              {quota && credits !== null && credits > quota.credits && <Banner tone="danger" title="Crédits insuffisants">Rechargez votre solde depuis l’abonnement avant de confirmer.</Banner>}
              {estimate && !estimate.model_available && <Banner tone="warning" title="Modèle indisponible">Ce modèle MuAPI n’est plus actif. Retournez à l’étape 4.</Banner>}
              <div className="flex flex-wrap gap-2">
                <Button size="lg" icon={<Play size={16} />} loading={starting} disabled={!canLaunch} onClick={() => setConfirmOpen(true)}>Confirmer et lancer la génération</Button>
                {jobId && !terminal && <Button variant="outline" icon={<Square size={15} />} onClick={() => void onCancel()}>Annuler</Button>}
                {jobId && terminal && <Button variant="outline" icon={<RefreshCw size={15} />} onClick={resetForNew}>Nouvelle génération</Button>}
              </div>
              {!canLaunch && !jobId && <p className="text-xs text-amber-200">Complétez la check-list à droite pour activer le lancement.</p>}
            </div>
          </Card>}

          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} disabled={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))}>Précédent</Button>
            <Button variant="outline" size="sm" disabled={step === 5} onClick={() => setStep((s) => Math.min(5, s + 1))}>Étape suivante <ArrowRight size={14} /></Button>
          </div>

          {resumable.length > 0 && <Card><CardHeader title="Reprendre un suivi en cours" description="Le suivi est assuré par le serveur : ces générations continuent même page fermée." />
            <div className="space-y-2 p-5">
              {resumable.map((j) => (
                <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-xs">
                  <span className="text-slate-300">Tâche {j.id.slice(0, 8)}… <Badge status={j.status}>{j.status}</Badge></span>
                  <Button size="sm" variant="outline" onClick={() => { setJobId(j.id); setStep(5); startPolling(j.id); }}>Reprendre le suivi</Button>
                </div>
              ))}
            </div>
          </Card>}
        </div>

        <div className="space-y-5 lg:col-span-2">
          <Card><CardHeader title="Suivi & prévisualisation" description="États : brouillon, en attente, en cours, terminé, échoué, annulé." />
            {!jobId ? <EmptyState icon={<Clapperboard size={24} />} title="Aucune génération lancée" description="Confirmez à l’étape 5 pour suivre ici la tâche MuAPI." /> : (
              <div className="space-y-4 p-5">
                <div className="flex items-center gap-3">
                  {status === 'succeeded' ? <CheckCircle2 className="text-emerald-400" size={22} /> : status === 'failed' || status === 'cancelled' ? <XCircle className="text-rose-400" size={22} /> : <Loader2 className="animate-spin text-brand-300" size={22} />}
                  <div>
                    <p className="text-sm font-semibold text-white">{status === 'succeeded' ? 'Vidéo disponible' : status === 'failed' ? 'Génération échouée' : status === 'cancelled' ? 'Génération annulée' : 'Génération en cours'}</p>
                    <p className="text-xs text-slate-500">Tâche {jobId.slice(0, 8)}… · MuAPI {selectedModel?.model_id ?? ''}</p>
                  </div>
                </div>
                <ProgressBar value={progress} max={100} tone={status === 'succeeded' ? 'emerald' : status === 'failed' ? 'amber' : 'brand'} />
                <div className="flex flex-wrap gap-2">
                  <Badge status={status}>{status || 'en attente'}</Badge>
                  {providerState && <Badge tone="info">État MuAPI : {providerState}</Badge>}
                </div>
                {!terminal && <p className="rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-slate-400">
                  Progression {progress} %. Webhook MuAPI + worker serveur toutes les minutes : vous pouvez fermer cette page, la vidéo sera enregistrée dans votre bibliothèque.
                </p>}
                {runError && <Banner tone="danger" title="Erreur de génération"><AlertTriangle size={12} className="inline" /> {runError}</Banner>}
                {status === 'succeeded' && previewUrl && <div className="space-y-2">
                  <video src={previewUrl} controls playsInline preload="metadata" className="w-full rounded-xl border border-line bg-black" aria-label="Prévisualisation de la vidéo générée" />
                  <a className="btn btn-primary btn-sm w-full" href={previewUrl} download={`reelora-${jobId.slice(0, 8)}.mp4`}><Download size={14} /> Télécharger la vidéo</a>
                </div>}
                {status === 'succeeded' && <Link to="/app/bibliotheque" className="btn btn-outline btn-sm w-full"><Film size={14} /> Voir dans la bibliothèque</Link>}
                <Link to="/app/historique" className="btn btn-ghost btn-sm w-full">Consulter l’historique & le ledger</Link>
                <p className="text-[11px] leading-relaxed text-slate-600">Aucun résultat fictif : seul un fichier réellement produit par MuAPI et stocké côté serveur est ajouté à la bibliothèque.</p>
              </div>
            )}
          </Card>

          <Card><CardHeader title="Check-list de lancement" />
            <div className="space-y-2.5 p-5 text-xs">
              {checklist.map(([label, ok]) => (
                <div key={label} className="flex items-center gap-2">
                  <span className={ok ? 'text-emerald-400' : 'text-amber-400'}>{ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span>
                  <span className={ok ? 'text-slate-300' : 'text-amber-200'}>{label}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card><CardHeader title="Vos vidéos précédentes" />
            {assets.length === 0 ? <EmptyState icon={<Film size={20} />} title="Bibliothèque vide" description="Vos vidéos MuAPI apparaîtront ici." /> : (
              <div className="space-y-2 p-5">
                {assets.slice(0, 4).map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-2 rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-xs">
                    <span className="truncate text-slate-300"><Film size={12} className="mr-1 inline" /> {a.storage_path.split('/').pop()}</span>
                    <span className="shrink-0 text-slate-500">{new Date(a.created_at).toLocaleDateString('fr-FR')}</span>
                  </div>
                ))}
                <Link to="/app/bibliotheque" className="btn btn-ghost btn-sm w-full">Ouvrir la bibliothèque</Link>
              </div>
            )}
          </Card>

          <Card><CardHeader title="Crédits" />
            <div className="flex items-center justify-between gap-3 p-5">
              <div><p className="text-[11px] text-slate-500">Solde disponible</p><p className="text-xl font-bold text-white">{quota?.credits ?? 0}</p></div>
              <Coins size={22} className="text-amber-300" />
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog open={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={() => void onLaunch()}
        confirmLabel={`Confirmer · ${creditsLabel}`} loading={starting}
        title="Confirmer la génération vidéo MuAPI"
        message={`Modèle ${selectedModel?.display_name ?? modelId}. ${creditsLabel} seront réservés maintenant puis débités uniquement si MuAPI produit la vidéo. En cas d’échec, d’expiration ou d’annulation autorisée, ils seront restitués automatiquement. Un seul lancement sera facturé pour cette opération.`} />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nouveau projet publicitaire"
        description="Le projet est créé dans votre workspace avec les règles RLS et quotas existantes."
        footer={<><Button variant="ghost" onClick={() => setCreateOpen(false)}>Annuler</Button><Button loading={creating} onClick={() => void onCreateProject()}>Créer le projet</Button></>}>
        <Input label="Nom du projet" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Ex. Campagne Sérum Éclat — Novembre" />
      </Modal>
    </>
  );
}
