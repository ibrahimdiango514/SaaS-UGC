import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle, Download, Mic, Music2, Square, Subtitles, Trash2, Upload, Volume2, VolumeX, Wand2,
} from 'lucide-react';
import { Button, Toggle, cn } from '../../../components/ui';
import { estimateSpeechDurationSeconds } from '../assist';
import { buildSrt, downloadBlob } from '../render';
import {
  effectiveSubtitleConfig, effectiveVoiceover, emptyAudio, patchScene, totalDuration,
  type EditorProject, type SubtitlePosition, type SubtitlePreset, type SubtitleSize,
} from '../types';

function micSupported(): boolean {
  const nav = globalThis.navigator as Navigator | undefined;
  const g = globalThis as unknown as { MediaRecorder?: unknown };
  return Boolean(nav?.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function' && typeof g.MediaRecorder === 'function');
}

export function SubtitlesVoiceoverPanel({
  project,
  onChange,
  onImportVoiceover,
  onImportAudio,
  disabled,
}: {
  project: EditorProject;
  onChange: (p: EditorProject) => void;
  onImportVoiceover: (file: File) => void;
  onImportAudio: (file: File) => void;
  disabled?: boolean;
}) {
  const voiceFileRef = useRef<HTMLInputElement>(null);
  const musicFileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [micError, setMicError] = useState('');

  const subCfg = effectiveSubtitleConfig(project);
  const voiceover = effectiveVoiceover(project);
  const timelineTotal = totalDuration(project);
  const totalWords = project.scenes.reduce((n, s) => n + s.spokenText.trim().split(/\s+/).filter(Boolean).length, 0);
  const estimatedSpeechSec = project.scenes.reduce((n, s) => n + estimateSpeechDurationSeconds(s.spokenText), 0);
  const srtContent = buildSrt(project);
  const hasMic = micSupported();

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    } catch { /* ignore */ }
    streamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
  }, []);

  const stopRecording = () => {
    if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null; }
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    } catch { /* ignore */ }
    setRecording(false);
  };

  const startRecording = async () => {
    setMicError('');
    if (!hasMic) {
      setMicError('Enregistrement micro indisponible dans cet environnement (MediaDevices / MediaRecorder absent). Importez un fichier audio à la place.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm' : '';
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onerror = () => setMicError('Erreur d’enregistrement micro.');
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
        streamRef.current = null;
        if (chunks.length > 0) {
          const type = recorder.mimeType || 'audio/webm';
          const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
          const blob = new Blob(chunks, { type });
          const file = new File([blob], `voix-off-${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}.${ext}`, { type });
          onImportVoiceover(file);
        }
      };
      recorderRef.current = recorder;
      recorder.start(250);
      setRecordSeconds(0);
      setRecording(true);
      timerRef.current = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch (err) {
      setMicError(err instanceof Error ? `Accès micro refusé ou impossible : ${err.message}` : 'Accès micro refusé.');
      setRecording(false);
    }
  };

  const generateSubsFromSpoken = () => {
    onChange({
      ...project,
      subtitlesEnabled: true,
      scenes: project.scenes.map((s) => s.spokenText.trim()
        ? { ...s, subtitle: s.spokenText.trim().slice(0, 110) } : s),
      updatedAt: new Date().toISOString(),
    });
  };

  const shortenSubsForMobile = () => {
    onChange({
      ...project,
      scenes: project.scenes.map((s) => s.subtitle.length > 90
        ? { ...s, subtitle: `${s.subtitle.slice(0, 87).trimEnd()}…` } : s),
      updatedAt: new Date().toISOString(),
    });
  };

  const exportSrt = () => {
    if (!srtContent.trim()) return;
    const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
    const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'vyora';
    downloadBlob(blob, `${slug}-sous-titres.srt`);
  };

  const patchSubConfig = (patch: Partial<typeof subCfg>) => {
    onChange({
      ...project,
      subtitleConfig: { ...subCfg, ...patch },
      updatedAt: new Date().toISOString(),
    });
  };

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {/* Subtitles Management */}
      <section className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4" aria-label="Gestion des sous-titres">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-white">
            <Subtitles size={13} className="text-cyan-300" /> Sous-titres & habillage
          </p>
          <Toggle
            checked={project.subtitlesEnabled}
            onChange={(v) => onChange({ ...project, subtitlesEnabled: v })}
            label="Incrustés"
          />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <label className="text-[10px] text-slate-400">Position
            <select
              disabled={disabled}
              value={subCfg.position}
              onChange={(e) => patchSubConfig({ position: e.target.value as SubtitlePosition })}
              className="studio-select mt-1 w-full"
            >
              <option value="bottom">Bas (standard)</option>
              <option value="center">Centre</option>
              <option value="top">Haut</option>
            </select>
          </label>
          <label className="text-[10px] text-slate-400">Style
            <select
              disabled={disabled}
              value={subCfg.style}
              onChange={(e) => patchSubConfig({ style: e.target.value as SubtitlePreset })}
              className="studio-select mt-1 w-full"
            >
              <option value="box">Boîte sombre</option>
              <option value="pill">Pilule cyan</option>
              <option value="outline">Contour net</option>
            </select>
          </label>
          <label className="text-[10px] text-slate-400">Taille
            <select
              disabled={disabled}
              value={subCfg.size}
              onChange={(e) => patchSubConfig({ size: e.target.value as SubtitleSize })}
              className="studio-select mt-1 w-full"
            >
              <option value="sm">Compacte</option>
              <option value="md">Moyenne</option>
              <option value="lg">Impact</option>
            </select>
          </label>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Toggle
            checked={subCfg.uppercase}
            onChange={(v) => patchSubConfig({ uppercase: v })}
            label="Majuscules"
          />
          <button type="button" disabled={disabled} onClick={generateSubsFromSpoken} className="studio-chip">
            <Wand2 size={11} /> Copier depuis voix off
          </button>
          <button type="button" disabled={disabled} onClick={shortenSubsForMobile} className="studio-chip">
            Couper ≤ 90 car.
          </button>
          <button
            type="button"
            disabled={!srtContent.trim()}
            onClick={exportSrt}
            className="studio-chip text-cyan-200 disabled:opacity-40"
          >
            <Download size={11} /> Exporter .SRT
          </button>
        </div>

        <div className="mt-3 max-h-[240px] space-y-2 overflow-y-auto pr-1">
          {project.scenes.map((scene, idx) => (
            <div key={scene.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
              <div className="flex items-center justify-between text-[10px] text-slate-400">
                <span className="font-semibold text-white">{idx + 1}. {scene.label} ({scene.duration.toFixed(1)} s)</span>
                <span className={cn(scene.subtitle.length > 90 ? 'text-amber-300' : 'text-slate-500')}>
                  {scene.subtitle.length} car.
                </span>
              </div>
              <input
                value={scene.subtitle}
                disabled={disabled}
                onChange={(e) => onChange(patchScene(project, scene.id, { subtitle: e.target.value.slice(0, 500) }))}
                placeholder="Sous-titre de ce plan…"
                className="studio-input mt-1.5"
              />
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <label className="text-[9px] text-slate-500">Début dans le plan (s)
                  <input
                    type="number"
                    min={0}
                    max={scene.duration}
                    step={0.1}
                    value={scene.subtitleStart ?? 0}
                    onChange={(e) => onChange(patchScene(project, scene.id, { subtitleStart: Number(e.target.value) }))}
                    className="studio-number mt-0.5"
                  />
                </label>
                <label className="text-[9px] text-slate-500">Fin dans le plan (s)
                  <input
                    type="number"
                    min={0}
                    max={scene.duration}
                    step={0.1}
                    value={scene.subtitleEnd ?? scene.duration}
                    onChange={(e) => onChange(patchScene(project, scene.id, { subtitleEnd: Number(e.target.value) }))}
                    className="studio-number mt-0.5"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Voiceover & Audio Tracks */}
      <section className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4" aria-label="Gestion de la voix off et de l’audio">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-white">
          <Mic size={13} className="text-cyan-300" /> Voix off & mixage audio
        </p>
        <div className="mt-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-2.5 text-[10px] leading-relaxed text-amber-200">
          <AlertCircle size={11} className="mr-1 inline" />
          Synthèse vocale IA (TTS) non connectée côté serveur : aucune voix artificielle n’est simulée. Importez un fichier voix off ou enregistrez votre voix réelle au micro.
        </div>

        {/* Real microphone recorder + import */}
        <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/25 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-white">Piste Voix off</span>
            <div className="flex flex-wrap gap-1.5">
              <input
                ref={voiceFileRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onImportVoiceover(f);
                  e.target.value = '';
                }}
              />
              <Button size="sm" variant="outline" disabled={disabled} icon={<Upload size={12} />} onClick={() => voiceFileRef.current?.click()}>
                Importer fichier
              </Button>
              {recording ? (
                <Button size="sm" variant="danger" icon={<Square size={12} />} onClick={stopRecording}>
                  Arrêter ({recordSeconds}s)
                </Button>
              ) : (
                <Button size="sm" disabled={disabled || !hasMic} icon={<Mic size={12} />} onClick={() => void startRecording()}>
                  Enregistrer micro
                </Button>
              )}
            </div>
          </div>

          {!hasMic && (
            <p className="mt-1.5 text-[10px] text-slate-500">
              Capture micro indisponible dans cet environnement ; l’import de fichier audio réel reste pleinement fonctionnel.
            </p>
          )}
          {micError && <p className="mt-1.5 text-[10px] text-rose-300">{micError}</p>}

          {voiceover.kind !== 'none' && (
            <div className="mt-2.5 space-y-2 border-t border-white/[0.06] pt-2.5 text-[10px]">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-emerald-200">{voiceover.name}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onChange({ ...project, voiceover: { ...voiceover, muted: !voiceover.muted } })}
                    className="studio-icon-link"
                    aria-label={voiceover.muted ? 'Réactiver voix off' : 'Couper voix off'}
                  >
                    {voiceover.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange({ ...project, voiceover: emptyAudio(1) })}
                    className="studio-icon-link hover:text-rose-300"
                    aria-label="Supprimer voix off"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-slate-400">Volume ({Math.round(voiceover.volume * 100)}%)
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={voiceover.volume}
                    onChange={(e) => onChange({ ...project, voiceover: { ...voiceover, volume: Number(e.target.value) } })}
                    className="mt-1.5 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-cyan-400"
                  />
                </label>
                <label className="text-slate-400">Décalage timeline (s)
                  <input
                    type="number"
                    min={0}
                    max={Math.max(0, timelineTotal)}
                    step={0.5}
                    value={voiceover.startAt ?? 0}
                    onChange={(e) => onChange({ ...project, voiceover: { ...voiceover, startAt: Math.max(0, Number(e.target.value) || 0) } })}
                    className="studio-number mt-1"
                  />
                </label>
                <label className="text-slate-400">Trim audio (s)
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={voiceover.trimStart ?? 0}
                    onChange={(e) => onChange({ ...project, voiceover: { ...voiceover, trimStart: Math.max(0, Number(e.target.value) || 0) } })}
                    className="studio-number mt-1"
                  />
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Music / ambience track */}
        <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/25 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-white">
              <Music2 size={12} className="text-cyan-300" /> Musique / ambiance
            </span>
            <div className="flex items-center gap-1.5">
              <input
                ref={musicFileRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onImportAudio(f);
                  e.target.value = '';
                }}
              />
              <Button size="sm" variant="outline" disabled={disabled} icon={<Upload size={12} />} onClick={() => musicFileRef.current?.click()}>
                Importer musique
              </Button>
            </div>
          </div>
          {project.audio.kind !== 'none' && (
            <div className="mt-2.5 space-y-2 border-t border-white/[0.06] pt-2.5 text-[10px]">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-cyan-200">{project.audio.name}</span>
                <button
                  type="button"
                  onClick={() => onChange({ ...project, audio: emptyAudio(0.8) })}
                  className="studio-icon-link hover:text-rose-300"
                >
                  <Trash2 size={11} />
                </button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-slate-400">Volume ({Math.round(project.audio.volume * 100)}%)
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={project.audio.volume}
                    onChange={(e) => onChange({ ...project, audio: { ...project.audio, volume: Number(e.target.value) } })}
                    className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-white/10 accent-cyan-400"
                  />
                </label>
                <Toggle
                  checked={project.audioDucking !== false}
                  onChange={(v) => onChange({ ...project, audioDucking: v })}
                  label="Ducking sous voix off"
                />
              </div>
            </div>
          )}
        </div>

        {/* Teleprompter & pacing summary */}
        <div className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-[10px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-white">Téléprompteur voix off</span>
            <span className={cn(estimatedSpeechSec > timelineTotal ? 'text-amber-300' : 'text-emerald-300')}>
              {totalWords} mots · ~{estimatedSpeechSec.toFixed(1)} s parlées / {timelineTotal.toFixed(1)} s montage
            </span>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-300">
            {project.scenes.map((s) => s.spokenText.trim()).filter(Boolean).join('\n') || 'Aucun texte parlé saisi dans les plans.'}
          </p>
        </div>
      </section>
    </div>
  );
}
