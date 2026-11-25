// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import type { ReactNode } from 'react';

/**
 * Preuve de rendu — SORAHNEX Grow, section Assistant.
 *
 * ## Pourquoi ce fichier existe
 *
 * Un test « route HTTP 200 » ou un build réussi ne prouve rien sur ce que voit
 * l'utilisateur. Ici, on monte le VRAI composant `BusinessGrow` (route
 * `/app/business`), avec son routeur et un socle mocké qui répond comme l'API,
 * puis on écrit le DOM obtenu dans `artifacts/business-grow-assistant.html`.
 * Ce fichier s'ouvre dans un navigateur : c'est une capture du rendu réel, pas
 * une affirmation.
 *
 * ## Limite assumée
 *
 * Aucun binaire Chrome n'est disponible ici (le cache Puppeteer est vide et le
 * téléchargement sort du réseau autorisé). Ce n'est donc pas une capture
 * d'écran. Le DOM reste fidèle : c'est exactement le balisage produit par
 * React, avec les classes de style de l'application.
 */

const donnees = vi.hoisted(() => ({
  conversations: [
    { id: 'c1', title: 'Lancement gamme karité', created_at: '2026-11-12T09:00:00Z', updated_at: '2026-11-12T09:00:00Z', last_message: 'Plan de lancement sur 30 jours' },
    { id: 'c2', title: 'Relance des paniers', created_at: '2026-11-10T09:00:00Z', updated_at: '2026-11-10T09:00:00Z', last_message: 'Trois segments identifiés' },
  ],
  messages: [
    {
      id: 'm1',
      author_role: 'user' as const,
      content: 'Quelles actions pour relancer les paniers abandonnés ce mois-ci ?',
      created_at: '2026-11-12T09:01:00Z',
    },
    {
      id: 'm2',
      author_role: 'assistant' as const,
      content: 'Trois leviers ressortent des données disponibles :\n\n- **Relance J+1** sur les paniers de plus de 40 000 FCFA\n- **Message personnalisé** par catégorie de produit\n- **Offre de livraison** sur la zone de Bamako\n\nLes données de commandes manquent pour chiffrer le gain attendu.',
      created_at: '2026-11-12T09:02:00Z',
      request_status: 'succeeded' as const,
      request_provider_key: 'groq',
      request_model_key: 'model-x',
    },
  ],
}));

const authMocks = vi.hoisted(() => ({
  workspace: {
    id: 'workspace-1',
    owner_user_id: 'preuve-rendu-user',
    name: 'Maison Karité',
    country_code: 'ML',
    default_language: 'fr',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  },
}));

vi.mock('../src/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    user: { id: 'preuve-rendu-user', email: 'awa@maison-karite.ml' },
    session: { access_token: 'test-token' },
    profile: { display_name: 'Awa Diango' },
    workspace: authMocks.workspace,
    workspaceId: authMocks.workspace.id,
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
  const quota = { domain: 'business_grow', studio_ugc_untouched: true, available_units: 840, reserved_units: 0, monthly_allowance: 1200 };
  return {
    getStatus: vi.fn(async () => ({
      providers: [{
        provider_key: 'groq',
        display_name: 'Groq',
        enabled: true,
        status: 'available',
        config_status: 'configured',
        checked_at: new Date().toISOString(),
        latency_ms: 42,
        available_models: ['model-x'],
      }],
      quota,
      saved_routing: [],
    })),
    listConversations: vi.fn(async () => ({ conversations: donnees.conversations, quota })),
    listMessages: vi.fn(async () => ({ messages: donnees.messages })),
    getMemory: vi.fn(async () => ({ consent: true, policyVersion: 'business-grow-memory-v1', profile: {}, items: [] })),
    listTools: vi.fn(async () => ({ tools: [] })),
    listConversationTools: vi.fn(async () => ({ tools: [] })),
    listRequests: vi.fn(async () => ({ requests: [] })),
    listAgentMemories: vi.fn(async () => ({ memories: [] })),
    listRoutingPreferences: vi.fn(async () => ({ preferences: [] })),
    listIntegrations: vi.fn(async () => ({ connections: [] })),
    // Le quota vient d'un appel dédié, pas de la réponse de statut.
    getQuota: vi.fn(async () => quota),
    getRouting: vi.fn(async () => ({ preferences: [] })),
    listModels: vi.fn(async () => ({ models: [] })),
    createConversation: vi.fn(async () => ({ conversationId: 'c9' })),
    renameConversation: vi.fn(async () => ({ renamed: true })),
    deleteConversation: vi.fn(async () => ({ deleted: true })),
    sendMessage: vi.fn(async () => ({ requestId: 'r1', inputMessageId: 'i1', status: 'succeeded', providerAvailable: true })),
  };
});

vi.mock('../src/business/api', async () => {
  const actual = await vi.importActual<typeof import('../src/business/api')>('../src/business/api');
  return {
    ...actual,
    businessGrowApi: { ...actual.businessGrowApi, ...api },
  };
});

vi.mock('../src/lib/api', () => ({
  listBrands: async () => [{ id: 'b1', name: 'Maison Karité', workspace_id: 'workspace-1' }],
  listProducts: async () => [],
}));

import BusinessGrow from '../src/business/BusinessGrow';
import { businessGrowApi } from '../src/business/api';

const STYLES = `
  body { margin:0; background:#05080e; color:#e2e8f0; font-family: ui-sans-serif, system-ui, sans-serif; line-height:1.5; }
  .wrap { max-width: 1400px; margin: 0 auto; padding: 24px; }
  .note { font-size: 12px; color:#94a3b8; border-left:2px solid #a78bfa; padding-left:12px; margin-bottom:20px; }
  code { color:#c4b5fd; }
`;

describe('preuve de rendu — SORAHNEX Grow', () => {
  it('monte la vraie page et produit un DOM vérifiable', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/app/business/assistant']}>
        <BusinessGrow />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('business-assistant')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('business-message-assistant')).toBeTruthy());

    // 1. L'interface SORAHNEX est bien celle qui est rendue.
    expect(screen.getByTestId('business-assistant')).toBeTruthy();
    expect(screen.getByLabelText('Navigation de l’assistant')).toBeTruthy();

    // 2. L'ancienne navigation d'espace n'est PAS recréée dans l'assistant.
    expect(screen.queryByText('Espace Business')).toBeNull();
    expect(screen.queryByText('Explorer')).toBeNull();

    // 3. La navigation réelle du Growth OS remplace l'ancien cockpit.
    expect(screen.getByRole('navigation', { name: 'Navigation SORAHNEX Grow' })).toBeTruthy();
    for (const section of ['Vue générale', 'CRM', 'Pipeline commercial', 'Finance', 'Recouvrement', 'Assistant IA', 'Mémoire métier', 'Services IA', 'Contrôle IA', 'Intégrations']) {
      expect(screen.getByRole('link', { name: section })).toBeTruthy();
    }
    expect(screen.queryByRole('link', { name: 'Croissance' })).toBeNull();

    // 4. AI Director et quota conservés.
    expect(screen.getByLabelText('Rôle de la tâche IA')).toBeTruthy();
    expect(screen.getByTestId('business-quota-pill').textContent).toContain('840');

    // 5. Conversations et message persistés affichés.
    expect(screen.getByRole('button', { name: 'Lancement gamme karité' })).toBeTruthy();
    expect(screen.getByTestId('business-message-assistant').textContent).toContain('Relance J+1');

    // 6. Vocabulaire métier du composeur.
    expect(screen.getByLabelText('Votre demande')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeTruthy();

    // Le statut de traitement ne doit pas exposer le fournisseur.
    expect(screen.getByTestId('business-message-assistant').textContent).not.toContain('groq');

    // Le CSS Tailwind compilé est inliné dans l'artefact : ouvert dans un
    // navigateur, le fichier rend alors la vraie mise en page, pas du texte
    // brut. Sans build préalable, on garde la structure sans styles.
    const dossierCss = 'dist/assets';
    const css = existsSync(dossierCss)
      ? readdirSync(dossierCss).filter((f) => f.endsWith('.css')).map((f) => readFileSync(`${dossierCss}/${f}`, 'utf8')).join('\n')
      : '';

    mkdirSync('artifacts', { recursive: true });
    const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>SORAHNEX — SORAHNEX Grow, section Assistant (preuve de rendu)</title>
<style>${css}</style>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <div class="note">
    <strong>Preuve de rendu</strong> — DOM produit par le vrai composant <code>BusinessGrow</code>
    (route <code>/app/business/assistant</code>), socle mocké répondant comme l'API.
    Généré par <code>tests/business-grow-rendu.test.tsx</code>.
    Ce n'est pas une capture d'écran : aucun binaire navigateur n'est disponible dans cet environnement.
  </div>
  ${container.innerHTML}
</div>
</body>
</html>`;
    writeFileSync('artifacts/business-grow-assistant.html', html, 'utf8');

    expect(html).toContain('Navigation de l’assistant');
    expect(html).toContain('business-assistant');
    expect(html.length).toBeGreaterThan(5000);

    // La page a réellement interrogé le socle : ce n'est pas un rendu statique.
    expect(businessGrowApi.listConversations).toHaveBeenCalled();
    expect(businessGrowApi.getStatus).toHaveBeenCalled();
  });
});
