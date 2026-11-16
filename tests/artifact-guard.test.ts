// VYORA — verrou de publication des artefacts.
//
// ## Ce que ces tests protègent
//
// La PR #10 publie `vyora-oauth` avec le bundle d'origine (18868 car.,
// sha256 `4a3f6206…`), celui qui ne vérifie pas l'identité de l'appelant.
// Si cette migration est appliquée APRÈS la publication corrigée de #12,
// elle réécrit les tranches sans erreur visible : `delete` puis `insert`,
// la migration réussit.
//
// Trois barrières existent désormais, à trois niveaux différents :
//
//   1. **Base de données** — `_edge_function_artifact_manifest` + le
//      déclencheur `_edge_function_artifact_guard` refusent toute réécriture
//      contredisant l'empreinte épinglée. La migration fautive échoue.
//   2. **Chargeur** — `loader.ts` épingle `SHA256` et `CHARS` ; il refuse
//      d'exécuter un bundle différent (`artifact_size_mismatch` → 503).
//   3. **Générateur** — `renderSeedSql` émet la pose d'épingle pour tout
//      artefact publié, donc la protection ne dépend pas de la mémoire de
//      l'opérateur.
//
// Ces tests vérifient les trois. Ils ne peuvent pas exécuter Postgres : les
// comportements de la base ont été validés manuellement en transaction
// annulée (voir `docs/mcp/verrou-publication.md`). Ce qui est vérifiable
// statiquement ici — la présence et la cohérence des gardes — l'est.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildBundle,
  publicationConstants,
  renderSeedSql,
  MANIFEST_TABLE,
} from '../scripts/build-edge-loader.mjs';

const ROOT = process.cwd();
const lire = (chemin: string) => readFileSync(join(ROOT, chemin), 'utf8');

/** Le verrou doit s'appliquer AVANT la publication qu'il protège. */
const MIGRATION_VERROU = 'supabase/migrations/20261116056000_edge_function_artifact_guard.sql';
const MIGRATION_PUBLICATION = 'supabase/migrations/20261116060000_vyora_oauth_artifact.sql';
const MIGRATION_TABLE = 'supabase/migrations/20261116055000_edge_function_artifact_slices.sql';

describe('verrou / ordre des migrations', () => {
  it('le verrou précède la publication', () => {
    // Un ordre inverse ne protégerait rien : l'épingle serait posée trop tard.
    const ts = (f: string) => Number(f.split('/').pop()!.slice(0, 14));
    expect(ts(MIGRATION_TABLE)).toBeLessThan(ts(MIGRATION_VERROU));
    expect(ts(MIGRATION_VERROU)).toBeLessThan(ts(MIGRATION_PUBLICATION));
  });

  it('le verrou est installé avant que #10 puisse s’appliquer hors ordre', () => {
    // Point contre-intuitif, et c'est ce qui rend le dispositif correct :
    // le verrou (20261116056000) porte un horodatage POSTÉRIEUR à la
    // publication de #10 (20261116040000). Ce n'est pas un défaut.
    //
    // Deux scénarios, tous deux sûrs :
    //   * #10 fusionnée avant #12 : sa migration s'applique sur une base sans
    //     verrou ni épingle — écriture libre, puis #12 corrige et épingle.
    //   * #10 fusionnée après #12 : 20261116040000 est une migration NOUVELLE,
    //     donc elle s'applique en dernier. Mais l'épingle est déjà posée par
    //     20261116060000, et le verrou installé en 20261116056000 la rend
    //     opposable. La migration fautive échoue.
    //
    // La propriété à tenir n'est donc pas « le verrou précède #10 », mais
    // « le verrou est en place avant que l'épingle existe ».
    const ts = (f: string) => Number(f.split('/').pop()!.slice(0, 14));
    expect(ts(MIGRATION_VERROU)).toBeLessThan(ts(MIGRATION_PUBLICATION));
    // Et l'épingle de #12 est postérieure à la publication de #10 : dans le
    // scénario « #12 d'abord », l'épingle gagne.
    expect(ts(MIGRATION_PUBLICATION)).toBeGreaterThan(20261116040000);
  });
});

describe('verrou / structure de la migration', () => {
  const sql = lire(MIGRATION_VERROU);

  it('crée la table du manifeste', () => {
    expect(sql).toContain(`create table if not exists public.${MANIFEST_TABLE}`);
  });

  it('la table du manifeste est protégée : RLS et privilèges restreints', () => {
    expect(sql).toContain(`alter table public.${MANIFEST_TABLE} enable row level security`);
    expect(sql).toMatch(new RegExp(`revoke all on public\\.${MANIFEST_TABLE} from anon`));
    expect(sql).toMatch(new RegExp(`revoke all on public\\.${MANIFEST_TABLE} from authenticated`));
    expect(sql).toMatch(new RegExp(`grant select on public\\.${MANIFEST_TABLE} to service_role`));
  });

  it('aucune politique permissive n’est créée', () => {
    // Refus par défaut : sans politique, personne hormis service_role ne lit.
    expect(sql.toLowerCase()).not.toContain('create policy');
  });

  it('le déclencheur est différé, sinon il bloquerait les republications légitimes', () => {
    // Point subtil : une publication s'écrit en deux temps (delete puis
    // insert). Un déclencheur immédiat verrait un état intermédiaire à zéro
    // tranche et refuserait même une republication correcte. D'où le
    // `constraint trigger … deferrable initially deferred`.
    expect(sql).toContain('create constraint trigger _edge_function_artifact_guard');
    expect(sql).toContain('deferrable initially deferred');
    expect(sql).toContain('for each row');
  });

  it('le déclencheur couvre insert, update ET delete', () => {
    // Couvrir seulement l'insert laisserait passer le `delete` de #10.
    expect(sql).toMatch(/after insert or update or delete on public\._edge_function_artifact_slices/);
  });

  it('la fonction de garde fige le search_path', () => {
    // `security definer` sans search_path figé est un vecteur d'élévation.
    expect(sql).toContain('security definer');
    expect(sql).toMatch(/set search_path = public, extensions/);
  });

  it('l’empreinte porte sur les tranches base64, pas sur le bundle', () => {
    // Postgres ne peut pas décompresser le gzip : le SHA-256 du bundle est
    // vérifié par le chargeur, celui des tranches par la base.
    const sql_garde = lire(MIGRATION_VERROU);
    const sql_publication = lire(MIGRATION_PUBLICATION);
    const attendu = publicationConstants('vyora-oauth', buildBundle(ROOT, 'vyora-oauth'));
    expect(sql_publication).toContain(attendu.slicesSha256);
    expect(sql_garde).toContain('string_agg(chunk');
    expect(sql_garde).toContain('digest(');
  });

  it('la migration ne pose AUCUNE épingle elle-même', () => {
    // Poser une épingle ici figerait l'état courant (l'ancien bundle) et
    // empêcherait la publication corrigée de s'appliquer. Les épingles sont
    // posées par les migrations de publication.
    const sansCommentaires = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(sansCommentaires).not.toMatch(/insert into public\._edge_function_artifact_manifest/);
  });
});

describe('verrou / le générateur pose l’épingle', () => {
  const built = buildBundle(ROOT, 'vyora-oauth');

  it('renderSeedSql émet la pose d’épingle', () => {
    const sql = renderSeedSql('vyora-oauth', built);
    expect(sql).toContain(`insert into public.${MANIFEST_TABLE}`);
    expect(sql).toContain('on conflict (name) do update');
  });

  it('l’épingle générée porte l’empreinte réelle du bundle', () => {
    const attendu = publicationConstants('vyora-oauth', built);
    const sql = renderSeedSql('vyora-oauth', built);
    expect(sql).toContain(attendu.slicesSha256);
    expect(sql).toContain(attendu.sha256);
    expect(sql).toContain(String(attendu.base64Chars));
    expect(sql).toContain(String(attendu.parts));
  });

  it('l’épingle est émise APRÈS la publication des tranches', () => {
    // L'ordre dans la migration compte : l'épingle doit voir les tranches
    // déjà écrites, sinon le déclencheur la refuserait.
    const sql = renderSeedSql('vyora-oauth', built);
    expect(sql.indexOf('_edge_function_artifact_manifest')).toBeGreaterThan(
      sql.indexOf('insert into public._edge_function_artifact_slices'),
    );
  });

  it('la migration de publication en dépôt contient l’épingle', () => {
    const sql = lire(MIGRATION_PUBLICATION);
    const attendu = publicationConstants('vyora-oauth', built);
    expect(sql).toContain(attendu.slicesSha256);
  });
});

describe('verrou / le chargeur refuse un bundle différent', () => {
  const loader = lire('supabase/functions/vyora-oauth/loader.ts');

  it('épingle le SHA-256 et la taille du bundle', () => {
    const attendu = publicationConstants('vyora-oauth', buildBundle(ROOT, 'vyora-oauth'));
    expect(loader).toContain(`const SHA256 = "${attendu.sha256}"`);
    expect(loader).toContain(`const CHARS = ${attendu.chars}`);
  });

  it('vérifie AVANT d’exécuter, et échoue explicitement', () => {
    expect(loader).toContain('artifact_size_mismatch');
    expect(loader).toContain('artifact_digest_mismatch');
    expect(loader).toContain('EDGE_ARTIFACT_UNAVAILABLE');
    // Les contrôles doivent précéder l'exécution du code.
    expect(loader.indexOf('artifact_digest_mismatch')).toBeLessThan(loader.indexOf('new Function(CODE)'));
  });

  it('les épingles du chargeur et de la base désignent le MÊME bundle', () => {
    const attendu = publicationConstants('vyora-oauth', buildBundle(ROOT, 'vyora-oauth'));
    const sql = lire(MIGRATION_PUBLICATION);
    expect(loader).toContain(attendu.sha256);
    expect(sql).toContain(attendu.sha256);
  });
});

describe('verrou / #10 ne peut pas réintroduire l’ancien bundle', () => {
  const SHA_VULNERABLE = '4a3f620661d713904679674d1d2d991579e56ebdbe9c6d47e73aef0f439a8888';

  it('le bundle corrigé et le bundle vulnérable sont distincts', () => {
    const corrige = publicationConstants('vyora-oauth', buildBundle(ROOT, 'vyora-oauth'));
    expect(corrige.sha256).not.toBe(SHA_VULNERABLE);
    expect(corrige.chars).not.toBe(18868);
  });

  it('le chargeur de #12 refuse le bundle de #10', () => {
    // Simulation du contrôle : taille puis digest. Les deux échouent.
    const loader = lire('supabase/functions/vyora-oauth/loader.ts');
    const chars = Number(/CHARS = (\d+)/.exec(loader)![1]);
    const sha = /SHA256 = "([0-9a-f]{64})"/.exec(loader)![1];
    const taille_10 = 18868;
    expect(chars).not.toBe(taille_10);
    expect(sha).not.toBe(SHA_VULNERABLE);
  });

  it('la migration de #10 a été neutralisée : elle ne publie plus rien', () => {
    // Avant correction, cette migration faisait `delete` puis `insert` du
    // bundle vulnérable. Elle est désormais un no-op documenté — c'est la
    // correction principale de ce tour, sur la branche de #10.
    const sql = execFileSync(
      'git',
      ['show', 'arena/vyora-mcp-connecteurs:supabase/migrations/20261116040000_vyora_oauth_artifact.sql'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(sql).not.toMatch(/^\s*delete from public\._edge_function_artifact_slices/m);
    expect(sql).not.toMatch(/^\s*insert into public\._edge_function_artifact_slices/m);
    expect(sql).toContain('publication RETIRÉE');
    // Le SHA vulnérable ne subsiste que comme explication, en commentaire.
    const lignesSha = sql.split('\n').filter((l) => l.includes(SHA_VULNERABLE));
    for (const ligne of lignesSha) expect(ligne.trim().startsWith('--')).toBe(true);
  });

  it('aucune migration de #10 ne pose d’épingle sur l’ancien bundle', () => {
    // Une épingle posée par #10 figerait le bundle vulnérable : ce serait
    // pire que le problème d'origine, puisque le verrou l'imposerait.
    // Si #10 posait une épingle, elle figerait le bundle vulnérable : ce
    // serait pire que le problème d'origine.
    const liste = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', 'arena/vyora-mcp-connecteurs', 'supabase/migrations/'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    // On cherche une ÉCRITURE dans le manifeste, pas une simple lecture :
    // la migration neutralisée de #10 le lit (garde `to_regclass`, contrôle
    // d'épingle) sans jamais y insérer. Un grep sur le nom de la table
    // produisait un faux positif.
    const avecEpingles = liste
      .split('\n')
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => {
        const contenu = execFileSync('git', ['show', `arena/vyora-mcp-connecteurs:${f}`], {
          cwd: ROOT,
          encoding: 'utf8',
        });
        return /insert\s+into\s+public\._edge_function_artifact_manifest/i.test(contenu);
      });
    expect(avecEpingles).toEqual([]);
  });
});

describe('verrou / documentation et limites', () => {
  it('le verrou est documenté avec ses limites', () => {
    const doc = 'docs/mcp/verrou-publication.md';
    expect(existsSync(join(ROOT, doc))).toBe(true);
    const texte = lire(doc);
    expect(texte).toMatch(/ne protège pas le déploiement|protège les données/i);
    expect(texte).toContain('4a3f6206');
  });
});
