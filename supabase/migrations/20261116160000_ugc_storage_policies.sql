-- Politiques Storage du bucket `ugc-assets` — source de vérité dans le dépôt.
--
-- ## Pourquoi cette migration existe
-- Ces quatre politiques existaient déjà en production, mais AUCUNE migration du
-- dépôt ne les déclarait. Conséquence : un environnement recréé depuis le
-- dépôt n'avait pas d'isolation Storage, alors que la production, si. Un écart
-- de reproductibilité sur la partie qui décide qui peut lire quoi n'est pas
-- acceptable.
--
-- Rien n'est modifié ici : les expressions reproduisent EXACTEMENT celles
-- relevées dans `pg_policies` (vérifié par requête, pas par numéro de version).
-- L'écriture est idempotente (`drop policy if exists` puis `create policy`),
-- donc rejouable sans risque.
--
-- ## Le principe d'isolation, en une phrase
-- Le PREMIER segment du chemin d'objet est l'identifiant de l'entreprise ; il
-- doit être un UUID, et l'accès est décidé par les fonctions qui vérifient
-- l'appartenance réelle (`ugc_private.is_workspace_member` en lecture,
-- `ugc_private.can_edit_workspace` en écriture). Le chemin n'est donc pas un
-- simple rangement : c'est le contrôle d'accès. Un utilisateur qui viserait
-- `<autre_entreprise>/…` est refusé par la politique, pas par le code client.
--
-- ## Preuve d'exécution (sonde en base, transaction annulée)
--   A_lit=1 | B_lit=0 | B_modifie=0 | B_insere_dans_A=0 | chemin_sans_ws=0 | anon_lit=0
-- B est un utilisateur réel d'une AUTRE entreprise. La suppression directe par
-- SQL n'est pas testable : la plateforme l'interdit (« Direct deletion from
-- storage tables is not allowed. Use the Storage API instead »). Elle est donc
-- couverte par la politique DELETE ci-dessous et par le code applicatif.

-- Lecture : tout MEMBRE de l'entreprise (propriétaire ou invité, quel que soit
-- son rôle — un lecteur doit pouvoir consulter et prévisualiser).
drop policy if exists ugc_storage_select_member on storage.objects;
create policy ugc_storage_select_member on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ugc-assets'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and ugc_private.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );

-- Écriture : seuls les rôles qui peuvent MODIFIER l'entreprise.
drop policy if exists ugc_storage_insert_editor on storage.objects;
create policy ugc_storage_insert_editor on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ugc-assets'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and ugc_private.can_edit_workspace(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists ugc_storage_update_editor on storage.objects;
create policy ugc_storage_update_editor on storage.objects
  for update to authenticated
  using (
    bucket_id = 'ugc-assets'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and ugc_private.can_edit_workspace(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'ugc-assets'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and ugc_private.can_edit_workspace(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists ugc_storage_delete_editor on storage.objects;
create policy ugc_storage_delete_editor on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ugc-assets'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and ugc_private.can_edit_workspace(((storage.foldername(name))[1])::uuid)
  );

-- Le bucket reste PRIVÉ : aucune lecture anonyme, exclusivement des URL signées
-- à durée limitée délivrées par l'API Storage après contrôle de la politique
-- ci-dessus.
update storage.buckets
set public = false
where id = 'ugc-assets';

do $verif$
declare
  v_nb int;
  v_public boolean;
begin
  select count(*) into v_nb
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname like 'ugc_storage_%';
  if v_nb <> 4 then
    raise exception 'attendu 4 politiques ugc_storage_*, trouvé %', v_nb;
  end if;

  select public into v_public from storage.buckets where id = 'ugc-assets';
  if v_public is distinct from false then
    raise exception 'le bucket ugc-assets doit rester privé (public=%)', v_public;
  end if;
end
$verif$;
