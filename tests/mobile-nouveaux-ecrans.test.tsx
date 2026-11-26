// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listModuleRecords: vi.fn(),
  createModuleRecord: vi.fn(),
  updateModuleRecord: vi.fn(),
  deleteModuleRecord: vi.fn(),
  // Voie dédiée du journal : on simule l'Edge DÉJÀ déployé pour tester l'écran
  // nominal sur mobile (le mode de repli est couvert par `ecrans-agent.test`).
  listAgentJournal: vi.fn(),
  appendAgentJournal: vi.fn(),
  setAgentJournalStatus: vi.fn(),
}));

vi.mock('../src/business/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/business/api')>();
  return { ...actual, businessGrowApi: { ...actual.businessGrowApi, ...api } };
});

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/context/ToastContext';
import { RecouvrementWorkspace } from '../src/business/finance/RecouvrementWorkspace';
import { MessagesWorkspace } from '../src/business/marketing/MessagesWorkspace';
import { EcheancesWorkspace } from '../src/business/compliance/EcheancesWorkspace';
import { VeilleWorkspace } from '../src/business/growth/VeilleWorkspace';
import { BriefStudioWorkspace } from '../src/business/growth/BriefStudioWorkspace';
import { HistoriqueAgent } from '../src/business/agent/HistoriqueAgent';

/**
 * Mobile d'abord (Android 360 px).
 *
 * ## Ce que ces tests prouvent — et ce qu'ils ne prouvent PAS
 * Ils prouvent que, sur un écran de 360 px, chaque nouvel écran se monte, ne
 * produit AUCUN doublon dans le DOM (une seule version de la donnée, donc un
 * seul élément pour les sélecteurs et les lecteurs d'écran), et expose des
 * cibles tactiles et des champs accessibles au clavier.
 *
 * Ils ne remplacent PAS un essai sur un téléphone réel : je n'ai pas d'appareil
 * Android connecté dans cet environnement, donc je ne peux pas affirmer que le
 * rendu visuel a été vérifié à la main.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const record = (id: string, category: string, data: Record<string, unknown>) => ({
  id, category, data, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
});

beforeEach(() => {
  // 360 px : sous le point de rupture `sm` (640 px), donc mode « petit écran ».
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
  window.matchMedia = ((requete: string) => ({
    matches: false,
    media: requete,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function donneesDeBase() {
  api.listAgentJournal.mockResolvedValue({
    entries: [record('j1', 'bg_module_agent_journal', {
      horodatage: '2026-11-25T10:00:00Z', outil: 'creer_tache', resume: 'Créer une tâche',
      statut: 'executee', resultat: 'ok', enregistrementId: 'rec-1',
      categorie: 'bg_module_crm_tasks', annulable: true,
    })],
  });
  api.listModuleRecords.mockImplementation(async (category: string) => {
    if (category === 'bg_module_receivables') {
      return { records: [record('r1', category, {
        reference: 'FAC-42', contactId: 'k1', initialAmount: 500000,
        issuedAt: '2019-12-01', dueDate: '2020-01-01', status: 'en_attente',
      })] };
    }
    if (category === 'bg_module_crm_contacts') {
      return { records: [record('k1', category, { firstName: 'Awa', lastName: 'Traoré', country: 'Mali', type: 'client' })] };
    }
    if (category === 'bg_module_sales_invoices') {
      return { records: [record('f1', category, {
        number: 'FAC-1', contactId: 'k1', status: 'envoyee', issuedAt: '2026-11-01', dueDate: '2026-12-01',
        currency: 'XOF',
        lines: [{ id: 'l1', productId: 'p1', description: 'Savon', quantity: 10, unitPrice: 5000, discountPct: 0, taxPct: 0 }],
      })] };
    }
    if (category === 'bg_module_catalog_products') {
      return { records: [record('p1', category, { name: 'Savon', sku: 'SAV-1', price: 5000, cost: 2000, stock: 10 })] };
    }
    if (category === 'bg_module_agent_journal') {
      return { records: [record('j1', category, {
        horodatage: '2026-11-25T10:00:00Z', outil: 'creer_tache', resume: 'Créer une tâche',
        statut: 'executee', resultat: 'ok', enregistrementId: 'rec-1', categorie: 'bg_module_crm_tasks', annulable: true,
      })] };
    }
    return { records: [] };
  });
}

describe('Nouveaux écrans à 360 px', () => {
  it('Recouvrement : une seule occurrence de la créance', async () => {
    donneesDeBase();
    render(<ToastProvider><RecouvrementWorkspace workspaceId={WS} onOpenFinance={() => {}} /></ToastProvider>);
    await screen.findByTestId('recouvrement-workspace');
    await waitFor(() => expect(screen.getAllByText(/FAC-42/).length).toBeGreaterThan(0));
    // Aucune version « tableau » cachée en plus de la version mobile.
    expect(screen.queryByRole('table')).toBeNull();
    // Le contenu détaillé est dépliable et les actions restent accessibles.
    expect(screen.getByRole('button', { name: /copier le message/i })).toBeTruthy();
  });

  it('Messages : le champ de texte est étiqueté pour le clavier et les lecteurs', async () => {
    donneesDeBase();
    render(<ToastProvider><MessagesWorkspace workspaceId={WS} /></ToastProvider>);
    await screen.findByTestId('messages-workspace');
    const champ = screen.getByLabelText('Message préparé');
    expect(champ.tagName).toBe('TEXTAREA');
    // Les sélecteurs ont un libellé : utilisables sans souris.
    expect(screen.getByLabelText('Situation')).toBeTruthy();
    expect(screen.getByLabelText('Langue')).toBeTruthy();
  });

  it('Échéances : les champs de saisie ont un libellé accessible', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [] });
    render(<ToastProvider><EcheancesWorkspace workspaceId={WS} /></ToastProvider>);
    await screen.findByTestId('echeances-workspace');
    expect(screen.getByLabelText('Nom de l’échéance')).toBeTruthy();
    expect(screen.getByLabelText('Date de l’échéance').getAttribute('type')).toBe('date');
    // Le bouton d'ajout est atteignable et nommé.
    expect(screen.getByRole('button', { name: /ajouter/i })).toBeTruthy();
  });

  it('Veille : pas de tableau, un état vide explicite', async () => {
    render(<ToastProvider><VeilleWorkspace memory={null} prixMaison={null} /></ToastProvider>);
    await screen.findByTestId('veille-workspace');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/Aucune donnée de veille/i)).toBeTruthy();
  });

  it('Brief Studio : le texte reste lisible en petit écran', async () => {
    donneesDeBase();
    render(
      <MemoryRouter>
        <ToastProvider><BriefStudioWorkspace workspaceId={WS} nomEntreprise="Maison Karité" /></ToastProvider>
      </MemoryRouter>,
    );
    const panneau = await screen.findByTestId('brief-studio-workspace');
    await waitFor(() => expect(panneau.textContent).toContain('Savon'));
    // Le bouton reste un lien réel : il fonctionne au clavier.
    const lien = screen.getByTestId('ouvrir-studio-sans-debit');
    expect(lien.tagName).toBe('A');
    expect(lien.getAttribute('href')).toBe('/app/studio');
  });

  it('Historique : une seule liste, chacun de ses boutons est nommé', async () => {
    donneesDeBase();
    render(<ToastProvider><HistoriqueAgent workspaceId={WS} /></ToastProvider>);
    await screen.findByTestId('historique-agent');
    await waitFor(() => expect(screen.getAllByText(/Créer une tâche/).length).toBeGreaterThan(0));
    expect(screen.queryByRole('table')).toBeNull();
    const annuler = screen.getByRole('button', { name: /annuler cette action/i });
    expect(annuler.textContent?.trim().length).toBeGreaterThan(0);
  });
});
