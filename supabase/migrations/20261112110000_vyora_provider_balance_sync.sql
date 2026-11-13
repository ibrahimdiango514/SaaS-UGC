-- Solde fournisseur MuAPI : synchro serveur réelle, jamais simulée.
-- Une ligne par fournisseur (aujourd'hui : muapi). Les valeurs proviennent
-- EXCLUSIVEMENT de GET /api/v1/account/balance avec la clé serveur.
--
-- Règle produit : un solde inconnu vaut NULL, jamais 0. L'admin doit pouvoir
-- distinguer « solde nul » (compte à sec) de « solde non vérifiable » (API ou
-- clé en erreur), car seul le premier justifie un rechargement.

create table if not exists saas_ugc.ugc_provider_balance (
  provider text primary key,
  balance_usd numeric,
  currency text,
  account_email text,
  bonus_balances jsonb not null default '{}'::jsonb,
  topup_totals jsonb not null default '{}'::jsonb,
  http_status integer,
  status text not null default 'unknown',
  error_code text,
  error_message text,
  synced_at timestamptz,
  checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table saas_ugc.ugc_provider_balance is
  'Dernier solde fournisseur observé côté serveur (MuAPI). status=ok|error|unknown. Aucune valeur n''est inventée : si l''appel échoue, balance_usd est null et error_code est renseigné.';

comment on column saas_ugc.ugc_provider_balance.balance_usd is
  'Solde réel MuAPI en USD tel que retourné par /api/v1/account/balance. NULL = inconnu (ne jamais interpréter comme 0).';

revoke all on saas_ugc.ugc_provider_balance from public, anon, authenticated;
grant select on saas_ugc.ugc_provider_balance to service_role;

-- RPC de lecture admin (le front n'accède jamais à la table directement).
create or replace function public.reelora_admin_provider_balance()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, saas_ugc
as $$
declare
  v_uid uuid := auth.uid();
  v_is_admin boolean;
  v_row saas_ugc.ugc_provider_balance%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;
  select exists (
    select 1 from saas_ugc.ugc_user_roles r
     where r.user_id = v_uid and r.role = 'admin'
  ) into v_is_admin;
  if not v_is_admin then
    return jsonb_build_object('error', 'forbidden');
  end if;

  select * into v_row from saas_ugc.ugc_provider_balance where provider = 'muapi';
  if not found then
    return jsonb_build_object(
      'provider', 'muapi',
      'status', 'unknown',
      'balance_usd', null,
      'currency', null,
      'checked_at', null,
      'synced_at', null,
      'error_code', 'not_synced_yet',
      'error_message', 'Le solde n''a pas encore été synchronisé depuis l''API MuAPI.'
    );
  end if;

  return jsonb_build_object(
    'provider', 'muapi',
    'status', v_row.status,
    'balance_usd', v_row.balance_usd,
    'currency', v_row.currency,
    'account_email', v_row.account_email,
    'bonus_balances', v_row.bonus_balances,
    'topup_totals', v_row.topup_totals,
    'http_status', v_row.http_status,
    'synced_at', v_row.synced_at,
    'checked_at', v_row.checked_at,
    'error_code', v_row.error_code,
    'error_message', v_row.error_message
  );
end;
$$;

revoke all on function public.reelora_admin_provider_balance() from public, anon;
grant execute on function public.reelora_admin_provider_balance() to authenticated, service_role;
