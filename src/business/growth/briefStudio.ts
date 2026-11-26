/**
 * « Du chiffre à la vidéo » — construire un brief Studio UGC depuis les vrais
 * chiffres de l'entreprise.
 *
 * ## La règle d'argent
 * Rien n'est généré ici. Ce module produit un TEXTE de brief et l'état de
 * navigation attendu par Studio. Aucun appel à un fournisseur vidéo, aucun
 * débit : la génération reste dans Studio, où le devis est affiché avant toute
 * dépense. Un brief n'engage donc jamais de crédit.
 *
 * ## D'où viennent les chiffres
 * Uniquement de données présentes : produits réellement vendus, montants
 * réellement facturés, meilleure marge connue. Quand une donnée manque, le
 * brief le dit — il ne comble pas avec une estimation.
 */
import type { Invoice } from '../sales/model';
import type { Product } from '../catalog/model';
import { lignesFacturees, rapportRentabilite } from '../catalog/rentabilite';

export interface ChiffreCle {
  produit: string;
  /** Quantité réellement facturée (hors devis et commandes non facturées). */
  quantite: number;
  /** Chiffre d'affaires généré par ce produit. `null` si un prix manque. */
  chiffreAffaires: number | null;
  /** Marge connue, `null` si le coût d'achat n'est pas renseigné. */
  marge: number | null;
  devise: string;
}

/**
 * Classe les produits par ce qu'ils rapportent réellement.
 *
 * On réutilise `rapportRentabilite` : les lignes sont rattachées au CATALOGUE
 * (`productId`), pas au texte libre d'une désignation. Chercher par nom aurait
 * donné une marge fausse dès qu'une désignation est reformulée — exactement le
 * genre d'erreur qui finit dans une vidéo.
 *
 * Seules les factures comptent : une commande non facturée n'est pas encore du
 * chiffre d'affaires. Brouillons et annulées sont exclus par `lignesFacturees`.
 */
export function chiffresParProduit(
  invoices: readonly Invoice[],
  produits: readonly Product[],
): ChiffreCle[] {
  const devise = invoices.find((facture) => facture.currency)?.currency ?? '';
  if (!devise) return [];
  const rapport = rapportRentabilite(produits, lignesFacturees(invoices, devise), devise);
  return rapport.produits
    .filter((produit) => produit.quantiteVendue > 0)
    .sort((a, b) => b.revenu - a.revenu)
    .map((produit) => ({
      produit: produit.nom,
      quantite: produit.quantiteVendue,
      chiffreAffaires: Number.isFinite(produit.revenu) ? produit.revenu : null,
      // La marge reste `null` quand le coût d'achat est inconnu : afficher une
      // marge de 100 % serait un mensonge comptable.
      marge: produit.marge,
      devise,
    }));
}

export interface BriefStudio {
  /** État de navigation déjà au bon format pour Studio. */
  state: { ugcBrief: Record<string, unknown> };
  /** Texte du brief, lisible et modifiable par l'utilisateur. */
  texte: string;
  /** Chiffres réellement utilisés, pour que l'utilisateur puisse vérifier. */
  sources: string[];
  /** Ce qui manque, affiché avant d'ouvrir Studio. */
  manques: string[];
  /** Vrai si aucun chiffre ne permet de construire un brief honnête. */
  vide: boolean;
}

/**
 * Construit le brief.
 *
 * `produit` peut être une chaîne libre (saisie) ; sinon on prend le produit qui
 * rapporte le plus, avec sa quantité réelle. Le brief ne promet jamais un
 * résultat (« +30 % de ventes ») : il décrit ce qui est vendu et pourquoi.
 */
export function construireBriefStudio(input: {
  invoices: readonly Invoice[];
  produits: readonly Product[];
  nomEntreprise: string;
  /** Produit choisi par l'utilisateur ; vide = le plus vendu. */
  produitChoisi?: string;
  /** Angle choisi par l'utilisateur ; vide = proposition neutre. */
  angleChoisi?: string;
  /** Cible choisie par l'utilisateur ; vide = laissée à préciser. */
  cible?: string;
}): BriefStudio {
  const chiffres = chiffresParProduit(input.invoices, input.produits);
  const choisi = (input.produitChoisi ?? '').trim();
  const meilleur = choisi
    ? chiffres.find((chiffre) => chiffre.produit.toLowerCase() === choisi.toLowerCase())
      ?? { produit: choisi, quantite: 0, chiffreAffaires: null, marge: null, devise: '' }
    : chiffres[0];

  const sources: string[] = [];
  const manques: string[] = [];

  if (!meilleur) {
    return {
      state: { ugcBrief: {} },
      texte: '',
      sources,
      manques: ['Aucune facture ne permet d’identifier un produit à mettre en avant. Choisissez un produit manuellement.'],
      vide: true,
    };
  }

  const devise = meilleur.devise || input.invoices[0]?.currency || '';
  const montant = (valeur: number | null): string => {
    if (valeur === null || !Number.isFinite(valeur)) return '';
    try {
      return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(valeur) + (devise ? ` ${devise}` : '');
    } catch {
      return String(valeur);
    }
  };

  if (meilleur.quantite > 0) sources.push(`${meilleur.quantite} unité(s) facturée(s) de « ${meilleur.produit} »`);
  if (meilleur.chiffreAffaires !== null) sources.push(`${montant(meilleur.chiffreAffaires)} facturés sur ce produit`);
  if (meilleur.quantite === 0) manques.push('Ce produit n’apparaît dans aucune facture : les chiffres du brief restent à confirmer.');
  if (meilleur.chiffreAffaires === null) manques.push('Aucun chiffre d’affaires calculable pour ce produit (prix absent des lignes facturées).');
  if (meilleur.marge === null) manques.push('Coût d’achat inconnu : la marge n’est pas affichée.');

  const angleParDefaut = meilleur.quantite > 0
    ? `Montrer pourquoi « ${meilleur.produit} » est le produit le plus vendu, sans promesse de résultat chiffré.`
    : `Présenter « ${meilleur.produit} » à partir de son usage réel, sans chiffre inventé.`;
  const angle = (input.angleChoisi ?? '').trim() || angleParDefaut;

  const hook = meilleur.quantite > 0
    ? `« ${meilleur.produit} » : ce que nos clients achètent le plus`
    : `« ${meilleur.produit} » : à quoi ça sert vraiment`;

  const resume = [
    `${input.nomEntreprise || 'Notre entreprise'} met en avant « ${meilleur.produit} ».`,
    meilleur.quantite > 0 ? `Produit réellement facturé ${meilleur.quantite} fois.` : '',
    'Aucun chiffre de résultat n’est promis dans la vidéo.',
  ].filter(Boolean).join(' ');

  const brief = {
    product: meilleur.produit,
    productName: meilleur.produit,
    angle,
    hook,
    targetAudience: (input.cible ?? '').trim(),
    summary: resume,
    cta: 'Découvrir le produit',
    brandName: input.nomEntreprise || undefined,
    // Champs acceptés par `normalizeUgcHandoffBrief` : on reste dans le contrat
    // existant, on n'invente pas un second format de brief.
    source: 'business_grow',
  };

  const texte = [
    `Brief vidéo — ${meilleur.produit}`,
    '',
    `Produit : ${meilleur.produit}`,
    `Accroche : ${hook}`,
    `Angle : ${angle}`,
    input.cible?.trim() ? `Cible : ${input.cible.trim()}` : '',
    `Résumé : ${resume}`,
    sources.length > 0 ? `Chiffres utilisés : ${sources.join(' · ')}` : '',
    manques.length > 0 ? `À vérifier : ${manques.join(' · ')}` : '',
    '',
    'La génération se fait dans Studio, après affichage du devis. Rien n’est débité depuis Grow.',
  ].filter((ligne) => ligne !== '' || true).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return { state: { ugcBrief: brief }, texte, sources, manques, vide: false };
}
