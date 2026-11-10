// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Settings from '../src/pages/Settings';

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  updateBrand: vi.fn(),
  updateProduct: vi.fn(),
  listBrands: vi.fn(),
  listProducts: vi.fn(),
  getMembers: vi.fn(),
  healthCheck: vi.fn(),
  updateProfile: vi.fn(),
  updateWorkspace: vi.fn(),
  state: {
    productName: 'Produit Réel',
    description: 'Description initiale',
    benefits: ['Hydrate'],
    auth: {
      user: { id: 'user-1', email: 'user@example.test', created_at: '2026-01-01' },
      profile: { display_name: 'User', country_code: 'ML', preferred_language: 'fr' },
      workspace: {
        id: 'workspace-1', owner_user_id: 'user-1', name: 'Workspace', country_code: 'ML',
        default_language: 'fr', created_at: '2026-01-01', updated_at: '2026-01-01',
      },
      refreshAll: vi.fn(),
    },
  },
}));

vi.mock('../src/context/ToastContext', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error, warning: mocks.warning, info: vi.fn() }),
}));

vi.mock('../src/context/AuthContext', () => {
  return { useAuth: () => mocks.state.auth };
});

vi.mock('../src/lib/api', () => ({
  createBrand: vi.fn(),
  createProduct: vi.fn(),
  deleteBrand: vi.fn(),
  deleteProduct: vi.fn(),
  getMembers: mocks.getMembers,
  healthCheck: mocks.healthCheck,
  listBrands: mocks.listBrands,
  listProducts: mocks.listProducts,
  updateBrand: mocks.updateBrand,
  updateEmail: vi.fn(),
  updatePassword: vi.fn(),
  updateProduct: mocks.updateProduct,
  updateProfile: mocks.updateProfile,
  updateWorkspace: mocks.updateWorkspace,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.productName = 'Produit Réel';
  mocks.state.description = 'Description initiale';
  mocks.state.benefits = ['Hydrate'];
  mocks.state.auth = {
    user: { id: 'user-1', email: 'user@example.test', created_at: '2026-01-01' },
    profile: { display_name: 'User', country_code: 'ML', preferred_language: 'fr' },
    workspace: {
      id: 'workspace-1', owner_user_id: 'user-1', name: 'Workspace', country_code: 'ML',
      default_language: 'fr', created_at: '2026-01-01', updated_at: '2026-01-01',
    },
    refreshAll: vi.fn(),
  };
  mocks.getMembers.mockResolvedValue([]);
  mocks.listBrands.mockResolvedValue([]);
  mocks.listProducts.mockImplementation(async () => [{
    id: 'product-1', workspace_id: 'workspace-1', brand_id: null,
    name: mocks.state.productName, description: mocks.state.description,
    key_benefits: mocks.state.benefits, features: [], price_amount: null, price_currency: null,
    product_url: null, reference_image_paths: [], product_facts: {},
    created_at: '2026-01-01', updated_at: '2026-01-01',
  }]);
  mocks.healthCheck.mockResolvedValue({ configured: { groq: false, muapi: false, worker: false, supabase: true } });
  mocks.updateProduct.mockImplementation(async (_id: string, patch: { name: string; description: string; key_benefits: string[] }) => {
    mocks.state.productName = patch.name;
    mocks.state.description = patch.description;
    mocks.state.benefits = patch.key_benefits;
  });
});

afterEach(cleanup);

describe('Gestion persistante du catalogue métier', () => {
  it('enregistre le profil Reelora avant d’afficher une confirmation', async () => {
    render(<MemoryRouter><Settings /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('Nom affiché'), { target: { value: 'Aïssata' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le profil' }));

    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledWith('user-1', {
      display_name: 'Aïssata',
      country_code: 'ML',
      preferred_language: 'fr',
    }));
    expect(mocks.success).toHaveBeenCalledWith('Profil mis à jour.');
  });

  it('n’affiche pas de confirmation si la mise à jour de l’espace échoue', async () => {
    mocks.updateWorkspace.mockRejectedValueOnce(new Error('Workspace update denied'));
    render(<MemoryRouter><Settings /></MemoryRouter>);
    await screen.findByLabelText('Nom affiché');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Espace de travail' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Workspace update denied'));
    expect(mocks.success).not.toHaveBeenCalledWith('Espace de travail mis à jour.');
  });

  it('modifie et recharge un produit via l’opération Supabase avant de confirmer', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Settings /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Marques & produits' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier Produit Réel' }));

    fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Produit mis à jour' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Nouvelle description' } });
    fireEvent.change(screen.getByLabelText('Bénéfices clés (un par ligne)'), { target: { value: 'Hydrate\nProtège' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le produit' }));

    await waitFor(() => expect(mocks.updateProduct).toHaveBeenCalledWith('product-1', {
      name: 'Produit mis à jour',
      description: 'Nouvelle description',
      key_benefits: ['Hydrate', 'Protège'],
      features: [],
      price_amount: null,
      price_currency: null,
      product_url: null,
    }));
    expect(await screen.findByText('Produit mis à jour')).toBeTruthy();
    expect(mocks.success).toHaveBeenCalledWith('Produit mis à jour.');
  });

  it('ne confirme pas l’enregistrement lorsque la persistance échoue', async () => {
    const user = userEvent.setup();
    mocks.updateProduct.mockRejectedValueOnce(new Error('RLS denied'));
    render(<MemoryRouter><Settings /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Marques & produits' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier Produit Réel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le produit' }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('RLS denied'));
    expect(mocks.success).not.toHaveBeenCalledWith('Produit mis à jour.');
  });

  it('présente les connecteurs prévus comme non connectés tant que l’autorisation réelle manque', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Settings /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Intégrations' }));

    expect(await screen.findByTestId('integration-facebook')).toBeTruthy();
    expect(screen.getByTestId('integration-shopify').textContent).toContain('Non connecté');
    expect(screen.getByTestId('integration-woocommerce').textContent).toContain('Non connecté');
    expect(screen.getByText('Pas de connexions simulées')).toBeTruthy();
  });

  it('ignore les résultats retardés du catalogue de l’espace précédent', async () => {
    let resolveOldBrands!: (brands: unknown[]) => void;
    mocks.listBrands.mockImplementation((workspaceId: string) => {
      if (workspaceId === 'workspace-1') {
        return new Promise((resolve) => { resolveOldBrands = resolve; });
      }
      return Promise.resolve([{ id: 'brand-new', name: 'Nouvelle marque', industry: null }]);
    });

    const view = render(<MemoryRouter><Settings /></MemoryRouter>);
    await waitFor(() => expect(mocks.listBrands).toHaveBeenCalledWith('workspace-1'));

    mocks.state.auth = {
      user: { id: 'user-2', email: 'second@example.test', created_at: '2026-02-01' },
      profile: { display_name: 'Second user', country_code: 'FR', preferred_language: 'fr' },
      workspace: {
        id: 'workspace-2', owner_user_id: 'user-2', name: 'Second workspace', country_code: 'FR',
        default_language: 'fr', created_at: '2026-02-01', updated_at: '2026-02-01',
      },
      refreshAll: vi.fn(),
    };
    view.rerender(<MemoryRouter><Settings /></MemoryRouter>);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Marques & produits' }));
    expect(await screen.findByText('Nouvelle marque')).toBeTruthy();

    resolveOldBrands([{ id: 'brand-old', name: 'Ancienne marque', industry: null }]);
    await waitFor(() => expect(screen.queryByText('Ancienne marque')).toBeNull());
    expect(screen.getByText('Nouvelle marque')).toBeTruthy();
  });
});
