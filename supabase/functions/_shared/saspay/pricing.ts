// Tarification VYORA : provision commerciale et couverture des frais SasPay.
//
// Miroir, en TypeScript, du calcul fait en base par `ugc_private.vyora_price_quote`
// (migration `20261113120000_vyora_pricing_margin.sql`). La base FAIT FOI : c'est
// elle qui fige le prix d'une commande. Ce module sert aux tests (mêmes vecteurs
// que le banc SQL : `supabase/tests/saspay/pricing-vectors.json`) et à simuler la
// base dans les tests du service de paiement.
//
// Tous les montants sont des entiers `bigint` en CENTIÈMES de l'unité monétaire ;
// les pourcentages sont en MILLIÈMES de pour cent (2,5 % = 2500). Aucun nombre à
// virgule flottante n'intervient.

export type FeeBase = 'total' | 'base';
export type PricingStrategy = 'cover_fees' | 'provision_only';

export interface FeeLine {
  id: string;
  transaction_type: 'payin' | 'payout';
  /** `null` : tous les pays. */
  country_code: string | null;
  currency: string;
  /** `null` : tous les opérateurs. */
  network_code: string | null;
  min_amount_cents: bigint;
  max_amount_cents: bigint | null;
  percent_milli: bigint;
  fixed_cents: bigint;
  floor_fee_cents: bigint | null;
  cap_fee_cents: bigint | null;
  /** Assiette des frais : total encaissé (mode « Déduits ») ou prix de base. */
  fee_base: FeeBase;
  /** Millisecondes depuis l'époque. */
  valid_from: number;
  valid_until: number | null;
  created_at: number;
}

export interface PricingPolicy {
  enabled: boolean;
  strategy: PricingStrategy;
  currencies: Record<string, { provision_cents: bigint; rounding_step_cents: bigint }>;
}

export interface PriceQuote {
  policy_enabled: boolean;
  strategy: PricingStrategy | 'none';
  currency: string;
  country: string;
  network: string | null;
  base_cents: bigint;
  provision_cents: bigint;
  final_cents: bigint;
  surcharge_cents: bigint;
  /** Frais retenus pour fixer le prix (pire cas parmi les opérateurs possibles). */
  pricing_fee_cents: bigint | null;
  /** Frais estimés pour CETTE commande (opérateur connu), sinon le pire cas. */
  estimated_fee_cents: bigint | null;
  expected_net_cents: bigint | null;
  expected_margin_cents: bigint | null;
  tariff_status: 'confirmed' | 'missing';
  tariff_id: string | null;
  fee_charge_mode: 'DEDUCTED' | null;
  iterations: number;
}

export class PricingError extends Error {
  constructor(readonly code: string) { super(code); }
}

const PERCENT_DENOMINATOR = 100_000n; // millièmes de pour cent → fraction
const MAX_ITERATIONS = 200;

/** Frais d'un palier pour un montant ; part proportionnelle arrondie au centième supérieur. */
export function feeAmount(
  amountCents: bigint,
  line: Pick<FeeLine, 'percent_milli' | 'fixed_cents' | 'floor_fee_cents' | 'cap_fee_cents'>,
): bigint {
  let fee = (amountCents * line.percent_milli + PERCENT_DENOMINATOR - 1n) / PERCENT_DENOMINATOR + line.fixed_cents;
  if (line.floor_fee_cents !== null && fee < line.floor_fee_cents) fee = line.floor_fee_cents;
  if (line.cap_fee_cents !== null && fee > line.cap_fee_cents) fee = line.cap_fee_cents;
  return fee;
}

export function roundUp(valueCents: bigint, stepCents: bigint): bigint {
  return ((valueCents + stepCents - 1n) / stepCents) * stepCents;
}

interface Scope {
  type: 'payin' | 'payout';
  country: string;
  currency: string;
  total: bigint;
  base: bigint;
  at: number;
}

const assiette = (line: FeeLine, scope: Scope) => (line.fee_base === 'total' ? scope.total : scope.base);

function applicable(line: FeeLine, scope: Scope): boolean {
  if (line.transaction_type !== scope.type || line.currency !== scope.currency) return false;
  if (line.valid_from > scope.at) return false;
  if (line.valid_until !== null && line.valid_until <= scope.at) return false;
  if (line.country_code !== null && line.country_code !== scope.country) return false;
  const amount = assiette(line, scope);
  if (amount < line.min_amount_cents) return false;
  if (line.max_amount_cents !== null && amount > line.max_amount_cents) return false;
  return true;
}

/** Plus précise d'abord (pays), puis plus récente. */
function byPrecedence(a: FeeLine, b: FeeLine): number {
  const country = Number(b.country_code !== null) - Number(a.country_code !== null);
  if (country !== 0) return country;
  if (a.valid_from !== b.valid_from) return b.valid_from - a.valid_from;
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Ligne applicable à un opérateur donné (ou générique si `network` est nul). */
export function feeLine(lines: FeeLine[], scope: Scope, network: string | null): FeeLine | null {
  const candidates = lines.filter((line) => applicable(line, scope)
    && (line.network_code === null || line.network_code === network));
  candidates.sort((a, b) => {
    const specific = Number(b.network_code !== null) - Number(a.network_code !== null);
    return specific !== 0 ? specific : byPrecedence(a, b);
  });
  return candidates[0] ?? null;
}

/** Frais les plus élevés parmi les opérateurs possibles. `networks` nul : tous. */
export function worstFee(
  lines: FeeLine[], scope: Scope, networks: string[] | null,
): { fee: bigint; line: FeeLine } | null {
  const perNetwork = new Map<string, FeeLine>();
  for (const line of lines) {
    if (!applicable(line, scope)) continue;
    if (line.network_code !== null && networks !== null && !networks.includes(line.network_code)) continue;
    const key = line.network_code ?? '\u0000';
    const current = perNetwork.get(key);
    if (!current || byPrecedence(line, current) < 0) perNetwork.set(key, line);
  }
  let worst: { fee: bigint; line: FeeLine } | null = null;
  for (const line of perNetwork.values()) {
    const fee = feeAmount(assiette(line, scope), line);
    if (!worst || fee > worst.fee || (fee === worst.fee && line.id < worst.line.id)) worst = { fee, line };
  }
  return worst;
}

export interface QuoteInput {
  policy: PricingPolicy;
  lines: FeeLine[];
  baseCents: bigint;
  currency: string;
  country: string;
  /** Opérateur de la commande (paiement direct) ; nul pour la page hébergée. */
  network: string | null;
  /** Opérateurs possibles pour ce pays ; nul = tous (page hébergée activée). */
  networks: string[] | null;
  at: number;
}

/**
 * Prix final : plus petit montant, arrondi au pas de la devise, qui respecte
 *   P ≥ base + provision   et   P − frais(P) ≥ base.
 * Les frais portant sur le total, P est résolu par relèvements successifs.
 */
export function quotePrice(input: QuoteInput): PriceQuote {
  const { policy, lines, baseCents: base } = input;
  if (base <= 0n) throw new PricingError('pricing_invalid_base');
  const currency = input.currency.toUpperCase();
  const country = input.country.toUpperCase();
  let provision = 0n;
  let step = 100n;
  let strategy: PriceQuote['strategy'] = 'none';
  let total = base;
  if (policy.enabled) {
    const settings = policy.currencies[currency];
    if (!settings) throw new PricingError('pricing_currency_not_configured');
    provision = settings.provision_cents;
    step = settings.rounding_step_cents < 100n ? 100n : settings.rounding_step_cents;
    strategy = policy.strategy === 'provision_only' ? 'provision_only' : 'cover_fees';
    total = roundUp(base + provision, step);
  }

  const scope = (): Scope => ({ type: 'payin', country, currency, total, base, at: input.at });
  let worst = worstFee(lines, scope(), input.networks);
  let iterations = 0;
  while (worst && strategy === 'cover_fees' && total - worst.fee < base) {
    iterations += 1;
    if (iterations > MAX_ITERATIONS) throw new PricingError('pricing_not_convergent');
    total = roundUp(base + worst.fee, step);
    worst = worstFee(lines, scope(), input.networks);
  }

  let estimated: bigint | null = null;
  let tariff: FeeLine | null = null;
  if (input.network) {
    tariff = feeLine(lines, scope(), input.network);
    if (tariff) estimated = feeAmount(assiette(tariff, scope()), tariff);
  } else if (worst) {
    tariff = worst.line;
    estimated = worst.fee;
  }

  return {
    policy_enabled: policy.enabled,
    strategy,
    currency,
    country,
    network: input.network,
    base_cents: base,
    provision_cents: provision,
    final_cents: total,
    surcharge_cents: total - base,
    pricing_fee_cents: worst ? worst.fee : null,
    estimated_fee_cents: estimated,
    expected_net_cents: estimated === null ? null : total - estimated,
    expected_margin_cents: estimated === null ? null : total - estimated - base,
    tariff_status: estimated === null ? 'missing' : 'confirmed',
    tariff_id: tariff ? tariff.id : null,
    fee_charge_mode: policy.enabled ? 'DEDUCTED' : null,
    iterations,
  };
}

/** Décaissement : frais estimés, jamais de provision ni de relèvement. */
export function quotePayout(
  lines: FeeLine[], amountCents: bigint, currency: string, country: string, network: string | null, at: number,
): { amount_cents: bigint; provision_cents: bigint; estimated_fee_cents: bigint | null; tariff_status: 'confirmed' | 'missing' } {
  if (amountCents <= 0n) throw new PricingError('pricing_invalid_base');
  const scope: Scope = {
    type: 'payout', country: country.toUpperCase(), currency: currency.toUpperCase(),
    total: amountCents, base: amountCents, at,
  };
  const line = feeLine(lines, scope, network);
  const fee = line ? feeAmount(amountCents, line) : null;
  return {
    amount_cents: amountCents, provision_cents: 0n, estimated_fee_cents: fee,
    tariff_status: fee === null ? 'missing' : 'confirmed',
  };
}

export interface Reconciliation {
  charged_cents: bigint;
  actual_fee_cents: bigint | null;
  actual_net_cents: bigint | null;
  fee_variance_cents: bigint | null;
  margin_cents: bigint | null;
  provision_covers_fee: boolean | null;
  flags: string[];
}

/**
 * Rapprochement après confirmation (miroir de `vyora_payment_ledger_record`).
 * Frais réels = montant débité au client − montant net reçu.
 */
export function reconcile(
  quote: Pick<PriceQuote, 'policy_enabled' | 'base_cents' | 'provision_cents' | 'final_cents' | 'estimated_fee_cents'> | null,
  finalCents: bigint,
  actual: { chargedCents: bigint | null; netCents: bigint | null; feeMode: string | null },
): Reconciliation {
  const policy = quote?.policy_enabled === true;
  const base = quote ? quote.base_cents : finalCents;
  const estimated = quote ? quote.estimated_fee_cents : null;
  const flags: string[] = [];
  if (!quote) flags.push('legacy_pricing');
  else if (estimated === null) flags.push('tariff_missing');
  let charged = actual.chargedCents;
  if (charged === null) { charged = finalCents; flags.push('charged_assumed'); }
  let fee: bigint | null = null;
  if (actual.netCents === null) {
    flags.push('fee_unknown');
  } else {
    fee = charged - actual.netCents;
    // Provision réellement incluse dans le prix : prix final − prix de base (la
    // provision configurée, plus le relèvement décidé au devis pour un tarif connu).
    if (policy && fee > finalCents - base) flags.push('fee_exceeds_provision');
    if (actual.netCents < base) flags.push('net_below_base');
  }
  if (policy && (charged > finalCents || (actual.feeMode !== null && actual.feeMode !== 'DEDUCTED'))) {
    flags.push('fee_mode_unexpected');
  }
  return {
    charged_cents: charged,
    actual_fee_cents: fee,
    actual_net_cents: actual.netCents,
    fee_variance_cents: fee === null || estimated === null ? null : fee - estimated,
    margin_cents: actual.netCents === null ? null : actual.netCents - base,
    provision_covers_fee: fee === null || !policy ? null : fee <= finalCents - base,
    flags,
  };
}
