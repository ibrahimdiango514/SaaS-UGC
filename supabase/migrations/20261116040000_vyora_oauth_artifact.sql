-- vyora-oauth — publication RETIRÉE (neutralisée le 14 novembre 2026).
--
-- ## Ce que faisait cette migration
--
-- Elle publiait l'artefact `vyora-oauth` en version 18 868 caractères,
-- 4 tranches, sha256
-- `4a3f620661d713904679674d1d2d991579e56ebdbe9c6d47e73aef0f439a8888`.
--
-- Ce bundle **ne vérifie pas l'identité de l'appelant** : il lit l'en-tête
-- `Authorization`, mais ne le valide pas auprès de `/auth/v1/user`. Un UUID
-- quelconque placé dans cet en-tête suffisait à agir sur les comptes
-- connectés de cet utilisateur. C'est la faille corrigée par la PR #12.
--
-- ## Pourquoi neutraliser plutôt que supprimer
--
-- Supprimer le fichier laisserait les environnements où la migration a déjà
-- été appliquée dans un état divergent de l'historique. La conserver en
-- no-op documenté garde l'historique lisible et rend la neutralisation
-- explicite.
--
-- ## Pourquoi neutraliser plutôt que corriger sur place
--
-- La version corrigée du bundle est publiée par la PR #12
-- (`20261116060000_vyora_oauth_artifact.sql`), avec une épingle de
-- publication. Republier ici l'ancien bundle, même corrigé, ferait doublon
-- et rouvrirait la course entre les deux migrations.
--
-- ## Effet de cette migration
--
-- Aucun, dans tous les cas nominaux. Elle ne touche ni la table des
-- tranches, ni le manifeste, ni aucune fonction. Trois états possibles :
--
--   1. le manifeste n'existe pas (PR #12 pas encore appliquée) → no-op ;
--   2. le manifeste existe sans épingle pour `vyora-oauth` → no-op ;
--   3. l'épingle est celle du bundle corrigé → no-op, cas nominal après #12.
--
-- Le seul cas qui lève une exception est une épingle inattendue : c'est
-- exactement l'écrasement que le verrou de publication interdit, et il vaut
-- mieux un arrêt visible qu'une régression silencieuse.

do $neutralise$
declare
  empreinte_epinglee text;
begin
  -- Le manifeste est créé par la PR #12 (20261116056000). Si #10 est
  -- appliquée d'abord, la table n'existe pas encore : c'est un état normal,
  -- pas une anomalie.
  if to_regclass('public._edge_function_artifact_manifest') is null then
    raise notice 'vyora-oauth : publication retirée de cette migration. Rien à faire.';
    return;
  end if;

  select slices_sha256 into empreinte_epinglee
    from public._edge_function_artifact_manifest
   where name = 'vyora-oauth';

  if empreinte_epinglee is null then
    raise notice 'vyora-oauth : publication retirée de cette migration (aucune épingle posée). Rien à faire.';
    return;
  end if;

  if empreinte_epinglee = '6eebdd18470425a8bd9c1fb3fee5470b52f98abda1ed3acf997536aa180c5a02' then
    raise notice 'vyora-oauth : artefact déjà verrouillé sur le bundle corrigé (PR #12). Rien à faire.';
    return;
  end if;

  raise exception
    'vyora-oauth : épingle inattendue (%). Cette migration ne publie plus aucun artefact ; vérifier le manifeste avant de continuer.',
    left(empreinte_epinglee, 16);
end
$neutralise$;
