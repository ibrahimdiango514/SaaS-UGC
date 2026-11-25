import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AiConversation,
  type AiMessage,
  type AiMode,
  type AiAttachment,
  createConversation,
  defaultTitle,
  deleteConversation,
  filterConversations,
  groupByRecency,
  listConversations,
  listMessages,
  rememberConversation,
  renameConversation,
  sendMessage,
  titleFromMessage,
} from './api';

/**
 * État de l'assistant personnel.
 *
 * ## Ce que ce hook garantit
 *
 * - **Aucune conversation fabriquée localement.** Si `conversations.list`
 *   échoue, l'erreur est exposée et la liste reste vide. On ne crée pas une
 *   conversation fantôme pour « faire joli ».
 * - **L'historique vient du serveur.** Après un envoi, on recharge depuis le
 *   socle ; la réponse affichée est celle qui a été persistée.
 * - **Les erreurs sont visibles.** Un échec d'envoi laisse un message dans le
 *   fil, avec son motif, plutôt que de disparaître.
 */
export interface AssistantState {
  conversations: AiConversation[];
  groups: Array<{ label: string; items: AiConversation[] }>;
  filtered: AiConversation[];
  activeId: string | null;
  messages: AiMessage[];
  loadingList: boolean;
  loadingThread: boolean;
  sending: boolean;
  error: string | null;
  query: string;
  setQuery: (value: string) => void;
  select: (id: string) => void;
  startNew: () => void;
  send: (content: string, mode: AiMode, attachments: AiAttachment[]) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  reload: () => Promise<void>;
  /** Message d'erreur transitoire du dernier envoi, effaçable. */
  clearError: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Opération impossible pour le moment.';
}

/**
 * @param workspaceId Entreprise active lorsque l'interface est hébergée dans
 *   SORAHNEX Grow. `null` conserve l'assistant autonome. Les conversations
 *   sont alors rattachées à cette entreprise côté serveur.
 */
export function useAssistant(workspaceId: string | null = null): AssistantState {
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Évite qu'une réponse lente écrase un fil plus récent.
  const threadToken = useRef(0);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const items = await listConversations(workspaceId);
      setConversations(items);
      setError(null);
    } catch (e) {
      setConversations([]);
      setError(`Conversations indisponibles : ${messageOf(e)}`);
    } finally {
      setLoadingList(false);
    }
    // `workspaceId` en dépendance : changer d'entreprise doit recharger la
    // liste, pas conserver celle de l'entreprise précédente.
  }, [workspaceId]);

  const loadThread = useCallback(async (id: string) => {
    const token = ++threadToken.current;
    setLoadingThread(true);
    try {
      const items = await listMessages(id, workspaceId);
      if (token === threadToken.current) setMessages(items);
    } catch (e) {
      if (token === threadToken.current) {
        setMessages([]);
        setError(`Messages indisponibles : ${messageOf(e)}`);
      }
    } finally {
      if (token === threadToken.current) setLoadingThread(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const select = useCallback(
    (id: string) => {
      setActiveId(id);
      rememberConversation(id);
      void loadThread(id);
    },
    [loadThread],
  );

  const startNew = useCallback(() => {
    setActiveId(null);
    setMessages([]);
    setError(null);
  }, []);

  const send = useCallback(
    async (content: string, mode: AiMode, attachments: AiAttachment[]) => {
      const texte = content.trim();
      if (!texte && attachments.length === 0) return false;

      setSending(true);
      setError(null);
      try {
        let id = activeId;
        if (!id) {
          id = await createConversation(titleFromMessage(texte) || defaultTitle(), workspaceId);
          setActiveId(id);
          rememberConversation(id);
        }

        const { providerAvailable } = await sendMessage({
          conversationId: id,
          workspaceId,
          content: texte || '(fichiers joints sans texte)',
          mode,
          attachments,
        });

        if (!providerAvailable) {
          // Le socle a enregistré le message mais le fournisseur IA est
          // indisponible : on le dit, sans inventer de réponse.
          setError('Message enregistré, mais aucun fournisseur IA n’a répondu. Réessayez plus tard.');
        }

        await loadThread(id);
        await loadList();
        return providerAvailable;
      } catch (e) {
        setError(`Envoi impossible : ${messageOf(e)}`);
        return false;
      } finally {
        setSending(false);
      }
    },
    [activeId, loadList, loadThread],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteConversation(id, workspaceId);
        if (activeId === id) {
          setActiveId(null);
          setMessages([]);
        }
        await loadList();
      } catch (e) {
        setError(`Suppression impossible : ${messageOf(e)}`);
      }
    },
    [activeId, loadList, workspaceId],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      const propre = title.trim();
      if (!propre) return;
      try {
        await renameConversation(id, propre, workspaceId);
        await loadList();
      } catch (e) {
        setError(`Renommage impossible : ${messageOf(e)}`);
      }
    },
    [loadList, workspaceId],
  );

  const filtered = useMemo(() => filterConversations(conversations, query), [conversations, query]);
  const groups = useMemo(() => groupByRecency(filtered), [filtered]);

  return {
    conversations,
    groups,
    filtered,
    activeId,
    messages,
    loadingList,
    loadingThread,
    sending,
    error,
    query,
    setQuery,
    select,
    startNew,
    send,
    remove,
    rename,
    reload: loadList,
    clearError: () => setError(null),
  };
}
