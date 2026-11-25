-- Identité de marque SORAHNEX dans la configuration applicative.
--
-- Portée VOLONTAIREMENT limitée aux libellés : aucune donnée client, aucun
-- solde, aucun abonnement, aucune ressource de stockage n'est touché. Les clés
-- techniques (`vyora_pricing_policy`, `SasPay`, buckets, Edge Functions) sont
-- conservées telles quelles : les renommer casserait des dépendances déployées
-- sans bénéfice visible pour l'utilisateur.
--
-- Idempotente : ré-exécutable sans effet de bord.

-- `support_email` est VOLONTAIREMENT inchangé : la boîte `support@vyora.app`
-- reçoit réellement le courrier. La basculer vers un domaine non encore
-- prouvé renverrait les utilisateurs vers une adresse morte. À changer dans une
-- migration dédiée le jour où la boîte SORAHNEX existe et répond.
update public.ugc_app_settings
set setting_value = jsonb_set(
      coalesce(setting_value, '{}'::jsonb),
      '{name}',
      to_jsonb('SORAHNEX'::text),
      true
    ),
    updated_at = now()
where setting_key = 'platform'
  and setting_value->>'name' is distinct from 'SORAHNEX';

update public.ugc_app_settings
set description = replace(replace(description, 'marque VYORA', 'marque SORAHNEX'), 'VYORA', 'SORAHNEX'),
    updated_at = now()
where description like '%VYORA%';
