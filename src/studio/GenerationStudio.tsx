import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle, ArrowRight, CheckCircle2, Clapperboard, Coins, Database, Info,
  Layers3, Plus, RefreshCw, Scissors, Square,
} from 'lucide-react';
import { Banner, Button, ErrorState, LoadingState, Modal, Select, cn } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  cancelGeneration, createProject, estimateVideo, generateScript, getJob, healthCheck,
  getVideoCatalog, getVideoModelDetail, listAvatars, listProjects, listServices,
  newGenerationIdempotencyKey, signedStorageUrl, startGeneration, uploadReferenceImage,
  videoStart, videoStatus,
} from '../lib/api';
import { asAppError } from '../lib/errors';
import type {
  Avatar, GenerationJob, MuApiModel, Project, ServiceCatalogItem, VideoActionResult,
  VideoCatalogDiagnostics, VideoCostEstimate,
} from '../lib/types';
import { CostConfirm } from './components/CostConfirm';
import { GenerationEmptyState } from './components/GenerationEmptyState';
import { AfterGeneration } from './components/AfterGeneration';
import { CatalogBrowser } from './components/CatalogBrowser';
import { PromptBar, initialFormState, type GenerationFormState } from './components/PromptBar';
import { StudioTopBar } from './components/StudioTopBar';
import { TrackingPanel } from './components/PreviewStage';
import { trackingState } from './tracking';
import {
  modelFamily, modeFromModel, providerQuoteOriginLabel, type ParamValue,
} from './model';
import {
  QUALITY_TIERS, buildCompatibleParams, defaultSettingsFor, modelForQuality,
  qualityTierSummary, serviceForQuality,
} from './quality';
import { USD_CREDIT_NOTE, creditSummary } from './catalog';
import {
  PLAN_VERSION, CREATION_MODES, buildLocalPlan, mapAiScriptToPlan, planToEditorProject,
  validateProductionPlan, type ProductionPlan, type SectorId,
} from './plan';
import { loadLocalDraft, saveLocalDraft as createLocalEditorDraft } from './editor/persistence';

const ACTIVE = ['queued', 'reserved', 'processing'];
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const RESERVED_KEYS = ['aspect_ratio', 'resolution', 'duration'];
const MEDIA_FIELDS = new Set([
  'prompt', 'image_url', 'last_image', 'audio_url', 'video_url', 'input_video',
  'images_list', 'image_urls', 'mask_image_url', 'mask_video_url', 'request_id',
]);

interface SignedReference {
  path?: string;
  url?: string;
  lastPath?: string;
  lastUrl?: string;
  avatarId?: string;
}

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
  const location = useLocation();
  const { workspaceId, quota, refreshQuota } = useAuth();
  const [search] = useSearchParams();
  const handedOffBrief = asRecord((location.state as { ugcBrief?: unknown } | null)?.ugcBrief);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [models, setModels] = useState<MuApiModel[]>([]);
  const [catalog, setCatalog] = useState<VideoCatalogDiagnostics | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [services, setServices] = useState<ServiceCatalogItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [health, setHealth] = useState<Record<string, boolean> | null>(null);
  const [healthBusy, setHealthBusy] = useState(true);
  const [healthError, setHealthError] = useState('');
  const [form, setForm] = useState<GenerationFormState>(() => {
    const base = initialFormState();
    const promptParts = [handedOffBrief.hook, handedOffBrief.angle, handedOffBrief.summary, handedOffBrief.cta]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (!promptParts.length) return base;
    return {
      ...base,
      prompt: promptParts.join(' — '),
      script: typeof handedOffBrief.summary === 'string' ? handedOffBrief.summary : base.script,
    };
  });
  const [selectedSector, setSelectedSector] = useState<SectorId>('cosmetique');
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [estimateError, setEstimateError] = useState('');
  const [reference, setReference] = useState<SignedReference | null>(null);
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
  const detailCache = useRef<Set<string>>(new Set());
  const fromEditor = search.get('fromEditor') === '1';
  const resumeJob = search.get('job');
  const preserveEditorAspect = useRef(fromEditor);

  const patch = useCallback((p: Partial<GenerationFormState>) => setForm((f) => ({ ...f, ...p })), []);
  const balance = quota?.credits ?? 0;

  const checkHealth = useCallback(async () => {
    setHealthBusy(true);
    setHealthError('');
    try {
      setHealth((await healthCheck()).configured);
    } catch (err) {
      setHealth(null);
      setHealthError(asAppError(err).message);
    } finally {
      setHealthBusy(false);
    }
  }, []);

  const modeDef = CREATION_MODES.find((m) => m.id === form.mode) ?? CREATION_MODES[0];
  const simplifiedModel = useMemo(
    () => modelForQuality(models, modeDef.mode, form.quality),
    [models, modeDef.mode, form.quality],
  );
  const selectedModel = useMemo(
    () => selectedModelId ? models.find((m) => m.model_id === selectedModelId) ?? null : null,
    [models, selectedModelId],
  );
  const model = advancedMode && selectedModel ? selectedModel : simplifiedModel;
  const generationMode = advancedMode && selectedModel ? modeFromModel(selectedModel) : modeDef.mode;
  const service = useMemo(() => serviceForQuality(services, form.quality), [services, form.quality]);
  const compatible = useMemo(() => buildCompatibleParams(model, {
    ratio: form.ratio, resolution: form.resolution, duration: form.duration, extras: form.extras,
  }), [model, form.ratio, form.resolution, form.duration, form.extras]);
  const paramsKey = JSON.stringify(compatible);
  const schemaKey = useMemo(() => JSON.stringify(model?.param_schema ?? {}), [model]);
  const inputFieldsKey = useMemo(() => JSON.stringify(model?.input_fields ?? []), [model]);
  const requiredKey = JSON.stringify(model?.required_fields ?? []);

  const dynamicValues = useMemo(() => {
    const out: Record<string, ParamValue> = { ...form.extras };
    if (model?.input_fields.includes('aspect_ratio')) out.aspect_ratio = form.ratio;
    if (model?.input_fields.includes('resolution') && form.resolution) out.resolution = form.resolution;
    if (model?.input_fields.includes('duration') && form.duration !== null) out.duration = form.duration;
    return out;
  }, [form.extras, form.ratio, form.resolution, form.duration, model?.input_fields]);

  const localPlan = useMemo(() => buildLocalPlan({
    prompt: form.prompt, script: form.script,
    ratio: (['9:16', '1:1', '16:9'].includes(form.ratio) ? form.ratio : '9:16') as ProductionPlan['ratio'],
    subtitles: form.subtitles,
  }), [form.prompt, form.script, form.ratio, form.subtitles]);
  const validated = useMemo(() => validateProductionPlan(localPlan), [localPlan]);
  const plan = aiPlan ?? (validated.ok ? validated.plan : localPlan);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    void checkHealth();
    try {
      const [p, svc, c, av] = await Promise.all([
        listProjects(), listServices(), getVideoCatalog(),
        workspaceId ? listAvatars(workspaceId).catch(() => [] as Avatar[]) : Promise.resolve([] as Avatar[]),
      ]);
      setProjects(p); setServices(svc.filter((s) => s.active));
      setModels(c.models ?? []); setCatalog(c.catalog ?? null);
      setCatalogError(c.catalog?.error ?? '');
      setAvatars(av);
      setProjectId((current) => current || p[0]?.id || '');
    } catch (err) {
      setLoadError(asAppError(err).message);
    } finally { setLoading(false); }
  }, [checkHealth, workspaceId]);
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
      if (typeof p.model_id === 'string') { setSelectedModelId(p.model_id); setAdvancedMode(true); }
      setProjectId(j.project_id ?? '');
      toast.info('Paramètres de la génération rechargés. Vérifiez le devis avant de lancer.');
    }).catch(() => undefined);
    return () => { active = false; };
  }, [search, toast]);

  // Restore a general brief / scene edits made in the editor.
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

  // Fetch the full input_schema for the selected model once, server-side.
  useEffect(() => {
    const id = model?.model_id;
    if (!id || detailCache.current.has(id)) return;
    detailCache.current.add(id);
    setDetailLoading(true);
    void getVideoModelDetail(id)
      .then((r) => {
        if (!r?.model) return;
        setModels((prev) => prev.map((m) => m.model_id === id ? { ...m, ...r.model } : m));
      })
      .catch((err) => {
        detailCache.current.delete(id);
        toast.warning(`Schéma détaillé indisponible pour ${id} : ${asAppError(err).message}`);
      })
      .finally(() => setDetailLoading(false));
  }, [model?.model_id, toast]);

  // Apply the model's REAL declared defaults whenever its schema changes.
  useEffect(() => {
    if (!model) return;
    const d = defaultSettingsFor(model);
    setForm((f) => ({
      ...f,
      ratio: preserveEditorAspect.current ? f.ratio : d.ratio,
      resolution: d.resolution, duration: d.duration, extras: {},
    }));
    preserveEditorAspect.current = false;
  }, [model?.model_id, schemaKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sign REAL uploaded / avatar references BEFORE the quote, so a dynamic
  // MuAPI estimate receives exactly the same URLs as the generation would.
  useEffect(() => {
    let active = true;
    setReference(null);
    const requiredImage = (model?.required_fields ?? []).some((f) => f.toLowerCase() === 'image_url');
    const declaredImage = Boolean(model?.input_fields.includes('image_url'));
    const declaredLastImage = Boolean(model?.input_fields.includes('last_image'));
    const wantsImage = requiredImage || declaredImage || form.mode === 'product' || form.mode === 'avatar';
    const wantsLastImage = declaredLastImage && !!form.lastReferenceFile;
    if (!wantsImage && !wantsLastImage) return;
    if ((form.referenceFile || form.lastReferenceFile) && !workspaceId) {
      toast.error('Espace de travail indisponible : import de référence impossible.');
      return;
    }
    void (async () => {
      try {
        const next: SignedReference = {};
        if (wantsLastImage && form.lastReferenceFile && workspaceId) {
          const lastPath = await uploadReferenceImage(workspaceId, form.lastReferenceFile);
          next.lastPath = lastPath;
          next.lastUrl = await signedStorageUrl(lastPath, 86400);
        }
        if (form.referenceFile && workspaceId) {
          const path = await uploadReferenceImage(workspaceId, form.referenceFile);
          next.path = path;
          next.url = await signedStorageUrl(path, 86400);
        } else if (form.avatarId && wantsImage) {
          const avatar = avatars.find((a) => a.id === form.avatarId);
          const url = avatar?.preview_url
            || (avatar?.preview_storage_path ? await signedStorageUrl(avatar.preview_storage_path, 86400) : '');
          if (url) {
            next.path = avatar?.preview_storage_path ?? undefined;
            next.url = url;
            next.avatarId = avatar?.id;
          }
        }
        if (active) setReference(next);
      } catch (err) { if (active) toast.error(asAppError(err).message); }
    })();
    return () => { active = false; };
  }, [form.referenceFile, form.lastReferenceFile, form.avatarId, form.mode, model?.model_id, requiredKey,
    inputFieldsKey, workspaceId, avatars, toast]);

  // Quote is computed EXCLUSIVELY by the backend, with exact model + params.
  useEffect(() => {
    if (!service || !model) {
      setEstimate(null); setEstimateError(''); setQuoteBusy(false); return;
    }
    let active = true;
    setEstimate(null); setEstimateError('');
    const timer = window.setTimeout(() => {
      setQuoteBusy(true);
      void estimateVideo(service.service_key, model.model_id, {
        params: compatible, prompt: form.prompt.trim(),
        image_url: reference?.url, last_image_url: reference?.lastUrl,
        param_schema: model.param_schema,
      })
        .then((e) => {
          if (!active) return;
          setEstimate(e);
          setEstimateError(e.provider_quote_error ?? '');
        })
        .catch((err) => {
          if (!active) return;
          setEstimate(null);
          setEstimateError(asAppError(err).message);
        })
        .finally(() => { if (active) setQuoteBusy(false); });
    }, 350);
    return () => { active = false; window.clearTimeout(timer); };
  }, [service?.service_key, model?.model_id, schemaKey, inputFieldsKey, paramsKey, form.prompt,
    reference?.url, reference?.lastUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const requiresExactQuote = Boolean(model?.dynamic_pricing);
  const summary = creditSummary(estimate, balance, requiresExactQuote);
  const cost = summary.creditsCost;
  const tierSummary = useMemo(
    () => qualityTierSummary(models, services, modeDef.mode),
    [models, services, modeDef.mode],
  );
  const issues = useMemo(() => {
    const out: string[] = [];
    if (!model) out.push('Aucun modèle MuAPI compatible disponible pour ce mode.');
    if (!service) out.push('Service de crédits indisponible pour cette qualité.');
    if (catalogError) out.push(catalogError);
    if (catalog?.account.key_valid === false) out.push('Clé / compte MuAPI non validée : aucune génération réelle ne peut être lancée.');
    if (health?.muapi === false) out.push('Secret serveur MUAPI_API_KEY absent : une génération réelle ne peut pas aboutir.');
    if (detailLoading) out.push('Schéma réel du modèle en cours de récupération…');
    if (quoteBusy) out.push('Devis backend exact en cours…');
    if (estimateError) out.push(`Devis serveur : ${estimateError}`);
    if (form.prompt.trim().length < 20) out.push('Décrivez votre vidéo en au moins 20 caractères.');
    if (!projectId) out.push('Sélectionnez ou créez un projet.');
    if (!estimate) out.push('Devis serveur en cours…');
    else {
      if (!estimate.service_active) out.push('Le service de crédits est inactif.');
      if (!estimate.model_available) out.push(estimate.model_reason || 'Le modèle MuAPI sélectionné n’est plus disponible.');
      if (estimate.provider_quote_error) out.push(estimate.provider_quote_error);
      if (requiresExactQuote && !summary.exactQuote) out.push('Devis exact estimate-cost indisponible pour ce modèle dynamique : aucune génération payante sans prix confirmé.');
      if (summary.quoteToConfirm) out.push('Devis fournisseur à confirmer : aucun prix fictif, y compris un zéro factice, n’est accepté.');
      if (cost !== null && cost > balance) out.push('Crédits UGC insuffisants pour cette réservation.');
      if (cost === null || cost <= 0) out.push('Coût en crédits Reelora non confirmé par le serveur.');
    }
    const needsImage = (model?.required_fields ?? []).some((f) => f.toLowerCase() === 'image_url');
    if (needsImage && !reference?.url) out.push('Ce modèle exige une image de référence réelle pour le devis et la génération.');
    if (form.mode === 'product' && !form.referenceFile) out.push('Importez une image de produit.');
    if (form.mode === 'avatar' && !form.avatarId) out.push('Choisissez un avatar existant.');
    if (form.referenceFile && form.referenceFile.size > MAX_REFERENCE_BYTES) out.push('Image trop volumineuse (8 Mo maximum).');
    if (form.lastReferenceFile && form.lastReferenceFile.size > MAX_REFERENCE_BYTES) out.push('Image finale trop volumineuse (8 Mo maximum).');
    if (starting || (jobId && ACTIVE.includes(status))) out.push('Une génération est déjà en cours.');
    return out;
  }, [model, service, catalog, catalogError, health, detailLoading, quoteBusy, estimateError,
    form.prompt, form.mode, form.referenceFile, form.lastReferenceFile, form.avatarId, projectId,
    estimate, balance, reference, starting, jobId, status, requiresExactQuote,
    summary.exactQuote, summary.quoteToConfirm, cost]);
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
    if (blockedReason || !model || !service || !projectId || !estimate || !summary.canReserve || summary.quoteToConfirm) {
      toast.warning(blockedReason || 'Devis à confirmer : génération non autorisée.');
      return;
    }
    setStarting(true); setConfirmOpen(false); setRunError(''); setResult(null);
    try {
      let referencePayload: Record<string, unknown> = {};
      if (reference) {
        referencePayload = {
          ...(reference.url ? { image_url: reference.url } : {}),
          ...(reference.path ? { image_storage_path: reference.path } : {}),
          ...(reference.lastUrl ? { last_image_url: reference.lastUrl } : {}),
          ...(reference.lastPath ? { last_image_storage_path: reference.lastPath } : {}),
          ...(reference.avatarId ? { avatar_id: reference.avatarId } : {}),
        };
      } else if (form.mode === 'product' && form.referenceFile && workspaceId) {
        const path = await uploadReferenceImage(workspaceId, form.referenceFile);
        referencePayload = { image_storage_path: path, image_url: await signedStorageUrl(path, 86400) };
      } else if (form.mode === 'avatar' && form.avatarId) {
        const avatar = avatars.find((a) => a.id === form.avatarId);
        const url = avatar?.preview_url || (avatar?.preview_storage_path ? await signedStorageUrl(avatar.preview_storage_path, 86400) : '');
        referencePayload = { avatar_id: form.avatarId, image_url: url, ...(avatar?.preview_storage_path ? { image_storage_path: avatar.preview_storage_path } : {}) };
      }
      if (!referencePayload.last_image_storage_path && form.lastReferenceFile && workspaceId) {
        const lastPath = await uploadReferenceImage(workspaceId, form.lastReferenceFile);
        referencePayload.last_image_storage_path = lastPath;
        referencePayload.last_image_url = await signedStorageUrl(lastPath, 86400);
      }
      const prompt = form.prompt.trim();
      const payload = {
        provider: 'muapi', ui_version: 'reelora-video-studio-v2-catalog',
        mode: generationMode, creation_mode: form.mode, quality: form.quality,
        sector: plan.sector, model_id: model.model_id, params: compatible,
        visual_prompt: prompt,
        script_text: (form.script.trim() || prompt).slice(0, 4000),
        subtitles: form.subtitles,
        plan_version: PLAN_VERSION, plan_source: plan.source,
        plan_scenes: plan.scenes.map((s) => ({ role: s.role, label: s.label, duration_seconds: s.durationSeconds, visual_prompt: s.visualPrompt, subtitle: s.subtitle })),
        quote: {
          credits_cost: estimate.credits_cost,
          provider_cost_usd: estimate.provider_cost_usd,
          provider_cost_currency: estimate.provider_cost_currency,
          provider_quote_source: estimate.provider_quote_source,
          params: estimate.quote_params ?? compatible,
        },
        ...referencePayload,
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

  const onExample = (sector: SectorId, example: string) => {
    setSelectedSector(sector);
    setForm((f) => ({ ...f, prompt: example }));
    toast.info('Exemple chargé : personnalisez-le avant de confirmer le devis.');
    document.getElementById('studio-prompt')?.focus();
  };

  const onOpenCatalog = () => {
    setCatalogOpen((v) => !v);
    if (!catalogOpen && model && !selectedModelId) setSelectedModelId(model.model_id);
    window.setTimeout(() => document.getElementById('catalog-muapi')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
  };

  const onSelectModel = (id: string) => {
    setSelectedModelId(id);
    setAdvancedMode(true);
    toast.info('Modèle sélectionné : schéma réel et devis serveur en cours de chargement.');
  };

  const onClearSelection = () => {
    setSelectedModelId(null);
    setAdvancedMode(false);
    toast.info('Mode simplifié réactivé : le modèle est choisi selon la qualité.');
  };

  const onParamsChange = (values: Record<string, ParamValue>) => {
    if (selectedModelId) setAdvancedMode(true);
    const extras: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(values)) {
      if (RESERVED_KEYS.includes(k) || MEDIA_FIELDS.has(k) || k.startsWith('__')) continue;
      if (!model?.input_fields.includes(k)) continue;
      extras[k] = v;
    }
    setForm((f) => ({
      ...f,
      ratio: typeof values.aspect_ratio === 'string' ? values.aspect_ratio : f.ratio,
      resolution: typeof values.resolution === 'string' ? values.resolution
        : values.resolution === undefined ? f.resolution : String(values.resolution),
      duration: typeof values.duration === 'number' ? values.duration
        : typeof values.duration === 'string' && Number.isFinite(Number(values.duration)) ? Number(values.duration) : f.duration,
      extras,
    }));
  };

  const onAiPlan = async () => {
    if (health?.groq !== true) {
      const message = health?.groq === false
        ? 'Assistance IA indisponible : GROQ_API_KEY absent côté serveur. Aucune réponse n’est simulée.'
        : healthError || 'Configuration Groq non vérifiée. Réessayez la vérification avant de continuer.';
      setAiMessage(message);
      toast.warning(message);
      return;
    }
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
  const catalogSummary = catalog
    ? `${catalog.detected_video} détectés · ${catalog.active} actifs · ${catalog.unavailable} indisponibles · ${catalog.account_accessible} retournés avec la clé`
    : 'Catalogue en cours…';
  const catalogModel = selectedModel;

  return (
    <div className="studio-v2 animate-fadeUp pb-2">
      <StudioTopBar />

      <div className="hidden flex-wrap items-center justify-between gap-2 sm:flex">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.06] px-2.5 py-1.5 text-[11px] text-cyan-200">
            <Database size={12} /> Catalogue MuAPI · {catalogSummary}
          </span>
          <Link to="/app/studio/classique" className="studio-icon-link">Parcours détaillé</Link>
          <Link to="/app/studio/avance" className="studio-icon-link hidden sm:inline-flex">Parcours 5 étapes</Link>
          <Link to="/app/studio/montage" className="studio-icon-link"><Scissors size={12} /> AI Video Editor</Link>
        </div>
        <div className="flex items-center gap-2">
          <Select id="studio-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-auto min-w-[160px] text-xs" aria-label="Projet">
            <option value="">Choisir un projet…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </Select>
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setProjectModal(true)}>Nouveau</Button>
        </div>
      </div>

      {catalogError && (
        <div className="mt-3"><Banner tone="danger" title="Catalogue MuAPI partiellement indisponible">{catalogError}</Banner></div>
      )}
      {catalog?.account.key_valid === false && (
        <div className="mt-3"><Banner tone="warning" title="Compte MuAPI non validé">
          La sonde lecture seule n’a pas pu valider la clé serveur. Les modèles publics restent visibles mais aucune option n’est présentée comme réellement accessible au compte.
        </Banner></div>
      )}
      {catalog?.account.key_valid === true && (
        <p className="mt-2 hidden items-center gap-1.5 text-[11px] text-emerald-300 sm:flex"><CheckCircle2 size={12} /> Clé compte MuAPI validée en lecture seule · aucune génération payante lancée.</p>
      )}
      {health?.muapi === false && (
        <div className="mt-3"><Banner tone="warning" title="Secret MuAPI absent">
          La génération réelle ne peut pas aboutir. Ajoutez le secret serveur MUAPI_API_KEY dans Supabase ; aucun résultat n’est simulé.
        </Banner></div>
      )}
      {estimateError && (
        <div className="mt-3"><Banner tone="danger" title="Devis backend indisponible">{estimateError}</Banner></div>
      )}

      <section data-testid="studio-tier-summary" className="mt-3 rounded-2xl border border-white/[0.08] bg-[#080d14] p-3 sm:p-4" aria-label="Correspondance des niveaux de qualité">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-300">Rapide · Standard · Premium</p>
            <h2 className="mt-0.5 text-sm font-semibold text-white">Services et modèles réellement associés</h2>
          </div>
          <span className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-500">{models.length} modèles · {services.length} services</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {tierSummary.map((tier) => (
            <div key={tier.tier} className={cn('rounded-xl border p-3', form.quality === tier.tier ? 'border-cyan-400/35 bg-cyan-400/[0.06]' : 'border-white/[0.07] bg-white/[0.02]')}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-bold text-white">{tier.label}</p>
                <span className={cn('rounded-md px-1.5 py-0.5 text-[9px]', tier.available ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-200')}>{tier.available ? 'Disponible' : 'Indisponible'}</span>
              </div>
              <p className="mt-1 text-[10px] leading-snug text-slate-500">{tier.description}</p>
              <p className="mt-2 text-[11px] font-semibold text-amber-300">{tier.creditsCost ?? '—'} crédits UGC · {tier.serviceKey}</p>
              <p className="mt-0.5 truncate text-[10px] text-slate-400" title={tier.modelId ?? ''}>{tier.modelName ?? 'Aucun modèle compatible'}</p>
              <p className="mt-0.5 text-[9px] text-slate-600">Tarif catalogue {tier.catalogCostUsd !== null ? `${tier.catalogCostUsd.toFixed(3)} USD` : '—'} · devis exact séparé</p>
            </div>
          ))}
        </div>
        <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-600"><Info size={11} className="mt-0.5 shrink-0" /> {USD_CREDIT_NOTE}</p>
      </section>

      {showEmpty && (
        <div className="mt-4">
          <GenerationEmptyState onExample={onExample} onStart={() => document.getElementById('studio-prompt')?.focus()}
            onSector={setSelectedSector} selectedSector={selectedSector} />
        </div>
      )}

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
                <div className="flex justify-between gap-2"><span className="text-slate-500">Coût fournisseur</span><span className={summary.quoteToConfirm ? 'text-right font-semibold text-amber-200' : 'text-right text-white'}>{summary.usdLabel}</span></div>
                <div className="flex justify-between gap-2"><span className="text-slate-500">Origine du devis</span><span className="text-right text-white">{providerQuoteOriginLabel(estimate)}</span></div>
                <div className="flex justify-between gap-2"><span className="text-slate-500">Solde après réservation</span><span className="text-white">{summary.remaining ?? '—'}</span></div>
              </div>
              {estimate?.provider_quote_error && <p className="mt-2 text-[10px] text-amber-200">{estimate.provider_quote_error}</p>}
              {summary.quoteToConfirm && <p data-testid="studio-quote-warning" className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-2 py-1.5 text-[10px] font-semibold leading-relaxed text-amber-200">Devis fournisseur à confirmer : aucun prix fictif, génération bloquée.</p>}
              <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-500"><Info size={11} className="mt-0.5 shrink-0" /> Devis calculé exclusivement côté backend. {USD_CREDIT_NOTE} Réservation avant envoi, capture uniquement après succès, restitution sur échec.</p>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4">
              <p className="text-[11px] font-semibold text-white">Paramètres réellement envoyés</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(compatible).map(([k, v]) => <span key={k} className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10px] text-slate-300">{k} : {String(v)}</span>)}
                {Object.keys(compatible).length === 0 && <span className="text-[11px] text-slate-500">Prompt uniquement.</span>}
              </div>
              <p className="mt-2 text-[10px] text-slate-600">Dérivés de <code>param_schema ∩ input_fields</code> du schéma MuAPI récupéré côté serveur.</p>
            </div>
          </div>
        </div>
      )}

      {catalogOpen && (
        <CatalogBrowser models={models} catalog={catalog} selectedId={selectedModelId}
          onSelect={onSelectModel} onClose={() => setCatalogOpen(false)} onRefresh={() => void load()}
          detailLoading={detailLoading} model={catalogModel} params={dynamicValues}
          onParamsChange={onParamsChange} onClearSelection={onClearSelection}
          referenceFile={form.referenceFile} lastReferenceFile={form.lastReferenceFile}
          onReferenceChange={(file) => patch({ referenceFile: file })}
          onLastReferenceChange={(file) => patch({ lastReferenceFile: file })}
          estimate={selectedModelId === model?.model_id ? estimate : null} balance={balance}
          loading={loading} catalogError={catalogError} estimateError={estimateError}
          quoteBusy={quoteBusy} providerUnavailable={catalog?.account.key_valid === false || health?.muapi === false} />
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
        balance={balance} blockedReason={blockedReason} busy={starting || confirmOpen || quoteBusy}
        onGenerate={() => setConfirmOpen(true)} health={health} avatars={avatars}
        onAiPlan={() => void onAiPlan()} aiBusy={aiBusy} aiMessage={aiMessage}
        healthBusy={healthBusy} healthError={healthError} onRetryHealth={() => void checkHealth()}
        catalogOpen={catalogOpen} onOpenCatalog={onOpenCatalog} catalogSummary={catalogSummary} />

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

      <p className="mt-4 hidden flex-wrap items-center gap-1.5 text-[10px] text-slate-600 sm:flex">
        <Clapperboard size={11} /> Les cartes de secteur sont des inspirations visuelles, pas des médias générés.
        <Coins size={11} className="ml-2" /> Crédits UGC uniquement : le Business Growth Workspace n’est pas concerné.
        <Layers3 size={11} className="ml-2" /> Aucun moteur Image / Audio / Lip Sync n’est présenté comme connecté.
        <Link to="/app/historique" className="ml-2 inline-flex items-center gap-1 text-cyan-400/70 hover:text-cyan-300">Historique <ArrowRight size={10} /></Link>
      </p>
    </div>
  );
}
