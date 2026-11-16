// @vitest-environment jsdom
// VYORA Connect — page complète.
//
// Ces tests vérifient le comportement RÉEL de la page face à l'API :
// ce qui s'affiche quand rien n'est configuré, quand un compte existe, quand
// une action échoue. Aucune connexion n'est simulée côté produit : seules les
// réponses de l'API sont mockées, ce qui est inévitable en test unitaire.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchProviderAvailability = vi.fn();
const fetchConnectedAccounts = vi.fn();
const fetchAuditEvents = vi.fn();
const startAuthorization = vi.fn();
const revokeAccount = vi.fn();
const refreshAccount = vi.fn();
const rememberPendingAuthorization = vi.fn();
const readPendingAuthorization = vi.fn();
const clearPendingAuthorization = vi.fn();

vi.mock('../src/integrations/connect-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integrations/connect-api')>();
  return {
    ...actual,
    fetchProviderAvailability: (...args: unknown[]) => fetchProviderAvailability(...args),
    fetchConnectedAccounts: (...args: unknown[]) => fetchConnectedAccounts(...args),
    fetchAuditEvents: (...args: unknown[]) => fetchAuditEvents(...args),
    startAuthorization: (...args: unknown[]) => startAuthorization(...args),
    revokeAccount: (...args: unknown[]) => revokeAccount(...args),
    refreshAccount: (...args: unknown[]) => refreshAccount(...args),
    rememberPendingAuthorization: (...args: unknown[]) => rememberPendingAuthorization(...args),
    readPendingAuthorization: (...args: unknown[]) => readPendingAuthorization(...args),
    clearPendingAuthorization: (...args: unknown[]) => clearPendingAuthorization(...args),
  };
});

import Connect from '../src/pages/Connect';
import { ConnectError } from '../src/integrations/connect-api';

const NOT_CONFIGURED = { google: false, oauth_function: false, encryption: false };
const CONFIGURED = { google: true, oauth_function: true, encryption: true };

function renderPage() {
  return render(
    <MemoryRouter>
      <Connect />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchProviderAvailability.mockResolvedValue(NOT_CONFIGURED);
  fetchConnectedAccounts.mockResolvedValue([]);
  fetchAuditEvents.mockResolvedValue([]);
  readPendingAuthorization.mockReturnValue(null);
  // `window.location.assign` n'existe pas en jsdom de façon assignable : on le
  // remplace par un espion pour vérifier qu'on redirige vers l'URL du serveur.
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    ...window.location,
    assign: vi.fn(),
  } as unknown as Location);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('VYORA Connect / état de configuration réel', () => {
  it('affiche les huit fournisseurs demandés', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Gmail')).toBeTruthy());
    for (const name of [
      'Gmail', 'Google Drive', 'Google Calendar',
      'Instagram', 'Facebook', 'TikTok', 'YouTube', 'WhatsApp Business',
    ]) {
      expect(screen.getByText(name), `${name} absent de la page`).toBeTruthy();
    }
  });

  it('sans identifiants Google, les trois fournisseurs affichent « Configuration requise »', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Gmail')).toBeTruthy());
    const requirementLabels = screen.getAllByText('Configuration requise');
    // Exactement les trois fournisseurs Google, pas les autres.
    expect(requirementLabels).toHaveLength(3);
  });

  it('aucun bouton « Connecter » n’existe quand rien n’est configuré', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Gmail')).toBeTruthy());
    expect(screen.queryAllByRole('button', { name: 'Connecter' })).toHaveLength(0);
  });

  it('explique pourquoi Gmail n’est pas connectable, sans jargon technique', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Gmail')).toBeTruthy());
    const gmailCard = document.querySelector('[data-provider="gmail"]')!;
    expect(gmailCard.textContent).toContain('Identifiants OAuth Google');
    // On n'expose pas les noms de variables d'environnement à l'utilisateur.
    expect(gmailCard.textContent).not.toContain('GOOGLE_CLIENT_SECRET');
  });

  it('les réseaux sociaux affichent « Autorisation fournisseur », pas « Configuration requise »', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Instagram')).toBeTruthy());
    const instagram = document.querySelector('[data-provider="instagram"]')!;
    // Distinction essentielle : ce blocage dépend d'un tiers, pas de nous.
    expect(instagram.textContent).toContain('Autorisation fournisseur');
    expect(instagram.textContent).not.toContain('Configuration requise');
  });

  it('un fournisseur non implémenté reste bloqué même si Google est configuré', async () => {
    fetchProviderAvailability.mockResolvedValue(CONFIGURED);
    renderPage();
    await waitFor(() => expect(screen.getByText('Instagram')).toBeTruthy());
    expect(document.querySelector('[data-provider="instagram"]')!.textContent)
      .toContain('Autorisation fournisseur');
  });

  it('quand Google EST configuré, les trois boutons Connecter apparaissent', async () => {
    fetchProviderAvailability.mockResolvedValue(CONFIGURED);
    renderPage();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connecter' })).toHaveLength(3));
    expect(screen.getAllByText('Disponible')).toHaveLength(3);
  });

  it('une API injoignable ne fait jamais apparaître un faux bouton actif', async () => {
    fetchProviderAvailability.mockResolvedValue(NOT_CONFIGURED);
    fetchConnectedAccounts.mockRejectedValue(new ConnectError('network', 'réseau indisponible'));
    renderPage();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryAllByRole('button', { name: 'Connecter' })).toHaveLength(0);
  });

  it('la réponse du serveur fait autorité : pas de bouton si google=false', async () => {
    // Même si la clé de chiffrement existe, sans identifiants Google c'est non.
    fetchProviderAvailability.mockResolvedValue({ google: false, oauth_function: true, encryption: true });
    renderPage();
    await waitFor(() => expect(screen.getByText('Gmail')).toBeTruthy());
    expect(screen.queryAllByRole('button', { name: 'Connecter' })).toHaveLength(0);
  });
});

describe('VYORA Connect / comptes connectés', () => {
  const account = {
    id: 'acct-1',
    provider: 'gmail',
    external_account_id: 'sub-1',
    display_name: 'Camille',
    email: 'camille@exemple.com',
    capabilities: ['read', 'draft'],
    status: 'connected' as const,
    last_verified_at: '2026-11-14T10:00:00.000Z',
    last_error: null,
    created_at: '2026-11-01T09:00:00.000Z',
  };

  beforeEach(() => {
    fetchProviderAvailability.mockResolvedValue(CONFIGURED);
  });

  it('affiche l’adresse et l’état du compte', async () => {
    fetchConnectedAccounts.mockResolvedValue([account]);
    renderPage();
    await waitFor(() => expect(screen.getByText('camille@exemple.com')).toBeTruthy());
    expect(screen.getByText('Connecté')).toBeTruthy();
  });

  it('n’affiche QUE les permissions réellement accordées', async () => {
    fetchConnectedAccounts.mockResolvedValue([account]);
    renderPage();
    await waitFor(() => expect(screen.getByText('camille@exemple.com')).toBeTruthy());
    const card = document.querySelector('[data-account-id="acct-1"]')!;
    const granted = within(card as HTMLElement).getByLabelText('Permissions accordées');
    expect(granted.textContent).toContain('Lire');
    expect(granted.textContent).toContain('Rédiger');
    // « Envoyer » n'a pas été accordé : il ne doit jamais apparaître.
    expect(granted.textContent).not.toContain('Envoyer');
  });

  it('ne montre aucun jeton, même si la réponse en contenait', async () => {
    fetchConnectedAccounts.mockResolvedValue([
      { ...account, access_token_cipher: 'NE-DOIT-PAS-FUIR', token_iv: 'iv' },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('camille@exemple.com')).toBeTruthy());
    expect(document.body.textContent).not.toContain('NE-DOIT-PAS-FUIR');
  });

  it('signale un compte expiré et propose de renouveler', async () => {
    fetchConnectedAccounts.mockResolvedValue([{ ...account, status: 'expired', last_error: 'refresh_refuse' }]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Autorisation expirée')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Renouveler l’autorisation' })).toBeTruthy();
  });

  it('affiche « Aucun compte connecté » quand la liste est vide', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Aucun compte connecté')).toBeTruthy());
  });

  it('révoque après confirmation explicite, jamais au premier clic', async () => {
    fetchConnectedAccounts.mockResolvedValue([account]);
    revokeAccount.mockResolvedValue({ revoked: true, remoteRevoked: true });
    renderPage();
    await waitFor(() => expect(screen.getByText('camille@exemple.com')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Déconnecter' }));
    // Une boîte de confirmation apparaît ; rien n'est encore révoqué.
    expect(revokeAccount).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Déconnecter Gmail ?');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Déconnecter' }));
    await waitFor(() => expect(revokeAccount).toHaveBeenCalledWith('acct-1'));
  });

  it('annuler la confirmation ne révoque rien', async () => {
    fetchConnectedAccounts.mockResolvedValue([account]);
    renderPage();
    await waitFor(() => expect(screen.getByText('camille@exemple.com')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Déconnecter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(revokeAccount).not.toHaveBeenCalled();
  });

  it('explique honnêtement quand la révocation distante n’est pas confirmée', async () => {
    fetchConnectedAccounts.mockResolvedValue([account]);
    revokeAccount.mockResolvedValue({ revoked: true, remoteRevoked: false });
    renderPage();
    await waitFor(() => expect(screen.getByText('camille@exemple.com')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Déconnecter' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Déconnecter' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('n’a pas été confirmée'),
    );
  });

  it('affiche un message lisible si la révocation échoue', async () => {
    fetchConnectedAccounts.mockResolvedValue([account]);
    revokeAccount.mockRejectedValue(new ConnectError('forbidden', 'Vous n’avez pas accès à ce compte.'));
    renderPage();
    await waitFor(() => expect(screen.getByText('camille@exemple.com')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Déconnecter' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Déconnecter' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('pas accès à ce compte'));
  });
});

describe('VYORA Connect / permissions séparées', () => {
  it('cocher « Rédiger » ne coche jamais « Envoyer »', async () => {
    fetchProviderAvailability.mockResolvedValue(CONFIGURED);
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Permissions demandées')).toBeTruthy());

    const draft = screen.getByRole('checkbox', { name: /Rédiger/ }) as HTMLInputElement;
    const send = screen.getByRole('checkbox', { name: /Envoyer/ }) as HTMLInputElement;
    expect(draft.checked).toBe(false);
    expect(send.checked).toBe(false);

    fireEvent.click(draft);
    expect(draft.checked).toBe(true);
    expect(send.checked).toBe(false);
  });

  it('la lecture seule est cochée par défaut', async () => {
    fetchProviderAvailability.mockResolvedValue(CONFIGURED);
    renderPage();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Lire/ })).toBeTruthy());
    expect((screen.getByRole('checkbox', { name: /Lire/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('l’envoi est signalé comme action irréversible', async () => {
    fetchProviderAvailability.mockResolvedValue(CONFIGURED);
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Permissions demandées')).toBeTruthy());
    const picker = screen.getByLabelText('Permissions demandées');
    expect(picker.textContent).toContain('action irréversible');
  });

  it('transmet exactement les permissions cochées au démarrage OAuth', async () => {
    fetchProviderAvailability.mockResolvedValue(CONFIGURED);
    startAuthorization.mockResolvedValue({
      authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      state: 'abc',
      capabilities: ['read', 'draft'],
      expires_in: 600,
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connecter' })).toHaveLength(3));

    fireEvent.click(screen.getByRole('checkbox', { name: /Rédiger/ }));
    const gmailCard = document.querySelector('[data-provider="gmail"]')! as HTMLElement;
    fireEvent.click(within(gmailCard).getByRole('button', { name: 'Connecter' }));

    await waitFor(() =>
      expect(startAuthorization).toHaveBeenCalledWith('gmail', ['read', 'draft']),
    );
    // Jamais `send` : l'utilisateur ne l'a pas demandé.
    const [, capabilities] = startAuthorization.mock.calls[0];
    expect(capabilities).not.toContain('send');
    expect(capabilities).not.toContain('modify');
  });

  it('garde la trace de l’intention avant de quitter la page', async () => {
    fetchProviderAvailability.mockResolvedValue(CONFIGURED);
    startAuthorization.mockResolvedValue({
      authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      state: 'abc',
      capabilities: ['read'],
      expires_in: 600,
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connecter' })).toHaveLength(3));
    const driveCard = document.querySelector('[data-provider="google_drive"]')! as HTMLElement;
    fireEvent.click(within(driveCard).getByRole('button', { name: 'Connecter' }));
    await waitFor(() => expect(rememberPendingAuthorization).toHaveBeenCalled());
    const intent = rememberPendingAuthorization.mock.calls[0][0] as { provider: string };
    expect(intent.provider).toBe('google_drive');
  });

  it('affiche un message utile quand Google n’est pas configuré côté serveur', async () => {
    fetchProviderAvailability.mockResolvedValue(CONFIGURED);
    startAuthorization.mockRejectedValue(
      new ConnectError('google_not_configured', 'Les identifiants Google ne sont pas encore configurés.'),
    );
    renderPage();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connecter' })).toHaveLength(3));
    const gmailCard = document.querySelector('[data-provider="gmail"]')! as HTMLElement;
    fireEvent.click(within(gmailCard).getByRole('button', { name: 'Connecter' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('identifiants Google'));
  });
});

describe('VYORA Connect / journal des événements', () => {
  it('affiche les événements avec leur tonalité', async () => {
    fetchAuditEvents.mockResolvedValue([
      { id: 2, provider: 'gmail', action: 'connect_failure', capability: null, outcome: 'denied', detail: 'etat_invalide', created_at: '2026-11-14T10:00:00.000Z' },
      { id: 1, provider: 'gmail', action: 'connect_start', capability: null, outcome: 'ok', detail: null, created_at: '2026-11-14T09:59:00.000Z' },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Connexion échouée')).toBeTruthy());
    expect(screen.getByText('Connexion démarrée')).toBeTruthy();
    expect(screen.getByText('etat_invalide')).toBeTruthy();
  });

  it('affiche un état vide explicite quand rien ne s’est passé', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Aucun événement enregistré pour l’instant.')).toBeTruthy());
  });

  it('signale un refus de capacité en rouge', async () => {
    fetchAuditEvents.mockResolvedValue([
      { id: 3, provider: 'gmail', action: 'denied', capability: 'send', outcome: 'denied', detail: 'capacite_non_accordee', created_at: '2026-11-14T10:00:00.000Z' },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Action refusée')).toBeTruthy());
    expect(screen.getByText('erreur')).toBeTruthy();
  });
});
