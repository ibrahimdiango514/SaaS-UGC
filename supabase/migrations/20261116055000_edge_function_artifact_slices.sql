-- public._edge_function_artifact_slices — stockage des artefacts Edge Functions.
--
-- ## Pourquoi cette migration existe
--
-- Le chargeur déployé (`supabase/functions/<nom>/loader.ts`) ne contient pas le
-- code métier : il lit l'artefact depuis cette table, le recompose, vérifie sa
-- taille ET son SHA-256, puis seulement l'exécute. Ce mécanisme existe parce
-- que le canal de déploiement Supabase altère les sources longues.
--
-- **La table existait en production sans aucune migration qui la crée.** Elle
-- avait été créée directement via l'API de gestion. Le dépôt ne pouvait donc
-- pas reconstituer une base neuve : un environnement recréé aurait des chargeurs
-- fonctionnels mais une table absente, donc des Edge Functions en 503.
--
-- Cette migration comble ce trou. Elle est écrite à partir du DDL réellement
-- observé en production (colonnes, types, contraintes, index, privilèges, RLS),
-- pas d'une reconstitution approximative.
--
-- ## Pourquoi deux mécanismes distincts
--
-- `create table if not exists` ne couvre QUE l'absence de la table. Si une table
-- homonyme existait déjà avec une forme différente — colonne manquante, type
-- changé, contrainte absente — la migration passerait sans rien corriger, et le
-- chargeur échouerait à l'exécution avec une erreur peu lisible.
--
-- Le bloc 1 garantit donc l'existence, le bloc 2 garantit la FORME, et le bloc 3
-- garantit les ACCÈS. Les trois sont nécessaires.
--
-- ## Compatibilité
--
-- Aucune des branches `arena/vyora-mcp-core` (#9) et
-- `arena/vyora-mcp-connecteurs` (#10) ne crée cette table : elles ne faisaient
-- que l'utiliser, héritant du même trou. Cette migration est donc la première à
-- la déclarer, et elle est sans effet si la table existe déjà avec la bonne
-- forme — ce qui est le cas en production aujourd'hui.
--
-- L'ordre d'application n'a pas d'importance vis-à-vis de #9 et #10 : elles
-- insèrent des lignes (`insert ... on conflict`), elles ne modifient pas le
-- schéma de cette table.

-- ---------------------------------------------------------------------------
-- Bloc 1 — existence et forme
-- ---------------------------------------------------------------------------

create table if not exists public._edge_function_artifact_slices (
  -- Nom logique de l'artefact (« vyora-oauth », « vyora-ai »…).
  name  text    not null,
  -- Numéro de tranche, base 0. L'ordre est significatif : les tranches sont
  -- concaténées dans cet ordre avant décompression gzip.
  part  integer not null,
  -- Tranche du bundle gzip encodé en base64. La charge utile fiable du canal
  -- est de 2 000 caractères : au-delà, le transport altère la source.
  chunk text    not null,
  -- Clé primaire composite : une tranche est identifiée par (artefact, numéro).
  -- C'est aussi ce qui rend l'insertion idempotente via `on conflict`.
  constraint _edge_function_artifact_slices_pkey primary key (name, part)
);

-- Si la table préexistait sans clé primaire, l'instruction ci-dessus n'aurait
-- rien fait (elle est ignorée dans son ensemble). On la garantit séparément.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public._edge_function_artifact_slices'::regclass
       and contype = 'p'
  ) then
    alter table public._edge_function_artifact_slices
      add constraint _edge_function_artifact_slices_pkey primary key (name, part);
  end if;
end $$;

-- Les colonnes manquantes sont ajoutées si besoin. `not null` sans défaut
-- échouerait sur une table déjà peuplée : on ajoute en deux temps, ce qui est
-- sûr même si la table contient des lignes.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = '_edge_function_artifact_slices'
       and column_name = 'chunk'
  ) then
    alter table public._edge_function_artifact_slices add column chunk text;
    update public._edge_function_artifact_slices set chunk = '' where chunk is null;
    alter table public._edge_function_artifact_slices alter column chunk set not null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Bloc 2 — index
-- ---------------------------------------------------------------------------

-- La clé primaire fournit déjà un index btree sur (name, part), qui sert la
-- lecture du chargeur (`where name = … order by part`). Aucun index
-- supplémentaire n'est créé : en ajouter un non utilisé ralentirait les
-- insertions de publication sans bénéfice.

-- ---------------------------------------------------------------------------
-- Bloc 3 — accès
-- ---------------------------------------------------------------------------

-- RLS activée SANS politique : c'est le refus par défaut. Aucun rôle client ne
-- peut lire ces lignes ; seul `service_role`, qui contourne la RLS, y accède.
-- Une politique serait ici une erreur : elle ouvrirait les bundles publiés.
alter table public._edge_function_artifact_slices enable row level security;

-- Double barrière : même si une politique permissive était ajoutée par erreur,
-- les privilèges de table resteraient absents.
revoke all on public._edge_function_artifact_slices from public;
revoke all on public._edge_function_artifact_slices from anon;
revoke all on public._edge_function_artifact_slices from authenticated;

-- `service_role` écrit les tranches (publication) et les relit (chargeur).
grant select, insert, update, delete
  on public._edge_function_artifact_slices
  to service_role;

comment on table public._edge_function_artifact_slices is
  'Artefacts Edge Functions publiés par tranches. Lu par les chargeurs (service_role), vérifié par SHA-256 avant exécution. Aucun accès client.';
