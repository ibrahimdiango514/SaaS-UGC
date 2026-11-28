/**
 * Fournisseur de progrès : relie le défilement aux scènes.
 *
 * Ce composant est le seul endroit qui connaisse GSAP. Les scènes ne font que
 * lire un nombre (0 → 1) par le contexte. Conséquence directe : une scène peut
 * être rendue et testée sans navigateur, sans GSAP, sans animation — et c'est
 * exactement ce qui rend le repli vérifiable.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNiveauImmersion } from '../systeme/immersion';
import { useDefilementImmersion } from './useDefilementImmersion';
import { ContexteScene } from './SceneMoteur';

/** Scènes attendues : sert à initialiser un progrès à zéro pour chacune. */
const SCENES = ['hero', 'immersion', 'grow', 'agent', 'automatisation'] as const;

export function SceneMoteurProgres({ children }: { children: ReactNode }) {
  const racine = useRef<HTMLDivElement>(null);
  const { niveau, pret } = useNiveauImmersion();
  const [progres, setProgres] = useState<Record<string, number>>(() =>
    Object.fromEntries(SCENES.map((nom) => [nom, 0])),
  );
  /** Scène actuellement traversée : c'est elle que les enfants lisent. */
  const [active, setActive] = useState<string>('hero');

  /*
   * Le rappel est stable : sinon chaque image recréerait le contexte React et
   * provoquerait un rendu de toute la page à 60 images par seconde.
   */
  const surProgres = useCallback((id: string, valeur: number) => {
    setProgres((precedent) => {
      // On ne rend que si la valeur bouge vraiment (au centième près).
      if (Math.abs((precedent[id] ?? 0) - valeur) < 0.01) return precedent;
      return { ...precedent, [id]: valeur };
    });
    setActive((precedent) => (precedent === id ? precedent : id));
  }, []);

  useDefilementImmersion({ racine, niveau, pret, surProgres });

  const valeur = useMemo(() => ({ progres: progres[active] ?? 0, niveau }), [progres, active, niveau]);

  return (
    <ContexteScene.Provider value={valeur}>
      <div ref={racine} data-moteur-immersion data-niveau={niveau} className="relative">
        {children}
      </div>
    </ContexteScene.Provider>
  );
}
