import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, Coins, CreditCard, Gift, Receipt, Sparkles } from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Input, Select, Badge, Banner, LoadingState, ErrorState, EmptyState, ProgressBar, StatCard } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { formatDate, formatMoney, statusLabel } from '../lib/format';
import { createRecharge, getSubscription, listLedger, listPlans, listRecharges, redeemPromo, requestPlanChange } from '../lib/api';
import type { LedgerEntry, Plan, RechargeOrder, Subscription as Sub } from '../lib/types';

export default function Subscription() {
  const toast = useToast();
  const { user, quota, refreshQuota } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [sub, setSub] = useState<Sub | null>(null);
  const [orders, setOrders] = useState<RechargeOrder[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState(500000);
  const [country, setCountry] = useState('ML');
  const [promo, setPromo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [p, o, l, s] = await Promise.all([listPlans(), listRecharges(), listLedger(20), user ? getSubscription(user.id) : Promise.resolve(null)]);
      setPlans(p); setOrders(o); setLedger(l); setSub(s);
    } catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  const onRequestPlan = async (key: string) => {
    setBusy(key);
    try { await requestPlanChange(key); toast.success('Demande transmise à l’administration.'); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  const onRecharge = async (e: FormEvent) => {
    e.preventDefault(); setBusy('recharge');
    try {
      await createRecharge(Math.round(amount), country);
      toast.success('Commande de recharge créée. Un administrateur doit la confirmer après réception du paiement.');
      await load(); await refreshQuota();
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  const onPromo = async (e: FormEvent) => {
    e.preventDefault(); setBusy('promo');
    try { await redeemPromo(promo.trim()); toast.success('Code promotionnel appliqué, crédits crédités.'); setPromo(''); await load(); await refreshQuota(); }
    catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  return (
    <>
      <PageHeader eyebrow="Compte" title="Abonnement & crédits" description="Formule, quotas mensuels, recharge et historique financier."
        actions={<Button variant="ghost" size="sm" onClick={() => void load()}>Actualiser</Button>} />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Formule" value={quota?.plan?.display_name ?? '—'} icon={<Sparkles size={19} />} hint={sub ? `Statut : ${statusLabel(sub.status)}` : undefined} />
        <StatCard label="Crédits disponibles" value={quota?.credits ?? 0} icon={<Coins size={19} />} hint="Solde du portefeuille" tone="amber" />
        <StatCard label="Vidéos ce mois" value={`${quota?.usage?.video ?? 0} / ${quota?.plan?.max_videos_per_month ?? 0}`} icon={<CreditCard size={19} />} hint={`Période ${quota?.period ?? '—'}`} tone="cyan" />
        <StatCard label="Projets utilisés" value={`${quota?.projects ?? 0} / ${quota?.plan?.max_projects ?? 0}`} icon={<Receipt size={19} />} hint="Projets non archivés" tone="emerald" />
      </div>

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      <div className="mb-5"><Banner tone="info" title="Facturation assistée par l’administration">Les formules payantes font l’objet d’une demande validée par un administrateur. Les recharges créent une commande en attente : les crédits ne sont crédités qu’après confirmation manuelle du paiement. Aucun paiement n’est simulé.</Banner></div>

      {loading ? <LoadingState label="Chargement de l’abonnement…" /> : (
        <>
          <h2 className="mb-3 text-lg font-semibold text-white">Formules disponibles</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {plans.map((p) => {
              const current = p.plan_key === quota?.plan?.plan_key;
              return (
                <Card key={p.plan_key} className={`flex flex-col p-5 ${current ? 'border-brand-400/50 ring-1 ring-brand-400/20' : ''}`}>
                  <div className="flex items-start justify-between gap-2"><h3 className="text-base font-bold text-white">{p.display_name}</h3>{current && <Badge tone="success">Actuelle</Badge>}</div>
                  <p className="mt-1 text-xs text-slate-500">{p.tagline}</p>
                  <p className="mt-4 text-xl font-bold text-white">{formatMoney(p.monthly_price_minor, p.currency)}<span className="text-xs font-normal text-slate-500"> / mois</span></p>
                  <ul className="mt-4 flex-1 space-y-2">{p.features.map((f) => <li key={f} className="flex items-start gap-2 text-xs text-slate-300"><Check size={13} className="mt-0.5 shrink-0 text-emerald-400" /> {f}</li>)}</ul>
                  <div className="mt-4 space-y-2 text-xs text-slate-400">
                    <div className="flex justify-between"><span>Projets</span><span className="text-white">{p.max_projects}</span></div>
                    <div className="flex justify-between"><span>Vidéos / mois</span><span className="text-white">{p.max_videos_per_month}</span></div>
                    <div className="flex justify-between"><span>Scripts / mois</span><span className="text-white">{p.max_scripts_per_month}</span></div>
                  </div>
                  <Button size="sm" variant={current ? 'ghost' : 'primary'} className="mt-4 w-full" disabled={current} loading={busy === p.plan_key} onClick={() => void onRequestPlan(p.plan_key)}>
                    {current ? 'Formule actuelle' : 'Demander cette formule'}
                  </Button>
                </Card>
              );
            })}
          </div>

          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            <Card><CardHeader title="Recharger mes crédits" description="Le montant est converti en crédits selon la grille tarifaire du pays." />
              <form onSubmit={(e) => void onRecharge(e)} className="space-y-4 p-5">
                <Select label="Pays / devise" value={country} onChange={(e) => setCountry(e.target.value)}>
                  <option value="ML">Mali · XOF</option><option value="FR">France · EUR</option>
                </Select>
                <Input label={`Montant (${country === 'ML' ? 'XOF' : 'EUR'})`} type="number" min={country === 'ML' ? 100000 : 500} max={country === 'ML' ? 50000000 : 500000} step={100} value={amount} onChange={(e) => setAmount(Number(e.target.value))} hint="Montant en unités majeures. Limites : 100 000 – 50 000 000 XOF ou 5 – 5 000 EUR." />
                <div className="rounded-xl border border-line bg-white/[0.03] px-4 py-3 text-xs text-slate-400">Crédits estimés : <span className="font-semibold text-amber-300">{Math.floor((country === 'ML' ? amount / 1000 * 0.2 : amount / 1000 * 0.5))} crédits</span> (à confirmer à la validation).</div>
                <Button type="submit" className="w-full" loading={busy === 'recharge'} icon={<CreditCard size={15} />}>Créer une commande de recharge</Button>
              </form>
            </Card>

            <Card><CardHeader title="Code promotionnel" description="Un code valide crédite immédiatement votre portefeuille." />
              <form onSubmit={(e) => void onPromo(e)} className="space-y-4 p-5">
                <Input label="Code" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="REELORA2026" />
                <Button type="submit" variant="outline" className="w-full" loading={busy === 'promo'} icon={<Gift size={15} />}>Appliquer le code</Button>
              </form>
              <div className="border-t border-line p-5">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Quotas du mois</p>
                {[
                  { label: 'Vidéos', used: quota?.usage?.video ?? 0, max: quota?.plan?.max_videos_per_month ?? 0 },
                  { label: 'Scripts IA', used: quota?.usage?.script ?? 0, max: quota?.plan?.max_scripts_per_month ?? 0 },
                  { label: 'Prompts IA', used: quota?.usage?.prompt ?? 0, max: quota?.plan?.max_prompts_per_month ?? 0 },
                ].map((x) => <div key={x.label} className="mb-3"><div className="mb-1 flex justify-between text-xs"><span className="text-slate-400">{x.label}</span><span className="text-white">{x.used}/{x.max}</span></div><ProgressBar value={x.used} max={x.max} /></div>)}
              </div>
            </Card>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card><CardHeader title="Commandes de recharge" description="Suivi des demandes de paiement." />
              {orders.length === 0 ? <EmptyState icon={<Receipt size={22} />} title="Aucune commande" description="Créez une recharge pour la retrouver ici." /> : (
                <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Montant</th><th>Crédits</th><th>Statut</th></tr></thead>
                  <tbody>{orders.map((o) => <tr key={o.id}><td className="text-xs">{formatDate(o.created_at, true)}</td><td>{formatMoney(o.amount_minor, o.currency)}</td><td>{o.credits_to_grant}</td><td><Badge status={o.status}>{statusLabel(o.status)}</Badge></td></tr>)}</tbody></table></div>
              )}
            </Card>
            <Card><CardHeader title="Derniers mouvements de crédits" action={<Link to="/app/historique" className="text-xs font-semibold text-brand-300">Tout voir</Link>} />
              {ledger.length === 0 ? <EmptyState icon={<Coins size={22} />} title="Aucun mouvement" /> : (
                <div className="divide-y divide-white/[0.06]">{ledger.slice(0, 8).map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-3 px-5 py-3"><div><p className="text-sm text-white">{l.operation_type}</p><p className="text-[11px] text-slate-500">{formatDate(l.created_at, true)}</p></div><span className={`text-sm font-semibold ${l.available_delta > 0 ? 'text-emerald-300' : l.available_delta < 0 ? 'text-rose-300' : 'text-slate-400'}`}>{l.available_delta > 0 ? '+' : ''}{l.available_delta}</span></div>
                ))}</div>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
