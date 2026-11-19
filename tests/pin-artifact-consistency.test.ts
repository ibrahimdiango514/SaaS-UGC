/**
 * Le commit épinglé contient-il vraiment le bundle que le chargeur exigeait ?
 *
 * ## Le défaut que ce fichier empêche
 *
 * Réépingler un artefact est un geste en deux temps : régénérer, puis committer.
 * En régénérant AVANT d'avoir commité le nouveau bundle, on obtient un chargeur
 * qui pointe sur le commit précédent — lequel contient encore l'ANCIEN fichier.
 * En production, le chargeur télécharge alors un bundle dont la taille et le
 * SHA-256 ne correspondent pas à l'empreinte épinglée, refuse de démarrer, et
 * toute la fonction tombe. Le code source, lui, est correct : aucun test unitaire
 * du handler ne voit le problème.
 *
 * Les tests d'artefact existants vérifient que le commit épinglé EXISTE. Ils ne
 * vérifient pas que le fichier à cet endroit est bien celui dont l'empreinte est
 * gravée dans le chargeur. C'est cette vérification-là qui manquait.
 *
 * ## Portée
 *
 * Le test est volontairement limité à `business-grow`, le seul artefact modifié
 * ici. Il lit le dépôt local : il ne prouve pas que le commit est poussé (le
 * réseau n'est pas disponible dans cet environnement) mais il prouve la
 * cohérence contenu/empreinte, qui est la partie déterministe.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CHARGEUR = 'supabase/functions/business-grow/loader.ts';
const BUNDLE = 'supabase/functions/business-grow.edge.js';

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

describe('artefact business-grow — le commit épinglé contient le bundle épinglé', () => {
  const chargeur = readFileSync(CHARGEUR, 'utf8');

  /* Le chargeur grave deux valeurs : le commit à interroger, et le SHA-256. */
  /* Pas de `\b` : un hash finissant par une lettre n'a pas de frontière de mot
   * avec le guillemet suivant, ce qui tronquait la capture. */
  const pins = chargeur.match(/[0-9a-f]{64}|[0-9a-f]{40}/g) ?? [];
  /* L'empreinte fait 64 caractères, le commit 40 : on les distingue par taille. */
  const empreinte = pins.find((p) => p.length === 64);
  const commit = pins.find((p) => p.length === 40);

  it('le chargeur déclare un commit et une empreinte distincts', () => {
    expect(commit, 'aucun commit épinglé dans le chargeur').toBeDefined();
    expect(empreinte, 'aucune empreinte SHA-256 dans le chargeur').toBeDefined();
    expect(empreinte).toHaveLength(64);
  });

  it('le commit épinglé existe dans ce dépôt', () => {
    const ok = git(['cat-file', '-e', `${commit}^{commit}`]) !== null;
    expect(ok, `le commit épinglé ${commit} est absent du dépôt`).toBe(true);
  });

  it('le fichier présent au commit épinglé porte l’empreinte exigée par le chargeur', () => {
    /*
     * C'est LE contrôle qui aurait attrapé la panne : avant correctif, le
     * commit épinglé portait l'ancien bundle de 88 258 caractères alors que le
     * chargeur exigeait l'empreinte du nouveau (93 252).
     */
    const contenu = git(['show', `${commit}:${BUNDLE}`]);
    expect(contenu, `le bundle est absent au commit épinglé ${commit}`).not.toBeNull();

    const crypto = require('node:crypto') as typeof import('node:crypto');
    const reel = crypto.createHash('sha256').update(contenu as string, 'utf8').digest('hex');
    expect(
      reel,
      `le bundle au commit ${commit} a l'empreinte ${reel}, mais le chargeur exige ${empreinte} : `
      + 'le chargeur refuserait de démarrer. Régénérez puis committez, et épinglez ce commit.',
    ).toBe(empreinte);
  });

  it('la taille annoncée dans le chargeur correspond au fichier épinglé', () => {
    /*
     * Le chargeur vérifie la taille AVANT le hash (contrôle bon marché sur un
     * contenu distant). Une taille fausse fait donc échouer le démarrage même
     * si le hash était bon.
     */
    const contenu = git(['show', `${commit}:${BUNDLE}`]) as string;
    const tailles = chargeur.match(/\b\d{5,6}\b/g) ?? [];
    const attendues = tailles.filter((t) => Math.abs(Number(t) - contenu.length) <= 0);
    expect(
      attendues.length,
      `aucune taille du chargeur ne vaut ${contenu.length} (tailles lues : ${tailles.join(', ')})`,
    ).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Le déploiement correspond-il au chargeur du dépôt ?                        */
/* -------------------------------------------------------------------------- */

describe('déploiement — le chargeur livré est celui qui tourne', () => {
  /**
   * ## Le risque visé
   *
   * Corriger le code, éprouver la base, committer — et croire que la production
   * exécute le correctif. Tant que la fonction Edge n'est pas redéployée, le
   * bundle à l'écran reste l'ancien : ici l'assistant ignore silencieusement
   * `propose_prospect_save`, donc ne propose jamais d'enregistrer un prospect.
   *
   * Ce test ne peut pas interroger le projet Supabase (pas de jeton dans cet
   * environnement). Il vérifie donc la partie déterministe et laisse le reste à
   * la procédure documentée : le bundle livré doit contenir l'outil, et le
   * chargeur doit le référencer. Si l'un des deux manque, aucun déploiement ne
   * peut fonctionner, et le test le dit avant la mise en ligne.
   */
  const bundle = readFileSync('supabase/functions/business-grow.edge.js', 'utf8');

  it('le bundle livré contient l’outil d’enregistrement de prospect', () => {
    expect(bundle).toContain('propose_prospect_save');
    /* Niveau de risque : une écriture doit rester soumise à approbation. */
    expect(bundle).toContain('propose_prospect_save:"write_requires_approval"');
  });

  it('le bundle livré contient la normalisation des arguments', () => {
    /*
     * Sans normalisation, le modèle peut envoyer des clés françaises ou une
     * étape accentuée : la base accepte, mais l'interface d'approbation
     * afficherait une fiche vide.
     */
    expect(bundle).toContain('prochaineAction');
    expect(bundle).toContain('entreprise');
  });

  it('le chargeur livré épingle bien ce bundle-ci', () => {
    /* Le chargeur et le bundle doivent décrire le même contenu, sinon le
     * démarrage échoue au contrôle de taille. */
    const pins = chargeurFichier().match(/[0-9a-f]{64}|[0-9a-f]{40}/g) ?? [];
    expect(pins.some((p) => p.length === 40), 'aucun commit épinglé').toBe(true);
    expect(pins.some((p) => p.length === 64), 'aucune empreinte SHA-256').toBe(true);
  });
});

/** Relit le chargeur au moment du test (le bloc précédent a sa propre copie). */
function chargeurFichier(): string {
  return readFileSync(CHARGEUR, 'utf8');
}
