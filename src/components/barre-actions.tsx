import type { ReactNode } from 'react';
import { useGrandEcran } from '../lib/media-query';
import { cn } from './ui';

/**
 * Barre d'action d'écran, adaptée au pouce.
 *
 * ## Le défaut corrigé
 * Les actions principales (`Nouveau contact`, `Nouveau devis`, `Ajouter une
 * dépense`…) étaient regroupées dans `PageHeader`, qui les empile SOUS un titre
 * de 24 px et une description de deux ou trois lignes. Sur un téléphone, le
 * bouton de création se retrouvait hors de l'écran initial : il fallait faire
 * défiler pour créer un élément, alors que c'est l'action la plus fréquente.
 *
 * ## La règle appliquée
 * - Téléphone : une barre collante sous l'en-tête, action principale à pleine
 *   largeur (56 px de haut, atteignable au pouce), actions secondaires derrière
 *   une feuille « Autres actions » qui n'obstrue jamais l'écran.
 * - ≥ 640 px : les actions reviennent en ligne, à droite du titre, comme avant.
 *
 * Le titre et la description restent inchangés : aucune information n'est
 * perdue, seule la position de l'action change.
 */
export function BarreActions({
  principale,
  secondaires = [],
  libelleSecondaires = 'Autres actions',
}: {
  /** Action principale : elle prend toute la largeur sur téléphone. */
  principale?: ReactNode;
  /** Actions secondaires, regroupées sur téléphone. */
  secondaires?: ReactNode[];
  /** Libellé du repli mobile. */
  libelleSecondaires?: string;
}) {
  // Une seule variante est montée : deux boutons identiques dans le DOM
  // seraient annoncés deux fois par les lecteurs d'écran et rendraient les
  // sélecteurs de test ambigus.
  const grandEcran = useGrandEcran();
  if (!principale && secondaires.length === 0) return null;

  return (
    <div
      data-testid="barre-actions"
      className={cn(
        // Collant : l'action reste accessible quand on fait défiler une liste.
        'sticky top-0 z-20 -mx-4 mb-4 border-b border-white/[0.06] bg-[#05080e]/92 px-4 py-2.5',
        'backdrop-blur-xl sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none',
      )}
    >
      <div className="flex items-stretch gap-2">
        {principale && <div className="flex-1 [&>*]:w-full sm:flex-none sm:[&>*]:w-auto">{principale}</div>}
        {secondaires.length > 0 && (
          <>
            {/* Téléphone : un seul bouton lisible qui déplie les autres. */}
            {!grandEcran && (
            <details className="relative" data-testid="barre-actions-repli">
              <summary
                className="cible-tactile cursor-pointer list-none rounded-xl border border-white/[0.09] bg-white/[0.03] px-3 text-[12px] font-semibold text-slate-300 [&::-webkit-details-marker]:hidden"
                aria-label={libelleSecondaires}
              >
                •••
              </summary>
              <div className="absolute right-0 z-30 mt-2 w-56 rounded-xl border border-white/[0.09] bg-panel p-1.5 shadow-2xl">
                {secondaires.map((action, index) => (
                  <div key={index} className="[&>*]:w-full [&>*]:justify-start">
                    {action}
                  </div>
                ))}
              </div>
            </details>
            )}
            {/* Tablette et bureau : les actions restent visibles en ligne. */}
            {grandEcran && <div className="flex flex-wrap items-center gap-2">{secondaires}</div>}
          </>
        )}
      </div>
    </div>
  );
}
