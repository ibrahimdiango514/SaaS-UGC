// VYORA — arithmétique monétaire exacte pour SasPay.
//
// SasPay échange les montants sous forme de CHAÎNES décimales (« 2500.00 »).
// Aucun calcul n'est fait en virgule flottante : tout passe par des entiers
// `bigint` exprimés en centièmes (échelle 2).

export const MONEY_SCALE = 100n;

const DECIMAL_RE = /^\d{1,15}(?:\.\d{1,2})?$/;

/** Convertit « 2500 », « 2500.5 », « 2500.50 » en centièmes. `null` si invalide. */
export function parseDecimal(value: unknown): bigint | null {
  let text: string;
  if (typeof value === 'string') text = value.trim();
  // Un nombre n'est accepté que s'il est un entier sûr : jamais de flottant.
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) text = String(value);
  else return null;
  if (!DECIMAL_RE.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * MONEY_SCALE + BigInt(fraction.padEnd(2, '0'));
}

/** Centièmes → chaîne décimale à deux décimales, format attendu par SasPay. */
export function formatDecimal(scaled: bigint): string {
  if (scaled < 0n) throw new RangeError('negative_amount');
  const whole = scaled / MONEY_SCALE;
  const fraction = (scaled % MONEY_SCALE).toString().padStart(2, '0');
  return `${whole.toString()}.${fraction}`;
}

/** Normalise une chaîne décimale (« 5000 » → « 5000.00 »). `null` si invalide. */
export function normalizeDecimal(value: unknown): string | null {
  const scaled = parseDecimal(value);
  return scaled === null ? null : formatDecimal(scaled);
}

/** Égalité stricte de deux montants décimaux. Faux si l'un des deux est invalide. */
export function decimalEquals(a: unknown, b: unknown): boolean {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  return left !== null && right !== null && left === right;
}

export type FeeChargeMode = 'ADD_ON' | 'DEDUCTED';

/** Palier tarifaire tel que renvoyé par `GET /pricing/my-rates/`. */
export interface RateTier {
  min_amount?: unknown;
  max_amount?: unknown;
  currency?: unknown;
  percent?: unknown;
  fixed?: unknown;
  floor_amount?: unknown;
  cap_amount?: unknown;
  fee_charge_mode?: unknown;
}

export interface FeeQuote {
  /** Frais estimés (chaîne décimale). */
  fee: string;
  /** Qui supporte les frais selon la configuration du compte SasPay. */
  mode: FeeChargeMode;
  /** Montant que le client paiera réellement. */
  total: string;
  /** Montant que le marchand recevra. */
  net: string;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** Sélectionne le palier applicable à un montant (bornes incluses, `null` = ouverte). */
export function selectTier(amount: string, tiers: RateTier[]): RateTier | null {
  const value = parseDecimal(amount);
  if (value === null) return null;
  for (const tier of tiers) {
    const min = tier.min_amount === null || tier.min_amount === undefined ? null : parseDecimal(tier.min_amount);
    const max = tier.max_amount === null || tier.max_amount === undefined ? null : parseDecimal(tier.max_amount);
    if (min !== null && value < min) continue;
    if (max !== null && value > max) continue;
    return tier;
  }
  return null;
}

/**
 * Estime les frais d'un paiement à partir d'un palier du compte.
 *
 * Les frais ne sont JAMAIS ajoutés au montant envoyé à SasPay : le prix du
 * produit est transmis tel quel et SasPay applique ses frais une seule fois,
 * selon le mode du compte. Cette estimation sert uniquement à l'affichage ; les
 * frais définitifs sont ceux renvoyés par la vérification du paiement.
 */
export function quoteFee(amount: string, tier: RateTier | null): FeeQuote | null {
  const value = parseDecimal(amount);
  if (value === null || !tier) return null;
  const mode = tier.fee_charge_mode === 'ADD_ON' || tier.fee_charge_mode === 'DEDUCTED' ? tier.fee_charge_mode : null;
  if (!mode) return null;
  const percent = tier.percent === null || tier.percent === undefined ? 0n : parseDecimal(tier.percent);
  const fixed = tier.fixed === null || tier.fixed === undefined ? 0n : parseDecimal(tier.fixed);
  if (percent === null || fixed === null) return null;
  // percent est en centièmes de pour-cent : fee = amount × percent / 100 / 100.
  let fee = ceilDiv(value * percent, 100n * MONEY_SCALE) + fixed;
  const floor = tier.floor_amount === null || tier.floor_amount === undefined ? null : parseDecimal(tier.floor_amount);
  const cap = tier.cap_amount === null || tier.cap_amount === undefined ? null : parseDecimal(tier.cap_amount);
  if (floor !== null && fee < floor) fee = floor;
  if (cap !== null && fee > cap) fee = cap;
  if (mode === 'DEDUCTED' && fee > value) return null;
  return {
    fee: formatDecimal(fee),
    mode,
    total: formatDecimal(mode === 'ADD_ON' ? value + fee : value),
    net: formatDecimal(mode === 'ADD_ON' ? value : value - fee),
  };
}
