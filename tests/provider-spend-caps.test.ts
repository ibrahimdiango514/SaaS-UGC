import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const migrations = [
  'supabase/migrations/20261112070000_vyora_provider_spend_caps_alerts.sql',
  'supabase/migrations/20261112090000_vyora_provider_spend_reserve_v2.sql',
].map(read).join('\n');

const reserveFn = (() => {
  const start = migrations.indexOf('create or replace function public.reelora_reserve_provider_spend');
  expect(start).toBeGreaterThan(-1);
  return migrations.slice(start);
})();

describe('plafond fournisseur v2 — configuration', () => {
  it('conserve un plafond à 0 USD par défaut et n’autorise jamais l’illimité', () => {
    // La migration v2 ne réécrit pas la valeur par défaut : elle reste 0/0.
    expect(migrations).not.toMatch(/max_usd['"]?\s*:\s*[-]?1\b/);
    expect(migrations).toContain("p_max_usd is null or p_max_usd < 0 or p_max_usd > 1000000");
    // Le plafond par fournisseur ne peut pas dépasser le plafond global.
    expect(migrations).toContain('invalid_provider_cap_amount');
    expect(migrations).toContain('(v_value)::text::numeric > p_max_usd');
  });

  it('exige le rôle administrateur pour modifier la politique', () => {
    const policy = migrations.slice(
      migrations.indexOf('function public.reelora_admin_set_provider_spend_policy'),
      migrations.indexOf('function public.reelora_admin_set_provider_spend_cap'),
    );
    expect(policy).toContain('perform ugc_private.reelora_assert_admin();');
    expect(policy).toContain('invalid_provider_alert_percent');
  });

  it('réserve la réservation et la mise à jour de dépense au service_role', () => {
    expect(migrations).toContain('from public, anon, authenticated;\ngrant execute on function public.reelora_reserve_provider_spend(uuid) to service_role');
    expect(reserveFn).toContain("<> 'service_role' then\n    raise exception 'forbidden'");
  });
});

describe('plafond fournisseur v2 — double verrou', () => {
  it('vérifie le plafond global ET le plafond du fournisseur', () => {
    expect(reserveFn).toContain('v_quote.provider_cost_usd > v_remaining');
    expect(reserveFn).toContain('v_quote.provider_cost_usd > v_provider_remaining');
    expect(reserveFn).toContain('provider_spend_provider_cap_exceeded');
  });

  it('ne réserve rien quand le plafond est atteint (comptabilité du fournisseur)', () => {
    // Le bloc de refus est exécuté avant tout insert « reserved ».
    const refuseIndex = reserveFn.indexOf("status, reason_code, completed_at");
    const reserveIndex = reserveFn.indexOf("'reserved');");
    expect(refuseIndex).toBeGreaterThan(-1);
    expect(reserveIndex).toBeGreaterThan(refuseIndex);
    expect(reserveFn).toContain("v_quote.provider_cost_usd, 'blocked', v_detail, now()");
  });

  it('renvoie un motif exploitable par l’Edge Function pour un plafond par fournisseur', () => {
    // L’artefact déployé mappe `provider_spend_cap_exceeded` vers un message
    // utilisateur ; le motif précis reste journalisé dans `detail`.
    expect(reserveFn).toContain("v_reason := 'provider_spend_cap_exceeded';");
    expect(reserveFn).toContain("'detail', v_detail");
  });

  it('exclut les lignes libérées et bloquées du budget engagé', () => {
    expect(reserveFn).toContain('when released_at is not null or status = \'blocked\' then 0');
  });
});

describe('plafond fournisseur v2 — alertes', () => {
  it('déduplique les alertes par clé', () => {
    expect(migrations).toContain('alert_key text not null unique');
    expect(migrations).toContain('on conflict (alert_key) do nothing');
    expect(migrations).toContain('if v_id is null then return false; end if;');
  });

  it('émet une alerte de seuil et une alerte d’arrêt automatique', () => {
    expect(migrations).toContain("'spend:threshold:'");
    expect(migrations).toContain("'spend:cap_reached:'");
    expect(migrations).toContain("'spend:blocked:'");
    expect(migrations).toContain("'cap_reached', 'critical'");
  });

  it('notifie les administrateurs via le canal de notifications existant', () => {
    expect(migrations).toContain('insert into saas_ugc.ugc_notifications (user_id, title, body, kind, href)');
    expect(migrations).toContain("from saas_ugc.ugc_user_roles ur where ur.role = 'admin'");
  });

  it('n’expose les alertes qu’aux administrateurs', () => {
    expect(migrations).toContain('revoke all on saas_ugc.ugc_provider_spend_alerts from public, anon, authenticated');
    expect(migrations).toContain('alter table saas_ugc.ugc_provider_spend_alerts enable row level security');
  });
});

describe('plafond fournisseur v2 — résumé administrateur', () => {
  it('expose par fournisseur le plafond et le restant, plus l’état d’alerte', () => {
    expect(migrations).toContain("'cap_usd', v_config->'provider_caps_usd'->>s.provider");
    expect(migrations).toContain("'alert_state', case");
    expect(migrations).toContain("'alerts', coalesce((");
    // Un fournisseur sans plafond dédié ne doit jamais afficher un restant inventé.
    expect(migrations).toContain("when v_config->'provider_caps_usd'->>s.provider is null then null");
  });
});

describe('plafond fournisseur v2 — contrat frontend', () => {
  const types = read('src/lib/types.ts');
  const api = read('src/lib/api.ts');
  const panel = read('src/pages/admin/ProviderBudgetSettings.tsx');
  const errors = read('src/lib/errors.ts');

  it('déclare les nouveaux champs consommés par la console', () => {
    for (const field of ['alert_percent', 'provider_caps_usd', 'alert_state', 'alerts', 'cap_usd']) {
      expect(types).toContain(field);
    }
  });

  it('appelle les RPC réellement déployées', () => {
    expect(api).toContain("rpc('reelora_admin_set_provider_spend_policy'");
    expect(api).toContain("rpc<boolean>('reelora_admin_ack_provider_spend_alert'");
    expect(migrations).toContain('function public.reelora_admin_ack_provider_spend_alert(p_alert_id uuid)');
    expect(migrations).toContain('function public.reelora_admin_set_provider_spend_policy(');
  });

  it('affiche un plafond par fournisseur et des alertes dans la console', () => {
    expect(panel).toContain('Plafonds par fournisseur');
    expect(panel).toContain('Alertes de budget');
    expect(panel).toContain('Plafond global uniquement');
  });

  it('traduit les refus de budget en messages non mensongers', () => {
    expect(errors).toContain('PROVIDER_SPEND_DISABLED');
    expect(errors).toContain('PROVIDER_SPEND_CAP_EXCEEDED');
    expect(errors).toContain('Aucun crédit n’a été débité');
  });
});
