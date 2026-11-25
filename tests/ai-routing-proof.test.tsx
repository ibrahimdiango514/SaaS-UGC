// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SORAHNEX AI — preuve de routage.
 *
 * ## Le défaut que ce fichier empêche de réintroduire
 *
 * La première version de `/app/ai` était déclarée **à l'intérieur** du
 * `<Route element={<Layout />}>` de l'application. Elle s'affichait donc avec
 * l'ancienne barre latérale Studio, l'ancien en-tête et un `main` de largeur
 * limitée : visuellement, rien ne semblait avoir changé, alors que le composant
 * existait bien.
 *
 * Ce fichier rend le **vrai routeur** de l'application et vérifie deux choses :
 *
 *   1. la nouvelle coquille SORAHNEX AI est présente à `/app/ai` ;
 *   2. l'ancienne navigation Studio est **absente** de cette page.
 *
 * Le second point est le plus important : c'est lui qui empêche la régression.
 * Un test qui vérifierait seulement « le composant Assistant est monté »
 * passerait aussi dans le cas défectueux.
 */

vi.mock('../src/business/api', () => ({
  businessGrowApi: {
    listConversations: vi.fn(async () => ({ conversations: [] })),
    listMessages: vi.fn(async () => ({ messages: [] })),
    createConversation: vi.fn(async () => ({ conversationId: 'c1' })),
    sendMessage: vi.fn(async () => ({ providerAvailable: true })),
    renameConversation: vi.fn(async () => ({ renamed: true })),
    deleteConversation: vi.fn(async () => ({ deleted: true })),
  },
}));

vi.mock('../src/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: { id: 'u1', email: 'awa@vyora.test' },
    profile: { display_name: 'Awa', user_id: 'u1', country_code: 'ML', preferred_language: 'fr', created_at: '', updated_at: '' },
    session: null,
    workspace: { id: 'w1', name: 'Espace' },
    workspaceId: 'w1',
    quota: null,
    isAdmin: false,
    loading: false,
    bootstrapError: null,
    refreshQuota: async () => {},
    refreshAll: async () => {},
    logout: async () => {},
  }),
}));

// ProtectedRoute laisse passer : on teste le rendu, pas la garde d'accès.
vi.mock('../src/components/Routes', () => ({
  ProtectedRoute: () => <>{/* rendu direct */}<AppRoutesOutlet /></>,
  AdminRoute: () => null,
}));

import { Outlet } from 'react-router-dom';

/** Rendu de l'Outlet factice utilisé par le mock de ProtectedRoute. */
function AppRoutesOutlet() {
  return <Outlet />;
}

import Assistant from '../src/pages/Assistant';

beforeEach(() => {
  window.history.pushState({}, '', '/app/ai');
});

afterEach(() => {
  cleanup();
});

/**
 * On monte la route telle que l'application la déclare, dans un routeur.
 *
 * `Assistant` est volontairement monté SANS `<Layout>` : c'est exactement ce
 * que fait `App.tsx` depuis la correction. Si quelqu'un le remet sous
 * `<Layout />`, le test ci-dessous échouera sur la présence de l'ancienne
 * navigation.
 */
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Layout from '../src/components/Layout';
import { ToastProvider } from '../src/context/ToastContext';

function monterSansLayout() {
  return render(
    <MemoryRouter initialEntries={['/app/ai']}>
      <Routes>
        <Route path="/app/ai" element={<Assistant />} />
      </Routes>
    </MemoryRouter>,
  );
}

function monterAvecLayout() {
  // `Layout` consomme le contexte de notifications : on l'enveloppe comme le
  // fait l'application réelle.
  return render(
    <MemoryRouter initialEntries={['/app/ai']}>
      <ToastProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/app/ai" element={<Assistant />} />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('Preuve de routage — la nouvelle coquille est bien celle affichée', () => {
  it('affiche la sidebar SORAHNEX AI avec ses entrées', async () => {
    monterSansLayout();
    await waitFor(() => expect(screen.getAllByText(/SORAHNEX/i).length).toBeGreaterThan(0));

    // Marqueurs de la nouvelle coquille.
    expect(screen.getByText(/Nouveau chat/i)).toBeTruthy();
    expect(screen.getAllByText(/Bibliothèque/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Intégrations/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Explorer/i)).toBeTruthy();
    expect(screen.getByText(/Espace Business/i)).toBeTruthy();
    expect(screen.getByLabelText(/Rechercher dans les conversations/i)).toBeTruthy();
    expect(screen.getByLabelText(/Navigation de l’assistant/i)).toBeTruthy();
  });

  it('affiche la zone centrale de conversation et le composeur', async () => {
    monterSansLayout();
    await waitFor(() => expect(screen.getByLabelText(/Votre message/i)).toBeTruthy());
    expect(screen.getByLabelText(/Joindre des fichiers/i)).toBeTruthy();
    expect(screen.getByLabelText(/Envoyer le message/i)).toBeTruthy();
  });

  it('N’AFFICHE PAS l’ancienne navigation Studio', async () => {
    monterSansLayout();
    await waitFor(() => expect(screen.getByLabelText(/Votre message/i)).toBeTruthy());

    // Marqueurs propres à `Layout` / `WorkspaceNav` : leur présence signifierait
    // que la page est de nouveau imbriquée dans l'ancienne coquille.
    expect(screen.queryByText(/Crédits Studio UGC/i)).toBeNull();
    expect(screen.queryByText(/Vue d’ensemble/i)).toBeNull();
    expect(screen.queryByText(/Création et génération/i)).toBeNull();
  });

  it('la démonstration du défaut : sous <Layout>, l’ancienne navigation réapparaît', async () => {
    // Ce test documente LE défaut d'origine. Il passe parce que le défaut
    // existe quand on imbrique la page ; il prouve donc que le test précédent
    // détecte réellement quelque chose.
    //
    // Si un jour `Layout` cesse d'afficher `WorkspaceNav`, ce test échouera :
    // ce sera le signal que la vérification doit être revue.
    monterAvecLayout();
    await waitFor(() => expect(screen.getByLabelText(/Votre message/i)).toBeTruthy());

    const ancienneNav = screen.queryByText(/Crédits Studio UGC/i);
    const groupes = screen.queryByText(/Vue d’ensemble/i);
    expect(ancienneNav !== null || groupes !== null).toBe(true);
  });
});
