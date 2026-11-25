import { useMemo } from 'react';

/**
 * Affichage d'un résultat de DONNÉE (`muapi_output_json_v1`).
 *
 * Le texte vient d'un fournisseur : il est traité comme une donnée, jamais
 * comme du HTML. Aucun `dangerouslySetInnerHTML`, aucun `innerHTML`, aucune
 * injection d'URL : React n'émet que des nœuds texte, donc `<script>` ou
 * `<img onerror=…>` restent affichés littéralement.
 *
 * Les bornes d'affichage évitent de figer un mobile sur une réponse énorme :
 * profondeur 6, 100 entrées par niveau, 4 000 caractères par chaîne.
 */

const MAX_DEPTH = 6;
const MAX_ITEMS = 100;
const MAX_STRING = 4000;

const text = (value: string): string => value.length > MAX_STRING
  ? `${value.slice(0, MAX_STRING)}… (${value.length} caractères)`
  : value;

function Node({ value, depth }: { value: unknown; depth: number }) {
  if (value === null) return <span className="text-slate-500">null</span>;
  if (typeof value === 'boolean' || typeof value === 'number') {
    return <span className="text-cyan-200">{String(value)}</span>;
  }
  if (typeof value === 'string') {
    return <span className="whitespace-pre-wrap break-words text-slate-200">{text(value)}</span>;
  }
  if (depth >= MAX_DEPTH) return <span className="text-slate-500">…</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-slate-500">[]</span>;
    const shown = value.slice(0, MAX_ITEMS);
    return <ol className="list-decimal space-y-1 pl-4">
      {shown.map((item, index) => <li key={index} className="break-words"><Node value={item} depth={depth + 1} /></li>)}
      {value.length > shown.length && <li className="list-none text-slate-500">… {value.length - shown.length} élément(s) supplémentaires non affichés</li>}
    </ol>;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return <span className="text-slate-500">{'{}'}</span>;
    const shown = entries.slice(0, MAX_ITEMS);
    return <dl className="space-y-1">
      {shown.map(([key, item]) => <div key={key} className="break-words">
        <dt className="inline font-medium text-slate-300">{text(key)} : </dt>
        <dd className="inline"><Node value={item} depth={depth + 1} /></dd>
      </div>)}
      {entries.length > shown.length && <p className="text-slate-500">… {entries.length - shown.length} champ(s) supplémentaires non affichés</p>}
    </dl>;
  }
  return <span className="text-slate-500">non affichable</span>;
}

/** Vrai si le texte est un objet/tableau JSON : un simple nombre reste du texte. */
export function isJsonDocument(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object';
  } catch { return false; }
}

export function JsonResult({ value }: { value: string }) {
  const parsed = useMemo(() => {
    try { return { ok: true as const, data: JSON.parse(value) as unknown }; }
    catch { return { ok: false as const, data: null }; }
  }, [value]);
  if (!parsed.ok) return <pre className="whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 text-xs text-slate-200">{text(value)}</pre>;
  return <div className="space-y-1">
    <p className="text-xs text-slate-400">Résultat de données (JSON déclaré par le fournisseur)</p>
    <div className="max-h-96 overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 text-xs leading-relaxed">
      <Node value={parsed.data} depth={0} />
    </div>
  </div>;
}
