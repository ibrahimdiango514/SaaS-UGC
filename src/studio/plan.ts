/**
 * Single-prompt production planner (Reelora UGC Studio).
 *
 * `buildLocalPlan` is a DETERMINISTIC local planner: it assembles the user's own
 * instruction into a structured plan (objective, sector, narrative scenes,
 * visual instructions). It is explicitly NOT an AI response and is labelled as
 * such in the UI. The optional AI path (`mapAiScriptToPlan`) uses the EXISTING
 * `reelora-ai` Edge function and is only reachable when Groq is configured;
 * otherwise the UI shows an explicit unavailability state and never simulates.
 *
 * Every plan — local or AI — passes `validateProductionPlan` before anything is
 * sent to a provider. No model answer is forwarded blindly.
 */

import type { MuApiModel } from '../lib/types';
import type { GenerationMode } from './model';
import {
  clampDuration, emptyAudio, sceneId, type EditorProject, type SceneRole,
} from './editor/types';

export const PLAN_VERSION = 'reelora-ugc-plan-v1';

export type SectorId = 'cosmetique' | 'food' | 'ecommerce' | 'mode' | 'technologie' | 'general';

export interface SectorDefinition {
  id: SectorId;
  label: string;
  image: string;
  hint: string;
  example: string;
}

/** Real project-integrated stills, clearly labelled as inspiration in the UI. */
export const SECTORS: SectorDefinition[] = [
  {
    id: 'cosmetique', label: 'Cosmétique', image: '/studio-examples/cosmetique.jpg',
    hint: 'Soin, maquillage, parfum',
    example: 'Crée une publicité UGC de 20 secondes pour un sérum cosmétique : accroche sur la peau terne, démonstration du flacon et appel à l’achat.',
  },
  {
    id: 'food', label: 'Food', image: '/studio-examples/food.jpg',
    hint: 'Restauration, snacking, boissons',
    example: 'Crée une vidéo UGC de 15 secondes pour un burger artisanal : plan appétissant, main qui saisit une frite et appel à commander.',
  },
  {
    id: 'ecommerce', label: 'E-commerce', image: '/studio-examples/ecommerce.jpg',
    hint: 'Unboxing, objets, marketplace',
    example: 'Crée une publicité UGC de 15 secondes pour un accessoire tech : unboxing, détail produit et invitation à découvrir la boutique.',
  },
  {
    id: 'mode', label: 'Mode', image: '/studio-examples/mode.jpg',
    hint: 'Vêtements, accessoires, lifestyle',
    example: 'Crée une vidéo UGC de 20 secondes pour une veste minimaliste : silhouette en mouvement, détail de la matière et appel à l’achat.',
  },
  {
    id: 'technologie', label: 'Technologie', image: '/studio-examples/tech.jpg',
    hint: 'Apps, devices, SaaS',
    example: 'Crée une publicité UGC de 15 secondes pour une application : accroche sur le problème, démonstration à l’écran et appel à l’essai.',
  },
];

const SECTOR_KEYWORDS: Record<Exclude<SectorId, 'general'>, string[]> = {
  cosmetique: ['cosmétique', 'cosmetique', 'sérum', 'serum', 'peau', 'soin', 'maquillage', 'parfum', 'beauté', 'beaute', 'skincare', 'crème', 'creme'],
  food: ['food', 'burger', 'restaurant', 'plat', 'boisson', 'café', 'cafe', 'snack', 'pizza', 'recette', 'gâteau', 'gateau', 'nourriture'],
  ecommerce: ['e-commerce', 'ecommerce', 'unboxing', 'boutique', 'marketplace', 'colis', 'packaging', 'produit', 'shop'],
  mode: ['mode', 'veste', 'vêtement', 'vetement', 'look', 'fashion', 'sneakers', 'tenue', 'textile', 'style'],
  technologie: ['tech', 'application', 'app ', 'logiciel', 'saas', 'smartphone', 'laptop', 'device', 'gadget', 'digital'],
};

export function detectSector(text: string): SectorId {
  const t = text.toLowerCase();
  let best: { id: SectorId; score: number } = { id: 'general', score: 0 };
  for (const [id, words] of Object.entries(SECTOR_KEYWORDS)) {
    const score = words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
    if (score > best.score) best = { id: id as SectorId, score };
  }
  return best.id;
}

/** Reads an explicit duration from the user's instruction; clamped 5–60 s. */
export function extractDuration(text: string): number {
  const m = text.match(/(\d{1,2})\s*(?:secondes?|sec\b|s\b)/i);
  const n = m ? Number(m[1]) : 15;
  return Math.min(60, Math.max(5, Number.isFinite(n) ? n : 15));
}

export function extractProduct(text: string): string {
  const m = text.match(/pour\s+(?:un|une|le|la|les|mon|ma|mes|notre)\s+([\p{L}\p{N}\s'-]{2,60})/iu);
  return m ? m[1].trim().replace(/[,.;:].*$/, '') : '';
}

export type PlanRole = SceneRole;
export interface PlanScene {
  role: SceneRole;
  label: string;
  durationSeconds: number;
  visualPrompt: string;
  spokenText: string;
  subtitle: string;
}

export interface ProductionPlan {
  version: string;
  source: 'deterministic' | 'ai';
  objective: string;
  sector: SectorId;
  product: string;
  totalDuration: number;
  ratio: '9:16' | '1:1' | '16:9';
  scenes: PlanScene[];
  warnings: string[];
}

const ROLE_LABELS: Record<SceneRole, string> = {
  hook: 'Accroche', demo: 'Démonstration', proof: 'Bénéfice / preuve', cta: 'Appel à l’action', custom: 'Plan',
};

/**
 * Deterministic narrative structure. Visual instructions are assembled from the
 * USER'S OWN words plus a structural prefix — no invented scenario, no fake AI.
 */
export function buildLocalPlan(input: {
  prompt: string;
  script?: string;
  ratio?: '9:16' | '1:1' | '16:9';
  subtitles?: boolean;
}): ProductionPlan {
  const prompt = input.prompt.trim().slice(0, 4000);
  const script = (input.script ?? '').trim().slice(0, 4000);
  const total = extractDuration(prompt);
  const sector = detectSector(prompt);
  const product = extractProduct(prompt);
  const count = total <= 8 ? 2 : total <= 15 ? 3 : 4;
  const roles: SceneRole[] = count === 2 ? ['hook', 'cta']
    : count === 3 ? ['hook', 'demo', 'cta'] : ['hook', 'demo', 'proof', 'cta'];
  const weights = count === 2 ? [0.55, 0.45]
    : count === 3 ? [0.25, 0.5, 0.25] : [0.2, 0.35, 0.25, 0.2];
  const scenes: PlanScene[] = roles.map((role, i) => {
    const durationSeconds = clampDuration(total * weights[i]);
    const prefix = `Plan ${i + 1} · ${ROLE_LABELS[role].toLowerCase()}`;
    const base = `${prefix} : ${prompt || 'Vidéo UGC verticale authentique'}`;
    const spoken = script ? script.slice(0, 400) : '';
    return {
      role,
      label: ROLE_LABELS[role],
      durationSeconds,
      visualPrompt: base.slice(0, 1500),
      spokenText: spoken,
      subtitle: input.subtitles === false ? '' : (spoken || prompt).slice(0, 110),
    };
  });
  const warnings: string[] = [];
  if (prompt.length < 20) warnings.push('Instruction courte : ajoutez le produit, l’objectif et le ton pour un plan plus précis.');
  if (!product) warnings.push('Produit non identifié explicitement : précisez-le dans votre instruction.');
  if (!script) warnings.push('Aucun script fourni : la piste voix off reste vide (Groq non configuré).');
  return {
    version: PLAN_VERSION, source: 'deterministic', objective: prompt,
    sector, product, totalDuration: total, ratio: input.ratio ?? '9:16', scenes, warnings,
  };
}

/* --------------------------- Strict output validation -------------------- */

const ROLES: SceneRole[] = ['hook', 'demo', 'proof', 'cta', 'custom'];
const RATIOS = ['9:16', '1:1', '16:9'];
const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';

export function validateProductionPlan(raw: unknown): { ok: true; plan: ProductionPlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['Plan absent ou invalide.'] };
  const r = raw as Record<string, unknown>;
  if (str(r.version) !== PLAN_VERSION) errors.push('Version du plan incompatible.');
  if (r.source !== 'deterministic' && r.source !== 'ai') errors.push('Origine du plan inconnue.');
  const objective = str(r.objective).slice(0, 4000);
  if (!objective) errors.push('Objectif vide.');
  if (!RATIOS.includes(String(r.ratio))) errors.push('Ratio non pris en charge.');
  if (!Array.isArray(r.scenes) || r.scenes.length < 1 || r.scenes.length > 8) {
    errors.push('Le plan doit contenir 1 à 8 scènes.');
    return { ok: false, errors };
  }
  const scenes: PlanScene[] = [];
  for (const [i, item] of r.scenes.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`Scène ${i + 1} invalide.`); continue; }
    const s = item as Record<string, unknown>;
    const role = ROLES.includes(s.role as SceneRole) ? s.role as SceneRole : 'custom';
    const visual = str(s.visualPrompt).slice(0, 1500);
    const duration = Number(s.durationSeconds);
    if (!visual) errors.push(`Scène ${i + 1} : instruction visuelle vide.`);
    if (!Number.isFinite(duration) || duration < 0.5 || duration > 60) errors.push(`Scène ${i + 1} : durée invalide.`);
    scenes.push({
      role, label: str(s.label).slice(0, 120) || ROLE_LABELS[role],
      durationSeconds: clampDuration(duration || 3), visualPrompt: visual,
      spokenText: str(s.spokenText).slice(0, 2000), subtitle: str(s.subtitle).slice(0, 500),
    });
  }
  const sector = str(r.sector) as SectorId;
  const plan: ProductionPlan = {
    version: PLAN_VERSION, source: r.source as ProductionPlan['source'], objective,
    sector: SECTORS.some((s) => s.id === sector) || sector === 'general' ? sector : 'general',
    product: str(r.product).slice(0, 200),
    totalDuration: scenes.reduce((n, s) => n + s.durationSeconds, 0),
    ratio: r.ratio as ProductionPlan['ratio'], scenes,
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string').slice(0, 10) : [],
  };
  return errors.length ? { ok: false, errors } : { ok: true, plan };
}

/** Map the EXISTING `reelora-ai generate_script` answer, then validate it. */
export function mapAiScriptToPlan(raw: unknown, fallback: ProductionPlan): ReturnType<typeof validateProductionPlan> {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['Réponse IA vide.'] };
  const r = raw as Record<string, unknown>;
  const aiScenes = Array.isArray(r.scenes) ? r.scenes : [];
  const scenes = aiScenes.slice(0, 6).map((item) => {
    const s = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const role = ROLES.includes(s.scene_type as SceneRole) ? s.scene_type as SceneRole
      : String(s.scene_type ?? '') === 'ugc' ? 'demo' as SceneRole
        : String(s.scene_type ?? '') === 'product_demo' ? 'demo' as SceneRole
          : String(s.scene_type ?? '') === 'testimonial_style' ? 'proof' as SceneRole : 'custom' as SceneRole;
    const visual = str(s.visual_prompt ?? s.visualPrompt).slice(0, 1500);
    const spoken = str(s.spoken_text ?? s.spokenText).slice(0, 2000);
    return {
      role, label: ROLE_LABELS[role], durationSeconds: clampDuration(Number(s.duration_seconds ?? s.durationSeconds) || 3),
      visualPrompt: visual, spokenText: spoken,
      subtitle: (str(s.subtitle_text ?? s.subtitleText) || spoken).slice(0, 500),
    };
  });
  if (scenes.length === 0) return { ok: false, errors: ['L’IA n’a proposé aucune scène exploitable.'] };
  return validateProductionPlan({
    version: PLAN_VERSION, source: 'ai',
    objective: str(r.script_text ?? r.script ?? fallback.objective).slice(0, 4000) || fallback.objective,
    sector: fallback.sector, product: fallback.product, ratio: fallback.ratio,
    scenes, warnings: ['Plan proposé par Groq : relisez et ajustez chaque plan avant génération.'],
  });
}

/* ------------------------------ Plan → editor ---------------------------- */

export function planToEditorProject(plan: ProductionPlan, meta: {
  quality: string; mode: string; model: MuApiModel | null; subtitles: boolean; projectId?: string | null; demo?: boolean;
}): EditorProject {
  return {
    version: 1,
    projectId: meta.projectId ?? null,
    title: (plan.product || plan.objective).slice(0, 90) || 'Montage Reelora',
    prompt: plan.objective,
    sector: plan.sector,
    quality: meta.quality,
    mode: meta.mode,
    modelId: meta.model?.model_id ?? '',
    aspect: plan.ratio,
    subtitlesEnabled: meta.subtitles,
    planSource: plan.source,
    scenes: plan.scenes.map((s) => ({
      id: sceneId(), role: s.role, label: s.label,
      duration: clampDuration(s.durationSeconds), trimStart: 0,
      source: { kind: 'none' as const, name: '' },
      visualPrompt: s.visualPrompt, spokenText: s.spokenText,
      subtitle: meta.subtitles ? s.subtitle : '', transition: 'cut' as const,
    })),
    audio: emptyAudio(),
    updatedAt: new Date().toISOString(),
    ...(meta.demo ? { demo: true } : {}),
  };
}

/**
 * Rebuild scenes from a modified general brief WITHOUT losing imported media.
 * Structured plan validation is required before calling this function.
 */
export function replanEditorScenes(project: EditorProject, plan: ProductionPlan): EditorProject {
  const fresh = planToEditorProject(plan, {
    quality: project.quality, mode: project.mode, model: null,
    subtitles: project.subtitlesEnabled, projectId: project.projectId, demo: project.demo,
  });
  return {
    ...project,
    title: fresh.title,
    prompt: plan.objective,
    aspect: plan.ratio,
    scenes: fresh.scenes.map((scene, i) => ({
      ...scene,
      // Real media stays attached to the corresponding position; new scenes
      // explicitly have no source rather than inheriting a fake clip.
      source: project.scenes[i]?.source ?? { kind: 'none' as const, name: '' },
      transition: project.scenes[i]?.transition ?? scene.transition,
    })),
    updatedAt: new Date().toISOString(),
  };
}

/** Modes that map to a real MuAPI capability from the verified catalog. */
export const CREATION_MODES: { id: 'idea' | 'script' | 'product' | 'avatar'; label: string; description: string; mode: GenerationMode }[] = [
  { id: 'idea', label: 'Une idée / un prompt', description: 'Décrivez simplement la vidéo souhaitée.', mode: 'text-to-video' },
  { id: 'script', label: 'Depuis un script', description: 'Collez un script : il enrichit le contexte sans texte à l’écran.', mode: 'text-to-video' },
  { id: 'product', label: 'Image de produit', description: 'Animez une image de référence importée.', mode: 'image-to-video' },
  { id: 'avatar', label: 'Depuis un avatar', description: 'Utilisez l’image d’un avatar existant.', mode: 'image-to-video' },
];
