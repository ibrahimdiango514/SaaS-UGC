// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessReport, BusinessReportType, SavedBusinessReport } from '../src/business/api';

const api = vi.hoisted(() => ({
  generateReport: vi.fn(),
  listReports: vi.fn(),
  deleteReport: vi.fn(),
}));
vi.mock('../src/business/api', () => ({ businessGrowApi: api }));
import AgentReports from '../src/business/agent/AgentReports';

function makeReport(problem = 'Facture FAC-PRIVÉE en retard'): BusinessReport {
  return {
    type: 'health', period: { from: '2026-10-15', to: '2026-11-13' }, asOf: '2026-11-13',
    coverage: [{ module: 'Payment Recovery', category: 'bg_module_payment_recovery', count: 1, status: 'available', truncated: false }],
    metrics: [{ label: 'Montant total', value: 75000, unit: 'FCFA', basis: 'Montant saisi' }],
    recommendations: [{ id: 'invoice:source-secret', kind: 'invoice_overdue', module: 'Payment Recovery', priority: 'élevée',
      problem, evidence: ['Client confidentiel'], potentialImpact: 'Montant non garanti', action: 'Vérifier la facture',
      sourceCategory: 'bg_module_payment_recovery', sourceRecordId: 'source-secret', facts: { amount: 75000 } }],
    totalRecommendations: 1, warnings: ['Aucun connecteur externe supposé actif.'],
  };
}
const savedReport = (document: BusinessReport): SavedBusinessReport => ({
  id: 'report-id', report_type: document.type, period_from: document.period.from,
  period_to: document.period.to, document, created_at: '2026-11-13T00:00:00Z',
});
const onReport = vi.fn();
const onAsk = vi.fn();
const onPropose = vi.fn(async () => true);
const ui = (workspaceId = 'workspace-1') => <AgentReports workspaceId={workspaceId} ready busy={false} onReport={onReport} onPropose={onPropose} onAsk={onAsk} />;

beforeEach(() => {
  vi.clearAllMocks();
  api.generateReport.mockReset(); api.listReports.mockReset(); api.deleteReport.mockReset();
  api.generateReport.mockResolvedValue({ report: makeReport(), saved: false });
  api.listReports.mockResolvedValue({ reports: [] });
  api.deleteReport.mockResolvedValue({ deleted: true });
});
afterEach(cleanup);

describe('Diagnostics et rapports Business Agent', () => {
  it('affiche les preuves et prépare une proposition sans la confirmer ni transmettre les noms au brouillon IA', async () => {
    render(ui());
    fireEvent.click(await screen.findByRole('button', { name: /Diagnostics & rapports/ }));
    expect(await screen.findByText('Facture FAC-PRIVÉE en retard')).toBeTruthy();
    expect(screen.getByText(/Client confidentiel/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approfondir avec l’IA' }));
    const draft = onAsk.mock.calls[0][0] as string;
    expect(draft).toContain('75000');
    expect(draft).not.toContain('FAC-PRIVÉE');
    expect(draft).not.toContain('Client confidentiel');
    expect(draft).not.toContain('source-secret');
    fireEvent.click(screen.getByRole('button', { name: 'Préparer une tâche' }));
    await waitFor(() => expect(onPropose).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Proposition ajoutée à la conversation initiale/)).toBeTruthy();
    expect(onPropose).toHaveBeenCalledWith(expect.objectContaining({ sourceRecordId: 'source-secret' }));
  });

  it('refuse une période inversée ou supérieure à 366 jours avant toute requête', async () => {
    render(ui());
    fireEvent.click(await screen.findByRole('button', { name: /Diagnostics & rapports/ }));
    await screen.findByText('Facture FAC-PRIVÉE en retard');
    const initialCalls = api.generateReport.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Début de période'), { target: { value: '2026-11-14' } });
    fireEvent.change(screen.getByLabelText('Fin de période'), { target: { value: '2026-11-13' } });
    expect(screen.getByRole('alert').textContent).toMatch(/période valide/);
    expect((screen.getByRole('button', { name: 'Analyser' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Début de période'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Fin de période'), { target: { value: '2027-01-02' } });
    expect((screen.getByRole('button', { name: 'Enregistrer le rapport' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.generateReport).toHaveBeenCalledTimes(initialCalls);
  });

  it('réutilise la même clé après une réponse incertaine puis affiche l’historique', async () => {
    let saves = 0;
    api.generateReport.mockImplementation(async (_ws: string, _type: BusinessReportType, _from: string, _to: string, save: boolean) => {
      if (save && ++saves === 1) throw new Error('Résultat inconnu, vérifiez avant de relancer.');
      return { report: makeReport(), saved: save, created: true };
    });
    api.listReports.mockResolvedValue({ reports: [savedReport(makeReport())] });
    render(ui());
    fireEvent.click(await screen.findByRole('button', { name: /Diagnostics & rapports/ }));
    await screen.findByText('Facture FAC-PRIVÉE en retard');
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le rapport' }));
    expect(await screen.findByText(/Résultat inconnu/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le rapport' }));
    expect(await screen.findByText('Rapport enregistré dans cette entreprise.')).toBeTruthy();
    const saveCalls = api.generateReport.mock.calls.filter((call) => call[4] === true);
    expect(saveCalls).toHaveLength(2);
    expect(saveCalls[0][5]).toEqual(saveCalls[1][5]);
    expect(saveCalls[0][5]).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /Santé globale · 2026-10-15/ }));
    expect(screen.getByText('Rapport enregistré chargé.')).toBeTruthy();
    expect((screen.getByLabelText('Début de période') as HTMLInputElement).value).toBe('2026-10-15');
  });

  it('demande confirmation pour supprimer un rapport conservé et retire son affichage', async () => {
    api.listReports.mockResolvedValue({ reports: [savedReport(makeReport())] });
    render(ui());
    fireEvent.click(await screen.findByRole('button', { name: /Diagnostics & rapports/ }));
    const saved = await screen.findByRole('button', { name: /Santé globale · 2026-10-15/ });
    fireEvent.click(saved);
    expect(screen.getByText('Rapport enregistré chargé.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Supprimer le rapport Santé globale/ }));
    expect(screen.getByText('Supprimer ce rapport ?')).toBeTruthy();
    expect(api.deleteReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(api.deleteReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Supprimer le rapport Santé globale/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer le rapport' }));
    await waitFor(() => expect(api.deleteReport).toHaveBeenCalledWith('workspace-1', 'report-id'));
    expect(await screen.findByText(/Rapport supprimé de l’historique/)).toBeTruthy();
    expect(screen.queryByText('Facture FAC-PRIVÉE en retard')).toBeNull();
    expect(screen.queryByRole('button', { name: /Supprimer le rapport Santé globale/ })).toBeNull();
    expect(onReport).toHaveBeenLastCalledWith(null);
  });

  it('écarte un rapport et un historique arrivés après le changement d’entreprise', async () => {
    let finishReport!: (result: { report: BusinessReport }) => void;
    let finishHistory!: (result: { reports: SavedBusinessReport[] }) => void;
    api.generateReport.mockImplementation(async (workspace: string) => workspace === 'workspace-1'
      ? new Promise((resolve) => { finishReport = resolve; })
      : { report: makeReport('Facture entreprise B') });
    api.listReports.mockImplementation(async (workspace: string) => workspace === 'workspace-1'
      ? new Promise((resolve) => { finishHistory = resolve; })
      : { reports: [] });
    const view = render(ui());
    fireEvent.click(await screen.findByRole('button', { name: /Diagnostics & rapports/ }));
    await waitFor(() => expect(api.listReports).toHaveBeenCalledWith('workspace-1'));
    view.rerender(ui('workspace-2'));
    expect(await screen.findByText('Facture entreprise B')).toBeTruthy();
    await act(async () => {
      finishReport({ report: makeReport('Secret entreprise A') });
      finishHistory({ reports: [savedReport(makeReport('Ancien rapport A'))] });
    });
    expect(screen.queryByText('Secret entreprise A')).toBeNull();
    expect(screen.queryByText('Ancien rapport A')).toBeNull();
    expect(onReport.mock.calls.some(([report]) => report?.recommendations?.[0]?.problem === 'Secret entreprise A')).toBe(false);
    expect(screen.getByText('Facture entreprise B')).toBeTruthy();
  });
});
