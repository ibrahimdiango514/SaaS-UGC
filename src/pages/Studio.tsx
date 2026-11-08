import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, Clapperboard, Coins, Loader2, Play, RefreshCw,
  Sparkles, Square, Wand2, XCircle,
} from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Input, Textarea, Select, Badge, Banner, LoadingState, ErrorState, EmptyState } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { healthCheck, listAvatars, listPresets, listProjects, listScripts, listServices, startGeneration, videoStart, videoStatus, cancelGeneration } from '../lib/api';
import type { Avatar, GenerationPreset, Project, Script, ServiceCatalogItem, VideoActionResult } from '../lib/types';

const STEPS = [
  { n: 1, label: 'Projet & script' }, { n: 2, label: 'Avatar & réglages' },
  { n: 3, label: 'Lancement' }, { n: 4, label: 'Suivi' },
];

export default function Studio() {
  const toast = useToast();
  const { workspaceId, quota, refreshQuota } = useAuth();
  const [params] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [presets, setPresets] = useState<GenerationPreset[]>([]);
  const [services, setServices] = useState<ServiceCatalogItem[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [health, setHealth] = useState<Record<string, boolean> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [projectId, setProjectId] = useState(params.get('projet') ?? '');
  const [scriptText, setScriptText] = useState('');
  const [avatarId, setAvatarId] = useState('');
  const [presetId, setPresetId] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [provider, setProvider] = useState('heygen');
  const [duration, setDuration] = useState(15);
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [resolution, setResolution] = useState('1080p');
  const [style, setStyle] = useState('ugc_naturel');
  const [voiceSpeed, setVoiceSpeed] = useState(1);
  const [captions, setCaptions] = useState(true);
  const [backgroundColor, setBackgroundColor] = useState('#FFFFFF');
  const [falModel, setFalModel] = useState('');

  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [providerState, setProviderState] = useState<string>('');
  const [runError, setRunError] = useState('');
  const [starting, setStarting] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const [p, s, svc] = await Promise.all([listProjects(), listScripts(), listServices()]);
      setProjects(p); setServices(svc.filter((x) => x.active)); setScripts(s);
      try { setHealth((await healthCheck()).configured); } catch { setHealth(null); }
      if (workspaceId) {
        const [a, pr] = await Promise.all([listAvatars(workspaceId), listPresets(workspaceId)]);
        setAvatars(a.filter((x) => x.status === 'active')); setPresets(pr);
        const def = pr.find((x) => x.is_default);
        if (def) { setPresetId(def.id); applyPreset(def); }
      }
      const pid = params.get('projet') ?? '';
      if (pid) {
        const project = p.find((x) => x.id === pid);
        const latest = s.find((x) => x.project_id === pid && x.status === 'approved') ?? s.find((x) => x.project_id === pid);
        if (latest) setScriptText(latest.script_text);
        if (project) { setAspectRatio(project.aspect_ratio); setProvider(project.platform?.includes('fal') ? 'fal' : 'heygen'); }
      }
      const defaultService = svc.find((x) => x.service_key === 'ugc_clip_15s') ?? svc.find((x) => x.service_key.includes('clip'));
      if (defaultService) setServiceKey(defaultService.service_key);
    } catch (err) { setLoadError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [workspaceId, params]);

  useEffect(() => { void load(); }, [load]);

  function applyPreset(p: GenerationPreset) {
    const c = p.config as Record<string, unknown>;
    if (typeof c.provider === 'string') setProvider(c.provider);
    if (typeof c.duration_seconds === 'number') setDuration(c.duration_seconds);
    if (typeof c.aspect_ratio === 'string') setAspectRatio(c.aspect_ratio);
    if (typeof c.resolution === 'string') setResolution(c.resolution);
    if (typeof c.style === 'string') setStyle(c.style);
    if (typeof c.voice_speed === 'number') setVoiceSpeed(c.voice_speed);
    if (typeof c.captions === 'boolean') setCaptions(c.captions);
    if (typeof c.background_color === 'string') setBackgroundColor(c.background_color);
    if (typeof c.model === 'string') setFalModel(c.model);
  }

  const stopPolling = () => { if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; } setPolling(false); };
  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  const poll = useCallback(async (id: string) => {
    try {
      const r: VideoActionResult = await videoStatus(id);
      setStatus(r.status); setProviderState(r.provider_state ?? '');
      if (['succeeded', 'failed', 'cancelled'].includes(r.status)) {
        stopPolling();
        if (r.status === 'succeeded') { toast.success('Vidéo générée et ajoutée à la bibliothèque.'); await refreshQuota(); }
        else { setRunError(r.error || r.message || 'La génération a échoué. Les crédits réservés ont été restitués.'); await refreshQuota(); }
      }
    } catch (err) { setRunError(asAppError(err).message); }
  }, [refreshQuota, toast]);

  const startPolling = (id: string) => {
    stopPolling(); setPolling(true);
    void poll(id);
    pollRef.current = window.setInterval(() => void poll(id), 8000);
  };

  const onLaunch = async () => {
    setRunError('');
    if (!projectId) { toast.warning('Sélectionnez un projet.'); return; }
    if (!scriptText.trim()) { toast.warning('Un script est nécessaire pour la vidéo.'); return; }
    if (!avatarId) { toast.warning('Sélectionnez un avatar.'); return; }
    if (!serviceKey) { toast.warning('Sélectionnez un service de génération.'); return; }
    const avatar = avatars.find((a) => a.id === avatarId);
    if (provider === 'heygen' && !avatar?.provider_avatar_id) { toast.warning('Cet avatar n’a pas d’identifiant fournisseur HeyGen. Modifiez-le dans Avatars.'); return; }
    if (provider === 'fal' && !avatar?.preview_storage_path && !avatar?.preview_url) { toast.warning('Le mode fal.ai nécessite une image de référence sur l’avatar.'); return; }
    setStarting(true); setStatus(''); setProviderState(''); setJobId(null);
    try {
      const payload = {
        provider, avatar_id: avatarId, avatar_id_provider: avatar?.provider_avatar_id ?? null,
        script_text: scriptText, voice_id: avatar?.voice_id ?? null, voice_speed: voiceSpeed,
        duration_seconds: duration, aspect_ratio: aspectRatio, resolution, style,
        captions, background_color: backgroundColor, visual_prompt: style,
        model: falModel || undefined, fal_duration: provider === 'fal' ? '5' : undefined,
        title: projects.find((p) => p.id === projectId)?.title ?? 'Reelora',
        image_path: avatar?.preview_storage_path ?? null,
        image_url: avatar?.preview_url ?? null,
      };
      const id = await startGeneration(projectId, serviceKey, payload);
      setJobId(id); setStatus('reserved');
      const r = await videoStart(id);
      setStatus(r.status); setProviderState(r.provider_state ?? '');
      if (r.status === 'failed') { setRunError(r.error || r.message || 'Échec du lancement.'); await refreshQuota(); }
      else { toast.info('Génération soumise au fournisseur. Suivi en cours…'); startPolling(id); }
    } catch (err) {
      const e = asAppError(err);
      setRunError(e.code === 'VIDEO_PROVIDER_NOT_CONFIGURED' ? e.message : e.message);
      setStatus('failed'); await refreshQuota();
    } finally { setStarting(false); }
  };

  const onCancel = async () => {
    if (!jobId) return;
    try { await cancelGeneration(jobId); stopPolling(); setStatus('cancelled'); toast.success('Génération annulée, crédits restitués.'); await refreshQuota(); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  const activeStep = !jobId ? (scriptText && avatarId ? 2 : 1) : status === 'succeeded' || status === 'failed' ? 4 : 3;
  const selectedService = services.find((s) => s.service_key === serviceKey);
  const credits = selectedService?.credits_cost ?? 0;
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);

  if (loading) return <LoadingState label="Préparation du studio…" />;
  if (loadError) return <ErrorState message={loadError} onRetry={() => void load()} />;

  return (
    <>
      <PageHeader eyebrow="Production" title="UGC Studio" description="Composez, lancez et suivez une vraie génération vidéo, de bout en bout."
        actions={<Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>Actualiser</Button>} />

      <div className="mb-5 flex flex-wrap gap-2">
        {STEPS.map((s) => (
          <div key={s.n} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium ${activeStep >= s.n ? 'border-brand-400/30 bg-brand-500/10 text-brand-200' : 'border-line bg-white/[0.03] text-slate-500'}`}>
            <span className={`grid h-5 w-5 place-items-center rounded-full ${activeStep >= s.n ? 'bg-brand-500 text-white' : 'bg-white/10'}`}>{s.n}</span> {s.label}
          </div>
        ))}
      </div>

      {health && (!health.heygen && !health.fal) && (
        <div className="mb-5"><Banner tone="warning" title="Aucun fournisseur vidéo configuré">Ajoutez le secret serveur <code className="text-amber-100">HEYGEN_API_KEY</code> (avec <code>REELORA_VIDEO_PROVIDER=heygen</code>) ou <code className="text-amber-100">FAL_KEY</code> (avec <code>REELORA_VIDEO_PROVIDER=fal</code>) dans Supabase. Sans clé, la génération échoue explicitement et les crédits sont restitués.</Banner></div>
      )}

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <Card><CardHeader title="1. Projet & script" description="Le script est transmis au fournisseur pour la voix off." />
            <div className="space-y-4 p-5">
              <Select label="Projet" value={projectId} onChange={(e) => {
                const id = e.target.value; setProjectId(id);
                const p = projects.find((x) => x.id === id);
                const found = scripts.find((x) => x.project_id === id && x.status === 'approved') ?? scripts.find((x) => x.project_id === id);
                if (found) setScriptText(found.script_text);
                if (p) setAspectRatio(p.aspect_ratio);
              }}>
                <option value="">Sélectionner un projet</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </Select>
              <Textarea label="Script à lire par l’avatar" value={scriptText} onChange={(e) => setScriptText(e.target.value)} className="min-h-[150px]" placeholder="Collez votre script ou générez-le depuis Scripts IA…" hint={`${scriptText.length} caractères · pas de texte = génération impossible`} />
              <div className="flex flex-wrap gap-2"><Link to={projectId ? `/app/scripts?projet=${projectId}` : '/app/scripts'} className="btn btn-outline btn-sm"><Wand2 size={14} /> Générer un script avec l’IA</Link></div>
            </div>
          </Card>

          <Card><CardHeader title="2. Avatar & réglages vidéo" description="Les valeurs sont transmises au fournisseur sans transformation fictive." />
            <div className="space-y-4 p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Select label="Avatar" value={avatarId} onChange={(e) => setAvatarId(e.target.value)}>
                  <option value="">Sélectionner un avatar</option>
                  {avatars.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.provider})</option>)}
                </Select>
                <Select label="Préréglage" value={presetId} onChange={(e) => { const id = e.target.value; setPresetId(id); const p = presets.find((x) => x.id === id); if (p) applyPreset(p); }}>
                  <option value="">Réglages personnalisés</option>
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Select label="Fournisseur" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="heygen">HeyGen — avatar parlant</option><option value="fal">fal.ai — image vers vidéo</option>
                </Select>
                <Select label="Format" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>{['9:16', '1:1', '4:5', '16:9'].map((x) => <option key={x}>{x}</option>)}</Select>
                <Input label="Durée (s)" type="number" min={5} max={60} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
                <Select label="Résolution" value={resolution} onChange={(e) => setResolution(e.target.value)}><option value="720p">720p</option><option value="1080p">1080p</option><option value="4k">4K</option></Select>
                <Input label="Style / ambiance" value={style} onChange={(e) => setStyle(e.target.value)} />
                <Input label="Vitesse de voix" type="number" min={0.5} max={2} step={0.1} value={voiceSpeed} onChange={(e) => setVoiceSpeed(Number(e.target.value))} />
                <Input label="Couleur de fond" value={backgroundColor} onChange={(e) => setBackgroundColor(e.target.value)} />
                <Input label="Modèle fal.ai (optionnel)" value={falModel} onChange={(e) => setFalModel(e.target.value)} placeholder="Laisser vide = Kling v1.6" />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} className="h-4 w-4 accent-brand-500" /> Sous-titres / captions</label>
              {avatarId && <p className="text-xs text-slate-500">Identifiant fournisseur : <span className="text-slate-300">{avatars.find((a) => a.id === avatarId)?.provider_avatar_id || 'non renseigné'}</span> · <Link to="/app/avatars" className="text-brand-300">gérer les avatars</Link></p>}
            </div>
          </Card>

          <Card><CardHeader title="3. Service & coût" description="Le coût est réservé puis restitué en cas d’échec." />
            <div className="space-y-4 p-5">
              <Select label="Service de génération" value={serviceKey} onChange={(e) => setServiceKey(e.target.value)}>
                <option value="">Sélectionner un service</option>
                {services.map((s) => <option key={s.service_key} value={s.service_key}>{s.display_name} — {s.credits_cost} crédits</option>)}
              </Select>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-white/[0.03] px-4 py-3">
                <div><p className="text-xs text-slate-500">Solde disponible</p><p className="text-lg font-bold text-white">{quota?.credits ?? 0} crédits</p></div>
                <div><p className="text-xs text-slate-500">Coût de cette génération</p><p className="text-lg font-bold text-amber-300">{credits} crédits</p></div>
                <Coins size={20} className="text-amber-300" />
              </div>
              {quota && credits > quota.credits && <Banner tone="danger" title="Crédits insuffisants">Rechargez votre solde depuis l’abonnement avant de lancer la génération.</Banner>}
              <div className="flex flex-wrap gap-2">
                <Button size="lg" icon={<Play size={16} />} loading={starting} disabled={Boolean(jobId) && !terminal} onClick={() => void onLaunch()}>Lancer la génération</Button>
                {jobId && !terminal && <Button variant="outline" icon={<Square size={15} />} onClick={() => void onCancel()}>Annuler</Button>}
                {jobId && terminal && <Button variant="outline" icon={<RefreshCw size={15} />} onClick={() => { setJobId(null); setStatus(''); setRunError(''); }}>Nouvelle génération</Button>}
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-5 lg:col-span-2">
          <Card><CardHeader title="4. Suivi de la génération" description="Interrogation réelle du fournisseur vidéo." />
            {!jobId ? <EmptyState icon={<Clapperboard size={24} />} title="Aucune génération en cours" description="Lancez une génération pour suivre ici son état réel." /> : (
              <div className="space-y-4 p-5">
                <div className="flex items-center gap-3">
                  {status === 'succeeded' ? <CheckCircle2 className="text-emerald-400" size={22} /> : status === 'failed' || status === 'cancelled' ? <XCircle className="text-rose-400" size={22} /> : <Loader2 className="animate-spin text-brand-300" size={22} />}
                  <div><p className="text-sm font-semibold text-white">{status === 'succeeded' ? 'Vidéo disponible' : status === 'failed' ? 'Génération échouée' : status === 'cancelled' ? 'Génération annulée' : 'Génération en cours'}</p><p className="text-xs text-slate-500">Tâche {jobId.slice(0, 8)}…</p></div>
                </div>
                <div className="flex flex-wrap gap-2"><Badge status={status}>{status}</Badge>{providerState && <Badge tone="info">Fournisseur : {providerState}</Badge>}</div>
                {!terminal && <div className="rounded-xl border border-line bg-white/[0.03] p-3 text-xs text-slate-400"><p className="flex items-center gap-2"><RefreshCw size={13} className="animate-spin" /> Actualisation automatique toutes les 8 secondes.</p><p className="mt-1">{polling ? 'Le fournisseur est interrogé jusqu’à la fin de la tâche.' : 'Préparation du suivi…'}</p></div>}
                {runError && <Banner tone="danger" title="Erreur"><AlertTriangle size={12} className="inline" /> {runError}</Banner>}
                {status === 'succeeded' && <Link to="/app/bibliotheque" className="btn btn-primary btn-sm w-full"><Sparkles size={14} /> Voir dans la bibliothèque</Link>}
                {terminal && status !== 'succeeded' && <Link to="/app/historique" className="btn btn-outline btn-sm w-full">Consulter l’historique</Link>}
                <p className="text-[11px] text-slate-600">Aucun résultat fictif : seul un fichier réellement produit par le fournisseur est ajouté à la bibliothèque.</p>
              </div>
            )}
          </Card>

          <Card><CardHeader title="Check-list" />
            <div className="space-y-2.5 p-5 text-xs">
              {[
                ['Projet sélectionné', Boolean(projectId)],
                ['Script renseigné', scriptText.trim().length > 20],
                ['Avatar sélectionné', Boolean(avatarId)],
                ['Identifiant fournisseur / image', Boolean(avatars.find((a) => a.id === avatarId)?.provider_avatar_id || avatars.find((a) => a.id === avatarId)?.preview_storage_path)],
                ['Service choisi', Boolean(serviceKey)],
                ['Crédits suffisants', (quota?.credits ?? 0) >= credits],
                ['Clé fournisseur configurée', Boolean(health?.[provider === 'fal' ? 'fal' : 'heygen'])],
              ].map(([label, ok]) => (
                <div key={String(label)} className="flex items-center gap-2"><span className={ok ? 'text-emerald-400' : 'text-amber-400'}>{ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span><span className={ok ? 'text-slate-300' : 'text-amber-200'}>{label}</span></div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
