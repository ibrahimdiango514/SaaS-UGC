import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle, ArrowRight, CheckCircle2, Clapperboard, Clock3, Coins, Download, Film,
  FolderKanban, Image as ImageIcon, Layers3, Lock, Play, Plus, RefreshCw, Scissors, Sparkles, Square, Wand2,
} from 'lucide-react';
import {
  Badge, Banner, Button, Card, ErrorState, Input, LoadingState, Modal, Select, cn,
} from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  cancelGeneration, createProject, estimateVideo, getJob, healthCheck,
  listAssets, listJobs, listProjects, listServices, listVideoModels, newGenerationIdempotencyKey,
  signedStorageUrl, startGeneration, uploadReferenceImage, videoStart, videoStatus,
} from '../lib/api';
import { asAppError } from '../lib/errors';
import { formatDate } from '../lib/format';
import type {
  GeneratedAsset, GenerationJob, MuApiModel, Project, ServiceCatalogItem,
  VideoActionResult, VideoCostEstimate,
} from '../lib/types';
import { CostConfirm, CostSummary } from './components/CostConfirm';
import { DynamicParams, ReferenceUploader } from './components/DynamicParams';
import { ModelCatalog } from './components/ModelCatalog';
import { PreviewStage, TrackingPanel } from './components/PreviewStage';
import { EMPTY_STRUCTURE, PromptComposer, type StructuredPrompt } from './components/PromptComposer';
import { StudioShell } from './components/StudioShell';
import {
  MODE_DESCRIPTIONS, MODE_LABELS, defaultParams, isModelAvailable, modelFamily,
  modelModes, modelsForMode, paramsSummary, type GenerationMode, type ParamValue,
} from './model';
import { trackingState } from './tracking';

const VALID_MODES: GenerationMode[] = ['text-to-video', 'image-to-video', 'video-to-video'];
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const ACTIVE_STATUSES = ['queued', 'reserved', 'processing'];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asParamValues(value: unknown): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') out[key] = raw;
  }
  return out;
}

function validateImage(file: File): string {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return 'Format accepté : PNG, JPEG ou WebP.';
  if (file.size > MAX_REFERENCE_BYTES) return 'Image trop volumineuse (8 Mo maximum).';
  return '';
}

export default function VideoStudio() {
  const toast = useToast();
  const { workspaceId, quota, refreshQuota } = useAuth();
  const [params, setParams] = useSearchParams();
  const jobParam = params.get('job');
  const reuseParam = params.get('reuse');
  const initialMode = VALID_MODES.includes(params.get('mode') as GenerationMode) ? params.get('mode') as GenerationMode : 'text-to-video';
  const initialProjectRef = useRef(params.get('projet') ?? '');
  const initialModelRef = useRef(params.get('model') ?? '');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [models, setModels] = useState<MuApiModel[]>([]);
  const [services, setServices] = useState<ServiceCatalogItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [health, setHealth] = useState<Record<string, boolean> | null>(null);

  const [mode, setMode] = useState<GenerationMode>(initialMode);
  const [modelId, setModelId] = useState('');
  const [paramValues, setParamValues] = useState<Record<string, ParamValue>>({});
  const [prompt, setPrompt] = useState('');
  const [structure, setStructure] = useState<StructuredPrompt>(EMPTY_STRUCTURE);
  const [scriptText, setScriptText] = useState('');
  const [productName, setProductName] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [estimate, setEstimate] = useState<VideoCostEstimate | null>(null);

  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referencePath, setReferencePath] = useState('');
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [lastPath, setLastPath] = useState('');
  const [lastPreview, setLastPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [projectId, setProjectId] = useState('');
  const [projectModal, setProjectModal] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newGenerationIdempotencyKey());
  const [jobId, setJobId] = useState<string | null>(jobParam);
  const [status, setStatus] = useState('');
  const [providerState, setProviderState] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [finishedJob, setFinishedJob] = useState<GenerationJob | null>(null);
  const [runError, setRunError] = useState('');
  const pollRef = useRef<number | null>(null);

  const selectedModel = useMemo(() => models.find((m) => m.model_id === modelId), [models, modelId]);
  const modeModels = useMemo(() => modelsForMode(models, mode), [models, mode]);
  const selectedService = useMemo(() => services.find((s) => s.service_key === serviceKey), [services, serviceKey]);
  const balance = quota?.credits ?? 0;
  const tracking = useMemo(() => trackingState(status, providerState), [status, providerState]);
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);
  const resumable = useMemo(() => jobs.filter((j) => ACTIVE_STATUSES.includes(j.status)).slice(0, 3), [jobs]);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const [p, svc, m, j, a] = await Promise.all([
        listProjects(), listServices(), listVideoModels().catch(() => [] as MuApiModel[]),
        listJobs(100).catch(() => [] as GenerationJob[]), listAssets(8).catch(() => [] as GeneratedAsset[]),
      ]);
      const activeModels = m.filter(isModelAvailable);
      const activeServices = svc.filter((s) => s.active);
      setProjects(p); setServices(activeServices); setModels(activeModels); setJobs(j); setAssets(a);
      try { setHealth((await healthCheck()).configured); } catch { setHealth(null); }
      setServiceKey((current) => current || activeServices.find((s) => s.service_key === 'ugc_clip_8s')?.service_key || activeServices[0]?.service_key || '');
      setProjectId((current) => current || initialProjectRef.current || '');
      setModelId((current) => {
        if (current) return current;
        const requested = initialModelRef.current;
        const candidates = modelsForMode(activeModels, initialMode);
        return (requested && candidates.some((x) => x.model_id === requested) ? requested : null) || candidates[0]?.model_id || '';
      });
    } catch (err) { setLoadError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [initialMode]);

  useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!referenceFile) { setReferencePreview(null); return; }
    const url = URL.createObjectURL(referenceFile);
    setReferencePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [referenceFile]);

  useEffect(() => {
    if (!lastFile) { setLastPreview(null); return; }
    const url = URL.createObjectURL(lastFile);
    setLastPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [lastFile]);

  useEffect(() => {
    if (!selectedModel) { setParamValues({}); return; }
    setParamValues(defaultParams(selectedModel));
  }, [selectedModel?.model_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!serviceKey || !modelId || mode === 'video-to-video') { setEstimate(null); return; }
    let active = true;
    estimateVideo(serviceKey, modelId).then((e) => { if (active) setEstimate(e); }).catch(() => { if (active) setEstimate(null); });
    return () => { active = false; };
  }, [serviceKey, modelId, mode]);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => () => stopPolling(), [stopPolling]);

  const applyResult = useCallback((r: VideoActionResult) => {
    if (r.status) setStatus(r.status);
    if (r.provider_state) setProviderState(r.provider_state);
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
        void getJob(id).then((j) => { if (j) setFinishedJob(j); }).catch(() => undefined);
      }
    } catch (err) { setRunError(asAppError(err).message); }
  }, [applyResult, refreshQuota, stopPolling]);

  const startPolling = useCallback((id: string) => {
    stopPolling(); void poll(id);
    pollRef.current = window.setInterval(() => void poll(id), 6000);
  }, [poll, stopPolling]);
  const startPollingRef = useRef(startPolling);
  startPollingRef.current = startPolling;

  const hydrateFromJob = useCallback((job: GenerationJob) => {
    const payload = job.request_payload as Record<string, unknown>;
    const rawMode = String(payload.mode ?? '');
    const nextMode = VALID_MODES.includes(rawMode as GenerationMode) ? rawMode as GenerationMode : 'text-to-video';
    const rawModelId = String(payload.model_id ?? '');
    const nextModel = models.find((m) => m.model_id === rawModelId);
    setMode(nextMode);
    if (rawModelId) setModelId(rawModelId);
    setParamValues(Object.keys(asParamValues(payload.params)).length ? asParamValues(payload.params) : defaultParams(nextModel));
    setPrompt(String(payload.visual_prompt ?? ''));
    setScriptText(String(payload.script_text ?? ''));
    setProductName(String(payload.product_name ?? ''));
    setProjectId(job.project_id ?? '');
    setServiceKey(job.service_key || serviceKey);
    setEstimate(null);
    setIdempotencyKey(newGenerationIdempotencyKey());
  }, [models, serviceKey]);
  const hydrateRef = useRef(hydrateFromJob);
  hydrateRef.current = hydrateFromJob;

  useEffect(() => {
    if (loading || !jobParam) return;
    setJobId(jobParam);
    startPollingRef.current(jobParam);
    void getJob(jobParam).then((j) => {
      if (!j) return;
      setFinishedJob(j);
      hydrateRef.current(j);
    }).catch(() => undefined);
    return () => stopPolling();
  }, [loading, jobParam, stopPolling]);

  useEffect(() => {
    if (loading || !reuseParam || jobParam) return;
    void getJob(reuseParam).then((j) => {
      if (!j) { toast.warning('Génération introuvable ou inaccessible.'); return; }
      setFinishedJob(j);
      hydrateRef.current(j);
      toast.info('Paramètres rechargés. Vérifiez-les avant une nouvelle génération.');
      setParams({}, { replace: true });
    }).catch((err) => toast.error(asAppError(err).message));
  }, [loading, reuseParam, jobParam, setParams, toast]);

  const onModeChange = (next: GenerationMode) => {
    setMode(next);
    if (next === 'video-to-video') { setModelId(''); setParamValues({}); setEstimate(null); return; }
    const candidates = modelsForMode(models, next);
    if (!candidates.some((m) => m.model_id === modelId)) {
      const first = candidates[0];
      setModelId(first?.model_id ?? '');
      setParamValues(first ? defaultParams(first) : {});
    }
  };

  const onReference = (kind: 'first' | 'last', file: File | null) => {
    if (!file) {
      if (kind === 'first') { setReferenceFile(null); setReferencePath(''); }
      else { setLastFile(null); setLastPath(''); }
      return;
    }
    const issue = validateImage(file);
    if (issue) { toast.warning(issue); return; }
    if (kind === 'first') { setReferenceFile(file); setReferencePath(''); }
    else { setLastFile(file); setLastPath(''); }
  };

  const refreshCatalog = async () => {
    setRefreshing(true);
    try {
      const next = (await listVideoModels()).filter(isModelAvailable);
      setModels(next);
      if (!next.some((m) => m.model_id === modelId)) {
        const first = modelsForMode(next, mode)[0];
        setModelId(first?.model_id ?? '');
      }
      toast.success('Catalogue MuAPI vérifié rechargé.');
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setRefreshing(false); }
  };

  const onCreateProject = async () => {
    if (!newProjectTitle.trim()) { toast.warning('Nommez votre projet.'); return; }
    setCreatingProject(true);
    try {
      const id = await createProject({
        title: newProjectTitle.trim(), brief: prompt.slice(0, 600) || undefined,
        platform: 'TikTok', language: 'fr', aspect_ratio: String(paramValues.aspect_ratio ?? '9:16'),
        campaign_objective: 'Création Video Studio',
      });
      setProjects(await listProjects());
      setProjectId(id); setProjectModal(false); setNewProjectTitle('');
      toast.success('Projet créé avec les règles RLS et quotas existantes.');
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setCreatingProject(false); }
  };

  const launchIssues = useMemo(() => {
    const issues: string[] = [];
    if (mode === 'video-to-video') issues.push('Video to Video est un espace préparé : aucun modèle correspondant n’est intégré.');
    if (!selectedModel) issues.push('Choisissez un modèle MuAPI disponible.');
    else if (!modelModes(selectedModel).includes(mode)) issues.push('Le modèle sélectionné n’accepte pas ce mode.');
    if (!projectId) issues.push('Sélectionnez ou créez un projet pour enregistrer la vidéo.');
    if (prompt.trim().length < 20) issues.push('Décrivez la scène en au moins 20 caractères.');
    if (!serviceKey || !selectedService) issues.push('Choisissez un service de génération actif.');
    if (!estimate) issues.push('Estimation serveur des crédits en cours.');
    else {
      if (!estimate.service_active) issues.push('Le service de crédits sélectionné est inactif.');
      if (!estimate.model_available) issues.push('Le modèle MuAPI sélectionné n’est plus disponible.');
      if (estimate.credits_cost > balance) issues.push('Crédits insuffisants pour cette réservation.');
    }
    if (health?.muapi === false) issues.push('Le secret serveur MUAPI_API_KEY n’est pas configuré : une génération réelle ne peut pas aboutir.');
    if (selectedModel?.required_fields.includes('image_url') && !referenceFile && !referencePath) issues.push('Importez l’image de référence requise par ce modèle.');
    if (selectedModel?.required_fields.includes('last_image') && !lastFile && !lastPath) issues.push('Importez l’image finale requise par ce modèle.');
    if (starting || (jobId && !terminal)) issues.push('Une génération est déjà en cours pour cette session.');
    return issues;
  }, [mode, selectedModel, projectId, prompt, serviceKey, selectedService, estimate, balance, health, referenceFile, referencePath, lastFile, lastPath, starting, jobId, terminal]);
  const blockedReason = launchIssues[0];

  const onLaunch = async () => {
    if (blockedReason || !selectedModel || !projectId) { toast.warning(blockedReason || 'Complétez la configuration.'); return; }
    setStarting(true); setRunError(''); setPreviewUrl(null); setFinishedJob(null);
    try {
      if (!workspaceId && (referenceFile || lastFile)) throw new Error('Workspace indisponible pour l’import.');
      // Compatible with the LIVE Edge Function: a private Storage object is
      // uploaded, then a signed URL is passed as `image_url`. The storage path
      // is also included for the newer server-side signing path in source.
      let firstPath = referencePath;
      let lastImagePath = lastPath;
      if (referenceFile || lastFile) {
        setUploading(true);
        if (referenceFile && !firstPath) {
          firstPath = await uploadReferenceImage(workspaceId!, referenceFile);
          setReferencePath(firstPath);
        }
        if (lastFile && !lastImagePath) {
          lastImagePath = await uploadReferenceImage(workspaceId!, lastFile);
          setLastPath(lastImagePath);
        }
      }
      const reference = firstPath ? {
        image_storage_path: firstPath,
        image_url: await signedStorageUrl(firstPath, 86400),
      } : {};
      const lastReference = lastImagePath ? {
        last_image_storage_path: lastImagePath,
        last_image_url: await signedStorageUrl(lastImagePath, 86400),
      } : {};

      const payload = {
        provider: 'muapi', ui_version: 'reelora-video-studio-v1', mode,
        model_id: selectedModel.model_id, params: paramValues,
        visual_prompt: prompt.trim(), script_text: (scriptText.trim() || prompt.trim()).slice(0, 4000),
        product_name: productName.trim(), structured_prompt: structure,
        project_title: projects.find((p) => p.id === projectId)?.title ?? 'Reelora',
        ...reference, ...lastReference,
      };
      const id = await startGeneration(projectId, serviceKey, payload, idempotencyKey);
      setJobId(id); setStatus('reserved'); setProviderState('');
      const r = await videoStart(id);
      applyResult(r);
      if (r.status === 'failed') await refreshQuota();
      else { toast.info('Génération soumise à MuAPI. Le suivi se poursuit côté serveur.'); startPolling(id); }
    } catch (err) {
      setStatus('failed'); setRunError(asAppError(err).message); await refreshQuota();
    } finally { setStarting(false); setUploading(false); setConfirmOpen(false); }
  };

  const onCancel = async () => {
    if (!jobId) return;
    try {
      await cancelGeneration(jobId); stopPolling(); setStatus('cancelled');
      toast.success('Génération annulée, crédits restitués.'); await refreshQuota();
    } catch (err) { toast.error(asAppError(err).message); }
  };

  const resetForNew = () => {
    stopPolling(); setJobId(null); setStatus(''); setProviderState(''); setPreviewUrl(null);
    setFinishedJob(null); setRunError(''); setIdempotencyKey(newGenerationIdempotencyKey());
    setParams({}, { replace: true });
    toast.info('Configuration conservée pour une nouvelle génération.');
  };

  if (loading) return <LoadingState label="Préparation du Video Studio…" />;
  if (loadError) return <ErrorState message={loadError} onRetry={() => void load()} />;

  const stage = previewUrl && status === 'succeeded' ? 'result'
    : jobId && ACTIVE_STATUSES.includes(status) ? 'generating'
      : referencePreview ? 'reference' : 'empty';
  const currentProject = projects.find((p) => p.id === (finishedJob?.project_id ?? projectId));
  const resultCredits = finishedJob?.credits_charged || finishedJob?.credits_reserved || estimate?.credits_cost || 0;

  return (
    <StudioShell title="Video Studio · parcours détaillé" actions={<>
      <Link to="/app/studio" className="btn btn-primary btn-sm"><Sparkles size={13} /> Nouveau studio</Link>
      <Link to="/app/studio/montage" className="btn btn-outline btn-sm"><Scissors size={13} /> Éditeur</Link>
      <Link to="/app/historique" className="btn btn-outline btn-sm"><Clock3 size={13} /> Mes générations</Link>
      <Link to="/app/studio/avance" className="btn btn-ghost btn-sm"><Wand2 size={13} /> Parcours 5 étapes</Link>
    </>}>
      {health?.muapi === false && (
        <div className="mb-4"><Banner tone="warning" title="Activation MuAPI en attente">
          Le catalogue vérifié et toute la chaîne de crédits / suivi sont consultables. Le secret serveur <code>MUAPI_API_KEY</code> n’est pas configuré : le lancement est bloqué explicitement, sans résultat simulé. Configurez-le uniquement dans les secrets Supabase Edge Functions.
        </Banner></div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(330px,0.95fr)]">
        {/* Preview first on mobile, then the composer */}
        <div className="order-1 space-y-4">
          <PreviewStage state={stage} referenceUrl={referencePreview} videoUrl={previewUrl}
            onClearReference={() => onReference('first', null)}>
            {stage === 'generating' && <div className="mt-5 text-left"><TrackingPanel tracking={tracking} providerState={providerState} requestId={finishedJob?.provider_job_id ?? null} /></div>}
          </PreviewStage>

          {jobId && (
            <div className="space-y-3">
              <TrackingPanel tracking={tracking} providerState={providerState} requestId={finishedJob?.provider_job_id ?? null} />
              {runError && <Banner tone="danger" title="Génération interrompue"><AlertCircle size={12} className="inline" /> {runError}</Banner>}
              {status === 'succeeded' && (
                <Card className="p-4 sm:p-5">
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-400" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-white">Vidéo réelle disponible</h3>
                      <p className="mt-1 text-xs leading-relaxed text-slate-400">Fichier téléchargé depuis MuAPI et conservé dans Supabase Storage privé. L’URL de lecture ci-dessus est signée et temporaire ; le fichier, lui, reste dans votre bibliothèque.</p>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-[11px]"><span className="text-slate-500">Modèle : </span><span className="text-slate-200">{selectedModel?.display_name ?? String(finishedJob?.request_payload?.model_id ?? '—')}</span></div>
                        <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-[11px]"><span className="text-slate-500">Coût : </span><span className="text-amber-300">{resultCredits} crédits</span></div>
                        <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-[11px]"><span className="text-slate-500">Date : </span><span className="text-slate-200">{finishedJob ? formatDate(finishedJob.created_at, true) : '—'}</span></div>
                        <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-[11px]"><span className="text-slate-500">Projet : </span><span className="text-slate-200">{currentProject?.title ?? 'Bibliothèque'}</span></div>
                      </div>
                      <p className="mt-2 text-[11px] text-slate-500">Paramètres : {paramsSummary(paramValues)}</p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {previewUrl && <a href={previewUrl} download={`reelora-${jobId.slice(0, 8)}.mp4`} className="btn btn-primary btn-sm"><Download size={13} /> Télécharger</a>}
                        <Link to="/app/bibliotheque" className="btn btn-outline btn-sm"><Film size={13} /> Mes créations enregistrées</Link>
                        <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={resetForNew}>Relancer avec ces paramètres</Button>
                        <Link to="/app/historique" className="btn btn-ghost btn-sm">Détails & ledger</Link>
                      </div>
                    </div>
                  </div>
                </Card>
              )}
              {!terminal && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" icon={<Square size={13} />} onClick={() => void onCancel()}>Annuler la tâche</Button>
                  <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={() => jobId && void poll(jobId)}>Actualiser le suivi</Button>
                </div>
              )}
              {terminal && <Button variant="outline" size="sm" icon={<Plus size={13} />} onClick={resetForNew}>Nouvelle génération</Button>}
            </div>
          )}

          {resumable.length > 0 && !jobId && (
            <Card className="p-4">
              <h3 className="text-sm font-semibold text-white">Suivis serveur en cours</h3>
              <p className="mt-1 text-[11px] text-slate-500">Ces tâches continuent via webhook / worker, même si vous fermez la page.</p>
              <div className="mt-3 space-y-2">
                {resumable.map((j) => (
                  <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11px]">
                    <span className="text-slate-300">Tâche {j.id.slice(0, 8)}… <Badge status={j.status}>{j.status}</Badge></span>
                    <Link to={`/app/studio?job=${j.id}`} className="btn btn-ghost btn-sm">Reprendre le suivi</Link>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Configuration column */}
        <div className="order-2 space-y-4">
          <Card className="p-4 sm:p-5">
            <div className="mb-3 flex items-start gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-500/15 text-brand-200"><Clapperboard size={15} /></span>
              <div>
                <h3 className="text-sm font-semibold text-white">Mode de création</h3>
                <p className="mt-0.5 text-[11px] text-slate-500">Seuls les modes couverts par un modèle vérifié sont activables.</p>
              </div>
            </div>
            <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
              {VALID_MODES.map((m) => {
                const available = m !== 'video-to-video' && modelsForMode(models, m).length > 0;
                return (
                  <button key={m} type="button" onClick={() => onModeChange(m)}
                    className={cn('flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] font-medium transition-all',
                      mode === m ? 'border-brand-400/50 bg-brand-500/20 text-white' : 'border-white/[0.07] bg-white/[0.02] text-slate-400 hover:text-white')}>
                    {m === 'text-to-video' ? <Sparkles size={13} /> : m === 'image-to-video' ? <ImageIcon size={13} /> : <Film size={13} />}
                    {MODE_LABELS[m]}
                    {m === 'video-to-video' && <Lock size={10} className="ml-1 text-amber-300" />}
                    {!available && m !== 'video-to-video' && <span className="text-[9px] text-amber-300">0 modèle</span>}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{MODE_DESCRIPTIONS[mode]}</p>
            {mode === 'video-to-video' && (
              <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3 text-[11px] leading-relaxed text-amber-200">
                <Lock size={12} className="mr-1 inline" /> Espace préparé, non opérationnel. Aucun modèle vidéo → vidéo n’est intégré, aucun paramètre ni bouton de génération n’est proposé.
                <Link to="/app/studio/espace/video-to-video" className="ml-1 underline underline-offset-2">Voir la fiche</Link>
              </div>
            )}
          </Card>

          {mode !== 'video-to-video' && selectedModel && (
            <>
              <ModelCatalog models={modeModels} selectedId={modelId} onSelect={setModelId} busy={refreshing} onRefresh={() => void refreshCatalog()} estimate={estimate} healthMuapi={health?.muapi} />
              <PromptComposer prompt={prompt} onPrompt={setPrompt} structure={structure} onStructure={setStructure}
                scriptText={scriptText} onScript={setScriptText} productName={productName} onProductName={setProductName}
                groqConfigured={health?.groq ?? null} />
              <DynamicParams model={selectedModel} values={paramValues} onChange={setParamValues} />
              <ReferenceUploader model={selectedModel} firstPreview={referencePreview} lastPreview={lastPreview}
                onFirst={(f) => onReference('first', f)} onLast={(f) => onReference('last', f)} busy={uploading || starting} />

              <Card className="p-4 sm:p-5">
                <div className="mb-3 flex items-start gap-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-emerald-200"><FolderKanban size={15} /></span>
                  <div>
                    <h3 className="text-sm font-semibold text-white">Projet & service</h3>
                    <p className="mt-0.5 text-[11px] text-slate-500">Le résultat est rattaché à ce projet ; le coût Reelora vient du catalogue de services existant.</p>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Select id="studio-project" label="Enregistrer dans le projet *" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    <option value="">Choisir un projet…</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </Select>
                  <Select id="studio-service" label="Service / coût" value={serviceKey} onChange={(e) => setServiceKey(e.target.value)}>
                    {services.map((s) => <option key={s.service_key} value={s.service_key}>{s.display_name} — {s.credits_cost} crédits</option>)}
                  </Select>
                </div>
                <Button variant="ghost" size="sm" className="mt-3" icon={<Plus size={13} />} onClick={() => setProjectModal(true)}>Créer un projet rapide</Button>
                <p className="mt-2 text-[10px] leading-relaxed text-slate-600">Vous pourrez aussi rattacher ou déplacer un fichier depuis « Mes créations enregistrées ».</p>
              </Card>

              <CostSummary model={selectedModel} estimate={estimate} balance={balance} params={paramValues} />
              {launchIssues.length > 0 && (
                <div className="rounded-xl border border-amber-400/15 bg-amber-400/[0.05] px-3 py-2.5 text-[11px] text-amber-200">
                  <p className="flex items-center gap-1.5 font-semibold"><AlertCircle size={13} /> Conditions avant lancement ({launchIssues.length})</p>
                  <ul className="mt-1.5 space-y-1 pl-4">
                    {launchIssues.map((issue) => <li key={issue} className="list-disc leading-relaxed">{issue}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}

          {mode !== 'video-to-video' && !selectedModel && (
            <Card className="p-6 text-center text-sm text-slate-400">Aucun modèle vérifié n’est disponible pour ce mode. Actualisez le catalogue ou choisissez un autre mode.</Card>
          )}

          <Card className="p-4">
            <h3 className="text-sm font-semibold text-white">Bibliothèque récente</h3>
            <p className="mt-1 text-[11px] text-slate-500">Fichiers réellement produits et conservés côté serveur.</p>
            {assets.length === 0 ? <p className="mt-3 text-xs text-slate-600">Aucune vidéo enregistrée pour le moment.</p> : (
              <div className="mt-3 space-y-1.5">
                {assets.slice(0, 4).map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.02] px-2.5 py-2 text-[11px]">
                    <span className="truncate text-slate-300"><Film size={11} className="mr-1 inline" /> {a.storage_path.split('/').pop()}</span>
                    <span className="shrink-0 text-slate-600">{formatDate(a.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
            <Link to="/app/bibliotheque" className="btn btn-ghost btn-sm mt-3 w-full">Ouvrir la bibliothèque</Link>
          </Card>
        </div>
      </div>

      {mode !== 'video-to-video' && selectedModel && !jobId && (
        <div className="sticky bottom-[76px] z-20 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-400/25 bg-[#10131f]/95 p-3 shadow-[0_18px_50px_-25px_rgba(0,0,0,0.9)] backdrop-blur-xl lg:bottom-4">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-white">{selectedModel.display_name} <span className="font-normal text-slate-500">· {modelFamily(selectedModel)}</span></p>
            <CostSummary compact model={selectedModel} estimate={estimate} balance={balance} params={paramValues} />
          </div>
          <Button size="lg" icon={<Play size={16} />} disabled={Boolean(blockedReason)} onClick={() => setConfirmOpen(true)}>
            Générer une vidéo
          </Button>
        </div>
      )}

      {selectedModel && (
        <CostConfirm open={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={() => void onLaunch()}
          model={selectedModel} estimate={estimate} balance={balance} params={paramValues}
          loading={starting || uploading} blockedReason={blockedReason} />
      )}

      <Modal open={projectModal} onClose={() => setProjectModal(false)} title="Nouveau projet Reelora" size="sm"
        description="Utilise la RPC, les quotas et les RLS existants. Aucune donnée n’est supprimée."
        footer={<><Button variant="ghost" onClick={() => setProjectModal(false)}>Annuler</Button><Button loading={creatingProject} onClick={() => void onCreateProject()}>Créer le projet</Button></>}>
        <Input label="Nom du projet" value={newProjectTitle} onChange={(e) => setNewProjectTitle(e.target.value)} placeholder="Ex. Campagne Sérum Éclat — Novembre" />
      </Modal>

      <div className="mt-5 flex flex-wrap gap-2 text-[11px] text-slate-600">
        <span className="rounded-lg border border-white/[0.06] px-2.5 py-1"><Layers3 size={11} className="mr-1 inline" /> Catalogue dynamique</span>
        <span className="rounded-lg border border-white/[0.06] px-2.5 py-1"><Coins size={11} className="mr-1 inline" /> Réservation idempotente</span>
        <span className="rounded-lg border border-white/[0.06] px-2.5 py-1"><Clock3 size={11} className="mr-1 inline" /> Webhook + worker + cron</span>
        <Link to="/app/studio/espace/image" className="rounded-lg border border-white/[0.06] px-2.5 py-1 hover:text-white"><ArrowRight size={11} className="mr-1 inline" /> Espaces préparés</Link>
      </div>
    </StudioShell>
  );
}
