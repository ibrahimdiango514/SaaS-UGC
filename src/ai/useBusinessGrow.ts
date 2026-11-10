import { useCallback, useEffect, useState } from 'react';
import type {
  AIExecuteResponse,
  AIHealthResponse,
  AIProviderKey,
  AIRoutingPreference,
  AITaskType,
  BGQuotaStatus,
  BusinessConversation,
  BusinessMemoryCategory,
  BusinessMemoryItem,
  BusinessMessage,
  BusinessProfile,
  BusinessToolExecution,
  ExternalConnectorState,
} from './contracts';
import { reeloraAI } from './client';
import { asAppError } from '../lib/errors';

export interface UseBusinessGrowState {
  loading: boolean;
  sending: boolean;
  error: string | null;
  health: AIHealthResponse | null;
  bgQuota: BGQuotaStatus | null;
  profiles: BusinessProfile[];
  activeProfile: BusinessProfile | null;
  memories: BusinessMemoryItem[];
  conversations: BusinessConversation[];
  activeConversation: BusinessConversation | null;
  messages: BusinessMessage[];
  pendingTools: BusinessToolExecution[];
  connectors: ExternalConnectorState[];
  lastResponse: AIExecuteResponse | null;
}

export function useBusinessGrow(params: {
  workspaceId: string | null | undefined;
  userId: string | null | undefined;
}) {
  const { workspaceId, userId } = params;

  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<AIHealthResponse | null>(null);
  const [bgQuota, setBgQuota] = useState<BGQuotaStatus | null>(null);
  const [profiles, setProfiles] = useState<BusinessProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [memories, setMemories] = useState<BusinessMemoryItem[]>([]);
  const [conversations, setConversations] = useState<BusinessConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BusinessMessage[]>([]);
  const [pendingTools, setPendingTools] = useState<BusinessToolExecution[]>([]);
  const [connectors, setConnectors] = useState<ExternalConnectorState[]>([]);
  const [lastResponse, setLastResponse] = useState<AIExecuteResponse | null>(null);

  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? null;
  const activeConversation = conversations.find((c) => c.id === activeConversationId) ?? conversations[0] ?? null;

  const refreshAll = useCallback(async () => {
    if (!workspaceId || !userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [h, q, profs, convs] = await Promise.all([
        reeloraAI.getHealth().catch(() => null),
        reeloraAI.getBGQuota(workspaceId).catch(() => null),
        reeloraAI.listBusinessProfiles(),
        reeloraAI.listBusinessConversations(),
      ]);
      if (h) setHealth(h);
      if (q) setBgQuota(q);
      setProfiles(profs);
      const selectedProf = profs.find((p) => p.id === activeProfileId) ?? profs[0] ?? null;
      setActiveProfileId(selectedProf?.id ?? null);

      setConversations(convs);
      const selectedConv = convs.find((c) => c.id === activeConversationId) ?? convs[0] ?? null;
      setActiveConversationId(selectedConv?.id ?? null);

      if (selectedProf) {
        const [mems, conns] = await Promise.all([
          reeloraAI.listBusinessMemories(selectedProf.id),
          reeloraAI.listExternalConnectors(selectedProf.id),
        ]);
        setMemories(mems);
        setConnectors(conns);
      } else {
        setMemories([]);
        setConnectors([]);
      }

      if (selectedConv) {
        const [msgs, tools] = await Promise.all([
          reeloraAI.listBusinessMessages(selectedConv.id),
          reeloraAI.listToolExecutions(selectedConv.id),
        ]);
        setMessages(msgs);
        setPendingTools(tools.filter((t) => t.status === 'pending_approval'));
      } else {
        setMessages([]);
        setPendingTools([]);
      }
    } catch (err) {
      setError(asAppError(err).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, userId, activeProfileId, activeConversationId]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const sendMessage = useCallback(async (input: {
    prompt: string;
    taskType?: AITaskType;
    routing?: AIRoutingPreference;
  }): Promise<AIExecuteResponse | null> => {
    if (!workspaceId || !userId || !input.prompt.trim() || sending) return null;
    setSending(true);
    setError(null);
    try {
      let convId = activeConversation?.id ?? null;
      if (!convId) {
        const created = await reeloraAI.createBusinessConversation({
          workspaceId,
          userId,
          businessProfileId: activeProfile?.id ?? null,
          title: input.prompt.trim().slice(0, 60),
          activeTaskType: input.taskType ?? 'chat',
        });
        convId = created.id;
        setConversations((prev) => [created, ...prev]);
        setActiveConversationId(created.id);
      }

      const res = await reeloraAI.sendBusinessMessage({
        workspaceId,
        businessProfileId: activeProfile?.id,
        conversationId: convId,
        taskType: input.taskType ?? 'chat',
        prompt: input.prompt.trim(),
        routing: input.routing,
      });
      setLastResponse(res);

      const [msgs, tools, q] = await Promise.all([
        reeloraAI.listBusinessMessages(convId),
        reeloraAI.listToolExecutions(convId),
        reeloraAI.getBGQuota(workspaceId).catch(() => null),
      ]);
      setMessages(msgs);
      setPendingTools(tools.filter((t) => t.status === 'pending_approval'));
      if (q) setBgQuota(q);
      return res;
    } catch (err) {
      setError(asAppError(err).message);
      return null;
    } finally {
      setSending(false);
    }
  }, [workspaceId, userId, sending, activeConversation, activeProfile]);

  const upsertProfile = useCallback(async (patch: Partial<BusinessProfile> & { company_name: string }) => {
    if (!workspaceId || !userId) return null;
    const saved = await reeloraAI.upsertBusinessProfile({
      ...patch,
      workspace_id: workspaceId,
      user_id: userId,
    });
    await refreshAll();
    return saved;
  }, [workspaceId, userId, refreshAll]);

  const addMemory = useCallback(async (input: {
    category: BusinessMemoryCategory;
    memoryKey: string;
    summary: string;
    pinned?: boolean;
  }) => {
    if (!activeProfile) throw new Error('Créez d’abord un profil entreprise Business Grow.');
    const id = await reeloraAI.saveBusinessMemory({
      businessProfileId: activeProfile.id,
      ...input,
    });
    setMemories(await reeloraAI.listBusinessMemories(activeProfile.id));
    return id;
  }, [activeProfile]);

  const resolveTool = useCallback(async (executionId: string, decision: 'approved' | 'rejected') => {
    const res = await reeloraAI.resolveToolExecution(executionId, decision);
    if (decision === 'approved') {
      const target = pendingTools.find((t) => t.id === executionId);
      if (target?.tool_name === 'propose_business_memory_save' && activeProfile) {
        const args = target.input_args as { category?: BusinessMemoryCategory; memory_key?: string; summary?: string };
        if (args.category && args.memory_key && args.summary) {
          await reeloraAI.saveBusinessMemory({
            businessProfileId: activeProfile.id,
            category: args.category,
            memoryKey: args.memory_key,
            summary: args.summary,
            sourceType: 'conversation_extracted',
          });
          setMemories(await reeloraAI.listBusinessMemories(activeProfile.id));
        }
      }
    }
    setPendingTools((prev) => prev.filter((t) => t.id !== executionId));
    return res;
  }, [pendingTools, activeProfile]);

  const verifyProvider = useCallback(async (providerKey: AIProviderKey, modelId?: string) => {
    const res = await reeloraAI.verifyProvider(providerKey, modelId);
    const h = await reeloraAI.getHealth().catch(() => null);
    if (h) setHealth(h);
    return res;
  }, []);

  return {
    loading,
    sending,
    error,
    health,
    bgQuota,
    profiles,
    activeProfile,
    setActiveProfileId,
    memories,
    conversations,
    activeConversation,
    setActiveConversationId,
    messages,
    pendingTools,
    connectors,
    lastResponse,
    refreshAll,
    sendMessage,
    upsertProfile,
    addMemory,
    resolveTool,
    verifyProvider,
  };
}
