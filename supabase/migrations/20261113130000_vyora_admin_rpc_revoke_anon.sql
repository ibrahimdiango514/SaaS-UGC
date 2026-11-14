-- VYORA : les RPC d'administration ne sont plus appelables sans session.
--
-- Constat en production (13/11/2026) : `anon` avait le droit EXECUTE sur trois
-- RPC d'administration. Leurs migrations retirent bien le droit a PUBLIC, mais
-- le projet accorde par defaut EXECUTE a `anon` sur toute nouvelle fonction du
-- schema public, et ce droit direct n'etait pas retire.
--
-- Aucune fuite : chaque fonction commence par `ugc_private.reelora_assert_admin()`
-- et refusait deja un appel anonyme. Ce correctif retire la porte d'entree
-- elle-meme (defense en profondeur). `authenticated` garde son droit : c'est
-- l'interface d'administration, et la fonction verifie le role.
--
-- Idempotent, sans effet sur les donnees.
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.vyora_admin_metrics(integer)',
    'public.vyora_admin_credit_movement(uuid, bigint, text, text)',
    'public.vyora_admin_credit_history(uuid, integer)'
  ] loop
    if to_regprocedure(v_signature) is not null then
      execute format('revoke execute on function %s from anon', v_signature);
    end if;
  end loop;
end
$$;
