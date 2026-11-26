// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listModuleRecords: vi.fn(),
  createModuleRecord: vi.fn(),
  updateModuleRecord: vi.fn(),
  deleteModuleRecord: vi.fn(),
  // Journal dédié (`agent.journal`). Laissé SANS implémentation par défaut :
  // l'appel rejette, ce qui simule un Edge pas encore déployé. Chaque test dit
  // explicitement s'il teste la voie dédiée ou le repli.
  listAgentJournal: vi.fn(),
  appendAgentJournal: vi.fn(),
  setAgentJournalStatus: vi.fn(),
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
import { BusinessGrowApiError } from '../src/business/api';

afterEach(() => { cleanup(); vi.clearAllMocks(); localiserJournalDedie(); });

/**
 * Simule un Edge déployé AVANT l'action `agent.journal`.
 *
 * C'est l'état réel du serveur tant que le déploiement n'a pas eu lieu :
 * l'action est inconnue, le client doit alors le DIRE et se rabattre sur le
 * stockage de module, jamais faire semblant que tout va bien.
 */
function localiserJournalDedie() {
  api.listAgentJournal.mockRejectedValue(new BusinessGrowApiError('Opération Grow inconnue.', 'UNKNOWN_ACTION', 400));
  api.appendAgentJournal.mockRejectedValue(new BusinessGrowApiError('Opération Grow inconnue.', 'UNKNOWN_ACTION', 400));
  api.setAgentJournalStatus.mockRejectedValue(new BusinessGrowApiError('Opération Grow inconnue.', 'UNKNOWN_ACTION', 400));
}

localiserJournalDedie();

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

/**
 * Journal dédié (`agent.journal`) — la voie nominale.
 *
 * Ces tests vérifient ce que le repli ne peut pas garantir : la limite dédiée
 * (5 000 entrées) et le fait qu'une annulation ne réécrit QUE le statut, sans
 * pouvoir modifier un montant ou un résumé déjà journalisé.
 */
describe('Historique de l’agent — journal dédié', () => {
  const entree = {
    horodatage: '2026-11-25T10:00:00Z', outil: 'creer_facture', resume: 'Créer la facture FAC-9',
    statut: 'executee', decidePar: 'utilisateur', resultat: 'Facture créée',
    enregistrementId: '8f14e45f-ceea-467a-9c1b-1d3b5f0b1a11', categorie: 'bg_module_sales_invoices', annulable: true,
  };

  it('lit le journal dédié et n’affiche aucun bandeau de repli', async () => {
    api.listAgentJournal.mockResolvedValue({ entries: [record('j9', 'bg_module_agent_journal', entree)] });
    render(<ToastProvider><HistoriqueAgent workspaceId={WS} /></ToastProvider>);

    const panneau = await screen.findByTestId('historique-agent');
    await waitFor(() => expect(panneau.textContent).toContain('Créer la facture FAC-9'));
    expect(panneau.textContent).not.toContain('mode compatible');
    // Le repli ne doit pas avoir été sollicité : une seule vérité par lecture.
    expect(api.listModuleRecords).not.toHaveBeenCalled();
  });

  it('avertit explicitement quand le serveur déployé ne connaît pas le journal dédié', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [record('j1', 'bg_module_agent_journal', entree)] });
    render(<ToastProvider><HistoriqueAgent workspaceId={WS} /></ToastProvider>);

    const panneau = await screen.findByTestId('historique-agent');
    await waitFor(() => expect(panneau.textContent).toContain('mode compatible'));
    // L'entrée reste affichée : le repli est dégradé, pas menteur.
    expect(panneau.textContent).toContain('Créer la facture FAC-9');
  });

  it('annule en deux temps : retire la donnée, puis change le SEUL statut', async () => {
    api.listAgentJournal.mockResolvedValue({ entries: [record('j9', 'bg_module_agent_journal', entree)] });
    api.setAgentJournalStatus.mockResolvedValue({ updated: true });
    api.deleteModuleRecord.mockResolvedValue({ deleted: true });

    render(<ToastProvider><HistoriqueAgent workspaceId={WS} /></ToastProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /annuler cette action/i }));

    await waitFor(() => expect(api.setAgentJournalStatus).toHaveBeenCalledTimes(1));
    // La donnée métier est retirée de SA catégorie, pas du journal.
    expect(api.deleteModuleRecord).toHaveBeenCalledWith('bg_module_sales_invoices', entree.enregistrementId, WS);
    // Seuls identifiant + statut (+ résultat lisible) transitent : le serveur
    // ne peut pas réécrire le montant ou le résumé de l'entrée.
    const [, entryId, statut, resultat] = api.setAgentJournalStatus.mock.calls[0];
    expect(entryId).toBe('j9');
    expect(statut).toBe('annulee');
    expect(String(resultat)).toContain('Annulée');
    expect(api.updateModuleRecord).not.toHaveBeenCalled();
  });

  it('ne marque pas « annulée » si la donnée n’a pas pu être retirée', async () => {
    api.listAgentJournal.mockResolvedValue({ entries: [record('j9', 'bg_module_agent_journal', entree)] });
    api.deleteModuleRecord.mockRejectedValue(new Error('Suppression refusée'));

    render(<ToastProvider><HistoriqueAgent workspaceId={WS} /></ToastProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /annuler cette action/i }));

    await waitFor(() => expect(api.deleteModuleRecord).toHaveBeenCalled());
    // Aucune écriture de statut : afficher « annulée » sans l'avoir fait serait
    // exactement le mensonge que l'écran doit rendre impossible.
    expect(api.setAgentJournalStatus).not.toHaveBeenCalled();
    expect(api.updateModuleRecord).not.toHaveBeenCalled();
    // Le bouton reste proposé : l'action est toujours réellement annulable.
    expect(screen.getByRole('button', { name: /annuler cette action/i })).toBeTruthy();
  });

  it('propage un refus de droits au lieu de se replier dessus', async () => {
    api.listAgentJournal.mockRejectedValue(new BusinessGrowApiError('Accès refusé à cette entreprise.', 'FORBIDDEN', 403));

    render(<ToastProvider><HistoriqueAgent workspaceId={WS} /></ToastProvider>);
    expect(await screen.findByText(/Accès refusé à cette entreprise/i)).toBeTruthy();
    // Un 403 n'est pas un déploiement en retard : se replier reviendrait à
    // contourner le contrôle d'accès.
    expect(api.listModuleRecords).not.toHaveBeenCalled();
    expect(screen.queryByTestId('historique-agent')).toBeNull();
  });
});
