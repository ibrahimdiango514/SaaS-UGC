import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('isolation des comptes VYORA', () => {
  const migration = read('supabase/migrations/20261111165732_vyora_customer_isolation_and_admin_entitlement.sql');

  it('ne crée de compte client VYORA que pour une inscription explicitement VYORA', () => {
    expect(read('src/lib/api.ts')).toContain("app_scope: 'vyora'");
    expect(read('src/pages/OwnerBootstrap.tsx')).toContain("app_scope: 'vyora_owner'");
    expect(migration).toContain("new.raw_user_meta_data->>'app_scope' is distinct from 'vyora'");
    expect(migration).toContain('insert into saas_ugc.ugc_customer_accounts');
  });

  it('empêche le provisioning et les opérations client pour les administrateurs et comptes non VYORA', () => {
    expect(migration).toContain("raise exception 'admin_not_customer'");
    expect(migration).toContain("raise exception 'not_vyora_customer'");
    expect(migration).toContain("s.status <> 'active'");
    expect(migration).toContain('public.ugc_redeem_promo_code(p_code text)');
    expect(migration).toContain('public.ugc_reserve_credits(');
    expect(migration).toContain('public.ugc_confirm_recharge(');
  });

  it('ne donne pas aux administrateurs de portefeuille, abonnement ou dashboard client', () => {
    expect(migration).toContain("'workspace_id', null");
    expect(migration).toContain("'plan', null");
    expect(migration).toContain("'credits', 0");
    expect(migration).toContain("'credits_available'");
    expect(migration).toContain('admin-customer-exclusion:');
  });

  it('n’utilise pas auth.users comme source de la liste client ni des statistiques', () => {
    expect(migration).toContain('from saas_ugc.ugc_customer_accounts a');
    expect(migration).not.toMatch(/from auth\.users u\s+left join saas_ugc\.ugc_profiles/i);
    expect(migration).not.toMatch(/delete\s+from\s+auth\.users/i);
    expect(migration).toContain('where exists (select 1 from saas_ugc.ugc_customer_accounts');
  });

  it('laisse inchangées les inscriptions immobilier et ignore uniquement les scopes VYORA', () => {
    expect(migration).toContain("if new.raw_user_meta_data->>'app_scope' in ('vyora', 'vyora_owner') then");
    expect(migration).toContain('insert into saas_immobilier.user_profiles');
    expect(migration).not.toMatch(/delete\s+from\s+saas_immobilier/i);
  });
});
