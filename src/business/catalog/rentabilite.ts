/**
 * Rentabilité et fuites — fonctionnalité 5.
 *
 * Calcule la marge RÉELLE par produit, à partir de trois sources déjà en base :
 *  - le coût d'achat du produit (`catalog.model.cost`) ;
 *  - les remises et taxes réelles des lignes de vente (`sales.model.SalesLine`) ;
 *  - les dépenses récurrentes en doublon (`cash`).
 *
 * Honnêteté du calcul, et c'est tout l'enjeu :
 *  - **un produit sans coût n'a pas de marge** : on affiche « coût inconnu », on
 *    n'invente pas un taux. C'est la fuite la plus fréquente dans ce genre
 *    d'écran, alors elle est rendue visible et comptée à part ;
 *  - une vente à perte est signalée seulement si le coût EST connu ;
 *  - les revenus sont nets de remise et hors taxes (la taxe n'appartient pas à
 *    l'entreprise) ;
 *  - deux devises ne sont jamais mélangées.
 */

import type { Product } from './model';
import type { Invoice } from '../sales/model';

export interface MargeProduit {
  productId: string;
  nom: string;
  sku: string;
  /** Quantité réellement vendue sur la période analysée. */
  quantiteVendue: number;
  /** Chiffre d'affaires hors taxes et net de remise. */
  revenu: number;
  /** Coût des marchandises vendues, `null` si le coût unitaire est inconnu. */
  cout: number | null;
  /** Marge en valeur, `null` si le coût est inconnu. */
  marge: number | null;
  /** Taux de marge en %, `null` si le coût est inconnu ou le revenu nul. */
  tauxMarge: number | null;
  /** Vrai seulement si le coût est connu ET la marge négative. */
  venteAPerte: boolean;
}

export interface RapportRentabilite {
  devise: string;
  produits: MargeProduit[];
  /** Produits vendus dont le coût manque : marge non calculable. */
  produitsSansCout: string[];
  /** Nombre de ventes à perte détectées. */
  ventesAPerte: number;
  /** Revenu total des lignes analysées. */
  revenuTotal: number;
  /** Marge totale des seules lignes à coût connu. */
  margeTotale: number;
  /** Part du revenu pour laquelle la marge est calculable, en %. */
  couvertureCout: number;
}

/** Prix de vente unitaire net de remise, hors taxe. */
function netUnitaire(ligne: { unitPrice: number; discountPct: number; taxPct: number }): number {
  const remise = Math.min(100, Math.max(0, ligne.discountPct)) / 100;
  const taxe = Math.min(100, Math.max(0, ligne.taxPct)) / 100;
  // `unitPrice` est exprimé TTC boutique : on retire la taxe, puis la remise.
  return (ligne.unitPrice / (1 + taxe)) * (1 - remise);
}

export interface LigneVendue {
  productId: string;
  quantite: number;
  prixUnitaire: number;
  remisePct: number;
  taxePct: number;
}

/**
 * Extrait les lignes réellement facturées.
 *
 * Sont exclues : les factures en brouillon, annulées, et les factures en
 * devise différente de celle analysée. Une facture en brouillon n'est pas une
 * vente — la compter gonflerait artificiellement le chiffre.
 */
export function lignesFacturees(factures: readonly Invoice[], devise: string): LigneVendue[] {
  const lignes: LigneVendue[] = [];
  for (const facture of factures) {
    if (facture.status === 'brouillon' || facture.status === 'annulee') continue;
    if (facture.currency.toUpperCase() !== devise.toUpperCase()) continue;
    for (const ligne of facture.lines) {
      if (!ligne.productId || ligne.quantity <= 0) continue;
      lignes.push({
        productId: ligne.productId,
        quantite: ligne.quantity,
        prixUnitaire: ligne.unitPrice,
        remisePct: ligne.discountPct,
        taxePct: ligne.taxPct,
      });
    }
  }
  return lignes;
}

export function rapportRentabilite(
  produits: readonly Product[],
  lignes: readonly LigneVendue[],
  devise = 'XOF',
): RapportRentabilite {
  const produitParId = new Map(produits.map((produit) => [produit.id, produit]));
  const agrégats = new Map<string, { quantite: number; revenu: number }>();

  for (const ligne of lignes) {
    const existant = agrégats.get(ligne.productId) ?? { quantite: 0, revenu: 0 };
    existant.quantite += ligne.quantite;
    existant.revenu += netUnitaire({
      unitPrice: ligne.prixUnitaire, discountPct: ligne.remisePct, taxPct: ligne.taxePct,
    }) * ligne.quantite;
    agrégats.set(ligne.productId, existant);
  }

  const resultats: MargeProduit[] = [];
  const sansCout: string[] = [];
  let revenuTotal = 0;
  let revenuCouvert = 0;
  let margeTotale = 0;
  let ventesAPerte = 0;

  for (const [productId, agrégat] of agrégats) {
    const produit = produitParId.get(productId);
    const nom = produit?.name ?? 'Produit supprimé du catalogue';
    const sku = produit?.sku ?? '';
    // Sans produit au catalogue, le coût est inconnu — jamais supposé nul.
    const coutUnitaire = produit?.cost ?? null;
    const revenu = arrondi(agrégat.revenu);
    revenuTotal += revenu;

    if (coutUnitaire === null) {
      sansCout.push(nom);
      resultats.push({
        productId, nom, sku, quantiteVendue: agrégat.quantite, revenu,
        cout: null, marge: null, tauxMarge: null, venteAPerte: false,
      });
      continue;
    }

    const cout = arrondi(coutUnitaire * agrégat.quantite);
    const marge = arrondi(revenu - cout);
    revenuCouvert += revenu;
    margeTotale += marge;
    if (marge < 0) ventesAPerte += 1;

    resultats.push({
      productId, nom, sku, quantiteVendue: agrégat.quantite, revenu, cout, marge,
      tauxMarge: revenu > 0 ? Math.round((marge / revenu) * 1000) / 10 : null,
      venteAPerte: marge < 0,
    });
  }

  resultats.sort((a, b) => (b.marge ?? Number.NEGATIVE_INFINITY) - (a.marge ?? Number.NEGATIVE_INFINITY));

  return {
    devise,
    produits: resultats,
    produitsSansCout: sansCout,
    ventesAPerte,
    revenuTotal: arrondi(revenuTotal),
    margeTotale: arrondi(margeTotale),
    couvertureCout: revenuTotal > 0 ? Math.round((revenuCouvert / revenuTotal) * 1000) / 10 : 0,
  };
}

export interface Fuite {
  type: 'produit_sans_cout' | 'vente_a_perte' | 'abonnement_doublon';
  label: string;
  detail: string;
  /** Montant concerné, `null` quand il n'est pas chiffrable. */
  montant: number | null;
}

export interface DepenseRecurrente {
  id: string;
  label: string;
  amount: number;
  recurrence: 'aucune' | 'mensuelle' | 'trimestrielle' | 'annuelle';
  status: 'engagee' | 'payee' | 'annulee';
}

/**
 * Doublons de dépenses récurrentes.
 *
 * Deux abonnements au même libellé et à la même fréquence sont très
 * probablement le même service. On SIGNALE la ressemblance, on n'affirme pas le
 * doublon : l'utilisateur seul sait s'il a deux lignes mobiles.
 */
export function abonnementsEnDoublon(depenses: readonly DepenseRecurrente[]): Array<{
  cle: string;
  libelles: string[];
  montantMensuelEstime: number;
}> {
  const groupes = new Map<string, DepenseRecurrente[]>();
  for (const depense of depenses) {
    if (depense.recurrence === 'aucune' || depense.status === 'annulee') continue;
    const cle = normaliser(depense.label);
    if (!cle) continue;
    groupes.set(cle, [...(groupes.get(cle) ?? []), depense]);
  }

  const doublons: Array<{ cle: string; libelles: string[]; montantMensuelEstime: number }> = [];
  for (const [cle, liste] of groupes) {
    if (liste.length < 2) continue;
    const montantMensuelEstime = liste.reduce((somme, depense) => somme + mensualiser(depense), 0);
    doublons.push({ cle, libelles: liste.map((d) => d.label), montantMensuelEstime: arrondi(montantMensuelEstime) });
  }
  return doublons;
}

/**
 * Fuites détectées, classées par chiffrabilité : ce qui a un montant d'abord.
 * Une fuite non chiffrée reste listée — c'est souvent la plus grosse.
 */
export function fuitesDetectees(rapport: RapportRentabilite, depenses: readonly DepenseRecurrente[]): Fuite[] {
  const fuites: Fuite[] = [];

  for (const produit of rapport.produits.filter((p) => p.venteAPerte)) {
    fuites.push({
      type: 'vente_a_perte',
      label: `${produit.nom} vendu à perte`,
      detail: `${produit.quantiteVendue} unité(s) · revenu ${montant(produit.revenu, rapport.devise)} · coût ${montant(produit.cout ?? 0, rapport.devise)}`,
      montant: produit.marge,
    });
  }

  if (rapport.produitsSansCout.length > 0) {
    fuites.push({
      type: 'produit_sans_cout',
      label: `${rapport.produitsSansCout.length} produit(s) vendu(s) sans coût d’achat connu`,
      detail: `Marge non calculable sur ${100 - rapport.couvertureCout} % du chiffre d’affaires. Renseignez le coût dans le catalogue.`,
      montant: null,
    });
  }

  for (const doublon of abonnementsEnDoublon(depenses)) {
    fuites.push({
      type: 'abonnement_doublon',
      label: `Dépense récurrente peut-être en double : ${doublon.libelles[0]}`,
      detail: `${doublon.libelles.length} lignes au même libellé · ${montant(doublon.montantMensuelEstime, rapport.devise)} par mois. À vérifier : seul vous savez s’il s’agit du même service.`,
      montant: -doublon.montantMensuelEstime,
    });
  }

  return fuites.sort((a, b) => {
    if (a.montant === null && b.montant === null) return 0;
    if (a.montant === null) return 1;
    if (b.montant === null) return -1;
    return a.montant - b.montant; // les pertes les plus lourdes d'abord
  });
}

function mensualiser(depense: DepenseRecurrente): number {
  switch (depense.recurrence) {
    case 'mensuelle': return depense.amount;
    case 'trimestrielle': return depense.amount / 3;
    case 'annuelle': return depense.amount / 12;
    default: return 0;
  }
}

function normaliser(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function arrondi(valeur: number): number {
  return Math.round(valeur * 100) / 100;
}

function montant(valeur: number, devise: string): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(valeur)} ${devise}`;
}
