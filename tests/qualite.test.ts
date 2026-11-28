/**
 * Dégradation par paliers — la logique de décision, vérifiée sans navigateur.
 *
 * ## Pourquoi ces tests existent
 * Le brief demande une dégradation automatique *et* un repli 2D. Une capture
 * ne prouve ni l'un ni l'autre : elle montre l'état d'une machine à un instant.
 * Ce qui peut être vérifié ici, c'est la règle — à quel FPS on descend, à quel
 * FPS on bascule en 2D, et le fait qu'on ne remonte jamais (une remontée
 * automatique oscille : dégrader → ça va mieux → remonter → ça retombe).
 *
 * Les seuils sont testés à leur frontière exacte, parce qu'une erreur d'un
 * FPS sur `SEUIL_REPLI` change le comportement d'une machine entière.
 */
import { describe, expect, it } from 'vitest';
import {
  ORDRE,
  PALIERS,
  SEUIL_DEGRADE,
  SEUIL_REPLI,
  decision,
  fpsDepuisIntervalles,
  mediane,
  palierDepuisUrl,
  palierInitial,
  palierSuivant,
} from '../src/landing/monde/qualite';

describe('mediane', () => {
  it('renvoie 0 sur une série vide', () => {
    expect(mediane([])).toBe(0);
  });

  it('renvoie la valeur centrale sur une série impaire', () => {
    expect(mediane([300, 100, 200])).toBe(200);
  });

  it('moyenne les deux valeurs centrales sur une série paire', () => {
    expect(mediane([100, 200, 300, 400])).toBe(250);
  });

  it("ignore l'ordre d'arrivée des mesures", () => {
    expect(mediane([16.7, 400, 16.6, 16.8])).toBe(mediane([16.6, 16.7, 16.8, 400]));
  });
});

describe('fpsDepuisIntervalles', () => {
  it('convertit une image à 16,7 ms en 60 fps', () => {
    expect(fpsDepuisIntervalles([16.7, 16.6, 16.8])).toBe(60);
  });

  it('convertit une image à 287 ms en 3 fps (mesure de la livraison 1)', () => {
    expect(fpsDepuisIntervalles([287, 290, 285])).toBe(3);
  });

  it('résiste à une image aberrante au milieu de la série', () => {
    expect(fpsDepuisIntervalles([16.7, 16.6, 900, 16.8, 16.7])).toBe(60);
  });

  it('renvoie 0 plutôt qu’un infini sur une série nulle', () => {
    expect(fpsDepuisIntervalles([0, 0])).toBe(0);
  });
});

describe('decision — les seuils', () => {
  /*
   * Les seuils sont figés ici volontairement : les autres tests les importent,
   * donc les décaler décalerait aussi leurs attentes — et une dégradation
   * silencieuse (45 → 40) ne se verrait pas. Ce test fait des seuils une
   * décision produit, pas un détail d'implémentation.
   */
  it('valent les valeurs documentées dans le rapport', () => {
    expect(SEUIL_DEGRADE).toBe(45);
    expect(SEUIL_REPLI).toBe(24);
  });

  it('garde le palier quand la machine tient largement le rythme', () => {
    expect(decision('complet', 60)).toBe('garder');
    expect(decision('moyen', 58)).toBe('garder');
  });

  it('garde le palier juste au-dessus du seuil de dégradation', () => {
    expect(decision('complet', SEUIL_DEGRADE)).toBe('garder');
  });

  it('descend d’un cran juste sous le seuil de dégradation', () => {
    expect(decision('complet', SEUIL_DEGRADE - 1)).toBe('descendre');
  });

  it('descend tant qu’il reste un palier plus léger', () => {
    expect(decision('complet', 20)).toBe('descendre');
    expect(decision('eleve', 20)).toBe('descendre');
    expect(decision('moyen', 20)).toBe('descendre');
  });

  it('bascule en repli 2D au plancher, sous le seuil de repli', () => {
    expect(decision('bas', SEUIL_REPLI - 1)).toBe('repli');
  });

  it('ne bascule pas en repli 2D au plancher si le seuil de repli est tenu', () => {
    expect(decision('bas', SEUIL_REPLI)).toBe('garder');
    expect(decision('bas', 44)).toBe('garder');
  });

  it('ne décide rien sur une mesure inutilisable', () => {
    expect(decision('moyen', 0)).toBe('garder');
    expect(decision('moyen', Number.NaN)).toBe('garder');
    expect(decision('moyen', Number.POSITIVE_INFINITY)).toBe('garder');
  });
});

describe('palierSuivant — la chaîne de descente', () => {
  it('parcourt les quatre paliers dans l’ordre', () => {
    expect(palierSuivant('complet')).toBe('eleve');
    expect(palierSuivant('eleve')).toBe('moyen');
    expect(palierSuivant('moyen')).toBe('bas');
  });

  it('s’arrête au plancher : plus rien à dégrader après « bas »', () => {
    expect(palierSuivant('bas')).toBeNull();
  });

  it('atteint le plancher en trois descentes, jamais en quatre', () => {
    // Boucle bornée volontairement : si la chaîne n'avançait plus (un palier
    // qui se renvoie lui-même), le test doit échouer, pas tourner sans fin.
    const parcours = [ORDRE[0]];
    for (let i = 0; i < ORDRE.length; i += 1) {
      const suivant = palierSuivant(parcours[parcours.length - 1]);
      if (!suivant) break;
      parcours.push(suivant);
    }
    expect(parcours).toEqual(ORDRE);
  });
});

describe('PALIERS — la hiérarchie est réellement décroissante', () => {
  it('commence par le rendu de la livraison 1', () => {
    expect(PALIERS.complet).toMatchObject({
      dpr: 1.5,
      halos: true,
      fond: '3d',
      brouillard: true,
      tonemapping: true,
      etincelles: true,
      ombres: true,
      affiches: 8,
    });
  });

  it('ne remonte jamais en passant au palier suivant', () => {
    for (let i = 1; i < ORDRE.length; i += 1) {
      const avant = PALIERS[ORDRE[i - 1]];
      const apres = PALIERS[ORDRE[i]];
      expect(apres.dpr).toBeLessThan(avant.dpr);
      expect(apres.lumieres).toBeLessThanOrEqual(avant.lumieres);
      expect(apres.affiches).toBeLessThanOrEqual(avant.affiches);
      expect(apres.segments).toBeLessThanOrEqual(avant.segments);
      expect(apres.ecranHz).toBeLessThanOrEqual(avant.ecranHz);
      expect(apres.resolutionEcran).toBeLessThanOrEqual(avant.resolutionEcran);
    }
  });

  it('remplace les halos 3D par des lueurs CSS dès qu’ils disparaissent', () => {
    for (const nom of ORDRE) {
      const palier = PALIERS[nom];
      if (!palier.halos) expect(palier.lueursCss).toBe(true);
    }
  });

  it('laisse toujours une image de fond : 3D ou CSS, jamais rien', () => {
    for (const nom of ORDRE) {
      expect(['3d', 'css']).toContain(PALIERS[nom].fond);
    }
  });

  it('garde le téléphone lisible au plancher (écran >= 320 px de large)', () => {
    expect(PALIERS.bas.resolutionEcran).toBeGreaterThanOrEqual(320);
    expect(PALIERS.bas.dpr).toBeGreaterThan(0);
  });
});

describe('palierDepuisUrl — les preuves se capturent par URL', () => {
  it('lit un palier valide', () => {
    expect(palierDepuisUrl('?palier=bas')).toBe('bas');
    expect(palierDepuisUrl('?immersion=complet&palier=moyen&perf=1')).toBe('moyen');
  });

  it('ne renvoie rien sans paramètre', () => {
    expect(palierDepuisUrl('')).toBeNull();
    expect(palierDepuisUrl('?immersion=complet')).toBeNull();
  });

  it('ignore une valeur inconnue plutôt que de casser la scène', () => {
    expect(palierDepuisUrl('?palier=ultra')).toBeNull();
    expect(palierDepuisUrl('?palier=BAS')).toBeNull();
  });
});

describe('palierInitial — le point de départ avant mesure', () => {
  it('part du rendu complet sur grand écran', () => {
    expect(palierInitial(false)).toBe('complet');
  });

  it('part déjà allégé sur mobile, où le GPU est plus faible', () => {
    expect(palierInitial(true)).toBe('moyen');
  });
});
