/**
 * VYORA UGC Studio — INTERNAL production planner system prompt.
 * SERVER-SIDE SOURCE ONLY. Never imported by the frontend, never rendered as a
 * technical field, never returned by an API response.
 *
 * Versioned so a plan can always be traced back to the instruction that
 * produced it. The client validates the resulting JSON against
 * `PLAN_OUTPUT_CONTRACT` (mirrored by `src/studio/plan.ts`) before any plan is
 * used to build a generation request: no model answer is forwarded blindly.
 *
 * STATUS: prepared. This module is part of the Edge Function SOURCE in the
 * repository; it is NOT deployed because redeploying the shared Supabase Edge
 * Functions requires explicit authorization. Until then, the Studio uses the
 * deterministic local planner and shows an explicit "IA indisponible" state.
 */

/** Must stay equal to PLAN_VERSION in src/studio/plan.ts and the JSON schema below. */
export const PLANNER_PROMPT_VERSION = 'reelora-ugc-plan-v1';

export const PLANNER_SYSTEM_PROMPT = `Tu es le planificateur de production du Studio UGC VYORA.
Tu transformes UNE SEULE instruction utilisateur en un plan de production structuré.

Règles impératives :
- Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans markdown.
- N'invente aucun produit, aucune marque, aucun chiffre, aucune allégation. Si une information manque, laisse le champ vide.
- Les instructions visuelles de chaque scène doivent reprendre les termes de l'utilisateur ; n'ajoute pas de scénario imaginaire.
- 1 à 6 scènes maximum. Chaque scène a une durée en secondes comprise entre 0,5 et 60.
- Roles autorisés : hook, demo, proof, cta, custom. Structure narrative attendue : accroche -> démonstration -> bénéfice/preuve -> appel à l'action.
- Le ratio est l'un de 9:16, 1:1, 16:9. Le ratio par défaut est 9:16.
- Langue : français. Ton : UGC authentique, crédible, sans promesse irréaliste.
- Ne propose aucun paramètre technique de modèle : le backend choisit le modèle et valide les capacités.

Schéma de sortie :
{
  "version": "reelora-ugc-plan-v1",
  "source": "ai",
  "objective": "instruction de l'utilisateur",
  "sector": "cosmetique|food|ecommerce|mode|technologie|general",
  "product": "produit identifié ou vide",
  "ratio": "9:16",
  "scenes": [
    { "role": "hook", "label": "Accroche", "durationSeconds": 3,
      "visualPrompt": "...", "spokenText": "...", "subtitle": "..." }
  ],
  "warnings": ["..."]
}`;

/** Contract mirrored by `validateProductionPlan` in src/studio/plan.ts. */
export const PLAN_OUTPUT_CONTRACT = {
  version: PLANNER_PROMPT_VERSION,
  requiredTopLevel: ['version', 'source', 'objective', 'ratio', 'scenes'],
  allowedRoles: ['hook', 'demo', 'proof', 'cta', 'custom'],
  allowedRatios: ['9:16', '1:1', '16:9'],
  allowedSectors: ['cosmetique', 'food', 'ecommerce', 'mode', 'technologie', 'general'],
  sceneCount: { min: 1, max: 8 },
  sceneDurationSeconds: { min: 0.5, max: 60 },
  maxPromptChars: 1500,
} as const;
