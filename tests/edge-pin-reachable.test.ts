import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Épinglage des artefacts Edge : le contrôle qui empêche un 503 en production.
 *
 * ## L'incident que ce fichier rend impossible
 * `business-grow/loader.ts` épinglait `4b584d9`, un commit qui n'existait QUE sur
 * une branche de travail. Après la fusion en squash de la PR, ce commit n'était
 * plus atteignable depuis `main` : le chargeur déployé aurait demandé
 * `raw.githubusercontent.com/.../<commit>/...`, reçu une erreur, et renvoyé
 * `503 BUSINESS_GROW_ARTIFACT_UNAVAILABLE`. Aucune fonctionnalité n'aurait
 * démarré, alors que tout était vert en local.
 *
 * ## Pourquoi les tests existants ne l'ont pas vu
 * `tests/store-import-artifact.test.ts` vérifie déjà l'empreinte réelle au
 * commit épinglé, mais il passe en `ctx.skip()` quand le commit est absent du
 * clone. Un contrôle qui s'ignore quand il ne peut pas conclure ne protège
 * rien : il donne l'illusion d'un contrôle. Ici, l'absence du commit est un
 * ÉCHEC explicite, et le contenu est lu par `git show` (le contenu réellement
 * présent au commit épinglé), jamais dans le fichier de travail.
 *
 * ## Ce que ces tests prouvent, et ce qu'ils ne prouvent PAS
 * Ils prouvent que le couple (commit épinglé, empreinte, taille) décrit le
 * contenu RÉEL de `main`. Ils ne prouvent pas que GitHub répondra au moment du
 * déploiement : cela dépend du réseau, pas du dépôt.
 */

interface ArtefactSuivi {
  nom: string;
  /** Chargeur réellement déployé. */
  loader: string;
  /** Chemin de l'artefact publié, tel que le chargeur le demande. */
  chemin: string;
}

const ARTEFACTS: readonly ArtefactSuivi[] = [
  {
    nom: 'business-grow',
    loader: 'supabase/functions/business-grow/loader.ts',
    chemin: 'supabase/functions/business-grow.edge.js',
  },
  {
    nom: 'store-import',
    loader: 'supabase/functions/store-import/loader.ts',
    chemin: 'supabase/functions/_artifacts/store-import.js',
  },
  {
    nom: 'store-connect',
    loader: 'supabase/functions/store-connect/loader.ts',
    chemin: 'supabase/functions/_artifacts/store-connect.js',
  },
];

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Le commit existe-t-il dans CE clone ? */
function commitPresent(commit: string): boolean {
  try {
    git(['cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Un clone tronqué rend l'ascendance invérifiable : la cause doit être dite. */
function avertissementCloneTronque(): string {
  try {
    return git(['rev-parse', '--is-shallow-repository']).trim() === 'true'
      ? ' (ce clone est tronqué : exécutez `git fetch --unshallow origin` pour rendre le contrôle concluant)'
      : '';
  } catch {
    return '';
  }
}

/**
 * Référence de `main` dans ce clone.
 *
 * `origin/main` d'abord (clone de travail), `main` ensuite (CI sur la branche
 * par défaut). Si AUCUNE n'existe, ce n'est pas « invérifiable » : c'est un
 * échec, car un épinglage qu'on ne peut rattacher à aucune branche publiée est
 * exactement ce qui a cassé le déploiement.
 */
function referenceMain(): string {
  for (const ref of ['origin/main', 'main']) {
    try {
      return git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    } catch {
      // On essaie la référence suivante.
    }
  }
  throw new Error(
    'aucune référence `main` dans ce clone (ni origin/main ni main) : '
    + 'impossible de rattacher l’épinglage à une branche publiée, donc impossible de l’accepter',
  );
}

/** Valeurs épinglées, lues dans le chargeur réellement déployé. */
function epingles(fichier: string): { commit: string; sha256: string; chars: number } {
  const source = readFileSync(fichier, 'utf8');
  const commit = /const COMMIT = "([0-9a-f]{40})"/.exec(source)?.[1];
  const sha256 = /const ARTIFACT_SHA256 = "([0-9a-f]{64})"/.exec(source)?.[1];
  const chars = Number(/const ARTIFACT_CHARS = (\d+);/.exec(source)?.[1]);
  if (!commit || !sha256 || !Number.isFinite(chars)) {
    throw new Error(`chargeur ${fichier} : commit, empreinte ou taille introuvable`);
  }
  return { commit, sha256, chars };
}

describe.each(ARTEFACTS)('épinglage de $nom — rattaché à main', ({ nom, loader, chemin }) => {
  const { commit, sha256, chars } = epingles(loader);

  /**
   * 1. Le commit épinglé existe dans ce clone.
   *
   * Échec, jamais `skip` : un chargeur qui pointe sur un commit introuvable ne
   * peut pas fonctionner en production, quelle qu'en soit la raison.
   */
  it('épingle un commit présent dans le dépôt', () => {
    expect(
      commitPresent(commit),
      `le commit épinglé ${commit} est absent de ce clone${avertissementCloneTronque()} : il a `
      + 'probablement été créé sur une branche puis perdu par une fusion en squash. '
      + 'Réépinglez sur un commit de main (§5 de docs/renommage-sorahnex.md).',
    ).toBe(true);
  });

  /**
   * 2. Ce commit fait partie de l'HISTORIQUE de `main`.
   *
   * C'est le cœur du défaut : un commit atteignable seulement depuis une branche
   * de travail peut disparaître à tout moment, et le contenu servi par
   * `raw.githubusercontent.com` dépend alors d'une référence qui s'évapore.
   */
  it('épingle un commit qui fait partie de l’historique de main', () => {
    expect(commitPresent(commit), `commit épinglé ${commit} absent de ce clone`).toBe(true);
    const main = referenceMain();
    let ancetre = true;
    try {
      git(['merge-base', '--is-ancestor', commit, main]);
    } catch {
      ancetre = false;
    }
    expect(
      ancetre,
      `le commit épinglé ${commit} n’est pas un ancêtre de main (${main.slice(0, 8)})`
      + `${avertissementCloneTronque()}. Une fusion en squash ne transporte pas le commit d’origine : `
      + 'réépinglez sur un commit de main, jamais sur une branche.',
    ).toBe(true);
  });

  /**
   * 3. L'artefact RÉELLEMENT présent à ce commit correspond à l'épingle.
   *
   * Lecture par `git show`, pas par le fichier local : c'est le contenu publié
   * que le chargeur téléchargera, et lui seul décide du démarrage.
   */
  it('publie exactement l’artefact de ce commit (empreinte et taille)', () => {
    expect(commitPresent(commit), `commit épinglé ${commit} absent de ce clone`).toBe(true);
    let contenu: string;
    try {
      contenu = git(['show', `${commit}:${chemin}`]);
    } catch {
      throw new Error(
        `l’artefact ${chemin} est ABSENT du commit épinglé ${commit} : le chargeur ne recevra rien `
        + 'et renverra 503. Committez l’artefact, puis réépinglez sur ce commit.',
      );
    }

    // L'empreinte porte sur les OCTETS, comme dans le chargeur.
    const empreinte = createHash('sha256').update(Buffer.from(contenu, 'utf8')).digest('hex');
    expect(empreinte, `l’artefact de ${commit.slice(0, 8)} ne correspond pas à l’empreinte épinglée`).toBe(sha256);

    /*
     * La taille est comparée en CARACTÈRES (`String.length` côté JavaScript),
     * pas en octets : un accent occupe deux octets en UTF-8 mais un seul
     * caractère. Confondre les deux ferait échouer à tort et pousserait à
     * « corriger » une épingle qui était juste.
     */
    expect(contenu.length, `taille réelle ${contenu.length} ≠ taille épinglée ${chars}`).toBe(chars);
  });

  /**
   * 4. `main` ne contient pas d'artefact plus récent que son épingle.
   *
   * ## Le défaut réel que ce contrôle a trouvé
   * `store-connect` épinglait le commit `0e49773` (81 320 caractères) alors que
   * la correction du 500 « column can_read does not exist » avait publié un
   * artefact plus récent (81 690 caractères) dans `main`. Le chargeur servait
   * donc l'ANCIEN code : le déploiement aurait reproduit le bug corrigé. Le
   * test historique ne le voyait pas, puisqu'il s'ignorait au titre d'un
   * « réépinglage en attente » — état qui, sur `main`, n'est pas une attente
   * mais une régression.
   *
   * ## Pourquoi ce n'est pas un piège pour le travail en cours
   * La comparaison se fait avec l'artefact de `main`, pas avec le fichier de
   * travail. Sur une branche qui prépare un nouvel artefact, `main` n'a pas
   * encore changé : le contrôle reste vert et la procédure en deux temps
   * (`docs/renommage-sorahnex.md` §5) se déroule normalement. Il ne rougit
   * qu'une fois l'artefact fusionné sans réépinglage — c'est-à-dire dans
   * l'unique état où la production sert du code périmé.
   */
  it('n’a pas, dans main, d’artefact plus récent que l’épingle', () => {
    const main = referenceMain();
    let artefactDeMain: string;
    try {
      artefactDeMain = git(['show', `${main}:${chemin}`]);
    } catch {
      throw new Error(`l’artefact ${chemin} est absent de main : le chargeur ne peut rien servir`);
    }

    const empreinteMain = createHash('sha256').update(Buffer.from(artefactDeMain, 'utf8')).digest('hex');
    expect(
      empreinteMain,
      `main publie un ${nom} de ${artefactDeMain.length} caractères (${empreinteMain.slice(0, 8)}), `
      + `mais le chargeur épingle ${chars} caractères (${sha256.slice(0, 8)}) : la production `
      + 'exécuterait une version périmée. Réépinglez sur le commit de main qui contient cet artefact '
      + '(`EDGE_PIN_COMMIT=<sha> node scripts/build-edge-artifact.mjs ' + nom + '`).',
    ).toBe(sha256);
  });
});
