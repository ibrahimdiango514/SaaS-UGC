/**
 * Tarification du Studio : calcul serveur, paliers dégressifs, isolation
 * stricte vis-à-vis de Business Grow, et absence de tout calcul client.
 *
 * Ces tests sont statiques (lecture de source) ou unitaires sur les fonctions
 * pures du moteur : aucun appel réseau, aucun crédit consommé.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertPackLadder, calculateVideoCredits, packPricePerCredit, type StudioPack,
} from '../supabase/functions/reelora-video/index';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const CONFIG = {
  usd_to_xof: 620,
  credit_value_xof: 100,
  markup_percent: 60,
  additional_cost_usd: 0.01,
};

describe('Calcul serveur des crédits Studio', () => {
  it('applique coût fournisseur × change × marge ÷ valeur du crédit', () => {
    // (0.10 + 0.01) × 620 × 1.6 = 109.12 XOF → 2 crédits à 100 XOF
    expect(calculateVideoCredits(0.10, CONFIG)).toBe(2);
    // (1.00 + 0.01) × 620 × 1.6 = 1002.0 XOF → 11 crédits
    expect(calculateVideoCredits(1.00, CONFIG)).toBe(11);
  });

  it('arrondit vers le haut et ne rend jamais 0 crédit', () => {
    // (0.0001 + 0.01) × 620 × 1.6 = 10.01 → 1 crédit (jamais gratuit)
    expect(calculateVideoCredits(0.0001, CONFIG)).toBe(1);
  });

  it('refuse de deviner quand un paramètre est inconnu', () => {
    expect(calculateVideoCredits(0.5, { ...CONFIG, usd_to_xof: null })).toBeNull();
    expect(calculateVideoCredits(0.5, { ...CONFIG, credit_value_xof: null })).toBeNull();
    expect(calculateVideoCredits(0.5, { ...CONFIG, markup_percent: null })).toBeNull();
    expect(calculateVideoCredits(0.5, { ...CONFIG, additional_cost_usd: null })).toBeNull();
    expect(calculateVideoCredits(0.5, { ...CONFIG, credit_value_xof: 0 })).toBeNull();
    expect(calculateVideoCredits(0, CONFIG)).toBeNull();
    expect(calculateVideoCredits(Number.NaN, CONFIG)).toBeNull();
  });

  it('intègre les coûts de traitement complémentaires', () => {
    const base = calculateVideoCredits(0.5, CONFIG)!;
    const withExtras = calculateVideoCredits(0.5, CONFIG, [0.2, 0.1])!;
    expect(withExtras).toBeGreaterThan(base);
    // Un coût annexe inconnu ou négatif bloque le calcul.
    expect(calculateVideoCredits(0.5, CONFIG, [Number.NaN])).toBeNull();
    expect(calculateVideoCredits(0.5, CONFIG, [-1])).toBeNull();
  });

  it('durée et résolution influencent le coût via le devis fournisseur', () => {
    // Le serveur reçoit un coût fournisseur qui dépend déjà de ces paramètres :
    // une opération deux fois plus chère coûte deux fois plus de crédits.
    const short = calculateVideoCredits(0.25, CONFIG)!;
    const long = calculateVideoCredits(0.50, CONFIG)!;
    expect(long).toBeGreaterThan(short);
  });
});

describe('Grille des packs Studio', () => {
  const packs: StudioPack[] = [
    { pack_key: 'creator', label: 'Creator', price_xof: 5000, credits: 27 },
    { pack_key: 'pro_creator', label: 'Pro Creator', price_xof: 15000, credits: 95 },
    { pack_key: 'studio_business', label: 'Studio Business', price_xof: 35000, credits: 265 },
  ];

  it('conserve les trois prix commerciaux validés', () => {
    expect(packs.map((p) => p.price_xof)).toEqual([5000, 15000, 35000]);
  });

  it('fait baisser le prix du crédit quand le pack grandit', () => {
    const units = packs.map((p) => packPricePerCredit(p)!);
    expect(units[0]).toBeGreaterThan(units[1]);
    expect(units[1]).toBeGreaterThan(units[2]);
    expect(assertPackLadder(packs)).toBeNull();
  });

  it('détecte une grille non dégressive', () => {
    const broken: StudioPack[] = [
      { pack_key: 'a', label: 'A', price_xof: 5000, credits: 50 },
      { pack_key: 'b', label: 'B', price_xof: 15000, credits: 60 },
    ];
    expect(assertPackLadder(broken)).toBe('pack_ladder_not_degressive');
  });

  it('rejette des valeurs de pack invalides', () => {
    expect(packPricePerCredit({ price_xof: 0, credits: 10 })).toBeNull();
    expect(packPricePerCredit({ price_xof: 1000, credits: 0 })).toBeNull();
  });
});

describe('Le navigateur ne fixe jamais le prix', () => {
  const clientFiles = [
    'src/pages/StudioPricing.tsx',
    'src/studio/GenerationStudio.tsx',
    'src/studio/components/PromptBar.tsx',
    'src/studio/components/CostConfirm.tsx',
  ];

  it('aucune surface client n’envoie un montant de crédits calculé localement', () => {
    for (const file of clientFiles) {
      const source = read(file);
      // Aucun appel ne fixe le coût : le client ne peut transmettre que la
      // valeur déjà renvoyée par le serveur (`estimate`), jamais un calcul local.
      expect(source).not.toMatch(/p_credits_cost\s*:/);
      expect(source).not.toMatch(/credits_cost\s*:\s*\d/);
      expect(source).not.toMatch(/credits_cost\s*:\s*Math\./);
      expect(source).not.toMatch(/credits_cost\s*:\s*[a-zA-Z_]+\s*\*/);
    }
  });

  it('le seul renvoi de coût est l’écho du devis serveur, contrôlé en base', () => {
    const studio = read('src/studio/GenerationStudio.tsx');
    expect(studio).toContain('credits_cost: estimate.credits_cost');
    // Le serveur compare l'écho du devis avec les crédits réellement réservés.
    const gateway = read('supabase/functions/reelora-video/index.ts');
    expect(gateway).toContain('Number(quote.credits_cost) !== Number(job.credits_reserved)');
  });

  it('l’achat de pack n’envoie qu’une clé, jamais un prix', () => {
    const pricing = read('src/pages/StudioPricing.tsx');
    expect(pricing).toContain("rpc<{ credits?: number; price_xof?: number; status?: string }>('studio_purchase_pack'");
    expect(pricing).toContain('p_pack_key: pack.pack_key');
    expect(pricing).not.toMatch(/p_price_xof/);
    expect(pricing).not.toMatch(/p_credits/);
  });

  it('les prix affichés viennent de la grille serveur, pas d’une constante locale', () => {
    const pricing = read('src/pages/StudioPricing.tsx');
    expect(pricing).toContain("rpc<Partial<CreditGrid>>('studio_credit_grid')");
    expect(pricing).not.toMatch(/price_xof:\s*5000/);
    expect(pricing).not.toMatch(/price_xof:\s*15000/);
    expect(pricing).not.toMatch(/price_xof:\s*35000/);
  });
});

describe('Isolation Studio ↔ Business Grow', () => {
  it('la migration tarifaire ne touche que saas_ugc', () => {
    const sql = read('supabase/migrations/20261112040000_studio_credit_grid.sql');
    const statements = sql
      .split('\n')
      .filter((line) => /^\s*(create|insert|alter|update|delete|grant|revoke|drop)\b/i.test(line));
    for (const statement of statements) {
      expect(statement).not.toMatch(/saas_business/);
    }
  });

  it('aucun portefeuille partagé : tables distinctes', () => {
    const sql = read('supabase/migrations/20261112040000_studio_credit_grid.sql');
    expect(sql).toContain('saas_ugc.ugc_credit_purchases');
    expect(sql).toContain('saas_ugc.ugc_credit_ledger');
    expect(sql).not.toContain('saas_business.wallets');
    expect(sql).not.toContain('saas_business.credit_ledger');
  });

  it('la marge Studio n’est pas la marge de Business Grow', () => {
    const sql = read('supabase/migrations/20261112040000_studio_credit_grid.sql');
    expect(sql).toContain('target_margin_percent');
    // L'objectif de marge de 95 % appartient à Business Grow.
    expect(sql).not.toMatch(/'target_margin_percent',\s*95/);
  });

  it('le calcul Studio n’est pas importé par le code Business Grow', () => {
    const businessFiles = readdirSync(join(process.cwd(), 'src/business'), { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'));
    for (const file of businessFiles) {
      const source = read(`src/business/${file}`);
      expect(source).not.toContain('calculateVideoCredits');
      expect(source).not.toContain('studio_credit_grid');
      expect(source).not.toContain('studio_purchase_pack');
    }
  });
});

describe('Migration : garde-fous serveur', () => {
  const sql = read('supabase/migrations/20261112040000_studio_credit_grid.sql');

  it('réserve les RPC sensibles aux rôles authentifiés', () => {
    expect(sql).toContain('revoke all on function public.studio_purchase_pack(text, text, text) from public, anon');
    expect(sql).toContain('grant execute on function public.studio_purchase_pack(text, text, text) to authenticated');
    expect(sql).toContain('revoke all on function public.studio_admin_set_credit_grid(jsonb) from public, anon');
    expect(sql).toContain('perform ugc_private.reelora_assert_admin()');
  });

  it('refuse une grille incohérente et journalise le changement', () => {
    expect(sql).toContain("raise exception 'studio_pricing_not_configured'");
    expect(sql).toContain("raise exception 'invalid_pack_values'");
    expect(sql).toContain("'set_studio_credit_grid'");
  });

  it('fige le prix et les crédits au moment de l’achat', () => {
    expect(sql).toContain('config_updated_at timestamptz not null');
    expect(sql).toContain('price_per_credit_xof');
    expect(sql).toContain('credits_granted');
  });

  it('ne simule aucun paiement : la commande reste en attente', () => {
    expect(sql).toContain("'status', 'pending'");
    expect(sql).not.toContain("'paid'");
  });
});
