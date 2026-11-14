// Tarification : provision, couverture des frais, arrondis, rapprochement.
// Les vecteurs sont ceux du banc SQL (`supabase/tests/saspay/pricing.mjs`) : le
// calcul TypeScript et le calcul en base doivent donner les mêmes résultats.
import { describe, expect, it } from 'vitest';
import vectors from '../supabase/tests/saspay/pricing-vectors.json';
import {
  feeAmount, quotePayout, quotePrice, reconcile, roundUp, PricingError,
  type FeeLine, type PricingPolicy,
} from '../supabase/functions/_shared/saspay/pricing';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const DAY = 86_400_000;

interface VectorLine {
  type: string; country: string | null; network: string | null; min: number; max: number | null;
  percent_milli: number; fixed: number; floor: number | null; cap: number | null; fee_base: string;
  from_days: number; until_days: number | null;
}
const big = (value: number | null) => (value === null ? null : BigInt(value));

function toLine(line: VectorLine, index: number): FeeLine {
  return {
    id: `line-${String(index).padStart(3, '0')}`,
    transaction_type: line.type as FeeLine['transaction_type'],
    country_code: line.country, currency: 'XOF', network_code: line.network,
    min_amount_cents: BigInt(line.min), max_amount_cents: big(line.max),
    percent_milli: BigInt(line.percent_milli), fixed_cents: BigInt(line.fixed),
    floor_fee_cents: big(line.floor), cap_fee_cents: big(line.cap),
    fee_base: line.fee_base as FeeLine['fee_base'],
    valid_from: NOW + line.from_days * DAY,
    valid_until: line.until_days === null ? null : NOW + line.until_days * DAY,
    created_at: NOW + index,
  };
}
function toPolicy(p: { enabled: boolean; strategy: string; provision: number; step: number }): PricingPolicy {
  return {
    enabled: p.enabled, strategy: p.strategy as PricingPolicy['strategy'],
    currencies: { XOF: { provision_cents: BigInt(p.provision), rounding_step_cents: BigInt(p.step) } },
  };
}
const POLICY: PricingPolicy = toPolicy({ enabled: true, strategy: 'cover_fees', provision: 100_000, step: 100 });
const line = (over: Partial<FeeLine> = {}): FeeLine => ({
  id: 'l1', transaction_type: 'payin', country_code: 'ML', currency: 'XOF', network_code: null,
  min_amount_cents: 0n, max_amount_cents: null, percent_milli: 0n, fixed_cents: 0n,
  floor_fee_cents: null, cap_fee_cents: null, fee_base: 'total', valid_from: NOW - DAY, valid_until: null,
  created_at: NOW - DAY, ...over,
});
const quote = (base: bigint, lines: FeeLine[], over: Partial<Parameters<typeof quotePrice>[0]> = {}) => quotePrice({
  policy: POLICY, lines, baseCents: base, currency: 'XOF', country: 'ML', network: null, networks: null, at: NOW, ...over,
});

describe('vecteurs communs avec la base', () => {
  for (const vector of vectors.vectors) {
    it(vector.name, () => {
      const result = quotePrice({
        policy: toPolicy(vector.policy),
        lines: (vector.lines as VectorLine[]).map(toLine),
        baseCents: BigInt(vector.base), currency: 'XOF', country: vector.country,
        network: vector.network,
        networks: vector.flows.includes('checkout') ? null : (vector.country === 'ML' ? vector.configured : []),
        at: NOW,
      });
      expect(result.final_cents).toBe(BigInt(vector.expect.final));
      expect(result.estimated_fee_cents).toBe(big(vector.expect.fee));
      expect(result.expected_net_cents).toBe(big(vector.expect.net));
      expect(result.expected_margin_cents).toBe(big(vector.expect.margin));
      expect(result.pricing_fee_cents).toBe(big(vector.expect.pricing_fee));
      expect(result.tariff_status).toBe(vector.expect.status);
      expect(result.base_cents).toBe(BigInt(vector.base));
      expect(result.surcharge_cents).toBe(result.final_cents - result.base_cents);
    });
  }
});

describe('frais d’un palier', () => {
  it('arrondit la part proportionnelle au centième supérieur, jamais en dessous', () => {
    expect(feeAmount(1n, line({ percent_milli: 1n }))).toBe(1n);               // 0,00001 centième → 1
    expect(feeAmount(100_000n, line({ percent_milli: 2500n }))).toBe(2500n);   // 1 000 × 2,5 % = 25
    expect(feeAmount(10_252_500n, line({ percent_milli: 2500n }))).toBe(256_313n);
    expect(feeAmount(0n, line({ percent_milli: 2500n, fixed_cents: 300n }))).toBe(300n);
  });
  it('applique le minimum puis le maximum', () => {
    expect(feeAmount(100_000n, line({ percent_milli: 1000n, floor_fee_cents: 5000n }))).toBe(5000n);
    expect(feeAmount(100_000_000n, line({ percent_milli: 5000n, cap_fee_cents: 80_000n }))).toBe(80_000n);
  });
  it('arrondit un prix au pas supérieur', () => {
    expect(roundUp(600_000n, 100n)).toBe(600_000n);
    expect(roundUp(600_001n, 100n)).toBe(600_100n);
    expect(roundUp(1_309_500n, 2500n)).toBe(1_310_000n);
  });
});

describe('net commercial préservé quand les frais sont connus', () => {
  // Générateur déterministe : mêmes cas à chaque exécution.
  let seed = 20261113;
  const next = (max: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; };

  it('le prix final est le plus petit qui respecte la provision et le net (1 500 tirages)', () => {
    for (let i = 0; i < 1500; i += 1) {
      const base = BigInt(500 + next(400_000)) * 100n;                       // 500 à 400 500 FCFA
      const step = [100n, 500n, 2500n, 10_000n][next(4)];
      const provision = BigInt(next(3) * 500) * 100n;                        // 0, 500 ou 1 000 FCFA
      const tariff = line({
        percent_milli: BigInt(next(8000)),                                   // 0 à 7,999 %
        fixed_cents: BigInt(next(4) * 5000),                                 // 0 à 150 FCFA
        floor_fee_cents: next(3) === 0 ? BigInt(next(2000) * 100) : null,
        cap_fee_cents: null,
      });
      const policy: PricingPolicy = {
        enabled: true, strategy: 'cover_fees', currencies: { XOF: { provision_cents: provision, rounding_step_cents: step } },
      };
      const result = quotePrice({
        policy, lines: [tariff], baseCents: base, currency: 'XOF', country: 'ML', network: null, networks: null, at: NOW,
      });
      const ok = (p: bigint) => p >= base + provision && p - feeAmount(p, tariff) >= base;
      expect(ok(result.final_cents)).toBe(true);
      expect(result.final_cents % step).toBe(0n);
      // Minimalité : le palier juste en dessous ne convient pas.
      expect(ok(result.final_cents - step)).toBe(false);
      expect(result.expected_net_cents! >= base).toBe(true);
    }
  });

  it('avec un maximum de frais, le net reste préservé', () => {
    for (let i = 0; i < 300; i += 1) {
      const base = BigInt(1000 + next(900_000)) * 100n;
      const tariff = line({ percent_milli: BigInt(1000 + next(6000)), cap_fee_cents: BigInt(500 + next(5000)) * 100n });
      const result = quote(base, [tariff]);
      expect(result.expected_net_cents! >= base).toBe(true);
      expect(result.final_cents >= base + 100_000n).toBe(true);
    }
  });

  it('plusieurs opérateurs : le net est préservé pour chacun, au même prix', () => {
    const lines = [
      line({ id: 'a', network_code: 'orange_ml', percent_milli: 1500n }),
      line({ id: 'b', network_code: 'moov_ml', percent_milli: 3500n, fixed_cents: 5000n }),
      line({ id: 'c', network_code: 'wave_sn', country_code: 'SN', percent_milli: 9000n }),
    ];
    const base = 7_500_000n;
    const price = quote(base, lines, { networks: ['orange_ml', 'moov_ml'] }).final_cents;
    for (const network of ['orange_ml', 'moov_ml']) {
      const result = quote(base, lines, { network, networks: ['orange_ml', 'moov_ml'] });
      expect(result.final_cents).toBe(price);
      expect(result.expected_net_cents! >= base).toBe(true);
    }
  });
});

describe('garde-fous', () => {
  it('refuse un prix de base nul ou négatif', () => {
    expect(() => quote(0n, [])).toThrow(PricingError);
    expect(() => quote(-100n, [])).toThrow('pricing_invalid_base');
  });
  it('refuse une devise sans provision paramétrée plutôt que d’en inventer une', () => {
    expect(() => quote(500_000n, [], { currency: 'XAF' })).toThrow('pricing_currency_not_configured');
  });
  it('ne mélange pas les devises ni les sens', () => {
    const lines = [line({ currency: 'XAF', percent_milli: 9000n }), line({ transaction_type: 'payout', percent_milli: 9000n })];
    expect(quote(500_000n, lines).estimated_fee_cents).toBeNull();
  });
  it('converge même à 50 % de frais', () => {
    const result = quote(1_000_000n, [line({ percent_milli: 50_000n })]);
    expect(result.final_cents).toBe(2_000_000n);
    expect(result.expected_net_cents).toBe(1_000_000n);
  });
});

describe('décaissements (payouts)', () => {
  it('estime les frais sans provision ni relèvement', () => {
    const lines = [
      line({ id: 'in', percent_milli: 2500n }),
      line({ id: 'out', transaction_type: 'payout', percent_milli: 1800n, cap_fee_cents: 500_000n }),
    ];
    expect(quotePayout(lines, 10_000_000n, 'XOF', 'ML', 'orange_ml', NOW)).toEqual({
      amount_cents: 10_000_000n, provision_cents: 0n, estimated_fee_cents: 180_000n, tariff_status: 'confirmed',
    });
    expect(quotePayout(lines, 100_000_000n, 'XOF', 'ML', null, NOW).estimated_fee_cents).toBe(500_000n);
  });
  it('signale l’absence de tarif de décaissement', () => {
    expect(quotePayout([line({ percent_milli: 2500n })], 10_000_000n, 'XOF', 'ML', null, NOW)).toMatchObject({
      estimated_fee_cents: null, tariff_status: 'missing', provision_cents: 0n,
    });
  });
});

describe('rapprochement après confirmation', () => {
  const quoted = quote(500_000n, [line({ percent_milli: 1000n })]); // 6 000 FCFA, frais estimés 60

  it('frais réels égaux à l’estimation', () => {
    expect(reconcile(quoted, 600_000n, { chargedCents: 600_000n, netCents: 594_000n, feeMode: 'DEDUCTED' })).toEqual({
      charged_cents: 600_000n, actual_fee_cents: 6000n, actual_net_cents: 594_000n, fee_variance_cents: 0n,
      margin_cents: 94_000n, provision_covers_fee: true, flags: [],
    });
  });
  it('frais réels supérieurs à l’estimation mais sous la provision', () => {
    const result = reconcile(quoted, 600_000n, { chargedCents: 600_000n, netCents: 560_000n, feeMode: 'DEDUCTED' });
    expect(result).toMatchObject({ actual_fee_cents: 40_000n, fee_variance_cents: 34_000n, margin_cents: 60_000n, provision_covers_fee: true, flags: [] });
  });
  it('frais réels égaux à la provision : couverte, marge nulle', () => {
    const result = reconcile(quoted, 600_000n, { chargedCents: 600_000n, netCents: 500_000n, feeMode: 'DEDUCTED' });
    expect(result).toMatchObject({ actual_fee_cents: 100_000n, margin_cents: 0n, provision_covers_fee: true, flags: [] });
  });
  it('frais réels supérieurs à la provision : alerte, net sous le prix de base', () => {
    const result = reconcile(quoted, 600_000n, { chargedCents: 600_000n, netCents: 480_000n, feeMode: 'DEDUCTED' });
    expect(result).toMatchObject({ actual_fee_cents: 120_000n, margin_cents: -20_000n, provision_covers_fee: false });
    expect(result.flags).toEqual(['fee_exceeds_provision', 'net_below_base']);
  });
  it('prix relevé au devis : les frais dépassent 1 000 FCFA mais sont couverts par le prix, aucune alerte', () => {
    const lifted = quote(10_000_000n, [line({ percent_milli: 2500n })]);
    const result = reconcile(lifted, lifted.final_cents, { chargedCents: 10_256_500n, netCents: 10_000_087n, feeMode: 'DEDUCTED' });
    expect(result).toMatchObject({ actual_fee_cents: 256_413n, fee_variance_cents: 0n, margin_cents: 87n, provision_covers_fee: true });
    expect(result.flags).toEqual([]);
    // Les mêmes frais, un centime de plus que ce que le prix couvre : alerte.
    const over = reconcile(lifted, lifted.final_cents, { chargedCents: 10_256_500n, netCents: 9_999_999n, feeMode: 'DEDUCTED' });
    expect(over).toMatchObject({ actual_fee_cents: 256_501n, margin_cents: -1n, provision_covers_fee: false });
    expect(over.flags).toEqual(['fee_exceeds_provision', 'net_below_base']);
  });
  it('frais ajoutés au client alors que le prix était tout compris', () => {
    const result = reconcile(quoted, 600_000n, { chargedCents: 606_000n, netCents: 600_000n, feeMode: 'ADD_ON' });
    expect(result.flags).toEqual(['fee_mode_unexpected']);
    expect(result).toMatchObject({ actual_fee_cents: 6000n, margin_cents: 100_000n });
  });
  it('frais non restitués : inconnus, jamais supposés', () => {
    const result = reconcile(quoted, 600_000n, { chargedCents: null, netCents: null, feeMode: null });
    expect(result).toMatchObject({ charged_cents: 600_000n, actual_fee_cents: null, actual_net_cents: null, margin_cents: null, fee_variance_cents: null, provision_covers_fee: null });
    expect(result.flags).toEqual(['charged_assumed', 'fee_unknown']);
  });
  it('sans tarif : pas d’écart calculable, mais la marge réelle l’est', () => {
    const noTariff = quote(500_000n, []);
    const result = reconcile(noTariff, 600_000n, { chargedCents: 600_000n, netCents: 585_000n, feeMode: 'DEDUCTED' });
    expect(result).toMatchObject({ actual_fee_cents: 15_000n, fee_variance_cents: null, margin_cents: 85_000n, provision_covers_fee: true });
    expect(result.flags).toEqual(['tariff_missing']);
  });
  it('commande antérieure à la politique : aucune alerte de provision', () => {
    const result = reconcile(null, 500_000n, { chargedCents: 500_000n, netCents: 485_000n, feeMode: 'DEDUCTED' });
    expect(result.flags).toEqual(['legacy_pricing', 'net_below_base']);
    expect(result.provision_covers_fee).toBeNull();
  });
});
