// VYORA AI CORE — mémoire persistante de l'agent (Business Grow).
//
// Verrouille : (1) l'extraction heuristique des DÉCLARATIONS explicites
// (jamais la conversation entière), (2) l'injection de la mémoire dans le
// prompt système (seulement avec consentement), (3) les actions de contrôle
// utilisateur (recherche/listing/effacement) et (4) le versionnement
// (une déclaration répétée remplace l'ancienne, pas de duplication).
import { describe, expect, it, vi } from 'vitest';
import {
  createBusinessGrowHandler,
  type BusinessGrowDependencies,
  type BusinessGrowStore,
} from '../supabase/functions/business-grow/handler';
import {
  buildBusinessSystemInstruction,
  extractUserStatement,
  type AgentMemoryItem,
} from '../supabase/functions/business-grow/intelligence';

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const convA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const wsA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function fixture(overrides: {
  consent?: boolean;
  memories?: AgentMemoryItem[];
} = {}) {
  const searchAgentMemory = vi.fn(async () => (overrides.memories ?? []));
  const saveAgentMemory = vi.fn(async (_u: string, _w: string | null, _c: string, _t: string, _content: string, _conf: string, _src: string, _sup?: string | null) => 'mem-new-id');
  const listAgentMemories = vi.fn(async () => (overrides.memories ?? []));
  const forgetAgentMemory = vi.fn(async () => true);
  const store: BusinessGrowStore = {
    listProviders: vi.fn(async () => []),
    listConversations: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    createConversation: vi.fn(async () => convA),
    renameConversation: vi.fn(async () => true),
    deleteConversation: vi.fn(async () => true),
    getMemory: vi.fn(async () => ({ consent: overrides.consent ?? false, items: [] })),
    setMemoryConsent: vi.fn(async () => ({})),
    saveMemoryProfile: vi.fn(async () => undefined),
    putMemoryItem: vi.fn(async () => 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
    deleteMemoryItem: vi.fn(async () => true),
    searchAgentMemory,
    saveAgentMemory,
    listAgentMemories,
    forgetAgentMemory,
    submitUserMessage: vi.fn(async () => ({ requestId: 'r1', inputMessageId: 'm1', status: 'queued', created: true })),
    startRequest: vi.fn(async () => undefined),
    selectRoute: vi.fn(async () => ({
      attemptId: '99999999-9999-4999-8999-999999999999',
      providerKey: 'groq',
      modelKey: 'groq-logical-key',
      providerModelKey: 'verified-groq-model',
    })),
    finalizeAttempt: vi.fn(async () => undefined),
    failRequest: vi.fn(async () => undefined),
    captureQuota: vi.fn(async () => ({})),
  };
  const complete = vi.fn(async (_p: string, _c: unknown, _m?: unknown) => ({ content: 'Réponse de test.', inputTokens: 10, outputTokens: 12 }));
  const dependencies: BusinessGrowDependencies = {
    store,
    getUserId: vi.fn(async (authorization) => authorization === 'Bearer valid-user-session' ? userA : null),
    allowedOrigins: ['https://reelora.test'],
    providerConfigs: { groq: { apiKey: 'k', model: 'verified-groq-model' } },
    providerOrder: ['groq'],
    complete,
  };
  return { store, complete, searchAgentMemory, saveAgentMemory, listAgentMemories, forgetAgentMemory, handler: createBusinessGrowHandler(dependencies) };
}

function request(body: unknown) {
  return new Request('https://edge.test/business-grow', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-user-session', Origin: 'https://reelora.test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Extraction heuristique — seulement les déclarations explicites
// ---------------------------------------------------------------------------
describe('extraction des déclarations explicites', () => {
  it('catégorise une déclaration sur l’entreprise', () => {
    const s = extractUserStatement('Notre entreprise vend des savons artisanaux à Bamako, notre budget marketing est de 500 000 FCFA par mois.');
    expect(s?.category).toBe('company');
    expect(s?.content).toContain('savons artisanaux');
    expect(s?.title.length).toBeLessThanOrEqual(90);
  });

  it('catégorise une décision', () => {
    const s = extractUserStatement("J'ai décidé de cibler les pharmacies plutôt que les supermarchés pour la première campagne.");
    expect(s?.category).toBe('decision');
  });

  it('catégorise une décision avec apostrophe typographique (U+2019)', () => {
    const s = extractUserStatement('J’ai décidé de lancer notre boutique en ligne.');
    expect(s?.category).toBe('decision');
  });

  it('catégorise une préférence personnelle', () => {
    const s = extractUserStatement('Je préfère des scripts courts, avec un ton authentique et sans jargon technique.');
    expect(s?.category).toBe('user');
  });

  it('ne mémorise jamais une simple question ni une demande', () => {
    expect(extractUserStatement('Comment je peux améliorer mes ventes ce mois-ci ?')).toBeNull();
    expect(extractUserStatement('Prépare-moi un plan de marketing pour le lancement.')).toBeNull();
    expect(extractUserStatement('Merci pour cette analyse, c’est très utile.')).toBeNull();
  });

  it('refuse les textes trop longs (pas d’accumulation de conversation)', () => {
    expect(extractUserStatement(`Notre entreprise vend des produits. ${'a'.repeat(520)}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Injection dans le prompt système
// ---------------------------------------------------------------------------
describe('injection de la mémoire dans le prompt', () => {
  const memories: AgentMemoryItem[] = [
    { id: 'm1', category: 'company', title: 'Notre entreprise vend des savons', content: 'Notre entreprise vend des savons artisanaux à Bamako.', confidence: 'fact' },
    { id: 'm2', category: 'decision', title: 'Ciblage pharmacies', content: 'On a décidé de cibler les pharmacies.', confidence: 'hypothesis' },
  ];

  it('ajoute la section mémoire avec la règle fait/hypothèse', () => {
    const prompt = buildBusinessSystemInstruction({
      baseSystemMessage: 'BASE.',
      roleKey: 'business_advisor',
      agentMemories: memories,
    });
    expect(prompt).toContain('Mémoire de l’agent');
    expect(prompt).toContain('savons artisanaux');
    expect(prompt).toContain('confiance' .replace('confiance', 'confidence'));
    expect(prompt).toContain('FAIT que les entrées marquées confidence=fact');
  });

  it('préserve le prompt de base quand la mémoire est vide', () => {
    const prompt = buildBusinessSystemInstruction({
      baseSystemMessage: 'BASE.',
      roleKey: 'business_advisor',
      agentMemories: [],
    });
    expect(prompt).toBe('BASE.');
  });
});

// ---------------------------------------------------------------------------
// Actions de contrôle utilisateur
// ---------------------------------------------------------------------------
describe('actions agentMemory (contrôle utilisateur)', () => {
  it('recherche dans la mémoire agent (périmètre utilisateur)', async () => {
    const { handler, searchAgentMemory } = fixture({ memories: [{ id: 'm1', category: 'company', title: 't', content: 'c', confidence: 'fact' }] });
    const res = await handler(request({ action: 'agentMemory.search', query: 'budget', workspaceId: wsA }));
    expect(res.status).toBe(200);
    expect(searchAgentMemory).toHaveBeenCalledWith(userA, wsA, 'budget', 8);
    const body = await res.json();
    expect(body.data.memories).toHaveLength(1);
  });

  it('liste les mémoires (catégorie optionnelle)', async () => {
    const { handler, listAgentMemories } = fixture();
    const res = await handler(request({ action: 'agentMemory.list', category: 'decision' }));
    expect(res.status).toBe(200);
    expect(listAgentMemories).toHaveBeenCalledWith(userA, null, 'decision', 20);
  });

  it('efface une mémoire (correction + effacement)', async () => {
    const memoryId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const { handler, forgetAgentMemory } = fixture();
    const res = await handler(request({ action: 'agentMemory.forget', memoryId }));
    expect(res.status).toBe(200);
    expect(forgetAgentMemory).toHaveBeenCalledWith(userA, memoryId);
    const body = await res.json();
    expect(body.data.forgotten).toBe(true);
  });

  it('valide les identifiants (uuid requis)', async () => {
    const { handler, forgetAgentMemory } = fixture();
    const res = await handler(request({ action: 'agentMemory.forget', memoryId: 'pas-un-uuid' }));
    expect(res.status).toBe(400);
    expect(forgetAgentMemory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Flux messages.send : lecture (consentement) + mémorisation versionnée
// ---------------------------------------------------------------------------
describe('flux messages.send avec mémoire agent', () => {
  it('sans consentement : la mémoire agent n’est ni lue ni écrite', async () => {
    const { handler, searchAgentMemory, saveAgentMemory } = fixture({ consent: false });
    const res = await handler(request({
      action: 'messages.send', conversationId: convA,
      content: 'Notre entreprise vend des savons artisanaux, notre budget est de 500 000 FCFA.',
      idempotencyKey: crypto.randomUUID(), workspaceId: wsA,
    }));
    expect(res.status).toBe(200);
    expect(searchAgentMemory).not.toHaveBeenCalled();
    expect(saveAgentMemory).not.toHaveBeenCalled();
  });

  it('avec consentement : la mémoire est lue et injectée dans le prompt', async () => {
    const { handler, complete } = fixture({ consent: true, memories: [{ id: 'm1', category: 'company', title: 't', content: 'Notre entreprise vend des savons artisanaux à Bamako.', confidence: 'fact' }] });
    const res = await handler(request({
      action: 'messages.send', conversationId: convA,
      content: 'Aide-moi à préparer ma campagne.',
      idempotencyKey: crypto.randomUUID(), workspaceId: wsA,
    }));
    expect(res.status).toBe(200);
    const history = complete.mock.calls[0][2] as Array<{ role: string; content: string }>;
    expect(history[0].content).toContain('Mémoire de l’agent');
    expect(history[0].content).toContain('savons artisanaux');
  });

  it('une déclaration explicite est mémorisée (source user_statement, fait)', async () => {
    const { handler, saveAgentMemory } = fixture({ consent: true });
    const res = await handler(request({
      action: 'messages.send', conversationId: convA,
      content: 'Notre entreprise vend des savons artisanaux à Bamako, notre budget est de 500 000 FCFA par mois.',
      idempotencyKey: crypto.randomUUID(), workspaceId: wsA,
    }));
    expect(res.status).toBe(200);
    expect(saveAgentMemory).toHaveBeenCalledTimes(1);
    const args = saveAgentMemory.mock.calls[0];
    expect(args[0]).toBe(userA);
    expect(args[1]).toBe(wsA);
    expect(args[2]).toBe('company');
    expect(String(args[4])).toContain('savons artisanaux');
    expect(args[5]).toBe('fact');
    expect(args[6]).toBe('user_statement');
    expect(args[7]).toBeNull();
  });

  it('une déclaration répétée REMPLACE l’ancienne (versionnement, pas de doublon)', async () => {
    // Une mémoire au même titre existe déjà → le save doit la versionner.
    const statement = 'Notre entreprise vend des savons artisanaux à Bamako, notre budget est de 500 000 FCFA par mois.';
    const existingTitle = statement.split('\n')[0].trim().slice(0, 90);
    const f2 = fixture({
      consent: true,
      memories: [{ id: 'mem-ancien', category: 'company', title: existingTitle, content: statement, confidence: 'fact' }],
    });
    const res = await f2.handler(request({ action: 'messages.send', conversationId: convA, content: statement, idempotencyKey: crypto.randomUUID(), workspaceId: wsA }));
    expect(res.status).toBe(200);
    expect(f2.saveAgentMemory).toHaveBeenCalledTimes(1);
    expect(f2.saveAgentMemory.mock.calls[0][7]).toBe('mem-ancien');
  });
});
