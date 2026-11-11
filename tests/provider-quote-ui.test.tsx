// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProviderQuotePanel, formatUsdQuote } from '../src/studio/components/ProviderQuotePanel';
import type { ProviderQuote } from '../src/lib/types';

afterEach(() => cleanup());

function quote(overrides: Partial<ProviderQuote> = {}): ProviderQuote {
  return {
    available: true,
    cost_usd: 1.87,
    currency: 'USD',
    source: 'provider_estimate',
    error_code: null,
    error_message: null,
    checked_at: '2026-11-11T12:00:00.000Z',
    catalog_synced_at: '2026-11-11T10:00:00.000Z',
    stale_catalog: false,
    pricing_basis: { duration: 5, resolution: '720p' },
    billing_units: ['duration', 'resolution'],
    estimate_endpoint_available: true,
    ...overrides,
  };
}

describe('Devis fournisseur dans le Studio', () => {
  it('affiche le montant USD exact et la base tarifaire sans détail technique', () => {
    const { container } = render(<ProviderQuotePanel quote={quote()} />);
    expect(screen.getByTestId('provider-quote-available')).toBeTruthy();
    expect(screen.getByText('Devis fournisseur vérifié')).toBeTruthy();
    expect(screen.getByText(/1,87/)).toBeTruthy();
    expect(screen.getByText(/durée : 5/)).toBeTruthy();
    expect(screen.getByText(/résolution : 720p/)).toBeTruthy();
    expect(container.textContent).not.toContain('seedance');
    expect(container.textContent).not.toContain('estimate-cost');
  });

  it('signale explicitement un devis indisponible et n’affiche aucun montant', () => {
    const { container } = render(<ProviderQuotePanel quote={quote({
      available: false, cost_usd: null, currency: null, source: 'none',
      error_code: 'PROVIDER_UNAVAILABLE', error_message: 'Le fournisseur est momentanément indisponible.',
    })} />);
    expect(screen.getByTestId('provider-quote-unavailable')).toBeTruthy();
    expect(screen.getByText(/Devis indisponible/)).toBeTruthy();
    expect(screen.getByText(/PROVIDER_UNAVAILABLE/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/\d+,\d{2}\s*\$/);
  });

  it('propose un recalcul réel et remonte l’état de chargement', () => {
    const onRefresh = vi.fn();
    render(<ProviderQuotePanel quote={quote()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: /Recalculer le devis fournisseur/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    cleanup();
    render(<ProviderQuotePanel quote={null} busy onRefresh={onRefresh} />);
    expect(screen.getByTestId('provider-quote-loading')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Recalculer le devis fournisseur/i })).toBeNull();
  });

  it('avertit quand le tarif catalogue n’est pas frais', () => {
    render(<ProviderQuotePanel quote={quote({ source: 'catalog_tariff', catalog_synced_at: null, stale_catalog: true })} />);
    expect(screen.getByText(/tarif à revérifier/i)).toBeTruthy();
  });

  it('formate les montants en français avec un maximum de 4 décimales', () => {
    expect(formatUsdQuote(0.02)).toMatch(/0,02/);
    expect(formatUsdQuote(9.35)).toMatch(/9,35/);
    expect(formatUsdQuote(1.234567)).toMatch(/1,2346/);
  });

  it('affiche une erreur de chargement sans inventer de valeur', () => {
    render(<ProviderQuotePanel quote={null} error="Impossible de joindre le service de devis." />);
    expect(screen.getByTestId('provider-quote-error')).toBeTruthy();
    expect(screen.getByText(/Impossible de joindre/)).toBeTruthy();
  });
});
