// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BusinessGrow from '../src/business/BusinessGrow';
import { BusinessGrowApiError } from '../src/business/api';
import type { ReactNode } from 'react';
import type { Brand, Product } from '../src/lib/types';
import {
  BUSINESS_PROVIDERS, isBusinessProviderAvailable,
} from '../src/business/ai/registry';
import { buildBusinessGrowLocationState } from '../src/contracts/business-grow';

const authMocks = vi.hoisted(() => ({
  userId: 'business-grow-test-user',
  workspace: null as null | {
    id: string;
    owner_user_id: string;
    name: string;
    country_code: string;
    default_language: string;
    created_at: string;
    updated_at: string;
  },
}));

vi.mock('../src/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: (() => {
    const session = { access_token: 'test-token' };
    return () => ({
      user: { id: authMocks.userId, email: `${authMocks.userId}@example.test` },
      session, profile: null, workspace: authMocks.workspace, workspaceId: authMocks.workspace?.id ?? null, quota: null,
      isAdmin: false, loading: false, bootstrapError: null,
      refreshQuota: vi.fn(), refreshAll: vi.fn(), logout: vi.fn(),
    });
  })(),
}));

/**
 * Implémentation par défaut de `verifyProvider`, réarmée dans `beforeEach`.
 * Les `mockResolvedValueOnce` d'un test restent ainsi réservés à ce test : la
 * sonde automatique de fin de test ne peut plus les consommer.
 */
const defaultVerifyProvider = async (providerKey: string) => ({
  providerKey,
  modelKey: 'verified-groq-model',
  status: 'healthy' as const,
  latencyMs: 38,
  errorCode: null,
  availableModels: ['verified-groq-model'],
});
const verifyProviderImpl = { current: defaultVerifyProvider };
/** Préférences de routage réellement servies par le backend mocké. */
const savedPreferences = { current: [] as Array<Record<string, unknown>> };

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
      request_provider_key?: string | null;
      request_model_key?: string | null;
    }>;
    memory: { consent: boolean; policyVersion: string | null; profile: Record<string, unknown> | null; items: Array<{ id: string; category: string; content: unknown; created_at: string; updated_at: string }> };
  } = { conversations: [], messages: [], memory: { consent: false, policyVersion: null, profile: null, items: [] } };
  const createdId = '11111111-1111-4111-8111-111111111111';
  return {
    state,
    createdId,
    listBrands: vi.fn(async (_workspaceId: string): Promise<Brand[]> => [{
      id: 'brand-1', workspace_id: 'workspace-1', name: 'Atelier Test', website_url: null,
      industry: 'Cosmétiques', description: 'Soins naturels', logo_storage_path: null,
      brand_colors: [], voice_guidelines: 'Chaleureux et direct',
      created_at: '2026-01-01', updated_at: '2026-01-01',
    }]),
    listProducts: vi.fn(async (_workspaceId: string): Promise<Product[]> => [{
      id: 'product-1', workspace_id: 'workspace-1', brand_id: 'brand-1', name: 'Sérum Éclat',
      description: 'Sérum naturel', key_benefits: ['Hydrate'], features: [], price_amount: null,
      price_currency: null, product_url: null, reference_image_paths: [], product_facts: {},
      created_at: '2026-01-01', updated_at: '2026-01-01',
    }]),
    getStatus: vi.fn(async (): Promise<{ providers: Array<Record<string, unknown>> }> => ({ providers: [] })),
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
    sendMessage: vi.fn(async (_id?: string, _content?: string, _idem?: string, _options?: unknown): Promise<{
      requestId: string; inputMessageId: string; status: string; providerAvailable: boolean;
      provider?: { key: string; model: string };
    }> => {
      throw Object.assign(new Error('Aucun fournisseur vérifié.'), { code: 'NO_VERIFIED_PROVIDER' });
    }),
    verifyProvider: vi.fn(async (providerKey: string) => verifyProviderImpl.current(providerKey)),
    listModels: vi.fn(async () => ({ models: [], remoteModels: {} })),
    getQuota: vi.fn(async (): Promise<{
      domain: 'business_grow';
      studio_ugc_untouched: boolean;
      available_units: number | null;
      reserved_units: number;
      monthly_allowance: number | null;
    }> => ({
      domain: 'business_grow',
      studio_ugc_untouched: true,
      available_units: null,
      reserved_units: 0,
      monthly_allowance: null,
    })),
    listRequests: vi.fn(async () => ({ requests: [] })),
    listTools: vi.fn(async () => ({ tools: [] as Array<Record<string, unknown>> })),
    resolveTool: vi.fn(async (_id: string, _decision: 'approved' | 'rejected') => ({ status: 'executed' })),
    listIntegrations: vi.fn(async () => ({ connections: [] })),
    getRouting: vi.fn(async () => ({ preferences: [] as Array<Record<string, unknown>> })),
    saveRouting: vi.fn(async () => ({ saved: true, id: 'pref-1' })),
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
  return {
    ...actual,
    listNotifications: async () => [],
    listBrands: businessMocks.listBrands,
    listProducts: businessMocks.listProducts,
  };
});

import App from '../src/App';

beforeEach(() => {
  authMocks.userId = 'business-grow-test-user';
  authMocks.workspace = null;
  businessMocks.state.conversations = [];
  businessMocks.state.messages = [];
  businessMocks.state.memory = { consent: false, policyVersion: null, profile: null, items: [] };
  vi.clearAllMocks();
  verifyProviderImpl.current = defaultVerifyProvider;
  businessMocks.getStatus.mockResolvedValue({ providers: [] });
  businessMocks.listModels.mockResolvedValue({ models: [], remoteModels: {} });
  businessMocks.getQuota.mockResolvedValue({
    domain: 'business_grow',
    studio_ugc_untouched: true,
    available_units: null,
    reserved_units: 0,
    monthly_allowance: null,
  });
  businessMocks.listRequests.mockResolvedValue({ requests: [] });
  businessMocks.listTools.mockResolvedValue({ tools: [] });
  businessMocks.listIntegrations.mockResolvedValue({ connections: [] });
  savedPreferences.current = [];
  businessMocks.getRouting.mockImplementation(async () => ({ preferences: savedPreferences.current }));
  businessMocks.listConversations.mockImplementation(async () => ({ conversations: businessMocks.state.conversations }));
  businessMocks.listMessages.mockImplementation(async () => ({ messages: businessMocks.state.messages }));
  businessMocks.sendMessage.mockReset();
  businessMocks.sendMessage.mockImplementation(async () => {
    throw Object.assign(new Error('Aucun fournisseur vérifié.'), { code: 'NO_VERIFIED_PROVIDER' });
  });
  businessMocks.createConversation.mockClear();
  businessMocks.listBrands.mockClear();
  businessMocks.listProducts.mockClear();
});

afterEach(cleanup);

describe('Business Grow', () => {
  it('est accessible par la route protégée et la navigation de l’application', async () => {
    window.history.pushState({}, '', '/app/business');
    render(<App />);
    expect(await screen.findByTestId('business-grow')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Business Grow/ }).length).toBeGreaterThan(0);
  });

  it('charge le backend sans prétendre disposer d’un service IA', async () => {
    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByText(/Aucun service IA vérifié/)).toBeTruthy();
    expect(screen.getByTestId('business-overall-status').textContent).toContain('IA non disponible');

    const composer = screen.getByLabelText('Votre demande') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Rédige une campagne pour mon produit.' } });
    expect(composer.value).toBe('Rédige une campagne pour mon produit.');
    expect((screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Aucune conversation enregistrée')).toBeTruthy();
  });

  it('charge la mémoire consentie et affiche les statuts vérifiables des services IA', async () => {
    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Mémoire métier' }));
    expect(screen.getByText('Mémoire métier privée')).toBeTruthy();
    expect(await screen.findByText('La mémoire est désactivée et reste vide.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Services IA' }));
    expect(screen.getByText('Services IA VYORA')).toBeTruthy();
    expect(screen.getByTestId('provider-gemini')).toBeTruthy();
    expect(screen.getByTestId('provider-groq')).toBeTruthy();
    expect(screen.getByText('Rédaction')).toBeTruthy();
    expect(screen.getByTestId('provider-muapi').textContent).toContain('Génération vidéo');
  });

  it('affiche les marques et produits persistés dans le même espace VYORA', async () => {
    authMocks.workspace = {
      id: 'workspace-1', owner_user_id: 'business-grow-test-user', name: 'Atelier VYORA',
      country_code: 'ML', default_language: 'fr', created_at: '2026-01-01', updated_at: '2026-01-01',
    };
    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: 'Entreprise' }));

    expect(await screen.findByText('Atelier VYORA')).toBeTruthy();
    expect(await screen.findByText('Atelier Test')).toBeTruthy();
    expect(await screen.findByText('Sérum Éclat')).toBeTruthy();
    expect(screen.getByText('Ces données proviennent de l’espace VYORA partagé. Elles ne sont pas copiées dans la mémoire IA.')).toBeTruthy();
    expect(businessMocks.listBrands).toHaveBeenCalledWith('workspace-1');
    expect(businessMocks.listProducts).toHaveBeenCalledWith('workspace-1');
    expect(screen.getByRole('link', { name: /Gérer les informations/ }).getAttribute('href')).toBe('/app/parametres');
  });

  it('ignore les résultats retardés des marques et produits de l’espace précédent', async () => {
    let resolveOldBrands!: (brands: Brand[]) => void;
    businessMocks.listBrands.mockImplementation(async (workspaceId: string) => {
      if (workspaceId === 'workspace-1') {
        return new Promise((resolve) => { resolveOldBrands = resolve; });
      }
      return [{
        id: 'brand-new', workspace_id: workspaceId, name: 'Marque du nouvel espace', website_url: null,
        industry: 'Services', description: null, logo_storage_path: null, brand_colors: [],
        voice_guidelines: null, created_at: '2026-02-01', updated_at: '2026-02-01',
      }] satisfies Brand[];
    });
    businessMocks.listProducts.mockImplementation(async (workspaceId: string) => workspaceId === 'workspace-1' ? [{
      id: 'product-old', workspace_id: workspaceId, brand_id: null, name: 'Produit ancien',
      description: null, key_benefits: [], features: [], price_amount: null, price_currency: null,
      product_url: null, reference_image_paths: [], product_facts: {},
      created_at: '2026-01-01', updated_at: '2026-01-01',
    }] : []);
    authMocks.workspace = {
      id: 'workspace-1', owner_user_id: 'business-grow-test-user', name: 'Ancien espace',
      country_code: 'ML', default_language: 'fr', created_at: '2026-01-01', updated_at: '2026-01-01',
    };
    const view = render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Entreprise' }));
    await waitFor(() => expect(businessMocks.listBrands).toHaveBeenCalledWith('workspace-1'));

    authMocks.workspace = {
      id: 'workspace-2', owner_user_id: 'business-grow-test-user', name: 'Nouvel espace',
      country_code: 'FR', default_language: 'fr', created_at: '2026-02-01', updated_at: '2026-02-01',
    };
    view.rerender(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByText('Marque du nouvel espace')).toBeTruthy();

    resolveOldBrands([{
      id: 'brand-old', workspace_id: 'workspace-1', name: 'Marque de l’ancien espace',
      website_url: null, industry: 'Commerce', description: null, logo_storage_path: null,
      brand_colors: [], voice_guidelines: null, created_at: '2026-01-01', updated_at: '2026-01-01',
    }]);
    await waitFor(() => expect(screen.queryByText('Marque de l’ancien espace')).toBeNull());
    expect(screen.queryByText('Produit ancien')).toBeNull();
    expect(screen.getByText('Marque du nouvel espace')).toBeTruthy();
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

  it('ne laisse pas un chargement de messages d’un compte précédent repeupler Business Grow', async () => {
    const oldConversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newConversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    businessMocks.state.conversations = [{
      id: oldConversationId, title: 'Conversation privée A', created_at: '2026-01-01', updated_at: '2026-01-01',
    }];
    let resolveOldMessages!: (result: { messages: typeof businessMocks.state.messages }) => void;
    businessMocks.listMessages.mockImplementation(async (conversationId?: string) => {
      if (conversationId === oldConversationId) {
        return new Promise((resolve) => { resolveOldMessages = resolve; });
      }
      return {
        messages: [{
          id: 'new-account-message', author_role: 'assistant',
          content: 'Contenu privé du nouveau compte', created_at: '2026-02-01',
        }],
      };
    });

    const view = render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Conversation privée A' });
    await waitFor(() => expect(businessMocks.listMessages).toHaveBeenCalledWith(oldConversationId));

    authMocks.userId = 'business-grow-user-2';
    businessMocks.state.conversations = [{
      id: newConversationId, title: 'Conversation du compte B', created_at: '2026-02-01', updated_at: '2026-02-01',
    }];
    view.rerender(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByText('Contenu privé du nouveau compte')).toBeTruthy();

    resolveOldMessages({
      messages: [{
        id: 'old-account-message', author_role: 'assistant',
        content: 'Contenu privé de l’ancien compte', created_at: '2026-01-01',
      }],
    });
    await waitFor(() => expect(screen.queryByText('Contenu privé de l’ancien compte')).toBeNull());
    expect(screen.getByText('Contenu privé du nouveau compte')).toBeTruthy();
  });

  it('affiche fidèlement les statuts du traitement conservés dans l’historique', async () => {
    const conversationId = '77777777-7777-4777-8777-777777777777';
    businessMocks.state.conversations = [
      { id: conversationId, title: 'Statuts', created_at: '2026-01-01', updated_at: '2026-01-01' },
    ];
    businessMocks.state.messages = [
      { id: 'm1', author_role: 'user', content: '1', created_at: '2026-01-01', request_status: 'queued' },
      { id: 'm2', author_role: 'user', content: '2', created_at: '2026-01-01', request_status: 'running' },
      {
        id: 'm3', author_role: 'assistant', content: '3', created_at: '2026-01-01',
        request_status: 'succeeded', request_provider_key: 'gemini', request_model_key: 'model-via-fixture',
      },
      { id: 'm4', author_role: 'user', content: '4', created_at: '2026-01-01', request_status: 'failed', request_error_code: 'NO_VERIFIED_PROVIDER' },
    ];

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByText('En attente')).toBeTruthy();
    expect(screen.getByText('Traitement en cours')).toBeTruthy();
    expect(screen.getByText(/Traitement réussi/)).toBeTruthy();
    expect(screen.getByText(/Réponse générée par l’assistant VYORA/)).toBeTruthy();
    expect(screen.getByText('Aucun service IA n’est disponible pour cette demande. Réessayez plus tard.')).toBeTruthy();
  });

  it('conserve le message utilisateur et masque les détails techniques de service en erreur', async () => {
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

    expect(await screen.findByText('Aidez-moi à planifier.')).toBeTruthy();
    // Le statut réel du message persisté reste lisible, sans détail technique.
    expect(
      await screen.findAllByText('Aucun service IA n’est disponible pour cette demande. Réessayez plus tard.'),
    ).toHaveLength(1);
    // La bannière globale explique l'action réelle à effectuer (contrôle valable 24 h).
    expect(screen.getByText(/Aucun service IA n’est vérifié pour le moment\. Ouvrez « Services IA »/)).toBeTruthy();
    expect(screen.queryByText(/NO_VERIFIED_PROVIDER/)).toBeNull();
  });

  it('affiche la réponse réellement persistée sans exposer le service utilisé', async () => {
    businessMocks.sendMessage.mockImplementationOnce(async (_conversationId?: string, content?: string) => {
      businessMocks.state.messages = [
        {
          id: 'real-user-message', author_role: 'user', content: content ?? '',
          created_at: '2026-01-01', request_status: 'succeeded',
        },
        {
          id: 'real-assistant-message', author_role: 'assistant', content: 'Réponse issue du fournisseur.',
          created_at: '2026-01-01', request_status: 'succeeded',
          request_provider_key: 'gemini', request_model_key: 'verified-gemini-model',
        },
      ];
      return {
        requestId: '55555555-5555-4555-8555-555555555555',
        inputMessageId: '66666666-6666-4666-8666-666666666666',
        status: 'succeeded',
        providerAvailable: true,
        provider: { key: 'gemini', model: 'verified-gemini-model' },
      };
    });

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByText(/Aucun service IA vérifié n’est actuellement disponible/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Votre demande'), { target: { value: 'Réponds réellement.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));

    expect(await screen.findByText('Réponse issue du fournisseur.')).toBeTruthy();
    expect(screen.getByTestId('business-message-assistant').textContent).toContain('Réponse générée par l’assistant VYORA');
    expect(screen.getByTestId('business-message-assistant').textContent).not.toContain('gemini');
    expect(screen.getByTestId('business-message-assistant').textContent).not.toContain('verified-gemini-model');
  });

  it('affiche un chargement puis un message factuel — jamais « backend non déployé »', async () => {
    businessMocks.getStatus.mockRejectedValue(new Error('Fonction Business Grow introuvable.'));
    businessMocks.listConversations.mockRejectedValue(new Error('Backend indisponible.'));

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    // Le premier appel est en vol : ce n'est pas une panne.
    expect(screen.getByTestId('business-ai-loading')).toBeTruthy();
    expect(screen.queryByTestId('business-ai-unavailable')).toBeNull();
    expect(await screen.findByText('Business Grow ne répond pas pour le moment', undefined, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByTestId('business-overall-status').textContent).toContain('Backend en attente');
    expect((screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement).disabled).toBe(true);
    // Aucune cause inventée sur le déploiement.
    expect(screen.queryByText(/pas déployée|absent ou injoignable|pas encore installé/i)).toBeNull();
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

  it('transmet le rôle, le mode manuel de routage et affiche le quota Business Grow isolé', async () => {
    businessMocks.getStatus.mockResolvedValue({
      providers: [
        {
          provider_key: 'groq',
          display_name: 'Groq',
          enabled: true,
          status: 'available',
          config_status: 'configured',
          checked_at: '2026-11-09T00:00:00Z',
        },
      ],
    });
    businessMocks.getQuota.mockResolvedValue({
      domain: 'business_grow',
      studio_ugc_untouched: true,
      available_units: 840,
      reserved_units: 0,
      monthly_allowance: 1000,
    });
    businessMocks.sendMessage.mockResolvedValueOnce({
      requestId: 'req-1',
      inputMessageId: 'msg-1',
      status: 'succeeded',
      providerAvailable: true,
      provider: { key: 'groq', model: 'verified-groq-model' },
    });

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByTestId('business-quota-pill')).toBeTruthy();
    expect(screen.getByTestId('business-quota-pill').textContent).toContain('840 unités');

    fireEvent.change(screen.getByLabelText('Rôle de la tâche IA'), { target: { value: 'marketing_campaign' } });
    fireEvent.change(screen.getByLabelText('Mode de routage'), { target: { value: 'manual' } });
    fireEvent.change(await screen.findByLabelText('Service IA manuel'), { target: { value: 'groq' } });
    fireEvent.change(screen.getByLabelText('Votre demande'), { target: { value: 'Lance ma campagne.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));

    await waitFor(() => expect(businessMocks.sendMessage).toHaveBeenCalled());
    const [, , , options] = businessMocks.sendMessage.mock.calls[0];
    expect(options).toMatchObject({
      roleKey: 'marketing_campaign',
      routing: { selectionMode: 'manual', preferredProviderKey: 'groq', allowFallback: false },
    });
  });

  it('affiche les propositions d’outils en attente, gère l’approbation et offre un transfert sans débit vers Studio UGC', async () => {
    const convId = '99999999-9999-4999-8999-999999999999';
    businessMocks.state.conversations = [{
      id: convId, title: 'Campagne', created_at: '2026-11-09', updated_at: '2026-11-09',
    }];
    businessMocks.listTools.mockResolvedValueOnce({
      tools: [{
        id: 'tool-handoff-1',
        conversation_id: convId,
        request_id: 'req-1',
        tool_name: 'handoff_ugc_brief',
        risk_level: 'write_requires_approval',
        status: 'pending_approval',
        input_args: { summary: 'Script UGC produit hydratant', hook: '3 secondes pour briller' },
        output_result: {},
        error_message: null,
        created_at: '2026-11-09',
      }],
    });

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    expect(await screen.findByTestId('business-tool-proposals')).toBeTruthy();
    expect(screen.getByText('Transférer vers Studio UGC')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Ouvrir dans Studio UGC \(sans débit\)/ }).getAttribute('href')).toBe('/app/studio');

    businessMocks.listTools.mockResolvedValueOnce({ tools: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Approuver' }));
    await waitFor(() => expect(businessMocks.resolveTool).toHaveBeenCalledWith('tool-handoff-1', 'approved'));
  });

  it('permet de vérifier un service réel et présente les services en préparation sans les simuler', async () => {
    businessMocks.getStatus.mockResolvedValue({
      providers: [{
        provider_key: 'groq',
        display_name: 'Groq',
        enabled: true,
        status: 'unverified',
        config_status: 'configured',
        checked_at: null,
      }],
    });

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    await screen.findByTestId('business-grow');
    fireEvent.click(screen.getByRole('button', { name: 'Services IA' }));

    expect(screen.getByTestId('adapter-openai').textContent).toContain('Service VYORA à venir');
    expect(screen.getByTestId('adapter-anthropic')).toBeTruthy();
    expect(screen.getByTestId('adapter-deepseek')).toBeTruthy();
    expect(screen.getByTestId('adapter-mistral')).toBeTruthy();

    const groqCard = screen.getByTestId('provider-groq');
    const verifyBtn = groqCard.querySelector('button');
    expect(verifyBtn?.textContent).toContain('Vérifier la connexion');
    if (verifyBtn) fireEvent.click(verifyBtn);

    await waitFor(() => expect(businessMocks.verifyProvider).toHaveBeenCalledWith('groq'));
    expect(await screen.findByText(/Connexion vérifiée avec succès/)).toBeTruthy();
  });

  it('affiche les intégrations sans fausse connexion et propose une demande d’activation', async () => {
    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Intégrations' }));
    expect(await screen.findByTestId('business-integrations')).toBeTruthy();
    const facebook = screen.getByTestId('connector-facebook').textContent ?? '';
    expect(facebook).toContain('Non connecté');
    expect(facebook).toContain('Demander l’activation');
    expect(facebook).not.toContain('Connecté');
    expect(screen.getByTestId('connector-shopify').textContent).toContain('Non connecté');
    expect(screen.getByTestId('connector-woocommerce')).toBeTruthy();
  });

  it('applique le contrat BusinessGrowEntryIntent et permet d’activer le secours auto en routage manuel', async () => {
    businessMocks.getStatus.mockResolvedValue({
      providers: [{
        provider_key: 'groq',
        display_name: 'Groq',
        enabled: true,
        status: 'available',
        config_status: 'configured',
        checked_at: '2026-11-10T00:00:00Z',
      }],
    });
    const intentState = buildBusinessGrowLocationState({
      section: 'chat',
      roleKey: 'action_plan',
      projectTitle: 'Gamme Karité',
      initialDraft: 'Planifie le lancement 30 jours pour Gamme Karité.',
      sourceRoute: '/app/projets/proj-karite',
    });

    render(
      <MemoryRouter initialEntries={[{ pathname: '/app/business', state: intentState }]}>
        <BusinessGrow />
      </MemoryRouter>,
    );

    const banner = await screen.findByTestId('business-entry-intent-banner');
    expect(banner.textContent).toContain('Gamme Karité');
    expect((screen.getByLabelText('Rôle de la tâche IA') as HTMLSelectElement).value).toBe('action_plan');
    expect((screen.getByLabelText('Votre demande') as HTMLTextAreaElement).value).toContain('Gamme Karité');

    fireEvent.change(screen.getByLabelText('Mode de routage'), { target: { value: 'manual' } });
    fireEvent.change(screen.getByLabelText('Service IA manuel'), { target: { value: 'groq' } });
    fireEvent.click(screen.getByLabelText('Autoriser le secours automatique en mode manuel'));
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));

    await waitFor(() => expect(businessMocks.sendMessage).toHaveBeenCalled());
    expect(businessMocks.getRouting.mock.calls.length).toBeGreaterThan(0);
    const options = businessMocks.sendMessage.mock.calls[0][3];
    expect(options).toMatchObject({
      roleKey: 'action_plan',
      routing: { selectionMode: 'manual', preferredProviderKey: 'groq', allowFallback: true },
    });
  });

  it('n’affiche jamais Vérifié sans preuve serveur réelle et masque les détails techniques des erreurs', async () => {
    businessMocks.getStatus.mockResolvedValue({
      providers: [
        {
          provider_key: 'groq',
          display_name: 'Groq',
          enabled: true,
          status: 'available',
          config_status: 'configured',
          checked_at: null,
        },
        {
          provider_key: 'gemini',
          display_name: 'Gemini',
          enabled: true,
          status: 'available',
          config_status: 'configured',
          checked_at: '2026-11-10T18:00:00Z',
          verified_model_keys: ['gemini-2.5-flash'],
        },
      ],
    });
    businessMocks.verifyProvider.mockRejectedValueOnce(
      new BusinessGrowApiError(
        'La vérification réelle du fournisseur groq a échoué (PROVIDER_AUTH_FAILED).',
        'PROVIDER_AUTH_FAILED',
      ),
    );

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    await screen.findByTestId('business-grow');
    expect(screen.getByTestId('business-overall-status').textContent).toContain('1 service(s) IA vérifié(s)');

    fireEvent.click(screen.getByRole('button', { name: 'Services IA' }));

    const groqCard = screen.getByTestId('provider-groq');
    expect(groqCard.textContent).toContain('Configuré · Non vérifié');
    expect(groqCard.textContent).not.toContain('Disponible');

    const geminiCard = screen.getByTestId('provider-gemini');
    expect(geminiCard.textContent).toContain('Vérifié');
    expect(geminiCard.textContent).toContain('Disponibilité confirmée.');
    expect(geminiCard.textContent).not.toContain('gemini');
    expect(geminiCard.textContent).not.toContain('gemini-2.5-flash');

    // La sonde part désormais automatiquement (aucune action manuelle requise).
    await waitFor(() => expect(businessMocks.verifyProvider).toHaveBeenCalledWith('groq'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Impossible de vérifier la connexion au service IA.');
    // Le détail technique reste masqué et l'aide affichée est celle du code réel.
    expect(alert.textContent).toContain('contactez le support VYORA');
    expect(alert.textContent).not.toContain('PROVIDER_AUTH_FAILED');
    expect(alert.textContent).not.toContain('Supabase Edge Functions Secrets');
  });

  it('envoie explicitement selectionMode auto si une règle manuelle sauvegardée existe pour le rôle', async () => {
    businessMocks.getStatus.mockResolvedValue({
      providers: [{
        provider_key: 'groq',
        display_name: 'Groq',
        enabled: true,
        status: 'available',
        config_status: 'configured',
        checked_at: '2026-11-10T18:00:00Z',
      }],
    });
    savedPreferences.current = [{
      role_key: 'business_advisor',
      selection_mode: 'manual',
      preferred_provider_key: 'gemini',
      preferred_model_key: 'gemini-2.5-flash',
      allow_fallback: false,
    }];
    businessMocks.sendMessage.mockResolvedValueOnce({
      requestId: 'req-auto-override',
      inputMessageId: 'msg-auto-override',
      status: 'succeeded',
      providerAvailable: true,
      provider: { key: 'groq', model: 'openai/gpt-oss-120b' },
    });

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    await screen.findByTestId('business-grow');

    // Attendre que la préférence de routage sauvegardée soit réellement chargée :
    // l'envoi doit refléter l'état serveur, pas une course avec son chargement.
    fireEvent.click(screen.getByRole('button', { name: /Services IA/ }));
    expect(await screen.findByTestId('saved-routing-rules')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Assistant/ }));

    fireEvent.change(screen.getByLabelText('Votre demande'), { target: { value: 'Priorités du mois.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));

    await waitFor(() => expect(businessMocks.sendMessage).toHaveBeenCalled());
    const options = businessMocks.sendMessage.mock.calls[0][3];
    expect(options).toMatchObject({
      roleKey: 'business_advisor',
      routing: { selectionMode: 'auto', allowFallback: true },
    });
  });
});
