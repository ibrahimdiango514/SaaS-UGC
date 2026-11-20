// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProviderQuotePanel } from '../src/studio/components/ProviderQuotePanel';

afterEach(cleanup);
describe('Devis client', () => {
  it('ne montre pas de coût fournisseur même si une ancienne API en renvoie', () => {
    const legacy = { available: true, error_code: null, cost_usd: 1.87, currency: 'USD', pricing_basis: { price: 3 } };
    const { container } = render(<ProviderQuotePanel quote={legacy} />);
    expect(screen.getByTestId('provider-quote-available')).toBeTruthy();
    expect(container.textContent).not.toMatch(/1[,.]87|USD|fournisseur|price/i);
  });
  it('gère les états et le recalcul', () => {
    const refresh = vi.fn();
    render(<ProviderQuotePanel quote={{ available: false, error_code: 'PROMPT_REQUIRED' }} onRefresh={refresh} />);
    expect(screen.getByText(/Ajoutez une instruction/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Recalculer le devis/i }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
