/**
 * Expérience 3D — la caméra et le récit, vérifiés sans navigateur.
 *
 * ## Pourquoi ces tests existent
 * La livraison précédente affirmait « caméra en mouvement » alors que rien ne
 * bougeait réellement. Une capture ne prouve pas un mouvement : elle montre
 * une image. `etatCamera` est donc une fonction pure du progrès, et ces tests
 * la font parler : la caméra avance, elle dépasse le téléphone, elle arrive
 * devant l'écran du Studio, et le récit passe bien par quatre étapes.
 *
 * Ils protègent aussi deux exigences mesurables du brief : le téléphone
 * occupe au moins 60 % de la hauteur visible sur mobile, et le CTA n'est
 * jamais repoussé par une scène.
 */
import { describe, expect, it } from 'vitest';
import {
  ETAPES_STUDIO,
  etatCamera,
  etapeStudio,
  FOV,
  HAUTEUR_TELEPHONE,
  partHauteurTelephone,
  POSITION_ECRAN,
  profondeurArrivee,
  profondeurDepart,
} from '../src/landing/monde/camera';
import { phaseExperience } from '../src/landing/monde/progres';

const PROGRES = Array.from({ length: 41 }, (_, i) => i / 40);

describe('Caméra — elle avance vraiment', () => {
  it('avance en profondeur de façon monotone, du hero jusqu’à l’écran', () => {
    const z = PROGRES.map((p) => etatCamera(p, false).position[2]);
    for (let i = 1; i < z.length; i += 1) {
      expect(z[i], `la caméra recule entre ${PROGRES[i - 1]} et ${PROGRES[i]}`).toBeLessThan(z[i - 1]);
    }
    expect(z[0]).toBeCloseTo(profondeurDepart(false), 5);
    expect(z[z.length - 1]).toBeCloseTo(profondeurArrivee(false), 5);
  });

  it('dépasse le téléphone : au-delà de la moitié, la caméra est derrière lui', () => {
    // Le téléphone est à z = 0. Une caméra restée devant lui ne raconte rien.
    expect(etatCamera(0.5, false).position[2]).toBeLessThan(0);
    expect(etatCamera(1, false).position[2]).toBeLessThan(0);
  });

  it('finit devant l’écran du Studio, à distance de lecture', () => {
    const arrivee = etatCamera(1, false);
    const distance = Math.abs(arrivee.position[2] - POSITION_ECRAN[2]);
    // Assez loin pour voir la dalle entière, assez près pour lire son texte.
    expect(distance).toBeGreaterThan(4);
    expect(distance).toBeLessThan(14);
  });

  it('bouge aussi latéralement et verticalement : ce n’est pas un travelling droit', () => {
    const xs = PROGRES.map((p) => etatCamera(p, false).position[0]);
    const ys = PROGRES.map((p) => etatCamera(p, false).position[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.05);
  });

  it('garde une cible qui avance aussi (la caméra regarde où elle va)', () => {
    const cibles = PROGRES.map((p) => etatCamera(p, false).cible[2]);
    for (let i = 1; i < cibles.length; i += 1) {
      expect(cibles[i]).toBeLessThanOrEqual(cibles[i - 1]);
    }
    expect(cibles[cibles.length - 1]).toBeLessThan(-15);
  });

  it('borne le progrès : hors [0,1], aucune position aberrante', () => {
    expect(etatCamera(-3, false)).toEqual(etatCamera(0, false));
    expect(etatCamera(9, false)).toEqual(etatCamera(1, false));
  });
});

describe('Cadrage — le téléphone tient ses promesses de taille', () => {
  it('occupe au moins 60 % de la hauteur visible sur mobile', () => {
    expect(partHauteurTelephone(true)).toBeGreaterThanOrEqual(0.6);
  });

  it('la part visible du téléphone se calcule bien avec le FOV réel', () => {
    const visible = 2 * profondeurDepart(true) * Math.tan((FOV * Math.PI) / 360);
    expect(partHauteurTelephone(true)).toBeCloseTo(HAUTEUR_TELEPHONE / visible, 6);
  });

  it('recule davantage en portrait pour que l’écran reste lisible', () => {
    expect(profondeurArrivee(true)).toBeGreaterThan(profondeurArrivee(false));
  });
});

describe('Récit — quatre étapes de Studio, dans l’ordre', () => {
  it('parcourt Brief → Script → Storyboard → Vidéo', () => {
    expect(ETAPES_STUDIO.map((e) => e.cle)).toEqual(['brief', 'script', 'storyboard', 'video']);
    expect(etapeStudio(ETAPES_STUDIO[0].de)).toBe(0);
    expect(etapeStudio(ETAPES_STUDIO[1].de)).toBe(1);
    expect(etapeStudio(ETAPES_STUDIO[2].de)).toBe(2);
    expect(etapeStudio(1)).toBe(3);
  });

  it('ne saute aucune étape sur le trajet complet', () => {
    const vues = new Set(PROGRES.map((p) => etapeStudio(p)));
    expect([...vues].sort()).toEqual([0, 1, 2, 3]);
  });

  it('passe du hero au Studio par une transition courte', () => {
    expect(phaseExperience(0)).toBe('hero');
    expect(phaseExperience(0.18)).toBe('transition');
    expect(phaseExperience(0.6)).toBe('studio');
  });
});
