import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, Ban, CheckCircle2, Download, Film, Info, LoaderCircle,
  RefreshCw, RotateCcw, Server, SlidersHorizontal, X,
} from 'lucide-react';
import { Banner, Button, cn } from '../../../components/ui';
import {
  ASPECT_PRESETS, type AspectPreset, type EditorProject,
} from '../types';
import {
  QUALITY_LABELS, RENDER_LIMITATIONS, RESOLUTION_LABELS, buildSrt, downloadBlob,
  estimateExportMetrics, exportFilename, renderIssues, resolveExportPlan,
  type ExportCapabilities, type ExportContainerId, type ExportPhase, type ExportQualityId,
  type ExportResolutionId, type ExportSettings, type RenderResult,
} from '../render';
import { assessServerRenderNeed } from '../serverRenderSpec';

const PHASE_META: Record<ExportPhase, { label: string; badgeCls: string }> = {
  idle: { label: 'Prêt', badgeCls: 'border-white/10 bg-white/[0.04] text-slate-300' },
  preparing: { label: 'Préparation', badgeCls: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200' },
  rendering: { label: 'Rendu en cours', badgeCls: 'border-cyan-400/40 bg-cyan-400/15 text-cyan-100' },
  finalizing: { label: 'Finalisation', badgeCls: 'border-indigo-400/35 bg-indigo-400/15 text-indigo-200' },
  succeeded: { label: 'Réussi · vérifié', badgeCls: 'border-emerald-400/35 bg-emerald-400/15 text-emerald-200' },
  cancelled: { label: 'Annulé', badgeCls: 'border-amber-400/35 bg-amber-400/10 text-amber-200' },
  failed: { label: 'Échec', badgeCls: 'border-rose-400/35 bg-rose-400/15 text-rose-200' },
};

export function ExportPanel({
  project,
  caps,
  settings,
  onSettingsChange,
  onAspectChange,
  phase,
  progress,
  progressLabel,
  error,
  result,
  onStartRender,
  onSaveAndRender,
  onCancel,
  srtReady,
}: {
  project: EditorProject;
  caps: ExportCapabilities;
  settings: ExportSettings;
  onSettingsChange: (next: ExportSettings) => void;
  onAspectChange: (aspect: AspectPreset) => void;
  phase: ExportPhase;
  progress: number;
  progressLabel: string;
  error: string;
  result: RenderResult | null;
  onStartRender: () => void;
  onSaveAndRender: () => void;
  onCancel: () => void;
  srtReady: boolean;
}) {
  const isBusy = phase === 'preparing' || phase === 'rendering' || phase === 'finalizing';
  const issues = useMemo(() => renderIssues(project), [project]);
  const plan = useMemo(
    () => resolveExportPlan(project.aspect, settings, caps),
    [project.aspect, settings, caps],
  );
  const estimate = useMemo(
    () => estimateExportMetrics(project, settings, plan.engine),
    [project, settings, plan.engine],
  );
  const serverAssess = useMemo(
    () => assessServerRenderNeed(project, settings, caps),
    [project, settings, caps],
  );

  // Manage preview object URL cleanly without leaking browser memory
  const [previewUrl, setPreviewUrl] = useState<string>('');
  useEffect(() => {
    if (!result?.blob) { setPreviewUrl(''); return; }
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(result.blob);
    setPreviewUrl(url);
    return () => {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    };
  }, [result]);

  const phaseUi = PHASE_META[phase];
  const canLaunch = issues.length === 0 && plan.allowed && !isBusy;

  const updateSettings = (patch: Partial<ExportSettings>) => {
    onSettingsChange({ ...settings, ...patch });
  };

  return (
    <section
      className="rounded-2xl border border-cyan-400/20 bg-[#080d14] p-4"
      aria-label="Export et rendu vidéo professionnel"
    >
      {/* Header + state badge */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-white">
            <Film size={13} className="text-cyan-300" /> Moteur d’export vidéo professionnel
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
            Rendu réel navigateur (WebCodecs MP4/WebM + mixage audio haute précision ou MediaRecorder). Gratuit : 0 crédit UGC.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            data-testid="export-phase-badge"
            className={cn('rounded-lg border px-2 py-1 text-[10px] font-medium', phaseUi.badgeCls)}
          >
            {phaseUi.label}
          </span>
          <span
            data-testid="export-engine-badge"
            className={cn(
              'rounded-lg border px-2 py-1 text-[10px]',
              plan.allowed ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200' : 'border-rose-400/25 bg-rose-400/10 text-rose-200',
            )}
          >
            {plan.allowed && plan.mimeType
              ? `${plan.engine === 'webcodecs' ? 'WebCodecs' : 'MediaRecorder'} · ${plan.mimeType.split(';')[0]}`
              : 'Encodage indisponible'}
          </span>
        </div>
      </div>

      {/* Format ratio selector */}
      <div className="mt-3">
        <p className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-slate-400">
          <SlidersHorizontal size={11} /> Format vidéo (ratio)
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          {(Object.keys(ASPECT_PRESETS) as AspectPreset[]).map((ratio) => {
            const p = ASPECT_PRESETS[ratio];
            const active = project.aspect === ratio;
            return (
              <button
                key={ratio}
                type="button"
                disabled={isBusy}
                onClick={() => onAspectChange(ratio)}
                className={cn(
                  'rounded-xl border px-2.5 py-2 text-left transition disabled:opacity-50',
                  active
                    ? 'border-cyan-400/50 bg-cyan-400/12 text-white'
                    : 'border-white/[0.08] bg-black/25 text-slate-300 hover:border-white/20',
                )}
              >
                <p className="text-[11px] font-semibold">{ratio}</p>
                <p className="truncate text-[9px] text-slate-400">{p.platforms}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Resolution selector (strictly gated per actual browser capability) */}
      <div className="mt-3">
        <p className="mb-1.5 text-[10px] font-medium text-slate-400">
          Résolution (capacités réelles vérifiées)
        </p>
        <div className="grid gap-1.5 sm:grid-cols-3">
          {(['720p', '1080p', '4k'] as ExportResolutionId[]).map((resId) => {
            const sup = caps.resolutions[resId];
            const meta = RESOLUTION_LABELS[resId];
            const active = settings.resolution === resId;
            return (
              <button
                key={resId}
                type="button"
                disabled={isBusy || !sup.supported}
                onClick={() => updateSettings({ resolution: resId })}
                aria-label={`Résolution ${resId}`}
                className={cn(
                  'rounded-xl border px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-45',
                  active && sup.supported
                    ? 'border-cyan-400/50 bg-cyan-400/12 text-white'
                    : 'border-white/[0.08] bg-black/25 text-slate-300 hover:border-white/20',
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-semibold">{meta.label}</span>
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-[9px]',
                    sup.supported ? 'bg-emerald-400/15 text-emerald-200' : 'bg-rose-400/15 text-rose-200',
                  )}>
                    {sup.supported ? (sup.engine === 'webcodecs' ? 'WebCodecs' : 'Temps réel') : 'Indisponible'}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] text-slate-400">
                  {sup.width} × {sup.height} px
                </p>
                {!sup.supported && sup.reason && (
                  <p className="mt-0.5 text-[9px] text-rose-300/90">{sup.reason}</p>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Quality, Container & FPS controls */}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <label className="block text-[10px] text-slate-400">
          Qualité / débit
          <select
            aria-label="Qualité d’export"
            disabled={isBusy}
            value={settings.quality}
            onChange={(e) => updateSettings({ quality: e.target.value as ExportQualityId })}
            className="studio-input mt-1"
          >
            {(Object.keys(QUALITY_LABELS) as ExportQualityId[]).map((q) => (
              <option key={q} value={q}>{QUALITY_LABELS[q].label}</option>
            ))}
          </select>
        </label>

        <label className="block text-[10px] text-slate-400">
          Conteneur
          <select
            aria-label="Conteneur vidéo"
            disabled={isBusy}
            value={settings.container}
            onChange={(e) => updateSettings({ container: e.target.value as ExportContainerId })}
            className="studio-input mt-1"
          >
            <option value="auto">Automatique (meilleur supporté)</option>
            <option value="mp4" disabled={!caps.supportsMp4}>
              MP4 (H.264){!caps.supportsMp4 ? ' — indisponible' : ''}
            </option>
            <option value="webm" disabled={!caps.supportsWebm}>
              WebM (VP9/VP8){!caps.supportsWebm ? ' — indisponible' : ''}
            </option>
          </select>
        </label>

        <label className="block text-[10px] text-slate-400">
          Cadence (FPS)
          <select
            aria-label="Images par seconde"
            disabled={isBusy}
            value={settings.fps}
            onChange={(e) => updateSettings({ fps: Number(e.target.value) === 24 ? 24 : 30 })}
            className="studio-input mt-1"
          >
            <option value={30}>30 ips (standard fluide)</option>
            <option value={24}>24 ips (cinéma / léger)</option>
          </select>
        </label>
      </div>

      {/* Technical capability & pre-export estimate */}
      <div className="mt-3 grid gap-2 sm:grid-cols-4 text-[10px]">
        <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-2">
          <span className="text-slate-500">Dimensions sortie</span>
          <p className="font-semibold text-white">{estimate.width}×{estimate.height}</p>
        </div>
        <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-2">
          <span className="text-slate-500">Durée montage</span>
          <p className="font-semibold text-white">{estimate.durationSeconds.toFixed(1)} s · {settings.fps} ips</p>
        </div>
        <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-2">
          <span className="text-slate-500">Taille estimée</span>
          <p className="font-semibold text-cyan-200">~{estimate.estimatedSizeMb.toFixed(1)} Mo</p>
        </div>
        <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-2">
          <span className="text-slate-500">Temps estimé</span>
          <p className="font-semibold text-white">
            {plan.allowed
              ? `${estimate.estimatedRenderMinSeconds}–${estimate.estimatedRenderMaxSeconds} s`
              : 'Indisponible'}
          </p>
        </div>
      </div>

      {/* Technical capability diagnostics */}
      <div className="mt-2 grid gap-2 sm:grid-cols-3 text-[10px]">
        <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-1.5">
          <span className="text-slate-500">WebCodecs MP4/WebM</span>
          <p className={caps.mp4Profile.supported || caps.webmProfile.supported ? 'text-emerald-300' : 'text-slate-400'}>
            {caps.mp4Profile.supported ? 'MP4 H.264 actif' : caps.webmProfile.supported ? 'WebM VP9 actif' : 'Absent / non supporté'}
          </p>
        </div>
        <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-1.5">
          <span className="text-slate-500">MediaRecorder + Capture</span>
          <p className={caps.hasMediaRecorder && caps.hasCaptureStream ? 'text-emerald-300' : 'text-rose-300'}>
            {caps.hasMediaRecorder && caps.hasCaptureStream ? 'Disponible' : 'Indisponible'}
          </p>
        </div>
        <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-1.5">
          <span className="text-slate-500">Mixage Audio (Ducking)</span>
          <p className={caps.hasOfflineAudioContext || caps.hasAudioContext ? 'text-emerald-300' : 'text-amber-300'}>
            {caps.hasOfflineAudioContext ? 'OfflineAudioContext' : caps.hasAudioContext ? 'Web Audio temps réel' : 'Vidéo seule'}
          </p>
        </div>
      </div>

      {/* Blockers & capability warnings */}
      {issues.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 text-[11px] leading-relaxed text-amber-200">
          <AlertCircle size={11} className="mr-1 inline" /> {issues.join(' ')}
        </div>
      )}

      {!plan.allowed && (
        <div className="mt-3">
          <Banner tone="danger" title="Export vidéo indisponible dans cet environnement">
            {plan.reason || caps.reasons.join(' ')} Aucun export factice ou simulé ne sera généré.
          </Banner>
        </div>
      )}

      {phase === 'cancelled' && (
        <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-3 text-[11px] text-amber-100">
          <Ban size={12} className="mr-1 inline" /> Export annulé. Le montage sauvegardé reste intact : relancez quand vous voulez.
        </div>
      )}

      {error && (
        <div className="mt-3">
          <Banner tone="danger" title="Export non terminé">{error}</Banner>
        </div>
      )}

      {/* Real Progress Bar */}
      {isBusy && (
        <div className="mt-3 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.05] p-3">
          <div className="flex items-center justify-between text-[10px] text-cyan-100">
            <span className="font-medium">{progressLabel || phaseUi.label}</span>
            <span className="font-mono">{Math.round(progress * 100)} %</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/[0.08]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-300 transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <Button size="sm" variant="ghost" className="mt-2" icon={<X size={12} />} onClick={onCancel}>
            Annuler l’export
          </Button>
        </div>
      )}

      {/* Real Output Preview & Verified Download */}
      {phase === 'succeeded' && result && (
        <div className="mt-3 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-200">
              <CheckCircle2 size={13} /> Fichier vidéo vérifié · {result.width}×{result.height} · {result.fps} ips · {result.durationSeconds.toFixed(1)} s
            </p>
            <span className="rounded bg-emerald-400/15 px-2 py-0.5 text-[10px] text-emerald-200">
              {result.engine === 'webcodecs' ? 'WebCodecs' : 'MediaRecorder'} · {result.container.toUpperCase()}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-slate-300">
            {(result.blob.size / 1024 / 1024).toFixed(2)} Mo · {result.mimeType} · audio mixé : {result.audioMixed ? 'oui' : 'non'}
          </p>
          {result.diagnostics.length > 0 && (
            <p className="mt-1 text-[10px] text-amber-200">{result.diagnostics.join(' ')}</p>
          )}

          {previewUrl && (
            <video
              controls
              playsInline
              src={previewUrl}
              className="mt-2.5 max-h-[240px] w-full rounded-xl border border-white/10 bg-black"
              aria-label="Aperçu du fichier vidéo exporté"
            />
          )}

          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<Download size={13} />}
              onClick={() => downloadBlob(result.blob, exportFilename(project, result.mimeType))}
            >
              Télécharger ({result.container.toUpperCase()})
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon={<RotateCcw size={13} />}
              disabled={!canLaunch}
              onClick={onStartRender}
            >
              Relancer l’export
            </Button>
          </div>
        </div>
      )}

      {/* Action Buttons (Protected against double launch) */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          loading={isBusy}
          disabled={!canLaunch}
          icon={phase === 'failed' || phase === 'cancelled' ? <RotateCcw size={13} /> : <LoaderCircle size={13} />}
          onClick={onStartRender}
        >
          {phase === 'failed' || phase === 'cancelled' ? 'Relancer le rendu' : 'Lancer le rendu'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canLaunch}
          icon={<RefreshCw size={13} />}
          onClick={onSaveAndRender}
        >
          Enregistrer et exporter
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!srtReady}
          icon={<Download size={13} />}
          onClick={() => {
            const srt = buildSrt(project);
            if (!srt.trim()) return;
            downloadBlob(new Blob([srt], { type: 'text/plain;charset=utf-8' }), 'sous-titres.srt');
          }}
        >
          Exporter sous-titres (.SRT)
        </Button>
      </div>

      {/* Explicit Server Render Study & Limitations */}
      <details className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 p-3 text-[10px] text-slate-400">
        <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-300">
          <Server size={11} /> Capacités techniques & architecture de rendu serveur (non activée)
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-4 leading-relaxed">
          {RENDER_LIMITATIONS.map((l) => <li key={l}>{l}</li>)}
        </ul>
        <div className="mt-2 rounded-lg border border-white/[0.07] bg-black/30 p-2.5 leading-relaxed">
          <p className="font-semibold text-slate-300">
            Rendu serveur FFmpeg : non déployé (export local gratuit = 0 crédit)
          </p>
          {serverAssess.reasons.length > 0 && (
            <p className="mt-1 text-amber-200">{serverAssess.reasons.join(' ')}</p>
          )}
          <p className="mt-1 flex items-start gap-1.5 text-slate-400">
            <Info size={10} className="mt-0.5 shrink-0" />
            Une file FFmpeg serveur nécessiterait un worker dédié + secrets serveur + validation explicite si facturée en crédits. Aucune fonction Edge n’est déployée automatiquement.
          </p>
        </div>
      </details>
    </section>
  );
}
