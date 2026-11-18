// @vitest-environment jsdom
/**
 * Phase E — centre « Mes boutiques connectées ».
 *
 * Ce panneau agrège des états serveur. Le risque n'est pas qu'il plante : c'est
 * qu'il affiche « connectée » à tort, ou qu'une panne de lecture passe pour une
 * absence de connexion. Les deux cas sont testés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ connectEdge: vi.fn(), invokeEdge: vi.fn() }));

vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...reel,
    invokeEdge: (nom: string, corps: Record<string, unknown>) => (
      nom === 'store-connect' ? api.connectEdge(nom, corps) : api.invokeEdge(nom, corps)
    ),
  };
});

import { MemoryRouter } from 'react-router-dom';
import { MesBoutiquesConnectees, type BoutiquesAccess } from '../src/integrations/MesBoutiquesConnectees';

/** Abonnement Business Grow vérifié par le serveur : la lecture est permise. */
const ACTIF: BoutiquesAccess = { kind: 'active' };
const VERROUILLE: BoutiquesAccess = {
  kind: 'locked',
  title: 'Abonnement Business Grow requis',
  detail: 'Import & Connect est réservé aux abonnés Business Grow.',
  showSubscribe: true,
};

beforeEach(() => {
  api.connectEdge.mockReset();
  api.invokeEdge.mockReset();
});

afterEach(cleanup);

/** Réponse de `store-connect` par connecteur. */
function repondre(parCle: Record<string, unknown | Error>) {
  api.connectEdge.mockImplementation(async (_nom: string, corps: Record<string, unknown>) => {
    const valeur = parCle[String(corps.connectorKey)];
    if (valeur instanceof Error) throw valeur;
    return { data: valeur ?? null };
  });
}

describe('lecture des états', () => {
  it('affiche une boutique connectée avec sa preuve', async () => {
    repondre({
      prestashop: {
        connectorKey: 'prestashop',
        status: 'connected',
        connected: true,
        shopName: 'Atelier Lin',
        endpoint: 'https://atelier-lin.example/api',
        totalProducts: 42,
        checkedAt: '2026-11-14T10:00:00.000Z',
      },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />);

    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    const carte = screen.getByTestId('boutique-prestashop');
    expect(carte.getAttribute('data-state')).toBe('connected');
    expect(carte.textContent).toContain('Atelier Lin');
    expect(carte.textContent).toContain('42');
  });

  it('distingue une erreur d’authentification d’un droit manquant', async () => {
    repondre({
      prestashop: { connectorKey: 'prestashop', status: 'error', connected: false, lastError: 'La clé a été refusée.', lastErrorCode: 'AUTH_INVALID' },
      chariow: { connectorKey: 'chariow', status: 'error', connected: false, lastError: 'Autorisation insuffisante : ajoutez products.read', lastErrorCode: 'INSUFFICIENT_SCOPE' },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />);

    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    expect(screen.getByTestId('boutique-prestashop').getAttribute('data-state')).toBe('auth-error');
    expect(screen.getByTestId('boutique-chariow').getAttribute('data-state')).toBe('insufficient-scope');
  });

  it('affiche « non configurée » quand le serveur ne renvoie rien', async () => {
    repondre({});
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />);
    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    expect(screen.getByTestId('boutique-prestashop').getAttribute('data-state')).toBe('not-configured');
  });

  it('ne conclut RIEN quand la lecture échoue', async () => {
    repondre({ prestashop: new Error('Réseau indisponible') });
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />);

    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    const carte = screen.getByTestId('boutique-prestashop');
    // Surtout pas « non configurée » : l'utilisateur ressaisirait sa clé alors
    // qu'une connexion valide existe peut-être.
    expect(carte.getAttribute('data-state')).toBe('pending');
    expect(carte.textContent).toMatch(/illisible/i);
    expect(carte.textContent).toMatch(/aucune conclusion/i);
    // Une lecture échouée n'est pas « en cours » : ce libellé promettait un
    // résultat qui n'arrivait jamais (constat de production, erreurs CORS).
    expect(carte.textContent).not.toMatch(/Vérification en cours/i);
  });

  it('une panne d’un connecteur ne masque pas l’autre', async () => {
    repondre({
      prestashop: new Error('panne'),
      chariow: { connectorKey: 'chariow', status: 'connected', connected: true, shopName: 'Vitrine' },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />);

    await waitFor(() => expect(screen.getByTestId('boutique-chariow')).toBeTruthy());
    expect(screen.getByTestId('boutique-chariow').getAttribute('data-state')).toBe('connected');
    expect(screen.getByTestId('boutique-prestashop').getAttribute('data-state')).toBe('pending');
  });

  it('signale une connexion déclarée sans secret', async () => {
    repondre({
      chariow: {
        connectorKey: 'chariow',
        status: 'connected',
        // Le serveur dit « connecté » mais aucun secret n'existe : trace d'une
        // ancienne demande d'activation.
        connected: false,
      },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />);

    await waitFor(() => expect(screen.getByTestId('boutique-chariow')).toBeTruthy());
    expect(screen.getByTestId('boutique-chariow').textContent).toMatch(/Aucun secret/i);
  });

  it('résume les états en tête', async () => {
    repondre({
      prestashop: { connectorKey: 'prestashop', status: 'connected', connected: true },
      chariow: { connectorKey: 'chariow', status: 'error', connected: false, lastErrorCode: 'AUTH_INVALID' },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />);
    await waitFor(() => expect(screen.getByTestId('mes-boutiques').textContent).toMatch(/1 connectée/i));
    expect(screen.getByTestId('mes-boutiques').textContent).toMatch(/1 à corriger/i);
  });
});

describe('interactions', () => {
  it('ouvre la fiche du connecteur demandé', async () => {
    repondre({});
    const onOpen = vi.fn();
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} onOpenConnector={onOpen} />);

    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    const bouton = screen.getByTestId('boutique-prestashop').querySelector('button');
    expect(bouton).toBeTruthy();
    fireEvent.click(bouton!);
    expect(onOpen).toHaveBeenCalledWith('prestashop');
  });

  it('relit les états au clic sur Actualiser', async () => {
    repondre({});
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />);
    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    const avant = api.connectEdge.mock.calls.length;

    fireEvent.click(screen.getByTestId('mes-boutiques-refresh'));
    await waitFor(() => expect(api.connectEdge.mock.calls.length).toBeGreaterThan(avant));
  });

  it('ne lit rien sans entreprise active', () => {
    render(<MesBoutiquesConnectees workspaceId={null} access={ACTIF} />);
    expect(screen.getByTestId('mes-boutiques').textContent).toMatch(/Sélectionnez une entreprise/i);
    expect(api.connectEdge).not.toHaveBeenCalled();
  });
});

describe('périmètre affiché', () => {
  it('ne liste que les connecteurs réellement branchés', async () => {
    repondre({});
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />);
    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());

    // Les quatre connecteurs dont la connexion est déployée.
    for (const present of ['prestashop', 'chariow', 'shopify', 'woocommerce']) {
      expect(screen.getByTestId(`boutique-${present}`), present).toBeTruthy();
    }
    // Aucun connecteur non fonctionnel ne doit apparaître ici.
    for (const absent of ['opencart', 'magento', 'wix', 'ecwid']) {
      expect(screen.queryByTestId(`boutique-${absent}`), absent).toBeNull();
    }
  });

  it('dit combien de connecteurs sont configurables', async () => {
    repondre({});
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />);
    await waitFor(() => expect(screen.getByTestId('mes-boutiques').textContent).toMatch(/4 connecteurs sont configurables/i));
  });

  it('n’expose aucun secret dans le DOM', async () => {
    repondre({
      chariow: { connectorKey: 'chariow', status: 'connected', connected: true, shopName: 'Vitrine' },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />);
    await waitFor(() => expect(screen.getByTestId('boutique-chariow')).toBeTruthy());
    // `credential_ref` ne doit jamais être rendu, même sous forme de nom.
    expect(document.body.innerHTML).not.toMatch(/credential|vault|sk_live/i);
  });
});

describe('verrou Business Grow — aucune requête sans abonnement actif', () => {
  it('verrouillé : aucun appel store-connect, message explicite et lien vers la vraie page d’abonnement', () => {
    repondre({});
    render(
      <MemoryRouter>
        <MesBoutiquesConnectees workspaceId="w1" access={VERROUILLE} />
      </MemoryRouter>,
    );
    const panneau = screen.getByTestId('mes-boutiques');
    expect(panneau.getAttribute('data-access')).toBe('locked');
    expect(panneau.textContent).toMatch(/Connexions verrouillées/);
    expect(panneau.textContent).toMatch(/Abonnement Business Grow requis/);
    expect(panneau.textContent).toMatch(/aucune requête n’est émise/i);
    // Ni « Vérification en cours », ni erreur réseau : rien n'a été tenté.
    expect(panneau.textContent).not.toMatch(/Vérification en cours|illisible|réseau|CORS/i);
    expect(screen.queryByTestId('boutique-prestashop')).toBeNull();
    expect(screen.getByTestId('mes-boutiques-abonnement').getAttribute('href')).toBe('/app/business/abonnement');
    expect(api.connectEdge).not.toHaveBeenCalled();
  });

  it('verrouillé sans proposition d’abonnement (session requise) : pas de lien, toujours aucune requête', () => {
    repondre({});
    render(
      <MemoryRouter>
        <MesBoutiquesConnectees workspaceId="w1" access={{ ...VERROUILLE, title: 'Session requise', showSubscribe: false }} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('mes-boutiques-abonnement')).toBeNull();
    expect(api.connectEdge).not.toHaveBeenCalled();
  });

  it('vérification en cours : aucun appel, aucune conclusion', () => {
    repondre({});
    render(<MesBoutiquesConnectees workspaceId="w1" access={{ kind: 'pending' }} />);
    const panneau = screen.getByTestId('mes-boutiques');
    expect(panneau.getAttribute('data-access')).toBe('pending');
    expect(panneau.textContent).toMatch(/Vérification de l’abonnement/);
    expect(screen.queryByTestId('boutique-prestashop')).toBeNull();
    expect(api.connectEdge).not.toHaveBeenCalled();
  });

  it('lecture des intégrations en échec : message dédié, aucun appel', () => {
    repondre({});
    render(<MesBoutiquesConnectees workspaceId="w1" access={{ kind: 'pending', message: 'Lecture des intégrations en échec.' }} />);
    expect(screen.getByTestId('mes-boutiques').textContent).toMatch(/Lecture des intégrations en échec/);
    expect(api.connectEdge).not.toHaveBeenCalled();
  });

  it('abonnement détecté après coup : la lecture réelle démarre et l’état réel s’affiche', async () => {
    repondre({ chariow: { connectorKey: 'chariow', status: 'connected', connected: true, shopName: 'Vitrine' } });
    const { rerender } = render(
      <MemoryRouter>
        <MesBoutiquesConnectees workspaceId="w1" access={VERROUILLE} />
      </MemoryRouter>,
    );
    expect(api.connectEdge).not.toHaveBeenCalled();

    rerender(
      <MemoryRouter>
        <MesBoutiquesConnectees workspaceId="w1" access={ACTIF} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('boutique-chariow')).toBeTruthy());
    expect(screen.getByTestId('boutique-chariow').getAttribute('data-state')).toBe('connected');
    expect(screen.getByTestId('boutique-chariow').textContent).toContain('Vitrine');
    // Exactement les quatre connecteurs configurables, une lecture chacun.
    const cles = api.connectEdge.mock.calls.map(([, corps]) => String((corps as Record<string, unknown>).connectorKey)).sort();
    expect(cles).toEqual(['chariow', 'prestashop', 'shopify', 'woocommerce']);
    expect(api.connectEdge.mock.calls.every(([, corps]) => (corps as Record<string, unknown>).action === 'status')).toBe(true);
  });
});
