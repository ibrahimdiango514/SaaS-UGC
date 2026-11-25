/**
 * SORAHNEX — section « Variantes » d'une fiche produit.
 *
 * ## Ce que cette section est, et n'est pas
 * Les variantes sont des déclinaisons de LEUR produit parent. Cette section ne
 * crée donc jamais de produit : elle ajoute, modifie et retire des options sous
 * un parent existant. Un produit à trois tailles reste UN produit.
 *
 * ## Lecture seule
 * Quand l'abonnement a expiré, le catalogue reste consultable : le tableau
 * s'affiche, les boutons d'écriture sont désactivés, et une phrase explique
 * pourquoi. Le serveur refuserait de toute façon (42501) — l'interface évite
 * seulement de proposer une action vouée à l'échec.
 *
 * ## Désactiver plutôt que supprimer
 * « Retirer » sort la variante de la vente en conservant sa référence et son
 * stock. Elle reste visible, grisée, avec un bouton pour la remettre en vente :
 * une taille saisonnière ne doit pas être à ressaisir chaque année.
 */
import { useEffect, useMemo, useState } from 'react';
import { Ban, Check, Loader2, Pencil, Plus, RotateCcw, X } from 'lucide-react';
import { Button, cn } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { formatGrowthAmount } from '../growth/model';
import {
  EMPTY_VARIANT, formFromVariant, validateVariantForm, variantPriceLabel, variantStockLabel,
  type ProductVariant, type VariantForm,
} from './variants-model';
import { createVariant, setVariantActive, updateVariant } from './variants';

export interface ProductVariantsSectionProps {
  productId: string;
  productName: string;
  productPrice: number | null;
  productCurrency: string | null;
  variants: ProductVariant[];
  /** Vrai quand l'abonnement est expiré : la lecture reste, l'écriture non. */
  readOnly: boolean;
  /** Recharge le catalogue après une écriture réussie. */
  onChanged: () => void | Promise<void>;
}

export function ProductVariantsSection({
  productId, productName, productPrice, productCurrency, variants, readOnly, onChanged,
}: ProductVariantsSectionProps) {
  const toast = useToast();
  const [ouverts, setOuverts] = useState(true);
  const [édition, setÉdition] = useState<ProductVariant | null>(null);
  const [création, setCréation] = useState(false);
  const [form, setForm] = useState<VariantForm>(EMPTY_VARIANT);
  const [enregistrement, setEnregistrement] = useState(false);
  const [enCours, setEnCours] = useState<string | null>(null);

  // L'ordre reçu du serveur est conservé ; on ne retrie pas par nom, sinon
  // « S, M, L » deviendrait « L, M, S ».
  const triées = useMemo(
    () => [...variants].sort((a, b) => a.position - b.position),
    [variants],
  );

  useEffect(() => {
    // Une variante ajoutée depuis l'extérieur doit ouvrir la section : sans
    // cela, elle resterait invisible jusqu'au prochain clic.
    if (variants.length > 0) setOuverts(true);
  }, [variants.length]);

  // Un produit sans variante n'a rien à replier : masquer la section cacherait
  // justement l'explication « aucune variante » et le bouton d'ajout.
  const dépliable = triées.length > 0;

  const démarrerCréation = () => {
    setForm({ ...EMPTY_VARIANT, currency: productCurrency ?? '' });
    setÉdition(null);
    setCréation(true);
  };

  const démarrerÉdition = (variante: ProductVariant) => {
    setForm(formFromVariant(variante));
    setÉdition(variante);
    setCréation(false);
  };

  const fermerFormulaire = () => {
    setCréation(false);
    setÉdition(null);
    setForm(EMPTY_VARIANT);
  };

  const enregistrer = async () => {
    const validation = validateVariantForm(form);
    if (!validation.ok) {
      toast.warning(validation.error);
      return;
    }
    setEnregistrement(true);
    try {
      if (édition) {
        await updateVariant(édition.id, validation.payload);
        toast.success('Variante mise à jour.');
      } else {
        await createVariant(productId, validation.payload);
        toast.success('Variante ajoutée.');
      }
      fermerFormulaire();
      await onChanged();
    } catch (erreur) {
      // Les codes de la base sont traduits : « DUPLICATE_OPTION » est un cas
      // courant (deux fois « M »), pas une panne.
      const message = asAppError(erreur).message;
      toast.error(
        /DUPLICATE_OPTION/.test(message)
          ? 'Cette option existe déjà pour ce produit.'
          : /SUBSCRIPTION|42501/.test(message)
            ? 'Abonnement Business Grow inactif : les variantes ne peuvent pas être modifiées.'
            : message,
      );
    } finally {
      setEnregistrement(false);
    }
  };

  const basculer = async (variante: ProductVariant) => {
    setEnCours(variante.id);
    try {
      await setVariantActive(variante.id, !variante.active);
      toast.success(variante.active ? 'Variante retirée de la vente.' : 'Variante remise en vente.');
      await onChanged();
    } catch (erreur) {
      toast.error(asAppError(erreur).message);
    } finally {
      setEnCours(null);
    }
  };

  const actives = triées.filter((v) => v.active).length;

  return (
    <section className="mt-3 rounded-xl border border-white/[0.07] bg-black/20" data-testid={`variants-${productId}`}>
      <div className="flex items-center gap-2 px-3 py-2">
      <button
        type="button"
        onClick={() => { if (dépliable) setOuverts((v) => !v); }}
        className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
        aria-expanded={ouverts}
        disabled={!dépliable}
      >
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
          Variantes
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] text-slate-400">
            {actives} active{actives > 1 ? 's' : ''}
            {triées.length > actives ? ` · ${triées.length - actives} retirée${triées.length - actives > 1 ? 's' : ''}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-[10px] text-slate-500">
          {dépliable ? (ouverts ? 'Masquer' : 'Afficher') : ''}
        </span>
      </button>
      {/* Section repliée sur un produit sans variante : sans ce bouton, ajouter
          la première taille demanderait de deviner qu'il faut déplier. */}
      {dépliable && !ouverts && !readOnly && (
        <button
          type="button"
          onClick={() => { setOuverts(true); démarrerCréation(); }}
          className="shrink-0 rounded border border-cyan-300/25 px-1.5 py-0.5 text-[9px] font-medium text-cyan-100 transition hover:border-cyan-300/45"
          data-testid={`variant-add-${productId}`}
        >
          Ajouter
        </button>
      )}
      </div>

      {ouverts && (
        <div className="border-t border-white/[0.06] px-3 py-2.5">
          {readOnly && (
            <p className="mb-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-2 py-1.5 text-[10px] text-amber-100">
              Lecture seule : votre abonnement Business Grow a expiré. Les variantes restent
              consultables, mais ne peuvent plus être modifiées.
            </p>
          )}

          {triées.length === 0 ? (
            <p className="text-[10px] text-slate-500">
              Aucune variante. Ajoutez des tailles, couleurs ou pointures — elles resteront
              rattachées à « {productName} », sans créer de produit séparé.
            </p>
          ) : (
            <div className="vy-scroll overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-[10px]" data-testid={`variants-table-${productId}`}>
                <thead>
                  <tr className="text-left text-[9px] uppercase tracking-wide text-slate-500">
                    <th className="py-1 pr-2 font-medium">Option</th>
                    <th className="py-1 pr-2 font-medium">Réf.</th>
                    <th className="py-1 pr-2 font-medium">Prix</th>
                    <th className="py-1 pr-2 font-medium">Stock</th>
                    <th className="py-1 pr-2 font-medium">État</th>
                    <th className="py-1 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {triées.map((variante) => (
                    <tr
                      key={variante.id}
                      className={cn(
                        'border-t border-white/[0.05]',
                        // Une variante retirée est lisible mais atténuée : elle
                        // reste dans le tableau, elle n'est simplement plus vendue.
                        variante.active ? 'text-slate-200' : 'text-slate-500',
                      )}
                      data-testid={`variant-row-${variante.id}`}
                      data-active={variante.active ? 'true' : 'false'}
                    >
                      <td className="py-1.5 pr-2">
                        {variante.attribute_name && (
                          <span className="mr-1 text-slate-500">{variante.attribute_name}</span>
                        )}
                        <span className="font-medium">{variante.attribute_value}</span>
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-[9px] text-slate-400">{variante.sku ?? '—'}</td>
                      <td className="py-1.5 pr-2">
                        {variantPriceLabel(variante, productPrice, productCurrency, formatGrowthAmount)}
                      </td>
                      <td className="py-1.5 pr-2">{variantStockLabel(variante)}</td>
                      <td className="py-1.5 pr-2">
                        {variante.active ? (
                          <span className="text-emerald-300">En vente</span>
                        ) : (
                          <span className="text-slate-500">Retirée</span>
                        )}
                      </td>
                      <td className="py-1.5 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            disabled={readOnly || enCours === variante.id}
                            onClick={() => démarrerÉdition(variante)}
                            aria-label={`Modifier ${variante.attribute_value}`}
                            className="rounded p-1 text-slate-400 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            type="button"
                            disabled={readOnly || enCours === variante.id}
                            onClick={() => void basculer(variante)}
                            aria-label={variante.active ? `Retirer ${variante.attribute_value}` : `Remettre ${variante.attribute_value}`}
                            className="rounded p-1 text-slate-400 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {enCours === variante.id
                              ? <Loader2 size={11} className="animate-spin" />
                              : variante.active ? <Ban size={11} /> : <RotateCcw size={11} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!readOnly && !création && !édition && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              icon={<Plus size={11} />}
              onClick={démarrerCréation}
              data-testid={`variant-add-${productId}`}
            >
              Ajouter une variante
            </Button>
          )}

          {(création || édition) && (
            <div className="mt-2 rounded-lg border border-cyan-300/20 bg-cyan-400/[0.04] p-2.5" data-testid="variant-form">
              <p className="text-[10px] font-semibold text-cyan-100">
                {édition ? `Modifier « ${édition.attribute_value} »` : 'Nouvelle variante'}
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="text-[9px] text-slate-400">
                  Critère (facultatif)
                  <input
                    value={form.attributeName}
                    onChange={(e) => setForm({ ...form, attributeName: e.target.value })}
                    placeholder="Taille, Couleur…"
                    className="mt-0.5 w-full rounded border border-white/[0.09] bg-black/30 px-2 py-1 text-[10px] text-slate-200 focus:border-cyan-300/40 focus:outline-none"
                    data-testid="variant-attribute-name"
                  />
                </label>
                <label className="text-[9px] text-slate-400">
                  Option *
                  <input
                    value={form.attributeValue}
                    onChange={(e) => setForm({ ...form, attributeValue: e.target.value })}
                    placeholder="M, 43, Rouge…"
                    className="mt-0.5 w-full rounded border border-white/[0.09] bg-black/30 px-2 py-1 text-[10px] text-slate-200 focus:border-cyan-300/40 focus:outline-none"
                    data-testid="variant-attribute-value"
                  />
                </label>
                <label className="text-[9px] text-slate-400">
                  Référence (SKU)
                  <input
                    value={form.sku}
                    onChange={(e) => setForm({ ...form, sku: e.target.value })}
                    className="mt-0.5 w-full rounded border border-white/[0.09] bg-black/30 px-2 py-1 font-mono text-[10px] text-slate-200 focus:border-cyan-300/40 focus:outline-none"
                    data-testid="variant-sku"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[9px] text-slate-400">
                    Prix
                    <input
                      value={form.price}
                      onChange={(e) => setForm({ ...form, price: e.target.value })}
                      inputMode="decimal"
                      placeholder="vide = prix du produit"
                      className="mt-0.5 w-full rounded border border-white/[0.09] bg-black/30 px-2 py-1 text-[10px] text-slate-200 focus:border-cyan-300/40 focus:outline-none"
                      data-testid="variant-price"
                    />
                  </label>
                  <label className="text-[9px] text-slate-400">
                    Devise
                    <input
                      value={form.currency}
                      onChange={(e) => setForm({ ...form, currency: e.target.value })}
                      maxLength={3}
                      placeholder={productCurrency ?? 'XOF'}
                      className="mt-0.5 w-full rounded border border-white/[0.09] bg-black/30 px-2 py-1 text-[10px] uppercase text-slate-200 focus:border-cyan-300/40 focus:outline-none"
                      data-testid="variant-currency"
                    />
                  </label>
                </div>
                <label className="text-[9px] text-slate-400">
                  Stock
                  <input
                    value={form.stock}
                    onChange={(e) => setForm({ ...form, stock: e.target.value })}
                    inputMode="numeric"
                    className="mt-0.5 w-full rounded border border-white/[0.09] bg-black/30 px-2 py-1 text-[10px] text-slate-200 focus:border-cyan-300/40 focus:outline-none"
                    data-testid="variant-stock"
                  />
                </label>
              </div>
              <p className="mt-1.5 text-[9px] text-slate-500">
                Un prix laissé vide signifie « même prix que le produit », jamais « gratuit ».
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  loading={enregistrement}
                  onClick={() => void enregistrer()}
                  icon={<Check size={11} />}
                  data-testid="variant-save"
                >
                  {édition ? 'Enregistrer' : 'Ajouter'}
                </Button>
                <Button size="sm" variant="ghost" onClick={fermerFormulaire} icon={<X size={11} />}>
                  Annuler
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
