/**
 * Montage assistance — deterministic LOCAL rules, explicitly not AI.
 *
 * Reelora's AI-assisted suggestions require a configured Groq key. While it is
 * absent, these rules provide real, reviewable editing help (detect, propose,
 * accept / refuse / modify). They never fabricate an AI answer or a media file.
 */

import { clampDuration, patchScene, moveScene, totalDuration, type EditorProject } from './types';

export type SuggestionKind =
  | 'media' | 'hook' | 'cta' | 'pacing' | 'subtitles' | 'coherence'
  | 'transitions' | 'audio' | 'cuts' | 'visual-consistency' | 'sync';

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'error';
  /** Real state change applied when the user accepts. `null` = guidance only. */
  apply: ((project: EditorProject) => EditorProject) | null;
}

function findRole(project: EditorProject, role: string): number {
  return project.scenes.findIndex((s) => s.role === role);
}

export function analyzeProject(project: EditorProject, targetDuration = 20): Suggestion[] {
  const out: Suggestion[] = [];
  const scenes = project.scenes;
  const total = totalDuration(project);
  const withoutMedia = scenes.filter((s) => s.source.kind === 'none' || !s.source.url);

  if (scenes.length === 0) {
    return [{
      id: 'empty', kind: 'media', title: 'Aucune scène', severity: 'error',
      detail: 'Créez un plan depuis une instruction ou importez des clips pour commencer le montage.',
      apply: null,
    }];
  }

  if (withoutMedia.length > 0) {
    out.push({
      id: 'media', kind: 'media', title: `${withoutMedia.length} plan(s) sans média`, severity: 'error',
      detail: `L’export est refusé tant qu’un plan n’a pas de source réelle : ${withoutMedia.map((s) => s.label).join(', ')}. Importez un clip, utilisez une création de la bibliothèque ou lancez une génération.`,
      apply: null,
    });
  }

  const hook = findRole(project, 'hook');
  if (hook > 0) {
    out.push({
      id: 'hook', kind: 'hook', title: 'Placer l’accroche en ouverture', severity: 'warning',
      detail: 'Une publicité UGC performante commence par l’accroche. Déplacez ce plan en première position.',
      apply: (p) => moveScene(p, hook, 0),
    });
  }

  const cta = findRole(project, 'cta');
  if (cta >= 0 && cta !== scenes.length - 1) {
    out.push({
      id: 'cta', kind: 'cta', title: 'Terminer par l’appel à l’action', severity: 'warning',
      detail: 'Déplacez l’appel à l’action en fin de montage pour conclure la progression narrative.',
      apply: (p) => moveScene(p, cta, p.scenes.length - 1),
    });
  }

  if (Math.abs(total - targetDuration) > 3) {
    const factor = targetDuration / Math.max(total, 0.1);
    out.push({
      id: 'pacing', kind: 'pacing', title: total > targetDuration ? 'Resserrer le rythme' : 'Allonger le montage',
      severity: 'info',
      detail: `Durée actuelle ${total.toFixed(1)} s, cible ${targetDuration} s. Ajuster proportionnellement chaque plan.`,
      apply: (p) => ({ ...p, scenes: p.scenes.map((s) => ({ ...s, duration: clampDuration(s.duration * factor) })), updatedAt: new Date().toISOString() }),
    });
  }

  const withSpoken = scenes.filter((s) => s.spokenText.trim().length > 5);
  if (withSpoken.length && (!project.subtitlesEnabled || withSpoken.some((s) => !s.subtitle.trim()))) {
    out.push({
      id: 'subtitles', kind: 'subtitles', title: 'Générer les sous-titres depuis la voix off', severity: 'info',
      detail: 'Les sous-titres sont construits à partir du texte de chaque plan (synthèse vocale et transcription automatique non disponibles).',
      apply: (p) => ({
        ...p, subtitlesEnabled: true,
        scenes: p.scenes.map((s) => s.spokenText.trim() ? { ...s, subtitle: s.spokenText.trim().slice(0, 110) } : s),
        updatedAt: new Date().toISOString(),
      }),
    });
  }

  const longSubtitles = scenes.filter((s) => s.subtitle.length > 90);
  if (longSubtitles.length) {
    out.push({
      id: 'cuts', kind: 'cuts', title: 'Raccourcir les sous-titres longs', severity: 'info',
      detail: `${longSubtitles.length} sous-titre(s) dépassent 90 caractères et seront illisibles sur mobile.`,
      apply: (p) => ({
        ...p, scenes: p.scenes.map((s) => s.subtitle.length > 90
          ? { ...s, subtitle: `${s.subtitle.slice(0, 87).trimEnd()}…` } : s), updatedAt: new Date().toISOString(),
      }),
    });
  }

  const prompts = scenes.map((s) => s.visualPrompt.trim().toLowerCase()).filter(Boolean);
  if (new Set(prompts).size < prompts.length) {
    out.push({
      id: 'coherence', kind: 'coherence', title: 'Incohérence : instructions visuelles répétées', severity: 'warning',
      detail: 'Plusieurs plans partagent la même instruction visuelle. Différenciez-les avant de générer pour éviter des plans identiques.',
      apply: null,
    });
  }

  if (scenes.length > 1 && scenes.slice(0, -1).every((s) => s.transition === 'cut')) {
    out.push({
      id: 'transitions', kind: 'transitions', title: 'Proposer des transitions', severity: 'info',
      detail: 'Un fondu entre la démonstration et l’appel à l’action fluidifie le montage.',
      apply: (p) => {
        const idx = p.scenes.findIndex((s) => s.role === 'cta');
        const target = idx > 0 ? idx - 1 : p.scenes.length - 2;
        const id = p.scenes[target]?.id;
        return id ? patchScene(p, id, { transition: 'fade' }) : p;
      },
    });
  }

  const tooShort = scenes.filter((s) => s.duration < 1.5);
  if (tooShort.length) {
    out.push({
      id: 'visual-consistency', kind: 'visual-consistency', title: 'Plans trop courts', severity: 'warning',
      detail: `${tooShort.length} plan(s) durent moins de 1,5 s : le spectateur n’a pas le temps de lire l’image.`,
      apply: (p) => ({ ...p, scenes: p.scenes.map((s) => s.duration < 1.5 ? { ...s, duration: 1.5 } : s), updatedAt: new Date().toISOString() }),
    });
  }

  if (project.audio.kind === 'none') {
    out.push({
      id: 'audio', kind: 'audio', title: 'Piste audio absente', severity: 'info',
      detail: 'Le rendu utilise uniquement le son des clips. Reelora ne génère pas encore de voix off ni de musique (aucun moteur TTS connecté).',
      apply: null,
    });
  }

  if (withSpoken.length && scenes.some((s) => s.spokenText.trim() && s.source.kind !== 'none')) {
    out.push({
      id: 'sync', kind: 'sync', title: 'Synchroniser voix et images', severity: 'info',
      detail: 'Les sous-titres sont calés sur la durée de chaque plan. Ajustez les durées dans la timeline pour affiner la synchronisation.',
      apply: null,
    });
  }

  return out;
}

/** Reproducible subtitle spans, used by the compositor and the timeline. */
export function subtitleSpans(project: EditorProject): { sceneIndex: number; start: number; end: number; text: string }[] {
  let cursor = 0;
  return project.scenes.flatMap((s, sceneIndex) => {
    const start = cursor;
    cursor += Math.max(0, s.duration);
    if (!project.subtitlesEnabled || !s.subtitle.trim()) return [];
    return [{ sceneIndex, start, end: cursor, text: s.subtitle.trim() }];
  });
}
