-- =============================================================================
-- VYORA — reprise des imports interrompus.
--
-- ## Le problème
-- Un import écrit produit par produit. Si la session expire, si le réseau
-- coupe ou si l'instance Edge est recyclée au milieu du lot, les produits déjà
-- écrits restent en base — c'est voulu, on ne supprime rien — mais rien ne dit
-- OÙ l'écriture s'est arrêtée. L'utilisateur qui relance écrit une seconde fois
-- les lignes déjà passées.
--
-- ## Ce que cette migration ajoute
-- Une table de PROGRESSION : une ligne par produit traité (créé ou mis à jour),
-- rattachée à un import (`import_key`). La reprise relit ces lignes et écarte
-- les produits déjà traités. Rien n'est réécrit, rien n'est supprimé.
--
-- ## Pourquoi `import_key` et pas le `previewId`
-- Un aperçu expiré est supprimé, et avec lui son identifiant : une reprise
-- après expiration de session n'aurait plus de clé. `import_key` est une
-- empreinte STABLE du lot (source + ensemble des références), calculée par la
-- fonction d'import. Réimporter exactement le même catalogue retrouve donc la
-- même clé, et donc la progression — sans jamais dépendre d'un aperçu encore
-- valide.
--
-- ## Idempotence
-- La contrainte d'unicité `(workspace_id, import_key, line_key)` rend l'écriture
-- d'une ligne de progression idempotente : rejouer la même ligne ne crée pas de
-- doublon et ne corrompt rien. L'écriture produit correspondante est déjà
-- protégée par la transaction par produit.
-- =============================================================================

create table if not exists saas_ugc.ugc_import_progress (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Empreinte stable du lot importé (voir `importKey` côté fonction).
  import_key text not null,
  -- Clé stable de LA ligne dans le lot : référence si disponible, sinon nom
  -- normalisé. Deux lignes de même clé ne peuvent pas être traitées deux fois.
  line_key text not null,
  product_id uuid not null,
  outcome text not null check (outcome in ('created', 'updated')),
  variants_written integer not null default 0,
  created_at timestamptz not null default now(),
  constraint ugc_import_progress_unique_line unique (workspace_id, import_key, line_key)
);

create index if not exists ugc_import_progress_key_idx
  on saas_ugc.ugc_import_progress (workspace_id, import_key);

-- RLS : propriétaire uniquement. La fonction d'import écrit avec le rôle
-- service ; `authenticated` ne doit pouvoir NI lire NI écrire cette table
-- directement — la lecture passe par une RPC qui vérifie l'appartenance, comme
-- l'historique.
alter table saas_ugc.ugc_import_progress enable row level security;

drop policy if exists ugc_import_progress_owner_read on saas_ugc.ugc_import_progress;
create policy ugc_import_progress_owner_read on saas_ugc.ugc_import_progress
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on saas_ugc.ugc_import_progress from anon;
revoke insert, update, delete on saas_ugc.ugc_import_progress from authenticated;

comment on table saas_ugc.ugc_import_progress is
  'Progression d''un import, une ligne par produit traité. Sert à reprendre un import interrompu sans réécrire ce qui est déjà fait.';

-- -----------------------------------------------------------------------------
-- Lecture sécurisée de la progression
-- -----------------------------------------------------------------------------
-- Rend, pour un lot donné, les lignes déjà traitées. L'appelant ne voit QUE
-- ses propres imports, dans une entreprise dont il est membre : même règle que
-- `vyora_ugc_import_history`, pour ne pas ouvrir une seconde porte moins
-- gardée que la première.
create or replace function public.vyora_ugc_import_progress(
  p_workspace_id uuid,
  p_import_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'progress_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  if not (select ugc_private.is_workspace_member(p_workspace_id)) then
    raise exception 'progress_forbidden:WORKSPACE_ACCESS_DENIED' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'import_key', p_import_key,
    'total', (
      select count(*) from saas_ugc.ugc_import_progress p
       where p.workspace_id = p_workspace_id
         and p.import_key = p_import_key
         and p.user_id = v_user
    ),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_key', p.line_key,
               'product_id', p.product_id,
               'outcome', p.outcome,
               'variants_written', p.variants_written,
               'created_at', p.created_at
             ) order by p.created_at, p.line_key)
        from saas_ugc.ugc_import_progress p
       where p.workspace_id = p_workspace_id
         and p.import_key = p_import_key
         and p.user_id = v_user
    ), '[]'::jsonb)
  );
end
$function$;

revoke all on function public.vyora_ugc_import_progress(uuid, text) from public, anon;
grant execute on function public.vyora_ugc_import_progress(uuid, text) to authenticated;

comment on function public.vyora_ugc_import_progress(uuid, text) is
  'Lignes déjà traitées pour un lot d''import, limitées à l''appelant et à son entreprise.';

-- -----------------------------------------------------------------------------
-- Contrôles
-- -----------------------------------------------------------------------------
do $verif$
declare
  v_table integer;
  v_index integer;
  v_rls boolean;
  v_grant integer;
begin
  select count(*) into v_table
    from information_schema.tables
   where table_schema = 'saas_ugc' and table_name = 'ugc_import_progress';
  if v_table <> 1 then raise exception 'table ugc_import_progress manquante'; end if;

  select count(*) into v_index
    from pg_indexes
   where schemaname = 'saas_ugc' and indexname = 'ugc_import_progress_unique_line';
  if v_index <> 1 then raise exception 'index unique de progression manquant'; end if;

  select relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'saas_ugc' and c.relname = 'ugc_import_progress';
  if v_rls is not true then raise exception 'RLS non activée sur la progression'; end if;

  -- Aucun droit d'écriture direct pour `authenticated` : seule la fonction
  -- (service_role) écrit la progression.
  select count(*) into v_grant
    from information_schema.role_table_grants
   where table_schema = 'saas_ugc' and table_name = 'ugc_import_progress'
     and grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
  if v_grant <> 0 then raise exception 'authenticated peut écrire la progression'; end if;

  raise notice 'contrôles passes : progression d''import en place';
end
$verif$;
