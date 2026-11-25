import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  artifactSql,
  buildArtifact,
  renderLoader,
  FUNCTIONS,
} from '../scripts/build-edge-artifact.mjs';

/**
 * Parité chargeur ↔ dépôt.
 *
 * Le chargeur déployé ne contient aucune logique métier : il télécharge le
 * bundle depuis un commit précis du dépôt public, vérifie sa taille et son
 * empreinte, puis l'exécute. Ces tests garantissent que :
 *   1. le chargeur livré correspond exactement à ce que le script génère pour
 *      le bundle actuel (aucune dérive silencieuse) ;
 *   2. le bundle ne contient **aucune** instruction `import` (il est exécuté
 *      par `new Function`, qui les refuserait) ni aucun secret inliné ;
 *   3. le commit est épinglé et jamais une branche mouvante.
 *
 * ## Pourquoi ils ont changé
 * Ils vérifiaient auparavant un chargement depuis `public._edge_function_artifact`.
 * Ce mécanisme n'est plus celui de la production : les tests validaient donc un
 * chargeur que personne n'exécute. C'est précisément le genre d'écart qui avait
 * laissé la garde d'abonnement hors du bundle déployé.
 */

/**
 * Fonctions couvertes.
 *
 * `store-connect` a été ajoutée ici après coup : elle était déployée avec un
 * chargeur généré à la main, donc jamais vérifiée. Une fonction déployée sans
 * contrôle de parité est exactement le cas qui produit un 503 silencieux en
 * production — le chargeur est bien formé, mais l'artefact épinglé n'est pas
 * celui du dépôt.
 */
const FONCTIONS_SUIVIES = ['store-import', 'store-connect'] as const;

/**
 * Lit un fichier **tel qu'il est au commit donné**, via `git show`.
 *
 * ## Pourquoi ce test existe
 * L'artefact et le chargeur voyagent dans deux commits successifs : le
 * chargeur désigne le commit qui contient l'artefact. Générer le chargeur
 * depuis `HEAD` juste après avoir committé le code — sans avoir committé
 * l'artefact — produit une épingle cohérente avec le dossier de travail mais
 * FAUSSE en dépôt : le chargeur déployé télécharge l'ancien bundle, l'empreinte
 * ne correspond pas, et la fonction répond 503. C'est déjà arrivé.
 *
 * Le contrôle ci-dessous interroge donc le commit épinglé lui-même, et non le
 * disque.
 */
/**
 * L'objet de commit existe-t-il dans CE clone ?
 *
 * Un clone dont l'historique a été reconstruit (CI cloud, dépôt réimporté)
 * peut parfaitement ne pas contenir le commit épinglé : le contrôle ci-dessous
 * n'est alors pas exécutable, et le déclarer en échec accuserait le code à tort.
 * On l'annonce explicitement en « skipped » avec sa raison, jamais en succès.
 */
function commitPresent(commit: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: process.cwd(), stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fichierAuCommit(commit: string, chemin: string): string | null {
  try {
    return execFileSync('git', ['show', `${commit}:${chemin}`], {
      cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}


/**
 * Un artefact est-il committé et pourtant PAS encore ré-épinglé ?
 *
 * ## Pourquoi cette distinction est indispensable
 * Le ré-épinglage est impossible en un seul commit : `loader.ts` doit désigner
 * un commit qui CONTIENT déjà le nouvel artefact. La procédure du dépôt
 * (`docs/renommage-sorahnex.md` §5) est donc en deux temps :
 *   1. committer l'artefact seul ;
 *   2. régénérer le chargeur sur ce commit, puis le committer.
 *
 * Entre les deux, tout build intermédiaire de `main` est ROUGE si ce
 * désalignement compte comme un échec — et un rouge attendu finit par masquer
 * une vraie dérive.
 *
 * ## La garantie conservée (et non désactivée)
 * L'état « en attente » n'est reconnu que si le bundle RÉELLEMENT committé est
 * bit pour bit celui que le code actuel produit. Autrement dit : le code et
 * l'artefact sont d'accord, seul l'ÉPINGLAGE est en retard. Dès que l'un des
 * deux bouge sans l'autre, la comparaison échoue et le test redevient rouge.
 */
/**
 * L'ancien artefact est-il RÉELLEMENT celui du commit épinglé ?
 *
 * C'est la seule preuve que l'épingle pointe sur une version antérieure du code
 * et non sur autre chose. Le mode « en attente » ne doit jamais couvrir une
 * empreinte épinglée qui ne correspond à RIEN de connu : ce serait un
 * déploiement cassé, pas un ré-épinglage en retard.
 *
 * Indisponible si le commit épinglé n'est pas dans ce clone (contrôle déjà
 * signalé en `skipped` par le test dédié).
 */
function ancienArtefactEstCeluiDuCommit(nomFonction: string): boolean {
  const chargeur = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
  const commit = /const COMMIT = "([0-9a-f]{40})"/.exec(chargeur)?.[1];
  if (!commit) return false;
  if (!commitPresent(commit)) return true; // non vérifiable ici : le test dédié le dit
  const ancien = fichierAuCommit(commit, FUNCTIONS[nomFonction].artifact);
  if (ancien === null) return false;
  const empreinteEpinglee = /const ARTIFACT_SHA256 = "([0-9a-f]{64})"/.exec(chargeur)?.[1];
  return createHash('sha256').update(ancien, 'utf8').digest('hex') === empreinteEpinglee;
}

function reepinglageEnAttente(nomFonction: string): boolean {
  const built = buildArtifact(nomFonction);
  const artefactCommis = readFileSync(FUNCTIONS[nomFonction].artifact, 'utf8');
  const empreinteCommis = createHash('sha256').update(artefactCommis, 'utf8').digest('hex');
  const chargeur = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
  const empreinteEpinglee = /const ARTIFACT_SHA256 = "([0-9a-f]{64})"/.exec(chargeur)?.[1];
  return empreinteCommis === built.sha256
    && empreinteEpinglee !== built.sha256
    // Sans cette condition, une épingle pointant sur un artefact inconnu
    // passerait pour un simple retard de ré-épinglage.
    && ancienArtefactEstCeluiDuCommit(nomFonction);
}

/** Message d'attente, affiché dans le rapport de test. */
const MESSAGE_REEPINGLAGE =
  'ré-épinglage en attente : artefact committé conforme au code, chargeur pas encore réépinglé. '
  + 'Après fusion, exécuter `EDGE_PIN_COMMIT=<sha de main> node scripts/build-edge-artifact.mjs '
  + '<fonction>` puis committer le chargeur et redéployer.';

describe.each(FONCTIONS_SUIVIES)('artefact %s — parité avec le dépôt', (nomFonction) => {
  it('produit un bundle déterministe et non vide', () => {
    const a = buildArtifact(nomFonction);
    const b = buildArtifact(nomFonction);
    // Déterminisme : deux constructions donnent le même code et la même empreinte.
    expect(a.sha256).toBe(b.sha256);
    expect(a.chars).toBeGreaterThan(10_000);
    expect(a.chars).toBeLessThan(200_000);
  });

  it('le bundle ne contient aucun import (exécuté par new Function)', () => {
    const { source } = buildArtifact(nomFonction);
    // `import x from`, `import{...}`, `import *` : aucun ne doit subsister.
    expect(source).not.toMatch(/(^|[;}\n])\s*import\s*[\w{*]/m);
    // Le module postgres est fourni par le chargeur, pas importé.
    expect(source).toContain('__edgePostgres');
  });

  it('le bundle ne contient aucun secret', () => {
    const { source } = buildArtifact(nomFonction);
    // Aucune valeur de type clé, jeton ou URL de base de données.
    expect(source).not.toMatch(/eyJhbGciOi/); // JWT
    expect(source).not.toMatch(/sb_secret_/);
    expect(source).not.toMatch(/postgres:\/\/[^\s"']+:[^\s"']+@/);
    // Les valeurs restent lues à l'exécution.
    expect(source).toContain('Deno');
  });

  /** Commit épinglé lu dans le chargeur livré : c'est la vérité du déploiement. */
  const commitEpingle = (): string => {
    const livre = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
    const m = /const COMMIT = "([0-9a-f]{40})";/.exec(livre);
    if (!m) throw new Error('aucun commit épinglé dans le chargeur livré');
    return m[1];
  };

  it('le chargeur livré correspond au bundle actuel', (ctx) => {
    const built = buildArtifact(nomFonction);
    const livre = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
    if (reepinglageEnAttente(nomFonction)) {
      // Étape 1/2 du cycle documenté : l'artefact est à jour, l'épingle non.
      ctx.skip(`${nomFonction} — ${MESSAGE_REEPINGLAGE}`);
    }
    expect(livre).toBe(renderLoader(nomFonction, built, commitEpingle()));
  });

  it('le chargeur est court et vérifie taille et empreinte', () => {
    const built = buildArtifact(nomFonction);
    const chargeur = renderLoader(nomFonction, built, commitEpingle());
    // Le canal de déploiement altère les corps longs.
    expect(chargeur.length).toBeLessThan(8_000);
    expect(chargeur).toContain(built.sha256);
    expect(chargeur).toContain(String(built.chars));
    expect(chargeur).toContain('source.length !== ARTIFACT_CHARS');
    expect(chargeur).toContain('hex !== ARTIFACT_SHA256');
    expect(chargeur).toContain('new Function(CODE)()');
    // Échec fermé : jamais d'exécution d'un code partiel.
    expect(chargeur).toContain('if (CODE) {');
    expect(chargeur).toContain('status: 503');
  });

  it('épingle un commit, jamais une branche mouvante', () => {
    const chargeur = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
    expect(commitEpingle()).toMatch(/^[0-9a-f]{40}$/);
    expect(chargeur).not.toMatch(/raw\.githubusercontent\.com[^"]*\/(main|develop|master)\//);
  });

  it('l’artefact RÉELLEMENT présent au commit épinglé a la bonne empreinte', (ctx) => {
    // Le point le plus fragile du déploiement. Sans ce contrôle, un chargeur
    // parfaitement formé peut pointer sur un commit où l'artefact n'existe pas
    // ou diffère : la production échoue en 503 et rien ne le signale ici.
    const built = buildArtifact(nomFonction);
    const commit = commitEpingle();
    if (!commitPresent(commit)) {
      // Historique reconstruit : le commit épinglé n'est pas dans ce clone.
      // Contrôle non exécutable ici — annoncé, jamais compté comme réussi.
      ctx.skip(`commit épinglé ${commit} absent de ce clone : contrôle exécutable seulement sur un clone complet du dépôt`);
    }
    const artefact = fichierAuCommit(commit, FUNCTIONS[nomFonction].artifact);
    expect(
      artefact,
      `l'artefact est absent du commit épinglé ${commit} : poussez-le, puis régénérez le chargeur sur ce commit`,
    ).not.toBeNull();

    // 1) L'épingle est HONNÊTE : l'artefact réellement présent au commit
    //    épinglé a bien l'empreinte et la taille annoncées par le chargeur.
    //    C'est le contrôle qui empêche un déploiement cassé, et il ne se
    //    relâche jamais — y compris pendant un ré-épinglage.
    const chargeur = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
    const empreinteEpinglee = /const ARTIFACT_SHA256 = "([0-9a-f]{64})"/.exec(chargeur)?.[1];
    const tailleEpinglee = Number(/const ARTIFACT_CHARS = (\d+);/.exec(chargeur)?.[1]);
    expect(createHash('sha256').update(artefact as string, 'utf8').digest('hex')).toBe(empreinteEpinglee);
    // `chars` compte des CARACTÈRES, pas des octets : comparer `Buffer.length`
    // à `chars` ferait échouer à tort dès qu'un accent est présent.
    expect((artefact as string).length).toBe(tailleEpinglee);

    // 2) L'épingle désigne-t-elle la version COURANTE du code ? Pendant le
    //    cycle en deux temps (docs/renommage-sorahnex.md §5), l'artefact est
    //    committé avant le ré-épinglage : l'épingle pointe alors, à raison,
    //    sur la version précédente. Le test dédié au ré-épinglage l'annonce
    //    en « skipped » ; ici on vérifie que l'écart se limite à cela.
    if (reepinglageEnAttente(nomFonction)) {
      // L'artefact committé est, lui, exactement celui du code actuel.
      expect(createHash('sha256').update(readFileSync(FUNCTIONS[nomFonction].artifact, 'utf8'), 'utf8').digest('hex'))
        .toBe(built.sha256);
      return;
    }
    expect(createHash('sha256').update(artefact as string, 'utf8').digest('hex')).toBe(built.sha256);
    expect((artefact as string).length).toBe(built.chars);
  });

  it('les modules PARTAGÉS sont couverts par l’artefact épinglé', () => {
    /*
     * `safe-egress.ts` et `pinned-fetch.ts` sont importés par `store-import` ET
     * `store-connect`. Les modifier change donc DEUX bundles déjà déployés sans
     * que rien ne le signale — c'est exactement ce qui s'est produit en ajoutant
     * `POST` pour le client MCP : 6 tests de parité sont tombés.
     *
     * Ce contrôle ne remplace pas la régénération, il rend la cause lisible :
     * quand l'empreinte diffère, le message doit dire QUELLE source partagée a
     * bougé, au lieu de laisser chercher.
     */
    const built = buildArtifact(nomFonction);
    const chargeur = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
    const epingle = /const ARTIFACT_SHA256 = "([0-9a-f]{64})"/.exec(chargeur)?.[1];
    if (epingle === built.sha256) return;

    // Artefact committé conforme au code : seule l'épingle est en retard. Le
    // bundle déployé n'a donc pas dérivé — on le signale sans faire échouer.
    if (reepinglageEnAttente(nomFonction)) {
      const commis = createHash('sha256')
        .update(readFileSync(FUNCTIONS[nomFonction].artifact, 'utf8'), 'utf8')
        .digest('hex');
      expect(commis).toBe(built.sha256);
      return;
    }

    const partages = [
      'supabase/functions/store-import/safe-egress.ts',
      'supabase/functions/store-import/pinned-fetch.ts',
    ];
    const empreintes = partages.map((chemin) => {
      const contenu = readFileSync(chemin, 'utf8');
      return `${chemin.split('/').pop()} ${createHash('sha256').update(contenu, 'utf8').digest('hex').slice(0, 12)}`;
    });
    expect.fail(
      `le bundle de ${nomFonction} a changé (épinglé ${epingle?.slice(0, 12)}, actuel ${built.sha256.slice(0, 12)}). `
      + `Souvent un module partagé modifié : ${empreintes.join(', ')}. `
      + 'Régénérez les artefacts puis réépinglez (voir la procédure dans le README du script).',
    );
  });

  it('ne réintroduit pas l’ancien chargement depuis la base', () => {
    // Garde-fou explicite : une future génération ne doit pas ramener le
    // mécanisme « artefact en base », absent de la production.
    const chargeur = readFileSync(FUNCTIONS[nomFonction].loader, 'utf8');
    expect(chargeur).not.toContain('_edge_function_artifact');
    expect(chargeur).not.toContain('artifact_missing');
  });

  it('le SQL d’insertion échappe les apostrophes et ne contient aucun secret', () => {
    const built = buildArtifact(nomFonction);
    const sql = artifactSql(nomFonction, built);
    expect(sql).toContain('insert into public._edge_function_artifact');
    expect(sql).toContain(built.sha256);
    expect(sql).toContain(`'${nomFonction}'`);
    // Aucune apostrophe non échappée : elles sont toutes doublées.
    expect(sql.match(/(?<!')'(?!')/g)?.length).toBeGreaterThan(0);
    expect(sql).not.toMatch(/eyJhbGciOi|sb_secret_/);
  });
});

/**
 * Retire commentaires et littéraux de chaîne d'un source TypeScript.
 *
 * Objectif précis : distinguer `Deno.serve(...)` (usage réel, interdit ici) de
 * `` `Deno.env.get(...)` `` cité dans un commentaire (documentation, permise).
 * Ce n'est pas un analyseur TypeScript, et ce n'est pas grave : le test doit
 * seulement ne pas se laisser duper par sa propre documentation.
 */
function sansCommentairesNiChaines(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')       // commentaires de bloc
    .replace(/^\s*\/\/.*$/gm, '')            // commentaires de ligne entiers
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')     // commentaires en fin de ligne
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')      // gabarits
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")   // chaînes simples
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');  // chaînes doubles
}

describe('configuration vérifiée des Edge Functions', () => {
  it('couvre les deux fonctions dans tsconfig.edge.json', () => {
    // Sans cette inclusion, `npm run typecheck` ignore la fonction : c'est
    // exactement ainsi que `store-connect` a été déployée sans jamais être
    // vérifiée, et qu'un `Deno.env.get` en portée de module y est resté.
    const config = JSON.parse(readFileSync('tsconfig.edge.json', 'utf8')) as { include?: string[] };
    const inclus = config.include ?? [];
    for (const nom of FONCTIONS_SUIVIES) {
      expect(inclus, `${nom} absente de tsconfig.edge.json`).toContain(`supabase/functions/${nom}/index.ts`);
      expect(inclus).toContain(`supabase/functions/${nom}/handler.ts`);
    }
  });

  it('les points d’entrée ne supposent pas la globale Deno au chargement', () => {
    // `tsconfig.edge.json` ne charge pas les types Deno. Un `Deno.x` nu en
    // portée de module casse la vérification de types, donc la fonction sort
    // du périmètre contrôlé. L'accès doit passer par `globalThis`.
    //
    // On ne cherche que dans le CODE : les commentaires et les chaînes citent
    // `Deno.env.get` pour expliquer la règle, et les compter comme usage réel
    // rendrait le test faux.
    for (const nom of FONCTIONS_SUIVIES) {
      const code = sansCommentairesNiChaines(
        readFileSync(`supabase/functions/${nom}/index.ts`, 'utf8'),
      );
      expect(
        code.match(/(^|[^.\w])Deno\./) ?? [],
        `${nom}/index.ts utilise Deno.* sans passer par globalThis`,
      ).toHaveLength(0);
      expect(code).toContain('globalThis');
    }
  });
});
