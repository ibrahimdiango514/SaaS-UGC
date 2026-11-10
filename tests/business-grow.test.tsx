// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BusinessGrow from '../src/business/BusinessGrow';
import type { ReactNode } from 'react';
import {
  BUSINESS_PROVIDERS, isBusinessProviderAvailable,
} from '../src/business/ai/registry';

vi.mock('../src/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: (() => {
    const user = { id: 'business-grow-test-user', email: 'business-grow@example.test' };
    const session = { access_token: 'test-token' };
    return () => ({
      user, session, profile: null, workspace: null, workspaceId: null, quota: null,
      isAdmin: false, loading: false, bootstrapError: null,
      refreshQuota: vi.fn(), refreshAll: vi.fn(), logout: vi.fn(),
    });
  })(),
}));

const businessMocks = vi.hoisted(() => {
  const state: {
    conversations: Array<{ id: string; title: string; created_at: string; updated_at: string; last_message?: string }>;
    messages: Array<{
      id: string;
      author_role: 'user' | 'assistant';
      content: string;
      created_at: string;
      request_status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
      request_error_code?: string | null;
    }>;
    memory: { consent: boolean; policyVersion: string | null; profile: Record<string, unknown> | null; items: Array<{ id: string; category: string; content: unknown; created_at: string; updated_at: string }> };
  } = { conversations: [], messages: [], memory: { consent: false, policyVersion: null, profile: null, items: [] } };
  const createdId = '11111111-1111-4111-8111-111111111111';
  return {
    state,
    createdId,
    getStatus: vi.fn(async () => ({ providers: [] })),
    listConversations: vi.fn(async () => ({ conversations: state.conversations })),
    createConversation: vi.fn(async (title: string) => {
      state.conversations.unshift({
        id: createdId, title, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      });
      return { conversationId: createdId };
    }),
    renameConversation: vi.fn(async (id: string, title: string) => {
      const conversation = state.conversations.find((item) => item.id === id);
      if (conversation) conversation.title = title;
      return { renamed: Boolean(conversation) };
    }),
    deleteConversation: vi.fn(async (id: string) => {
      const originalLength = state.conversations.length;
      state.conversations = state.conversations.filter((item) => item.id !== id);
      return { deleted: state.conversations.length !== originalLength };
    }),
    listMessages: vi.fn(async (_conversationId?: string) => ({ messages: state.messages })),
    sendMessage: vi.fn(async (_id?: string, _content?: string) => {
      throw Object.assign(new Error('Aucun fournisseur vérifié.'), { code: 'NO_VERIFIED_PROVIDER' });
    }),
    getMemory: vi.fn(async () => state.memory),
    setMemoryConsent: vi.fn(async (enabled: boolean) => {
      state.memory = { ...state.memory, consent: enabled, policyVersion: 'business-grow-memory-v1' };
      return { event_id: 1, occurred_at: '2026-01-01T00:00:00Z' };
    }),
    saveMemoryProfile: vi.fn(async () => ({ saved: true })),
    putMemoryItem: vi.fn(async () => ({ itemId: '22222222-2222-4222-8222-222222222222' })),
    deleteMemoryItem: vi.fn(async () => ({ deleted: true })),
  };
});

vi.mock('../src/business/api', () => ({
  BusinessGrowApiError: class BusinessGrowApiError extends Error {
    constructor(message: string, readonly code: string) { super(message); }
  },
  businessGrowApi: businessMocks,
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return { ...actual, listNotifications: async () => [] };
});

import App from '../src/App';

beforeEach(() => {
  businessMocks.state.conversations = [];
  businessMocks.state.messages = [];
  businessMocks.state.memory = { consent: false, policyVersion: null, profile: null, items: [] };
  vi.clearAllMocks();
  businessMocks.getStatus.mockResolvedValue({ providers: [] });
  businessMocks.listConversations.mockImplementation(async () => ({ conversations: businessMocks.state.conversations }));
  businessMocks.listMessages.mockImplementation(async () => ({ messages: businessMocks.state.messages }));
  businessMocks.sendMessage.mockImplementation(async () => {
    throw Object.assign(new Error('Aucun fournisseur vérifié.'), { code: 'NO_VERIFIED_PROVIDER' });
  });
});

afterEach(cleanup);

describe('Business Grow', () => {
  it('est accessible par la route protégée et la navigation de l’application', async () => {
    window.history.pushState({}, '', '/app/business');
    render(<App />);
    expect(await screen.findByTestId('business-grow')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Business Grow/ }).length).toBeGreaterThan(0);
  });

  it('charge le backend mais ne prétend pas disposer d’un fournisseur IA', async () => {
    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByText(/Aucun fournisseur IA vérifié/)).toBeTruthy();
    expect(screen.getByTestId('business-overall-status').textContent).toContain('IA non disponible');

    const composer = screen.getByLabelText('Votre demande') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Rédige une campagne pour mon produit.' } });
    expect(composer.value).toBe('Rédige une campagne pour mon produit.');
    expect((screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Aucune conversation enregistrée')).toBeTruthy();
  });

  it('charge la mémoire consentie et affiche les statuts vérifiables des fournisseurs', async () => {
    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Mémoire métier' }));
    expect(screen.getByText('Mémoire métier privée')).toBeTruthy();
    expect(await screen.findByText('La mémoire est désactivée et reste vide.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Fournisseurs IA' }));
    expect(screen.getByText('Registre des fournisseurs')).toBeTruthy();
    expect(screen.getByTestId('provider-gemini')).toBeTruthy();
    expect(screen.getByTestId('provider-groq')).toBeTruthy();
    expect(screen.getByText('Rédaction')).toBeTruthy();
    expect(screen.getByTestId('provider-muapi').textContent).toContain('Hors du routage conversationnel');
  });

  it('crée et affiche une conversation seulement après confirmation de création serveur', async () => {
    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    const createButton = await screen.findByRole('button', { name: 'Nouvelle conversation' });
    fireEvent.click(createButton);

    expect(await screen.findAllByRole('button', { name: /^Nouvelle conversation$/ })).toHaveLength(2);
    expect(businessMocks.createConversation).toHaveBeenCalledWith('Nouvelle conversation', null);
  });

  it('charge les messages de la conversation sélectionnée', async () => {
    const first = '33333333-3333-4333-8333-333333333333';
    const second = '44444444-4444-4444-8444-444444444444';
    businessMocks.state.conversations = [
      { id: first, title: 'Campagne A', created_at: '2026-01-01', updated_at: '2026-01-01' },
      { id: second, title: 'Campagne B', created_at: '2026-01-02', updated_at: '2026-01-02' },
    ];
    businessMocks.listMessages.mockImplementation(async (conversationId?: string) => ({
      messages: [{
        id: `message-${conversationId ?? 'unknown'}`,
        author_role: 'user',
        content: conversationId === first ? 'Message A' : 'Message B',
        created_at: '2026-01-02',
      }],
    }));

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByText('Message A')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Campagne B/ }));
    expect(await screen.findByText('Message B')).toBeTruthy();
    expect(businessMocks.listMessages).toHaveBeenCalledWith(second);
  });

  it('affiche fidèlement les statuts du traitement conservés dans l’historique', async () => {
    const conversationId = '77777777-7777-4777-8777-777777777777';
    businessMocks.state.conversations = [
      { id: conversationId, title: 'Statuts', created_at: '2026-01-01', updated_at: '2026-01-01' },
    ];
    businessMocks.state.messages = [
      { id: 'm1', author_role: 'user', content: '1', created_at: '2026-01-01', request_status: 'queued' },
      { id: 'm2', author_role: 'user', content: '2', created_at: '2026-01-01', request_status: 'running' },
      { id: 'm3', author_role: 'assistant', content: '3', created_at: '2026-01-01', request_status: 'succeeded' },
      { id: 'm4', author_role: 'user', content: '4', created_at: '2026-01-01', request_status: 'failed', request_error_code: 'NO_VERIFIED_PROVIDER' },
    ];

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByText('En attente')).toBeTruthy();
    expect(screen.getByText('Traitement en cours')).toBeTruthy();
    expect(screen.getByText('Traitement réussi')).toBeTruthy();
    expect(screen.getByText('Erreur (NO_VERIFIED_PROVIDER)')).toBeTruthy();
  });

  it('conserve le message utilisateur et affiche l’erreur réelle quand aucun fournisseur ne répond', async () => {
    const conversationId = '88888888-8888-4888-8888-888888888888';
    businessMocks.state.conversations = [
      { id: conversationId, title: 'Question', created_at: '2026-01-01', updated_at: '2026-01-01' },
    ];
    businessMocks.sendMessage.mockImplementationOnce(async (_id?: string, content?: string) => {
      businessMocks.state.messages.push({
        id: 'persisted-user-message',
        author_role: 'user',
        content: content ?? '',
        created_at: '2026-01-01',
        request_status: 'failed',
        request_error_code: 'NO_VERIFIED_PROVIDER',
      });
      throw Object.assign(new Error('Aucun fournisseur vérifié. Aucune réponse simulée.'), { code: 'NO_VERIFIED_PROVIDER' });
    });

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Question' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Votre demande'), { target: { value: 'Aidez-moi à planifier.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));

    expect(await screen.findByText('Aucun fournisseur vérifié. Aucune réponse simulée.')).toBeTruthy();
    expect(await screen.findByText('Aidez-moi à planifier.')).toBeTruthy();
    expect(await screen.findByText('Erreur (NO_VERIFIED_PROVIDER)')).toBeTruthy();
  });

  it('n’affiche pas le backend comme disponible si Supabase/Edge ne répond pas', async () => {
    businessMocks.getStatus.mockRejectedValue(new Error('Fonction Business Grow introuvable.'));
    businessMocks.listConversations.mockRejectedValue(new Error('Backend indisponible.'));

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByText('Backend Business Grow indisponible')).toBeTruthy();
    expect(screen.getByTestId('business-overall-status').textContent).toContain('Backend en attente');
    expect((screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Aucune donnée n’est enregistrée localement/)).toBeTruthy();
  });

  it('enregistre et révoque le consentement avant d’afficher les données mémoire', async () => {
    businessMocks.state.memory = {
      consent: true,
      policyVersion: 'business-grow-memory-v1',
      profile: { goal: 'Lancer une offre' },
      items: [{
        id: '66666666-6666-4666-8666-666666666666',
        category: 'business_context',
        content: { text: 'Produit de lancement' },
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      }],
    };
    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Mémoire métier' }));
    expect(await screen.findByDisplayValue(/Lancer une offre/)).toBeTruthy();
    expect(screen.getByText('Produit de lancement')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Activée' }));
    expect(await screen.findByText('La mémoire est désactivée et reste vide.')).toBeTruthy();
    expect(businessMocks.setMemoryConsent).toHaveBeenCalledWith(false);
  });

  it('renomme et supprime réellement une conversation via le backend', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    businessMocks.state.conversations = [
      { id, title: 'Ancien nom', created_at: '2026-01-01', updated_at: '2026-01-01' },
    ];

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Ancien nom' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Renommer la conversation' }));
    fireEvent.change(screen.getByLabelText('Nouveau titre de conversation'), { target: { value: 'Nom modifié' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le titre' }));
    expect(await screen.findByRole('button', { name: 'Nom modifié' })).toBeTruthy();
    expect(businessMocks.renameConversation).toHaveBeenCalledWith(id, 'Nom modifié');

    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la suppression' }));
    expect(await screen.findByText('Aucune conversation enregistrée')).toBeTruthy();
    expect(businessMocks.deleteConversation).toHaveBeenCalledWith(id);
  });

  it('enregistre les rôles initiaux comme propositions et aucun fournisseur comme disponible', () => {
    expect(BUSINESS_PROVIDERS.map((provider) => provider.id)).toEqual([
      'gemini', 'groq', 'gonka', 'kilo', 'openrouter', 'llm7', 'muapi',
    ]);
    expect(BUSINESS_PROVIDERS.every((provider) => provider.connectionState === 'unverified')).toBe(true);
    expect(BUSINESS_PROVIDERS.every((provider) => !isBusinessProviderAvailable(provider))).toBe(true);
    expect(BUSINESS_PROVIDERS.find((provider) => provider.id === 'gemini')?.proposedCapabilities)
      .toEqual(['writing', 'images', 'documents']);
    expect(BUSINESS_PROVIDERS.find((provider) => provider.id === 'groq')?.proposedCapabilities)
      .toEqual(['scripts', 'hooks', 'reasoning']);
    expect(BUSINESS_PROVIDERS.find((provider) => provider.id === 'kilo')?.proposedCapabilities)
      .toEqual(['economic-routing', 'fallback']);
  });
});
