-- VYORA FILES — système centralisé de fichiers et médias.
--
-- ## Ce qui existait déjà (et qui n'est PAS dupliqué)
--   * bucket privé `ugc-assets` (file_size_limit 500 Mo, liste MIME fermée) ;
--   * politiques Storage `ugc_storage_*` : chemin `${workspace_id}/…`, accès
--     contrôlé par `ugc_private.is_workspace_member` / `can_edit_workspace` ;
--   * table `saas_ugc.ugc_generated_assets` (actifs produits par les
--     générations) et téléversements ad hoc par usage (`avatars/`, `references/`,
--     `editor/`), sans métadonnées interrogeables.
--
-- ## Ce qui manquait
-- Une table de fichiers UTILISATEUR : nom d'origine, format, taille, date,
-- propriétaire, entreprise, projet, genre de référence Studio, et lien vers la
-- conversation. Sans elle, un fichier téléversé n'était plus retrouvable après
-- rechargement de la page et aucune suppression contrôlée n'était possible.
--
-- ## Décisions de conception
--   1. **Même bucket, mêmes politiques de base.** On n'ouvre pas un second
--      système de stockage : le préfixe `${workspace_id}/` reste la clé
--      d'isolation, et les politiques existantes continuent de s'appliquer.
--   2. **Une contrainte croisée table ↔ Storage.** Le nom de l'objet DOIT
--      commencer par `${workspace_id}/` : une ligne de métadonnées ne peut pas
--      désigner un objet d'une autre entreprise, même en cas d'erreur de code.
--   3. **Table globale, RLS par entreprise ET par propriétaire.** Les membres
--      d'une entreprise voient les fichiers de l'entreprise ; seul le
--      propriétaire (ou un admin de l'entreprise) peut supprimer.
--   4. **Aucune suppression de données préexistante.** Migration additive.
--
-- ## Limite assumée
-- La taille maximale d'objet est portée par le bucket. Elle est réglée ici à
-- 50 Mo, valeur choisie APRÈS vérification des envois directs navigateur →
-- Storage (voir docs/ai/2026-11-16-fichiers-media.md) : un plafond trop élevé
-- en apparence ne sert à rien si l'envoi direct échoue en pratique.

-- -----------------------------------------------------------------------------
-- 1) Le bucket accepte les formats demandés, dans une liste FERMÉE.
--    Le type MIME annoncé ne suffit pas : la validation réelle (octets
--    d'en-tête) est faite côté application avant l'envoi, et le bucket reste la
--    seconde barrière.
-- -----------------------------------------------------------------------------
update storage.buckets
set
  file_size_limit = 52428800, -- 50 Mio
  allowed_mime_types = array[
    -- Images
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif',
    -- Vidéos
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
    -- Documents
    'application/pdf', 'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    -- Audio (déjà utilisé par l'éditeur vidéo)
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/webm'
  ]
where id = 'ugc-assets';

-- -----------------------------------------------------------------------------
-- 2) Table centrale des fichiers.
-- -----------------------------------------------------------------------------
create table if not exists public.vyora_files (
  id uuid primary key default gen_random_uuid(),

  -- Isolation : l'entreprise est obligatoire, le propriétaire aussi.
  workspace_id uuid not null,
  owner_id uuid not null default auth.uid(),

  -- Rattachements facultatifs. Aucune clé étrangère vers `saas_ugc` / 
  -- `saas_business` : ces schémas ne sont pas garantis exposés, et une
  -- contrainte croisée bloquerait la suppression d'un projet. L'intégrité est
  -- vérifiée par les RPC ci-dessous, qui refusent un identifiant étranger.
  project_id uuid,
  conversation_id uuid,

  -- Métadonnées demandées : nom, format, taille, date, propriétaire, projet.
  original_name text not null,
  storage_path text not null,
  mime_type text not null,
  extension text not null,
  size_bytes bigint not null,

  -- Classement : `kind` = nature technique, `reference_role` = usage Studio.
  kind text not null,
  reference_role text,

  -- Renseigné quand la prévisualisation est possible (image, PDF, vidéo,
  -- texte). `null` = pas de prévisualisation, et l'interface le dit.
  preview_kind text,

  -- Empreinte facultative (déduplication / intégrité), calculée côté client.
  checksum_sha256 text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint vyora_files_workspace_path_prefix
    check (storage_path like workspace_id::text || '/%'),
  constraint vyora_files_kind_check
    check (kind in ('image', 'video', 'document', 'spreadsheet', 'audio', 'other')),
  constraint vyora_files_reference_role_check
    check (reference_role is null or reference_role in
      ('character', 'product', 'decor', 'environment', 'object', 'video_reference', 'photo')),
  constraint vyora_files_size_positive
    check (size_bytes > 0 and size_bytes <= 52428800),
  constraint vyora_files_name_not_empty
    check (length(btrim(original_name)) between 1 and 255),
  constraint vyora_files_preview_kind_check
    check (preview_kind is null or preview_kind in ('image', 'video', 'pdf', 'text')),
  constraint vyora_files_checksum_check
    check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  constraint vyora_files_storage_path_unique unique (storage_path)
);

comment on table public.vyora_files is
  'Fichiers utilisateur (images, vidéos, documents, tableurs) : métadonnées et rattachements. Le binaire reste dans le bucket privé ugc-assets, sous ${workspace_id}/.';

create index if not exists vyora_files_workspace_idx
  on public.vyora_files (workspace_id, created_at desc);
create index if not exists vyora_files_project_idx
  on public.vyora_files (project_id) where project_id is not null;
create index if not exists vyora_files_conversation_idx
  on public.vyora_files (conversation_id) where conversation_id is not null;
create index if not exists vyora_files_owner_idx
  on public.vyora_files (owner_id);

-- -----------------------------------------------------------------------------
-- 3) Horodatage de mise à jour, réutilisé du socle existant.
-- -----------------------------------------------------------------------------
drop trigger if exists vyora_files_touch_updated_at on public.vyora_files;
create trigger vyora_files_touch_updated_at
  before update on public.vyora_files
  for each row execute function ugc_private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 4) RLS : l'entreprise fait foi, jamais le client.
-- -----------------------------------------------------------------------------
alter table public.vyora_files enable row level security;

-- Lecture : tout membre actif de l'entreprise.
drop policy if exists vyora_files_select_member on public.vyora_files;
create policy vyora_files_select_member on public.vyora_files
  for select to authenticated
  using (
    (select auth.uid()) is not null
    and ugc_private.is_workspace_member(workspace_id)
  );

-- Création : membre éditeur, et propriétaire = soi-même (on ne crée pas un
-- fichier au nom d'un autre).
drop policy if exists vyora_files_insert_editor on public.vyora_files;
create policy vyora_files_insert_editor on public.vyora_files
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and ugc_private.can_edit_workspace(workspace_id)
  );

-- Renommage / changement de rattachement : éditeur, sans changer ni l'entreprise
-- ni le propriétaire ni le chemin (sinon on pourrait réécrire l'histoire).
drop policy if exists vyora_files_update_editor on public.vyora_files;
create policy vyora_files_update_editor on public.vyora_files
  for update to authenticated
  using (
    owner_id = (select auth.uid())
    and ugc_private.can_edit_workspace(workspace_id)
  )
  with check (
    owner_id = (select auth.uid())
    and ugc_private.can_edit_workspace(workspace_id)
  );

-- Suppression : le propriétaire, ou un administrateur de l'entreprise.
drop policy if exists vyora_files_delete_owner on public.vyora_files;
create policy vyora_files_delete_owner on public.vyora_files
  for delete to authenticated
  using (
    owner_id = (select auth.uid())
    or ugc_private.can_edit_workspace(workspace_id)
  );

-- -----------------------------------------------------------------------------
-- 5) Verrouillage des colonnes d'identité après création.
--    Une politique RLS ne peut pas comparer l'ancienne et la nouvelle valeur :
--    ce garde-fou est donc un trigger. Sans lui, un éditeur pourrait déplacer
--    une ligne vers une autre entreprise ou changer son propriétaire.
-- -----------------------------------------------------------------------------
create or replace function ugc_private.vyora_files_guard_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id <> old.id
     or new.workspace_id <> old.workspace_id
     or new.owner_id <> old.owner_id
     or new.storage_path <> old.storage_path
     or new.size_bytes <> old.size_bytes
     or new.mime_type <> old.mime_type
     or new.checksum_sha256 is distinct from old.checksum_sha256
  then
    raise exception 'identité du fichier immuable (entreprise, propriétaire, chemin, type, taille)'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists vyora_files_guard_identity on public.vyora_files;
create trigger vyora_files_guard_identity
  before update on public.vyora_files
  for each row execute function ugc_private.vyora_files_guard_identity();

-- -----------------------------------------------------------------------------
-- 6) RPC de rattachement contrôlé.
--    Elles valident l'appartenance du projet / de la conversation à la MÊME
--    entreprise avant d'écrire. Un identifiant d'une autre entreprise est
--    refusé explicitement, et le message ne révèle pas son existence.
-- -----------------------------------------------------------------------------

-- Rattache un fichier à un projet Studio (et, facultativement, précise son rôle).
create or replace function public.vyora_file_attach_to_project(
  p_file_id uuid,
  p_project_id uuid,
  p_reference_role text default null
)
returns public.vyora_files
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file public.vyora_files;
  v_project_workspace uuid;
begin
  select * into v_file from public.vyora_files where id = p_file_id;
  if not found then
    raise exception 'fichier introuvable' using errcode = 'P0002';
  end if;
  if v_file.owner_id <> (select auth.uid())
     and not ugc_private.can_edit_workspace(v_file.workspace_id) then
    raise exception 'droits insuffisants sur ce fichier' using errcode = '42501';
  end if;

  select w.id into v_project_workspace
  from saas_ugc.ugc_video_projects p
  join saas_ugc.ugc_workspaces w on w.id = p.workspace_id
  where p.id = p_project_id;

  if v_project_workspace is null or v_project_workspace <> v_file.workspace_id then
    raise exception 'projet inconnu pour cette entreprise' using errcode = 'P0002';
  end if;
  if not ugc_private.can_edit_workspace(v_project_workspace) then
    raise exception 'droits insuffisants sur ce projet' using errcode = '42501';
  end if;

  update public.vyora_files
  set project_id = p_project_id,
      reference_role = coalesce(p_reference_role, reference_role)
  where id = p_file_id
  returning * into v_file;

  return v_file;
end $$;

revoke all on function public.vyora_file_attach_to_project(uuid, uuid, text) from public, anon;
grant execute on function public.vyora_file_attach_to_project(uuid, uuid, text) to authenticated;

-- Rattache un fichier à une conversation de l'assistant.
create or replace function public.vyora_file_attach_to_conversation(
  p_file_id uuid,
  p_conversation_id uuid
)
returns public.vyora_files
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file public.vyora_files;
  v_conversation_workspace uuid;
  v_conversation_owner uuid;
begin
  select * into v_file from public.vyora_files where id = p_file_id;
  if not found then
    raise exception 'fichier introuvable' using errcode = 'P0002';
  end if;
  if v_file.owner_id <> (select auth.uid())
     and not ugc_private.can_edit_workspace(v_file.workspace_id) then
    raise exception 'droits insuffisants sur ce fichier' using errcode = '42501';
  end if;

  select c.workspace_id, c.user_id
    into v_conversation_workspace, v_conversation_owner
  from saas_business.conversations c
  where c.id = p_conversation_id;

  if v_conversation_owner is null or v_conversation_owner <> (select auth.uid()) then
    raise exception 'conversation inconnue' using errcode = 'P0002';
  end if;
  if v_conversation_workspace is not null
     and v_conversation_workspace <> v_file.workspace_id then
    raise exception 'conversation rattachée à une autre entreprise' using errcode = '42501';
  end if;

  update public.vyora_files
  set conversation_id = p_conversation_id
  where id = p_file_id
  returning * into v_file;

  return v_file;
end $$;

revoke all on function public.vyora_file_attach_to_conversation(uuid, uuid) from public, anon;
grant execute on function public.vyora_file_attach_to_conversation(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 7) Enregistrement d'un envoi réussi (idempotent).
--    Le navigateur envoie d'abord le binaire (RLS Storage le vérifie), puis
--    déclare les métadonnées ici. Cette fonction refuse toute métadonnée dont
--    le chemin ne correspond pas à l'entreprise, et toute taille incohérente
--    avec l'objet réellement stocké.
-- -----------------------------------------------------------------------------
create or replace function public.vyora_file_register(
  p_workspace_id uuid,
  p_storage_path text,
  p_original_name text,
  p_mime_type text,
  p_extension text,
  p_size_bytes bigint,
  p_kind text,
  p_reference_role text default null,
  p_preview_kind text default null,
  p_checksum_sha256 text default null,
  p_project_id uuid default null,
  p_conversation_id uuid default null
)
returns public.vyora_files
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.vyora_files;
  v_object_size bigint;
  v_object_mime text;
begin
  if not ugc_private.can_edit_workspace(p_workspace_id) then
    raise exception 'droits insuffisants sur cette entreprise' using errcode = '42501';
  end if;
  if p_storage_path not like p_workspace_id::text || '/%' then
    raise exception 'chemin hors de l''entreprise' using errcode = '42501';
  end if;

  -- L'objet doit exister RÉELLEMENT dans le bucket : on ne déclare pas un
  -- fichier qui n'a pas été téléversé (« aucune fausse pièce jointe »).
  select (o.metadata->>'size')::bigint, o.metadata->>'mimetype'
    into v_object_size, v_object_mime
  from storage.objects o
  where o.bucket_id = 'ugc-assets' and o.name = p_storage_path;

  if v_object_size is null then
    raise exception 'objet absent du stockage : envoi incomplet' using errcode = 'P0002';
  end if;
  if v_object_size <> p_size_bytes then
    raise exception 'taille déclarée (% ) différente de l''objet stocké (%)',
      p_size_bytes, v_object_size using errcode = '22000';
  end if;

  insert into public.vyora_files (
    workspace_id, owner_id, project_id, conversation_id,
    original_name, storage_path, mime_type, extension, size_bytes,
    kind, reference_role, preview_kind, checksum_sha256
  ) values (
    p_workspace_id, (select auth.uid()), p_project_id, p_conversation_id,
    p_original_name, p_storage_path, coalesce(v_object_mime, p_mime_type),
    p_extension, p_size_bytes, p_kind, p_reference_role, p_preview_kind,
    p_checksum_sha256
  )
  on conflict (storage_path) do update
    set original_name = excluded.original_name,
        reference_role = coalesce(excluded.reference_role, public.vyora_files.reference_role),
        project_id = coalesce(excluded.project_id, public.vyora_files.project_id),
        conversation_id = coalesce(excluded.conversation_id, public.vyora_files.conversation_id)
  returning * into v_row;

  return v_row;
end $$;

revoke all on function public.vyora_file_register(uuid, text, text, text, text, bigint, text, text, text, text, uuid, uuid) from public, anon;
grant execute on function public.vyora_file_register(uuid, text, text, text, text, bigint, text, text, text, text, uuid, uuid) to authenticated;

comment on function public.vyora_file_register(uuid, text, text, text, text, bigint, text, text, text, text, uuid, uuid) is
  'Déclare un fichier déjà téléversé. Refuse un chemin hors entreprise et une taille qui ne correspond pas à l''objet réellement stocké.';
