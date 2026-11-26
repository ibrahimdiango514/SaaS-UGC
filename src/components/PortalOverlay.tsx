import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Overlay rendu dans `document.body`, hors de tout ancêtre transformé.
 *
 * ## Le défaut que ce composant rend impossible
 * Un élément `position: fixed` se positionne par rapport à son **ancêtre
 * transformé** le plus proche, et non par rapport à la fenêtre. Or les écrans de
 * SORAHNEX utilisent `animate-fadeUp` / `animate-riseIn` (Tailwind) pour leur
 * entrée en scène : ces animations se terminent avec `animation-fill-mode: both`,
 * donc elles **conservent** `transform: translateY(0)` après la fin. `translateY(0)`
 * n'est pas `none` : l'ancêtre devient définitif comme référentiel.
 *
 * Conséquence constatée sur Android (360 px) dans SORAHNEX Grow : le menu mobile,
 * rendu sous la racine `animate-fadeUp`, se dimensionnait sur le conteneur de
 * contenu et non sur l'écran. Le panneau ne couvrait pas la fenêtre, la couche
 * sombre s'arrêtait au milieu, et les dernières entrées du menu — donc la
 * navigation du bas — devenaient inaccessibles.
 *
 * ## La règle
 * Tout overlay plein écran (`fixed inset-0`) qui vit sous un parent `animate-*`,
 * `transform`, `filter` ou `will-change` doit passer par ce portail. Monter dans
 * `document.body` rétablit la fenêtre comme référentiel, quel que soit le parent.
 *
 * ## Accessibilité conservée
 * Le portail ne change QUE l'emplacement dans le DOM : `role="dialog"`,
 * `aria-modal`, la fermeture par Échap et le verrouillage du défilement restent
 * la responsabilité de l'appelant, qui continue de les appliquer.
 */
export function PortalOverlay({ children }: { children: ReactNode }) {
  /**
   * Rendu différé d'un cycle : côté serveur (et au premier rendu), `document`
   * n'existe pas. On ne rend rien avant le montage, puis on monte le portail.
   * Cela évite une erreur d'hydratation sans jamais dupliquer le contenu.
   */
  const [monte, setMonte] = useState(false);

  useEffect(() => { setMonte(true); }, []);

  if (!monte) return null;
  return createPortal(children, document.body);
}
