import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Sparkles, User, Volume2, Square } from 'lucide-react';
import type { AiMessage } from './api';
import { renderMarkdown, toPlainText } from './render';
import { cn } from '../components/ui';

/**
 * Fil de conversation.
 *
 * Le rendu Markdown est échappé en amont (voir `render.ts`) : on peut donc
 * utiliser `dangerouslySetInnerHTML` sans exposer à une injection issue de la
 * réponse du modèle.
 */
export function MessageList({
  messages,
  loading,
  sending,
}: {
  messages: AiMessage[];
  loading: boolean;
  sending: boolean;
}) {
  const fin = useRef<HTMLDivElement>(null);

  // Défilement vers le bas à chaque nouveau message, sans voler le scroll
  // si l'utilisateur a remonté volontairement.
  useEffect(() => {
    // `scrollIntoView` n'existe pas dans tous les environnements (jsdom en
    // tests, certains WebView anciens) : son absence ne doit pas casser le fil.
    fin.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages.length, sending]);

  if (loading) {
    return (
      <div className="space-y-4 px-4 py-6" aria-busy="true" aria-label="Chargement des messages">
        {[0, 1].map((i) => (
          <div key={i} className={cn('vy-panel h-20 animate-pulse', i === 1 && 'ml-auto w-2/3')} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-5 px-3 py-6 sm:px-5">
      {messages.map((message) => (
        <Bubble key={message.id} message={message} />
      ))}

      {sending && (
        <div className="vy-enter flex gap-3">
          <Avatar role="assistant" />
          <div className="vy-bubble-assistant flex items-center gap-2 px-4 py-3">
            <span className="vy-typing flex gap-1" aria-hidden="true">
              <span /><span /><span />
            </span>
            <span className="sr-only" role="status">L’assistant rédige une réponse</span>
          </div>
        </div>
      )}

      <div ref={fin} />
    </div>
  );
}

function Avatar({ role }: { role: string }) {
  const assistant = role === 'assistant';
  return (
    <div
      className={cn(
        'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border',
        assistant
          ? 'border-brand-400/30 bg-brand-500/15 text-brand-200'
          : 'border-line bg-white/[0.06] text-slate-300',
      )}
      aria-hidden="true"
    >
      {assistant ? <Sparkles size={15} /> : <User size={15} />}
    </div>
  );
}

function Bubble({ message }: { message: AiMessage }) {
  const assistant = message.author_role === 'assistant';
  const enEchec = message.request_status === 'failed';
  const [copie, setCopie] = useState(false);
  const [lecture, setLecture] = useState(false);

  const [html] = useState(() => (assistant ? renderMarkdown(message.content) : ''));

  const copier = async () => {
    try {
      await navigator.clipboard.writeText(toPlainText(message.content));
      setCopie(true);
      setTimeout(() => setCopie(false), 1600);
    } catch {
      /* presse-papiers refusé : rien à signaler d'utile à l'utilisateur */
    }
  };

  /**
   * Synthèse vocale.
   *
   * C'est la voix du navigateur (`speechSynthesis`), pas un service VYORA.
   * Disponible hors ligne, sans clé. Si l'API manque, le bouton n'est pas rendu.
   */
  const parler = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (lecture) {
      window.speechSynthesis.cancel();
      setLecture(false);
      return;
    }
    const texte = toPlainText(message.content).slice(0, 4000);
    if (!texte) return;
    const utterance = new SpeechSynthesisUtterance(texte);
    utterance.lang = 'fr-FR';
    utterance.onend = () => setLecture(false);
    utterance.onerror = () => setLecture(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setLecture(true);
  };

  const voixDisponible = typeof window !== 'undefined' && 'speechSynthesis' in window;

  return (
    <div className={cn('vy-enter group flex gap-3', !assistant && 'flex-row-reverse')}>
      <Avatar role={message.author_role} />

      <div className={cn('min-w-0 max-w-[min(46rem,88%)]', !assistant && 'flex flex-col items-end')}>
        {assistant ? (
          <div className="vy-bubble-assistant">
            <div className="vy-prose" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        ) : (
          <div className="vy-bubble-user whitespace-pre-wrap break-words text-[0.925rem] leading-relaxed text-slate-100">
            {message.content}
          </div>
        )}

        <div
          className={cn(
            'mt-1.5 flex items-center gap-1 px-1 text-[0.7rem] text-slate-500',
            !assistant && 'justify-end',
          )}
        >
          {enEchec && (
            <span className="mr-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-300">
              réponse incomplète
            </span>
          )}
          {assistant && message.request_provider_key && (
            <span className="mr-1">{message.request_provider_key}</span>
          )}
          <span>{heure(message.created_at)}</span>

          {assistant && (
            <>
              <button
                type="button"
                onClick={() => void copier()}
                className="ml-1 rounded p-1 text-slate-500 opacity-0 transition hover:bg-white/10 hover:text-white focus:opacity-100 group-hover:opacity-100"
                aria-label={copie ? 'Copié' : 'Copier la réponse'}
                title={copie ? 'Copié' : 'Copier'}
              >
                {copie ? <Check size={13} /> : <Copy size={13} />}
              </button>
              {voixDisponible && (
                <button
                  type="button"
                  onClick={parler}
                  className="rounded p-1 text-slate-500 opacity-0 transition hover:bg-white/10 hover:text-white focus:opacity-100 group-hover:opacity-100"
                  aria-label={lecture ? 'Arrêter la lecture' : 'Écouter la réponse'}
                  title={lecture ? 'Arrêter' : 'Écouter (voix du navigateur)'}
                >
                  {lecture ? <Square size={12} /> : <Volume2 size={13} />}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function heure(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
