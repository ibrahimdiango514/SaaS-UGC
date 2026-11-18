/**
 * Chargeur Edge « GitHub épinglé » — contrat du générateur partagé.
 *
 * ## Pourquoi ce fichier existe
 * `business-grow` et `store-import` produisaient chacun leur chargeur, et les
 * deux copies avaient divergé : l'une retirait le saut de ligne final avant de
 * calculer l'empreinte, l'autre non. Un chargeur qui calcule l'empreinte sur
 * autre chose que le fichier committé refuse un bundle pourtant légitime — la
 * fonction tombe alors en panne au premier redémarrage. Ces tests verrouillent
 * les propriétés qui rendent ce mécanisme sûr, une fois pour les deux.
 *
 * ## Ce que ces tests ne prouvent pas
 * Ils ne prouvent pas que le commit épinglé existe sur GitHub ni que le réseau
 * répondra. Cela se constate en production ; le fichier épinglé est vérifié
 * séparément dans les tests d'artefact de chaque fonction.
 */
import { describe, expect, it } from 'vitest';
import {
  GITHUB_REPO,
  MARQUEURS_INTERDITS,
  renderGithubLoader,
  validerCommit,
  validerEmpreinte,
  verifierChargeur,
} from '../scripts/edge-github-loader.mjs';

const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

function chargeur(surcharge: Record<string, unknown> = {}) {
  return renderGithubLoader({
    fonction: 'store-import',
    path: 'supabase/functions/_artifacts/store-import.js',
    sha256: SHA,
    chars: 37_387,
    commit: COMMIT,
    ...surcharge,
  });
}

describe('générateur de chargeur — épinglage', () => {
  it('accepte un commit complet et le conserve tel quel', () => {
    expect(validerCommit(COMMIT)).toBe(COMMIT);
    expect(validerCommit(`  ${COMMIT.toUpperCase()}  `)).toBe(COMMIT);
  });

  it('refuse une branche mouvante', () => {
    // `main` avance : la même URL servirait demain un autre contenu, et
    // l'empreinte épinglée deviendrait fausse — panne au redémarrage suivant.
    for (const branche of ['main', 'develop', 'master', 'HEAD', 'Main']) {
      expect(() => validerCommit(branche)).toThrow();
    }
  });

  it('refuse un identifiant trop court ou mal formé', () => {
    for (const valeur of ['abc', '', 'g'.repeat(40), `${COMMIT}0`]) {
      expect(() => validerCommit(valeur)).toThrow();
    }
  });

  it('refuse une empreinte qui n’est pas un SHA-256', () => {
    for (const valeur of ['', 'abc', 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(() => validerEmpreinte(valeur)).toThrow();
    }
  });

  it('refuse une taille nulle ou non entière', () => {
    expect(() => chargeur({ chars: 0 })).toThrow();
    expect(() => chargeur({ chars: -1 })).toThrow();
    expect(() => chargeur({ chars: 12.5 })).toThrow();
  });
});

describe('générateur de chargeur — contenu produit', () => {
  it('ne contient ni placeholder ni référence à une branche', () => {
    const code = chargeur();
    expect(verifierChargeur(code)).toEqual([]);
    for (const { motif } of MARQUEURS_INTERDITS) {
      expect(motif.test(code)).toBe(false);
    }
  });

  it('vérifie la taille AVANT l’empreinte, et l’empreinte AVANT l’exécution', () => {
    // L'ordre n'est pas cosmétique : exécuter avant de vérifier reviendrait à
    // faire confiance à ce que le réseau a renvoyé.
    const code = chargeur();
    const taille = code.indexOf('source.length !== ARTIFACT_CHARS');
    const empreinte = code.indexOf('hex !== ARTIFACT_SHA256');
    const execution = code.indexOf('new Function(CODE)()');
    expect(taille).toBeGreaterThan(-1);
    expect(empreinte).toBeGreaterThan(taille);
    expect(execution).toBeGreaterThan(empreinte);
  });

  it('n’exécute jamais un code vide ou partiel', () => {
    const code = chargeur();
    expect(code).toContain('if (CODE) {');
    expect(code).toContain('status: 503');
    // Un seul point d'exécution : pas de « tentative quand même » ailleurs.
    expect(code.match(/new Function\(/g)).toHaveLength(1);
  });

  it('tente trois fois et bascule sur l’API GitHub en second recours', () => {
    const code = chargeur();
    expect(code).toContain('essai <= 3');
    expect(code).toContain('raw.githubusercontent.com');
    expect(code).toContain('api.github.com');
    // Les deux sources sont essayées dans l'ordre, sans court-circuit.
    expect(code.indexOf('raw.githubusercontent.com')).toBeLessThan(code.indexOf('api.github.com'));
  });

  it('ne retire pas le saut de ligne final', () => {
    // Piège réel : `store-import` le retirait, et l'empreinte portait alors sur
    // un contenu différent du fichier committé.
    const code = chargeur();
    expect(code).not.toContain('endsWith("\\n")');
    expect(code).not.toContain("endsWith('\\n')");
  });

  it('injecte la dépendance postgres avant d’exécuter le bundle', () => {
    const code = chargeur({ chargeur: '__bgPostgres' });
    const injection = code.indexOf('__bgPostgres = postgres');
    const execution = code.indexOf('new Function(CODE)()');
    expect(injection).toBeGreaterThan(-1);
    expect(injection).toBeLessThan(execution);
  });

  it('produit un corps court, compatible avec le canal de déploiement', () => {
    // Le canal altère les corps longs : c'est la raison d'être du chargeur.
    expect(chargeur().length).toBeLessThan(8_000);
  });

  it('reprend le dépôt public configuré', () => {
    expect(chargeur()).toContain(`const REPO = "${GITHUB_REPO}";`);
  });
});

describe('générateur de chargeur — deux fonctions, un seul mécanisme', () => {
  it('produit le même squelette pour les deux fonctions', () => {
    const commun = chargeur();
    const grow = renderGithubLoader({
      fonction: 'business-grow',
      path: 'supabase/functions/business-grow.edge.js',
      sha256: SHA,
      chars: 88_231,
      commit: COMMIT,
      chargeur: '__bgPostgres',
      codeIndisponible: 'BUSINESS_GROW_ARTIFACT_UNAVAILABLE',
    });
    // Ce qui doit différer : le nom, le chemin, la dépendance injectée.
    expect(commun).toContain('store-import');
    expect(grow).toContain('business-grow');
    expect(commun).toContain('__edgePostgres');
    expect(grow).toContain('__bgPostgres');
    // Ce qui ne doit PAS différer : les contrôles de sécurité.
    for (const invariant of [
      'source.length !== ARTIFACT_CHARS',
      'hex !== ARTIFACT_SHA256',
      'if (CODE) {',
      'status: 503',
      'essai <= 3',
    ]) {
      expect(commun).toContain(invariant);
      expect(grow).toContain(invariant);
    }
  });

  it('refuse de produire un chargeur non conforme', () => {
    // Le générateur échoue à la construction plutôt que de laisser passer un
    // chargeur qui exécuterait sans vérifier.
    const code = chargeur();
    expect(verifierChargeur(code)).toEqual([]);
    // Altération volontaire : l'exécution passe avant la vérification.
    const altere = code
      .replace('if (source.length !== ARTIFACT_CHARS)', 'if (false)')
      .replace('if (hex !== ARTIFACT_SHA256)', 'if (false)');
    expect(verifierChargeur(altere)).toContain('contrôle de taille absent');
  });

  it('détecte un placeholder laissé dans un chargeur', () => {
    expect(verifierChargeur(chargeur().replace('new Function(CODE)()', 'new Function("__PAYLOAD__")()')))
      .toContain('placeholder du type __VALEUR__');
  });
});
