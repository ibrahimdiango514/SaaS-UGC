/**
 * Tarification du Studio VYORA.
 *
 * Sources de vérité :
 *  - Les packs (prix + crédits + recommandation) viennent de la base via
 *    `studio_credit_grid()` : ils sont administrables sans redéploiement.
 *  - Le nombre de crédits d'une génération est calculé côté serveur par
 *    `reelora-video` (coût fournisseur × change × marge ÷ valeur du crédit).
 *    Le navigateur ne fait aucun calcul de facturation.
 *
 * Paiement : lorsque le paiement en ligne SasPay est activé côté serveur, l'achat
 * passe par `PaymentDialog` (prix, frais et confirmation fournis par le serveur).
 * Sinon, le parcours historique est conservé : commande validée par un
 * administrateur.
 *
 * Périmètre : Studio uniquement. Business Grow a ses propres abonnements.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, Check, Coins, CreditCard, History, Loader2, Sparkles, Star, Wand2,
} from 'lucide-react';
import { Badge, Button, LoadingState, ErrorState, Banner, cn } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { asAppError } from '../lib/errors';
import { formatDate } from '../lib/format';
import { rpc } from '../lib/api';
import PaymentDialog from '../components/PaymentDialog';
import {
  PAYMENT_STATE_LABELS, PAYMENT_STATE_TONES, catalogPrice, formatAmount, getPaymentOptions, listMyPayments, refundBadge,
  type PaymentItem, type PaymentOptions, type PaymentOrder,
} from '../lib/payments';

interface StudioPack {
  pack_key: string;
  label: string;
  price_xof: number;
  credits: number;
  recommended?: boolean;
}

interface CreditGrid {
  credit_value_xof: number;
  packs: StudioPack[];
  custom_recharge: { min_xof: number; max_xof: number; step_xof: number } | null;
  /** Ordres de grandeur indicatifs ; jamais une grille imposée au serveur. */
  examples: { label: string; approx_credits: number | null }[];
  target_margin_percent: number | null;
  updated_at: string | null;
}

interface PurchaseRow {
  id: string;
  label: string;
  price_xof: number;
  credits_granted: number;
  price_per_credit_xof: number;
  created_at: string;
}

interface LedgerRow {
  id: string;
  delta: number;
  reason: string | null;
  reference: string | null;
  created_at: string;
}

const XOF = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

function formatXof(value: number): string {
  return `${XOF.format(Math.round(value))} FCFA`;
}

export default function StudioPricing() {
  const toast = useToast();
  const { quota, refreshQuota } = useAuth();
  const [grid, setGrid] = useState<CreditGrid | null>(null);
  const [purchases, setPurchases] = useState<PurchaseRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [customAmount, setCustomAmount] = useState<number | null>(null);
  /** Vrai seulement si le serveur annonce le paiement en ligne disponible pour ce compte. */
  const [online, setOnline] = useState(false);
  const [onlineMode, setOnlineMode] = useState<'test' | 'live' | null>(null);
  /** Réponse du serveur de paiement : porte les prix finals (tout compris) du catalogue. */
  const [payOptions, setPayOptions] = useState<PaymentOptions | null>(null);
  const [payments, setPayments] = useState<PaymentOrder[]>([]);
  const [checkout, setCheckout] = useState<{ item: PaymentItem; title: string } | null>(null);

  const load = useCallback(async (silent = false) => {
    // Rafraîchissement silencieux : la page reste montée (fenêtre de paiement comprise).
    if (!silent) setLoading(true);
    setError('');
    try {
      const [gridResult, historyResult, optionsResult, paymentRows] = await Promise.all([
        rpc<Partial<CreditGrid>>('studio_credit_grid'),
        rpc<{ purchases?: PurchaseRow[]; ledger?: LedgerRow[] }>('studio_credit_history', { p_limit: 40 })
          .catch(() => ({ purchases: [], ledger: [] })),
        // Service de paiement absent, désactivé ou en panne : on garde le parcours historique.
        getPaymentOptions('studio').catch(() => null),
        listMyPayments('studio', 20).catch(() => [] as PaymentOrder[]),
      ]);
      setOnline(optionsResult?.available === true);
      setPayOptions(optionsResult);
      setOnlineMode(optionsResult?.available === true ? optionsResult.mode : null);
      setPayments(paymentRows);
      const raw = (gridResult ?? {}) as Partial<CreditGrid>;
      setGrid({
        credit_value_xof: Number(raw.credit_value_xof ?? 0),
        packs: Array.isArray(raw.packs) ? raw.packs as StudioPack[] : [],
        custom_recharge: raw.custom_recharge ?? null,
        examples: Array.isArray(raw.examples) ? raw.examples as { label: string; approx_credits: number | null }[] : [],
        target_margin_percent: raw.target_margin_percent ?? null,
        updated_at: raw.updated_at ?? null,
      });
      const history = (historyResult ?? {}) as { purchases?: PurchaseRow[]; ledger?: LedgerRow[] };
      setPurchases(Array.isArray(history.purchases) ? history.purchases : []);
      setLedger(Array.isArray(history.ledger) ? history.ledger : []);
    } catch (err) {
      if (!silent) setError(asAppError(err).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (grid?.custom_recharge && customAmount === null) {
      setCustomAmount(grid.custom_recharge.min_xof);
    }
  }, [grid, customAmount]);

  const packs = useMemo(() => {
    if (!grid) return [];
    // Prix montré = prix réellement payé (final, tout compris, fourni par le
    // serveur). Le prix par crédit et l'économie en découlent, pour rester cohérents.
    const shown = grid.packs.map((pack) => ({ pack, price: catalogPrice(payOptions, pack.pack_key, pack.price_xof) }));
    const worst = Math.max(0, ...shown.map(({ pack, price }) => price.amount / Math.max(pack.credits, 1)));
    return shown.map(({ pack, price }) => {
      const unit = pack.credits > 0 ? price.amount / pack.credits : 0;
      const saving = worst > 0 ? Math.max(0, Math.round((1 - unit / worst) * 100)) : 0;
      return { ...pack, unit, saving, shownPrice: price.label, fromPrice: price.from };
    });
  }, [grid, payOptions]);
  const allInclusive = online && payOptions?.all_inclusive === true;

  const onBuyPack = async (pack: StudioPack) => {
    if (online) {
      // Seule la clé du pack part au serveur, qui relit prix et crédits dans sa grille.
      setCheckout({ item: { kind: 'pack', pack_key: pack.pack_key }, title: `Acheter « ${pack.label} »` });
      return;
    }
    setBusy(pack.pack_key);
    try {
      // Aucun prix n'est transmis : le serveur relit la grille et calcule.
      const result = await rpc<{ credits?: number; price_xof?: number; status?: string }>('studio_purchase_pack', {
        p_pack_key: pack.pack_key,
        p_provider: 'admin',
        p_idempotency_key: `studio-pack:${pack.pack_key}:${Date.now()}`,
      });
      toast.success(
        `Commande créée : ${result.credits ?? pack.credits} crédits pour ${formatXof(result.price_xof ?? pack.price_xof)}. `
        + 'Les crédits sont ajoutés après confirmation du paiement par un administrateur.',
      );
      await load();
      await refreshQuota();
    } catch (err) {
      toast.error(asAppError(err).message);
    } finally {
      setBusy(null);
    }
  };

  const onCustomRecharge = async (event: FormEvent) => {
    event.preventDefault();
    if (!grid?.custom_recharge || customAmount === null) return;
    if (online) {
      setCheckout({ item: { kind: 'custom', amount_xof: Math.round(customAmount) }, title: 'Recharge personnalisée' });
      return;
    }
    setBusy('custom');
    try {
      await rpc('ugc_create_recharge_order', {
        p_amount_minor: Math.round(customAmount),
        p_country_code: 'ML',
        p_provider: 'admin',
        p_idempotency_key: `studio-custom:${Math.round(customAmount)}:${Date.now()}`,
      });
      toast.success('Recharge personnalisée créée. Les crédits sont accordés après confirmation du paiement.');
      await load();
      await refreshQuota();
    } catch (err) {
      toast.error(asAppError(err).message);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <LoadingState label="Chargement de la grille de crédits Studio…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  // En ligne, le serveur convertit selon ses paliers : on n'affiche aucune estimation locale.
  const creditsForCustom = !online && grid?.custom_recharge && customAmount !== null && grid.credit_value_xof > 0
    ? Math.floor(customAmount / grid.credit_value_xof)
    : null;

  const onPaymentConfirmed = () => {
    void load(true);
    void refreshQuota();
  };

  return (
    <div className="animate-fadeUp space-y-6">
      <header className="reveal">
        <p className="vyora-eyebrow"><Coins size={11} /> Crédits Studio</p>
        <h1 className="vyora-display mt-3 text-3xl text-white sm:text-4xl">Achetez des crédits, pas un abonnement.</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
          Un seul solde pour toutes les fonctions du Studio. Aucun prélèvement automatique :
          chaque achat crée une commande que vous validez, et le prix est toujours affiché avant.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          <span className="vyora-badge-soft"><Coins size={11} className="text-cyan-300" /> Solde actuel : {quota?.credits ?? 0} crédits</span>
          {grid?.credit_value_xof ? (
            <span className="vyora-badge-soft">1 crédit ≈ {formatXof(grid.credit_value_xof)}</span>
          ) : null}
          <Link to="/app/abonnement" className="vyora-badge-soft hover:text-white">Abonnement & historique complet</Link>
        </div>
      </header>

      <Banner tone="info" title="Une seule règle, transparente">
        Le prix d’une génération est calculé par le serveur à partir du coût réel du fournisseur,
        du change, de la marge Studio et de la valeur du crédit. Si le coût réel est inconnu,
        la génération est bloquée — jamais estimée au hasard.
      </Banner>

      {/* Packs */}
      <section aria-label="Packs de crédits">
        <div className="grid gap-3 sm:grid-cols-3">
          {packs.map((pack) => (
            <article
              key={pack.pack_key}
              className={cn(
                'relative flex flex-col rounded-2xl border p-4',
                pack.recommended
                  ? 'border-cyan-400/45 bg-cyan-400/[0.06]'
                  : 'border-white/[0.08] bg-white/[0.02]',
              )}
            >
              {pack.recommended && (
                <span className="absolute -top-2.5 left-4 inline-flex items-center gap-1 rounded-full bg-cyan-400 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#03131a]">
                  <Star size={9} /> Recommandé
                </span>
              )}
              <h2 className="text-sm font-semibold text-white">{pack.label}</h2>
              <p className="mt-2 text-2xl font-bold tracking-tight text-white" data-testid={`pack-price-${pack.pack_key}`}>
                {pack.fromPrice && <span className="mr-1 text-xs font-medium text-slate-400">à partir de</span>}
                {pack.shownPrice}
              </p>
              <p className="mt-1 text-sm font-semibold text-cyan-200">{pack.credits} crédits</p>
              <p className="mt-1 text-[11px] text-slate-500">
                {formatXof(pack.unit)} par crédit
                {pack.saving > 0 && <span className="ml-1 text-emerald-300">· {pack.saving} % de moins</span>}
              </p>
              <Button
                className="mt-4 w-full"
                variant={pack.recommended ? 'primary' : 'outline'}
                loading={busy === pack.pack_key}
                onClick={() => void onBuyPack(pack)}
                icon={<CreditCard size={14} />}
              >
                Choisir ce pack
              </Button>
            </article>
          ))}
        </div>
        <p className="mt-2 text-[10.5px] text-slate-600">
          {online
            ? 'Paiement Mobile Money via SasPay. Les crédits sont ajoutés dès que le paiement est confirmé par SasPay.'
            : 'Crédits accordés après confirmation du paiement par un administrateur.'}
          {allInclusive ? ' Prix finals, frais de paiement inclus : rien ne s’ajoute au moment de payer.' : ''}
          {' '}Aucun prélèvement automatique, aucun débit récurrent.
          {online && onlineMode === 'test' ? ' Mode test : aucun débit réel.' : ''}
        </p>
      </section>

      {/* Recharge personnalisée */}
      {grid?.custom_recharge && (
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4" aria-label="Recharge personnalisée">
          <h2 className="text-sm font-semibold text-white">Recharge personnalisée</h2>
          <p className="mt-1 text-[11.5px] text-slate-500">
            {allInclusive ? 'Choisissez librement la valeur de votre recharge, entre ' : 'Choisissez librement votre montant entre '}
            {formatXof(grid.custom_recharge.min_xof)} et{' '}
            {formatXof(grid.custom_recharge.max_xof)}.
          </p>
          <form onSubmit={(e) => void onCustomRecharge(e)} className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex-1 min-w-[200px] text-[11px] text-slate-400">
              {allInclusive ? 'Valeur de la recharge (FCFA)' : 'Montant (FCFA)'}
              <input
                type="number"
                min={grid.custom_recharge.min_xof}
                max={grid.custom_recharge.max_xof}
                step={grid.custom_recharge.step_xof}
                value={customAmount ?? grid.custom_recharge.min_xof}
                onChange={(e) => setCustomAmount(Number(e.target.value))}
                className="studio-number mt-1"
                aria-label="Montant de la recharge en FCFA"
              />
            </label>
            {!online && (
              <div className="text-[11px] text-slate-400">
                <p className="text-slate-500">Crédits estimés</p>
                <p className="text-base font-bold text-cyan-200">{creditsForCustom ?? '—'}</p>
              </div>
            )}
            <Button type="submit" loading={busy === 'custom'} icon={<CreditCard size={14} />}>
              {online ? 'Voir le prix et payer' : 'Créer la commande'}
            </Button>
          </form>
          <p className="mt-2 text-[10.5px] text-slate-600">
            {online
              ? allInclusive
                ? 'Le nombre exact de crédits et le prix final à payer, frais de paiement inclus, sont calculés par le serveur et affichés avant tout paiement.'
                : 'Le nombre exact de crédits et les frais sont calculés par le serveur et affichés avant tout paiement.'
              : 'Le montant exact en crédits est recalculé et enregistré côté serveur au moment de la commande.'}
          </p>
        </section>
      )}

      {/* Possibilités concrètes */}
      {grid?.examples && grid.examples.length > 0 && (
        <section aria-label="Ce que permettent les crédits">
          <h2 className="text-sm font-semibold text-white">Ce que permettent vos crédits</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {grid.examples.map((example) => (
              <div key={example.label} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                <p className="text-[11.5px] text-slate-400">{example.label}</p>
                <p className="mt-1 text-sm font-semibold text-white">
                  {typeof example.approx_credits === 'number'
                    ? `≈ ${example.approx_credits} crédits`
                    : 'Coût calculé à la demande'}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-slate-600">
            <AlertCircle size={11} className="mt-0.5 shrink-0" />
            Ordres de grandeur observés. Le montant exact dépend du modèle, de la durée, de la résolution
            et du coût fournisseur du moment : il est toujours affiché avant de lancer la génération.
          </p>
        </section>
      )}

      {/* Paiements en ligne */}
      {payments.length > 0 && (
        <section aria-label="Paiements en ligne">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-white"><CreditCard size={13} className="text-cyan-300" /> Paiements en ligne</h2>
          <ul className="mt-2 divide-y divide-white/[0.05] rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3">
            {payments.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[11.5px]">
                <span className="min-w-0 flex-1 truncate text-slate-300">{row.label ?? 'Achat de crédits'}</span>
                <span className="text-slate-500">{formatDate(row.created_at, true)}</span>
                <span className="text-slate-300">{formatAmount(row.amount, row.currency)}</span>
                {refundBadge(row)
                  ? <Badge tone={refundBadge(row)?.tone}>{refundBadge(row)?.label}{row.refund_amount ? ` · ${formatAmount(row.refund_amount, row.currency)}` : ''}</Badge>
                  : <Badge tone={PAYMENT_STATE_TONES[row.state]}>{PAYMENT_STATE_LABELS[row.state]}</Badge>}
                {(row.state === 'pending' || row.state === 'todo' || row.state === 'review') && (
                  <Link to={`/app/paiement/retour?produit=studio&commande=${row.id}`} className="text-cyan-300 hover:text-white">Suivre</Link>
                )}
                {row.state === 'review' && (
                  <p className="w-full text-[11px] text-amber-200" data-testid="studio-review">
                    Paiement en cours de vérification : ne payez pas une seconde fois. Aucun autre paiement ne peut être lancé d’ici là.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Historique */}
      <section aria-label="Historique des recharges et consommations">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-white"><History size={13} className="text-cyan-300" /> Historique</h2>
        <div className="mt-2 grid gap-3 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3">
            <p className="text-[11px] font-semibold text-slate-300">Recharges</p>
            {purchases.length === 0 ? (
              <p className="mt-2 text-[11.5px] text-slate-500">Aucun achat de crédits pour le moment.</p>
            ) : (
              <ul className="mt-2 divide-y divide-white/[0.05]">
                {purchases.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-2 py-1.5 text-[11.5px]">
                    <span className="text-slate-300">{row.label}</span>
                    <span className="text-slate-500">{formatDate(row.created_at, true)}</span>
                    <span className="font-semibold text-cyan-200">+{row.credits_granted}</span>
                    <span className="text-slate-400">{formatXof(Number(row.price_xof))}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3">
            <p className="text-[11px] font-semibold text-slate-300">Consommations & mouvements</p>
            {ledger.length === 0 ? (
              <p className="mt-2 text-[11.5px] text-slate-500">Aucun mouvement de crédits.</p>
            ) : (
              <ul className="mt-2 divide-y divide-white/[0.05]">
                {ledger.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-2 py-1.5 text-[11.5px]">
                    <span className="truncate text-slate-300">{row.reason || 'Mouvement'}</span>
                    <span className="text-slate-500">{formatDate(row.created_at, true)}</span>
                    <span className={cn('font-semibold', Number(row.delta) < 0 ? 'text-rose-300' : 'text-emerald-300')}>
                      {Number(row.delta) > 0 ? '+' : ''}{row.delta}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-violet-400/20 bg-violet-400/[0.05] p-4">
        <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-violet-100">
          <Sparkles size={12} /> Périmètre de facturation
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-violet-100/70">
          Ces crédits concernent uniquement le <strong className="font-semibold text-violet-50">Studio vidéo</strong>.
          Business Grow fonctionne avec ses propres abonnements et son propre portefeuille : aucun crédit,
          aucun historique et aucune règle de marge ne sont partagés entre les deux produits.
        </p>
        <Link to="/app/business" className="mt-2 inline-flex items-center gap-1 text-[11px] text-violet-200 hover:text-white">
          <Wand2 size={11} /> Voir Business Grow
        </Link>
      </section>

      <p className="flex items-center gap-1.5 text-[10px] text-slate-600">
        <Loader2 size={10} className="opacity-0" />
        Grille administrable{grid?.updated_at ? ` · mise à jour le ${formatDate(grid.updated_at, true)}` : ''}.
        <Check size={10} className="text-emerald-400/60" /> Aucun paiement n’est simulé.
      </p>

      <PaymentDialog
        open={checkout !== null}
        product="studio"
        item={checkout?.item ?? null}
        title={checkout?.title ?? 'Paiement'}
        onClose={() => { setCheckout(null); void load(true); }}
        onConfirmed={onPaymentConfirmed}
      />
    </div>
  );
}
