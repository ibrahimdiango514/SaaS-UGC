/**
 * Variantes d'un produit — appels serveur.
 *
 * Les RPC vérifient en base l'appartenance à l'espace de travail ET
 * l'abonnement. Ce module ne calcule aucun droit : il transmet, puis relit la
 * réponse avec le modèle pur de `variants-model.ts`.
 */
import { rpc } from '../../lib/api';
import { normalizeVariant } from './variants-model';
import type { ProductVariant, VariantPayload } from './variants-model';

export type { VariantPayload } from './variants-model';

/* --------------------------------- appels --------------------------------- */

/** Ajoute une variante à un produit existant. */
export async function createVariant(productId: string, payload: VariantPayload): Promise<ProductVariant> {
  const raw = await rpc<unknown>('vyora_ugc_variant_create', {
    p_product_id: productId,
    p_attribute_value: payload.attribute_value,
    p_attribute_name: payload.attribute_name,
    p_sku: payload.sku,
    p_price_amount: payload.price_amount,
    p_price_currency: payload.price_currency,
    p_stock: payload.stock,
  });
  const variante = normalizeVariant(raw, productId);
  if (!variante) throw new Error('La variante n’a pas pu être créée.');
  return variante;
}

/**
 * Met à jour une variante.
 *
 * `null` est une valeur voulue sur le prix : elle signifie « revenir au prix du
 * parent ». Le composant ne doit donc pas la remplacer par l'ancienne valeur.
 */
export async function updateVariant(variantId: string, payload: VariantPayload): Promise<ProductVariant> {
  const raw = await rpc<unknown>('vyora_ugc_variant_update', {
    p_variant_id: variantId,
    p_attribute_value: payload.attribute_value,
    p_sku: payload.sku,
    p_price_amount: payload.price_amount,
    p_price_currency: payload.price_currency,
    p_stock: payload.stock,
  });
  const variante = normalizeVariant(raw);
  if (!variante) throw new Error('La variante n’a pas pu être mise à jour.');
  return variante;
}

/** Retire la variante de la vente (ou la remet), sans effacer la ligne. */
export async function setVariantActive(variantId: string, active: boolean): Promise<boolean> {
  const raw = await rpc<unknown>('vyora_ugc_variant_set_active', {
    p_variant_id: variantId,
    p_active: active,
  });
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return source.active === true;
}

