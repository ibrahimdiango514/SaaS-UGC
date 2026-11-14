import { describe, expect, it } from 'vitest';
import { firstNameFrom, stableHash, welcomeMessage, workspaceHint } from '../src/lib/welcome';

/**
 * Accueil personnalisé — contrat de vérité.
 *
 * Ces tests protègent une règle produit explicite : **aucun nom n'est inventé**.
 * Un e-mail, un identifiant technique ou un champ vide ne produisent jamais de
 * prénom. Les messages restent variés mais déterministes pour une même journée.
 */
describe('accueil personnalisé — prénom', () => {
  it('extrait le prénom d’un nom complet et met la majuscule initiale', () => {
    expect(firstNameFrom('Ibrahim Diango')).toBe('Ibrahim');
    expect(firstNameFrom('awa traoré')).toBe('Awa');
    expect(firstNameFrom('  Awa  ')).toBe('Awa');
  });

  it('conserve les prénoms composés et les majuscules internes', () => {
    expect(firstNameFrom('Jean-Pierre Dupont')).toBe('Jean-Pierre');
    expect(firstNameFrom('MC Solar')).toBe('MC');
  });

  it('gère les particules sans les capitaliser à tort', () => {
    expect(firstNameFrom('de la Cruz')).toBe('de la Cruz');
    expect(firstNameFrom('van Dijk')).toBe('van Dijk');
  });

  it('ne fabrique jamais un prénom à partir d’un e-mail', () => {
    expect(firstNameFrom('awa.traore@example.com')).toBeNull();
    expect(firstNameFrom(null)).toBeNull();
    expect(firstNameFrom('   ')).toBeNull();
  });

  it('ignore les identifiants techniques', () => {
    expect(firstNameFrom('3f2b8c1e-9a4d-4c7e-8b21-5f0e9d3a1c22')).toBeNull();
    expect(firstNameFrom('123456')).toBeNull();
  });
});

describe('accueil personnalisé — message', () => {
  it('salue avec le prénom réel du profil', () => {
    const message = welcomeMessage({ displayName: 'Ibrahim Diango', greeting: 'Bonsoir' });
    expect(message.heading).toBe('Bonsoir, Ibrahim.');
    expect(message.firstName).toBe('Ibrahim');
    expect(message.sentence.length).toBeGreaterThan(20);
  });

  it('salue sans prénom quand le profil n’en fournit pas', () => {
    const message = welcomeMessage({ displayName: null, greeting: 'Bonjour' });
    expect(message.heading).toBe('Bonjour.');
    expect(message.heading).not.toMatch(/,\s*$/);
    expect(message.firstName).toBeNull();
  });

  it('n’utilise jamais l’e-mail comme prénom (aucune piste fournie)', () => {
    // Le module ne reçoit pas l'e-mail : c'est précisément la garantie qu'aucun
    // prénom ne peut être déduit de l'adresse.
    const message = welcomeMessage({ displayName: 'awa.traore@example.com', greeting: 'Bonjour' });
    expect(message.firstName).toBeNull();
    expect(message.heading).toBe('Bonjour.');
  });

  it('est déterministe pour une même graine', () => {
    const input = { displayName: 'Awa', greeting: 'Bonjour', seed: 'user-1:2026-11-14' };
    expect(welcomeMessage(input).sentence).toBe(welcomeMessage(input).sentence);
  });

  it('varie selon la graine et selon la première visite', () => {
    const sentences = new Set(
      Array.from({ length: 12 }, (_, index) => welcomeMessage({
        displayName: 'Awa',
        greeting: 'Bonjour',
        seed: `user-${index}:2026-11-14`,
      }).sentence),
    );
    expect(sentences.size).toBeGreaterThan(1);

    const first = welcomeMessage({ displayName: 'Awa', greeting: 'Bonjour', seed: 'x', firstVisit: true });
    const returning = welcomeMessage({ displayName: 'Awa', greeting: 'Bonjour', seed: 'x', firstVisit: false });
    expect(first.status).not.toBe(returning.status);
  });

  it('hash stable et borné', () => {
    expect(stableHash('vyora')).toBe(stableHash('vyora'));
    expect(stableHash('vyora')).not.toBe(stableHash('Vyora'));
    expect(stableHash('')).toBeGreaterThanOrEqual(0);
  });

  it('rappel d’espace uniquement si le nom existe réellement', () => {
    expect(workspaceHint('Maison VYORA')).toBe('Vous êtes dans Maison VYORA.');
    expect(workspaceHint('')).toBeNull();
    expect(workspaceHint(null)).toBeNull();
  });
});
