/**
 * VYORA — tarifs lus en base, jamais écrits dans le composant.
 *
 * ## La règle
 *
 * Un prix affiché doit venir de la base. Un prix en dur dans un `.tsx` est un
 * prix qui finit par diverger de ce que le client paie réellement — et un écart
 * de prix est le pire litige commercial qui existe.
 *
 * ## Le cas « tarif de lancement »
 *
 * Les plans Starter / Professional / Business sont créés sans prix définitif
 * (`prix_minor = 0`). Le champ `libelle_prix` porte alors « Tarif de lancement ».
 * L'interface doit l'afficher **tel quel** : pas de « 0 FCFA », pas de
 * « Bientôt », pas de faux prix barré. On dit la vérité : le prix n'est pas
 * encore fixé, et on propose de découvrir l'offre.
 *
 * ## Conversion des crédits — explication demandée
 *
 * L'ancien réglage disait : 27 crédits pour 5 000 XOF, alors que 1 crédit
 * vaut 100 XOF. 27 × 100 = 2 700 XOF de valeur pour 5 000 XOF payés : la
 * différence (2 300 XOF, soit 46 %) n'est pas un rabais, c'est la **marge de la
 * plateforme** sur le coût fournisseur. La grille a donc été mal libellée :
 * elle présente comme un « pack de crédits » ce qui est en réalité un prix de
 * vente avec marge intégrée.
 *
 * Ici, on expose les deux nombres séparément — ce que le client paie, et ce que
 * les crédits valent en production — pour que l'écran de crédits puisse le dire
 * honnêtement (exigence 3.6).
 */

import { supabase } from '../lib/supabase';

export interface TarifPlan {
  planKey: string;
  nom: string;
  sousTitre: string | null;
  /** Prix en unité mineure (XOF = centimes). 0 = pas encore défini. */
  prixMinor: number;
  devise: string;
  /** Texte à afficher si le prix n'est pas défini (« Tarif de lancement »). */
  libellePrix: string | null;
  credits: number | null;
  videosMax: number | null;
  univers: 'business' | 'studio';
  /** Points d'offre, dérivés des limites réelles — jamais inventés. */
  points: string[];
  recommande: boolean;
}

/** Formate un montant mineur en FCFA lisible. 5000 XOF = 500000 mineur. */
export function formaterFcfa(prixMinor: number): string {
  // En XOF, la plus petite unité vaut 1/100 de franc : on arrondit au franc.
  const francs = Math.round(prixMinor / 100);
  return `${francs.toLocaleString('fr-FR')} FCFA`;
}

/**
 * Dérive les points d'offre depuis les limites réelles.
 * Un point ne s'affiche que si la donnée existe : pas de « 500 prospects » si
 * la base ne le dit pas.
 */
function pointsDepuisLimites(pe: {
  max_prospects: number | null;
  max_clients: number | null;
  max_produits: number | null;
  max_emails_mois: number | null;
  max_audits_mois: number | null;
  max_analyses_image_mois: number | null;
  ai_units_mois: number | null;
  max_stockage_mo: number | null;
}): string[] {
  const p: string[] = [];
  const n = (v: number) => v.toLocaleString('fr-FR');
  if (pe.max_prospects !== null) p.push(`${n(pe.max_prospects)} prospects`);
  else p.push('Prospects sans limite');
  if (pe.max_clients !== null) p.push(`${n(pe.max_clients)} clients`);
  if (pe.max_produits !== null) p.push(`${n(pe.max_produits)} produits`);
  if (pe.max_emails_mois !== null) p.push(`${n(pe.max_emails_mois)} relances e-mail / mois`);
  if (pe.max_audits_mois !== null) p.push(`${n(pe.max_audits_mois)} audits de boutique / mois`);
  if (pe.max_analyses_image_mois !== null) p.push(`${n(pe.max_analyses_image_mois)} lectures de documents / mois`);
  if (pe.ai_units_mois !== null) p.push(`${n(pe.ai_units_mois)} actions d’assistant / mois`);
  if (pe.max_stockage_mo !== null)
    p.push(pe.max_stockage_mo >= 1024 ? `${n(Math.round(pe.max_stockage_mo / 1024))} Go de stockage` : `${n(pe.max_stockage_mo)} Mo de stockage`);
  return p;
}

/**
 * Charge les plans d'un univers. En cas d'échec réseau, renvoie un tableau vide :
 * la section tarifs disparaît plutôt que d'afficher des prix inventés.
 */
export async function chargerTarifs(univers: 'business' | 'studio'): Promise<TarifPlan[]> {
  const { data, error } = await supabase
    .from('plan_entitlements')
    .select('*')
    .eq('actif', true)
    .in('univers', [univers, 'commun'])
    .order('sort_order');
  if (error || !data) return [];

  const rows = data as Array<Record<string, unknown>>;
  const plans = rows
    .filter((r) => r.univers === univers && r.plan_key !== 'free')
    .map((r) => {
      const planKey = String(r.plan_key);
      const nom = planKey
        .replace(/_business$|_studio$/, '')
        .replace(/^starter$/, 'Starter')
        .replace(/^professional$/, 'Professional')
        .replace(/^business$/, 'Business')
        .replace(/^essential$/, 'Essential')
        .replace(/^studio$/, 'Studio')
        .replace(/^pro$/, 'Pro');
      return {
        planKey,
        nom: nom.charAt(0).toUpperCase() + nom.slice(1),
        sousTitre: null as string | null,
        prixMinor: Number(r.prix_minor ?? 0),
        devise: String(r.devise ?? 'XOF'),
        libellePrix: (r.libelle_prix as string | null) ?? null,
        credits: null as number | null,
        videosMax: null as number | null,
        univers,
        points: pointsDepuisLimites(r as never),
        recommande: false,
      };
    });

  // Le plan du milieu est mis en avant : c'est le choix le plus souvent retenu,
  // et le placer au centre réduit l'hésitation. Choix assumé, pas une donnée.
  if (plans.length === 3) plans[1].recommande = true;
  return plans;
}

/**
 * Grille de crédits Studio, lue dans `ugc_app_settings.studio_pricing_config`.
 * Sert à expliquer la conversion sans mentir sur la marge.
 */
export interface GrilleCredits {
  valeurCreditXof: number;
  usdToXof: number;
  margeCible: number;
  packs: Array<{ nom: string; credits: number; prixXof: number; recommande: boolean }>;
}

export async function chargerGrilleCredits(): Promise<GrilleCredits | null> {
  const { data, error } = await supabase
    .from('ugc_app_settings')
    .select('setting_value')
    .eq('setting_key', 'studio_pricing_config')
    .maybeSingle();
  if (error || !data) return null;
  const v = data.setting_value as Record<string, unknown> | null;
  if (!v) return null;
  const packsBruts = (v.packs as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    valeurCreditXof: Number(v.credit_value_xof ?? 100),
    usdToXof: Number(v.usd_to_xof ?? 620),
    margeCible: Number(v.target_margin_pct ?? 0.6),
    packs: packsBruts.map((p) => ({
      nom: String(p.name ?? p.nom ?? 'Pack'),
      credits: Number(p.credits ?? 0),
      prixXof: Number(p.price_xof ?? p.prix_xof ?? 0),
      recommande: Boolean(p.recommended ?? p.recommande ?? false),
    })),
  };
}

/**
 * Explique la conversion crédits → francs.
 *
 * Exemple concret avec les chiffres réels : 27 crédits, 1 crédit = 100 XOF,
 * donc 2 700 XOF de valeur de production, vendus 5 000 XOF. Le client paie
 * 2 300 XOF de plus que la valeur nominale des crédits — cet écart couvre le
 * coût fournisseur réel et la marge cible de 60 %.
 */
export function expliquerConversion(pack: { credits: number; prixXof: number }, valeurCreditXof: number) {
  const valeurNominale = pack.credits * valeurCreditXof;
  const ecart = pack.prixXof - valeurNominale;
  return {
    valeurNominale,
    ecart,
    ecartPct: pack.prixXof > 0 ? Math.round((ecart / pack.prixXof) * 100) : 0,
    /** Vrai si le pack se présente comme un rabais alors qu'il coûte plus cher. */
    trompeur: ecart > 0,
  };
}
