// @vitest-environment jsdom
/**
 * Tests d'intégration frontend du SDK `src/ai/*` et du hook `useBusinessGrow`
 * (fixtures Supabase et Edge Function simulées — aucune requête réseau réelle).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const supabaseMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    functions: { invoke: supabaseMocks.invoke },
    rpc: supabaseMocks.rpc,
    from: supabaseMocks.from,
  },
  STORAGE_BUCKET: 'ugc-assets',
  SITE_URL: 'https://reelora.test',
}));

import { reeloraAI, useBusinessGrow } from '../src/ai/index';

function queryBuilder(rows: unknown) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    insert: () => chain,
    upsert: () => chain,
    delete: () => chain,
    single: async () => ({ data: Array.isArray(rows) ? rows[0] : rows, error: null }),
    then: (resolve: (v: { data: unknown; error: null }) => void) =>
      Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SDK src/ai & hook React useBusinessGrow (simulé)', () => {
  it('hydrate le profil, les souvenirs, les crédits isolés BG et valide les outils avec approbation explicite', async () => {
    const profileRow = {
      id: 'prof-1',
      workspace_id: 'ws-1',
      user_id: 'u-1',
      company_name: 'Kora Beauté',
      industry: 'Cosmétique',
      tagline: null,
      description: null,
      website_url: null,
      primary_language: 'fr',
      products_services: [{ name: 'Sérum Karité' }],
      target_customers: ['Femmes 25-40'],
      business_goals: ['+30% CA'],
      positioning: 'Naturel premium',
      brand_identity: {},
      communication_tone: 'Authentique',
      preferences: {},
      ai_memory_consent: true,
      consent_updated_at: null,
      is_default: true,
      status: 'active',
      created_at: '2026-11-09T10:00:00Z',
      updated_at: '2026-11-09T10:00:00Z',
    };
    const convRow = {
      id: 'conv-1',
      workspace_id: 'ws-1',
      user_id: 'u-1',
      business_profile_id: 'prof-1',
      title: 'Croissance T4',
      objective: null,
      active_task_type: 'chat',
      routing_override: {},
      status: 'active',
      last_message_at: null,
      created_at: '2026-11-09T10:00:00Z',
      updated_at: '2026-11-09T10:00:00Z',
    };
    const pendingTool = {
      id: 'tool-exec-1',
      workspace_id: 'ws-1',
      user_id: 'u-1',
      business_profile_id: 'prof-1',
      conversation_id: 'conv-1',
      message_id: 'msg-1',
      request_id: 'req-1',
      tool_name: 'propose_business_memory_save',
      risk_level: 'write_requires_approval',
      status: 'pending_approval',
      input_args: { category: 'goal', memory_key: 'panier_moyen', summary: 'Viser 35 EUR de panier moyen.' },
      output_result: {},
      error_message: null,
      approved_by: null,
      approved_at: null,
      executed_at: null,
      created_at: '2026-11-09T10:01:00Z',
    };

    supabaseMocks.from.mockImplementation((table: string) => {
      if (table === 'reelora_bg_business_profiles') return queryBuilder([profileRow]);
      if (table === 'reelora_bg_conversations') return queryBuilder([convRow]);
      if (table === 'reelora_bg_business_memories') return queryBuilder([]);
      if (table === 'reelora_bg_external_connectors') return queryBuilder([]);
      if (table === 'reelora_bg_messages') return queryBuilder([]);
      if (table === 'reelora_bg_tool_executions') return queryBuilder([pendingTool]);
      return queryBuilder([]);
    });

    supabaseMocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'reelora_bg_quota_status') {
        return {
          data: {
            wallet_id: 'w-bg-1',
            workspace_id: 'ws-1',
            credit_domain: 'business_grow',
            studio_ugc_credits_untouched: true,
            available_credits: 48,
            reserved_credits: 0,
            monthly_allowance: 50,
            period_key: '2026-11',
            period_used: 2,
            lifetime_consumed: 2,
          },
          error: null,
        };
      }
      if (name === 'reelora_bg_resolve_tool_execution') {
        return { data: { id: 'tool-exec-1', status: 'approved', tool_name: 'propose_business_memory_save', approved_at: '2026-11-09T10:02:00Z' }, error: null };
      }
      if (name === 'reelora_bg_upsert_memory') {
        return { data: 'mem-saved-1', error: null };
      }
      return { data: true, error: null };
    });

    supabaseMocks.invoke.mockImplementation(async (_fn: string, opts: { body: { action: string } }) => {
      if (opts.body.action === 'health') {
        return {
          data: {
            engine: 'reelora-ai-engine',
            status: 'ok',
            creditDomainIsolation: true,
            providers: [],
            models: [],
          },
          error: null,
        };
      }
      if (opts.body.action === 'business_chat') {
        return {
          data: {
            requestId: 'req-2',
            space: 'business_grow',
            taskType: 'strategy',
            provider: 'gemini',
            model: 'gemini-2.5-pro',
            fallbackUsed: true,
            attempts: [],
            text: 'Plan stratégique généré.',
            toolProposals: [],
            usage: {
              inputTokens: 320,
              outputTokens: 110,
              estimatedCostUsd: 0.0015,
              bgCreditsCharged: 3,
              studioUgcCreditsCharged: 0,
            },
            latencyMs: 840,
            messageId: 'msg-2',
            businessProfileId: 'prof-1',
          },
          error: null,
        };
      }
      return { data: {}, error: null };
    });

    const { result } = renderHook(() => useBusinessGrow({ workspaceId: 'ws-1', userId: 'u-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.bgQuota?.credit_domain).toBe('business_grow');
    expect(result.current.bgQuota?.studio_ugc_credits_untouched).toBe(true);
    expect(result.current.activeProfile?.company_name).toBe('Kora Beauté');
    expect(result.current.pendingTools).toHaveLength(1);

    await act(async () => {
      const response = await result.current.sendMessage({
        prompt: 'Construis la stratégie de vente Q4.',
        taskType: 'strategy',
      });
      expect(response?.provider).toBe('gemini');
      expect(response?.fallbackUsed).toBe(true);
      expect(response?.usage.studioUgcCreditsCharged).toBe(0);
    });

    // Explicit approval of memory tool triggers reelora_bg_upsert_memory
    await act(async () => {
      await result.current.resolveTool('tool-exec-1', 'approved');
    });
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('reelora_bg_resolve_tool_execution', {
      p_execution_id: 'tool-exec-1',
      p_decision: 'approved',
    });
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('reelora_bg_upsert_memory', expect.objectContaining({
      p_business_profile_id: 'prof-1',
      p_category: 'goal',
      p_memory_key: 'panier_moyen',
    }));

    // Direct SDK call test
    const q = await reeloraAI.getBGQuota('ws-1');
    expect(q.available_credits).toBe(48);
  });
});
