import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Défilement cohérent entre les espaces.
 *
 * - Une navigation normale (lien, changement d'espace) ouvre la nouvelle page
 *   en haut : l'utilisateur ne débarque jamais au milieu d'une page.
 * - Un retour arrière (POP) rend la page telle qu'elle était, à la position
 *   près : quitter un CRM pour ouvrir une fiche puis revenir ne fait plus
 *   perdre le fil.
 *
 * La position est mémorisée par `location.key`, donc par entrée d'historique,
 * et non par URL : deux visites du même écran gardent chacune leur contexte.
 * Aucun scroll imbriqué n'est introduit : c'est la fenêtre qui défile.
 */
export function useScrollRestoration() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const positions = useRef(new Map<string, number>());
  const keyRef = useRef(location.key);

  useEffect(() => {
    const save = () => {
      positions.current.set(keyRef.current, window.scrollY);
    };
    save();
    window.addEventListener('scroll', save, { passive: true });
    return () => {
      save();
      window.removeEventListener('scroll', save);
    };
  }, [location.key]);

  useEffect(() => {
    keyRef.current = location.key;
    if (navigationType === 'POP') {
      const previous = positions.current.get(location.key);
      if (typeof previous === 'number') {
        window.scrollTo({ top: previous, behavior: 'auto' });
        return;
      }
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.key, navigationType]);
}
