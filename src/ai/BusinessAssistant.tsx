import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, Megaphone, Menu, PenLine, Sparkles, X } from 'lucide-react';
import { useAssistant, type AssistantState } from './useAssistant';
import { Sidebar } from './Sidebar';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import {
  composeMessageBody,
  filterConversations,
  groupByRecency,
  type AiAttachment,
  type AiConversation,
  type AiMessage,
  type AiMode,
} from './api';
import './assistant.css';

const CLE_REPLI = 'vyora.ai.sidebar.collapsed';

const IDEES = [
  {
    label: 'Analyser mes ventes',
    texte: 'Analyse mes ventes du mois : quelles tendances, quels produits progressent et quels signaux méritent mon attention ?',
    icon: BarChart3,
  },
  {
    label: 'Préparer une campagne',
    texte: 'Prépare une campagne marketing pour mon entreprise : cible, message, canaux et calendrier sur quatre semaines.',
    icon: Megaphone,
  },
  {
    label: 'Rédiger une réponse',
    texte: 'Rédige une réponse professionnelle à un client mécontent de son délai de livraison.',
    icon: PenLine,
  },
] as const;

/**
 * État fourni par la page hôte (Grow).
 *
 * Grow possède déjà les conversations, les messages, les mutations et
 * les règles d'isolation (révisions, séquences, rechargements). L'interface ne
 * les duplique pas : elle les affiche et déclenche les mêmes rappels.
 */
export interface BusinessAssistantHost {
  conversations: AiConversation[];
  conversationsLoaded: boolean;
  selectedConversationId: string | null;
  messages: AiMessage[];
  loading: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<unknown> | void;
  onDelete: (id: string) => Promise<unknown> | void;
  /**
   * Envoi. `body` est déjà composé (mode analyse + pièces jointes) : la page
   * hôte n'a pas à connaître le format de l'interface, et l'interface n'a pas
   * à connaître le contrat serveur.
   */
  onSend: (body: string) => Promise<boolean>;
}

/**
 * SORAHNEX AI — interface de conversation, hébergée dans Grow.
 *
 * ## Un seul espace métier
 *
 * Ce composant ne crée ni route propre au-dessus de Grow, ni
 * navigation d'application : il occupe la section « Assistant » de Business
 * Grow et s'appuie sur le socle `business-grow`. Les conversations sont
 * rattachées à l'entreprise active.
 *
 * Le panneau latéral est celui de SORAHNEX AI, utilisé en mode `embedded` : il ne
 * propose plus de liens vers d'autres espaces (sinon il reconstituerait la
 * navigation globale à côté de celle de Grow), seulement les
 * conversations et le raccourci vers la rubrique Intégrations.
 *
 * ## Ce qui n'est pas simulé
 *
 * - Pas de streaming : `vyora-ai` répond en une fois. L'indicateur reflète
 *   l'attente réelle.
 * - Pas de dictée vocale : permission micro fermée dans `netlify.toml`.
 * - Aucune réponse inventée : si aucun fournisseur ne répond, l'écran le dit
 *   et le message reste enregistré côté serveur.
 *
 * ## Deux modes
 *
 * - **Piloté** (`host` fourni) : Grow possède l'état. C'est le mode
 *   utilisé dans l'application.
 * - **Autonome** (`host` absent) : le composant charge lui-même via
 *   `useAssistant`. Utile pour les tests et pour un usage hors Grow.
 */
export function BusinessAssistant({
  workspaceId,
  host,
  onOpenIntegrations,
  backendReady = true,
  backendLoading = false,
  providers = null,
  draftFromReport = null,
  onDraftConsumed,
}: {
  workspaceId: string | null;
  /** État géré par Grow. Absent, le composant est autonome. */
  host?: BusinessAssistantHost;
  /** Ouvre la rubrique Intégrations de Grow. */
  onOpenIntegrations?: () => void;
  backendReady?: boolean;
  backendLoading?: boolean;
  /**
   * Statut des services IA. `null` signifie « non chargé », pas « aucun
   * fournisseur » : confondre les deux ferait croire à une absence de service
   * alors que la lecture a simplement échoué.
   */
  providers?: Array<{ provider_key: string; status: string }> | null;
  /** Texte préparé par un rapport d'agent. */
  draftFromReport?: string | null;
  onDraftConsumed?: () => void;
}) {
  const autonome = useAssistant(workspaceId);
  const [mode, setMode] = useState<AiMode>('standard');
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [tiroirMobile, setTiroirMobile] = useState(false);
  const [repliee, setRepliee] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CLE_REPLI) === '1';
    } catch {
      return false;
    }
  });

  const basculer = useCallback(() => {
    setRepliee((prev) => {
      const suivant = !prev;
      try {
        localStorage.setItem(CLE_REPLI, suivant ? '1' : '0');
      } catch {
        /* préférence d'affichage : stockage indisponible, on continue */
      }
      return suivant;
    });
  }, []);

  // Une suggestion externe (rapport d'agent) est transmise au composeur.
  useEffect(() => {
    if (draftFromReport) {
      setSuggestion(draftFromReport);
      onDraftConsumed?.();
    }
  }, [draftFromReport, onDraftConsumed]);

  // Échap ferme le tiroir mobile.
  useEffect(() => {
    if (!tiroirMobile) return;
    const surTouche = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTiroirMobile(false);
    };
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  }, [tiroirMobile]);

  const [recherche, setRecherche] = useState('');

  // Vue unifiée, quel que soit le mode.
  const vue: AssistantState = host
    ? {
        conversations: host.conversations,
        groups: groupByRecency(filterConversations(host.conversations, recherche)),
        filtered: filterConversations(host.conversations, recherche),
        activeId: host.selectedConversationId,
        messages: host.messages,
        loadingList: !host.conversationsLoaded,
        loadingThread: host.loading,
        sending: host.busy,
        error: null,
        query: recherche,
        setQuery: setRecherche,
        select: host.onSelect,
        startNew: host.onNew,
        send: async (content: string, modeChoisi: AiMode, attachments: AiAttachment[]) =>
          host.onSend(composeMessageBody(content, modeChoisi, attachments)),
        remove: async (id: string) => { await host.onDelete(id); },
        rename: async (id: string, title: string) => { await host.onRename(id, title); },
        reload: async () => undefined,
        clearError: () => undefined,
      }
    : autonome;

  const activerConversation = useCallback(
    (id: string) => {
      vue.select(id);
      setTiroirMobile(false);
    },
    [vue],
  );

  const titreActif = useMemo(
    () => vue.conversations.find((item) => item.id === vue.activeId)?.title || 'Nouvelle conversation',
    [vue.conversations, vue.activeId],
  );

  const blocage = !backendReady && !backendLoading ? 'indisponible' : backendLoading ? 'chargement' : null;

  const panneau = (modeTiroir: boolean) => (
    <Sidebar
      collapsed={modeTiroir ? false : repliee}
      onToggle={modeTiroir ? () => setTiroirMobile(false) : basculer}
      groups={vue.groups}
      activeId={vue.activeId}
      query={vue.query}
      onQuery={vue.setQuery}
      onSelect={activerConversation}
      onNew={() => {
        vue.startNew();
        setTiroirMobile(false);
      }}
      onDelete={(id) => void vue.remove(id)}
      // Le renommage existait dans l'ancienne interface : le retirer serait une
      // régression fonctionnelle, pas une simplification.
      onRename={(id, title) => void vue.rename(id, title)}
      loading={vue.loadingList}
      embedded
      fillHeight
      // L'ancienne interface nommait l'action « Nouvelle conversation ».
      onNavigateSection={(section) => {
        if (section === 'integrations') onOpenIntegrations?.();
        setTiroirMobile(false);
      }}
      newLabel="Nouvelle conversation"
      onCloseMobile={modeTiroir ? () => setTiroirMobile(false) : undefined}
    />
  );

  return (
    <div
      className="relative flex h-[min(78vh,860px)] min-h-[560px] overflow-hidden rounded-[1.4rem] border border-white/[0.09] bg-ink"
      data-testid="business-assistant"
    >
      {/*
        Un seul panneau monté à la fois. jsdom ne résout pas les media queries :
        monter le panneau desktop *et* le tiroir dupliquerait chaque nom
        accessible (« Intégrations », « Nouvelle conversation »…), ce qui est
        aussi un vrai défaut pour les technologies d'assistance.
      */}
      <div className="hidden lg:block" data-testid="business-assistant-rail">{panneau(false)}</div>

      {tiroirMobile && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          {/* L'overlay est cliquable mais n'est pas une commande : il n'a pas
              de nom accessible, pour ne pas concurrencer le bouton de fermeture
              réel de la barre latérale. */}
          <button
            type="button"
            className="flex-1 bg-black/70 backdrop-blur-sm"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setTiroirMobile(false)}
          />
          {panneau(true)}
        </div>
      )}

      <main className="vy-ambient relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-3 py-2.5 sm:px-5">
          <button
            type="button"
            onClick={() => setTiroirMobile(true)}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white lg:hidden"
            aria-label="Ouvrir les conversations"
          >
            <Menu size={18} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-slate-200">{titreActif}</p>
            <p className="text-[0.62rem] text-slate-500">
              {workspaceId ? 'Entreprise active · AI Director SORAHNEX' : 'Conversation personnelle'}
              {' · '}
              {backendLoading
                ? 'vérification des services IA…'
                : providers === null
                  ? 'statut des services IA indisponible'
                  : 'services IA vérifiés côté serveur'}
            </p>
          </div>
          <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[0.62rem] text-slate-400 sm:flex">
            <Sparkles size={11} className="text-brand-300" />
            {mode === 'analyse' ? 'Mode analyse' : 'Standard'}
          </span>
        </header>

        {blocage && (
          <div
            role="status"
            data-testid={blocage === 'chargement' ? 'business-ai-loading' : 'business-ai-unavailable'}
            className="m-3 flex items-start gap-2.5 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3.5 py-3 text-xs leading-relaxed text-amber-100"
          >
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">
                {blocage === 'chargement' ? 'Connexion à Grow…' : 'Grow ne répond pas pour le moment'}
              </p>
              <p className="mt-1 text-amber-100/70">
                {blocage === 'chargement'
                  ? 'L’historique et la mémoire se chargent dès que la session SORAHNEX est confirmée.'
                  : 'La connexion a été retentée automatiquement. Vérifiez votre connexion puis utilisez « Réessayer » : aucune donnée n’est inventée ni enregistrée localement.'}
              </p>
            </div>
          </div>
        )}

        {vue.error && (
          <div
            role="alert"
            className="mx-3 mt-2 flex items-start gap-2 rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-3 py-2 text-xs text-rose-100"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{vue.error}</span>
            <button
              type="button"
              onClick={vue.clearError}
              aria-label="Masquer l’erreur"
              className="rounded p-0.5 text-rose-200/70 transition hover:bg-white/10 hover:text-white"
            >
              <X size={13} />
            </button>
          </div>
        )}

        <div className="vy-scroll min-h-0 flex-1 overflow-y-auto">
          {vue.messages.length === 0 && !vue.loadingThread ? (
            <div className="flex h-full flex-col items-center justify-center px-4 py-10 text-center">
              <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-accent shadow-glow">
                <Sparkles size={26} className="text-ink" />
              </span>
              <h2 className="mt-5 font-display text-xl font-semibold tracking-tight text-white sm:text-2xl">
                Que fait-on pour votre entreprise&nbsp;?
              </h2>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-400">
                {workspaceId
                  ? 'Vos conversations, la mémoire consentie et le contexte de l’entreprise active sont utilisés par l’AI Director.'
                  : 'Sélectionnez une entreprise pour que l’assistant dispose du contexte métier.'}
              </p>
              <div className="mt-7 grid w-full max-w-lg gap-2 sm:grid-cols-3">
                {IDEES.map(({ label, texte, icon: Icon }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setSuggestion(texte)}
                    className="vy-suggestion flex flex-col items-start gap-1.5 p-3 text-left"
                  >
                    <Icon size={15} className="text-brand-300" />
                    <span className="text-xs font-medium text-slate-200">{label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MessageList
              messages={vue.messages}
              loading={vue.loadingThread}
              sending={vue.sending}
              testIdPrefix={host ? 'business-message' : 'message'}
            />
          )}
        </div>

        <div className="shrink-0 border-t border-white/[0.07] bg-ink/60 backdrop-blur-xl">
          <Composer
            // Les fichiers sont téléversés sous l'entreprise active et
            // rattachés à la conversation en cours. Sans entreprise, le
            // composeur refuse explicitement plutôt que de perdre le fichier.
            workspaceId={workspaceId}
            conversationId={vue.activeId}
            onSend={(content, modeChoisi, attachments) => vue.send(content, modeChoisi, attachments)}
            sending={vue.sending || blocage !== null}
            mode={mode}
            onModeChange={setMode}
            suggestion={suggestion}
            onSuggestionUsed={() => setSuggestion(null)}
            // Le vocabulaire métier de Grow, conservé de l'interface
            // précédente : on ne demande pas « votre message » au même endroit
            // qu'un assistant personnel.
            label="Votre demande"
            sendLabel="Envoyer"
            placeholder="Partagez une question, un objectif ou un défi métier…"
          />
        </div>
      </main>
    </div>
  );
}
