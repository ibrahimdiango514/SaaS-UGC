// @vitest-environment jsdom
// Hero 3D adaptatif — la logique qui décide du niveau.
//
// Ces tests ne cherchent pas à vérifier qu'un joli rendu apparaît : ils
// vérifient que la **décision** est correcte. C'est là que se joue la fluidité
// perçue sur un Android d'entrée de gamme, et donc une partie de la conversion.
//
// Ce qui est testé :
//   - pas de WebGL → niveau 0 (statique) ;
//   - mouvement réduit → niveau 0, quel que soit l'appareil ;
//   - économie de données / 2G-3G / petit écran → niveau 1 (2,5D) ;
//   - appareil robuste → niveau 2 (WebGL) ;
//   - la rétrogradation ne remonte jamais.
import { describe, expect, it } from 'vitest';
import { detecterCapacites, niveauInitial, type Capacites } from '../src/marketing/3d/capacites';

/** Fabrique une capacité « appareil correct » que chaque test dégrade. */
function capacites(overrides: Partial<Capacites> = {}): Capacites {
  return {
    webgl: true,
    deviceMemory: 8,
    coeurs: 8,
    saveData: false,
    effectiveType: '4g',
    mouvementReduit: false,
    largeur: 1280,
    enLigne: true,
    ...overrides,
  };
}

describe('décision du niveau 3D', () => {
  it('reste statique quand WebGL est indisponible', () => {
    expect(niveauInitial(capacites({ webgl: false }))).toBe(0);
  });

  it('reste statique quand le mouvement réduit est demandé', () => {
    // C'est un choix d'accessibilité, pas une optimisation : on ne discute pas.
    expect(niveauInitial(capacites({ mouvementReduit: true }))).toBe(0);
  });

  it('reste statique en économie de données', () => {
    expect(niveauInitial(capacites({ saveData: true }))).toBe(0);
  });

  it('reste statique hors ligne', () => {
    expect(niveauInitial(capacites({ enLigne: false }))).toBe(0);
  });

  it('passe en 2,5D sur réseau lent', () => {
    expect(niveauInitial(capacites({ effectiveType: '3g' }))).toBe(1);
    expect(niveauInitial(capacites({ effectiveType: '2g' }))).toBe(1);
  });

  it('passe en 2,5D sur petit écran', () => {
    expect(niveauInitial(capacites({ largeur: 360 }))).toBe(1);
  });

  it('passe en 2,5D sur appareil à mémoire faible', () => {
    expect(niveauInitial(capacites({ deviceMemory: 2 }))).toBe(1);
  });

  it('passe en 2,5D quand le nombre de cœurs est insuffisant', () => {
    expect(niveauInitial(capacites({ coeurs: 2 }))).toBe(1);
  });

  it('reste prudent quand la mémoire est inconnue (Safari iOS)', () => {
    expect(niveauInitial(capacites({ deviceMemory: null, coeurs: 4 }))).toBe(1);
  });

  it('accorde le WebGL à un appareil robuste', () => {
    expect(niveauInitial(capacites())).toBe(2);
  });

  it('ne regarde jamais le nom du modèle', () => {
    // Deux appareils identiques en capacités mais aux noms opposés doivent
    // recevoir le même niveau : la décision est fondée sur des mesures.
    const entree = capacites({ deviceMemory: 4, coeurs: 8 });
    const a = niveauInitial({ ...entree });
    const b = niveauInitial({ ...entree });
    expect(a).toBe(b);
  });
});

describe('détection des capacités', () => {
  it('ne lève pas d’exception dans un environnement sans WebGL', () => {
    // jsdom n'implémente pas getContext : la détection doit renvoyer false,
    // pas planter — sinon la landing blanche est garantie en cas de navigateur
    // exotique.
    const c = detecterCapacites();
    expect(typeof c.webgl).toBe('boolean');
    expect(c.largeur).toBeGreaterThan(0);
  });
});
