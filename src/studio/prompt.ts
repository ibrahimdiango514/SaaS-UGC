/** Pure helpers for the structured scene builder (no network, no React). */

export interface StructuredPrompt {
  character: string;
  movement: string;
  setting: string;
  action: string;
  ambience: string;
}

export const EMPTY_STRUCTURE: StructuredPrompt = {
  character: '', movement: '', setting: '', action: '', ambience: '',
};

export const PROMPT_FIELDS: Array<{ key: keyof StructuredPrompt; label: string; placeholder: string }> = [
  { key: 'character', label: 'Personnage / produit', placeholder: 'Une créatrice, un sérum cosmétique…' },
  { key: 'movement', label: 'Mouvement / caméra', placeholder: 'Travelling avant lent, léger handheld…' },
  { key: 'setting', label: 'Décor', placeholder: 'Salle de bain lumineuse, comptoir en bois…' },
  { key: 'action', label: 'Action', placeholder: 'Elle dépose le flacon et sourit…' },
  { key: 'ambience', label: 'Ambiance / lumière', placeholder: 'Lumière naturelle, tons chauds, UGC authentique…' },
];

/** Only user-entered fields are assembled; nothing is invented by the UI. */
export function composeStructuredPrompt(s: StructuredPrompt): string {
  return PROMPT_FIELDS
    .map((f) => {
      const value = (s[f.key] ?? '').trim();
      return value ? `${f.label} : ${value}.` : '';
    })
    .filter(Boolean)
    .join(' ');
}
