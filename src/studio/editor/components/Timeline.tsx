import { useMemo, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Copy, Film, FolderOpen, GripVertical, Mic, Music2,
  Pause, Play, Plus, Redo2, Scissors, Subtitles, Trash2, Undo2, Upload, Volume2, VolumeX, ZoomIn,
} from 'lucide-react';
import { cn } from '../../../components/ui';
import { estimateSpeechDurationSeconds, subtitleSpans } from '../assist';
import {
  SCENE_ROLES, TRANSITIONS, addScene, clampDuration, duplicateScene,
  effectiveVoiceover, emptyAudio, moveScene, patchScene, removeScene, splitScene,
  totalDuration, trimScene, type EditorProject, type EditorScene, type FitMode, type SceneRole,
} from '../types';

const MIN_BLOCK = 64;

function sceneOffsetAt(scenes: EditorScene[], id: string): { start: number; scene: EditorScene } | null {
  let cursor = 0;
  for (const s of scenes) {
    if (s.id === id) return { start: cursor, scene: s };
    cursor += Math.max(0, s.duration);
  }
  return null;
}

function sceneAtTime(scenes: EditorScene[], t: number): { scene: EditorScene; local: number } | null {
  let cursor = 0;
  for (let i = 0; i < scenes.length; i += 1) {
    const d = Math.max(0, scenes[i].duration);
    if (t <= cursor + d || i === scenes.length - 1) {
      return { scene: scenes[i], local: Math.max(0, Math.min(d, t - cursor)) };
    }
    cursor += d;
  }
  return null;
}

export function Timeline({
  project,
  onChange,
  selectedId,
  onSelect,
  playhead,
  onSeek,
  playing,
  onTogglePlay,
  onImport,
  onImportAudio,
  onImportVoiceover,
  onOpenLibrary,
  onOpenVoiceTab,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
}: {
  project: EditorProject;
  onChange: (p: EditorProject) => void;
  selectedId: string;
  onSelect: (id: string) => void;
  playhead: number;
  onSeek: (t: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  /** Persists the clip in private Storage, then returns a source with its path. */
  onImport: (file: File, sceneId: string) => void;
  onImportAudio: (file: File) => void;
  onImportVoiceover?: (file: File) => void;
  onOpenLibrary?: () => void;
  onOpenVoiceTab?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const voiceRef = useRef<HTMLInputElement>(null);
  const trackWrapRef = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<number | null>(null);
  const [zoom, setZoom] = useState<1 | 1.5 | 2>(1);

  const total = Math.max(0.1, totalDuration(project));
  const selected = project.scenes.find((s) => s.id === selectedId) ?? project.scenes[0] ?? null;
  const spans = subtitleSpans(project);
  const voiceover = effectiveVoiceover(project);

  const widthFor = (duration: number) => `${Math.max(MIN_BLOCK, (duration / total) * 100 * zoom)}%`;
  const timeLabel = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${String(Math.floor((t % 1) * 10))}`;
  const playheadPct = Math.min(100, Math.max(0, (playhead / total) * 100));

  const rulerMarks = useMemo(() => {
    const step = total <= 12 ? 2 : total <= 30 ? 5 : 10;
    const marks: number[] = [];
    for (let t = 0; t <= Math.floor(total); t += step) marks.push(t);
    return marks;
  }, [total]);

  const patchSelected = (p: Partial<EditorScene>) => {
    if (!selected) return;
    onChange(patchScene(project, selected.id, p));
  };

  const reorder = (delta: number) => {
    if (!selected) return;
    const i = project.scenes.findIndex((s) => s.id === selected.id);
    if (i < 0) return;
    onChange(moveScene(project, i, Math.min(project.scenes.length - 1, Math.max(0, i + delta))));
  };

  const onSplitCurrent = () => {
    const hit = sceneAtTime(project.scenes, playhead);
    if (hit && hit.scene.duration >= 1) {
      const splitOffset = hit.local >= 0.5 && hit.local <= hit.scene.duration - 0.5
        ? hit.local
        : hit.scene.duration / 2;
      onChange(splitScene(project, hit.scene.id, splitOffset));
      return;
    }
    if (selected && selected.duration >= 1) {
      onChange(splitScene(project, selected.id));
    }
  };

  const onAddScene = () => {
    const next = addScene(project, { role: 'custom', label: `Plan ${project.scenes.length + 1}`, duration: 3 });
    const created = next.scenes[next.scenes.length - 1];
    onChange(next);
    if (created) onSelect(created.id);
  };

  const onDuplicate = () => {
    if (!selected) return;
    const next = duplicateScene(project, selected.id);
    const idx = next.scenes.findIndex((s) => s.id === selected.id);
    onChange(next);
    if (idx >= 0 && next.scenes[idx + 1]) onSelect(next.scenes[idx + 1].id);
  };

  const onRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const updateFromClientX = (clientX: number) => {
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      onSeek(Number((ratio * total).toFixed(2)));
    };
    updateFromClientX(e.clientX);
    const onMove = (ev: PointerEvent) => updateFromClientX(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startTrimDrag = (e: React.PointerEvent<HTMLButtonElement>, scene: EditorScene) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startDur = scene.duration;
    const trackW = trackWrapRef.current?.clientWidth || 600;
    const pxPerSec = Math.max(12, (trackW * zoom) / total);
    const onMove = (ev: PointerEvent) => {
      const deltaSec = (ev.clientX - startX) / pxPerSec;
      const nextDur = clampDuration(startDur + deltaSec);
      onChange(trimScene(project, scene.id, { duration: nextDur }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const canSplit = Boolean(
    (sceneAtTime(project.scenes, playhead)?.scene.duration ?? 0) >= 1
    || (selected && selected.duration >= 1),
  );
  const selectedWordCount = selected ? selected.spokenText.trim().split(/\s+/).filter(Boolean).length : 0;
  const selectedSpeechSec = selected ? estimateSpeechDurationSeconds(selected.spokenText) : 0;

  return (
    <div className="studio-v2 rounded-2xl border border-white/[0.08] bg-[#080d14]">
      {/* Playback & editing transport */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.06] px-3 py-2.5">
        <button
          type="button"
          onClick={onTogglePlay}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cyan-400 text-[#04121a]"
          aria-label={playing ? 'Pause' : 'Lecture'}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <span className="font-mono text-[11px] text-cyan-200">{timeLabel(playhead)}</span>
        <input
          type="range"
          min={0}
          max={total}
          step={0.1}
          value={Math.min(playhead, total)}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="h-1.5 min-w-[90px] flex-1 cursor-pointer appearance-none rounded-full bg-white/10 accent-cyan-400"
          aria-label="Position de lecture"
        />
        <span className="font-mono text-[11px] text-slate-500">{timeLabel(total)}</span>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            disabled={!canSplit || project.scenes.length >= 24}
            onClick={onSplitCurrent}
            className="studio-chip"
            title="Scinder le plan au niveau du curseur"
          >
            <Scissors size={11} /> Scinder
          </button>
          <button
            type="button"
            disabled={project.scenes.length >= 24}
            onClick={onAddScene}
            className="studio-chip"
            title="Ajouter un nouveau plan"
          >
            <Plus size={11} /> Plan
          </button>
          <button
            type="button"
            disabled={!selected || project.scenes.length >= 24}
            onClick={onDuplicate}
            className="studio-chip hidden sm:inline-flex"
            title="Dupliquer le plan sélectionné"
          >
            <Copy size={11} /> Dupliquer
          </button>
          {onUndo && (
            <button
              type="button"
              disabled={!canUndo}
              onClick={onUndo}
              className="studio-icon-link disabled:opacity-35"
              title="Annuler la dernière modification"
              aria-label="Annuler"
            >
              <Undo2 size={12} />
            </button>
          )}
          {onRedo && (
            <button
              type="button"
              disabled={!canRedo}
              onClick={onRedo}
              className="studio-icon-link disabled:opacity-35"
              title="Rétablir"
              aria-label="Rétablir"
            >
              <Redo2 size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setZoom((z) => (z === 1 ? 1.5 : z === 1.5 ? 2 : 1))}
            className="studio-icon-link"
            title="Zoom timeline"
            aria-label={`Zoom ${zoom}x`}
          >
            <ZoomIn size={12} /> {zoom}×
          </button>
        </div>
      </div>

      {/* Ruler + Multi-track area */}
      <div className="space-y-2 p-3">
        {/* Scrubbable time ruler */}
        <div
          role="slider"
          aria-label="Règle temporelle"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={Number(playhead.toFixed(1))}
          tabIndex={0}
          onPointerDown={onRulerPointerDown}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') onSeek(Math.min(total, playhead + 0.5));
            if (e.key === 'ArrowLeft') onSeek(Math.max(0, playhead - 0.5));
          }}
          className="relative h-6 cursor-ew-resize select-none rounded-lg border border-white/[0.06] bg-black/40 px-2"
        >
          {rulerMarks.map((m) => (
            <span
              key={m}
              style={{ left: `${Math.min(96, (m / total) * 100)}%` }}
              className="absolute top-1 -translate-x-1/2 font-mono text-[9px] text-slate-500"
            >
              {m}s
            </span>
          ))}
          <div
            style={{ left: `${playheadPct}%` }}
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.8)]"
          >
            <span className="absolute -left-1.5 -top-0.5 h-2.5 w-3.5 rounded-b bg-cyan-300" />
          </div>
        </div>

        {/* Track 1: Video */}
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
          <span className="flex items-center gap-2"><Film size={11} /> Piste vidéo ({project.scenes.length} plans · {total.toFixed(1)} s)</span>
          <span className="hidden text-[9px] normal-case text-slate-600 sm:inline">Glisser pour réorganiser · poignée droite pour ajuster la durée</span>
        </div>
        <div
          ref={trackWrapRef}
          className="no-scrollbar relative flex min-h-[96px] gap-1.5 overflow-x-auto rounded-xl border border-white/[0.06] bg-black/30 p-2"
          role="list"
          aria-label="Scènes vidéo"
        >
          {project.scenes.length === 0 && (
            <div className="m-auto flex flex-col items-center gap-2 py-2 text-center">
              <p className="text-[11px] text-slate-500">Aucune scène dans la timeline.</p>
              <button type="button" onClick={onAddScene} className="studio-chip"><Plus size={11} /> Ajouter un plan</button>
            </div>
          )}
          {project.scenes.map((scene, i) => {
            const hasMedia = scene.source.kind !== 'none' && Boolean(scene.source.url);
            const roleLabel = SCENE_ROLES.find((r) => r.id === scene.role)?.label ?? scene.role;
            return (
              <div
                key={scene.id}
                role="listitem"
                draggable
                onDragStart={() => { dragFrom.current = i; }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom.current !== null) onChange(moveScene(project, dragFrom.current, i));
                  dragFrom.current = null;
                }}
                onClick={() => {
                  onSelect(scene.id);
                  const offset = sceneOffsetAt(project.scenes, scene.id);
                  if (offset) onSeek(offset.start);
                }}
                style={{ width: widthFor(scene.duration) }}
                className={cn(
                  'group relative min-w-[64px] shrink-0 cursor-pointer overflow-hidden rounded-lg border p-2 pr-3 transition',
                  selected?.id === scene.id
                    ? 'border-cyan-400/70 bg-cyan-400/[0.12]'
                    : 'border-white/[0.09] bg-white/[0.03] hover:border-cyan-400/30',
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-[11px] font-semibold text-white">{i + 1}. {scene.label}</span>
                  <GripVertical size={11} className="shrink-0 text-slate-600" />
                </div>
                <div className="mt-1 flex items-center gap-1 text-[9px] text-slate-400">
                  <span className="rounded bg-white/[0.06] px-1 py-0.5 text-[8px] uppercase text-cyan-200">{roleLabel}</span>
                  {scene.source.mediaWidth && scene.source.mediaHeight ? (
                    <span className="truncate text-[8px] text-slate-500">{scene.source.mediaWidth}×{scene.source.mediaHeight}</span>
                  ) : null}
                </div>
                <div className={cn(
                  'mt-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-[9px]',
                  hasMedia ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-300',
                )}>
                  {hasMedia ? <Film size={9} /> : <Upload size={9} />}
                  <span className="truncate">{hasMedia ? scene.source.name.slice(0, 18) : 'Média manquant'}</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[9px] text-slate-500">
                  <span>{scene.duration.toFixed(1)} s{scene.trimStart > 0 ? ` · in ${scene.trimStart.toFixed(1)}s` : ''}</span>
                  <span>{scene.transition === 'cut' ? 'coupe' : scene.transition}</span>
                </div>
                {/* Interactive right-edge duration trim handle */}
                <button
                  type="button"
                  onPointerDown={(e) => startTrimDrag(e, scene)}
                  aria-label={`Redimensionner la durée de ${scene.label}`}
                  title="Glisser pour ajuster la durée"
                  className="absolute inset-y-1 right-0 w-2 cursor-ew-resize rounded-r bg-white/[0.04] opacity-40 transition hover:bg-cyan-400/50 group-hover:opacity-100"
                />
              </div>
            );
          })}
        </div>

        {/* Track 2: Subtitles */}
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500">
          <Subtitles size={11} /> Piste sous-titres
        </div>
        <div className="no-scrollbar flex min-h-[42px] gap-1 overflow-x-auto rounded-xl border border-white/[0.06] bg-black/30 p-1.5">
          {!project.subtitlesEnabled && <span className="m-auto text-[10px] text-slate-600">Sous-titres désactivés</span>}
          {project.subtitlesEnabled && spans.length === 0 && <span className="m-auto text-[10px] text-slate-600">Aucun sous-titre saisi</span>}
          {project.subtitlesEnabled && spans.map((s) => (
            <button
              key={`${s.sceneId}-${s.start}`}
              type="button"
              onClick={() => {
                onSelect(s.sceneId);
                onSeek(s.start);
              }}
              style={{ width: widthFor(Math.max(0.5, s.end - s.start)) }}
              className={cn(
                'min-w-[60px] shrink-0 truncate rounded border px-1.5 py-1 text-left text-[9px]',
                s.text.length > 90
                  ? 'border-amber-400/35 bg-amber-400/[0.08] text-amber-100'
                  : 'border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-100',
              )}
              title={`${s.text} (${s.start.toFixed(1)}s → ${s.end.toFixed(1)}s)`}
            >
              {s.text.slice(0, 26)}…
            </button>
          ))}
        </div>

        {/* Track 3: Dedicated Voiceover */}
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500">
          <Mic size={11} /> Piste voix off
        </div>
        <div className="flex min-h-[40px] flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-black/30 px-3 py-1.5 text-[10px]">
          {voiceover.kind === 'none' ? (
            <span className="text-slate-500">Aucune voix off · importez un enregistrement ou utilisez le micro (aucun TTS IA connecté)</span>
          ) : (
            <span className="flex items-center gap-1.5 text-emerald-200">
              <Mic size={11} /> {voiceover.name}
              {voiceover.sourceDuration ? ` (${voiceover.sourceDuration.toFixed(1)} s)` : ''}
              {' · '}{Math.round(voiceover.volume * 100)} %
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {voiceRef && onImportVoiceover && (
              <>
                <input
                  ref={voiceRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onImportVoiceover(f);
                    e.target.value = '';
                  }}
                />
                <button type="button" onClick={() => voiceRef.current?.click()} className="studio-chip">Importer voix off</button>
              </>
            )}
            {onOpenVoiceTab && (
              <button type="button" onClick={onOpenVoiceTab} className="studio-chip text-cyan-200"><Mic size={11} /> Enregistrer / script</button>
            )}
            {voiceover.kind !== 'none' && (
              <>
                <button
                  type="button"
                  onClick={() => onChange({ ...project, voiceover: { ...voiceover, muted: !voiceover.muted } })}
                  className="studio-icon-link"
                  aria-label={voiceover.muted ? 'Réactiver la voix off' : 'Couper la voix off'}
                >
                  {voiceover.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                </button>
                <button
                  type="button"
                  onClick={() => onChange({ ...project, voiceover: emptyAudio(1) })}
                  className="studio-icon-link hover:text-rose-300"
                  aria-label="Retirer la voix off"
                >
                  <Trash2 size={11} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Track 4: Background Music / Ambience */}
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500">
          <Music2 size={11} /> Piste musique / ambiance
        </div>
        <div className="flex min-h-[40px] flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-black/30 px-3 py-1.5 text-[10px]">
          {project.audio.kind === 'none' ? (
            <span className="text-slate-600">Aucune musique · son des clips uniquement</span>
          ) : (
            <span className="flex items-center gap-1.5 text-cyan-200">
              <Music2 size={11} /> {project.audio.name} · volume {Math.round(project.audio.volume * 100)} %
              {project.audioDucking && voiceover.kind !== 'none' && (
                <span className="rounded bg-cyan-400/15 px-1.5 py-0.5 text-[9px] text-cyan-200">Ducking actif</span>
              )}
            </span>
          )}
          <input
            ref={audioRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportAudio(f);
              e.target.value = '';
            }}
          />
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => audioRef.current?.click()} className="studio-chip">Importer musique</button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={project.audio.volume}
              onChange={(e) => onChange({ ...project, audio: { ...project.audio, volume: Number(e.target.value) } })}
              className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-white/10 accent-cyan-400"
              aria-label="Volume audio"
            />
            {project.audio.kind !== 'none' && (
              <button
                type="button"
                onClick={() => onChange({ ...project, audio: emptyAudio(0.8) })}
                className="studio-icon-link hover:text-rose-300"
                aria-label="Retirer la musique"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Scene inspector — touch friendly, works seamlessly on mobile & desktop */}
      {selected && (
        <div className="border-t border-white/[0.06] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-white">
              <Scissors size={13} className="text-cyan-300" /> Plan sélectionné · {selected.label}
              {selected.source.sourceDuration && (
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-normal text-slate-400">
                  clip réel : {selected.source.sourceDuration.toFixed(1)} s
                </span>
              )}
            </p>
            <div className="flex flex-wrap gap-1">
              <button type="button" onClick={() => reorder(-1)} className="studio-icon-link" title="Déplacer avant" aria-label="Déplacer le plan avant"><ChevronLeft size={13} /></button>
              <button type="button" onClick={() => reorder(1)} className="studio-icon-link" title="Déplacer après" aria-label="Déplacer le plan après"><ChevronRight size={13} /></button>
              <button
                type="button"
                disabled={selected.duration < 1 || project.scenes.length >= 24}
                onClick={() => onChange(splitScene(project, selected.id))}
                className="studio-icon-link disabled:opacity-40"
                title="Scinder ce plan en deux"
              >
                <Scissors size={12} /> Scinder
              </button>
              <button type="button" onClick={onDuplicate} className="studio-icon-link" title="Dupliquer ce plan" aria-label="Dupliquer le plan"><Copy size={12} /></button>
              <button type="button" onClick={() => onChange(removeScene(project, selected.id))} className="studio-icon-link hover:text-rose-300" title="Supprimer la scène" aria-label="Supprimer le plan"><Trash2 size={13} /></button>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-[10px] text-slate-400">Rôle UGC
              <select
                value={selected.role}
                onChange={(e) => {
                  const role = e.target.value as SceneRole;
                  const roleLabel = SCENE_ROLES.find((r) => r.id === role)?.label;
                  patchSelected({ role, ...(roleLabel ? { label: roleLabel } : {}) });
                }}
                className="studio-select mt-1 w-full"
              >
                {SCENE_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </label>
            <label className="text-[10px] text-slate-400">Durée (s)
              <input
                type="number"
                min={0.5}
                max={60}
                step={0.5}
                value={selected.duration}
                onChange={(e) => onChange(trimScene(project, selected.id, { duration: Number(e.target.value) }))}
                className="studio-number mt-1"
              />
            </label>
            <label className="text-[10px] text-slate-400">Point d’entrée (s)
              <input
                type="number"
                min={0}
                max={selected.source.sourceDuration ? Math.max(0, selected.source.sourceDuration - 0.5) : 120}
                step={0.5}
                value={selected.trimStart}
                onChange={(e) => onChange(trimScene(project, selected.id, { trimStart: Number(e.target.value) }))}
                className="studio-number mt-1"
              />
            </label>
            <label className="text-[10px] text-slate-400">Transition sortante
              <select
                value={selected.transition}
                onChange={(e) => patchSelected({ transition: e.target.value as EditorScene['transition'] })}
                className="studio-select mt-1 w-full"
              >
                {TRANSITIONS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
          </div>

          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-[10px] text-slate-400">Cadrage média
              <select
                value={selected.fitMode ?? 'cover'}
                onChange={(e) => patchSelected({ fitMode: e.target.value as FitMode })}
                className="studio-select mt-1 w-full"
              >
                <option value="cover">Plein cadre (cover)</option>
                <option value="contain">Image entière (contain)</option>
              </select>
            </label>
            <label className="text-[10px] text-slate-400">Durée transition (s)
              <input
                type="number"
                min={0.15}
                max={1.2}
                step={0.05}
                value={selected.transitionDuration ?? 0.4}
                onChange={(e) => patchSelected({ transitionDuration: Number(e.target.value) })}
                className="studio-number mt-1"
              />
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => patchSelected({ muted: !selected.muted })}
                className="studio-chip flex-1 justify-center"
              >
                {selected.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                {selected.muted ? 'Clip muet' : `Son clip ${Math.round((selected.volume ?? 1) * 100)}%`}
              </button>
            </div>
            <div className="flex flex-wrap items-end gap-1.5">
              <input
                ref={fileRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && selected) onImport(f, selected.id);
                  e.target.value = '';
                }}
              />
              <button type="button" onClick={() => fileRef.current?.click()} className="studio-chip flex-1 justify-center">
                <Upload size={12} /> Importer un clip
              </button>
              {onOpenLibrary && (
                <button type="button" onClick={onOpenLibrary} className="studio-chip justify-center" title="Choisir dans les médias du projet">
                  <FolderOpen size={12} />
                </button>
              )}
            </div>
          </div>

          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="block text-[10px] text-slate-400">
              Sous-titre du plan ({selected.subtitle.length} car.)
              <input
                value={selected.subtitle}
                onChange={(e) => patchSelected({ subtitle: e.target.value.slice(0, 500) })}
                className="studio-input mt-1"
                placeholder="Texte affiché à l’écran…"
              />
            </label>
            <label className="block text-[10px] text-slate-400">
              Voix off / texte parlé ({selectedWordCount} mots · ~{selectedSpeechSec} s)
              <input
                value={selected.spokenText}
                onChange={(e) => patchSelected({ spokenText: e.target.value.slice(0, 2000) })}
                className="studio-input mt-1"
                placeholder="Contexte de synchronisation…"
              />
            </label>
            <label className="block text-[10px] text-slate-400 sm:col-span-2">Instruction visuelle du plan
              <textarea
                value={selected.visualPrompt}
                onChange={(e) => patchSelected({ visualPrompt: e.target.value.slice(0, 4000) })}
                rows={2}
                className="studio-input mt-1 resize-none"
                placeholder="Note de production…"
              />
            </label>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
            Glissez les blocs pour réordonner sur ordinateur ; utilisez les flèches sur mobile. Aucun média n’est fabriqué : un plan sans source reste explicitement vide.
          </p>
        </div>
      )}
    </div>
  );
}
