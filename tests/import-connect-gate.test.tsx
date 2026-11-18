// @vitest-environment jsdom
/**
 * Import & Connect — verrouillage de l'interface.
 *
 * Ce que ces tests prouvent, et ce qu'ils ne prouvent pas :
 *   - ils prouvent qu'un non-abonné voit une présentation commerciale et que le
 *     panneau d'import n'est PAS monté (aucun bouton, aucun formulaire, aucun
 *     appel réseau déclenché par un écran inutile) ;
 *   - ils prouvent qu'un abonné obtient le module ;
 *   - ils NE prouvent PAS la sécurité : celle-ci est dans l'Edge Function, et
 *     testée séparément dans `import-connect-subscription.test.ts`. Un client
 *     modifié peut afficher ce qu'il veut ; le serveur refusera quand même.
 *
 * Le point sensible est donc le suivant : quand l'accès est refusé,
 * `StoreImportPanel` ne doit pas exister dans le DOM du tout — pas seulement
 * être grisé.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  /** Réponse de `vyora_import_connect_access`, pilotée par test. */
  rpc: vi.fn(),
  /** Monte-t-on réellement le panneau d'import ? */
  panneauMonte: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({ rpc: mocks.rpc }));
vi.mock('../src/business/importer/StoreImportPanel', () => ({
  StoreImportPanel: (props: { workspaceId?: string }) => {
    mocks.panneauMonte(props.workspaceId);
    return <div data-testid="store-import-panel">panneau d’import</div>;
  },
}));

import { ImportConnectGate } from '../src/business/import-connect/ImportConnectGate';
import { normalizeAccess, accessGuidance, unknownAccess } from '../src/business/import-connect/access';

function rendre(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function acces(partiel: Record<string, unknown>) {
  mocks.rpc.mockResolvedValue(partiel);
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.panneauMonte.mockReset();
});

afterEach(cleanup);

describe('droits d’accès — lecture défensive', () => {
  it('seul un `allowed === true` explicite ouvre l’accès', () => {
    expect(normalizeAccess({ allowed: true }).allowed).toBe(true);
    // Les formes plausibles d'un faux accord envoyé par un client.
    for (const valeur of [undefined, null, 'true', 1, 'yes', {}, []]) {
      expect(normalizeAccess({ allowed: valeur }).allowed).toBe(false);
    }
  });

  it('un motif inconnu est traité comme un refus, pas comme un accord', () => {
    const etat = normalizeAccess({ allowed: false, reason: 'GOD_MODE' });
    expect(etat.reason).toBe('UNKNOWN');
    expect(etat.allowed).toBe(false);
  });

  it('chaque motif produit un message distinct et une action adaptée', () => {
    const cas = ['NO_SUBSCRIPTION', 'PAYMENT_FAILED', 'SUBSCRIPTION_EXPIRED', 'SUBSCRIPTION_CANCELED', 'PLAN_INACTIVE'] as const;
    const titres = new Set<string>();
    for (const reason of cas) {
      const guide = accessGuidance(normalizeAccess({ allowed: false, reason }));
      titres.add(guide.title);
      expect(guide.showSubscribe).toBe(true);
      expect(guide.detail.length).toBeGreaterThan(20);
    }
    // Cinq situations, cinq explications : l'utilisateur sait quoi faire.
    expect(titres.size).toBe(cas.length);
  });

  it('une vérification impossible ne devient pas un accord', () => {
    const guide = accessGuidance(unknownAccess('réseau indisponible'));
    expect(guide.title).toContain('indisponible');
    expect(guide.showSubscribe).toBe(false);
  });
});

describe('interface — non-abonné', () => {
  it('affiche la présentation commerciale et NE MONTE PAS le module', async () => {
    acces({ allowed: false, reason: 'NO_SUBSCRIPTION', message: 'Abonnement requis' });
    rendre(
      <ImportConnectGate>
        <div data-testid="module-reel">contenu réservé</div>
      </ImportConnectGate>,
    );

    await waitFor(() => expect(screen.getByText(/Abonnement Business Ground requis/i)).toBeTruthy());

    // Le contenu réservé n'est pas rendu du tout.
    expect(screen.queryByTestId('module-reel')).toBeNull();
    // Et l'utilisateur voit le chemin de sortie.
    const lien = screen.getByRole('link', { name: /offres Business Ground/i });
    expect(lien.getAttribute('href')).toBe('/app/business/abonnement');
    expect(screen.getByText(/Aucune importation ni connexion n’a été lancée/i)).toBeTruthy();
  });

  it('ne déclenche aucun import quand l’accès est refusé', async () => {
    acces({ allowed: false, reason: 'SUBSCRIPTION_EXPIRED' });
    rendre(<ImportConnectGate><div data-testid="module-reel" /></ImportConnectGate>);
    await waitFor(() => expect(screen.getByText(/Abonnement expiré/i)).toBeTruthy());
    expect(mocks.panneauMonte).not.toHaveBeenCalled();
  });

  it('distingue un paiement en échec d’une simple absence d’abonnement', async () => {
    acces({ allowed: false, reason: 'PAYMENT_FAILED' });
    rendre(<ImportConnectGate><div /></ImportConnectGate>);
    await waitFor(() => expect(screen.getByText(/Paiement de l’abonnement en échec/i)).toBeTruthy());
  });

  it('une panne de vérification affiche « indisponible » et propose de réessayer', async () => {
    mocks.rpc.mockRejectedValue(new Error('réseau indisponible'));
    rendre(<ImportConnectGate><div data-testid="module-reel" /></ImportConnectGate>);

    await waitFor(() => expect(screen.getByText(/Vérification de l’abonnement indisponible/i)).toBeTruthy());
    expect(screen.queryByTestId('module-reel')).toBeNull();
    expect(screen.getByRole('button', { name: /Revérifier/i })).toBeTruthy();
  });
});

describe('interface — abonné', () => {
  it('ouvre le module quand le serveur accorde l’accès', async () => {
    acces({ allowed: true, reason: 'OK', current_period_end: '2027-01-01T00:00:00Z' });
    rendre(<ImportConnectGate><div data-testid="module-reel" /></ImportConnectGate>);
    await waitFor(() => expect(screen.getByTestId('module-reel')).toBeTruthy());
    expect(screen.queryByText(/Abonnement Business Ground requis/i)).toBeNull();
  });

  it('rouvre l’accès après renouvellement, sans recharger la page', async () => {
    mocks.rpc.mockResolvedValueOnce({ allowed: false, reason: 'SUBSCRIPTION_EXPIRED' });
    rendre(<ImportConnectGate><div data-testid="module-reel" /></ImportConnectGate>);
    await waitFor(() => expect(screen.getByText(/Abonnement expiré/i)).toBeTruthy());
    expect(screen.queryByTestId('module-reel')).toBeNull();

    // Le renouvellement est enregistré côté serveur : la relance doit le voir.
    mocks.rpc.mockResolvedValue({ allowed: true, reason: 'OK' });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: /Revérifier/i }));

    await waitFor(() => expect(screen.getByTestId('module-reel')).toBeTruthy());
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
});
