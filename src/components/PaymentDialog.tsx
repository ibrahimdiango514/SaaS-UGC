/**
 * Fenêtre de paiement SasPay, commune au Studio et à Business Grow.
 *
 * Règles tenues ici :
 *  - le prix, les crédits et les frais affichés viennent du serveur (`options`) ;
 *  - le navigateur n'envoie qu'une intention (article, réseau, numéro) ;
 *  - l'écran ne dit « confirmé » que lorsque le serveur a vérifié le paiement
 *    auprès de SasPay. Fermer la fenêtre ne change rien à la commande ;
 *  - un double clic ne crée ni seconde commande ni second débit (clé d'intention).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck, Smartphone, XCircle } from 'lucide-react';
import { Banner, Button, Modal, cn } from './ui';
import { asAppError } from '../lib/errors';
import {
  PAYMENT_STATE_LABELS, createIntentKeeper, createPayment, describeFee, formatAmount, getPaymentOptions,
  getPaymentStatus, isFinalState, isPlausiblePhone, isSafeCheckoutUrl,
  type PaymentFlow, type PaymentItem, type PaymentOptions, type PaymentOrder, type PaymentProduct,
} from '../lib/payments';

/** Intervalle entre deux vérifications et durée maximale d'attente à l'écran. */
export const POLL_INTERVAL_MS = 4_000;
export const POLL_MAX_MS = 180_000;

interface PaymentDialogProps {
  open: boolean;
  product: PaymentProduct;
  item: PaymentItem | null;
  title: string;
  onClose: () => void;
  /** Appelé une seule fois, quand le serveur a confirmé le paiement. */
  onConfirmed?: (order: PaymentOrder) => void;
}

type Step = 'loading' | 'unavailable' | 'form' | 'submitting' | 'waiting' | 'redirecting' | 'done';

export default function PaymentDialog({ open, product, item, title, onClose, onConfirmed }: PaymentDialogProps) {
  const [step, setStep] = useState<Step>('loading');
  const [options, setOptions] = useState<PaymentOptions | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [flow, setFlow] = useState<PaymentFlow>('softpay');
  const [network, setNetwork] = useState('');
  const [phone, setPhone] = useState('');
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const intent = useRef(createIntentKeeper());
  const confirmedFor = useRef<string | null>(null);
  const itemKey = item ? JSON.stringify(item) : '';

  // Chargement du devis à l'ouverture (et à chaque changement d'article).
  useEffect(() => {
    if (!open || !item) return undefined;
    let cancelled = false;
    setStep('loading'); setError(''); setNotice(''); setOrder(null); setTimedOut(false); setPhone('');
    intent.current.reset();
    getPaymentOptions(product, item).then((result) => {
      if (cancelled) return;
      setOptions(result);
      if (!result.available || !result.price) { setStep('unavailable'); return; }
      const first = result.countries[0];
      setCountryCode(first?.code ?? '');
      const usable = first?.networks.filter((n) => n.available && !n.otp_required) ?? [];
      const canSoftpay = result.flows.includes('softpay') && usable.length > 0;
      if (!canSoftpay && !result.flows.includes('checkout')) {
        setError('Aucun moyen de paiement n’est disponible pour le moment.');
        setStep('unavailable');
        return;
      }
      setFlow(canSoftpay ? 'softpay' : 'checkout');
      setNetwork(usable[0]?.code ?? '');
      setStep('form');
    }).catch((err: unknown) => {
      if (cancelled) return;
      setOptions(null);
      setError(asAppError(err, 'Le service de paiement est momentanément indisponible.').message);
      setStep('unavailable');
    });
    return () => { cancelled = true; };
    // `itemKey` représente `item` par valeur : l'objet est recréé à chaque rendu parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product, itemKey]);

  const country = useMemo(
    () => options?.countries.find((c) => c.code === countryCode) ?? null,
    [options, countryCode],
  );
  const selectedNetwork = country?.networks.find((n) => n.code === network) ?? null;
  const currency = options?.price?.currency ?? 'XOF';
  const softpayAllowed = Boolean(options?.flows.includes('softpay'))
    && Boolean(country?.networks.some((n) => n.available && !n.otp_required));
  const checkoutAllowed = Boolean(options?.flows.includes('checkout'));
  const phoneValid = country ? isPlausiblePhone(phone, country) : false;

  const applyOrder = useCallback((next: PaymentOrder) => {
    setOrder(next);
    if (next.state === 'confirmed') {
      setStep('done');
      if (confirmedFor.current !== next.id) {
        confirmedFor.current = next.id;
        onConfirmed?.(next);
      }
    } else if (isFinalState(next.state)) {
      setStep('done');
    }
  }, [onConfirmed]);

  // Suivi d'un paiement en attente : seul le serveur fait foi.
  useEffect(() => {
    if (!open || step !== 'waiting' || !order) return undefined;
    let stopped = false;
    const startedAt = Date.now();
    const tick = async () => {
      if (stopped) return;
      if (Date.now() - startedAt >= POLL_MAX_MS) { setTimedOut(true); return; }
      try {
        const result = await getPaymentStatus(order.product, order.id);
        if (stopped) return;
        setNotice(result.message ?? '');
        applyOrder(result.order);
        if (isFinalState(result.order.state)) return;
      } catch (err) {
        if (stopped) return;
        setNotice(asAppError(err, 'Vérification momentanément impossible.').message);
      }
      timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    let timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    return () => { stopped = true; window.clearTimeout(timer); };
    // On ne relance le suivi que pour une autre commande, pas à chaque mise à jour d'état.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, order?.id, applyOrder]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!item || !country || step === 'submitting') return;
    if (flow === 'softpay' && (!selectedNetwork || !phoneValid)) return;
    setStep('submitting'); setError(''); setNotice(''); setTimedOut(false);
    const choice = flow === 'softpay'
      ? { product, item: itemKey, country: country.code, flow, network, phone: phone.replace(/\s/g, '') }
      : { product, item: itemKey, country: country.code, flow };
    try {
      const result = await createPayment({
        product, item, country: country.code, flow,
        network: flow === 'softpay' ? network : undefined,
        phone: flow === 'softpay' ? phone : undefined,
        idempotencyKey: intent.current.keyFor(choice),
      });
      setOrder(result.order);
      if (isFinalState(result.order.state)) { applyOrder(result.order); return; }
      if (result.next === 'redirect') {
        if (!isSafeCheckoutUrl(result.order.checkout_url)) {
          setError('Le lien de paiement reçu est invalide. Aucun paiement n’a été lancé.');
          setStep('form');
          return;
        }
        setStep('redirecting');
        window.location.assign(result.order.checkout_url);
        return;
      }
      setStep('waiting');
    } catch (err) {
      // Même clé au prochain essai tant que les choix ne changent pas : aucun doublon.
      setError(asAppError(err, 'Le paiement n’a pas pu être lancé.').message);
      setStep('form');
    }
  };

  const retry = () => {
    intent.current.reset();
    setOrder(null); setError(''); setNotice(''); setTimedOut(false);
    setStep('form');
  };

  const checkNow = async () => {
    if (!order) return;
    setTimedOut(false); setNotice('');
    try {
      const result = await getPaymentStatus(order.product, order.id);
      setNotice(result.message ?? '');
      applyOrder(result.order);
      if (!isFinalState(result.order.state)) setStep('waiting');
    } catch (err) {
      setNotice(asAppError(err, 'Vérification momentanément impossible.').message);
      setTimedOut(true);
    }
  };

  const price = options?.price ?? null;
  const fee = flow === 'softpay' ? selectedNetwork?.fee ?? null : null;

  return (
    <Modal open={open} onClose={onClose} title={title} description={price?.label ?? undefined} size="md">
      <div className="space-y-4 px-5 py-4" data-testid="payment-dialog" data-step={step}>
        {step === 'loading' && (
          <p role="status" className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 size={15} className="animate-spin" /> Préparation du paiement…
          </p>
        )}

        {step === 'unavailable' && (
          <Banner tone="warning" title="Paiement en ligne indisponible">
            {error || options?.message || 'Le paiement en ligne n’est pas disponible pour le moment.'}
            {' '}Aucune commande n’a été créée et rien n’a été débité.
          </Banner>
        )}

        {options?.mode === 'test' && step !== 'loading' && step !== 'unavailable' && (
          <Banner tone="info" title="Mode test">
            Environnement de test SasPay : aucun débit réel n’est effectué.
          </Banner>
        )}

        {price && (step === 'form' || step === 'submitting') && (
          <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
            <dl className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-400">Prix</dt>
                <dd className="text-lg font-bold text-white" data-testid="payment-price">{formatAmount(price.amount, currency)}</dd>
              </div>
              {typeof price.credits === 'number' && (
                <div className="mt-1 flex items-baseline justify-between gap-3 text-[12px]">
                  <dt className="text-slate-500">Crédits Studio</dt>
                  <dd className="font-semibold text-cyan-200">{price.credits}</dd>
                </div>
              )}
              {typeof price.period_days === 'number' && (
                <div className="mt-1 flex items-baseline justify-between gap-3 text-[12px]">
                  <dt className="text-slate-500">Durée</dt>
                  <dd className="font-semibold text-violet-200">{price.period_days} jours, sans renouvellement automatique</dd>
                </div>
              )}
            </dl>

            {softpayAllowed && checkoutAllowed && (
              <fieldset>
                <legend className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Moyen de paiement</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {([
                    ['softpay', 'Mobile Money', 'Validation sur votre téléphone', <Smartphone key="i" size={14} />],
                    ['checkout', 'Page de paiement sécurisée', 'Vous êtes redirigé chez SasPay', <ExternalLink key="i" size={14} />],
                  ] as const).map(([value, label, hint, icon]) => (
                    <label
                      key={value}
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm',
                        flow === value ? 'border-cyan-400/50 bg-cyan-400/[0.06] text-white' : 'border-white/[0.08] text-slate-300',
                      )}
                    >
                      <input type="radio" name="payment-flow" className="sr-only" checked={flow === value} onChange={() => setFlow(value)} />
                      <span className="mt-0.5 text-cyan-300">{icon}</span>
                      <span><span className="block font-semibold">{label}</span><span className="block text-[11px] text-slate-500">{hint}</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {flow === 'softpay' && country && (
              <>
                <fieldset>
                  <legend className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Opérateur ({country.name})</legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    {country.networks.map((n) => {
                      const usable = n.available && !n.otp_required;
                      return (
                        <label
                          key={n.code}
                          className={cn(
                            'rounded-xl border p-2.5 text-[12.5px]',
                            !usable && 'cursor-not-allowed opacity-50',
                            usable && 'cursor-pointer',
                            network === n.code ? 'border-cyan-400/50 bg-cyan-400/[0.06] text-white' : 'border-white/[0.08] text-slate-300',
                          )}
                        >
                          <input type="radio" name="payment-network" className="sr-only" disabled={!usable} checked={network === n.code} onChange={() => setNetwork(n.code)} />
                          <span className="block font-semibold">{n.label}</span>
                          {!n.available && <span className="block text-[10.5px] text-slate-500">Indisponible</span>}
                          {n.available && n.otp_required && <span className="block text-[10.5px] text-slate-500">Via la page sécurisée</span>}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Numéro Mobile Money
                  <span className="mt-2 flex items-center gap-2">
                    {country.dial_code && <span className="rounded-lg border border-white/[0.08] px-2.5 py-2 text-sm font-normal text-slate-300">+{String(country.dial_code).replace(/\D/g, '')}</span>}
                    <input
                      type="tel" inputMode="tel" autoComplete="tel-national" value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      aria-invalid={phone.length > 0 && !phoneValid}
                      placeholder={country.national_number_length ? `${country.national_number_length} chiffres` : 'Numéro'}
                      className="w-full rounded-lg border border-white/[0.1] bg-black/30 px-3 py-2 text-sm font-normal normal-case tracking-normal text-white outline-none focus:border-cyan-400/60"
                    />
                  </span>
                  {phone.length > 0 && !phoneValid && (
                    <span className="mt-1 block text-[11px] font-normal normal-case tracking-normal text-rose-300">
                      Numéro invalide pour {country.name}.
                    </span>
                  )}
                </label>
              </>
            )}

            <p className="text-[11.5px] leading-relaxed text-slate-400" data-testid="payment-fee">
              {flow === 'softpay'
                ? describeFee(fee, currency)
                : 'Les frais éventuels sont affichés sur la page de paiement avant validation.'}
            </p>

            {error && <Banner tone="danger" title="Paiement non lancé">{error}</Banner>}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-1.5 text-[10.5px] text-slate-500">
                <ShieldCheck size={12} className="text-emerald-400/70" /> Paiement traité par SasPay. VYORA ne voit ni votre code ni votre solde.
              </p>
              <Button
                type="submit"
                loading={step === 'submitting'}
                disabled={step === 'submitting' || (flow === 'softpay' && (!selectedNetwork || !phoneValid))}
              >
                {flow === 'softpay'
                  ? `Payer ${formatAmount(fee?.total ?? price.amount, currency)}`
                  : 'Continuer vers le paiement'}
              </Button>
            </div>
          </form>
        )}

        {step === 'redirecting' && (
          <p role="status" className="flex items-center gap-2 text-sm text-slate-300">
            <Loader2 size={15} className="animate-spin" /> Redirection vers la page de paiement sécurisée…
          </p>
        )}

        {step === 'waiting' && order && (
          <div className="space-y-3" role="status" aria-live="polite">
            <p className="flex items-center gap-2 text-sm font-semibold text-white">
              <Loader2 size={15} className={cn(!timedOut && 'animate-spin')} /> Paiement en attente de confirmation
            </p>
            <p className="text-[12.5px] leading-relaxed text-slate-400">
              Validez la demande de {formatAmount(order.quoted_total_amount ?? order.amount, order.currency)} sur votre téléphone
              {order.payer_msisdn_masked ? ` (${order.payer_msisdn_masked})` : ''}.
              Rien n’est crédité tant que SasPay n’a pas confirmé le paiement.
            </p>
            {notice && <p className="text-[11.5px] text-amber-200">{notice}</p>}
            {timedOut && (
              <Banner tone="info" title="Toujours en attente">
                La confirmation tarde. Vous pouvez fermer cette fenêtre : la commande {order.internal_reference} sera
                mise à jour automatiquement dès la réponse de SasPay, et apparaîtra dans votre historique.
              </Banner>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>Fermer</Button>
              <Button variant="outline" size="sm" onClick={() => void checkNow()}>Vérifier maintenant</Button>
            </div>
          </div>
        )}

        {step === 'done' && order && (
          <div className="space-y-3" role="status" aria-live="polite" data-testid="payment-result" data-state={order.state}>
            {order.state === 'confirmed' ? (
              <>
                <p className="flex items-center gap-2 text-sm font-semibold text-emerald-200"><CheckCircle2 size={16} /> Paiement confirmé</p>
                <p className="text-[12.5px] leading-relaxed text-slate-300">
                  {order.product === 'studio'
                    ? `${order.credits ?? ''} crédits ont été ajoutés à votre solde Studio.`
                    : 'Votre abonnement Business Grow est actif.'}
                  {' '}Référence : {order.internal_reference}.
                </p>
              </>
            ) : (
              <>
                <p className="flex items-center gap-2 text-sm font-semibold text-rose-200">
                  <XCircle size={16} /> Paiement {PAYMENT_STATE_LABELS[order.state].toLowerCase()}
                </p>
                <p className="text-[12.5px] leading-relaxed text-slate-300">
                  {order.state === 'cancelled'
                    ? 'Le paiement a été annulé ou a expiré.'
                    : 'Le paiement n’a pas abouti.'}
                  {' '}Rien n’a été crédité. Référence : {order.internal_reference}.
                </p>
              </>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {order.state !== 'confirmed' && <Button variant="outline" size="sm" onClick={retry}>Réessayer</Button>}
              <Button size="sm" onClick={onClose}>Fermer</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
