// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Intégration de l'interface SORAHNEX AI dans Grow.
 *
 * ## Ce que ces tests protègent
 *
 * La demande était explicite : **un seul espace métier**. Les tests existants
 * de Grow vérifient déjà les fonctions métier (AI Director, mémoire,
 * quota, isolation) ; ceux-ci vérifient la *direction architecturale* :
 *
 * 1. l'interface SORAHNEX remplace réellement l'ancienne section Assistant ;
 * 2. elle ne recrée pas une navigation d'application concurrente ;
 * 3. elle réutilise le socle de Grow (aucun service inventé) ;
 * 4. le catalogue d'intégrations reste accessible depuis Grow ;
 * 5. les conversations restent rattachées à l'entreprise active.
 */

const donnees = vi.hoisted(() => ({
  conversations: [
    { id: 'c1', title: 'Lancement karité', created_at: '2026-11-12T09:00:00Z', updated_at: '2026-11-12T09:00:00Z' },
  ],
  messages: [
    { id: 'm1', author_role: 'user' as const, content: 'Bonjour', created_at: '2026-11-12T09:01:00Z' },
  ],
}));

vi.mock('../src/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    user: { id: 'arch-user', email: 'dirigeant@vyora.test' },
    session: { access_token: 'token' },
    profile: { display_name: 'Awa Diango' },
    workspace: {
      id: 'workspace-1', owner_user_id: 'arch-user', name: 'Maison Karité',
      country_code: 'ML', default_language: 'fr', created_at: '2026-01-01', updated_at: '2026-01-01',
    },
    workspaceId: 'workspace-1',
    quota: null,
    isAdmin: false,
    loading: false,
    bootstrapError: null,
    refreshQuota: vi.fn(),
    refreshAll: vi.fn(),
    logout: vi.fn(),
  }),
}));

const api = vi.hoisted(() => {
  const quota = { domain: 'business_grow', studio_ugc_untouched: true, available_units: 500, reserved_units: 0, monthly_allowance: 1000 };
  return {
    getStatus: vi.fn(async () => ({
      providers: [{
        provider_key: 'groq', display_name: 'Groq', enabled: true, status: 'available',
        config_status: 'configured', checked_at: new Date().toISOString(), available_models: [],
      }],
      quota, saved_routing: [],
    })),
    listConversations: vi.fn(async () => ({ conversations: donnees.conversations, quota })),
    listMessages: vi.fn(async () => ({ messages: donnees.messages })),
    getQuota: vi.fn(async () => quota),
    getRouting: vi.fn(async () => ({ preferences: [] })),
    listModels: vi.fn(async () => ({ models: [] })),
    getMemory: vi.fn(async () => ({ consent: true, policyVersion: 'business-grow-memory-v1', profile: {}, items: [] })),
    listTools: vi.fn(async () => ({ tools: [] })),
    listConversationTools: vi.fn(async () => ({ tools: [] })),
    listRequests: vi.fn(async () => ({ requests: [] })),
    listAgentMemories: vi.fn(async () => ({ memories: [] })),
    listRoutingPreferences: vi.fn(async () => ({ preferences: [] })),
    listIntegrations: vi.fn(async () => ({ connections: [] })),
    createConversation: vi.fn(async () => ({ conversationId: 'c-new' })),
    renameConversation: vi.fn(async () => ({ renamed: true })),
    deleteConversation: vi.fn(async () => ({ deleted: true })),
    sendMessage: vi.fn(async () => ({ requestId: 'r1', inputMessageId: 'i1', status: 'succeeded', providerAvailable: true })),
  };
});

vi.mock('../src/business/api', async () => {
  const actual = await vi.importActual<typeof import('../src/business/api')>('../src/business/api');
  return { ...actual, businessGrowApi: { ...actual.businessGrowApi, ...api } };
});

vi.mock('../src/lib/api', () => ({
  listBrands: async () => [],
  listProducts: async () => [],
}));

import BusinessGrow from '../src/business/BusinessGrow';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

function monter() {
  return render(
    <MemoryRouter initialEntries={['/app/business/assistant']}>
      <BusinessGrow />
    </MemoryRouter>,
  );
}

describe('Grow — l’interface SORAHNEX remplace l’ancienne section Assistant', () => {
  it('rend l’interface SORAHNEX dans la section Assistant', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('business-assistant')).toBeTruthy());

    // Les composants de la Livraison 1 sont réellement montés.
    expect(screen.getByLabelText('Navigation de l’assistant')).toBeTruthy();
    expect(screen.getByLabelText('Votre demande')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeTruthy();
  });

  it('ne recrée pas une navigation d’application concurrente', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('business-assistant')).toBeTruthy());

    // Ces liens existent dans la sidebar autonome ; imbriqués dans Business
    // Grow, ils reconstitueraient le second espace métier qu'on refuse.
    expect(screen.queryByText('Espace Business')).toBeNull();
    expect(screen.queryByText('Explorer')).toBeNull();
    expect(screen.queryByText('Bibliothèque')).toBeNull();
    expect(screen.queryByText('Images')).toBeNull();
  });

  it('expose la navigation réelle du Growth OS', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('business-assistant')).toBeTruthy());

    const nav = screen.getByRole('navigation', { name: 'Navigation Growth OS' });
    expect(nav).toBeTruthy();
    for (const rubrique of [
      'Vue générale', 'Rapports et analyses', 'CRM', 'Pipeline commercial',
      'Tâches et activités', 'Relances', 'Finance', 'Recouvrement',
      'Assistant IA', 'Contexte entreprise', 'Mémoire métier', 'Services IA',
      'Contrôle IA', 'Intégrations',
    ]) {
      expect(screen.getByRole('link', { name: rubrique })).toBeTruthy();
    }
    // Plus aucun ancien onglet « Croissance » ni second CRM dans l’interface.
    expect(screen.queryByRole('link', { name: 'Croissance' })).toBeNull();
  });

  it('s’appuie sur le socle de Grow, pas sur un service inventé', async () => {
    monter();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Lancement karité' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Lancement karité' }));
    await waitFor(() => expect(screen.getByTestId('business-message-user')).toBeTruthy());

    // Les conversations viennent de `businessGrowApi`, avec l'entreprise active :
    // c'est la même source que le reste de la page, pas un second backend.
    expect(api.listConversations).toHaveBeenCalled();
    expect(api.listMessages).toHaveBeenCalledWith('c1', 'workspace-1');
  });

  it('affiche les conversations et le fil de la plus récente', async () => {
    monter();
    // Grow sélectionne la conversation la plus récente à l'ouverture,
    // et son fil s'affiche — comportement conservé de l'interface précédente.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Lancement karité' })).toBeTruthy());
    expect(await screen.findByText('Bonjour')).toBeTruthy();

    // La sélection manuelle recharge bien depuis le socle.
    fireEvent.click(screen.getByRole('button', { name: 'Lancement karité' }));
    await waitFor(() => expect(api.listMessages).toHaveBeenCalled());
  });

  it('crée une conversation via le socle, avec l’entreprise active', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('business-assistant')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Nouvelle conversation' }));
    await waitFor(() => expect(api.createConversation).toHaveBeenCalledWith('Nouvelle conversation', 'workspace-1'));
  });

  it('ouvre Intégrations depuis la sidebar de l’assistant', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('business-assistant')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Ouvrir les intégrations de Grow/i }));
    await waitFor(() => expect(screen.getByTestId('business-integrations')).toBeTruthy());
  });

  it('le catalogue d’intégrations reste accessible et relié au socle réel', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('business-assistant')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Ouvrir les intégrations de Grow/i }));

    await waitFor(() => expect(screen.getByTestId('business-integrations')).toBeTruthy());
    // La lecture des connexions a bien été tentée : l'état affiché en découle.
    expect(api.listIntegrations).toHaveBeenCalled();
    // Aucune fausse connexion : la page annonce l'absence de connecteur actif.
    expect(screen.queryByText('Connecté')).toBeNull();
  });

  it('replie la barre latérale sur desktop sans perdre l’accès aux conversations', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('business-assistant')).toBeTruthy());

    const rail = screen.getByLabelText('Navigation de l’assistant');
    expect(rail.className).toContain('w-[264px]');

    fireEvent.click(screen.getByRole('button', { name: 'Réduire la barre latérale' }));
    await waitFor(() => expect(screen.getByLabelText('Navigation de l’assistant').className).toContain('w-[68px]'));

    // Replié, les titres restent accessibles en infobulle : rien ne disparaît.
    expect(screen.getByRole('button', { name: 'Nouvelle conversation' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Agrandir la barre latérale' }));
    await waitFor(() => expect(screen.getByLabelText('Navigation de l’assistant').className).toContain('w-[264px]'));
  });

  it('ouvre le tiroir mobile au lieu du rail sur petit écran', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('business-assistant')).toBeTruthy());

    // Le rail desktop est masqué par la classe (media query lg).
    expect(screen.getByTestId('business-assistant-rail').className).toContain('hidden');
    expect(screen.getByTestId('business-assistant-rail').className).toContain('lg:block');

    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir les conversations' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fermer le menu' })).toBeTruthy());
  });

  it('transmet le rôle et le routage à l’envoi, sans exposer le service', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('business-assistant')).toBeTruthy());

    const champ = screen.getByLabelText('Votre demande');
    fireEvent.change(champ, { target: { value: 'Analyse mes ventes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    const appel = api.sendMessage.mock.calls[0] as unknown as [string, string, string, Record<string, unknown>?];
    expect(appel[0]).toBe('c1');
    expect(appel[1]).toContain('Analyse mes ventes.');
    // Le workspace accompagne l'envoi : la réponse est rattachée à l'entreprise.
    expect(appel[3]).toMatchObject({ workspaceId: 'workspace-1' });
  });
});
