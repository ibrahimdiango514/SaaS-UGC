// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  diagnostiquerMoteur,
  etatDepuisSante,
  formeAdresse,
  type EtatMoteurObserve,
} from '../src/business/ai/diagnostic';

/**
 * BLOC A — le moteur IA doit dire POURQUOI il ne répond pas.
 *
 * ## Ce que ces tests empêchent
 * L'écran affichait « registre indisponible » quel que soit le blocage réel :
 * clé absente, adresse absente, adresse `localhost`, délai dépassé, clé
 * refusée, aucun modèle validé, fournisseur désactivé. Ces causes demandent des
 * actions DIFFÉRENTES, souvent par des personnes différentes.
 *
 * ## Règle de non-invention
 * Chaque cas ci-dessous est construit sur des valeurs observées par la sonde
 * réelle (`configured`, `status`, `error_code`, `base_url_form`), jamais sur une
 * supposition. Un test qui passerait sans donnée d'entrée ne prouverait rien :
 * tous les cas fournissent un état explicite.
 */

function etat(partiel: Partial<EtatMoteurObserve>): EtatMoteurObserve {
  return {
    registreLisible: true,
    clePresente: true,
    adresseConfiguree: true,
    formeAdresse: 'publique',
    actif: true,
    codeErreur: null,
    statutHttp: null,
    modelesCatalogue: 12,
    modelesVerifies: 3,
    ...partiel,
  };
}

describe('Forme de l’adresse — jamais restituée, seulement qualifiée', () => {
  it('reconnaît une adresse publique', () => {
    expect(formeAdresse('https://freellmapi.example.com/v1')).toBe('publique');
    expect(formeAdresse('https://8.8.8.8/v1')).toBe('publique');
  });

  it('reconnaît ce qui ne peut jamais être joint depuis le cloud', () => {
    // Le cas exact du constat : FreeLLMAPI sur localhost.
    expect(formeAdresse('http://localhost:3000/v1')).toBe('locale');
    expect(formeAdresse('http://127.0.0.1:8080')).toBe('locale');
    expect(formeAdresse('http://[::1]:3000')).toBe('locale');
    expect(formeAdresse('http://api.local/v1')).toBe('locale');
    expect(formeAdresse('http://192.168.1.10:3000')).toBe('privee');
    expect(formeAdresse('http://172.16.0.4')).toBe('privee');
    expect(formeAdresse('http://10.0.0.7')).toBe('privee');
  });

  it('signale une adresse illisible ou absente', () => {
    expect(formeAdresse('')).toBe('absente');
    expect(formeAdresse(null)).toBe('absente');
    expect(formeAdresse('freellmapi')).toBe('illisible'); // pas d'URL complète
    expect(formeAdresse('ftp://example.com')).toBe('illisible');
  });
});

describe('Diagnostic — une cause distincte par blocage', () => {
  it('clé FREE_LLM_API_KEY absente', () => {
    const d = diagnostiquerMoteur(etat({ clePresente: false }));
    expect(d.blocage).toBe('cle_absente');
    expect(d.message).toContain('FREE_LLM_API_KEY');
    expect(d.etape).toBe('configuration');
    expect(d.pret).toBe(false);
    // Le message dit quoi faire.
    expect(d.action.length).toBeGreaterThan(20);
  });

  it('adresse FREE_LLM_API_BASE_URL absente', () => {
    const d = diagnostiquerMoteur(etat({ adresseConfiguree: false, formeAdresse: 'absente' }));
    expect(d.blocage).toBe('adresse_absente');
    expect(d.message).toContain('FREE_LLM_API_BASE_URL');
  });

  it('adresse locale ou privée : la cause est l’adresse, pas le réseau', () => {
    const locale = diagnostiquerMoteur(etat({ formeAdresse: 'locale' }));
    expect(locale.blocage).toBe('adresse_non_publique');
    const privee = diagnostiquerMoteur(etat({ formeAdresse: 'privee' }));
    expect(privee.blocage).toBe('adresse_non_publique');
    // L'action nomme explicitement l'hébergement public.
    expect(locale.action).toMatch(/HTTPS publiqu/i);
  });

  it('adresse illisible', () => {
    expect(diagnostiquerMoteur(etat({ formeAdresse: 'illisible' })).blocage).toBe('adresse_invalide');
  });

  it('délai dépassé', () => {
    const d = diagnostiquerMoteur(etat({ codeErreur: 'PROVIDER_TIMEOUT' }));
    expect(d.blocage).toBe('delai_depasse');
    expect(d.message).toContain('délai');
    expect(d.etape).toBe('reseau');
  });

  it('réseau injoignable', () => {
    expect(diagnostiquerMoteur(etat({ codeErreur: 'PROVIDER_NETWORK_ERROR' })).blocage).toBe('injoignable');
  });

  it('clé refusée (401 et 403)', () => {
    expect(diagnostiquerMoteur(etat({ codeErreur: 'PROVIDER_AUTH_FAILED', statutHttp: 401 })).blocage).toBe('cle_refusee');
    expect(diagnostiquerMoteur(etat({ statutHttp: 403 })).blocage).toBe('cle_refusee');
  });

  it('mauvaise adresse (404)', () => {
    const d = diagnostiquerMoteur(etat({ statutHttp: 404 }));
    expect(d.blocage).toBe('adresse_introuvable');
    expect(d.action).toContain('/models');
  });

  it('quota ou solde épuisé', () => {
    expect(diagnostiquerMoteur(etat({ statutHttp: 402 })).blocage).toBe('quota');
    expect(diagnostiquerMoteur(etat({ codeErreur: 'PROVIDER_RATE_LIMITED' })).blocage).toBe('quota');
  });

  it('aucun modèle validé par sonde', () => {
    const vide = diagnostiquerMoteur(etat({ modelesCatalogue: 0 }));
    expect(vide.blocage).toBe('aucun_modele');
    // Catalogue non vide mais aucun modèle vérifié : même conclusion, la
    // complétion n'a jamais abouti.
    expect(diagnostiquerMoteur(etat({ modelesVerifies: 0 })).blocage).toBe('aucun_modele');
  });

  it('fournisseur désactivé alors que tout le reste fonctionne', () => {
    const d = diagnostiquerMoteur(etat({ actif: false }));
    expect(d.blocage).toBe('desactive');
    expect(d.action).toMatch(/activer/i);
  });

  it('opérationnel seulement si une complétion a été validée', () => {
    const d = diagnostiquerMoteur(etat({}));
    expect(d.blocage).toBe('operationnel');
    expect(d.pret).toBe(true);
  });

  it('registre illisible : cas distinct, sans accuser le fournisseur', () => {
    const d = diagnostiquerMoteur(etat({ registreLisible: false }));
    expect(d.blocage).toBe('registre_indisponible');
    expect(d.etape).toBe('configuration');
  });

  it('l’ordre des contrôles suit le chemin réel d’un appel', () => {
    // Clé absente ET fournisseur désactivé : la clé est la première étape.
    // Annoncer « désactivé » ferait activer un fournisseur inutilisable.
    expect(diagnostiquerMoteur(etat({ clePresente: false, actif: false })).blocage).toBe('cle_absente');
    // Adresse locale ET modèle absent : l'adresse bloquera toujours.
    expect(diagnostiquerMoteur(etat({ formeAdresse: 'locale', modelesCatalogue: 0 })).blocage).toBe('adresse_non_publique');
  });

  it('ne cite jamais de secret ni d’URL complète', () => {
    const cas: Array<Partial<EtatMoteurObserve>> = [
      { clePresente: false }, { formeAdresse: 'locale' }, { statutHttp: 401 }, { statutHttp: 404 },
      { modelesCatalogue: 0 }, { actif: false }, { codeErreur: 'PROVIDER_TIMEOUT' },
    ];
    for (const partiel of cas) {
      const d = diagnostiquerMoteur(etat(partiel));
      for (const texte of [d.message, d.action]) {
        expect(texte).not.toMatch(/https?:\/\/\S+/);
        expect(texte).not.toMatch(/sk-|Bearer |eyJhbGciOi/);
      }
    }
  });
});

describe('État dérivé de la réponse `health` du serveur', () => {
  it('un fournisseur absent du registre n’est pas « opérationnel »', () => {
    const e = etatDepuisSante(null);
    expect(e.registreLisible).toBe(false);
    expect(diagnostiquerMoteur(e).blocage).toBe('registre_indisponible');
  });

  it('relaie les champs observés sans les interpréter', () => {
    const e = etatDepuisSante({
      configured: true,
      status: 'degraded',
      enabled: true,
      base_url_configured: true,
      base_url_form: 'publique',
      error_code: 'PROVIDER_TIMEOUT',
      catalog_models: 5,
      verified_models: 1,
    });
    expect(e.clePresente).toBe(true);
    expect(e.codeErreur).toBe('PROVIDER_TIMEOUT');
    expect(diagnostiquerMoteur(e).blocage).toBe('delai_depasse');
  });

  it('un fournisseur désactivé au registre est reconnu comme non actif', () => {
    const e = etatDepuisSante({
      configured: true, status: 'unverified', enabled: false,
      base_url_configured: true, base_url_form: 'publique',
      catalog_models: 10, verified_models: 2, error_code: null,
    });
    expect(diagnostiquerMoteur(e).blocage).toBe('desactive');
  });
});

/* ------------------------------------------------------------------------- */
/* Rendu : le diagnostic est VISIBLE dans l'écran, avec un appel réel mocké.  */
/* ------------------------------------------------------------------------- */

const api = vi.hoisted(() => ({ aiEngineHealth: vi.fn() }));
vi.mock('../src/lib/api', () => ({ aiEngineHealth: api.aiEngineHealth }));

import { MoteurIaDiagnostic } from '../src/business/ai/MoteurIaDiagnostic';

beforeEach(() => { api.aiEngineHealth.mockReset(); });
afterEach(cleanup);

describe('Panneau de diagnostic — rendu réel', () => {
  it('affiche la cause exacte et l’action quand la clé est absente', async () => {
    api.aiEngineHealth.mockResolvedValue({
      providers: {
        freellmapi: {
          configured: false, model: null, status: 'unavailable', enabled: false,
          base_url_configured: false, base_url_form: 'absente',
          error_code: 'PROVIDER_NOT_CONFIGURED', catalog_models: 0, verified_models: 0,
        },
      },
    });
    render(<MoteurIaDiagnostic />);
    // L'appel serveur est bien parti : le test ne passe pas sans lui.
    await waitFor(() => expect(api.aiEngineHealth).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('moteur-ia-message').textContent).toContain('FREE_LLM_API_KEY'));
    expect(screen.getByTestId('moteur-ia-action').textContent).toMatch(/Renseigner/);
    expect(screen.getByText('Bloqué')).toBeTruthy();
  });

  it('affiche « Opérationnel » seulement quand la sonde a validé', async () => {
    api.aiEngineHealth.mockResolvedValue({
      providers: {
        freellmapi: {
          configured: true, model: 'auto', status: 'available', enabled: true,
          base_url_configured: true, base_url_form: 'publique',
          error_code: null, catalog_models: 9, verified_models: 4,
        },
      },
    });
    render(<MoteurIaDiagnostic />);
    await waitFor(() => expect(screen.getByTestId('moteur-ia-message').textContent).toContain('Opérationnel'));
    expect(screen.getByText('Opérationnel')).toBeTruthy();
  });

  it('un échec de la sonde n’affiche jamais « Opérationnel »', async () => {
    api.aiEngineHealth.mockRejectedValue(new Error('Sonde indisponible'));
    render(<MoteurIaDiagnostic />);
    await waitFor(() => expect(screen.getByTestId('moteur-ia-message').textContent).toContain('Registre'));
    expect(screen.queryByText('Opérationnel')).toBeNull();
  });

  it('n’affiche ni clé ni URL, même quand l’adresse est locale', async () => {
    api.aiEngineHealth.mockResolvedValue({
      providers: {
        freellmapi: {
          configured: true, model: null, status: 'unavailable', enabled: true,
          base_url_configured: true, base_url_form: 'locale',
          error_code: 'PROVIDER_NETWORK_ERROR', catalog_models: 0, verified_models: 0,
        },
      },
    });
    const { container } = render(<MoteurIaDiagnostic />);
    await waitFor(() => expect(screen.getByTestId('moteur-ia-message').textContent).toContain('locale'));
    expect(container.textContent).not.toMatch(/https?:\/\//);
    expect(container.textContent).not.toMatch(/sk-|eyJhbGciOi/);
  });

  it('la fiche « Rendre FreeLLMAPI joignable » expose les trois étapes', async () => {
    api.aiEngineHealth.mockResolvedValue({ providers: {} });
    render(<MoteurIaDiagnostic variante="admin" />);
    await waitFor(() => expect(screen.getByTestId('moteur-ia-fiche')).toBeTruthy());
    const fiche = screen.getByTestId('moteur-ia-fiche');
    expect(fiche.textContent).toContain('HTTPS');
    expect(fiche.textContent).toContain('FREE_LLM_API_KEY');
    expect(fiche.textContent).toContain('FREE_LLM_API_BASE_URL');
    expect(fiche.textContent).toMatch(/Relancer la sonde/);
    expect(fiche.querySelectorAll('li').length).toBe(3);
  });

  it('l’espace Agent n’expose pas la fiche d’administration', async () => {
    api.aiEngineHealth.mockResolvedValue({ providers: {} });
    render(<MoteurIaDiagnostic variante="agent" />);
    await waitFor(() => expect(screen.getByTestId('moteur-ia-diagnostic')).toBeTruthy());
    expect(screen.queryByTestId('moteur-ia-fiche')).toBeNull();
  });

  it('le bouton « Relancer la sonde » refait un appel réel', async () => {
    api.aiEngineHealth.mockResolvedValue({ providers: {} });
    const onRelancer = vi.fn(async () => undefined);
    render(<MoteurIaDiagnostic onRelancer={onRelancer} />);
    await waitFor(() => expect(api.aiEngineHealth).toHaveBeenCalledTimes(1));
    screen.getByRole('button', { name: /Relancer la sonde/ }).click();
    await waitFor(() => expect(onRelancer).toHaveBeenCalledTimes(1));
    // La relance relit l'état : deux appels au total, jamais un cache affiché.
    await waitFor(() => expect(api.aiEngineHealth).toHaveBeenCalledTimes(2));
  });

  /*
   * Défaut trouvé en CI, invisible en test isolé.
   *
   * `aiEngineHealth` répond après que le composant a quitté l'écran (changement
   * d'onglet, fermeture du panneau, fin d'un test). React écrivait alors l'état
   * d'un arbre démonté : en production c'est du travail perdu, et dans un
   * environnement de test déjà détruit cela lève
   * `ReferenceError: window is not defined` — une erreur NON GÉRÉE qui fait
   * échouer la suite entière, pas seulement le test concerné.
   *
   * Le test démonte donc volontairement avant la réponse de la sonde et exige
   * l'absence de toute erreur non gérée.
   */
  it('une sonde qui répond après démontage ne met à jour aucun état', async () => {
    let repondre: (valeur: unknown) => void = () => undefined;
    api.aiEngineHealth.mockReturnValue(new Promise((resolve) => { repondre = resolve; }));

    const { unmount } = render(<MoteurIaDiagnostic />);
    expect(screen.getByTestId('moteur-ia-diagnostic')).toBeTruthy();
    unmount();

    /*
     * On reproduit la condition exacte de la CI : jsdom est détruit (plus de
     * `window`) alors que la promesse est encore en vol, puis elle répond.
     *
     * Sans garde de montage, React écrit l'état d'un arbre démonté, lit
     * `window` pour calculer la priorité de l'événement et lève
     * `ReferenceError: window is not defined` — une erreur NON GÉRÉE qui fait
     * sortir vitest en code 1, donc échouer la CI entière.
     */
    const fenetre = (globalThis as { window?: unknown }).window;
    const erreurs: unknown[] = [];
    const capter = (e: unknown) => { erreurs.push(e); };
    process.on('unhandledRejection', capter);
    process.on('uncaughtException', capter);
    try {
      delete (globalThis as { window?: unknown }).window;
      repondre({ providers: { freellmapi: { enabled: true, last_probe_ok: true } } });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      (globalThis as { window?: unknown }).window = fenetre;
      process.off('unhandledRejection', capter);
      process.off('uncaughtException', capter);
    }

    expect(erreurs).toEqual([]);
  });
});
