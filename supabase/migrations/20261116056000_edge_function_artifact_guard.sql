-- VYORA — verrou de publication des artefacts Edge.
--
-- ## Pourquoi cette migration existe
--
-- Chaque publication d'artefact commence par :
--
--   delete from public._edge_function_artifact_slices where name = '<slug>';
--   insert into public._edge_function_artifact_slices values (...);
--
-- Rien n'empêche une migration plus ancienne, fusionnée plus tard, de
-- réécrire ces lignes. C'est le cas de la PR #10 : sa migration
-- `20261116040000_vyora_oauth_artifact.sql` publie le bundle `vyora-oauth`
-- d'origine, celui qui ne vérifie pas l'identité de l'appelant. Fusionnée
-- après la PR #12, elle remplace silencieusement le bundle corrigé — la
-- migration réussit, aucune erreur n'est levée.
--
-- Le chargeur corrigé épingle le SHA-256 attendu et refuserait d'exécuter un
-- bundle différent (`artifact_digest_mismatch` → 503). La faille n'est donc
-- pas réintroduite dans le code exécuté. Mais remettre en base l'ancien
-- bundle ferait passer le service de « sécurisé » à « indisponible » sans
-- raison valable — et laisserait en place une charge prête à redevenir active
-- au prochain déploiement.
--
-- ## Ce que fait cette migration
--
-- 1. Table `_edge_function_artifact_manifest` : quelle empreinte de tranches
--    est attendue pour chaque artefact, et à partir de quelle version
--    l'épingle est opposable.
-- 2. Déclencheur `_edge_function_artifact_guard` sur la table des tranches :
--    refuse toute publication contredisant une empreinte épinglée.
--
-- L'empreinte porte sur les **tranches base64**, pas sur le bundle : les
-- tranches sont du gzip encodé, que Postgres ne peut pas décompresser. Le
-- SHA-256 du bundle décompressé est vérifié par le chargeur, à l'exécution.
--
-- ## Ce que ce dispositif garantit, et ce qu'il ne garantit pas
--
-- Garanti : une fois l'épingle posée, aucune migration ne peut réécrire les
-- tranches de `vyora-oauth` avec un autre contenu, quel que soit l'ordre de
-- fusion. La migration fautive échoue bruyamment au lieu de réussir en
-- silence.
--
-- Non garanti : un déploiement du chargeur #10 (qui, lui aussi, épingle
-- `4a3f6206…`) reste possible. Ce dispositif protège les données, pas le
-- déploiement. Repasser d'une version déployée à une autre est une décision
-- opérationnelle, journalisée et réversible.
--
-- ## Ordre de mise en œuvre
--
-- Cette migration est idempotente et sans effet sur l'état existant : elle ne
-- pose une épingle que si les tranches présentes correspondent exactement à
-- l'empreinte connue. Sur une base où `vyora-oauth` est encore l'ancien
-- bundle, aucune épingle n'est posée pour ce nom — la publication corrigée
-- (20261116060000) pourra donc s'appliquer normalement, puis posera
-- l'épingle dans un second temps.

begin;

-- Manifeste des empreintes attendues.
create table if not exists public._edge_function_artifact_manifest (
  name          text primary key,
  slices_sha256 text not null,
  base64_chars  integer not null,
  parts         integer not null,
  bundle_chars  integer not null,
  bundle_sha256 text not null,
  note          text,
  sealed_at     timestamptz not null default now(),
  constraint _edge_function_artifact_manifest_sha256_format
    check (slices_sha256 ~ '^[0-9a-f]{64}$'),
  constraint _edge_function_artifact_manifest_bundle_sha_format
    check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  constraint _edge_function_artifact_manifest_positive
    check (base64_chars > 0 and parts > 0 and bundle_chars > 0)
);

alter table public._edge_function_artifact_manifest enable row level security;
revoke all on public._edge_function_artifact_manifest from public;
revoke all on public._edge_function_artifact_manifest from anon;
revoke all on public._edge_function_artifact_manifest from authenticated;
grant select on public._edge_function_artifact_manifest to service_role;
grant insert, update, delete on public._edge_function_artifact_manifest to service_role;

-- Refus par défaut : aucune politique n'est créée, comme pour la table des
-- tranches. Seul `service_role` y accède, via les migrations.

-- Fonction de garde.
--
-- Elle contrôle l'état FINAL du nom concerné, au moment du COMMIT. Ce point
-- est essentiel : une publication légitime s'écrit en deux temps
-- (`delete` puis `insert`), et passe donc par un état intermédiaire où
-- l'artefact a zéro tranche. Un déclencheur immédiat refuserait cette
-- séquence et bloquerait même les republications correctes.
--
-- D'où un `constraint trigger` différé (`DEFERRABLE INITIALLY DEFERRED`) :
-- Postgres l'évalue à la fin de la transaction, quand delete et insert ont
-- tous deux eu lieu. Une publication à l'identique passe ; une publication
-- qui change le contenu échoue, et fait échouer la transaction entière, donc
-- la migration entière.
create or replace function public._edge_function_artifact_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cible    text;
  epingle  public._edge_function_artifact_manifest%rowtype;
  actuel   text;
  nb_parts integer;
  nb_b64   integer;
begin
  -- Nom concerné : celui qui vient d'être écrit ou supprimé.
  cible := coalesce(new.name, old.name);

  select * into epingle
    from public._edge_function_artifact_manifest
   where name = cible;

  if not found then
    return null;  -- aucune épingle : écriture libre
  end if;

  select count(*), coalesce(sum(length(chunk)), 0),
         encode(digest(coalesce(string_agg(chunk, '' order by part), ''), 'sha256'), 'hex')
    into nb_parts, nb_b64, actuel
    from public._edge_function_artifact_slices
   where name = cible;

  -- État identique à l'épingle : republication à l'identique, autorisée.
  if actuel = epingle.slices_sha256
     and nb_parts = epingle.parts
     and nb_b64 = epingle.base64_chars then
    return null;
  end if;

  -- Toute autre combinaison contredit l'épingle.
  raise exception
    'artefact % verrouillé : publication refusée (attendu % tranches/% caractères base64/sha256 %, obtenu %/%/%)',
    cible, epingle.parts, epingle.base64_chars, left(epingle.slices_sha256, 16),
    nb_parts, nb_b64, left(actuel, 16)
    using errcode = 'raise_exception',
          hint = 'Une version corrigée existe pour cet artefact. Ne pas republier une version antérieure : voir docs/mcp/publication-artefacts.md.';
end;
$$;

comment on function public._edge_function_artifact_guard() is
  'Refuse toute republication d''un artefact dont l''empreinte de tranches est épinglée dans _edge_function_artifact_manifest.';

drop trigger if exists _edge_function_artifact_guard on public._edge_function_artifact_slices;
create constraint trigger _edge_function_artifact_guard
  after insert or update or delete on public._edge_function_artifact_slices
  deferrable initially deferred
  for each row
  execute function public._edge_function_artifact_guard();

-- La table des tranches est lue par le chargeur avec la clé de service ; le
-- déclencheur doit pouvoir y lire même sous cet angle.
grant execute on function public._edge_function_artifact_guard() to service_role;

-- Aucune épingle n'est posée ici. Elles le sont par les migrations de
-- publication, qui connaissent le contenu exact qu'elles écrivent. Poser une
-- épingle depuis cette migration reviendrait à figer l'état courant, donc à
-- empêcher la publication corrigée de s'appliquer.

commit;
