// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Login from '../src/pages/Login';
import Signup from '../src/pages/Signup';
import ForgotPassword from '../src/pages/ForgotPassword';
import { passwordStrength } from '../src/components/auth/AuthForm';
import { useSceneCapability } from '../src/components/auth/useSceneCapability';
import { renderHook } from '@testing-library/react';

/**
 * Parcours d'authentification immersif — contrats.
 *
 * Ces tests verrouillent deux choses :
 *  1. le comportement d'origine (validations, messages) n'a pas changé ;
 *  2. le repli « sans WebGL » est systématique — la page reste utilisable.
 */

vi.mock('../src/lib/api', () => ({
  signIn: vi.fn(async () => ({})),
  bootstrap: vi.fn(async () => ({ is_admin: false, workspace_id: 'ws-1' })),
  signUp: vi.fn(async () => ({ session: null })),
  sendPasswordReset: vi.fn(async () => undefined),
}));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false, isAdmin: false }),
}));

vi.mock('../src/context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

beforeEach(() => {
  // jsdom n'implémente pas WebGL : la scène 3D doit se replier silencieusement.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('connexion — expérience immersive', () => {
  it('conserve la validation historique et annonce l’erreur', async () => {
    render(<MemoryRouter initialEntries={['/connexion']}><Login /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Se connecter/i }));
    expect(await screen.findByText(/Renseignez votre e-mail et votre mot de passe/)).toBeTruthy();
  });

  it('expose des champs accessibles avec états de saisie', async () => {
    render(<MemoryRouter initialEntries={['/connexion']}><Login /></MemoryRouter>);
    const email = screen.getByLabelText('Adresse e-mail') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'awa@example.com' } });
    expect(email.value).toBe('awa@example.com');
    // L'œil du mot de passe est un bouton nommé, pas une icône décorative.
    expect(screen.getByRole('button', { name: /Afficher le mot de passe/i })).toBeTruthy();
  });

  it('bascule l’affichage du mot de passe sans changer la valeur', async () => {
    render(<MemoryRouter initialEntries={['/connexion']}><Login /></MemoryRouter>);
    const password = screen.getByLabelText('Mot de passe') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'secret-1234' } });
    expect(password.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: /Afficher le mot de passe/i }));
    expect((screen.getByLabelText('Mot de passe') as HTMLInputElement).type).toBe('text');
    expect((screen.getByLabelText('Mot de passe') as HTMLInputElement).value).toBe('secret-1234');
  });

  it('garde les accès « mot de passe oublié » et « accès propriétaire »', async () => {
    render(<MemoryRouter initialEntries={['/connexion']}><Login /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Mot de passe oublié/i }).getAttribute('href')).toBe('/mot-de-passe-oublie');
    expect(screen.getByRole('link', { name: /Accès propriétaire/i }).getAttribute('href')).toBe('/proprietaire/connexion');
  });
});

describe('inscription — parcours en étapes', () => {
  it('valide la première étape avant de révéler le mot de passe', async () => {
    render(<MemoryRouter initialEntries={['/inscription']}><Signup /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Continuer/i }));
    expect(await screen.findByText('Indiquez votre nom.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Nom complet'), { target: { value: 'Ibrahim Diango' } });
    fireEvent.change(screen.getByLabelText('Adresse e-mail'), { target: { value: 'pas-un-email' } });
    fireEvent.click(screen.getByRole('button', { name: /Continuer/i }));
    expect(await screen.findByText('Adresse e-mail invalide.')).toBeTruthy();
  });

  it('applique la règle des 8 caractères et la confirmation', async () => {
    render(<MemoryRouter initialEntries={['/inscription']}><Signup /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Nom complet'), { target: { value: 'Awa Traoré' } });
    fireEvent.change(screen.getByLabelText('Adresse e-mail'), { target: { value: 'awa@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Continuer/i }));

    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'court' } });
    fireEvent.change(screen.getByLabelText('Confirmer le mot de passe'), { target: { value: 'court' } });
    fireEvent.click(screen.getByRole('button', { name: /Continuer/i }));
    expect(await screen.findByText('Le mot de passe doit contenir au moins 8 caractères.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'motdepasse1' } });
    fireEvent.change(screen.getByLabelText('Confirmer le mot de passe'), { target: { value: 'motdepasse2' } });
    fireEvent.click(screen.getByRole('button', { name: /Continuer/i }));
    expect(await screen.findByText('Les deux mots de passe ne correspondent pas.')).toBeTruthy();
  });

  it('atteint la confirmation et exige l’acceptation des conditions', async () => {
    render(<MemoryRouter initialEntries={['/inscription']}><Signup /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Nom complet'), { target: { value: 'Awa Traoré' } });
    fireEvent.change(screen.getByLabelText('Adresse e-mail'), { target: { value: 'awa@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Continuer/i }));
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'motdepasse123' } });
    fireEvent.change(screen.getByLabelText('Confirmer le mot de passe'), { target: { value: 'motdepasse123' } });
    fireEvent.click(screen.getByRole('button', { name: /Continuer/i }));

    expect(await screen.findByText(/Votre futur espace/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Créer mon compte/i }));
    expect(await screen.findByText('Vous devez accepter les conditions d’utilisation.')).toBeTruthy();
  });

  it('permet de revenir en arrière sans perdre la saisie', async () => {
    render(<MemoryRouter initialEntries={['/inscription']}><Signup /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Nom complet'), { target: { value: 'Awa Traoré' } });
    fireEvent.change(screen.getByLabelText('Adresse e-mail'), { target: { value: 'awa@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Continuer/i }));
    fireEvent.click(screen.getByRole('button', { name: /Retour/i }));
    expect((screen.getByLabelText('Nom complet') as HTMLInputElement).value).toBe('Awa Traoré');
  });
});

describe('mot de passe oublié', () => {
  it('refuse une adresse invalide et garde un message neutre après envoi', async () => {
    render(<MemoryRouter initialEntries={['/mot-de-passe-oublie']}><ForgotPassword /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Adresse e-mail'), { target: { value: 'invalide' } });
    fireEvent.click(screen.getByRole('button', { name: /Envoyer le lien/i }));
    expect(await screen.findByText('Adresse e-mail invalide.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Adresse e-mail'), { target: { value: 'awa@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Envoyer le lien/i }));
    await waitFor(() => expect(screen.getByText('E-mail envoyé')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText(/Si un compte existe pour/)).toBeTruthy();
  });
});

describe('robustesse technique du parcours', () => {
  it('se replie sur la composition statique sans WebGL', () => {
    const { result } = renderHook(() => useSceneCapability());
    // `useEffect` s'exécute de façon synchrone dans les tests de rendu React.
    expect(result.current.canRender3d).toBe(false);
  });

  it('jauge de mot de passe : purement indicative', () => {
    expect(passwordStrength('').score).toBe(0);
    expect(passwordStrength('court').score).toBe(0);
    expect(passwordStrength('MotDePasse123!').score).toBe(4);
    expect(passwordStrength('MotDePasse123!').label).toBe('Excellent');
  });
});
