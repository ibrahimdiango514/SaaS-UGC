// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/context/ToastContext';
import type { BusinessMemory } from '../src/business/api';

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    listProducts: async () => [],
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    deleteProduct: vi.fn(),
  };
});

vi.mock('../src/business/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/business/api')>();
  return {
    ...actual,
    businessGrowApi: {
      ...actual.businessGrowApi,
      putMemoryItem: vi.fn(async () => ({ itemId: 'new-id' })),
      deleteMemoryItem: vi.fn(async () => ({ deleted: true })),
      saveMemoryProfile: vi.fn(async () => ({ saved: true })),
      setMemoryConsent: vi.fn(async () => ({ event_id: 1, occurred_at: new Date().toISOString() })),
    },
  };
});

import GrowthWorkspace from '../src/business/growth/GrowthWorkspace';

const memory: BusinessMemory = {
  consent: true,
  policyVersion: 'v1',
  profile: { legalName: 'Maison Nala', market: 'Bamako' },
  items: [
    {
      id: 'goal-1', category: 'growth_goal', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
      content: { title: 'Atteindre 100 clientes', metric: 'clientes', target: 100, current: 40, unit: 'clientes', priority: 'haute', status: 'en_cours' },
    },
    {
      id: 'prospect-1', category: 'growth_prospect', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
      content: { name: 'Awa Traoré', company: 'Boutique Awa', stage: 'proposition', value: 25000, currency: 'XOF', nextAction: 'Envoyer le devis', nextActionAt: '2026-11-20' },
    },
    {
      id: 'competitor-1', category: 'growth_competitor', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
      content: { name: 'Concurrent X', positioning: 'Prix bas' },
    },
  ],
};

function renderGrowth(overrides: Partial<BusinessMemory> = {}) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <GrowthWorkspace
          workspace={{ id: 'ws-1', name: 'Espace Nala' } as never}
          workspaceId="ws-1"
          memory={{ ...memory, ...overrides }}
          loadingMemory={false}
          memoryError={null}
          onReloadMemory={async () => undefined}
          onOpenAssistant={() => undefined}
        />
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe('Growth OS — interface réelle', () => {
  it('affiche les indicateurs calculés à partir des enregistrements réels', () => {
    renderGrowth();
    expect(screen.getByTestId('growth-os')).toBeTruthy();
    expect(screen.getByText('Objectifs en cours')).toBeTruthy();
    expect(screen.getByText('Atteindre 100 clientes')).toBeTruthy();
    expect(screen.getByText('Envoyer le devis')).toBeTruthy();
    expect(screen.getAllByText(/25/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Créer dans le Studio/ }).getAttribute('href')).toBe('/app/studio');
  });

  it('navigue vers les objectifs et les prospects sans bouton décoratif', async () => {
    renderGrowth();
    fireEvent.click(screen.getByRole('button', { name: /Objectifs/ }));
    await waitFor(() => expect(screen.getByTestId('growth-goals')).toBeTruthy());
    expect(screen.getByText(/Atteindre 100 clientes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Prospects/ }));
    await waitFor(() => expect(screen.getByTestId('growth-crm')).toBeTruthy());
    expect(screen.getByText('Awa Traoré')).toBeTruthy();
  });

  it('affiche les concurrents réellement enregistrés', async () => {
    renderGrowth();
    fireEvent.click(screen.getByRole('button', { name: /Marché/ }));
    await waitFor(() => expect(screen.getByTestId('growth-market')).toBeTruthy());
    expect(screen.getByText('Concurrent X')).toBeTruthy();
  });

  it('demande le consentement quand la mémoire est désactivée', () => {
    renderGrowth({ consent: false, items: [], profile: null });
    expect(screen.getByText('Mémoire métier requise')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Activer la mémoire métier/ })).toBeTruthy();
  });

  it('affiche un état vide honnête quand aucun objectif n’existe', () => {
    renderGrowth({ items: [], profile: null });
    expect(screen.getByText('Aucun objectif défini')).toBeTruthy();
    expect(screen.getByText(/Aucune relance planifiée/)).toBeTruthy();
  });

  it('affiche l’historique réel des enregistrements métier', async () => {
    renderGrowth();
    fireEvent.click(screen.getByRole('button', { name: /Historique/ }));
    await waitFor(() => expect(screen.getByTestId('growth-activity')).toBeTruthy());
    expect(screen.getByText('Atteindre 100 clientes')).toBeTruthy();
    expect(screen.getByText('Awa Traoré')).toBeTruthy();
  });

  it('affiche les paramètres, le consentement et les accès réels', async () => {
    renderGrowth();
    fireEvent.click(screen.getByRole('button', { name: /Paramètres/ }));
    await waitFor(() => expect(screen.getByTestId('growth-settings')).toBeTruthy());
    expect(screen.getByText('Version de politique : v1')).toBeTruthy();
    expect(screen.getByText('Espace Nala')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Désactiver la mémoire/ })).toBeTruthy();
  });

  it('ouvre le formulaire d’entreprise et bloque l’enregistrement sans activité', async () => {
    renderGrowth();
    fireEvent.click(screen.getByRole('button', { name: /Entreprise/ }));
    await waitFor(() => expect(screen.getByTestId('growth-company')).toBeTruthy());
    expect(screen.getByDisplayValue('Maison Nala')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer l’entreprise/ }));
    await waitFor(() => expect(screen.getByText(/Renseignez au moins l’activité principale/)).toBeTruthy());
  });
});
