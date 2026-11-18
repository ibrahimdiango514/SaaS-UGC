// @vitest-environment jsdom
/**
 * Section « Variantes » d'une fiche produit — comportement visible.
 *
 * Ce qui est protégé ici :
 *   - l'ordre de la source est conservé (« S, M, L » ne devient pas « L, M, S ») ;
 *   - une variante retirée reste visible, avec le moyen de la remettre en vente ;
 *   - en lecture seule (abonnement expiré), la consultation marche et les
 *     actions d'écriture disparaissent ;
 *   - un prix hérité est annoncé comme tel, jamais comme « 0 ».
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  createVariant: vi.fn(),
  updateVariant: vi.fn(),
  setVariantActive: vi.fn(),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));

vi.mock('../src/business/importer/variants', () => api);
vi.mock('../src/context/ToastContext', () => ({ useToast: () => toast }));

import { ProductVariantsSection } from '../src/business/importer/ProductVariantsSection';
import type { ProductVariant } from '../src/business/importer/variants-model';

const variante = (surcharge: Partial<ProductVariant> = {}): ProductVariant => ({
  id: 'v-s', product_id: 'p1', attribute_name: 'Taille', attribute_value: 'S',
  sku: 'TSH-S', price_amount: 12000, price_currency: 'XOF', stock: 10,
  available: true, active: true, position: 0, ...surcharge,
});

const base = {
  productId: 'p1',
  productName: 'T-shirt coton',
  productPrice: 12000,
  productCurrency: 'XOF',
  readOnly: false,
  onChanged: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('ordre et contenu', () => {
  it('conserve l’ordre de la source', () => {
    render(
      <ProductVariantsSection
        {...base}
        variants={[
          variante({ id: 'v-l', attribute_value: 'L', position: 2 }),
          variante({ id: 'v-s', attribute_value: 'S', position: 0 }),
          variante({ id: 'v-m', attribute_value: 'M', position: 1 }),
        ]}
      />,
    );
    const lignes = screen.getAllByTestId(/^variant-row-/);
    expect(lignes.map((l) => l.getAttribute('data-testid'))).toEqual(['variant-row-v-s', 'variant-row-v-m', 'variant-row-v-l']);
  });

  it('affiche une variante retirée et propose de la remettre en vente', () => {
    render(<ProductVariantsSection {...base} variants={[variante({ active: false })]} />);
    expect(screen.getByText('Retirée')).toBeTruthy();
    expect(screen.getByLabelText('Remettre S')).toBeTruthy();
  });

  it('annonce un prix hérité plutôt que « 0 »', () => {
    render(<ProductVariantsSection {...base} variants={[variante({ price_amount: null })]} />);
    expect(screen.getByText(/Prix du produit/)).toBeTruthy();
    expect(screen.queryByText(/^0/)).toBeNull();
  });

  it('signale un stock inconnu sans le confondre avec une rupture', () => {
    render(<ProductVariantsSection {...base} variants={[variante({ stock: null })]} />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('Rupture')).toBeNull();
  });

  it('dit explicitement quand il n’y a aucune variante', () => {
    render(<ProductVariantsSection {...base} variants={[]} />);
    expect(screen.getByText(/Aucune variante/)).toBeTruthy();
  });
});

describe('lecture seule', () => {
  it('laisse consulter mais retire les actions d’écriture', () => {
    render(<ProductVariantsSection {...base} readOnly variants={[variante()]} />);
    // La donnée reste lisible.
    expect(screen.getByText('S')).toBeTruthy();
    // Le formatage monétaire utilise une espace insécable : on cherche le
    // montant, pas la chaîne exacte.
    expect(screen.getByText(/12\s*000/)).toBeTruthy();
    // Plus aucun moyen d'écrire.
    expect(screen.queryByTestId('variant-add-p1')).toBeNull();
    expect(screen.getByText(/Lecture seule/)).toBeTruthy();
  });

  it('désactive les boutons de ligne au lieu de les cacher', () => {
    render(<ProductVariantsSection {...base} readOnly variants={[variante()]} />);
    const modifier = screen.getByLabelText('Modifier S') as HTMLButtonElement;
    const retirer = screen.getByLabelText('Retirer S') as HTMLButtonElement;
    expect(modifier.disabled).toBe(true);
    expect(retirer.disabled).toBe(true);
  });
});

describe('écriture', () => {
  it('ajoute une variante et recharge le catalogue', async () => {
    api.createVariant.mockResolvedValue(variante({ id: 'v-new', attribute_value: 'XL' }));
    render(<ProductVariantsSection {...base} variants={[]} />);

    fireEvent.click(screen.getByTestId('variant-add-p1'));
    fireEvent.change(screen.getByTestId('variant-attribute-value'), { target: { value: 'XL' } });
    fireEvent.change(screen.getByTestId('variant-stock'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('variant-save'));

    await waitFor(() => expect(api.createVariant).toHaveBeenCalledTimes(1));
    expect(api.createVariant).toHaveBeenCalledWith('p1', expect.objectContaining({
      attribute_value: 'XL', stock: 4, price_amount: null,
    }));
    await waitFor(() => expect(base.onChanged).toHaveBeenCalled());
  });

  it('n’appelle pas le serveur quand l’option est vide', async () => {
    render(<ProductVariantsSection {...base} variants={[]} />);
    fireEvent.click(screen.getByTestId('variant-add-p1'));
    fireEvent.click(screen.getByTestId('variant-save'));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(api.createVariant).not.toHaveBeenCalled();
  });

  it('retire une variante sans la supprimer', async () => {
    api.setVariantActive.mockResolvedValue(false);
    render(<ProductVariantsSection {...base} variants={[variante()]} />);

    fireEvent.click(screen.getByLabelText('Retirer S'));

    await waitFor(() => expect(api.setVariantActive).toHaveBeenCalledWith('v-s', false));
    await waitFor(() => expect(base.onChanged).toHaveBeenCalled());
  });

  it('traduit un doublon d’option en message compréhensible', async () => {
    api.createVariant.mockRejectedValue(new Error('DUPLICATE_OPTION'));
    render(<ProductVariantsSection {...base} variants={[]} />);

    fireEvent.click(screen.getByTestId('variant-add-p1'));
    fireEvent.change(screen.getByTestId('variant-attribute-value'), { target: { value: 'M' } });
    fireEvent.click(screen.getByTestId('variant-save'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cette option existe déjà pour ce produit.'));
  });
});
