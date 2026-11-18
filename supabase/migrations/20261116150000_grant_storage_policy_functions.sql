-- Correctif de politiques Storage : fonctions inaccessibles au rôle authenticated.
--
-- ## Le défaut, et comment il a été constaté
-- Une politique RLS de `storage.objects` (`property_images_select_membre_agence`)
-- appelle `saas_immobilier.can_write_property_object(text, …)`. Cette fonction
-- n'avait d'EXECUTE que pour `postgres` et `service_role`.
--
-- PostgreSQL évalue les qualifications de TOUTES les politiques de la table
-- avant de filtrer la moindre ligne. Dès qu'un rôle n'a pas le droit d'exécuter
-- une fonction citée par une politique, la requête échoue entièrement en 42501 :
--      permission denied for function can_write_property_object
--
-- Conséquence mesurée : un utilisateur authentifié ne pouvait plus interroger
-- `storage.objects` du tout — donc plus créer d'URL signée ni de téléverser,
-- pour AUCUN bucket, y compris celui des fichiers VYORA.
--
-- ## La preuve, avant / après
-- Sonde exécutée en base, dans une transaction annulée (aucun résidu) :
--   * en `service_role` (contourne la RLS) : la requête passait ;
--   * en `authenticated` : échec 42501 — le défaut ne vient donc pas des données.
-- Après correctif, la même sonde donne :
--   A_lit=1 | B_lit=0 | B_modifie=0 | B_insere_dans_A=0 | chemin_sans_ws=0 | anon_lit=0
-- c'est-à-dire : le propriétaire lit, l'autre entreprise ne lit pas, ne modifie
-- pas et ne peut rien écrire chez autrui, et un chemin hors entreprise est
-- refusé. La suppression directe n'est pas testable par SQL (la plateforme
-- l'interdit : « Use the Storage API instead ») ; elle est couverte par
-- `tests/files-storage-policies.test.ts`.
--
-- ## Pourquoi ces GRANT sont sûrs
-- Les deux fonctions sont SECURITY DEFINER et comparent `auth.uid()` en interne :
-- elles ne renvoient qu'un booléen sur l'objet demandé, et elles ne font
-- qu'appliquer exactement la condition que la politique nomme déjà.
-- `anon` reste exclu.

grant execute on function saas_immobilier.can_write_property_object(text) to authenticated;
grant execute on function saas_immobilier.can_delete_property_object(text) to authenticated;

-- Garde-fou permanent : plus aucune fonction citée par une politique de
-- `storage.objects` ne doit être inaccessible à `authenticated`. Cette
-- vérification est aussi rejouée par la suite de tests.
do $verif$
declare
  v_manquantes text;
begin
  select string_agg(distinct n.nspname || '.' || p.proname, ', ')
    into v_manquantes
  from pg_policies pol
  cross join lateral regexp_matches(
    coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, ''),
    '([a-z_]+\.[a-z_]+)\(', 'g') m
  join pg_proc p on p.proname = split_part(m[1], '.', 2)
  join pg_namespace n on n.oid = p.pronamespace
    and n.nspname = split_part(m[1], '.', 1)
  where pol.schemaname = 'storage'
    and pol.tablename = 'objects'
    and not has_function_privilege('authenticated', p.oid, 'EXECUTE');

  if v_manquantes is not null then
    raise exception 'fonctions de politique Storage inaccessibles à authenticated : %',
      v_manquantes;
  end if;
end
$verif$;
