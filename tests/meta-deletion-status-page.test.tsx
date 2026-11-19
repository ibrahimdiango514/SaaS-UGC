// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Page publique de suivi d'une demande de suppression Meta.
 *
 * ## Ce que ces tests protègent
 * Meta exige une page PUBLIQUE qui indique si une suppression est **en attente**
 * ou **terminée**, à partir du code de confirmation. Les points sensibles :
 *
 * - chaque état est distingué (terminé / en attente / rien à supprimer), car
 *   afficher « terminé » à tort est un mensonge sur une suppression de données ;
 * - une panne réseau ne doit JAMAIS ressembler à « aucune demande » ;
 * - la page n'affiche jamais le code ni d'identifiant dans son contenu.
 */

import DeletionStatusPage from '../src/pages/DeletionStatus';

const CODE = 'vyora-0123456789abcdef0123456789abcdef';

function monter(route = `/confidentialite/suivi?code=${CODE}`) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <DeletionStatusPage />
    </MemoryRouter>,
  );
}

function repondre(corps: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(corps), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); });

describe('page de suivi — états affichés', () => {
  it('affiche « demande traitée » quand la suppression est terminée', async () => {
    vi.stubGlobal('fetch', repondre({
      status: 'completed',
      requestedAt: '2026-11-14T10:00:00.000Z',
      completedAt: '2026-11-14T10:00:01.000Z',
      hasFailure: false,
    }));
    monter();
    await waitFor(() => expect(screen.getByText('Demande traitée')).toBeTruthy());
    // Le détail compte : la personne doit savoir CE QUI a été supprimé.
    expect(screen.getByText(/connexions, jetons d’accès/i)).toBeTruthy();
  });

  it('affiche « en attente » quand la demande n’est pas terminée', async () => {
    vi.stubGlobal('fetch', repondre({
      status: 'pending',
      requestedAt: '2026-11-14T10:00:00.000Z',
      completedAt: null,
      hasFailure: false,
    }));
    monter();
    await waitFor(() => expect(screen.getByText(/en attente de traitement/i)).toBeTruthy());
    // Ne jamais afficher « terminé » sur une demande en cours.
    expect(screen.queryByText('Demande traitée')).toBeNull();
  });

  it('distingue « aucune donnée à supprimer » de « terminé »', async () => {
    vi.stubGlobal('fetch', repondre({
      status: 'no_data',
      requestedAt: '2026-11-14T10:00:00.000Z',
      completedAt: null,
      hasFailure: false,
    }));
    monter();
    await waitFor(() => expect(screen.getByText(/Aucune donnée à supprimer/i)).toBeTruthy());
    expect(screen.queryByText('Demande traitée')).toBeNull();
  });
});

describe('page de suivi — cas d’erreur', () => {
  it('affiche un message dédié pour un code inconnu (404)', async () => {
    vi.stubGlobal('fetch', repondre({ ok: false, error: 'inconnu' }, 404));
    monter();
    await waitFor(() => expect(screen.getByText(/Aucune demande ne correspond à ce code/i)).toBeTruthy());
  });

  it('affiche « code invalide » pour un code mal formé (400)', async () => {
    vi.stubGlobal('fetch', repondre({ ok: false }, 400));
    monter();
    await waitFor(() => expect(screen.getByText(/Code invalide/i)).toBeTruthy());
  });

  it('une panne réseau ne ressemble JAMAIS à « demande inexistante »', async () => {
    // Le défaut le plus grave possible : faire croire à une suppression
    // inexistante alors que la demande est peut-être enregistrée.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('réseau'); }));
    monter();
    await waitFor(() => expect(screen.getByText(/Vérification impossible/i)).toBeTruthy());
    expect(screen.queryByText(/Aucune demande ne correspond/i)).toBeNull();
  });

  it('une erreur serveur (500) n’annonce ni succès ni absence', async () => {
    vi.stubGlobal('fetch', repondre({ ok: false }, 500));
    monter();
    await waitFor(() => expect(screen.getByText(/Vérification impossible/i)).toBeTruthy());
  });

  it('sans code dans l’URL, explique quoi faire au lieu d’échouer', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    monter('/confidentialite/suivi');
    await waitFor(() => expect(screen.getByText(/Aucun code fourni/i)).toBeTruthy());
    // Aucun appel réseau inutile.
    expect(f).not.toHaveBeenCalled();
  });
});

describe('page de suivi — confidentialité', () => {
  it('interroge la route publique avec le code, en GET', async () => {
    const f = repondre({ status: 'completed', requestedAt: null, completedAt: null, hasFailure: false });
    vi.stubGlobal('fetch', f);
    monter();
    await waitFor(() => expect(screen.getByText('Demande traitée')).toBeTruthy());
    const appels = (f as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;
    const url = appels[0][0];
    expect(url).toContain('/functions/v1/meta-lifecycle/deletion-status');
    expect(url).toContain(encodeURIComponent(CODE));
    // Le code doit être correctement encodé : il ne contient que des caractères
    // sûrs aujourd'hui, mais la page ne doit pas dépendre de ce détail.
    expect(url).toContain(`code=${encodeURIComponent(CODE)}`);
  });

  it('n’affiche jamais le code de confirmation dans le corps de page', async () => {
    vi.stubGlobal('fetch', repondre({
      status: 'completed',
      requestedAt: '2026-11-14T10:00:00.000Z',
      completedAt: '2026-11-14T10:00:01.000Z',
      hasFailure: false,
    }));
    const { container } = monter();
    await waitFor(() => expect(screen.getByText('Demande traitée')).toBeTruthy());
    // Le code est déjà dans l'URL : le recopier élargirait sa trace (captures
    // d'écran, historique, copier-coller).
    expect(container.textContent).not.toContain(CODE);
  });

  it('signale une tentative antérieure échouée sans alarmer', async () => {
    vi.stubGlobal('fetch', repondre({
      status: 'completed',
      requestedAt: '2026-11-14T10:00:00.000Z',
      completedAt: '2026-11-14T10:00:01.000Z',
      hasFailure: true,
    }));
    monter();
    await waitFor(() => expect(screen.getByText(/tentative antérieure n’a pas abouti/i)).toBeTruthy());
    // Et la demande reste annoncée comme terminée : c'est la vérité.
    expect(screen.getByText('Demande traitée')).toBeTruthy();
  });
});
