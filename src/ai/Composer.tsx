import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, ScanText, X, FileText, ImageIcon } from 'lucide-react';
import type { AiAttachment, AiMode } from './api';
import {
  MAX_ATTACHMENTS,
  formatBytes,
  readAttachment,
  validateAttachment,
} from './attachments';
import { cn } from '../components/ui';

/**
 * Zone de saisie de l'assistant.
 *
 * ## Ce que font réellement les boutons
 *
 * - **Trombone** : ouvre le sélecteur de fichiers, lit les formats lisibles
 *   localement et affiche ce qui a pu être extrait. Un format non lisible est
 *   annoncé (voir `attachments.ts`), jamais ignoré en silence.
 * - **Mode analyse** : ajoute une consigne de structuration au message envoyé.
 *   Ce n'est pas un moteur distinct — c'est dit dans l'infobulle.
 * - **Envoyer** : transmet au socle, qui interroge `vyora-ai`.
 *
 * ## Ce qui n'existe pas ici
 *
 * Pas de bouton vocal. La dictée demande l'API `SpeechRecognition`, absente de
 * nombreux navigateurs et bloquée par `Permissions-Policy: microphone=()` dans
 * `netlify.toml`. Plutôt qu'un bouton mort, l'absence est assumée : ce sera une
 * décision explicite, avec ouverture de la permission.
 */
export function Composer({
  onSend,
  sending,
  mode,
  onModeChange,
  suggestion,
  onSuggestionUsed,
  label = 'Votre message',
  placeholder = 'Demandez, analysez, créez… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)',
  sendLabel = 'Envoyer le message',
}: {
  onSend: (content: string, mode: AiMode, attachments: AiAttachment[]) => Promise<boolean>;
  sending: boolean;
  mode: AiMode;
  onModeChange: (mode: AiMode) => void;
  /**
   * Texte pré-rempli depuis l'extérieur (suggestions de l'accueil). Le
   * composant reste contrôlé : on ne manipule jamais son DOM de l'extérieur,
   * ce qui désynchroniserait l'état React du champ affiché.
   */
  suggestion?: string | null;
  onSuggestionUsed?: () => void;
  /** Libellé accessible du champ, selon l'espace qui héberge le composeur. */
  label?: string;
  placeholder?: string;
  /**
   * Libellé du bouton d'envoi. L'espace autonome utilise une icône seule
   * (`Envoyer le message`) ; Business Grow expose un bouton texte « Envoyer »,
   * comme dans l'interface qu'il remplace.
   */
  sendLabel?: string;
}) {
  const [texte, setTexte] = useState('');
  const [attachments, setAttachments] = useState<AiAttachment[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const zone = useRef<HTMLTextAreaElement>(null);
  const fichiers = useRef<HTMLInputElement>(null);

  // Une suggestion externe remplit le champ sans écraser un brouillon en cours
  // de frappe : si l'utilisateur a déjà écrit, c'est son texte qui compte.
  useEffect(() => {
    if (!suggestion) return;
    setTexte((courant) => (courant.trim() ? courant : suggestion));
    onSuggestionUsed?.();
    zone.current?.focus();
  }, [suggestion, onSuggestionUsed]);

  // Hauteur automatique, plafonnée par le CSS (max-height: 220px).
  useEffect(() => {
    const element = zone.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [texte]);

  const ajouter = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setErreur(null);
      const ajouts: AiAttachment[] = [];
      const refus: string[] = [];

      for (const file of Array.from(files)) {
        const probleme = validateAttachment(file, attachments.length + ajouts.length);
        if (probleme) {
          refus.push(probleme);
          continue;
        }
        const lu = await readAttachment(file);
        ajouts.push({
          name: file.name,
          storagePath: null,
          sizeBytes: file.size,
          mimeType: file.type || 'application/octet-stream',
          ...(lu.excerpt ? { excerpt: lu.excerpt } : {}),
        });
        if (lu.reason) refus.push(`${file.name} — ${lu.reason}`);
      }

      if (ajouts.length > 0) setAttachments((prev) => [...prev, ...ajouts]);
      if (refus.length > 0) setErreur(refus.join(' '));
    },
    [attachments.length],
  );

  const retirer = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const envoyer = async () => {
    if (sending) return;
    const contenu = texte;
    if (!contenu.trim() && attachments.length === 0) return;
    setTexte('');
    setAttachments([]);
    setErreur(null);
    const ok = await onSend(contenu, mode, attachments);
    // En cas d'échec, on restitue la saisie : perdre un long message serait
    // frustrant, et le motif est déjà affiché par le fil.
    if (!ok) {
      setTexte(contenu);
      setAttachments(attachments);
    }
  };

  const surEntree = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void envoyer();
    }
  };

  const peutEnvoyer = (texte.trim().length > 0 || attachments.length > 0) && !sending;

  return (
    <div className="px-3 pb-4 sm:px-5">
      {erreur && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <span className="flex-1">{erreur}</span>
          <button type="button" onClick={() => setErreur(null)} aria-label="Masquer l’avertissement">
            <X size={13} />
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a, index) => (
            <li
              key={`${a.name}-${index}`}
              className="flex items-center gap-2 rounded-lg border border-line bg-white/[0.04] px-2.5 py-1.5 text-xs text-slate-300"
            >
              {a.mimeType.startsWith('image/') ? <ImageIcon size={13} /> : <FileText size={13} />}
              <span className="max-w-[12rem] truncate">{a.name}</span>
              <span className="text-slate-500">{formatBytes(a.sizeBytes)}</span>
              {a.excerpt ? (
                <span className="rounded bg-brand-500/15 px-1 text-[0.65rem] text-brand-200">lu</span>
              ) : (
                <span className="rounded bg-white/10 px-1 text-[0.65rem] text-slate-400">non extrait</span>
              )}
              <button
                type="button"
                onClick={() => retirer(index)}
                className="rounded p-0.5 text-slate-500 hover:text-white"
                aria-label={`Retirer ${a.name}`}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="vy-composer px-3 py-2.5">
        <label className="sr-only" htmlFor="vy-prompt">{label}</label>
        <textarea
          id="vy-prompt"
          ref={zone}
          rows={1}
          value={texte}
          onChange={(event) => setTexte(event.target.value)}
          onKeyDown={surEntree}
          placeholder={placeholder}
          disabled={sending}
        />

        <div className="mt-2 flex items-center gap-1.5">
          <input
            ref={fichiers}
            type="file"
            multiple
            className="hidden"
            accept=".txt,.md,.csv,.json,.xml,.html,.css,.js,.ts,.sql,.log,image/*,application/pdf"
            onChange={(event) => {
              void ajouter(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fichiers.current?.click()}
            className="btn btn-ghost btn-sm h-9 w-9 p-0"
            aria-label="Joindre des fichiers"
            title={`Joindre un document (max ${MAX_ATTACHMENTS})`}
            disabled={sending || attachments.length >= MAX_ATTACHMENTS}
          >
            <Paperclip size={16} />
          </button>

          <button
            type="button"
            onClick={() => onModeChange(mode === 'analyse' ? 'standard' : 'analyse')}
            className={cn(
              'btn btn-sm h-9 gap-1.5 px-2.5 text-xs',
              mode === 'analyse' ? 'btn-outline border-brand-400/50 text-brand-200' : 'btn-ghost',
            )}
            aria-pressed={mode === 'analyse'}
            title="Ajoute une consigne de structuration au message (ce n’est pas un moteur distinct)"
          >
            <ScanText size={15} />
            <span className="hidden sm:inline">Analyse</span>
          </button>

          <span className="flex-1" />

          {sendLabel === 'Envoyer' ? (
            <button
              type="button"
              onClick={() => void envoyer()}
              disabled={!peutEnvoyer}
              className="btn btn-primary btn-sm h-9 gap-1.5 px-3"
            >
              <ArrowUp size={15} />
              Envoyer
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void envoyer()}
              disabled={!peutEnvoyer}
              className="btn btn-primary btn-sm h-9 w-9 p-0"
              aria-label={sendLabel}
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>

      <p className="mt-1.5 text-center text-[0.68rem] text-slate-600">
        VYORA peut se tromper. Vérifiez les informations importantes.
      </p>
    </div>
  );
}
