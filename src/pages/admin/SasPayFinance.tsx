/**
 * Administration — prix, frais SasPay et marge.
 *
 * Règles tenues par l'interface comme par la base :
 *  - le prix payé par le client = prix de base + provision, relevé si
 *    nécessaire pour que le net reçu ne passe pas sous le prix de base ;
 *  - AUCUN tarif n'est supposé. Sans ligne de barème confirmée, les frais sont
 *    « non confirmés » : affichés « — », jamais zéro ;
 *  - une ligne de barème ne se modifie pas : on la clôt et on en ajoute une ;
 *  - tous les calculs sont faits par la base ; le navigateur ne convertit que
 *    les saisies (chaînes → entiers), sans nombre flottant ;
 *  - importer les tarifs du compte ne fait qu'une LECTURE chez SasPay.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Calculator, Download, RefreshCw, Scale, TrendingUp } from 'lucide-react';
import { Badge, Banner, Button, Card, CardHeader, Input, LoadingState, Modal, Select, Textarea, Toggle } from '../../components/ui';
import { asAppError } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import {
  FINANCE_FLAG_LABELS, TARIFF_SOURCE_LABELS, adminAddTariff, adminCloseTariff, adminFinanceBackfill, adminFinanceReport,
  adminPayoutSimulation, adminPriceSimulation, adminPricingOverview, adminSetPricingPolicy, adminSyncRates, formatCents,
  formatPercentMilli, parseScaled,
  type FinanceLine, type FinanceReport, type FinanceStats, type PayoutSimulation, type PaymentProduct, type PriceSimulation,
  type PricingOverview, type PricingStrategy, type Tariff, type TariffInput,
} from '../../lib/payments';

const STRATEGY_LABELS: Record<PricingStrategy, string> = {
  cover_fees: 'Provision + couverture des frais (recommandé)',
  provision_only: 'Provision seule (le prix n’est jamais relevé)',
};
const PRODUCT_LABELS: Record<string, string> = { studio: 'Studio', business: 'Business Grow' };

/** Centièmes → saisie (« 100000 » → « 1000 »), pour préremplir un champ. */
const centsInput = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : `${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, '0')}`);

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'bad' | 'good' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[12.5px]">
      <dt className="text-slate-400">{label}</dt>
      <dd className={[
        strong ? 'text-base font-bold' : 'font-semibold',
        tone === 'bad' ? 'text-rose-300' : tone === 'good' ? 'text-emerald-300' : 'text-white',
      ].join(' ')}>{value}</dd>
    </div>
  );
}

/* ------------------------------- Politique -------------------------------- */

function PolicyCard({ overview, onSaved }: { overview: PricingOverview; onSaved: (message: string) => void }) {
  const policy = overview.policy;
  const xof = policy.currencies.XOF ?? { provision_cents: 100000, rounding_step_cents: 100 };
  const [enabled, setEnabled] = useState(policy.enabled);
  const [strategy, setStrategy] = useState<PricingStrategy>(policy.strategy);
  const [provision, setProvision] = useState(centsInput(xof.provision_cents));
  const [step, setStep] = useState(centsInput(xof.rounding_step_cents));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const provisionCents = parseScaled(provision, 0) === null ? null : (parseScaled(provision, 0) as number) * 100;
  const stepCents = parseScaled(step, 0) === null ? null : (parseScaled(step, 0) as number) * 100;
  const valid = provisionCents !== null && stepCents !== null && stepCents >= 100;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setError('');
    try {
      await adminSetPricingPolicy({
        enabled, strategy,
        // Les autres devises déjà paramétrées sont conservées telles quelles.
        currencies: { ...policy.currencies, XOF: { provision_cents: provisionCents, rounding_step_cents: stepCents } },
      });
      onSaved('Politique de prix enregistrée. Elle s’applique aux prochaines commandes ; les commandes déjà créées gardent leur prix.');
    } catch (err) {
      setError(asAppError(err, 'La politique de prix n’a pas pu être enregistrée.').message);
    } finally { setBusy(false); }
  };

  return (
    <Card data-testid="finance-policy">
      <CardHeader
        title="Politique de prix"
        description="Le client paie un prix final unique. La provision s’ajoute au prix de base pour absorber les frais SasPay ; les crédits et l’abonnement restent calculés sur le prix de base."
      />
      <form onSubmit={(e) => void save(e)} className="space-y-4 p-5" noValidate>
        <Toggle checked={enabled} onChange={setEnabled} label="Appliquer la provision aux nouveaux paiements" />
        {!enabled && (
          <Banner tone="warning" title="Provision désactivée">
            Les prix redeviennent les prix de base et les frais SasPay s’appliquent selon le réglage du compte SasPay.
          </Banner>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Input id="fin-pol-1"
            label="Provision par transaction (FCFA)" inputMode="numeric" value={provision}
            onChange={(e) => setProvision(e.target.value)}
            error={provisionCents === null ? 'Montant entier attendu.' : undefined}
            hint="Ajoutée au prix de base de chaque paiement."
          />
          <Input id="fin-pol-2"
            label="Arrondi du prix final (FCFA)" inputMode="numeric" value={step}
            onChange={(e) => setStep(e.target.value)}
            error={stepCents === null || stepCents < 100 ? 'Au moins 1 FCFA.' : undefined}
            hint="Le prix est arrondi au multiple supérieur."
          />
          <Select id="fin-pol-3" label="Stratégie" value={strategy} onChange={(e) => setStrategy(e.target.value as PricingStrategy)}>
            {(Object.keys(STRATEGY_LABELS) as PricingStrategy[]).map((key) => <option key={key} value={key}>{STRATEGY_LABELS[key]}</option>)}
          </Select>
        </div>
        <p className="text-[11.5px] leading-relaxed text-slate-400">
          {strategy === 'cover_fees'
            ? 'Si les frais confirmés au barème dépassent la provision, le prix est relevé juste assez pour que VYORA reçoive au moins le prix de base.'
            : 'Le prix final est toujours « prix de base + provision ». Si les frais dépassent la provision, la vente est déficitaire et une alerte est émise.'}
          {' '}Mode de frais demandé à SasPay : <strong className="text-slate-200">déduits</strong> (le client paie exactement le prix affiché).
        </p>
        {error && <Banner tone="danger" title="Enregistrement impossible">{error}</Banner>}
        <div className="flex justify-end">
          <Button type="submit" loading={busy} disabled={!valid || busy}>Enregistrer la politique</Button>
        </div>
      </form>
    </Card>
  );
}

/* --------------------------------- Barème --------------------------------- */

function describeTariff(t: Tariff): string {
  const parts: string[] = [];
  if (t.percent_milli > 0) parts.push(formatPercentMilli(t.percent_milli));
  if (t.fixed_cents > 0) parts.push(`${formatCents(t.fixed_cents, t.currency)} fixes`);
  if (parts.length === 0) parts.push('Gratuit (confirmé)');
  if (t.floor_fee_cents !== null) parts.push(`minimum ${formatCents(t.floor_fee_cents, t.currency)}`);
  if (t.cap_fee_cents !== null) parts.push(`maximum ${formatCents(t.cap_fee_cents, t.currency)}`);
  return parts.join(' · ');
}

const EMPTY_TARIFF = {
  type: 'payin' as 'payin' | 'payout', country: 'ML', currency: 'XOF', network: '', min: '0', max: '', percent: '', fixed: '',
  floor: '', cap: '', source: 'owner_provided' as TariffInput['source'], note: '', free: false,
};

function TariffDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const [form, setForm] = useState(EMPTY_TARIFF);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof typeof EMPTY_TARIFF>(key: K, value: (typeof EMPTY_TARIFF)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const optional = (text: string, digits: number): number | null | undefined => (text.trim() === '' ? null : parseScaled(text, digits) ?? undefined);
  const percent = form.percent.trim() === '' ? 0 : parseScaled(form.percent, 3);
  const fixed = form.fixed.trim() === '' ? 0 : parseScaled(form.fixed, 2);
  const min = parseScaled(form.min.trim() === '' ? '0' : form.min, 2);
  const max = optional(form.max, 2);
  const floor = optional(form.floor, 2);
  const cap = optional(form.cap, 2);
  const numbersOk = percent !== null && fixed !== null && min !== null && max !== undefined && floor !== undefined && cap !== undefined;
  const isFree = numbersOk && percent === 0 && fixed === 0 && floor === null;
  const valid = numbersOk && /^[A-Za-z]{3}$/.test(form.currency.trim()) && form.note.trim().length >= 5 && (!isFree || form.free);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !numbersOk) return;
    setBusy(true); setError('');
    try {
      await adminAddTariff({
        transaction_type: form.type,
        country_code: form.country.trim().toUpperCase() || null,
        currency: form.currency.trim().toUpperCase(),
        network_code: form.network.trim() || null,
        min_amount_cents: min as number, max_amount_cents: max as number | null,
        percent_milli: percent as number, fixed_cents: fixed as number,
        floor_fee_cents: floor as number | null, cap_fee_cents: cap as number | null,
        fee_base: 'total', source: form.source, source_note: form.note.trim(),
        ...(isFree ? { confirmed_free: true } : {}),
      });
      onDone('Ligne de barème ajoutée. Elle s’applique aux prochaines commandes.');
    } catch (err) {
      setError(asAppError(err, 'La ligne n’a pas pu être ajoutée.').message);
    } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title="Ajouter une ligne de barème" size="lg"
      description="Saisissez uniquement un tarif confirmé par SasPay ou par un document du propriétaire. Aucune estimation.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4 px-5 py-4" noValidate data-testid="tariff-form">
        <div className="grid gap-3 sm:grid-cols-4">
          <Select id="fin-tar-1" label="Type" value={form.type} onChange={(e) => set('type', e.target.value as 'payin' | 'payout')}>
            <option value="payin">Encaissement (pay-in)</option>
            <option value="payout">Décaissement (payout)</option>
          </Select>
          <Input id="fin-tar-2" label="Pays" value={form.country} maxLength={2} onChange={(e) => set('country', e.target.value)} hint="Code à 2 lettres. Vide = tous." />
          <Input id="fin-tar-3" label="Devise" value={form.currency} maxLength={3} onChange={(e) => set('currency', e.target.value)} />
          <Input id="fin-tar-4" label="Opérateur" value={form.network} onChange={(e) => set('network', e.target.value)} hint="Ex. orange_ml. Vide = tous." />
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Input id="fin-tar-5" label="Taux (%)" inputMode="decimal" value={form.percent} onChange={(e) => set('percent', e.target.value)}
            error={percent === null ? '3 décimales au plus.' : undefined} hint="Ex. 2,5" />
          <Input id="fin-tar-6" label="Frais fixes" inputMode="decimal" value={form.fixed} onChange={(e) => set('fixed', e.target.value)}
            error={fixed === null ? 'Montant invalide.' : undefined} />
          <Input id="fin-tar-7" label="Frais minimum" inputMode="decimal" value={form.floor} onChange={(e) => set('floor', e.target.value)}
            error={floor === undefined ? 'Montant invalide.' : undefined} hint="Facultatif" />
          <Input id="fin-tar-8" label="Frais maximum" inputMode="decimal" value={form.cap} onChange={(e) => set('cap', e.target.value)}
            error={cap === undefined ? 'Montant invalide.' : undefined} hint="Facultatif" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input id="fin-tar-9" label="Montant à partir de" inputMode="decimal" value={form.min} onChange={(e) => set('min', e.target.value)}
            error={min === null ? 'Montant invalide.' : undefined} />
          <Input id="fin-tar-10" label="Montant jusqu’à" inputMode="decimal" value={form.max} onChange={(e) => set('max', e.target.value)}
            error={max === undefined ? 'Montant invalide.' : undefined} hint="Vide = sans plafond" />
          <Select id="fin-tar-11" label="Origine du tarif" value={form.source} onChange={(e) => set('source', e.target.value as TariffInput['source'])}>
            <option value="owner_provided">Fourni par le propriétaire</option>
            <option value="saspay_documentation">Documentation SasPay</option>
          </Select>
        </div>
        <Textarea id="fin-tar-12" label="Référence du tarif" value={form.note} onChange={(e) => set('note', e.target.value)} maxLength={500}
          hint="Document, page, date ou interlocuteur SasPay qui confirme ce tarif (5 caractères au moins)." />
        {isFree && (
          <Toggle checked={form.free} onChange={(v) => set('free', v)} label="Je confirme que ce tarif est réellement de 0 (aucuns frais)" />
        )}
        {error && <Banner tone="danger" title="Ligne refusée">{error}</Banner>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" loading={busy} disabled={!valid || busy}>Ajouter la ligne</Button>
        </div>
      </form>
    </Modal>
  );
}

function CloseTariffDialog({ tariff, onClose, onDone }: { tariff: Tariff; onClose: () => void; onDone: (message: string) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await adminCloseTariff(tariff.id, note.trim());
      onDone('Ligne close. Les commandes déjà créées gardent le devis calculé avec elle.');
    } catch (err) {
      setError(asAppError(err, 'La ligne n’a pas pu être close.').message);
    } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Clore cette ligne de barème" description={describeTariff(tariff)}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4 px-5 py-4" noValidate>
        <p className="text-[12.5px] text-slate-300">
          La ligne cesse de s’appliquer dès maintenant et reste consultable. Sans autre ligne pour ce pays et cet opérateur,
          les frais redeviennent « non confirmés ».
        </p>
        <Textarea id="fin-clo-1" label="Motif" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        {error && <Banner tone="danger" title="Clôture impossible">{error}</Banner>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" loading={busy} disabled={busy || note.trim().length < 5}>Clore la ligne</Button>
        </div>
      </form>
    </Modal>
  );
}

function TariffCard({ overview, onChanged }: { overview: PricingOverview; onChanged: (message: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [closing, setClosing] = useState<Tariff | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const active = overview.tariffs.filter((t) => t.active);
  const closed = overview.tariffs.filter((t) => !t.active);

  const importRates = async () => {
    setImporting(true); setError('');
    try {
      const result = await adminSyncRates();
      onChanged(`Tarifs du compte SasPay importés (${result.mode === 'live' ? 'production' : 'mode test'}) : `
        + `${result.inserted} ligne(s) ajoutée(s), ${result.unchanged} inchangée(s), ${result.closed} close(s)`
        + `${result.skipped > 0 ? `, ${result.skipped} ignorée(s) car illisible(s)` : ''}.`);
    } catch (err) {
      setError(asAppError(err, 'Les tarifs du compte SasPay n’ont pas pu être lus. Le barème n’a pas été modifié.').message);
    } finally { setImporting(false); }
  };

  return (
    <Card data-testid="finance-tariffs">
      <CardHeader
        title="Barème des frais SasPay"
        description="Seuls des tarifs confirmés figurent ici : importés du compte SasPay, ou saisis d’après un document. Rien n’est supposé."
        action={(
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" icon={<Download size={13} />} loading={importing} onClick={() => void importRates()}>
              Importer les tarifs du compte
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>Ajouter une ligne</Button>
          </div>
        )}
      />
      <div className="space-y-3 p-5">
        <p className="text-[11.5px] text-slate-400">
          L’import lit les tarifs propres à votre compte chez SasPay (lecture seule, aucun paiement) avec la clé installée côté serveur.
        </p>
        {error && <Banner tone="danger" title="Import impossible">{error}</Banner>}
        {overview.missing_tariffs.length > 0 && (
          <Banner tone="warning" title="Frais non confirmés">
            Aucun tarif d’encaissement confirmé pour :{' '}
            {overview.missing_tariffs.map((m) => `${m.country_code} · ${m.network_code ?? m.network_label}`).join(' ; ')}.
            {' '}Pour ces paiements, le prix final est « prix de base + provision » et les frais estimés restent inconnus
            jusqu’à l’import des tarifs ou la saisie d’une ligne.
          </Banner>
        )}
        {overview.account_add_on_lines > 0 && (
          <Banner tone="warning" title="Le compte SasPay ajoute les frais au client par défaut">
            {overview.account_add_on_lines} ligne(s) importée(s) indiquent le mode « frais ajoutés ». VYORA demande le mode « déduits »
            à chaque paiement, mais SasPay ne l’applique que si l’option « Autoriser le choix du mode de frais par l’API » est activée
            (tableau de bord SasPay, Paramètres → Frais). Sinon le client paierait plus que le prix affiché : une alerte serait émise.
          </Banner>
        )}
        {active.length === 0 ? (
          <p className="text-[12.5px] text-slate-400" data-testid="tariffs-empty">Le barème est vide : aucun tarif SasPay n’est confirmé pour l’instant.</p>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {active.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5" data-testid="tariff-line">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">
                    {t.transaction_type === 'payin' ? 'Encaissement' : 'Décaissement'} · {t.country_code ?? 'Tous pays'} · {t.network_code ?? 'Tous opérateurs'} · {describeTariff(t)}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    De {formatCents(t.min_amount_cents, t.currency)}{t.max_amount_cents !== null ? ` à ${formatCents(t.max_amount_cents, t.currency)}` : ' et plus'}
                    {' · '}{TARIFF_SOURCE_LABELS[t.source] ?? t.source}{t.source_note ? ` — ${t.source_note}` : ''}
                    {' · '}depuis le {formatDate(t.valid_from, true)}
                    {t.account_fee_mode ? ` · mode du compte : ${t.account_fee_mode === 'ADD_ON' ? 'frais ajoutés' : 'frais déduits'}` : ''}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setClosing(t)}>Clore</Button>
              </div>
            ))}
          </div>
        )}
        {closed.length > 0 && (
          <div>
            <button type="button" className="text-[11.5px] text-slate-400 underline" onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? 'Masquer' : 'Afficher'} les {closed.length} ligne(s) close(s) ou à venir
            </button>
            {showClosed && (
              <ul className="mt-2 space-y-1 text-[11px] text-slate-500">
                {closed.map((t) => (
                  <li key={t.id}>
                    {t.transaction_type === 'payin' ? 'Encaissement' : 'Décaissement'} · {t.country_code ?? 'Tous pays'} · {t.network_code ?? 'Tous opérateurs'} · {describeTariff(t)}
                    {' · '}du {formatDate(t.valid_from, true)}{t.valid_until ? ` au ${formatDate(t.valid_until, true)}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {adding && <TariffDialog onClose={() => setAdding(false)} onDone={(m) => { setAdding(false); onChanged(m); }} />}
      {closing && <CloseTariffDialog tariff={closing} onClose={() => setClosing(null)} onDone={(m) => { setClosing(null); onChanged(m); }} />}
    </Card>
  );
}

/* ------------------------------- Simulateur ------------------------------- */

function SimulatorCard() {
  const [amount, setAmount] = useState('5000');
  const [country, setCountry] = useState('ML');
  const [network, setNetwork] = useState('');
  const [kind, setKind] = useState<'payin' | 'payout'>('payin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [price, setPrice] = useState<PriceSimulation | null>(null);
  const [payout, setPayout] = useState<PayoutSimulation | null>(null);
  const cents = parseScaled(amount, 2);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (cents === null || cents <= 0) return;
    setBusy(true); setError(''); setPrice(null); setPayout(null);
    try {
      const net = network.trim() || null;
      if (kind === 'payin') setPrice(await adminPriceSimulation(cents, 'XOF', country.trim().toUpperCase(), net));
      else setPayout(await adminPayoutSimulation(cents, 'XOF', country.trim().toUpperCase(), net));
    } catch (err) {
      setError(asAppError(err, 'La simulation n’a pas pu être calculée.').message);
    } finally { setBusy(false); }
  };

  return (
    <Card data-testid="finance-simulator">
      <CardHeader title="Simulateur" description="Calculé par le serveur avec la politique et le barème en vigueur. Aucune commande, aucun paiement." />
      <div className="space-y-4 p-5">
        <form onSubmit={(e) => void run(e)} className="grid items-end gap-3 sm:grid-cols-5" noValidate>
          <Select id="fin-sim-1" label="Opération" value={kind} onChange={(e) => setKind(e.target.value as 'payin' | 'payout')}>
            <option value="payin">Encaissement client</option>
            <option value="payout">Décaissement (estimation)</option>
          </Select>
          <Input id="fin-sim-2" label={kind === 'payin' ? 'Prix de base (FCFA)' : 'Montant à verser (FCFA)'} inputMode="decimal" value={amount}
            onChange={(e) => setAmount(e.target.value)} error={cents === null || cents <= 0 ? 'Montant invalide.' : undefined} />
          <Input id="fin-sim-3" label="Pays" value={country} maxLength={2} onChange={(e) => setCountry(e.target.value)} />
          <Input id="fin-sim-4" label="Opérateur" value={network} onChange={(e) => setNetwork(e.target.value)} hint="Vide = pire cas du pays" />
          <Button type="submit" loading={busy} disabled={busy || cents === null || cents <= 0} icon={<Calculator size={14} />}>Simuler</Button>
        </form>
        {error && <Banner tone="danger" title="Simulation impossible">{error}</Banner>}
        {price && (
          <dl className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3" data-testid="simulation-result">
            <Row label="Prix de base" value={formatCents(price.base_cents, price.currency)} />
            <Row label="Provision" value={formatCents(price.provision_cents, price.currency)} />
            <Row label="Prix final payé par le client" value={formatCents(price.final_cents, price.currency)} strong />
            <Row label="Frais SasPay estimés"
              value={price.tariff_status === 'confirmed' ? formatCents(price.estimated_fee_cents, price.currency) : 'Non confirmés (barème vide pour ce cas)'} />
            <Row label="Net attendu" value={price.tariff_status === 'confirmed' ? formatCents(price.expected_net_cents, price.currency) : '—'} />
            <Row label="Marge attendue après frais"
              value={price.tariff_status === 'confirmed' ? formatCents(price.expected_margin_cents, price.currency) : '—'}
              tone={price.expected_margin_cents === null ? undefined : price.expected_margin_cents < 0 ? 'bad' : 'good'} />
            {!price.policy_enabled && <p className="mt-2 text-[11.5px] text-amber-200">Provision désactivée : le prix final est le prix de base.</p>}
            {price.tariff_status === 'confirmed' && price.surcharge_cents > price.provision_cents && (
              <p className="mt-2 text-[11.5px] text-slate-400">
                Les frais dépassent la provision : le prix a été relevé de {formatCents(price.surcharge_cents - price.provision_cents, price.currency)} supplémentaires
                pour que le net ne passe pas sous le prix de base.
              </p>
            )}
          </dl>
        )}
        {payout && (
          <dl className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3" data-testid="payout-result">
            <Row label="Montant à verser" value={formatCents(payout.amount_cents)} />
            <Row label="Provision" value="Aucune (la provision ne s’applique qu’aux encaissements)" />
            <Row label="Frais de décaissement estimés"
              value={payout.tariff_status === 'confirmed' ? formatCents(payout.estimated_fee_cents) : 'Non confirmés (aucun tarif de décaissement au barème)'} />
            <p className="mt-2 text-[11.5px] text-slate-400">Estimation seulement : VYORA n’exécute aucun décaissement.</p>
          </dl>
        )}
      </div>
    </Card>
  );
}

/* --------------------------------- Rapport -------------------------------- */

function StatsGrid({ stats }: { stats: FinanceStats }) {
  const currency = stats.currency ?? 'XOF';
  if (stats.transactions === 0) return <p className="text-[12.5px] text-slate-400" data-testid="finance-empty">Aucun paiement confirmé sur ce périmètre.</p>;
  if (stats.currencies > 1) {
    return (
      <Banner tone="warning" title="Plusieurs devises">
        Ce périmètre mélange {stats.currencies} devises : les montants ne s’additionnent pas. Filtrez par pays.
      </Banner>
    );
  }
  return (
    <dl className="grid gap-x-8 sm:grid-cols-2" data-testid="finance-totals">
      <div>
        <Row label="Paiements confirmés" value={String(stats.transactions)} />
        <Row label="Chiffre d’affaires brut (payé par les clients)" value={formatCents(stats.gross_cents, currency)} strong />
        <Row label="dont prix de base" value={formatCents(stats.base_cents, currency)} />
        <Row label="dont provisions facturées" value={formatCents(stats.provision_cents, currency)} />
        <Row label="Remboursements enregistrés" value={`${formatCents(stats.refunded_cents, currency)} (${stats.refunded})`} />
      </div>
      <div>
        <Row label="Frais SasPay réels" value={stats.fee_known > 0 ? formatCents(stats.actual_fee_cents, currency) : '—'} />
        <Row label="Net reçu" value={stats.fee_known > 0 ? formatCents(stats.actual_net_cents, currency) : '—'} strong />
        <Row label="Marge après frais (net − prix de base)" value={stats.fee_known > 0 ? formatCents(stats.margin_cents, currency) : '—'}
          tone={stats.fee_known === 0 ? undefined : stats.margin_cents < 0 ? 'bad' : 'good'} />
        <Row label="Écart frais réels − frais estimés"
          value={stats.compared > 0 ? `${formatCents(stats.fee_variance_cents, currency)} sur ${stats.compared} paiement(s)` : '— (aucun tarif confirmé à comparer)'} />
        <Row label="Ventes déficitaires / frais au-dessus de la provision" value={`${stats.unprofitable} / ${stats.over_provision}`}
          tone={stats.unprofitable + stats.over_provision > 0 ? 'bad' : undefined} />
      </div>
      {stats.fee_unknown > 0 && (
        <p className="col-span-full mt-2 text-[11.5px] text-amber-200">
          {stats.fee_unknown} paiement(s) sans frais restitués par SasPay : ils ne sont comptés ni dans les frais, ni dans le net, ni dans la marge.
        </p>
      )}
    </dl>
  );
}

function Breakdown<T extends FinanceStats>({ title, rows, label }: { title: string; rows: T[]; label: (row: T) => string }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-left text-[12px]">
          <thead className="text-[10.5px] uppercase tracking-wide text-slate-500">
            <tr><th className="py-1 pr-3">Périmètre</th><th className="pr-3">Paiements</th><th className="pr-3">Brut</th><th className="pr-3">Frais réels</th><th className="pr-3">Net reçu</th><th>Marge</th></tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05] text-slate-200">
            {rows.map((row) => {
              const currency = row.currency ?? 'XOF';
              const known = row.fee_known > 0 && row.currencies <= 1;
              return (
                <tr key={label(row)}>
                  <td className="py-1.5 pr-3 font-medium text-white">{label(row)}</td>
                  <td className="pr-3">{row.transactions}</td>
                  <td className="pr-3">{row.currencies > 1 ? 'Plusieurs devises' : formatCents(row.gross_cents, currency)}</td>
                  <td className="pr-3">{known ? formatCents(row.actual_fee_cents, currency) : '—'}</td>
                  <td className="pr-3">{known ? formatCents(row.actual_net_cents, currency) : '—'}</td>
                  <td className={known && row.margin_cents < 0 ? 'text-rose-300' : ''}>{known ? formatCents(row.margin_cents, currency) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Lines({ lines, testId }: { lines: FinanceLine[]; testId: string }) {
  return (
    <div className="divide-y divide-white/[0.06]">
      {lines.map((l) => (
        <div key={`${l.product}:${l.order_id}`} className="py-2" data-testid={testId}>
          <p className="text-[12.5px] font-semibold text-white">
            {PRODUCT_LABELS[l.product] ?? l.product}{l.item_key ? ` · ${l.item_key}` : ''} · payé {formatCents(l.charged_cents, l.currency)}
            {' · '}frais {formatCents(l.actual_fee_cents, l.currency)} · net {formatCents(l.actual_net_cents, l.currency)}
            {' · '}marge <span className={l.margin_cents !== null && l.margin_cents < 0 ? 'text-rose-300' : 'text-emerald-300'}>{formatCents(l.margin_cents, l.currency)}</span>
          </p>
          <p className="text-[11px] text-slate-500">
            {formatDate(l.paid_at, true)} · {l.country_code ?? '—'} · {l.network} · <span className="font-mono">{l.internal_reference}</span>
            {' · '}base {formatCents(l.base_cents, l.currency)} + provision {formatCents(l.provision_cents, l.currency)}
            {' · '}frais estimés {formatCents(l.estimated_fee_cents, l.currency)}
            {l.refund_cents ? ` · remboursé ${formatCents(l.refund_cents, l.currency)}` : ''}
          </p>
          {l.flags.length > 0 && (
            <p className="text-[11px] text-amber-200/90">{l.flags.map((f) => FINANCE_FLAG_LABELS[f] ?? f).join(' · ')}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function ReportCard({ missing, onBackfilled }: { missing: number; onBackfilled: (message: string) => void }) {
  const [filters, setFilters] = useState({ from: '', to: '', country: '', network: '', product: '' });
  const [report, setReport] = useState<FinanceReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [backfilling, setBackfilling] = useState(false);

  const load = useCallback(async (f: typeof filters) => {
    setBusy(true); setError('');
    try {
      // Bornes de dates en heure locale de l'administrateur ; la fin est exclusive (lendemain 00:00).
      const from = f.from ? new Date(`${f.from}T00:00:00`).toISOString() : null;
      const end = f.to ? new Date(`${f.to}T00:00:00`) : null;
      if (end) end.setDate(end.getDate() + 1);
      const result = await adminFinanceReport({
        from, to: end ? end.toISOString() : null, country: f.country.trim() || null, network: f.network.trim() || null,
        product: f.product === 'studio' || f.product === 'business' ? f.product as PaymentProduct : null,
      });
      if (!result) throw new Error('Réponse inattendue du serveur.');
      setReport(result);
    } catch (err) {
      // Rapport illisible : « inconnu », jamais des zéros.
      setReport(null);
      setError(asAppError(err, 'Le rapport financier n’a pas pu être lu.').message);
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void load({ from: '', to: '', country: '', network: '', product: '' }); }, [load]);

  const backfill = async () => {
    setBackfilling(true); setError('');
    try {
      const recorded = await adminFinanceBackfill();
      onBackfilled(`${recorded} paiement(s) ancien(s) ajouté(s) au rapprochement.`);
      await load(filters);
    } catch (err) {
      setError(asAppError(err, 'La reprise de l’historique a échoué.').message);
    } finally { setBackfilling(false); }
  };

  return (
    <Card data-testid="finance-report">
      <CardHeader
        title="Chiffre d’affaires, frais et marge"
        description="Rapprochement de chaque paiement confirmé : ce que le client a payé, ce que SasPay a prélevé, ce que VYORA a reçu."
        action={<Button size="sm" variant="outline" icon={<RefreshCw size={13} />} loading={busy} onClick={() => void load(filters)}>Actualiser</Button>}
      />
      <div className="space-y-4 p-5">
        <form className="grid items-end gap-3 sm:grid-cols-6" onSubmit={(e) => { e.preventDefault(); void load(filters); }}>
          <Input id="fin-rep-1" label="Du" type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
          <Input id="fin-rep-2" label="Au" type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
          <Input id="fin-rep-3" label="Pays" value={filters.country} maxLength={2} onChange={(e) => setFilters((f) => ({ ...f, country: e.target.value }))} />
          <Input id="fin-rep-4" label="Opérateur" value={filters.network} onChange={(e) => setFilters((f) => ({ ...f, network: e.target.value }))} />
          <Select id="fin-rep-5" label="Produit" value={filters.product} onChange={(e) => setFilters((f) => ({ ...f, product: e.target.value }))}>
            <option value="">Tous</option>
            <option value="studio">Studio</option>
            <option value="business">Business Grow</option>
          </Select>
          <Button type="submit" variant="outline" loading={busy}>Filtrer</Button>
        </form>
        {missing > 0 && (
          <Banner tone="info" title="Paiements non rapprochés">
            {missing} paiement(s) confirmé(s) avant la mise en place du rapprochement n’y figurent pas encore.{' '}
            <button type="button" className="underline" disabled={backfilling} onClick={() => void backfill()}>
              {backfilling ? 'Reprise en cours…' : 'Reprendre l’historique'}
            </button>
          </Banner>
        )}
        {error && <Banner tone="danger" title="Rapport non vérifié">{error}</Banner>}
        {busy && !report && <LoadingState label="Lecture du rapprochement…" />}
        {report && (
          <>
            {report.totals ? <StatsGrid stats={report.totals} /> : <p className="text-[12.5px] text-slate-400" data-testid="finance-empty">Aucun paiement confirmé sur ce périmètre.</p>}
            <Breakdown title="Par pays" rows={report.by_country} label={(r) => r.country_code ?? 'Pays inconnu'} />
            <Breakdown title="Par opérateur" rows={report.by_network}
              label={(r) => (r.network === 'checkout' ? 'Page de paiement hébergée' : r.network === 'inconnu' ? 'Opérateur inconnu' : r.network)} />
            <Breakdown title="Par produit" rows={report.by_product} label={(r) => `${PRODUCT_LABELS[r.product] ?? r.product} · ${r.item_key ?? '—'}`} />
            {report.unprofitable.length > 0 && (
              <div>
                <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-rose-300">
                  <Scale size={12} /> Paiements insuffisamment rentables <Badge tone="danger">{report.unprofitable.length}</Badge>
                </p>
                <Lines lines={report.unprofitable} testId="finance-unprofitable" />
              </div>
            )}
            {report.recent.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Derniers paiements rapprochés</p>
                <Lines lines={report.recent} testId="finance-line" />
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

/* --------------------------------- Écran ---------------------------------- */

export default function SasPayFinance() {
  const [overview, setOverview] = useState<PricingOverview | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** Force le remontage des formulaires après un rechargement (valeurs relues du serveur). */
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const result = await adminPricingOverview();
      if (!result) throw new Error('Réponse inattendue du serveur.');
      setOverview(result);
      setVersion((v) => v + 1);
    } catch (err) {
      // Politique illisible : on ne montre pas de valeurs par défaut inventées.
      setOverview(null);
      setError(asAppError(err, 'La politique de prix n’a pas pu être lue.').message);
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const changed = (message: string) => { setNotice(message); void load(); };

  return (
    <div className="space-y-5" data-testid="saspay-finance">
      <p className="flex items-center gap-2 text-[12px] text-slate-400">
        <TrendingUp size={14} className="text-slate-500" />
        Prix final payé par le client = prix de base + provision, relevé si les frais confirmés l’exigent. Le client ne voit que le prix final.
      </p>
      {notice && <Banner tone="success" title="Enregistré">{notice}</Banner>}
      {error && <Banner tone="danger" title="Tarification non vérifiée">{error}</Banner>}
      {busy && !overview && <LoadingState label="Lecture de la tarification…" />}
      {overview && (
        <>
          <PolicyCard key={`policy-${version}`} overview={overview} onSaved={changed} />
          <TariffCard overview={overview} onChanged={changed} />
          <SimulatorCard key={`sim-${version}`} />
          <ReportCard missing={overview.missing_reconciliations} onBackfilled={changed} />
        </>
      )}
    </div>
  );
}
