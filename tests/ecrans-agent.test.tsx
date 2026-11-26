// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listModuleRecords: vi.fn(),
  createModuleRecord: vi.fn(),
  updateModuleRecord: vi.fn(),
  deleteModuleRecord: vi.fn(),
}));

vi.mock('../src/business/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/business/api')>();
  return { ...actual, businessGrowApi: { ...actual.businessGrowApi, ...api } };
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../src/context/ToastContext';
import { LitigesWorkspace } from '../src/business/finance/LitigesWorkspace';
import { RentabiliteWorkspace } from '../src/business/catalog/RentabiliteWorkspace';
import { HistoriqueAgent } from '../src/business/agent/HistoriqueAgent';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const record = (id: string, category: string, data: Record<string, unknown>) => ({
  id, category, data, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
});
const WS = '11111111-1111-4111-8111-111111111111';

describe('Écran Litiges — visible et honnête', () => {
  it('affiche un dossier avec ses preuves et son alerte d’échéance', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => {
      if (category === 'bg_module_receivable_disputes') {
        return { records: [record('d1', category, {
          receivableId: 'r1', contactId: 'k1', reason: 'Montant contesté',
          description: 'Le client conteste la ligne de livraison.', openedAt: '2026-11-01',
          status: 'ouvert', montant: 250000, devise: 'XOF', echeance: '2020-01-01',
        })] };
      }
      if (category === 'bg_module_receivables') {
        return { records: [record('r1', category, {
          reference: 'FAC-42', contactId: 'k1', initialAmount: 250000, issuedAt: '2026-10-01',
          dueDate: '2026-11-01', status: 'en_attente',
        })] };
      }
      return { records: [] };
    });
    render(<ToastProvider><LitigesWorkspace workspaceId={WS} onOpenFinance={() => {}} /></ToastProvider>);

    const panneau = await screen.findByTestId('litiges-workspace');
    await waitFor(() => expect(panneau.textContent).toContain('Montant contesté'));
    expect(panneau.textContent).toContain('250');
    expect(panneau.textContent).toMatch(/preuve\(s\) disponible\(s\)/);
  });

  it('dit qu’il n’y a aucun dossier plutôt que d’inventer', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [] });
    render(<ToastProvider><LitigesWorkspace workspaceId={WS} onOpenFinance={() => {}} /></ToastProvider>);
    const panneau = await screen.findByTestId('litiges-workspace');
    await waitFor(() => expect(panneau.textContent).toContain('Aucun dossier de litige'));
  });

  it('ouvre le dossier et montre les preuves ABSENTES comme absentes', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => {
      if (category === 'bg_module_receivable_disputes') {
        return { records: [record('d1', category, {
          receivableId: 'r1', contactId: 'k1', reason: 'Contestation', status: 'ouvert', montant: 1000, devise: 'XOF', echeance: '2020-01-01',
        })] };
      }
      return { records: [] };
    });
    render(<ToastProvider><LitigesWorkspace workspaceId={WS} onOpenFinance={() => {}} /></ToastProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /ouvrir le dossier/i }));
    const dialogue = (await screen.findAllByRole('dialog')).pop()!;
    expect(dialogue.textContent).toContain('Absente');
    expect(dialogue.textContent).toMatch(/aucune évaluation de vos chances|brouillon/i);
  });
});

describe('Écran Rentabilité — la marge inconnue reste inconnue', () => {
  it('affiche « — » pour un produit sans coût, jamais une marge inventée', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => {
      if (category === 'bg_module_catalog_products') {
        return { records: [record('p1', category, {
          name: 'Sac en cuir', sku: 'SAC-1', kind: 'produit', price: 20000, cost: null, trackStock: true, stock: 3,
        })] };
      }
      if (category === 'bg_module_sales_invoices') {
        return { records: [record('i1', category, {
          number: 'FAC-1', contactId: 'k1', status: 'payee', currency: 'XOF', issuedAt: '2026-11-01', dueDate: '2026-11-10',
          lines: [{ id: 'l1', productId: 'p1', description: 'Sac', quantity: 2, unitPrice: 20000, discountPct: 0, taxPct: 0 }],
        })] };
      }
      return { records: [] };
    });
    render(<ToastProvider><RentabiliteWorkspace workspaceId={WS} onOpenCatalog={() => {}} /></ToastProvider>);

    const panneau = await screen.findByTestId('rentabilite-workspace');
    await waitFor(() => expect(panneau.textContent).toContain('Sac en cuir'));
    expect(panneau.textContent).toContain('coût d’achat inconnu');
    expect(panneau.textContent).toContain('0 %'); // couverture du coût
  });

  it('signale une vente à perte quand le coût est connu', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => {
      if (category === 'bg_module_catalog_products') {
        return { records: [record('p1', category, {
          name: 'Produit cher', sku: 'P-1', kind: 'produit', price: 10000, cost: 15000, trackStock: true, stock: 1,
        })] };
      }
      if (category === 'bg_module_sales_invoices') {
        return { records: [record('i1', category, {
          number: 'FAC-1', contactId: 'k1', status: 'payee', currency: 'XOF', issuedAt: '2026-11-01', dueDate: '2026-11-10',
          lines: [{ id: 'l1', productId: 'p1', description: 'X', quantity: 1, unitPrice: 10000, discountPct: 0, taxPct: 0 }],
        })] };
      }
      return { records: [] };
    });
    render(<ToastProvider><RentabiliteWorkspace workspaceId={WS} onOpenCatalog={() => {}} /></ToastProvider>);
    const panneau = await screen.findByTestId('rentabilite-workspace');
    await waitFor(() => expect(panneau.textContent).toContain('à perte'));
  });
});

describe('Historique de l’agent — annulable seulement quand c’est possible', () => {
  it('n’affiche pas de bouton Annuler sur une proposition non exécutée', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [record('j1', 'bg_module_agent_journal', {
      horodatage: '2026-11-25T10:00:00Z', outil: 'planifier_relance', resume: 'Planifier une relance',
      statut: 'proposee', decidePar: 'utilisateur', resultat: 'En attente de validation', annulable: false,
    })] });
    render(<ToastProvider><HistoriqueAgent workspaceId={WS} /></ToastProvider>);
    const panneau = await screen.findByTestId('historique-agent');
    await waitFor(() => expect(panneau.textContent).toContain('Planifier une relance'));
    expect(screen.queryByRole('button', { name: /annuler cette action/i })).toBeNull();
  });

  it('propose Annuler sur une action exécutée et annulable', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [record('j1', 'bg_module_agent_journal', {
      horodatage: '2026-11-25T10:00:00Z', outil: 'creer_tache', resume: 'Créer une tâche',
      statut: 'executee', decidePar: 'utilisateur', resultat: 'ok',
      enregistrementId: 'rec-1', categorie: 'bg_module_crm_tasks', annulable: true,
    })] });
    render(<ToastProvider><HistoriqueAgent workspaceId={WS} /></ToastProvider>);
    expect(await screen.findByRole('button', { name: /annuler cette action/i })).toBeTruthy();
  });

  it('affiche un historique vide sans inventer d’entrée', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [] });
    render(<ToastProvider><HistoriqueAgent workspaceId={WS} /></ToastProvider>);
    const panneau = await screen.findByTestId('historique-agent');
    await waitFor(() => expect(panneau.textContent).toContain('Aucune action de l’agent'));
  });
});
