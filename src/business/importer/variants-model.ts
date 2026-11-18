/**
 * Variantes d'un produit — modèle pur (lecture, validation, mise en forme).
 *
 * ## Principe
 * Une variante appartient à SON produit : elle n'est jamais transformée en
 * produit indépendant. Ce module ne crée donc aucun produit.
 *
 * ## Désactiver plutôt que supprimer
 * Retirer une taille de la vente ne doit pas effacer son stock ni sa référence :
 * la ligne reste, seule sa mise en vente change.
 *
 * ## Aucun réseau
 * Ce module n'importe rien qui touche au réseau, ce qui permet à `lib/api.ts` de
 * l'utiliser sans créer de cycle d'import. Les appels sont dans `variants.ts`.
 */
import type { ProductVariant } from '../../lib/types';

export type { ProductVariant };

function texte(valeur: unknown): string | null {
  return typeof valeur === 'string' && valeur.trim() !== '' ? valeur : null;
}

function nombreOuNull(valeur: unknown): number | null {
  if (valeur === null || valeur === undefined || valeur === '') return null;
  const n = Number(valeur);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lit une variante telle que la RPC la renvoie.
 *
 * `priceAmount` reste `null` quand il n'y a pas de prix propre : le convertir en
 * 0 afficherait « gratuit » sur une variante qui hérite simplement du prix du
 * parent.
 */
/** Variante telle qu'un écran la manipule : le type de ligne, garanti complet. */
export type NormalizedVariant = ProductVariant;

export function normalizeVariant(raw: unknown, productId = ''): NormalizedVariant | null {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = texte(source.id);
  const valeur = texte(source.attribute_value);
  if (!id || !valeur) return null;

  return {
    id,
    product_id: texte(source.product_id) ?? productId,
    attribute_name: texte(source.attribute_name),
    attribute_value: valeur,
    sku: texte(source.sku),
    price_amount: nombreOuNull(source.price_amount),
    price_currency: texte(source.price_currency),
    stock: nombreOuNull(source.stock),
    available: typeof source.available === 'boolean' ? source.available : null,
    // Absent = actif : une variante importée avant l'ajout de la colonne ne doit
    // pas disparaître de l'affichage.
    active: source.active !== false,
    position: nombreOuNull(source.position) ?? 0,
  };
}

/** Lit la liste de variantes d'un produit, en conservant l'ordre reçu. */
export function normalizeVariants(raw: unknown, productId = ''): NormalizedVariant[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entree) => normalizeVariant(entree, productId))
    .filter((variante): variante is NormalizedVariant => variante !== null)
    .sort((a, b) => a.position - b.position);
}

/* ------------------------------- formulaire -------------------------------- */

export interface VariantForm {
  attributeName: string;
  attributeValue: string;
  sku: string;
  price: string;
  currency: string;
  stock: string;
}

export const EMPTY_VARIANT: VariantForm = {
  attributeName: '', attributeValue: '', sku: '', price: '', currency: '', stock: '',
};

export function formFromVariant(variante: ProductVariant): VariantForm {
  return {
    attributeName: variante.attribute_name ?? '',
    attributeValue: variante.attribute_value,
    sku: variante.sku ?? '',
    price: variante.price_amount === null ? '' : String(variante.price_amount),
    currency: variante.price_currency ?? '',
    stock: variante.stock === null ? '' : String(variante.stock),
  };
}

export interface VariantPayload {
  attribute_name: string | null;
  attribute_value: string;
  sku: string | null;
  price_amount: number | null;
  price_currency: string | null;
  stock: number | null;
}

export type VariantValidation =
  | { ok: true; payload: VariantPayload }
  | { ok: false; error: string };

/**
 * Valide et convertit le formulaire.
 *
 * ## Ce que la validation refuse, et pourquoi
 * - une option vide : une variante sans nom ne s'affiche pas et ne se vend pas ;
 * - un prix négatif : ce n'est pas un prix ;
 * - un stock négatif ou décimal : le stock est un entier d'unités ;
 * - une devise qui n'a pas trois lettres : la contrainte de la base la
 *   rejetterait, autant le dire avant l'appel.
 *
 * Le serveur revérifie tout : cette validation sert à éviter un aller-retour,
 * pas à protéger quoi que ce soit.
 */
export function validateVariantForm(form: VariantForm): VariantValidation {
  const valeur = form.attributeValue.trim();
  if (!valeur) return { ok: false, error: 'Le nom de l’option est obligatoire (ex. « M », « 43 »).' };
  if (valeur.length > 120) return { ok: false, error: 'Le nom de l’option ne peut pas dépasser 120 caractères.' };

  const critere = form.attributeName.trim();
  if (critere.length > 60) return { ok: false, error: 'Le nom du critère ne peut pas dépasser 60 caractères.' };

  let prix: number | null = null;
  if (form.price.trim() !== '') {
    const valeurPrix = Number(form.price.replace(',', '.'));
    if (!Number.isFinite(valeurPrix)) return { ok: false, error: 'Prix invalide.' };
    if (valeurPrix < 0) return { ok: false, error: 'Le prix ne peut pas être négatif.' };
    prix = valeurPrix;
  }

  const devise = form.currency.trim().toUpperCase();
  if (devise !== '' && !/^[A-Z]{3}$/.test(devise)) {
    return { ok: false, error: 'La devise doit comporter trois lettres (ex. XOF, EUR).' };
  }

  let stock: number | null = null;
  if (form.stock.trim() !== '') {
    const valeurStock = Number(form.stock);
    if (!Number.isFinite(valeurStock)) return { ok: false, error: 'Stock invalide.' };
    if (valeurStock < 0) return { ok: false, error: 'Le stock ne peut pas être négatif.' };
    if (!Number.isInteger(valeurStock)) return { ok: false, error: 'Le stock doit être un nombre entier d’unités.' };
    stock = valeurStock;
  }

  return {
    ok: true,
    payload: {
      attribute_name: critere || null,
      attribute_value: valeur,
      sku: form.sku.trim() || null,
      price_amount: prix,
      price_currency: devise || null,
      stock,
    },
  };
}

/* ------------------------------- affichage -------------------------------- */

/**
 * Prix affiché d'une variante.
 *
 * Un prix absent n'est PAS « 0 » : il signifie que la variante suit le prix du
 * parent. On le dit en toutes lettres, avec le montant du parent quand il est
 * connu.
 */
export function variantPriceLabel(
  variante: ProductVariant,
  parentPrice: number | null,
  parentCurrency: string | null,
  format: (montant: number, devise: string) => string,
): string {
  if (variante.price_amount !== null) {
    return format(variante.price_amount, variante.price_currency ?? parentCurrency ?? '');
  }
  if (parentPrice !== null) {
    return `Prix du produit : ${format(parentPrice, parentCurrency ?? '')}`;
  }
  return 'Prix à compléter';
}

/** Stock affiché : `null` = inconnu, jamais « 0 ». */
export function variantStockLabel(variante: ProductVariant): string {
  if (variante.stock === null) return '—';
  if (variante.stock === 0) return 'Rupture';
  return String(variante.stock);
}
