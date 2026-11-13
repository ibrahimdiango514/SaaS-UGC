// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BusinessModules from '../src/business/modules/BusinessModules';
import BusinessModuleWorkspace from '../src/business/modules/BusinessModuleWorkspace';
import {
  FOUNDATION_MODULES,
  MODULE_DEFINITIONS,
  buildAutomationTasks,
  computeRevenueLeaks,
  daysSince, displayFieldValue, getModuleDefinition, measuredNumber,
  moduleKeyToCategory,
  type ModuleRecord,
} from '../src/business/modules/registry';

const api = vi.hoisted(() => ({
  listModuleRecords: vi.fn(async (_category?: string, _workspace?: string | null) => ({ records: [] as unknown[] })),
  createModuleRecord: vi.fn(async () => ({ recordId: 'new-record' })),
  confirmAutomationTask: vi.fn(async (_workspace?: string, _confirmation?: unknown) => ({ taskId: 'task', created: true })),
  updateModuleRecord: vi.fn(async () => ({ updated: true })),
  deleteModuleRecord: vi.fn(async () => ({ deleted: true })),
}));

vi.mock('../src/business/api', () => ({ businessGrowApi: api }));
const auth = vi.hoisted(() => ({ workspaceId: 'workspace-1' as string | null, userId: 'user-1' }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ workspaceId: auth.workspaceId, user: { id: auth.userId } }) }));

afterEach(() => cleanup());

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-state">{JSON.stringify(location.state)}</output>;
}

function record(id: string, data: Record<string, unknown>): ModuleRecord {
  return {
    id,
    category: 'bg_module_test',
    data,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
  };
}

describe('Registre des modules Business Growth', () => {
  it('couvre les 16 modules de la mission : 13 outils + 3 fondations', () => {
    expect(MODULE_DEFINITIONS).toHaveLength(13);
    expect(FOUNDATION_MODULES).toHaveLength(3);
    const allKeys = [...MODULE_DEFINITIONS.map((module) => module.key), ...FOUNDATION_MODULES.map((module) => module.key)];
    expect(new Set(allKeys).size).toBe(16);
  });

  it('déclare pour chaque module un stockage, des champs et des statuts cohérents', () => {
    for (const module of MODULE_DEFINITIONS) {
      expect(module.category).toBe(moduleKeyToCategory(module.key));
      expect(module.category).toMatch(/^bg_module_[a-z0-9_]+$/);
      expect(module.fields.length).toBeGreaterThan(2);
      expect(module.statuses.length).toBeGreaterThan(1);
      expect(module.openStatuses.length).toBeGreaterThan(0);
      expect(module.fields.some((field) => field.key === module.primaryField)).toBe(true);
      expect(module.fields.some((field) => field.required)).toBe(true);
      if (module.dateField) expect(module.fields.some((field) => field.key === module.dateField)).toBe(true);
      if (module.valueField) expect(module.fields.some((field) => field.key === module.valueField)).toBe(true);
      expect(typeof module.kpis[0].compute([])).toBe('string');
      expect(module.agentPrompt.trim().length).toBeGreaterThan(20);
    }
  });

  it('calcule les fuites de revenus à partir des enregistrements réels', () => {
    const leads = [
      record('lead-1', { name: 'A', estimatedValue: 75000, lastContactAt: '2026-10-01', status: 'nouveau' }),
      record('lead-2', { name: 'B', estimatedValue: 25000, lastContactAt: '2026-11-12', status: 'qualifie' }),
    ];
    const invoices = [record('invoice-1', { amount: 120000, status: 'en_retard' })];
    const stock = [record('stock-1', { stock: 2, threshold: 10, price: 15000 })];
    const leaks = computeRevenueLeaks({
      'lead-rescue': leads,
      'payment-recovery': invoices,
      'smart-inventory': stock,
    });
    const byId = Object.fromEntries(leaks.map((leak) => [leak.id, leak]));
    expect(byId['leak-leads'].amount).toBe(75000);
    expect(byId['leak-invoices'].amount).toBe(120000);
    expect(byId['leak-stock'].amount).toBeNull(); // manque de demande : aucune perte chiffrable
    expect(leaks[0].severity).toBe('haute');
  });

  it('calcule les KPI des bons modules et ne fabrique pas de stock ou montant nul', () => {
    const support = getModuleDefinition('customer-support-ai')!;
    const supplier = getModuleDefinition('supplier-delivery')!;
    const dispute = getModuleDefinition('dispute-shield')!;
    const inventory = getModuleDefinition('smart-inventory')!;
    const kpi = (key: string, label: string, rows: ModuleRecord[]) => getModuleDefinition(key)!.kpis.find((item) => item.label === label)!.compute(rows);
    expect(kpi(support.key, 'Ouverts', [record('s1', { status: 'ouvert' }), record('s2', { status: 'resolu' })])).toBe('1');
    expect(kpi(supplier.key, 'En retard', [record('s1', { status: 'transit', expectedAt: '2000-01-01' }), record('s2', { status: 'livre', expectedAt: '2000-01-01' })])).toBe('1');
    expect(kpi(dispute.key, 'Ouverts', [record('d1', { status: 'escalade', amount: 2500 }), record('d2', { status: 'resolu', amount: 9000 })])).toBe('1');
    const missing = record('missing', { status: 'normal', stock: null, threshold: null, unitCost: null });
    expect(kpi(inventory.key, 'Alertes stock', [missing])).toBe('0');
    expect(kpi(inventory.key, 'Ruptures', [missing])).toBe('0');
    expect(kpi(inventory.key, 'Stock au coût', [missing])).toBe('—');
    expect(kpi(inventory.key, 'Ruptures', [record('zero', { stock: 0 })])).toBe('1');
    expect(displayFieldValue(inventory, missing, inventory.fields.find((field) => field.key === 'stock')!)).toBe('—');
    expect(measuredNumber('0x100')).toBeNull();
    expect(measuredNumber(0)).toBe(0);
    expect(computeRevenueLeaks({ 'smart-inventory': [missing] })).toEqual([]);
    expect(computeRevenueLeaks({ 'payment-recovery': [record('future', { status: 'relance', amount: 1, dueDate: '2099-01-01' })] })).toEqual([]);
    expect(daysSince('2026-11-13', Date.parse('2026-11-13T23:00:00Z'))).toBe(0);
    expect(daysSince('2026-02-30', Date.parse('2026-11-13T23:00:00Z'))).toBeNull();
  });

  it('calcule les échéances d’automatisation à partir du délai réel, sans jour supplémentaire', () => {
    const source = { 'order-cart-recovery': [record('cart', { status: 'panier', reference: 'CMD' })] };
    const rules = [0, 1, null, 2.5, 3651].map((delay, i) => record(`rule-${i}`, { name: `Règle ${i}`, trigger: 'panier_abandonne', delayDays: delay, status: 'actif' }));
    const tasks = buildAutomationTasks(rules, source, Date.parse('2026-11-13T23:59:00Z'));
    expect(tasks.map((task) => task.dueDate)).toEqual(['2026-11-13', '2026-11-14', '2026-11-13']);
    expect(buildAutomationTasks(rules, source, NaN)).toEqual([]);
    const invoiceRule = [record('invoice-rule', { name: 'Facture', trigger: 'facture_echue', delayDays: 0, status: 'actif' })];
    const invoices = { 'payment-recovery': [record('invoice', { dueDate: '2026-11-12', status: 'a_echeance' })] };
    expect(buildAutomationTasks(invoiceRule, invoices, Date.parse('2026-11-12T23:59:00Z'))).toHaveLength(0);
    expect(buildAutomationTasks(invoiceRule, invoices, Date.parse('2026-11-13T00:00:00Z'))).toHaveLength(1);
    expect(buildAutomationTasks(invoiceRule, { 'payment-recovery': [record('bad-date', { dueDate: '2026-11-12T01:00:00Z', status: 'a_echeance' })] }, Date.parse('2026-11-13T00:00:00Z'))).toHaveLength(0);
  });

  it('génère des tâches déterministes uniquement pour les règles actives', () => {
    const playbooks = [
      record('rule-1', { name: 'Relancer les paniers', trigger: 'panier_abandonne', action: 'tache_relance', delayDays: 1, status: 'actif' }),
      record('rule-2', { name: 'Règle en pause', trigger: 'facture_echue', action: 'alerte_interne', delayDays: 0, status: 'pause' }),
    ];
    const tasks = buildAutomationTasks(playbooks, {
      'order-cart-recovery': [record('cart-1', { reference: 'CMD-1', status: 'panier' })],
      'payment-recovery': [record('invoice-1', { invoiceRef: 'FAC-1', status: 'en_retard' })],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      source: 'sales_automation',
      sourcePlaybookId: 'rule-1',
      sourceRecordId: 'cart-1',
      priority: 'moyenne',
    });
    expect(tasks[0].title).toContain('CMD-1');
  });
});

describe('Catalogue des modules', () => {
  it('présente les 13 outils et les 3 fondations, avec un lien réel par module', () => {
    render(<MemoryRouter><BusinessModules /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /Vos modules métier/i })).toBeTruthy();
    expect(screen.getByText('Fondations déjà opérationnelles')).toBeTruthy();
    for (const module of MODULE_DEFINITIONS) {
      expect(screen.getByRole('heading', { name: module.title })).toBeTruthy();
    }
    const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    for (const module of MODULE_DEFINITIONS) {
      expect(links).toContain(`/app/business/modules/${module.key}`);
    }
  });
});

describe('Espace d’un module', () => {
  beforeEach(() => {
    auth.workspaceId = 'workspace-1';
    auth.userId = 'user-1';
    api.listModuleRecords.mockReset();
    api.listModuleRecords.mockResolvedValue({ records: [] });
    api.createModuleRecord.mockClear();
    api.confirmAutomationTask.mockReset();
    api.confirmAutomationTask.mockResolvedValue({ taskId: 'task', created: true });
  });

  it('affiche un état vide et crée un enregistrement avec les champs réels', async () => {
    render(
      <MemoryRouter initialEntries={['/app/business/modules/lead-rescue']}>
        <Routes>
          <Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Lead Rescue' })).toBeTruthy();
    expect(await screen.findByText('Aucun lead à sauver pour le moment')).toBeTruthy();
    expect(api.listModuleRecords).toHaveBeenCalledWith('bg_module_lead_rescue', 'workspace-1');

    fireEvent.click(screen.getAllByRole('button', { name: /Créer un enregistrement/i })[0]);
    fireEvent.change(screen.getByLabelText(/Prospect/), { target: { value: 'Salif Traoré' } });
    fireEvent.change(screen.getByLabelText(/Valeur estimée/), { target: { value: '125000' } });
    fireEvent.change(screen.getByLabelText(/Dernier contact/), { target: { value: '2026-11-12' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer l’enregistrement/i }));

    await waitFor(() => {
      expect(api.createModuleRecord).toHaveBeenCalledWith('bg_module_lead_rescue', expect.objectContaining({
        name: 'Salif Traoré',
        estimatedValue: 125000,
        status: 'nouveau',
      }), null, 'workspace-1');
    });
  });

  it('ne déduit pas la date ou un montant manquant à la création', async () => {
    render(<MemoryRouter initialEntries={['/app/business/modules/lead-rescue']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    await screen.findByText('Aucun lead à sauver pour le moment');
    fireEvent.click(screen.getAllByRole('button', { name: /Créer un enregistrement/i })[0]);
    expect((screen.getByLabelText(/Dernier contact/) as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText(/Prospect/), { target: { value: 'Prospect sans montant' } });
    fireEvent.change(screen.getByLabelText(/Dernier contact/), { target: { value: '2026-11-10' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer l’enregistrement/i }));
    await waitFor(() => expect(api.createModuleRecord).toHaveBeenCalledWith('bg_module_lead_rescue', expect.objectContaining({ estimatedValue: null, lastContactAt: '2026-11-10' }), null, 'workspace-1'));
  });

  it('ne charge pas le périmètre personnel lorsqu’aucune entreprise n’est active', async () => {
    auth.workspaceId = null;
    render(<MemoryRouter initialEntries={['/app/business/modules/lead-rescue']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('Aucune entreprise active.')).toBeTruthy();
    expect(api.listModuleRecords).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Nouvel enregistrement' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('ignore une réponse tardive après changement d’entreprise', async () => {
    let resolveOld!: (value: { records: unknown[] }) => void;
    api.listModuleRecords.mockImplementation(async (_category, workspace) => workspace === 'workspace-1'
      ? new Promise((resolve) => { resolveOld = resolve; })
      : { records: [{ id: 'b', category: 'bg_module_lead_rescue', data: { name: 'Entreprise B', status: 'nouveau' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] });
    const ui = () => <MemoryRouter initialEntries={['/app/business/modules/lead-rescue']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>;
    const view = render(ui());
    await waitFor(() => expect(api.listModuleRecords).toHaveBeenCalledWith('bg_module_lead_rescue', 'workspace-1'));
    auth.workspaceId = 'workspace-2';
    view.rerender(ui());
    expect(await screen.findByText('Entreprise B')).toBeTruthy();
    await act(async () => { resolveOld({ records: [{ id: 'a', category: 'bg_module_lead_rescue', data: { name: 'Secret entreprise A', status: 'nouveau' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] }); });
    expect(screen.queryByText('Secret entreprise A')).toBeNull();
    expect(screen.getByText('Entreprise B')).toBeTruthy();
  });

  it('présente les tâches exactes avant confirmation, puis confirme leurs sources', async () => {
    let ruleReads = 0;
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: 'rule', category, data: { name: ruleReads++ ? 'Relance actuelle' : 'Ancienne relance', status: 'actif', trigger: 'panier_abandonne', delayDays: 0 }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return { records: [{ id: 'cart', category, data: { reference: 'CMD-1', status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      return { records: [] };
    });
    render(<MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    await screen.findByText('Ancienne relance');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    const dialog = await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    expect(dialog.textContent).toContain('Relance actuelle · CMD-1');
    expect(dialog.textContent).toContain('Aucun message ni action externe');
    expect(dialog.textContent).toContain('La capacité estimée peut changer');
    expect(dialog.textContent).toContain('en cas d’interruption, celles déjà créées restent enregistrées');
    expect(api.createModuleRecord).not.toHaveBeenCalled();
    expect(api.confirmAutomationTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la génération' }));
    await waitFor(() => expect(api.confirmAutomationTask).toHaveBeenCalledTimes(1));
    expect(api.confirmAutomationTask).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
      playbookId: 'rule', sourceId: 'cart', sourceCategory: 'bg_module_order_cart_recovery',
      previewDay: new Date().toISOString().slice(0, 10),
      expectedPlaybook: expect.objectContaining({ name: 'Relance actuelle', status: 'actif' }),
      expectedSource: { reference: 'CMD-1', status: 'panier' },
      task: expect.objectContaining({ title: 'Relance actuelle · CMD-1', sourceRecordId: 'cart', status: 'a_faire' }),
    }));
    expect(await screen.findByText(/1 tâche\(s\) créée\(s\), 0 déjà présente/)).toBeTruthy();
  });

  it('annule l’aperçu sans écriture et ne prépare rien si une lecture échoue', async () => {
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: 'rule', category, data: { name: 'Relance', status: 'actif', trigger: 'panier_abandonne', delayDays: 0 }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return { records: [{ id: 'cart', category, data: { reference: 'CMD-1', status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      return { records: [] };
    });
    render(<MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    await screen.findByText('Relance');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('dialog', { name: 'Vérifier les tâches proposées' })).toBeNull();
    expect(api.confirmAutomationTask).not.toHaveBeenCalled();
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_order_cart_recovery') throw new Error('Sources indisponibles');
      return { records: [] };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    expect(await screen.findByText('Sources indisponibles')).toBeTruthy();
    expect(api.confirmAutomationTask).not.toHaveBeenCalled();
  });

  it('arrête un lot partiel quand une source a changé et indique le résultat incertain', async () => {
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: 'rule', category, data: { name: 'Relance', status: 'actif', trigger: 'panier_abandonne', delayDays: 0 }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return { records: [1, 2, 3].map((n) => ({ id: `cart-${n}`, category, data: { reference: `CMD-${n}`, status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' })) };
      return { records: [] };
    });
    api.confirmAutomationTask.mockResolvedValueOnce({ taskId: 'first', created: true }).mockRejectedValueOnce(new Error('La règle ou sa source a changé.'));
    render(<MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    await screen.findByText('Relance');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    const dialog = await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    expect(dialog.textContent).toContain('3 tâche(s)');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la génération' }));
    expect(await screen.findByText(/1 tâche\(s\) créée\(s\).*avant l’interruption/)).toBeTruthy();
    expect(screen.getByText(/résultat de la dernière tâche est inconnu/)).toBeTruthy();
    expect(api.confirmAutomationTask).toHaveBeenCalledTimes(2);
    expect(api.createModuleRecord).not.toHaveBeenCalled();
  });

  it('ne considère pas une réponse de confirmation malformée comme une création', async () => {
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: 'rule', category, data: { name: 'Relance', status: 'actif', trigger: 'panier_abandonne' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return { records: [1, 2].map((n) => ({ id: `cart-${n}`, category, data: { reference: `CMD-${n}`, status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' })) };
      return { records: [] };
    });
    api.confirmAutomationTask.mockResolvedValueOnce({ taskId: '', created: true });
    render(<MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    await screen.findByText('Relance');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la génération' }));
    expect(await screen.findByText(/Réponse de confirmation invalide/)).toBeTruthy();
    expect(api.confirmAutomationTask).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/0 tâche\(s\) créée\(s\)/)).toBeTruthy();
  });

  it('limite l’aperçu et les créations à 25 en signalant les tâches restantes', async () => {
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: 'rule', category, data: { name: 'Relance', status: 'actif', trigger: 'panier_abandonne' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return { records: Array.from({ length: 28 }, (_, n) => ({ id: `cart-${n}`, category, data: { reference: `CMD-${n}`, status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' })) };
      if (category === 'bg_module_operations_manager') return { records: [{ id: 'known', category, data: { sourcePlaybookId: 'rule', sourceRecordId: 'cart-0' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      return { records: [] };
    });
    render(<MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    await screen.findByText('Relance');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    const dialog = await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    expect(dialog.querySelectorAll('li')).toHaveLength(25);
    expect(dialog.textContent).toContain('1 tâche(s) déjà présentes');
    expect(dialog.textContent).toContain('2 tâche(s) restantes');
    expect(dialog.textContent).not.toContain('Relance · CMD-0');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la génération' }));
    expect(await screen.findByText(/25 tâche\(s\) créée\(s\)/)).toBeTruthy();
    expect(api.confirmAutomationTask).toHaveBeenCalledTimes(25);
  });

  it('compte séparément une tâche devenue présente entre aperçu et confirmation', async () => {
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: 'rule', category, data: { name: 'Relance', status: 'actif', trigger: 'panier_abandonne' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return { records: [{ id: 'cart', category, data: { reference: 'CMD', status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      return { records: [] };
    });
    api.confirmAutomationTask.mockResolvedValueOnce({ taskId: 'existing-task', created: false });
    render(<MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    await screen.findByText('Relance');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la génération' }));
    expect(await screen.findByText(/0 tâche\(s\) créée\(s\), 1 déjà présente/)).toBeTruthy();
  });

  it('ne lance pas la tâche suivante après un changement d’entreprise pendant le lot', async () => {
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: 'rule', category, data: { name: 'Relance', status: 'actif', trigger: 'panier_abandonne' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return { records: [1, 2].map((n) => ({ id: `cart-${n}`, category, data: { reference: `CMD-${n}`, status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' })) };
      return { records: [] };
    });
    let finish!: (result: { taskId: string; created: boolean }) => void;
    api.confirmAutomationTask.mockImplementationOnce(async () => new Promise((resolve) => { finish = resolve; }));
    const ui = () => <MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>;
    const view = render(ui());
    await screen.findByText('Relance');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la génération' }));
    await waitFor(() => expect(api.confirmAutomationTask).toHaveBeenCalledTimes(1));
    auth.workspaceId = 'workspace-2';
    view.rerender(ui());
    await act(async () => { finish({ taskId: 'first', created: true }); });
    expect(api.confirmAutomationTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/tâche\(s\) créée\(s\)/)).toBeNull();
  });

  it('ignore les doubles clics pendant la préparation et la confirmation', async () => {
    let releaseSource!: (value: { records: unknown[] }) => void;
    let releaseConfirmation!: (value: { taskId: string; created: boolean }) => void;
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: 'rule', category, data: { name: 'Relance', status: 'actif', trigger: 'panier_abandonne' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return new Promise((resolve) => { releaseSource = resolve; });
      return { records: [] };
    });
    api.confirmAutomationTask.mockImplementationOnce(async () => new Promise((resolve) => { releaseConfirmation = resolve; }));
    render(<MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    await screen.findByText('Relance');
    const prepare = screen.getByRole('button', { name: 'Générer les tâches' });
    act(() => { prepare.click(); prepare.click(); });
    expect(api.listModuleRecords.mock.calls.filter(([category]) => category === 'bg_module_order_cart_recovery')).toHaveLength(1);
    expect((prepare as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { releaseSource({ records: [{ id: 'cart', category: 'bg_module_order_cart_recovery', data: { reference: 'CMD', status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] }); });
    await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    expect(api.confirmAutomationTask).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Confirmer la génération' });
    act(() => { confirm.click(); confirm.click(); });
    expect(api.confirmAutomationTask).toHaveBeenCalledTimes(1);
    await act(async () => { releaseConfirmation({ taskId: 'task', created: true }); });
    expect(await screen.findByText(/1 tâche\(s\) créée\(s\)/)).toBeTruthy();
    expect(api.confirmAutomationTask).toHaveBeenCalledTimes(1);
  });

  it('ne présente pas un aperçu de l’ancienne entreprise après son changement', async () => {
    let releaseOldSource!: (value: { records: unknown[] }) => void;
    api.listModuleRecords.mockImplementation(async (category, workspace) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: `rule-${workspace}`, category, data: { name: workspace === 'workspace-1' ? 'Règle A' : 'Règle B', status: 'actif', trigger: 'panier_abandonne' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery' && workspace === 'workspace-1') return new Promise((resolve) => { releaseOldSource = resolve; });
      return { records: [] };
    });
    const ui = () => <MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>;
    const view = render(ui());
    await screen.findByText('Règle A');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    await waitFor(() => expect(api.listModuleRecords).toHaveBeenCalledWith('bg_module_order_cart_recovery', 'workspace-1'));
    auth.workspaceId = 'workspace-2';
    view.rerender(ui());
    expect(await screen.findByText('Règle B')).toBeTruthy();
    await act(async () => { releaseOldSource({ records: [{ id: 'cart-a', category: 'bg_module_order_cart_recovery', data: { reference: 'Donnée entreprise A', status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] }); });
    expect(screen.queryByRole('dialog', { name: 'Vérifier les tâches proposées' })).toBeNull();
    expect(screen.queryByText(/Donnée entreprise A/)).toBeNull();
    expect(api.confirmAutomationTask).not.toHaveBeenCalled();
  });

  it('ferme l’aperçu ouvert lors d’un changement d’entreprise sans créer de tâche', async () => {
    api.listModuleRecords.mockImplementation(async (category, workspace) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: `rule-${workspace}`, category, data: { name: workspace === 'workspace-1' ? 'Règle A' : 'Règle B', status: 'actif', trigger: 'panier_abandonne' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return { records: [{ id: 'cart', category, data: { reference: 'CMD', status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      return { records: [] };
    });
    const ui = () => <MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>;
    const view = render(ui());
    await screen.findByText('Règle A');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    const dialog = await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    expect(dialog.textContent).toContain('Règle A · CMD');
    auth.workspaceId = 'workspace-2';
    view.rerender(ui());
    await screen.findByText('Règle B');
    expect(screen.queryByRole('dialog', { name: 'Vérifier les tâches proposées' })).toBeNull();
    expect(api.confirmAutomationTask).not.toHaveBeenCalled();
  });

  it('signale des sources potentiellement tronquées même après la confirmation', async () => {
    let eligible = true;
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: 'rule', category, data: { name: 'Relance', status: 'actif', trigger: 'panier_abandonne' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return { records: Array.from({ length: 500 }, (_, n) => ({ id: `cart-${n}`, category, data: { reference: `CMD-${n}`, status: eligible && n === 0 ? 'panier' : 'recupere' }, created_at: '2026-11-12', updated_at: '2026-11-12' })) };
      return { records: [] };
    });
    render(<MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    await screen.findByText('Relance');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    const dialog = await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    expect(dialog.querySelectorAll('li')).toHaveLength(1);
    expect(dialog.textContent).toContain('Limite de 500 enregistrements');
    expect(dialog.textContent).toContain('l’aperçu peut être incomplet');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la génération' }));
    expect(await screen.findByText(/1 tâche\(s\) créée\(s\).*l’aperçu peut être incomplet/)).toBeTruthy();
    expect(api.confirmAutomationTask).toHaveBeenCalledTimes(1);
    eligible = false;
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    expect(await screen.findByText(/Aucune nouvelle tâche à générer.*l’aperçu peut être incomplet/)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Vérifier les tâches proposées' })).toBeNull();
    expect(api.confirmAutomationTask).toHaveBeenCalledTimes(1);
  });

  it('signale une capacité consommée entre l’aperçu et la confirmation sans rejouer le lot', async () => {
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: 'rule', category, data: { name: 'Relance', status: 'actif', trigger: 'panier_abandonne' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return { records: [1, 2, 3].map((n) => ({ id: `cart-${n}`, category, data: { reference: `CMD-${n}`, status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' })) };
      return { records: [] };
    });
    api.confirmAutomationTask.mockResolvedValueOnce({ taskId: 'first', created: true }).mockRejectedValueOnce(new Error('Limite de stockage atteinte pour cette entreprise.'));
    render(<MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    await screen.findByText('Relance');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la génération' }));
    expect(await screen.findByText(/1 tâche\(s\) créée\(s\).*Limite de stockage atteinte/)).toBeTruthy();
    expect(screen.getByText(/aucune écriture n’a été rejouée automatiquement/)).toBeTruthy();
    expect(api.confirmAutomationTask).toHaveBeenCalledTimes(2);
  });

  it('tient compte de la capacité restante et refuse un Operations Manager plein', async () => {
    let count = 498;
    api.listModuleRecords.mockImplementation(async (category) => {
      if (category === 'bg_module_sales_automation') return { records: [{ id: 'rule', category, data: { name: 'Relance', status: 'actif', trigger: 'panier_abandonne' }, created_at: '2026-11-12', updated_at: '2026-11-12' }] };
      if (category === 'bg_module_order_cart_recovery') return { records: [1, 2, 3].map((n) => ({ id: `cart-${n}`, category, data: { reference: `CMD-${n}`, status: 'panier' }, created_at: '2026-11-12', updated_at: '2026-11-12' })) };
      if (category === 'bg_module_operations_manager') return { records: Array.from({ length: count }, (_, n) => ({ id: `existing-${n}`, category, data: { status: 'a_faire' }, created_at: '2026-11-12', updated_at: '2026-11-12' })) };
      return { records: [] };
    });
    render(<MemoryRouter initialEntries={['/app/business/modules/sales-automation']}><Routes><Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} /></Routes></MemoryRouter>);
    await screen.findByText('Relance');
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    const dialog = await screen.findByRole('dialog', { name: 'Vérifier les tâches proposées' });
    expect(dialog.querySelectorAll('li')).toHaveLength(2);
    expect(dialog.textContent).toContain('Capacité estimée : 2');
    expect(dialog.textContent).toContain('1 tâche(s) restantes');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    count = 500;
    fireEvent.click(screen.getByRole('button', { name: 'Générer les tâches' }));
    expect(await screen.findByText(/Operations Manager a atteint sa limite de 500/)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Vérifier les tâches proposées' })).toBeNull();
    expect(api.confirmAutomationTask).not.toHaveBeenCalled();
  });

  it('prépare un brief agent avec le contexte réel du module', async () => {
    api.listModuleRecords.mockResolvedValueOnce({
      records: [{
        id: 'lead-agent-1',
        category: 'bg_module_lead_rescue',
        data: { name: 'Fatoumata Diallo', company: 'Éclat Bamako', estimatedValue: 185000, lastContactAt: '2026-11-11', status: 'nouveau' },
        created_at: '2026-11-11T09:00:00Z',
        updated_at: '2026-11-12T09:00:00Z',
      }],
    });
    render(
      <MemoryRouter initialEntries={['/app/business/modules/lead-rescue']}>
        <Routes>
          <Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} />
          <Route path="/app/business" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Fatoumata Diallo');
    fireEvent.click(screen.getByRole('button', { name: /Demander à l’agent/i }));
    const probe = await screen.findByTestId('location-state');
    const state = JSON.parse(probe.textContent || '{}');
    expect(state.businessGrowIntent.section).toBe('chat');
    expect(state.businessGrowIntent.initialDraft).toContain('Analyse mes leads');
    expect(state.businessGrowIntent.initialDraft).not.toContain('Fatoumata Diallo');
    expect(state.businessGrowIntent.initialDraft).not.toContain('Éclat Bamako');
    expect(state.businessGrowIntent.initialDraft).toContain('185');
    expect(state.businessGrowIntent.initialDraft).toContain('Aucun nom, contact, message ou note');
  });

  it('ne copie pas le client ou son message dans le brouillon de support', async () => {
    api.listModuleRecords.mockResolvedValueOnce({ records: [{ id: 's1', category: 'bg_module_customer_support_ai', data: {
      subject: 'Objet privé', customer: 'Awa privée', channel: 'email', priority: 'haute', message: 'message confidentiel', status: 'ouvert',
    }, created_at: '2026-11-12T00:00:00Z', updated_at: '2026-11-12T00:00:00Z' }] });
    render(<MemoryRouter initialEntries={['/app/business/modules/customer-support-ai']}><Routes>
      <Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} />
      <Route path="/app/business" element={<LocationProbe />} />
    </Routes></MemoryRouter>);
    await screen.findByText('Objet privé');
    fireEvent.click(screen.getByRole('button', { name: 'Préparer avec l’agent' }));
    const state = JSON.parse((await screen.findByTestId('location-state')).textContent || '{}');
    const draft = state.businessGrowIntent.initialDraft;
    expect(draft).not.toContain('Awa privée');
    expect(draft).not.toContain('Objet privé');
    expect(draft).not.toContain('message confidentiel');
    expect(draft).toContain('résumé anonymisé');
    expect(draft).toContain('priorité : Haute');
  });

  it('refuse un module inconnu sans appeler le backend', async () => {
    render(
      <MemoryRouter initialEntries={['/app/business/modules/inconnu']}>
        <Routes>
          <Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Module introuvable')).toBeTruthy();
    expect(api.listModuleRecords).not.toHaveBeenCalled();
  });
});
