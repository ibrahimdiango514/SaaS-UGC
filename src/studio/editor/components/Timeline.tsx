import { useRef } from 'react';
import {
  ChevronLeft, ChevronRight, Film, GripVertical, Music2, Pause, Play, Scissors,
  Subtitles, Trash2, Upload,
} from 'lucide-react';
import { cn } from '../../../components/ui';
import { TRANSITIONS, totalDuration, moveScene, patchScene, removeScene,
  type EditorProject, type EditorScene } from '../types';
import { subtitleSpans } from '../assist';

const MIN_BLOCK = 56;

export function Timeline({ project, onChange, selectedId, onSelect, playhead, onSeek, playing, onTogglePlay, onImport, onImportAudio }: {
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
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const dragFrom = useRef<number | null>(null);
  const total = Math.max(0.1, totalDuration(project));
  const selected = project.scenes.find((s) => s.id === selectedId) ?? null;
  const spans = subtitleSpans(project);

  const widthFor = (duration: number) => `${Math.max(MIN_BLOCK, (duration / total) * 100)}%`;
  const timeLabel = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${String(Math.floor((t % 1) * 10))}`;

  const patchSelected = (p: Partial<EditorScene>) => {
    if (!selected) return;
    onChange(patchScene(project, selected.id, p));
  };

  const reorder = (delta: number) => {
    const i = project.scenes.findIndex((s) => s.id === selectedId);
    if (i < 0) return;
    onChange(moveScene(project, i, Math.min(project.scenes.length - 1, Math.max(0, i + delta))));
  };

  return (
    <div className="studio-v2 rounded-2xl border border-white/[0.08] bg-[#080d14]">
      {/* Playback controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
        <button type="button" onClick={onTogglePlay} className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-400 text-[#04121a]" aria-label={playing ? 'Pause' : 'Lecture'}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <span className="font-mono text-[11px] text-cyan-200">{timeLabel(playhead)}</span>
        <input type="range" min={0} max={total} step={0.1} value={Math.min(playhead, total)}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="h-1.5 min-w-[120px] flex-1 cursor-pointer appearance-none rounded-full bg-white/10 accent-cyan-400" aria-label="Position de lecture" />
        <span className="font-mono text-[11px] text-slate-500">{timeLabel(total)}</span>
        <span className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-slate-400">{project.scenes.length} plans · {total.toFixed(1)} s</span>
      </div>

      {/* Tracks */}
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500">
          <Film size={11} /> Piste vidéo
        </div>
        <div className="no-scrollbar flex min-h-[86px] gap-1.5 overflow-x-auto rounded-xl border border-white/[0.06] bg-black/30 p-2"
          role="list" aria-label="Scènes vidéo">
          {project.scenes.length === 0 && <p className="m-auto text-[11px] text-slate-600">Aucune scène. Créez un plan depuis le Video Studio.</p>}
          {project.scenes.map((scene, i) => {
            const hasMedia = scene.source.kind !== 'none' && Boolean(scene.source.url);
            return (
              <div key={scene.id} role="listitem" draggable
                onDragStart={() => { dragFrom.current = i; }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom.current !== null) onChange(moveScene(project, dragFrom.current, i));
                  dragFrom.current = null;
                }}
                onClick={() => onSelect(scene.id)}
                style={{ width: widthFor(scene.duration) }}
                className={cn(
                  'group relative min-w-[56px] shrink-0 cursor-pointer overflow-hidden rounded-lg border p-2 transition',
                  selectedId === scene.id ? 'border-cyan-400/70 bg-cyan-400/[0.12]' : 'border-white/[0.09] bg-white/[0.03] hover:border-cyan-400/30',
                )}>
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-[11px] font-semibold text-white">{i + 1}. {scene.label}</span>
                  <GripVertical size={11} className="shrink-0 text-slate-600" />
                </div>
                <div className={cn('mt-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-[9px]',
                  hasMedia ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-300')}>
                  {hasMedia ? <Film size={9} /> : <Upload size={9} />}
                  <span className="truncate">{hasMedia ? scene.source.name.slice(0, 18) : 'Média manquant'}</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[9px] text-slate-500">
                  <span>{scene.duration.toFixed(1)} s</span><span>{scene.transition === 'cut' ? 'coupe' : scene.transition}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500"><Music2 size={11} /> Piste audio</div>
        <div className="flex min-h-[38px] flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-black/30 px-3 text-[10px]">
          {project.audio.kind === 'none'
            ? <span className="text-slate-600">Aucune piste audio · son des clips uniquement (pas de TTS connecté)</span>
            : <span className="flex items-center gap-1.5 text-cyan-200"><Music2 size={11} /> {project.audio.name} · volume {Math.round(project.audio.volume * 100)} %</span>}
          <input ref={audioRef} type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImportAudio(f); }} />
          <button type="button" onClick={() => audioRef.current?.click()} className="studio-chip ml-auto">Importer audio</button>
          <input type="range" min={0} max={1} step={0.05} value={project.audio.volume}
            onChange={(e) => onChange({ ...project, audio: { ...project.audio, volume: Number(e.target.value) } })}
            className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-white/10 accent-cyan-400" aria-label="Volume audio" />
        </div>

        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500"><Subtitles size={11} /> Piste sous-titres</div>
        <div className="no-scrollbar flex min-h-[42px] gap-1 overflow-x-auto rounded-xl border border-white/[0.06] bg-black/30 p-1.5">
          {!project.subtitlesEnabled && <span className="m-auto text-[10px] text-slate-600">Sous-titres désactivés</span>}
          {project.subtitlesEnabled && spans.length === 0 && <span className="m-auto text-[10px] text-slate-600">Aucun sous-titre saisi</span>}
          {project.subtitlesEnabled && spans.map((s) => (
            <button key={`${s.sceneIndex}-${s.start}`} type="button" onClick={() => onSelect(project.scenes[s.sceneIndex].id)}
              style={{ width: widthFor(s.end - s.start) }}
              className="min-w-[56px] shrink-0 truncate rounded border border-cyan-400/20 bg-cyan-400/[0.06] px-1.5 py-1 text-left text-[9px] text-cyan-100"
              title={s.text}>{s.text.slice(0, 24)}…</button>
          ))}
        </div>
      </div>

      {/* Scene inspector — touch friendly, works on mobile via buttons */}
      {selected && (
        <div className="border-t border-white/[0.06] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-white"><Scissors size={13} className="text-cyan-300" /> Plan sélectionné · {selected.label}</p>
            <div className="flex gap-1">
              <button type="button" onClick={() => reorder(-1)} className="studio-icon-link" title="Déplacer avant"><ChevronLeft size={13} /></button>
              <button type="button" onClick={() => reorder(1)} className="studio-icon-link" title="Déplacer après"><ChevronRight size={13} /></button>
              <button type="button" onClick={() => onChange(removeScene(project, selected.id))} className="studio-icon-link hover:text-rose-300" title="Supprimer la scène"><Trash2 size={13} /></button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-[10px] text-slate-400">Durée (s)
              <input type="number" min={0.5} max={60} step={0.5} value={selected.duration}
                onChange={(e) => patchSelected({ duration: Number(e.target.value) })} className="studio-number mt-1" />
            </label>
            <label className="text-[10px] text-slate-400">Point d’entrée (s)
              <input type="number" min={0} step={0.5} value={selected.trimStart}
                onChange={(e) => patchSelected({ trimStart: Number(e.target.value) })} className="studio-number mt-1" />
            </label>
            <label className="text-[10px] text-slate-400">Transition
              <select value={selected.transition} onChange={(e) => patchSelected({ transition: e.target.value as EditorScene['transition'] })} className="studio-select mt-1 w-full">
                {TRANSITIONS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            <div className="flex flex-col justify-end">
              <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && selected) onImport(f, selected.id);
                e.target.value = '';
              }} />
              <button type="button" onClick={() => fileRef.current?.click()} className="studio-chip justify-center"><Upload size={12} /> Importer un clip</button>
            </div>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="block text-[10px] text-slate-400">Sous-titre du plan
              <input value={selected.subtitle} onChange={(e) => patchSelected({ subtitle: e.target.value.slice(0, 500) })}
                className="studio-input mt-1" placeholder="Texte affiché à l’écran…" />
            </label>
            <label className="block text-[10px] text-slate-400">Voix off / texte parlé
              <input value={selected.spokenText} onChange={(e) => patchSelected({ spokenText: e.target.value.slice(0, 2000) })}
                className="studio-input mt-1" placeholder="Contexte de synchronisation…" />
            </label>
            <label className="block text-[10px] text-slate-400 sm:col-span-2">Instruction visuelle du plan
              <textarea value={selected.visualPrompt} onChange={(e) => patchSelected({ visualPrompt: e.target.value.slice(0, 4000) })}
                rows={2} className="studio-input mt-1 resize-none" placeholder="Note de production…" />
            </label>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-600">Glissez les blocs pour réordonner sur ordinateur ; utilisez les flèches sur mobile. Aucun média n’est fabriqué : un plan sans source reste explicitement vide.</p>
        </div>
      )}
    </div>
  );
}
