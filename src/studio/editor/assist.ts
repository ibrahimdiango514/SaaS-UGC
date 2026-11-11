/**
 * Montage assistance — deterministic LOCAL rules, explicitly not AI.
 *
 * VYORA's AI-assisted suggestions require a configured Groq key (`reelora-ai`).
 * While it is absent, these deterministic local rules analyze the timeline,
 * real project media dimensions/durations, UGC pacing presets, voiceover WPM,
 * transitions and subtitles to propose concrete, reviewable edits (accept /
 * modify / reject). They never fabricate an AI answer or a media file.
 */

import { assembleFromProjectMedia, type ProjectMediaItem } from './projectMedia';
import {
  ASPECT_PRESETS, UGC_RHYTHM_PRESETS, clampDuration, clampTransitionDuration,
  effectiveVoiceover, moveScene, patchScene, reorderScenesByIds, splitScene,
  totalDuration, trimScene, type EditorProject, type FitMode, type SceneRole,
  type TransitionKind, type UgcRhythmPresetId,
} from './types';

export type SuggestionKind =
  | 'media' | 'hook' | 'cta' | 'order' | 'pacing' | 'subtitles' | 'coherence'
  | 'transitions' | 'audio' | 'cuts' | 'visual-consistency' | 'sync';

export interface SuggestionModifySpec {
  label: string;
  inputType: 'number' | 'text' | 'select';
  defaultValue: string;
  hint: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
}

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  origin: 'local-deterministic';
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'error';
  /** Target scene ID when the suggestion applies to a specific clip. */
  targetSceneId?: string;
  /** Real state change applied when the user accepts. `null` = guidance only. */
  apply: ((project: EditorProject) => EditorProject) | null;
  /** Optional custom application when the user chooses "Modifier". */
  applyCustom?: (project: EditorProject, rawValue: string) => EditorProject;
  /** Tailored inline control metadata for "Modifier". */
  modifySpec?: SuggestionModifySpec;
}

export interface AnalyzeOptions {
  preset?: UgcRhythmPresetId;
  targetDuration?: number;
  mediaItems?: ProjectMediaItem[];
}

function findRole(project: EditorProject, role: string): number {
  return project.scenes.findIndex((s) => s.role === role);
}

/** Average French/UGC speaking rate: ~150 words/min = 2.5 words/sec. */
export function estimateSpeechDurationSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return Number((words / 2.5).toFixed(1));
}

function aspectRatioValue(aspect: EditorProject['aspect']): number {
  const p = ASPECT_PRESETS[aspect];
  return p.width / p.height;
}

export function analyzeProject(
  project: EditorProject,
  targetDuration?: number,
  options: AnalyzeOptions = {},
): Suggestion[] {
  const presetId: UgcRhythmPresetId = options.preset ?? project.ugcPreset ?? 'ugc-balanced';
  const preset = UGC_RHYTHM_PRESETS[presetId];
  const resolvedTarget = targetDuration ?? options.targetDuration ?? project.targetDuration ?? preset.targetDuration;
  const mediaItems = options.mediaItems ?? [];

  const out: Suggestion[] = [];
  const scenes = project.scenes;
  const total = totalDuration(project);
  const withoutMedia = scenes.filter((s) => s.source.kind === 'none' || !s.source.url);
  const usableVideos = mediaItems.filter((m) => m.mediaType === 'video' && Boolean(m.url));

  if (scenes.length === 0) {
    return [{
      id: 'empty',
      kind: 'media',
      origin: 'local-deterministic',
      title: 'Aucune scène dans la timeline',
      severity: 'error',
      detail: usableVideos.length > 0
        ? `Vous disposez de ${usableVideos.length} vidéo(s) réelle(s) dans le projet. Créez automatiquement la structure UGC à partir de ces médias.`
        : 'Créez un plan depuis une instruction, ajoutez une scène ou importez des clips pour commencer le montage.',
      apply: usableVideos.length > 0 ? (p) => assembleFromProjectMedia(p, mediaItems) : null,
    }];
  }

  // 1. Media completeness & smart project-media auto-assignment
  if (withoutMedia.length > 0) {
    out.push({
      id: 'media',
      kind: 'media',
      origin: 'local-deterministic',
      title: `${withoutMedia.length} plan(s) sans média`,
      severity: 'error',
      detail: usableVideos.length > 0
        ? `Plans vides : ${withoutMedia.map((s) => s.label).join(', ')}. ${usableVideos.length} média(s) réel(s) du projet peuvent être assignés automatiquement, ou importez vos clips.`
        : `L’export est refusé tant qu’un plan n’a pas de source réelle : ${withoutMedia.map((s) => s.label).join(', ')}. Importez un clip ou attachez une création de la bibliothèque.`,
      apply: usableVideos.length > 0 ? (p) => assembleFromProjectMedia(p, mediaItems) : null,
    });
  }

  // 2. Source clip trim bounds vs actual file duration
  const overBounds = scenes.find((s) =>
    s.source.sourceDuration && s.source.sourceDuration >= 0.5 && (s.trimStart + s.duration > s.source.sourceDuration + 0.15),
  );
  if (overBounds && overBounds.source.sourceDuration) {
    const maxUsable = clampDuration(Math.max(0.5, overBounds.source.sourceDuration - overBounds.trimStart));
    out.push({
      id: 'trim-bounds',
      kind: 'cuts',
      origin: 'local-deterministic',
      targetSceneId: overBounds.id,
      title: `Ajuster la coupe de « ${overBounds.label} » à la durée du fichier`,
      severity: 'warning',
      detail: `Le plan demande ${(overBounds.trimStart + overBounds.duration).toFixed(1)} s alors que le clip source dure ${overBounds.source.sourceDuration.toFixed(1)} s. Ajuster la durée à ${maxUsable.toFixed(1)} s évite un gel d’image en fin de plan.`,
      apply: (p) => trimScene(p, overBounds.id, { duration: maxUsable }),
      applyCustom: (p, val) => trimScene(p, overBounds.id, { duration: Number(val) || maxUsable }),
      modifySpec: {
        label: 'Nouvelle durée du plan (s)',
        inputType: 'number',
        defaultValue: String(maxUsable),
        hint: `Maximum sans gel d’image : ${maxUsable.toFixed(1)} s.`,
        min: 0.5,
        max: Math.max(0.5, overBounds.source.sourceDuration),
        step: 0.5,
      },
    });
  }

  // 3. Hook placement at index 0
  const hook = findRole(project, 'hook');
  if (hook > 0) {
    out.push({
      id: 'hook',
      kind: 'hook',
      origin: 'local-deterministic',
      targetSceneId: scenes[hook].id,
      title: 'Placer l’accroche en ouverture',
      severity: 'warning',
      detail: 'Une publicité UGC performante capte l’attention dès la première seconde. Déplacez l’accroche en première position.',
      apply: (p) => moveScene(p, hook, 0),
      applyCustom: (p, val) => {
        const pos = Math.min(p.scenes.length - 1, Math.max(0, (Number(val) || 1) - 1));
        return moveScene(p, hook, pos);
      },
      modifySpec: {
        label: 'Position cible (1 à N)',
        inputType: 'number',
        defaultValue: '1',
        hint: '1 = ouverture immédiate (recommandé en UGC).',
        min: 1,
        max: Math.max(1, scenes.length),
        step: 1,
      },
    });
  }

  // 4. Hook retention duration check (UGC specific)
  if (scenes[0] && (scenes[0].role === 'hook' || hook === 0) && scenes[0].duration > preset.maxHookDuration) {
    const first = scenes[0];
    const targetHook = Math.min(preset.maxHookDuration, 2.5);
    out.push({
      id: 'hook-pacing',
      kind: 'pacing',
      origin: 'local-deterministic',
      targetSceneId: first.id,
      title: 'Accélérer l’accroche d’ouverture',
      severity: 'warning',
      detail: `Votre accroche dure ${first.duration.toFixed(1)} s (recommandation ${preset.label} : ≤ ${preset.maxHookDuration.toFixed(1)} s). Resserrer à ${targetHook.toFixed(1)} s améliore la rétention initiale.`,
      apply: (p) => patchScene(p, first.id, { duration: targetHook }),
      applyCustom: (p, val) => patchScene(p, first.id, { duration: Number(val) || targetHook }),
      modifySpec: {
        label: 'Durée de l’accroche (s)',
        inputType: 'number',
        defaultValue: String(targetHook),
        hint: 'Entre 1,0 s et 4,0 s pour bloquer le scroll.',
        min: 1,
        max: 10,
        step: 0.5,
      },
    });
  }

  // 5. CTA placement at the end
  const cta = findRole(project, 'cta');
  if (cta >= 0 && cta !== scenes.length - 1) {
    out.push({
      id: 'cta',
      kind: 'cta',
      origin: 'local-deterministic',
      targetSceneId: scenes[cta].id,
      title: 'Terminer par l’appel à l’action',
      severity: 'warning',
      detail: 'Déplacez l’appel à l’action en fin de montage pour conclure la progression narrative UGC.',
      apply: (p) => moveScene(p, cta, p.scenes.length - 1),
      applyCustom: (p, val) => {
        const pos = Math.min(p.scenes.length - 1, Math.max(0, (Number(val) || p.scenes.length) - 1));
        return moveScene(p, cta, pos);
      },
      modifySpec: {
        label: 'Position cible (1 à N)',
        inputType: 'number',
        defaultValue: String(scenes.length),
        hint: `Dernier plan (${scenes.length}) recommandé pour la conversion.`,
        min: 1,
        max: Math.max(1, scenes.length),
        step: 1,
      },
    });
  }

  // 6. Full UGC narrative sequence check (hook -> demo -> proof -> cta)
  const roleWeight: Record<SceneRole, number> = { hook: 0, demo: 1, proof: 2, custom: 3, cta: 4 };
  const canonical = [...scenes].sort((a, b) => roleWeight[a.role] - roleWeight[b.role]);
  const isOutOfNarrativeOrder = scenes.length >= 3
    && hook <= 0 // don't duplicate hook/cta-only warnings if simple move fixes it, unless mid-sections are inverted
    && (cta < 0 || cta === scenes.length - 1)
    && canonical.some((s, i) => s.id !== scenes[i].id);
  if (isOutOfNarrativeOrder) {
    out.push({
      id: 'order',
      kind: 'order',
      origin: 'local-deterministic',
      title: 'Réordonner selon la structure narrative UGC',
      severity: 'info',
      detail: `Ordre proposé : ${canonical.map((s) => s.label).join(' → ')}. Suit l’arc Accroche → Démonstration → Preuve → CTA.`,
      apply: (p) => reorderScenesByIds(p, canonical.map((s) => s.id)),
      applyCustom: (p, val) => {
        if (val === 'hook-proof-demo-cta') {
          const altWeight: Record<SceneRole, number> = { hook: 0, proof: 1, demo: 2, custom: 3, cta: 4 };
          return reorderScenesByIds(p, [...p.scenes].sort((a, b) => altWeight[a.role] - altWeight[b.role]).map((s) => s.id));
        }
        return reorderScenesByIds(p, canonical.map((s) => s.id));
      },
      modifySpec: {
        label: 'Architecture narrative',
        inputType: 'select',
        defaultValue: 'hook-demo-proof-cta',
        hint: 'Choisissez l’enchaînement narratif à appliquer.',
        options: [
          { value: 'hook-demo-proof-cta', label: 'Accroche → Démo → Preuve → CTA' },
          { value: 'hook-proof-demo-cta', label: 'Accroche → Preuve → Démo → CTA' },
        ],
      },
    });
  }

  // 7. Split overly long shots for dynamic UGC cuts
  const longShot = scenes.find((s) => s.duration > preset.maxShotDuration && s.duration >= 2);
  if (longShot && scenes.length < 24) {
    const defaultSplit = Math.round((longShot.duration / 2) * 10) / 10;
    out.push({
      id: 'split-long',
      kind: 'cuts',
      origin: 'local-deterministic',
      targetSceneId: longShot.id,
      title: `Découper « ${longShot.label} » (${longShot.duration.toFixed(1)} s) en 2 plans`,
      severity: 'info',
      detail: `Un plan continu de ${longShot.duration.toFixed(1)} s dépasse le seuil UGC (${preset.maxShotDuration} s). Scinder ce clip en deux séquences dynamise le rythme sans perdre le média.`,
      apply: (p) => splitScene(p, longShot.id, defaultSplit),
      applyCustom: (p, val) => splitScene(p, longShot.id, Number(val) || defaultSplit),
      modifySpec: {
        label: 'Point de découpe dans le plan (s)',
        inputType: 'number',
        defaultValue: String(defaultSplit),
        hint: `Entre 0,5 s et ${(longShot.duration - 0.5).toFixed(1)} s.`,
        min: 0.5,
        max: Math.max(0.5, Math.round((longShot.duration - 0.5) * 10) / 10),
        step: 0.5,
      },
    });
  }

  // 8. Global pacing vs target duration
  if (Math.abs(total - resolvedTarget) > 3) {
    const factor = resolvedTarget / Math.max(total, 0.1);
    out.push({
      id: 'pacing',
      kind: 'pacing',
      origin: 'local-deterministic',
      title: total > resolvedTarget ? 'Resserrer le rythme global' : 'Allonger le montage',
      severity: 'info',
      detail: `Durée actuelle ${total.toFixed(1)} s, cible ${resolvedTarget} s (${preset.label}). Ajuster proportionnellement chaque plan.`,
      apply: (p) => ({
        ...p,
        targetDuration: resolvedTarget,
        scenes: p.scenes.map((s) => ({ ...s, duration: clampDuration(s.duration * factor) })),
        updatedAt: new Date().toISOString(),
      }),
      applyCustom: (p, val) => {
        const customTarget = Number(val);
        if (!Number.isFinite(customTarget) || customTarget < 2 || customTarget > 120) return p;
        const f = customTarget / Math.max(0.1, totalDuration(p));
        return {
          ...p,
          targetDuration: customTarget,
          scenes: p.scenes.map((s) => ({ ...s, duration: clampDuration(s.duration * f) })),
          updatedAt: new Date().toISOString(),
        };
      },
      modifySpec: {
        label: 'Durée cible totale (secondes)',
        inputType: 'number',
        defaultValue: String(resolvedTarget),
        hint: 'Les plans sont ajustés proportionnellement entre 5 et 90 s.',
        min: 5,
        max: 90,
        step: 1,
      },
    });
  }

  // 9. Smart UGC transitions
  if (scenes.length > 1 && scenes.slice(0, -1).every((s) => s.transition === 'cut')) {
    out.push({
      id: 'transitions',
      kind: 'transitions',
      origin: 'local-deterministic',
      title: 'Fluidifier les transitions entre séquences',
      severity: 'info',
      detail: 'Gardez une coupe franche après l’accroche pour l’impact, et ajoutez un fondu ou dissolve avant l’appel à l’action.',
      apply: (p) => {
        const idx = p.scenes.findIndex((s) => s.role === 'cta');
        const target = idx > 0 ? idx - 1 : p.scenes.length - 2;
        const id = p.scenes[target]?.id;
        return id ? patchScene(p, id, { transition: 'fade', transitionDuration: 0.4 }) : p;
      },
      applyCustom: (p, val) => {
        const kind: TransitionKind = val === 'dissolve' || val === 'slide' || val === 'fade' || val === 'cut' ? val : 'fade';
        const idx = p.scenes.findIndex((s) => s.role === 'cta');
        const target = idx > 0 ? idx - 1 : p.scenes.length - 2;
        const id = p.scenes[target]?.id;
        return id ? patchScene(p, id, { transition: kind, transitionDuration: clampTransitionDuration(0.4) }) : p;
      },
      modifySpec: {
        label: 'Type de transition avant la conclusion',
        inputType: 'select',
        defaultValue: 'fade',
        hint: 'Appliquée entre la démonstration/preuve et l’appel à l’action.',
        options: [
          { value: 'fade', label: 'Fondu (0,4 s)' },
          { value: 'dissolve', label: 'Dissolve enchaîné (0,4 s)' },
          { value: 'slide', label: 'Balayage latéral (0,4 s)' },
          { value: 'cut', label: 'Coupe franche' },
        ],
      },
    });
  }

  // 10. Subtitles generation from voiceover text
  const withSpoken = scenes.filter((s) => s.spokenText.trim().length > 5);
  if (withSpoken.length && (!project.subtitlesEnabled || withSpoken.some((s) => !s.subtitle.trim()))) {
    const firstSpokenIdx = scenes.findIndex((s) => s.spokenText.trim().length > 5);
    out.push({
      id: 'subtitles',
      kind: 'subtitles',
      origin: 'local-deterministic',
      title: 'Générer les sous-titres depuis la voix off',
      severity: 'info',
      detail: 'Les sous-titres sont construits localement à partir du texte parlé de chaque plan (aucune transcription IA simulée).',
      apply: (p) => ({
        ...p,
        subtitlesEnabled: true,
        scenes: p.scenes.map((s) => s.spokenText.trim() && !s.subtitle.trim()
          ? { ...s, subtitle: s.spokenText.trim().slice(0, 110) } : s),
        updatedAt: new Date().toISOString(),
      }),
      applyCustom: (p, val) => {
        const cleaned = val.trim();
        return {
          ...p,
          subtitlesEnabled: true,
          scenes: p.scenes.map((s, i) => {
            if (i === firstSpokenIdx && cleaned) return { ...s, subtitle: cleaned.slice(0, 110) };
            return s.spokenText.trim() && !s.subtitle.trim()
              ? { ...s, subtitle: s.spokenText.trim().slice(0, 110) } : s;
          }),
          updatedAt: new Date().toISOString(),
        };
      },
      modifySpec: {
        label: 'Texte du premier sous-titre (optionnel)',
        inputType: 'text',
        defaultValue: scenes[firstSpokenIdx]?.spokenText.trim().slice(0, 110) ?? '',
        hint: 'Laissez vide pour reprendre automatiquement la voix off du plan.',
      },
    });
  }

  // 11. Long subtitles mobile check
  const longSubtitles = scenes.filter((s) => s.subtitle.length > 90);
  if (longSubtitles.length) {
    out.push({
      id: 'cuts',
      kind: 'cuts',
      origin: 'local-deterministic',
      title: 'Raccourcir les sous-titres longs pour mobile',
      severity: 'info',
      detail: `${longSubtitles.length} sous-titre(s) dépassent 90 caractères et risquent de masquer le produit sur écran 9:16.`,
      apply: (p) => ({
        ...p,
        scenes: p.scenes.map((s) => s.subtitle.length > 90
          ? { ...s, subtitle: `${s.subtitle.slice(0, 87).trimEnd()}…` } : s),
        updatedAt: new Date().toISOString(),
      }),
      applyCustom: (p, val) => {
        const max = Math.min(300, Math.max(25, Number(val) || 90));
        return {
          ...p,
          scenes: p.scenes.map((s) => s.subtitle.length > max
            ? { ...s, subtitle: `${s.subtitle.slice(0, max - 1).trimEnd()}…` } : s),
          updatedAt: new Date().toISOString(),
        };
      },
      modifySpec: {
        label: 'Longueur maximale (caractères)',
        inputType: 'number',
        defaultValue: '90',
        hint: 'Recommandé sur TikTok / Reels : 60 à 90 caractères.',
        min: 25,
        max: 300,
        step: 5,
      },
    });
  }

  // 12. Voiceover spoken-pace (WPM) vs clip duration synchronization
  const fastSpoken = scenes.find((s) => {
    const needed = estimateSpeechDurationSeconds(s.spokenText);
    return needed > s.duration + 1.0;
  });
  if (fastSpoken) {
    const needed = clampDuration(estimateSpeechDurationSeconds(fastSpoken.spokenText));
    out.push({
      id: 'wpm-sync',
      kind: 'sync',
      origin: 'local-deterministic',
      targetSceneId: fastSpoken.id,
      title: `Synchroniser la durée de « ${fastSpoken.label} » avec la voix off`,
      severity: 'warning',
      detail: `Le texte parlé nécessite environ ${needed.toFixed(1)} s à débit naturel (150 mots/min), contre ${fastSpoken.duration.toFixed(1)} s actuellement allouées.`,
      apply: (p) => patchScene(p, fastSpoken.id, { duration: needed }),
      applyCustom: (p, val) => patchScene(p, fastSpoken.id, { duration: Number(val) || needed }),
      modifySpec: {
        label: 'Nouvelle durée du plan (s)',
        inputType: 'number',
        defaultValue: String(needed),
        hint: `Temps de parole estimé : ${needed.toFixed(1)} s.`,
        min: 0.5,
        max: 60,
        step: 0.5,
      },
    });
  }

  // 13. Visual consistency: shots too short (< 1.5s)
  const tooShort = scenes.filter((s) => s.duration < 1.5);
  if (tooShort.length) {
    out.push({
      id: 'visual-consistency',
      kind: 'visual-consistency',
      origin: 'local-deterministic',
      title: 'Plans trop courts (< 1,5 s)',
      severity: 'warning',
      detail: `${tooShort.length} plan(s) durent moins de 1,5 s : le spectateur n’a pas le temps de lire l’image ni les sous-titres.`,
      apply: (p) => ({
        ...p,
        scenes: p.scenes.map((s) => s.duration < 1.5 ? { ...s, duration: 1.5 } : s),
        updatedAt: new Date().toISOString(),
      }),
      applyCustom: (p, val) => {
        const min = Math.min(10, Math.max(0.5, Number(val) || 1.5));
        return {
          ...p,
          scenes: p.scenes.map((s) => s.duration < min ? { ...s, duration: clampDuration(min) } : s),
          updatedAt: new Date().toISOString(),
        };
      },
      modifySpec: {
        label: 'Durée minimale par plan (s)',
        inputType: 'number',
        defaultValue: '1.5',
        hint: 'Tous les plans plus courts seront allongés à cette durée.',
        min: 0.5,
        max: 10,
        step: 0.5,
      },
    });
  }

  // 14. Aspect ratio mismatch vs measured media dimensions
  const canvasRatio = aspectRatioValue(project.aspect);
  const mismatched = scenes.find((s) => {
    if (!s.source.mediaWidth || !s.source.mediaHeight) return false;
    const clipRatio = s.source.mediaWidth / s.source.mediaHeight;
    return Math.abs(clipRatio - canvasRatio) > 0.35 && (s.fitMode ?? 'cover') === 'cover';
  });
  if (mismatched) {
    out.push({
      id: 'aspect-fit',
      kind: 'visual-consistency',
      origin: 'local-deterministic',
      targetSceneId: mismatched.id,
      title: `Ratio différent sur « ${mismatched.label} » (${mismatched.source.mediaWidth}×${mismatched.source.mediaHeight})`,
      severity: 'info',
      detail: `Ce clip ne correspond pas au format ${project.aspect}. Passez son cadrage en « Entier (contain) » pour éviter de rogner les bords importants.`,
      apply: (p) => patchScene(p, mismatched.id, { fitMode: 'contain' }),
      applyCustom: (p, val) => patchScene(p, mismatched.id, { fitMode: (val === 'cover' ? 'cover' : 'contain') as FitMode }),
      modifySpec: {
        label: 'Mode de cadrage',
        inputType: 'select',
        defaultValue: 'contain',
        hint: '« contain » conserve l’image entière ; « cover » remplit le cadre.',
        options: [
          { value: 'contain', label: 'Entier sans rognage (contain)' },
          { value: 'cover', label: 'Plein cadre recadré (cover)' },
        ],
      },
    });
  }

  // 15. Visual prompt duplicates
  const prompts = scenes.map((s) => s.visualPrompt.trim().toLowerCase()).filter(Boolean);
  if (new Set(prompts).size < prompts.length) {
    const seen = new Set<string>();
    const dup = scenes.find((s) => {
      const k = s.visualPrompt.trim().toLowerCase();
      if (!k) return false;
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    });
    out.push({
      id: 'coherence',
      kind: 'coherence',
      origin: 'local-deterministic',
      targetSceneId: dup?.id,
      title: 'Incohérence : instructions visuelles répétées',
      severity: 'warning',
      detail: 'Plusieurs plans partagent exactement la même instruction visuelle. Différenciez-les pour varier les angles de caméra UGC.',
      apply: dup
        ? (p) => patchScene(p, dup.id, { visualPrompt: `${dup.visualPrompt} — angle gros plan produit` })
        : null,
      applyCustom: dup
        ? (p, val) => patchScene(p, dup.id, { visualPrompt: val.trim() || dup.visualPrompt })
        : undefined,
      ...(dup ? {
        modifySpec: {
          label: `Instruction visuelle de « ${dup.label} »`,
          inputType: 'text',
          defaultValue: `${dup.visualPrompt} — gros plan`,
          hint: 'Personnalisez l’intention visuelle pour la différencier.',
        },
      } : {}),
    });
  }

  // 16. Audio ducking when both music and voiceover tracks exist
  const voiceover = effectiveVoiceover(project);
  if (voiceover.kind !== 'none' && project.audio.kind !== 'none' && !project.audioDucking) {
    out.push({
      id: 'audio-ducking',
      kind: 'audio',
      origin: 'local-deterministic',
      title: 'Activer l’atténuation musicale sous la voix off',
      severity: 'info',
      detail: 'Une piste voix off et une musique de fond sont actives. Réduire la musique à 30 % pendant la voix off améliore la clarté.',
      apply: (p) => ({ ...p, audioDucking: true, updatedAt: new Date().toISOString() }),
    });
  }

  // 17. Missing audio / voiceover track guidance (honest non-TTS state)
  if (project.audio.kind === 'none' && voiceover.kind === 'none') {
    out.push({
      id: 'audio',
      kind: 'audio',
      origin: 'local-deterministic',
      title: 'Piste audio / voix off absente',
      severity: 'info',
      detail: 'Le rendu utilise uniquement le son des clips. Aucun moteur TTS IA n’est connecté : importez un fichier audio ou enregistrez une voix off réelle au micro.',
      apply: null,
    });
  }

  // 18. Spoken text + real media sync check
  if (withSpoken.length && scenes.some((s) => s.spokenText.trim() && s.source.kind !== 'none') && !fastSpoken) {
    out.push({
      id: 'sync',
      kind: 'sync',
      origin: 'local-deterministic',
      title: 'Synchroniser voix et images',
      severity: 'info',
      detail: 'Les sous-titres et la piste voix off sont calés sur la timeline. Ajustez le point d’entrée ou les durées si besoin.',
      apply: null,
    });
  }

  return out;
}

/** Reproducible subtitle spans, used by the compositor, preview and SRT exporter. */
export function subtitleSpans(project: EditorProject): {
  sceneId: string;
  sceneIndex: number;
  start: number;
  end: number;
  text: string;
}[] {
  let cursor = 0;
  return project.scenes.flatMap((s, sceneIndex) => {
    const sceneStart = cursor;
    const dur = Math.max(0, s.duration);
    cursor += dur;
    if (!project.subtitlesEnabled || !s.subtitle.trim()) return [];
    const offsetStart = Math.max(0, Math.min(dur, s.subtitleStart ?? 0));
    const offsetEnd = Math.max(offsetStart + 0.1, Math.min(dur, s.subtitleEnd ?? dur));
    return [{
      sceneId: s.id,
      sceneIndex,
      start: Number((sceneStart + offsetStart).toFixed(3)),
      end: Number((sceneStart + offsetEnd).toFixed(3)),
      text: s.subtitle.trim(),
    }];
  });
}
