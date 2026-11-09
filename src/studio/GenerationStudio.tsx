import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle, ArrowRight, CheckCircle2, Clapperboard, Coins,
  Info, Layers3, Plus, RefreshCw, Scissors, Square,
} from 'lucide-react';
import { Banner, Button, ErrorState, LoadingState, Modal, Select } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  cancelGeneration, createProject, estimateVideo, generateScript, getJob, healthCheck, listAvatars,
  listProjects, listServices, listVideoModels, newGenerationIdempotencyKey,
  signedStorageUrl, startGeneration, uploadReferenceImage, videoStart, videoStatus,
} from '../lib/api';
import { asAppError } from '../lib/errors';
import type {
  Avatar, GenerationJob, MuApiModel, Project, ServiceCatalogItem, VideoActionResult,
  VideoCostEstimate,
} from '../lib/types';
import { CostConfirm } from './components/CostConfirm';
import { GenerationEmptyState } from './components/GenerationEmptyState';
import { AfterGeneration } from './components/AfterGeneration';
import { PromptBar, initialFormState, type GenerationFormState } from './components/PromptBar';
import { StudioTopBar } from './components/StudioTopBar';
import { TrackingPanel } from './components/PreviewStage';
import { trackingState } from './tracking';
import { modelFamily, type ParamValue } from './model';
import {
  QUALITY_TIERS, buildCompatibleParams, defaultSettingsFor, modelForQuality, serviceForQuality,
} from './quality';
import {
  PLAN_VERSION, CREATION_MODES, buildLocalPlan, mapAiScriptToPlan, planToEditorProject,
  validateProductionPlan, type ProductionPlan, type SectorId,
} from './plan';
import { loadLocalDraft, saveLocalDraft as createLocalEditorDraft } from './editor/persistence';

const ACTIVE = ['queued', 'reserved', 'processing'];
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
function asParams(v: unknown): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [k, raw] of Object.entries(asRecord(v))) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') out[k] = raw;
  }
  return out;
}

export default function GenerationStudio() {
  const toast = useToast();
  const navigate = useNavigate();
  const { workspaceId, quota, refreshQuota } = useAuth();
  const [search] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [models, setModels] = useState<MuApiModel[]>([]);
  const [services, setServices] = useState<ServiceCatalogItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [health, setHealth] = useState<Record<string, boolean> | null>(null);
  const [form, setForm] = useState<GenerationFormState>(initialFormState);
  const [projectId, setProjectId] = useState(search.get('projet') ?? '');
  const [projectModal, setProjectModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [estimate, setEstimate] = useState<VideoCostEstimate | null>(null);
  const [aiPlan, setAiPlan] = useState<ProductionPlan | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessage, setAiMessage] = useState('');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [key, setKey] = useState(() => newGenerationIdempotencyKey());
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [providerState, setProviderState] = useState('');
  const [result, setResult] = useState<VideoActionResult | null>(null);
  const [finishedJob, setFinishedJob] = useState<GenerationJob | null>(null);
  const [runError, setRunError] = useState('');
  const pollRef = useRef<number | null>(null);
  const fromEditor = search.get('fromEditor') === '1';
  const resumeJob = search.get('job');
  const preserveEditorAspect = useRef(fromEditor);

  const patch = useCallback((p: Partial<GenerationFormState>) => setForm((f) => ({ ...f, ...p })), []);
  const balance = quota?.credits ?? 0;

  const modeDef = CREATION_MODES.find((m) => m.id === form.mode) ?? CREATION_MODES[0];
  const generationMode = modeDef.mode;
  const model = useMemo(() => modelForQuality(models, generationMode, form.quality), [models, generationMode, form.quality]);
  const service = useMemo(() => serviceForQuality(services, form.quality), [services, form.quality]);
  const compatible = useMemo(() => buildCompatibleParams(model, {
    ratio: form.ratio, resolution: form.resolution, duration: form.duration, extras: form.extras,
  }), [model, form.ratio, form.resolution, form.duration, form.extras]);

  const localPlan = useMemo(() => buildLocalPlan({
    prompt: form.prompt, script: form.script,
    ratio: (['9:16', '1:1', '16:9'].includes(form.ratio) ? form.ratio : '9:16') as ProductionPlan['ratio'],
    subtitles: form.subtitles,
  }), [form.prompt, form.script, form.ratio, form.subtitles]);
  const validated = useMemo(() => validateProductionPlan(localPlan), [localPlan]);
  const plan = aiPlan ?? (validated.ok ? validated.plan : localPlan);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const [p, svc, m, av] = await Promise.all([
        listProjects(), listServices(), listVideoModels().catch(() => [] as MuApiModel[]),
        workspaceId ? listAvatars(workspaceId).catch(() => [] as Avatar[]) : Promise.resolve([] as Avatar[]),
      ]);
      setProjects(p); setServices(svc.filter((s) => s.active)); setModels(m); setAvatars(av);
      setProjectId((current) => current || p[0]?.id || '');
      try { setHealth((await healthCheck()).configured); } catch { setHealth(null); }
    } catch (err) { setLoadError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);

  // Reuse an existing job's real parameters (no invented values).
  useEffect(() => {
    const reuse = search.get('reuse');
    if (!reuse) return;
    let active = true;
    void getJob(reuse).then((j) => {
      if (!active || !j) return;
      const p = asRecord(j.request_payload);
      const params = asParams(p.params);
      const q = QUALITY_TIERS.find((t) => t.serviceKey === j.service_key)?.id;
      setForm((f) => ({
        ...f, prompt: String(p.visual_prompt ?? f.prompt).slice(0, 4000),
        script: String(p.script_text ?? f.script).slice(0, 4000),
        mode: p.creation_mode === 'script' || p.creation_mode === 'product' || p.creation_mode === 'avatar'
          ? p.creation_mode as GenerationFormState['mode'] : f.mode,
        quality: q ?? f.quality,
        ratio: typeof params.aspect_ratio === 'string' ? params.aspect_ratio : f.ratio,
        resolution: typeof params.resolution === 'string' ? params.resolution : f.resolution,
        duration: typeof params.duration === 'number' ? params.duration : f.duration,
        extras: params,
      }));
      setProjectId(j.project_id ?? '');
      toast.info('Paramètres de la génération rechargés. Vérifiez le devis avant de lancer.');
    }).catch(() => undefined);
    return () => { active = false; };
  }, [search, toast]);

  // Restore a general brief / scene edits made in the editor. The draft is
  // structured editor data, never a raw model answer sent to the provider.
  useEffect(() => {
    if (!fromEditor) return;
    const draft = loadLocalDraft();
    if (!draft) return;
    const mode = CREATION_MODES.find((m) => m.id === draft.mode)?.id ?? 'idea';
    const quality = QUALITY_TIERS.find((q) => q.id === draft.quality)?.id ?? 'standard';
    setForm((f) => ({
      ...f,
      prompt: draft.prompt.slice(0, 4000),
      script: draft.scenes.map((s) => s.spokenText.trim()).filter(Boolean).join('\n').slice(0, 4000),
      mode, quality, ratio: draft.aspect, subtitles: draft.subtitlesEnabled,
    }));
    if (draft.projectId) setProjectId(draft.projectId);
    toast.info('Demande et scènes reprises depuis l’éditeur. Vérifiez le devis avant de lancer.');
  }, [fromEditor, toast]);

  // Apply the model's REAL declared defaults whenever the derived model changes.
  useEffect(() => {
    if (!model) return;
    const d = defaultSettingsFor(model);
    setForm((f) => ({
      ...f,
      ratio: preserveEditorAspect.current ? f.ratio : d.ratio,
      resolution: d.resolution, duration: d.duration, extras: {},
    }));
    preserveEditorAspect.current = false;
  }, [model?.model_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!service || !model) { setEstimate(null); return; }
    let active = true;
    estimateVideo(service.service_key, model.model_id)
      .then((e) => { if (active) setEstimate(e); })
      .catch(() => { if (active) setEstimate(null); });
    return () => { active = false; };
  }, [service?.service_key, model?.model_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const cost = estimate?.credits_cost ?? null;
  const issues = useMemo(() => {
    const out: string[] = [];
    if (!model) out.push('Aucun modèle MuAPI compatible disponible pour ce mode.');
    if (!service) out.push('Service de crédits indisponible pour cette qualité.');
    if (form.prompt.trim().length < 20) out.push('Décrivez votre vidéo en au moins 20 caractères.');
    if (!projectId) out.push('Sélectionnez ou créez un projet.');
    if (!estimate) out.push('Devis serveur en cours…');
    else {
      if (!estimate.service_active) out.push('Le service de crédits est inactif.');
      if (!estimate.model_available) out.push('Le modèle MuAPI sélectionné n’est plus disponible.');
      if (estimate.credits_cost > balance) out.push('Crédits UGC insuffisants pour cette réservation.');
    }
    if (health?.muapi === false) out.push('Secret serveur MUAPI_API_KEY absent : une génération réelle ne peut pas aboutir.');
    if (form.mode === 'product' && !form.referenceFile) out.push('Importez une image de produit.');
    if (form.mode === 'avatar' && !form.avatarId) out.push('Choisissez un avatar existant.');
    if (form.referenceFile && form.referenceFile.size > MAX_REFERENCE_BYTES) out.push('Image trop volumineuse (8 Mo maximum).');
    if (starting || (jobId && ACTIVE.includes(status))) out.push('Une génération est déjà en cours.');
    return out;
  }, [model, service, form.prompt, form.mode, form.referenceFile, form.avatarId, projectId, estimate, balance, health, starting, jobId, status]);
  const blockedReason = issues[0] ?? '';

  const applyResult = useCallback((r: VideoActionResult) => {
    setResult(r);
    if (r.status) setStatus(r.status);
    if (r.provider_state) setProviderState(r.provider_state);
    if (r.status === 'failed') setRunError(r.error || r.message || 'La génération a échoué. Les crédits réservés ont été restitués.');
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => () => stopPolling(), [stopPolling]);

  const poll = useCallback(async (id: string) => {
    try {
      const r = await videoStatus(id);
      applyResult(r);
      if (['succeeded', 'failed', 'cancelled'].includes(r.status)) {
        stopPolling();
        await refreshQuota();
        void getJob(id).then((j) => { if (j) setFinishedJob(j); }).catch(() => undefined);
      }
    } catch (err) { setRunError(asAppError(err).message); }
  }, [applyResult, refreshQuota, stopPolling]);

  const startPolling = useCallback((id: string) => {
    stopPolling(); void poll(id);
    pollRef.current = window.setInterval(() => void poll(id), 6000);
  }, [poll, stopPolling]);

  // Resume an existing server-side job from History / Library. No new
  // reservation, no new provider call, no fabricated result.
  useEffect(() => {
    if (!resumeJob || jobId) return;
    let active = true;
    void getJob(resumeJob).then(async (j) => {
      if (!active || !j) return;
      const rp = asRecord(j.result_payload);
      const storagePath = typeof rp.storage_path === 'string' ? rp.storage_path : '';
      let previewUrl = typeof rp.preview_url === 'string' ? rp.preview_url : null;
      if (!previewUrl && storagePath) {
        try { previewUrl = await signedStorageUrl(storagePath, 3600); } catch { previewUrl = null; }
      }
      const r: VideoActionResult = {
        job_id: j.id, status: j.status,
        provider: j.provider ?? undefined,
        provider_job_id: j.provider_job_id,
        preview_url: previewUrl,
        storage_path: storagePath || undefined,
        error: j.error_message,
        message: j.status === 'succeeded' ? 'Résultat réel rechargé depuis votre espace privé.' : undefined,
      };
      if (!active) return;
      setJobId(j.id); setFinishedJob(j); applyResult(r);
      if (ACTIVE.includes(j.status)) { startPolling(j.id); toast.info('Suivi serveur repris. Aucun nouveau débit.'); }
    }).catch((err) => { if (active) setRunError(asAppError(err).message); });
    return () => { active = false; };
  }, [resumeJob, jobId, applyResult, startPolling, toast]);

  const onCancel = async () => {
    if (!jobId) return;
    try {
      await cancelGeneration(jobId); stopPolling(); setStatus('cancelled');
      setResult((r) => r ? { ...r, status: 'cancelled', message: 'Génération annulée, crédits restitués.' } : null);
      await refreshQuota(); toast.success('Génération annulée, crédits réservés restitués.');
    } catch (err) { toast.error(asAppError(err).message); }
  };

  const onConfirm = async () => {
    if (blockedReason || !model || !service || !projectId) { toast.warning(blockedReason || 'Complétez la configuration.'); return; }
    setStarting(true); setConfirmOpen(false); setRunError(''); setResult(null);
    try {
      let reference: Record<string, unknown> = {};
      if (form.mode === 'product' && form.referenceFile && workspaceId) {
        const path = await uploadReferenceImage(workspaceId, form.referenceFile);
        reference = { image_storage_path: path, image_url: await signedStorageUrl(path, 86400) };
      }
      if (form.mode === 'avatar' && form.avatarId) {
        const avatar = avatars.find((a) => a.id === form.avatarId);
        const url = avatar?.preview_url || (avatar?.preview_storage_path ? await signedStorageUrl(avatar.preview_storage_path, 86400) : '');
        reference = { avatar_id: form.avatarId, image_url: url, ...(avatar?.preview_storage_path ? { image_storage_path: avatar.preview_storage_path } : {}) };
      }
      const prompt = form.prompt.trim();
      const payload = {
        provider: 'muapi', ui_version: 'reelora-video-studio-v2',
        mode: generationMode, creation_mode: form.mode, quality: form.quality,
        sector: plan.sector, model_id: model.model_id, params: compatible,
        visual_prompt: prompt,
        script_text: (form.script.trim() || prompt).slice(0, 4000),
        subtitles: form.subtitles,
        plan_version: PLAN_VERSION, plan_source: plan.source,
        plan_scenes: plan.scenes.map((s) => ({ role: s.role, label: s.label, duration_seconds: s.durationSeconds, visual_prompt: s.visualPrompt, subtitle: s.subtitle })),
        ...reference,
      };
      const id = await startGeneration(projectId, service.service_key, payload, key);
      setJobId(id); setStatus('reserved'); setProviderState('');
      const r = await videoStart(id);
      applyResult(r);
      if (r.status === 'failed') await refreshQuota();
      else { toast.info('Génération soumise à MuAPI. Le suivi continue côté serveur.'); startPolling(id); }
    } catch (err) {
      setStatus('failed'); setRunError(asAppError(err).message); await refreshQuota();
    } finally { setStarting(false); }
  };

  const resetRun = () => {
    stopPolling(); setJobId(null); setStatus(''); setProviderState('');
    setResult(null); setFinishedJob(null); setRunError(''); setKey(newGenerationIdempotencyKey());
  };

  const editorProject = useCallback(() => planToEditorProject(plan, {
    quality: form.quality, mode: form.mode, model, subtitles: form.subtitles, projectId: projectId || null,
  }), [plan, form.quality, form.mode, form.subtitles, model, projectId]);

  const openEditor = (attach = false) => {
    let project = editorProject();
    if (attach && result?.preview_url && project.scenes.length) {
      project = {
        ...project,
        scenes: project.scenes.map((s, i) => i === 0 ? {
          ...s,
          source: { kind: result.storage_path ? 'asset' as const : 'job' as const, name: 'Vidéo générée', url: result.preview_url!, jobId: jobId ?? undefined },
        } : s),
      };
    }
    createLocalEditorDraft(project);
    navigate(attach && jobId ? `/app/studio/montage?draft=1&job=${jobId}` : '/app/studio/montage?draft=1');
  };

  const onExample = (_sector: SectorId, example: string) => {
    setForm((f) => ({ ...f, prompt: example }));
    toast.info('Exemple chargé : personnalisez-le avant de confirmer le devis.');
    document.getElementById('studio-prompt')?.focus();
  };

  const onAiPlan = async () => {
    if (health?.groq !== true) { toast.warning('Assistance IA indisponible : GROQ_API_KEY absent côté serveur. Aucune réponse n’est simulée.'); return; }
    setAiBusy(true); setAiMessage('');
    try {
      const script = await generateScript({ product: plan.product || 'le produit', brief: form.prompt.slice(0, 800), duration: plan.totalDuration, language: 'fr' });
      const mapped = mapAiScriptToPlan(script, localPlan);
      if (!mapped.ok) { setAiMessage(`Plan IA rejeté par la validation structurée : ${mapped.errors.join(' ')}`); toast.warning('Plan IA invalide, aucune donnée transmise au fournisseur.'); return; }
      setAiPlan(mapped.plan);
      setAiMessage(`Plan Groq validé : ${mapped.plan.scenes.length} scènes. Relisez chaque plan avant de générer.`);
      toast.success('Plan IA validé et chargé.');
    } catch (err) { setAiMessage(asAppError(err).message); toast.error(asAppError(err).message); }
    finally { setAiBusy(false); }
  };

  const onCreateProject = async () => {
    if (!newTitle.trim()) return;
    try {
      const id = await createProject({ title: newTitle.trim(), aspect_ratio: '9:16', brief: form.prompt.slice(0, 500) });
      setProjects(await listProjects()); setProjectId(id); setProjectModal(false); setNewTitle('');
      toast.success('Projet créé avec les règles RLS et quotas existantes.');
    } catch (err) { toast.error(asAppError(err).message); }
  };

  if (loading) return <div className="studio-v2"><StudioTopBar /><LoadingState label="Préparation du Video Generation Studio…" /></div>;
  if (loadError) return <div className="studio-v2"><StudioTopBar /><ErrorState message={loadError} onRetry={() => void load()} /></div>;

  const tracking = trackingState(status, providerState);
  const showEmpty = !form.prompt.trim() && !jobId && !result;

  return (
    <div className="studio-v2 animate-fadeUp pb-2">
      <StudioTopBar />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[11px] text-slate-400">
            <Clapperboard size={12} className="text-cyan-300" /> Catalogue MuAPI vérifié · {models.length} modèles actifs
          </span>
          <Link to="/app/studio/classique" className="studio-icon-link">Parcours détaillé</Link>
          <Link to="/app/studio/avance" className="studio-icon-link">Parcours 5 étapes</Link>
          <Link to="/app/studio/montage" className="studio-icon-link"><Scissors size={12} /> AI Video Editor</Link>
        </div>
        <div className="flex items-center gap-2">
          <Select id="studio-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-auto min-w-[170px] text-xs" aria-label="Projet">
            <option value="">Choisir un projet…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </Select>
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setProjectModal(true)}>Nouveau</Button>
        </div>
      </div>

      {health?.muapi === false && (
        <div className="mt-3"><Banner tone="warning" title="Secret MuAPI absent">
          La génération réelle ne peut pas aboutir. Ajoutez le secret serveur MUAPI_API_KEY dans Supabase ; aucun résultat n’est simulé.
        </Banner></div>
      )}
      {health?.muapi !== false && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-300"><CheckCircle2 size={12} /> MuAPI configuré côté serveur · validité fournisseur non vérifiée sans génération réelle.</p>
      )}

      {showEmpty && <div className="mt-5"><GenerationEmptyState onExample={onExample} onStart={() => document.getElementById('studio-prompt')?.focus()} /></div>}

      {/* Production plan from a SINGLE prompt */}
      {!showEmpty && (
        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-300">Plan de production · {plan.source === 'ai' ? 'Groq validé' : 'local déterministe'}</p>
                <h2 className="mt-1 text-lg font-semibold text-white">{plan.product || 'Votre publicité UGC'}</h2>
                <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400 line-clamp-2">{form.prompt}</p>
              </div>
              <span className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.07] px-2.5 py-1 text-[11px] text-cyan-200">{plan.scenes.length} scènes · {plan.totalDuration.toFixed(0)} s · {plan.ratio}</span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {plan.scenes.map((s, i) => (
                <div key={`${s.role}-${i}`} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-white">{i + 1}. {s.label}</span>
                    <span className="text-[10px] text-cyan-300">{s.durationSeconds} s</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-400">{s.visualPrompt}</p>
                  {s.subtitle && <p className="mt-1.5 text-[10px] italic text-slate-500">« {s.subtitle} »</p>}
                </div>
              ))}
            </div>
            {plan.warnings.length > 0 && (
              <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                <AlertCircle size={11} className="mr-1 inline" /> {plan.warnings.join(' ')}
              </div>
            )}
            {!validated.ok && <p className="mt-2 text-[11px] text-rose-300">Plan local invalide : {validated.errors.join(' ')}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" icon={<Scissors size={13} />} onClick={() => openEditor(false)}>Ouvrir le plan dans l’éditeur</Button>
              {aiPlan && <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => { setAiPlan(null); setAiMessage(''); }}>Revenir au plan local</Button>}
            </div>
          </div>

          <div className="space-y-3">
            <div className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4">
              <p className="text-[11px] font-semibold text-white">Devis serveur</p>
              <div className="mt-3 space-y-2 text-[11px]">
                <div className="flex justify-between gap-2"><span className="text-slate-500">Qualité</span><span className="text-white">{QUALITY_TIERS.find((q) => q.id === form.quality)?.label}</span></div>
                <div className="flex justify-between gap-2"><span className="text-slate-500">Modèle</span><span className="text-right text-white">{model ? modelFamily(model) : '—'}</span></div>
                <div className="flex justify-between gap-2"><span className="text-slate-500">Service</span><span className="text-right text-white">{service?.display_name ?? '—'}</span></div>
                <div className="flex justify-between gap-2"><span className="text-slate-500">Crédits UGC</span><span className="font-bold text-cyan-300">{cost ?? '…'}</span></div>
                <div className="flex justify-between gap-2"><span className="text-slate-500">Coût fournisseur</span><span className="text-white">{estimate?.provider_cost_usd ?? '—'} {estimate?.provider_cost_currency ?? ''}</span></div>
                <div className="flex justify-between gap-2"><span className="text-slate-500">Solde après réservation</span><span className="text-white">{cost !== null ? Math.max(0, balance - cost) : '—'}</span></div>
              </div>
              <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-500"><Info size={11} className="mt-0.5 shrink-0" /> Le coût provient du backend (catalogue des services). Réservation avant envoi, capture uniquement après succès, restitution sur échec.</p>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4">
              <p className="text-[11px] font-semibold text-white">Paramètres réellement envoyés</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(compatible).map(([k, v]) => <span key={k} className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10px] text-slate-300">{k} : {String(v)}</span>)}
                {Object.keys(compatible).length === 0 && <span className="text-[11px] text-slate-500">Prompt uniquement.</span>}
              </div>
              <p className="mt-2 text-[10px] text-slate-600">Dérivés de <code>param_schema ∩ input_fields</code> du catalogue vérifié.</p>
            </div>
          </div>
        </div>
      )}

      {jobId && (
        <div className="mt-4">
          <TrackingPanel tracking={tracking} providerState={providerState} requestId={finishedJob?.provider_job_id ?? null} />
          {ACTIVE.includes(status) && (
            <button type="button" onClick={() => void onCancel()} className="studio-chip mt-2 text-rose-200">
              <Square size={11} /> Annuler et restituer les crédits
            </button>
          )}
        </div>
      )}
      {runError && <div className="mt-3"><Banner tone="danger" title="Génération interrompue">{runError}</Banner></div>}

      {result && (
        <div className="mt-4"><AfterGeneration result={result} job={finishedJob}
          onRegenerate={resetRun}
          onEditScript={() => { resetRun(); patch({ mode: 'script', script: form.script || form.prompt }); toast.info('Modifiez le script puis confirmez le nouveau devis.'); }}
          onVariant={() => { resetRun(); toast.info('Ajustez votre instruction ou la qualité, puis confirmez le nouveau devis.'); }}
          onEditor={() => openEditor(true)} /></div>
      )}

      <PromptBar state={form} onPatch={patch} model={model} services={services} estimate={estimate}
        balance={balance} blockedReason={blockedReason} busy={starting || confirmOpen}
        onGenerate={() => setConfirmOpen(true)} health={health} avatars={avatars}
        onAiPlan={() => void onAiPlan()} aiBusy={aiBusy} aiMessage={aiMessage} />

      {model && estimate && (
        <CostConfirm open={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={() => void onConfirm()}
          model={model} estimate={estimate} balance={balance} params={compatible}
          loading={starting} blockedReason={blockedReason} />
      )}

      <Modal open={projectModal} onClose={() => setProjectModal(false)} title="Nouveau projet UGC" size="sm"
        description="Utilise la RPC, les quotas et les RLS existants. Aucune table ni politique modifiée."
        footer={<><Button variant="ghost" onClick={() => setProjectModal(false)}>Annuler</Button><Button onClick={() => void onCreateProject()}>Créer le projet</Button></>}>
        <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Ex. Campagne Sérum Éclat" className="studio-input" />
      </Modal>

      <p className="mt-4 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-600">
        <Layers3 size={11} /> Les visuels de secteur sont des images d’inspiration intégrées au projet, pas des générations vidéo.
        <Coins size={11} className="ml-2" /> Crédits UGC uniquement : le Business Growth Workspace n’est pas concerné.
        <Link to="/app/historique" className="ml-2 inline-flex items-center gap-1 text-cyan-400/70 hover:text-cyan-300">Historique <ArrowRight size={10} /></Link>
      </p>
    </div>
  );
}
