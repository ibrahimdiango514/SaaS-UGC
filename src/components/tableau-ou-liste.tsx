import type { ReactNode } from 'react';
import { useGrandEcran } from '../lib/media-query';
import { cn } from './ui';

/**
 * Liste tactile, remplacement des tableaux sur petit écran.
 *
 * ## Pourquoi un composant, et pas sept rustines
 * Sept écrans métier affichaient un `<table>` : trésorerie, ventes, catalogue,
 * clients, import, finance. Sur un écran de 360 px, des colonnes à six entrées
 * ne tiennent pas. Deux issues étaient possibles :
 *
 *   - faire défiler le tableau horizontalement — lisible, mais chaque ligne
 *     demande un geste et les libellés se coupent ;
 *   - **afficher une liste** : une ligne par enregistrement, l'essentiel en
 *     évidence, le détail sous le titre.
 *
 * La seconde est retenue. Elle ne supprime aucune donnée : chaque champ présent
 * dans le tableau existe dans la liste.
 *
 * ## Une seule vue à la fois
 * Le choix liste/tableau est fait en JavaScript (`useGrandEcran`), pas par
 * `hidden`/`sm:block`. Deux raisons concrètes :
 *   - en CSS, les deux versions restent dans le DOM : lecteurs d'écran en double,
 *     sélecteurs de test ambigus, rendu inutile ;
 *   - un écran de 360 px ne doit pas même construire un tableau à six colonnes.
 *
 * La parité de contenu est garantie par `TableauOuListe` : les deux rendus
 * reçoivent les mêmes données, ils ne peuvent pas diverger.
 */

/** Paire libellé / valeur d'une ligne de liste tactile. */
export interface LigneListeMobile {
  label: string;
  value: ReactNode;
  /** Masque la paire quand la valeur est vide : pas de « — » inutile. */
  masquerSiVide?: boolean;
}

export interface ElementListeMobile {
  /** Clé stable (identifiant de l'enregistrement). */
  id: string;
  /** Texte principal, en gras : ce que l'œil doit trouver en premier. */
  titre: ReactNode;
  /** Sous-titre court (client, catégorie, statut secondaire). */
  sousTitre?: ReactNode;
  /** Élément à droite du titre : montant, badge, statut. */
  accent?: ReactNode;
  /** Texte de remplacement quand il n'y a pas de sous-titre. */
  description?: ReactNode;
  /** Actions propres à la ligne (modifier, supprimer…). */
  actions?: ReactNode;
  /** Rend la ligne cliquable. */
  onOuvrir?: () => void;
}

/**
 * Conteneur : tableau sur grand écran, liste sur téléphone — jamais les deux.
 */
export function TableauOuListe({
  tableau,
  elements,
  legende,
  vide,
  testIdListe,
}: {
  /** Tableau d'origine, affiché à partir de 640 px. */
  tableau: ReactNode;
  /** Éléments de la liste tactile (mêmes données que le tableau). */
  elements: ElementListeMobile[];
  /** Intitulé de la liste, affiché sur mobile (aussi lu par les lecteurs d'écran). */
  legende: string;
  /** Contenu quand il n'y a aucun élément. */
  vide?: ReactNode;
  testIdListe?: string;
}) {
  const grandEcran = useGrandEcran();

  if (elements.length === 0 && vide) return <>{vide}</>;

  if (grandEcran) {
    return <div className="table-defile">{tableau}</div>;
  }

  return (
    <div data-testid={testIdListe}>
      <p className="mb-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {legende}
      </p>
      <ul className="liste-mobile overflow-hidden rounded-xl border border-white/[0.07]">
        {elements.map((element) => (
          <li key={element.id}>
            <LigneMobile element={element} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function LigneMobile({ element }: { element: ElementListeMobile }) {
  const contenu = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">{element.titre}</span>
          {element.accent && <span className="shrink-0 text-[12.5px] font-semibold">{element.accent}</span>}
        </div>
        {(element.sousTitre || element.description) && (
          <p className="mt-0.5 truncate text-[11.5px] text-slate-400">{element.sousTitre ?? element.description}</p>
        )}
      </div>
      {element.actions && <div className="flex shrink-0 items-center gap-1">{element.actions}</div>}
    </>
  );

  if (!element.onOuvrir) {
    return <div className="liste-mobile-ligne">{contenu}</div>;
  }
  return (
    <button type="button" onClick={element.onOuvrir} className={cn('liste-mobile-ligne', 'w-full')}>
      {contenu}
    </button>
  );
}
