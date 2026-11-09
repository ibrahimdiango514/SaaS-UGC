import { useEffect, useRef } from 'react';
import { Film, Play } from 'lucide-react';
import { ASPECT_PRESETS, type EditorProject } from '../types';

/** True preview of the CURRENT scene's real video source; no synthetic footage. */
export function PreviewPlayer({ project, playhead, playing, onTimeChange, onEnded }: {
  project: EditorProject;
  playhead: number;
  playing: boolean;
  onTimeChange: (t: number) => void;
  onEnded: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  let cursor = 0;
  let index = 0;
  let local = 0;
  for (let i = 0; i < project.scenes.length; i += 1) {
    const d = Math.max(0, project.scenes[i].duration);
    if (playhead < cursor + d || i === project.scenes.length - 1) { index = i; local = Math.max(0, playhead - cursor); break; }
    cursor += d;
  }
  const scene = project.scenes[index] ?? null;
  const url = scene?.source.url ?? '';
  const preset = ASPECT_PRESETS[project.aspect];

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url) return;
    const expected = (scene?.trimStart ?? 0) + local;
    if (Number.isFinite(v.duration) && Number.isFinite(expected)) {
      const clamped = Math.min(expected, Math.max(0, v.duration - 0.05));
      if (Math.abs(v.currentTime - clamped) > 0.35) v.currentTime = clamped;
    }
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [url, playing, index, local, scene?.trimStart]);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-black"
      style={{ aspectRatio: `${preset.width} / ${preset.height}`, maxHeight: 'min(62vh, 620px)' }}>
      {url ? (
        <video ref={videoRef} src={url} playsInline muted controls={false} preload="metadata"
          className="h-full w-full object-contain"
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            const delta = Math.max(0, v.currentTime - (scene?.trimStart ?? 0));
            onTimeChange(cursor + delta);
            if (scene && delta >= scene.duration - 0.05) onEnded();
          }} />
      ) : (
        <div className="grid h-full min-h-[260px] place-items-center px-6 text-center">
          <div>
            <Film size={30} className="mx-auto text-slate-600" />
            <p className="mt-2 text-sm text-slate-300">Aucun média réel pour ce plan</p>
            <p className="mx-auto mt-1 max-w-xs text-[11px] leading-relaxed text-slate-500">
              La prévisualisation n’affiche pas de vidéo fictive. Importez un clip ou attachez une création Reelora depuis la bibliothèque.
            </p>
          </div>
        </div>
      )}
      {project.subtitlesEnabled && scene?.subtitle && url && (
        <div className="pointer-events-none absolute inset-x-[8%] bottom-[7%] rounded-xl bg-black/75 px-3 py-2 text-center text-xs font-medium text-white sm:text-sm">
          {scene.subtitle}
        </div>
      )}
      <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-lg bg-black/65 px-2 py-1 text-[10px] text-cyan-200 backdrop-blur">
        {playing ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" /> : <Play size={10} />}
        Plan {index + 1}/{project.scenes.length} · {scene?.label ?? '—'}
      </div>
      {project.demo && (
        <span className="absolute right-3 top-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[10px] font-semibold text-amber-200">Démo · sans média réel</span>
      )}
    </div>
  );
}
