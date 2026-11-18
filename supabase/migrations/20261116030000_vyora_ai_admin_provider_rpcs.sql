-- VYORA AI CORE — les deux RPC d'administration des fournisseurs.
--
-- ## Pourquoi cette migration existe
-- `src/lib/api.ts` appelle `vyora_ai_admin_provider_upsert` et
-- `vyora_ai_admin_provider_disable` (écrans d'administration IA). En base, ces
-- deux fonctions étaient ABSENTES : la table `saas_business.ai_providers`, les
-- règles, la RPC publique `vyora_ai_provider_upsert` et tout le reste du noyau
-- IA existaient, mais pas ces deux points d'entrée. Les boutons d'ajout et de
-- désactivation d'un fournisseur échouaient donc à l'exécution.
--
-- Constat fait par inventaire des objets (`pg_proc`), pas par numéro de version :
-- plusieurs migrations de ce dépôt ont été appliquées sous un autre horodatage.
--
-- ## Portée
-- Aucune donnée n'est supprimée ni modifiée ici : uniquement deux définitions de
-- fonctions. `upsert` délègue à `public.vyora_ai_provider_upsert`, qui reste la
-- seule à écrire dans `saas_business.ai_providers` — une seule source de vérité
-- pour la validation (clé, URL https, type d'adaptateur).
--
-- ## Sécurité
-- `security definer` + `set search_path` figé, vérification `saas_ugc.ugc_is_admin()`
-- À L'INTÉRIEUR de la fonction : le droit d'exécution ne suffit pas, il faut être
-- administrateur. `anon` est explicitement révoqué.

create or replace function public.vyora_ai_admin_provider_upsert(p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_key text := lower(btrim(coalesce(p_payload->>'provider_key', '')));
  v_name text := btrim(coalesce(p_payload->>'display_name', ''));
  v_kind text := lower(btrim(coalesce(p_payload->>'adapter_kind', 'openai')));
  v_base text := btrim(coalesce(p_payload->>'base_url', ''));
  v_models_url text := nullif(btrim(coalesce(p_payload->>'models_url', '')), '');
  v_key_env text := nullif(btrim(coalesce(p_payload->>'api_key_env', '')), '');
  v_account_env text := nullif(btrim(coalesce(p_payload->>'account_id_env', '')), '');
  v_aggregator boolean := coalesce((p_payload->>'aggregator')::boolean, false);
begin
  if not saas_ugc.ugc_is_admin() then raise exception 'admin required'; end if;
  if v_key = '' or v_key !~ '^[a-z][a-z0-9_-]{1,39}$' then
    raise exception 'provider_key invalide (minuscules, chiffres, - et _)';
  end if;
  if v_name = '' then raise exception 'display_name requis'; end if;
  if v_kind not in ('openai', 'gemini', 'cloudflare', 'none') then
    raise exception 'adapter_kind invalide';
  end if;
  if v_base = '' or v_base !~ '^https://' then
    raise exception 'base_url doit etre une URL https';
  end if;

  return public.vyora_ai_provider_upsert(jsonb_build_object(
    'provider_key', v_key,
    'display_name', v_name,
    'adapter_kind', v_kind,
    'base_url', v_base,
    'models_url', v_models_url,
    'api_key_env', v_key_env,
    'account_id_env', v_account_env,
    'aggregator', v_aggregator
  ));
end $$;

revoke all on function public.vyora_ai_admin_provider_upsert(jsonb) from public, anon;
grant execute on function public.vyora_ai_admin_provider_upsert(jsonb) to authenticated;

-- Désactivation : on ne supprime JAMAIS un fournisseur. Il cesse d'être proposé
-- (`enabled = false`) et ses règles de routage cessent de le sélectionner, ce qui
-- préserve l'historique de consommation et les journaux de routage.
create or replace function public.vyora_ai_admin_provider_disable(p_provider_key text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_key text := lower(btrim(coalesce(p_provider_key, '')));
begin
  if not saas_ugc.ugc_is_admin() then raise exception 'admin required'; end if;
  if v_key = '' then raise exception 'provider_key requis'; end if;

  update saas_business.ai_providers
  set enabled = false, updated_at = clock_timestamp()
  where provider_key = v_key;

  if not found then raise exception 'fournisseur inconnu'; end if;

  update saas_business.ai_routing_rules
  set enabled = false
  where provider_key = v_key and enabled;

  return jsonb_build_object('provider_key', v_key, 'enabled', false);
end $$;

revoke all on function public.vyora_ai_admin_provider_disable(text) from public, anon;
grant execute on function public.vyora_ai_admin_provider_disable(text) to authenticated;
