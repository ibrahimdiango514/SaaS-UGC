// @vitest-environment jsdom
/**
 * Attribution manuelle d'une formule Grow par un administrateur.
 *
 * ## Deux niveaux de preuve
 * 1. **Migration `20261122090000`** (lue ici comme texte) : la RPC est
 *    `security definer`, `search_path` vide, revérifie le rôle admin côté
 *    serveur, refuse l'auto-attribution, borne la date, ne touche jamais aux
 *    prix ni à la facturation, et `anon` n'a aucun droit. Le comportement réel
 *    a été prouvé en production (transaction annulée) : voir le rapport final
 *    — ces tests verrouillent les décisions, ils ne remplacent pas la base.
 * 2. **Client et interface** (RPC simulée) : le navigateur transmet exactement
 *    la cible, la formule et la date ; il affiche le refus serveur tel quel
 *    (non-admin, expiration, conflit) sans jamais « réussir » localement ; il
 *    n'accorde rien de lui-même.
 *
 * Les scénarios exigés sont nommés tels quels : activation autorisée,
 * non-admin refusé, expiration, renouvellement, isolation entre comptes.
 */
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc, functions: { invoke: vi.fn() }, from: vi.fn(), auth: { getSession: vi.fn() } },
  STORAGE_BUCKET: 'ugc-assets',
  SITE_URL: 'http://localhost:5173',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_PUBLISHABLE_KEY: 'test',
}));

import { adminRevokeBusinessSubscription, adminSetBusinessSubscription, listBusinessGrowPlans } from '../src/lib/api';
import { ToastProvider } from '../src/context/ToastContext';
import BusinessGrowSubscriptionManager, {
  defaultPeriodEndInput, describeAdminSubscriptionError, parsePeriodEndInput,
} from '../src/pages/admin/BusinessGrowSubscriptionManager';
import { BusinessGrowApiError, subscriptionRefusalOf } from '../src/business/api';

const MIGRATION = readFileSync('supabase/migrations/20261122090000_business_grow_admin_subscription.sql', 'utf8');
const CODE = MIGRATION.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

function corpsFonction(nom: string): string {
  const debut = CODE.search(new RegExp(`create or replace function public\\.${nom}\\(`, 'i'));
  expect(debut, `fonction ${nom} absente`).toBeGreaterThan(-1);
  const fin = CODE.indexOf('$function$;', debut);
  expect(fin, `fin de ${nom} introuvable`).toBeGreaterThan(debut);
  return CODE.slice(debut, fin);
}

const CIBLE = '11111111-1111-4111-8111-111111111111';
const AUTRE = '22222222-2222-4222-8222-222222222222';

function okRpc(data: unknown) { return Promise.resolve({ data, error: null }); }
function koRpc(message: string) { return Promise.resolve({ data: null, error: { message, code: 'P0001' } }); }

describe('migration 20261122090000 — garde-fous de sécurité', () => {
  it('la RPC d’attribution vérifie le rôle admin en base, refuse l’auto-attribution et borne la date', () => {
    const f = corpsFonction('vyora_admin_set_business_subscription');
    expect(f).toMatch(/security definer/i);
    expect(f).toMatch(/set search_path = ''/i);
    expect(f).toMatch(/perform ugc_private\.reelora_assert_admin\(\)/);
    expect(f).toContain("raise exception 'self_assignment_forbidden'");
    expect(f).toContain("raise exception 'target_not_found'");
    expect(f).toContain("raise exception 'target_not_vyora_customer'");
    expect(f).toContain("raise exception 'plan_inactive'");
    expect(f).toContain("raise exception 'period_end_must_be_future'");
    expect(f).toContain("raise exception 'period_end_too_far'");
    expect(f).toContain("raise exception 'subscription_conflict'");
    // Journal d'audit obligatoire : qui, quoi, pour qui, jusqu'à quand.
    expect(f).toMatch(/ugc_audit_logs/);
    expect(f).toMatch(/business_grow_subscription_set/);
  });

  it('la révocation passe par les mêmes contrôles et ferme l’accès', () => {
    const f = corpsFonction('vyora_admin_revoke_business_subscription');
    expect(f).toMatch(/security definer/i);
    expect(f).toMatch(/perform ugc_private\.reelora_assert_admin\(\)/);
    expect(f).toContain("raise exception 'manual_subscription_not_found'");
    expect(f).toMatch(/business_grow_subscription_revoked/);
  });

  it('anon n’a aucun droit ; authenticated peut appeler (la RPC refuse ensuite les non-admins)', () => {
    expect(CODE).toMatch(/revoke all on function public\.vyora_admin_set_business_subscription\(uuid, text, timestamptz, text\) from public, anon/);
    expect(CODE).toMatch(/revoke all on function public\.vyora_admin_revoke_business_subscription\(uuid, text\) from public, anon/);
    expect(CODE).toMatch(/grant execute on function public\.vyora_admin_set_business_subscription\(uuid, text, timestamptz, text\) to authenticated/);
    expect(CODE).not.toMatch(/grant execute on function public\.vyora_admin_(set|revoke)_business_subscription[^;]*to anon/);
  });

  it('n’active aucune facturation et n’invente aucun prix', () => {
    expect(CODE).not.toMatch(/billing_enabled\s*=\s*true/i);
    expect(CODE).not.toMatch(/monthly_price_minor\s*=\s*\d/);
    expect(CODE).toMatch(/billing_enabled doit rester false/);
    // Le seul « Business Ground » restant est celui que le bloc de vérification interdit.
    for (const nom of ['vyora_admin_set_business_subscription', 'vyora_admin_revoke_business_subscription']) {
      expect(corpsFonction(nom)).not.toMatch(/Business Ground/);
    }
  });

  it('l’expiration reste portée par la règle unique d’accès (current_period_end), pas par le client', () => {
    const acces = CODE.slice(CODE.search(/create or replace function saas_business\.bg_import_access\(/i));
    expect(acces).toMatch(/SUBSCRIPTION_EXPIRED/);
    expect(acces).toMatch(/current_period_end/);
    expect(acces).toMatch(/Grow/);
  });
});

describe('client — appels RPC transmis sans interprétation', () => {
  beforeEach(() => { mocks.rpc.mockReset(); });

  it('activation manuelle autorisée : transmet cible, formule, date ISO et motif', async () => {
    const fin = new Date('2026-12-31T23:59:59.000Z');
    mocks.rpc.mockReturnValueOnce(okRpc({
      subscription_id: 'sub-1', user_id: CIBLE, plan_key: 'essentiel', status: 'active', billing_provider: 'manual',
      reference: `manual:${CIBLE}`, current_period_end: fin.toISOString(), renewed: false,
      access: { allowed: true, reason: 'OK', message: 'Abonnement Grow actif.' },
    }));
    const res = await adminSetBusinessSubscription({ userId: CIBLE, planKey: 'essentiel', periodEnd: fin, note: '  pilote ' });
    expect(mocks.rpc).toHaveBeenCalledWith('vyora_admin_set_business_subscription', {
      p_user_id: CIBLE, p_plan_key: 'essentiel', p_period_end: fin.toISOString(), p_note: 'pilote',
    });
    expect(res.status).toBe('active');
    expect(res.access.allowed).toBe(true);
  });

  it('non-admin refusé : le refus serveur « forbidden » remonte tel quel, rien n’est accordé', async () => {
    mocks.rpc.mockReturnValueOnce(koRpc('forbidden'));
    // `rpc()` humanise déjà « forbidden » ; le message traduit garde le sens : refus de droits.
    await expect(adminSetBusinessSubscription({ userId: CIBLE, planKey: 'essentiel', periodEnd: new Date(Date.now() + 86_400_000) }))
      .rejects.toMatchObject({ message: 'Vous n’avez pas les droits nécessaires pour cette action.' });
    expect(describeAdminSubscriptionError('forbidden')).toMatch(/Réservé aux administrateurs/);
    expect(describeAdminSubscriptionError('Vous n’avez pas les droits nécessaires pour cette action.')).toMatch(/Réservé aux administrateurs/);
  });

  it('expiration : une date passée est refusée côté client ET le refus serveur est traduit', async () => {
    expect(parsePeriodEndInput('2020-01-01')).toBeNull();
    expect(parsePeriodEndInput('abc')).toBeNull();
    const now = new Date('2026-11-14T10:00:00Z');
    expect(parsePeriodEndInput('2027-12-31', now)).toBeNull(); // > 366 jours
    expect(parsePeriodEndInput('2026-12-14', now)).not.toBeNull();
    expect(defaultPeriodEndInput(now)).toBe('2026-12-14');
    mocks.rpc.mockReturnValueOnce(koRpc('period_end_must_be_future'));
    await expect(adminSetBusinessSubscription({ userId: CIBLE, planKey: 'essentiel', periodEnd: new Date('2020-01-01') }))
      .rejects.toMatchObject({ message: 'period_end_must_be_future' });
    expect(describeAdminSubscriptionError('period_end_must_be_future')).toMatch(/futur/);
    // Côté espace client : un abonnement expiré est affiché « Abonnement requis » avec le motif.
    const refus = subscriptionRefusalOf(new BusinessGrowApiError('x', 'BUSINESS_GROW_SUBSCRIPTION_REQUIRED', 403, {
      reason: 'SUBSCRIPTION_EXPIRED', plan_key: 'essentiel', current_period_end: '2026-10-01T00:00:00Z', subscription_status: 'active',
    }));
    expect(refus).toMatchObject({ reason: 'SUBSCRIPTION_EXPIRED', planKey: 'essentiel', currentPeriodEnd: '2026-10-01T00:00:00Z' });
    expect(subscriptionRefusalOf(new BusinessGrowApiError('x', 'AUTRE_CODE', 500))).toBeNull();
    expect(subscriptionRefusalOf(new Error('panne'))).toBeNull();
  });

  it('renouvellement : même compte, nouvelle formule et nouvelle date → le serveur signale renewed=true', async () => {
    mocks.rpc.mockReturnValueOnce(okRpc({
      subscription_id: 'sub-1', user_id: CIBLE, plan_key: 'croissance', status: 'active', renewed: true,
      current_period_end: '2027-01-31T23:59:59.000Z', access: { allowed: true, reason: 'OK', message: 'Abonnement Grow actif.' },
    }));
    const res = await adminSetBusinessSubscription({ userId: CIBLE, planKey: 'croissance', periodEnd: new Date('2027-01-31T23:59:59Z') });
    expect(res.renewed).toBe(true);
    expect(res.plan_key).toBe('croissance');
  });

  it('isolation entre comptes : chaque appel ne cible qu’un identifiant, jamais une liste ni un joker', async () => {
    mocks.rpc.mockReturnValue(okRpc({ subscription_id: 's', status: 'active', access: { allowed: true, reason: 'OK', message: '' } }));
    await adminSetBusinessSubscription({ userId: CIBLE, planKey: 'essentiel', periodEnd: new Date(Date.now() + 86_400_000) });
    await adminRevokeBusinessSubscription(AUTRE, 'fin de pilote');
    const cibles = mocks.rpc.mock.calls.map(([, args]) => (args as { p_user_id: string }).p_user_id);
    expect(cibles).toEqual([CIBLE, AUTRE]);
    expect(mocks.rpc).toHaveBeenLastCalledWith('vyora_admin_revoke_business_subscription', { p_user_id: AUTRE, p_note: 'fin de pilote' });
    mocks.rpc.mockReturnValueOnce(koRpc('manual_subscription_not_found'));
    await expect(adminRevokeBusinessSubscription(AUTRE)).rejects.toMatchObject({ message: 'manual_subscription_not_found' });
  });

  it('liste uniquement les formules du catalogue public', async () => {
    mocks.rpc.mockReturnValueOnce(okRpc({ plans: [{ plan_key: 'essentiel', display_name: 'Essentiel', active: true }] }));
    expect(await listBusinessGrowPlans()).toEqual([{ plan_key: 'essentiel', display_name: 'Essentiel', active: true }]);
    mocks.rpc.mockReturnValueOnce(okRpc(null));
    expect(await listBusinessGrowPlans()).toEqual([]);
  });
});

describe('interface administrateur — modale d’attribution', () => {
  beforeEach(() => { mocks.rpc.mockReset(); });
  afterEach(cleanup);

  function catalogue() {
    return okRpc({ plans: [
      { plan_key: 'essentiel', display_name: 'Essentiel', active: true },
      { plan_key: 'croissance', display_name: 'Croissance', active: true },
      { plan_key: 'scale', display_name: 'Scale', active: true },
    ] });
  }

  it('attribue la formule au compte ciblé et affiche le résultat vérifié par le serveur', async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === 'business_grow_catalog') return catalogue();
      if (name === 'vyora_admin_set_business_subscription') {
        return okRpc({
          subscription_id: 'sub-1', user_id: CIBLE, plan_key: 'croissance', status: 'active', billing_provider: 'manual',
          reference: `manual:${CIBLE}`, current_period_end: '2026-12-31T23:59:59.000Z', renewed: false,
          access: { allowed: true, reason: 'OK', message: 'Abonnement Grow actif.' },
        });
      }
      return koRpc('inattendu');
    });
    const onApplied = vi.fn();
    render(<ToastProvider><BusinessGrowSubscriptionManager user={{ id: CIBLE, email: 'client@test.ml' }} onClose={() => {}} onApplied={onApplied} /></ToastProvider>);
    const form = await screen.findByTestId('bg-admin-subscription-form');
    await waitFor(() => expect(within(form).getByRole('combobox').hasAttribute('disabled')).toBe(false));
    expect(screen.getByText(/Aucune facturation engagée/)).toBeTruthy();
    fireEvent.change(within(form).getByRole('combobox'), { target: { value: 'croissance' } });
    fireEvent.click(within(form).getByRole('button', { name: '90 jours' }));
    fireEvent.submit(form);
    const resultat = await screen.findByTestId('bg-admin-subscription-result');
    expect(resultat.textContent).toContain('croissance');
    expect(resultat.textContent).toContain('ouvert');
    const appel = mocks.rpc.mock.calls.find(([n]) => n === 'vyora_admin_set_business_subscription');
    expect(appel?.[1]).toMatchObject({ p_user_id: CIBLE, p_plan_key: 'croissance', p_note: null });
    const fin = new Date((appel?.[1] as { p_period_end: string }).p_period_end).getTime() - Date.now();
    expect(fin).toBeGreaterThan(89 * 86_400_000);
    expect(fin).toBeLessThan(91 * 86_400_000);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('non-admin : le refus serveur s’affiche, aucun résultat n’est montré, rien n’est rechargé', async () => {
    mocks.rpc.mockImplementation((name: string) =>
      name === 'business_grow_catalog' ? catalogue() : koRpc('forbidden'));
    const onApplied = vi.fn();
    render(<ToastProvider><BusinessGrowSubscriptionManager user={{ id: CIBLE, email: 'client@test.ml' }} onClose={() => {}} onApplied={onApplied} /></ToastProvider>);
    const form = await screen.findByTestId('bg-admin-subscription-form');
    await waitFor(() => expect(within(form).getByRole('combobox').hasAttribute('disabled')).toBe(false));
    fireEvent.submit(form);
    expect(await screen.findByText(/Réservé aux administrateurs/)).toBeTruthy();
    expect(screen.queryByTestId('bg-admin-subscription-result')).toBeNull();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('résiliation : confirmation explicite puis accès fermé', async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === 'business_grow_catalog') return catalogue();
      if (name === 'vyora_admin_revoke_business_subscription') {
        return okRpc({ subscription_id: 'sub-1', status: 'canceled', access: { allowed: false, reason: 'SUBSCRIPTION_CANCELED', message: 'Abonnement Grow résilié.' } });
      }
      return koRpc('inattendu');
    });
    render(<ToastProvider><BusinessGrowSubscriptionManager user={{ id: CIBLE, email: 'client@test.ml' }} onClose={() => {}} /></ToastProvider>);
    await screen.findByTestId('bg-admin-subscription-form');
    fireEvent.click(screen.getByRole('button', { name: /Résilier l’attribution/ }));
    expect(mocks.rpc.mock.calls.some(([n]) => n === 'vyora_admin_revoke_business_subscription')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la résiliation' }));
    const resultat = await screen.findByTestId('bg-admin-subscription-result');
    expect(resultat.textContent).toContain('canceled');
    expect(resultat.textContent).toContain('fermé');
    expect(mocks.rpc).toHaveBeenLastCalledWith('vyora_admin_revoke_business_subscription', { p_user_id: CIBLE, p_note: null });
  });
});
