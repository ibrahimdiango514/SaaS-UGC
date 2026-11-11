import { useRef, useState } from 'react';
import { ChevronDown, Eraser, Lightbulb, Sparkles, WandSparkles } from 'lucide-react';
import { Button, Textarea, Input, cn } from '../../components/ui';
import { generateScript, improvePrompt } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import { PROMPT_FIELDS, composeStructuredPrompt, type StructuredPrompt } from '../prompt';

export { EMPTY_STRUCTURE, type StructuredPrompt } from '../prompt';

export function PromptComposer({ prompt, onPrompt, structure, onStructure, scriptText, onScript, productName, onProductName, groqConfigured }: {
  prompt: string;
  onPrompt: (value: string) => void;
  structure: StructuredPrompt;
  onStructure: (value: StructuredPrompt) => void;
  scriptText: string;
  onScript: (value: string) => void;
  productName: string;
  onProductName: (value: string) => void;
  groqConfigured: boolean | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'prompt' | 'script' | null>(null);
  const [open, setOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const onCompose = () => {
    const composed = composeStructuredPrompt(structure);
    if (!composed) { toast.warning('Renseignez au moins un élément de la scène.'); return; }
    onPrompt(prompt.trim() ? `${prompt.trim()}\n\n${composed}` : composed);
    promptRef.current?.focus();
    toast.success('Éléments ajoutés au prompt. Relisez et ajustez librement.');
  };

  const onImprove = async () => {
    if (prompt.trim().length < 15) { toast.warning('Décrivez d’abord votre scène en quelques mots.'); return; }
    setBusy('prompt');
    try {
      const result = await improvePrompt(prompt);
      if (result?.content) { onPrompt(result.content); toast.success('Prompt reformulé avec l’IA.'); }
      else toast.warning('L’IA n’a pas renvoyé de reformulation.');
    } catch { toast.error('Impossible de reformuler le prompt. Réessayez.'); }
    finally { setBusy(null); }
  };

  const onGenerateScript = async () => {
    if (!productName.trim()) { toast.warning('Indiquez le produit pour générer un script.'); return; }
    setBusy('script');
    try {
      const result = await generateScript({
        product: productName.trim(), language: 'fr', duration: 15,
        tone: 'authentique UGC', brief: prompt.slice(0, 800),
      });
      if (result?.script_text) { onScript(result.script_text); toast.success('Script voix off généré avec l’IA.'); }
      else toast.warning('L’IA n’a pas renvoyé de script.');
    } catch { toast.error('Impossible de générer le script. Réessayez.'); }
    finally { setBusy(null); }
  };

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-panel/60 p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-500/15 text-brand-200"><Sparkles size={15} /></span>
          <div>
            <h3 className="text-sm font-semibold text-white">Description de la scène</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">Écrivez, collez et modifiez librement. Ce texte guide la création vidéo.</p>
          </div>
        </div>
        <span className="text-[11px] text-slate-500">{prompt.length} / 4000</span>
      </div>

      <Textarea id="studio-prompt" ref={promptRef} value={prompt} onChange={(e) => onPrompt(e.target.value.slice(0, 4000))} maxLength={4000}
        placeholder="Ex. Une créatrice présente un sérum dans une salle de bain lumineuse. Plan smartphone légèrement handheld, travelling avant lent, geste naturel, lumière dorée, style UGC authentique…"
        className="min-h-[150px] border-white/10 bg-[#0a0d17] text-sm leading-relaxed sm:min-h-[175px]" />

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" icon={<WandSparkles size={13} />} loading={busy === 'prompt'}
          disabled={!groqConfigured || busy !== null} onClick={() => void onImprove()}>
          Améliorer le prompt avec l’IA
        </Button>
        <Button variant="ghost" size="sm" icon={<ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} />} onClick={() => setOpen((v) => !v)}>
          Construire la scène
        </Button>
        <Button variant="ghost" size="sm" icon={<Eraser size={13} />} onClick={() => onPrompt('')} disabled={!prompt}>Effacer</Button>
      </div>

      {groqConfigured === false && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-200"><Lightbulb size={12} /> L’aide IA est indisponible pour le moment.</p>
      )}

      {open && (
        <div className="animate-fadeUp mt-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5">
          <div className="grid gap-2.5 sm:grid-cols-2">
            {PROMPT_FIELDS.map((f) => (
              <Input key={f.key} label={f.label} value={structure[f.key]} placeholder={f.placeholder}
                onChange={(e) => onStructure({ ...structure, [f.key]: e.target.value })} />
            ))}
          </div>
          <Button variant="secondary" size="sm" className="mt-3" icon={<Sparkles size={13} />} onClick={onCompose}>Ajouter la structure au prompt</Button>
          <p className="mt-2 text-[10px] text-slate-600">Aucun contenu n’est inventé : seuls vos éléments sont assemblés dans le champ de description.</p>
        </div>
      )}

      <details className="group mt-4 rounded-xl border border-white/[0.07] bg-white/[0.01]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-3 text-xs font-medium text-slate-300 hover:text-white">
          <span>Script voix off · IA</span>
          <span className="text-[10px] font-normal text-slate-500">{scriptText ? 'Script présent' : 'Optionnel'}</span>
        </summary>
        <div className="border-t border-white/[0.06] p-3.5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Input label="Produit / marque" value={productName} onChange={(e) => onProductName(e.target.value)} placeholder="Ex. Sérum Éclat" className="flex-1" />
            <Button variant="outline" size="sm" loading={busy === 'script'} disabled={!groqConfigured || busy !== null} onClick={() => void onGenerateScript()}>Générer un script</Button>
          </div>
          <Textarea label="Script (contexte UGC, non écrit à l’écran)" value={scriptText} onChange={(e) => onScript(e.target.value.slice(0, 4000))}
            placeholder="Collez ou générez un script. Il enrichit le contexte du prompt sans ajouter de texte à l’image."
            className="mt-3 min-h-[100px] border-white/10 bg-[#0a0d17] text-xs" />
        </div>
      </details>
    </div>
  );
}
