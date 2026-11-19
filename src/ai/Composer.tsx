import { useCallback, useEffect, useRef, useState } from 'react';
import { useDictee } from './useDictee';
import { ArrowUp, Loader2, Mic, Paperclip, ScanText, Square, X, FileText, ImageIcon } from 'lucide-react';
import type { AiAttachment, AiMode } from './api';
import { MAX_ATTACHMENTS, formatBytes } from './attachments';
import { prepareAttachment } from '../files/intoAssistant';
import { asAppError } from '../lib/errors';
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
  workspaceId = null,
  conversationId = null,
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
  /**
   * Entreprise active. Sans elle, aucun fichier n'est téléversé : on refuse
   * plutôt que de faire croire à une pièce jointe conservée.
   */
  workspaceId?: string | null;
  /** Conversation en cours, pour rattacher les fichiers côté base. */
  conversationId?: string | null;
}) {
  const [texte, setTexte] = useState('');
  const [attachments, setAttachments] = useState<AiAttachment[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  /** Téléversements en cours, avec leur progression réelle. */
  const [envois, setEnvois] = useState<Array<{ key: string; name: string; percent: number }>>([]);

  /*
   * Dictée vocale.
   *
   * Le fragment reconnu est INSÉRÉ dans le texte existant, à la position du
   * curseur, au lieu de remplacer le message. Un utilisateur qui a déjà écrit
   * trois lignes puis dicte une précision ne doit pas les perdre.
   */
  const dictee = useDictee((fragment) => {
    /*
     * Insertion À LA POSITION DU CURSEUR, comme annoncé.
     *
     * La version précédente ajoutait toujours à la fin : un utilisateur qui
     * relisait son début de message et dictait une précision la voyait atterrir
     * à l'autre bout du texte, hors de son regard et hors de son intention.
     *
     * Si le champ n'a pas le focus (cas fréquent sur mobile : le clavier se
     * referme pendant l'écoute), on retombe proprement sur la fin du texte.
     */
    const zoneElement = zone.current;
    const debut = zoneElement && document.activeElement === zoneElement
      ? zoneElement.selectionStart
      : null;
    const fin = zoneElement && document.activeElement === zoneElement
      ? zoneElement.selectionEnd
      : null;
    setTexte((actuel) => {
      if (debut === null || fin === null) {
        return actuel.trim() ? `${actuel.trimEnd()} ${fragment}` : fragment;
      }
      const avant = actuel.slice(0, debut);
      const apres = actuel.slice(fin);
      /*
       * Une espace de séparation seulement si les DEUX côtés en manquent.
       *
       * Vérifier le seul côté gauche produisait un double espace quand le
       * fragment dicté commençait lui-même par une espace — la reconnaissance
       * vocale en produit régulièrement entre deux segments.
       */
      const prefixe = avant && !/\s$/.test(avant) && !/^\s/.test(fragment) ? ' ' : '';
      const suffixe = apres && !/^\s/.test(apres) && !/\s$/.test(fragment) ? ' ' : '';
      return `${avant}${prefixe}${fragment}${suffixe}${apres}`;
    });
    /*
     * Remettre le curseur après le texte dicté, sinon la frappe suivante
     * écraserait le fragment. On le fait au tour de rendu suivant, quand React
     * a écrit la nouvelle valeur.
     */
    if (debut !== null && fin !== null && zoneElement) {
      const position = debut + fragment.length + 1;
      requestAnimationFrame(() => {
        try {
          zoneElement.focus();
          zoneElement.setSelectionRange(position, position);
        } catch {
          /* champ démonté entre-temps : sans conséquence */
        }
      });
    }
  });
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
        const total = attachments.length + ajouts.length;
        if (total >= MAX_ATTACHMENTS) {
          refus.push(`Maximum ${MAX_ATTACHMENTS} fichiers par message.`);
          break;
        }

        // Sans entreprise active, le fichier ne peut pas être stocké de façon
        // durable : on le dit, au lieu d'ajouter une pièce jointe qui
        // disparaîtrait au rechargement.
        if (!workspaceId) {
          refus.push(`« ${file.name} » — sélectionnez une entreprise pour joindre un fichier durablement.`);
          continue;
        }

        const cle = `${file.name}-${Date.now()}-${Math.random()}`;
        setEnvois((prev) => [...prev, { key: cle, name: file.name, percent: 0 }]);
        try {
          const prepare = await prepareAttachment(workspaceId, file, {
            conversationId,
            onProgress: (percent) => {
              setEnvois((prev) => prev.map((e) => (e.key === cle ? { ...e, percent } : e)));
            },
          });
          ajouts.push(prepare.attachment);
          // La limite réelle du modèle est annoncée, pas découverte après envoi.
          if (!prepare.capability.transmitted) refus.push(`${file.name} — ${prepare.capability.note}`);
        } catch (error) {
          refus.push(asAppError(error).message);
        } finally {
          setEnvois((prev) => prev.filter((e) => e.key !== cle));
        }
      }

      if (ajouts.length > 0) setAttachments((prev) => [...prev, ...ajouts]);
      if (refus.length > 0) setErreur(refus.join(' '));
    },
    [attachments.length, workspaceId, conversationId],
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

      {envois.length > 0 && (
        <ul className="mb-2 space-y-1" aria-live="polite">
          {envois.map((envoi) => (
            <li key={envoi.key} className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 size={12} className="animate-spin" />
              <span className="max-w-[14rem] truncate">{envoi.name}</span>
              <span className="tabular-nums">{envoi.percent} %</span>
              <span className="h-1 w-24 overflow-hidden rounded bg-white/10">
                <span className="block h-full bg-cyan-400" style={{ width: `${envoi.percent}%` }} />
              </span>
            </li>
          ))}
        </ul>
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
                <span
                  className="rounded bg-brand-500/15 px-1 text-[0.65rem] text-brand-200"
                  title="Le contenu texte est transmis à l’assistant."
                >
                  lu
                </span>
              ) : (
                <span
                  className="rounded bg-white/10 px-1 text-[0.65rem] text-slate-400"
                  title={a.note ?? 'Le contenu de ce fichier n’est pas transmis au modèle.'}
                >
                  enregistré, non lu
                </span>
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
            accept=".txt,.md,.csv,.json,.xml,.html,.css,.js,.ts,.sql,.log,.pdf,.docx,.xlsx,image/png,image/jpeg,image/webp,video/mp4,video/quicktime,application/pdf"
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

          {/*
            Micro : n'apparaît QUE si le navigateur sait réellement transcrire.
            Afficher un bouton mort « pour l'interface » serait exactement le
            genre de fausse capacité qu'on veut éliminer — l'utilisateur
            appuierait, rien ne se passerait, et il conclurait que le produit
            est cassé. La raison de l'absence est exposée en infobulle.
          */}
          {dictee.disponible && (
            <button
              type="button"
              onClick={() => (dictee.ecoute ? dictee.arreter() : dictee.demarrer())}
              disabled={sending}
              className={cn(
                /* h-11 sur mobile : 44px est la cible tactile minimale recommandée ;
                   36px provoquait des appuis manqués au pouce. */
                'btn btn-sm h-11 gap-1.5 px-3 text-xs sm:h-9 sm:px-2.5',
                dictee.ecoute ? 'btn-outline border-rose-400/60 text-rose-200' : 'btn-ghost',
              )}
              aria-pressed={dictee.ecoute}
              aria-label={dictee.ecoute ? 'Arrêter la dictée' : 'Dicter le message'}
              title={dictee.ecoute ? 'Arrêter l’écoute et conserver le texte transcrit' : 'Dicter votre message à voix haute'}
              data-testid="composer-micro"
            >
              {dictee.ecoute ? <Square size={15} /> : <Mic size={15} />}
              {dictee.ecoute && <span className="hidden sm:inline">Écoute…</span>}
            </button>
          )}

          <span className="flex-1" />

          {sendLabel === 'Envoyer' ? (
            <button
              type="button"
              onClick={() => void envoyer()}
              disabled={!peutEnvoyer}
              className="btn btn-primary btn-sm h-11 gap-1.5 px-4 sm:h-9 sm:px-3"
            >
              <ArrowUp size={15} />
              Envoyer
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void envoyer()}
              disabled={!peutEnvoyer}
              className="btn btn-primary btn-sm h-11 w-11 p-0 sm:h-9 sm:w-9"
              aria-label={sendLabel}
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>

      {/*
        État de la dictée : texte en cours de reconnaissance, erreur ou refus de
        permission. Sans cette zone, un refus de micro serait totalement muet —
        le bouton reviendrait simplement à son état initial.
      */}
      {dictee.ecoute && dictee.provisoire && (
        <p className="mt-1.5 truncate rounded-lg bg-white/[0.03] px-2 py-1 text-[0.7rem] italic text-slate-400" role="status">
          {dictee.provisoire}
          {/*
            Point d'écoute STATIQUE, pas une pulsation : il signale que le
            navigateur écoute (état réel), sans simuler une activité qui
            n'existe pas. Quand la reconnaissance s'arrête, la zone disparaît.
          */}
          <span className="ml-1 text-rose-300" aria-hidden="true">●</span>
        </p>
      )}
      {dictee.erreur && (
        <div role="alert" className="mt-1.5 flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2 py-1.5 text-[0.7rem] text-amber-100">
          <span className="min-w-0 flex-1">{dictee.erreur}</span>
          <button type="button" onClick={dictee.effacerErreur} className="shrink-0 text-amber-200/80 underline">
            Masquer
          </button>
        </div>
      )}

      <p className="mt-1.5 text-center text-[0.68rem] text-slate-600">
        VYORA peut se tromper. Vérifiez les informations importantes.
      </p>
    </div>
  );
}
