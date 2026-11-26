// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AGENT_SPACE_NAV, agentSectionFromPath } from '../src/agent/agentSpace';

/**
 * BLOC D — espace Agent IA : dédié, avec sa propre navigation, réservé aux
 * abonnés SORAHNEX Grow, et sans aucune donnée chargée quand l'accès est refusé.
 *
 * ## Ce que ces tests protègent
 * 1. **Le placement** : l'agent n'est pas une rubrique de Grow. Il a ses propres
 *    routes, toutes réelles.
 * 2. **L'accès** : sans abonnement Grow actif, l'espace s'affiche verrouillé et
 *    ne charge RIEN (ni conversations, ni journal).
 * 3. **Le refus vient du serveur** : la règle n'est pas réécrite côté client ;
 *    on lit `vyora_import_connect_access`. Un test qui passerait sans appeler
 *    ce contrôle ne prouverait pas le refus.
 */

const mocks = vi.hoisted(() => ({
  loadImportAccess: vi.fn(),
  journalRecent: vi.fn(),
  listConversations: vi.fn(),
}));

vi.mock('../src/business/import-connect/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/business/import-connect/access')>();
  return { ...actual, loadImportAccess: mocks.loadImportAccess };
});
vi.mock('../src/business/agent/socle/journal', () => ({
  journalRecent: mocks.journalRecent,
  marquerAnnulee: vi.fn(),
  peutAnnuler: () => false,
}));
vi.mock('../src/business/agent/journalApi', () => ({
  changerStatutEntree: vi.fn(),
  lireJournal: vi.fn(async () => ({ entrees: [], brut: 0, mode: 'dedie' })),
  retirerEnregistrement: vi.fn(),
}));
vi.mock('../src/ai/BusinessAssistant', () => ({
  BusinessAssistant: () => <div data-testid="business-assistant-mock">chat</div>,
}));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ workspaceId: 'ws-1', workspace: { id: 'ws-1', name: 'Maison Karité' }, user: null }),
}));

import { AgentSpace } from '../src/agent/AgentSpace';

const ACCES_OK = {
  allowed: true, reason: 'OK', message: 'Actif', status: 'active', planKey: 'growth',
  currentPeriodEnd: '2026-12-31T00:00:00.000Z', checkedAt: '2026-11-26T00:00:00.000Z', unknown: false,
};

beforeEach(() => {
  mocks.loadImportAccess.mockReset().mockResolvedValue(ACCES_OK);
  mocks.journalRecent.mockReset();
  mocks.journalRecent.mockImplementation((entrees: unknown[]) => entrees);
  mocks.listConversations.mockReset().mockResolvedValue([]);
});
afterEach(cleanup);

function monter(route = '/app/agent/conversation') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AgentSpace />
    </MemoryRouter>,
  );
}

describe('Espace Agent IA — routes réelles', () => {
  it('résout chaque section depuis l’URL, et retombe sur la conversation', () => {
    expect(agentSectionFromPath('/app/agent')).toBe('conversation');
    expect(agentSectionFromPath('/app/agent/')).toBe('conversation');
    expect(agentSectionFromPath('/app/agent/conversation')).toBe('conversation');
    expect(agentSectionFromPath('/app/agent/historique')).toBe('historique');
    expect(agentSectionFromPath('/app/agent/capacites')).toBe('capacites');
    // Toute URL inconnue retombe sur un écran existant, jamais sur du vide.
    expect(agentSectionFromPath('/app/agent/inconnu')).toBe('conversation');
  });

  it('déclare trois sections, chacune avec un chemin réel', () => {
    expect(AGENT_SPACE_NAV.length).toBe(3);
    for (const item of AGENT_SPACE_NAV) {
      expect(item.path.startsWith('/app/agent/')).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(10);
    }
  });
});

describe('Espace Agent IA — abonnement Grow requis', () => {
  it('affiche l’espace complet quand le serveur accorde l’accès', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('agent-space')).toBeTruthy());
    expect(screen.queryByTestId('agent-space-locked')).toBeNull();
    expect(mocks.loadImportAccess).toHaveBeenCalledTimes(1);
  });

  it('verrouille sans abonnement, et ne charge AUCUNE donnée de l’agent', async () => {
    mocks.loadImportAccess.mockResolvedValue({
      allowed: false, reason: 'NO_SUBSCRIPTION', message: 'Abonnement requis.',
      status: null, planKey: null, currentPeriodEnd: null, checkedAt: null, unknown: false,
    });
    monter();

    await waitFor(() => expect(screen.getByTestId('agent-space-locked')).toBeTruthy());
    // Le point central : rien n'a été lu dans Grow.
    expect(mocks.journalRecent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('business-assistant-mock')).toBeNull();
    // L'écran dit ce qu'il permet, et mène aux formules.
    const verrou = screen.getByTestId('agent-space-locked');
    expect(verrou.textContent).toContain('Abonnement SORAHNEX Grow requis');
    expect(verrou.textContent).toContain('Lire vos données Grow');
    expect(screen.getByRole('link', { name: /Voir les formules Grow/ }).getAttribute('href'))
      .toBe('/app/business/abonnement');
  });

  it('distingue un paiement en échec d’une simple absence d’abonnement', async () => {
    mocks.loadImportAccess.mockResolvedValue({
      allowed: false, reason: 'PAYMENT_FAILED', message: 'Paiement en échec.',
      status: 'past_due', planKey: 'growth', currentPeriodEnd: null, checkedAt: null, unknown: false,
    });
    monter();
    await waitFor(() => expect(screen.getByTestId('agent-space-locked')).toBeTruthy());
    // Le motif AFFICHÉ est celui du serveur, pas un « accès refusé » générique.
    expect(screen.getByTestId('agent-space-locked').textContent).toContain('Paiement de l’abonnement en échec');
  });

  it('échoue fermé quand la vérification elle-même échoue', async () => {
    // `loadImportAccess` renvoie un état `unknown` : on n'accorde rien.
    mocks.loadImportAccess.mockResolvedValue({
      allowed: false, reason: 'UNKNOWN', message: 'Vérification impossible.',
      status: null, planKey: null, currentPeriodEnd: null, checkedAt: null, unknown: true,
    });
    monter();
    await waitFor(() => expect(screen.getByTestId('agent-space-locked')).toBeTruthy());
    expect(screen.getByTestId('agent-space-locked').textContent).toContain('Vérification de l’abonnement indisponible');
    // Un doute n'est jamais une autorisation, et ne propose pas de souscrire
    // à tort : on ne sait pas si l'abonnement existe.
    expect(screen.queryByRole('link', { name: /Voir les formules Grow/ })).toBeNull();
  });

  it('affiche la conversation quand l’accès est accordé', async () => {
    monter('/app/agent/conversation');
    await waitFor(() => expect(screen.getByTestId('agent-space-conversation')).toBeTruthy());
    expect(screen.getByTestId('business-assistant-mock')).toBeTruthy();
  });

  it('affiche l’historique sur sa propre route', async () => {
    monter('/app/agent/historique');
    await waitFor(() => expect(screen.getByTestId('agent-space-historique')).toBeTruthy());
  });

  it('affiche les capacités déclarées, sans promesse de résultat', async () => {
    monter('/app/agent/capacites');
    await waitFor(() => expect(screen.getByTestId('agent-space-capacites')).toBeTruthy());
    const texte = screen.getByTestId('agent-space-capacites').textContent ?? '';
    expect(texte).toContain('je prépare, tu valides');
    expect(texte).toContain('Lire vos données Grow');
    // Aucun chiffre de performance inventé.
    expect(texte).not.toMatch(/\d+\s?%\s?(de plus|de mieux|garanti)/i);
  });
});

describe('Espace Agent IA — navigation propre', () => {
  it('expose les trois sections et l’état actif', async () => {
    monter('/app/agent/historique');
    await waitFor(() => expect(screen.getByTestId('agent-space')).toBeTruthy());
    const nav = screen.getByRole('navigation', { name: 'Navigation de l’espace Agent' });
    expect(nav).toBeTruthy();
    const liens = screen.getAllByRole('link', { name: /Historique/ });
    expect(liens.some((l) => l.getAttribute('aria-current') === 'page')).toBe(true);
    expect(screen.getAllByRole('link', { name: /Conversation/ }).length).toBeGreaterThan(0);
  });

  it('le menu mobile est monté hors du conteneur animé', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('agent-space')).toBeTruthy());
    screen.getByRole('button', { name: 'Ouvrir le menu de l’espace Agent' }).click();
    const dialogue = await screen.findByRole('dialog', { name: 'Menu de l’espace Agent' });
    // Même défaut Android que le Growth OS : le portail est obligatoire.
    expect(dialogue.parentElement).toBe(document.body);
    screen.getByRole('button', { name: 'Fermer le menu' }).click();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu de l’espace Agent' })).toBeNull());
  });
});
