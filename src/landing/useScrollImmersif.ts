import { useEffect } from 'react';
import type { NiveauImmersion } from '../systeme/immersion';

/**
 * Défilement immersif : Lenis (défilement fluide) + GSAP ScrollTrigger.
 *
 * ## Ce que ça change pour le visiteur
 * Sans cela, la page défile par sauts de molette. Avec, la caméra se déplace
 * comme au cinéma : chaque scène est épinglée le temps qu'elle se joue, puis
 * la suivante prend sa place.
 *
 * ## Ce que ça ne doit jamais casser
 * - **Accessibilité** : en mouvement réduit, aucun code n'est exécuté. La page
 *   défile nativement et tout le contenu est visible. C'est pourquoi le niveau
 *   `statique` sort immédiatement.
 * - **Ancres** : les liens `#immersion` doivent continuer de fonctionner.
 *   Lenis gère les ancres lui-même, mais seulement si on les lui laisse ;
 *   on ne capture donc pas les clics.
 * - **Nettoyage** : tout est détruit au démontage (routeur, HMR). Sans cela,
 *   ScrollTrigger garde des références et les scènes apparaissent vides après
 *   un retour sur la page.
 *
 * ## Pourquoi une promesse d'import
 * GSAP et Lenis pèsent lourd. Ils sont chargés APRÈS le premier rendu : le
 * texte et le CTA sont déjà peints quand ils arrivent. Sur un appareil modeste,
 * ils ne sont jamais chargés du tout.
 */
export function useScrollImmersif(
  racine: React.RefObject<HTMLElement>,
  niveau: NiveauImmersion,
  pret: boolean,
): void {
  useEffect(() => {
    if (!pret || niveau === 'statique') return;
    const element = racine.current;
    if (!element) return;

    /*
     * Garde d'environnement, et non simple politesse.
     *
     * GSAP et ScrollTrigger lisent `window.matchMedia` à l'enregistrement du
     * greffon. En test, l'environnement jsdom est détruit entre les fichiers :
     * le module dynamique se résout APRÈS, et l'appel lève
     * `TypeError: _win.matchMedia is not a function` — une erreur NON GÉRÉE
     * qui fait échouer la suite vitest entière, pas seulement un test.
     * On vérifie donc que l'environnement est encore utilisable au moment où
     * la promesse se résout, avant de toucher à quoi que ce soit.
     */
    const environnementPret = () =>
      typeof window !== 'undefined' &&
      typeof document !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      document.body != null;

    if (!environnementPret()) return;

    let detruit = false;
    let nettoyer: (() => void) | null = null;

    void (async () => {
      /** Types minimaux : seuls les membres réellement utilisés importent. */
      type Modules = [
        { default: typeof import('gsap').default },
        { ScrollTrigger: { update: () => void; refresh: () => void } },
        {
          default: new (options: Record<string, unknown>) => {
            raf: (temps: number) => void;
            on: (evenement: string, rappel: () => void) => void;
            destroy: () => void;
          };
        },
      ];
      let modules: Modules;
      try {
        modules = (await Promise.all([
          import('gsap'),
          import('gsap/ScrollTrigger'),
          import('lenis'),
        ])) as unknown as typeof modules;
      } catch {
        // Un chunk indisponible (réseau coupé, déploiement partiel) laisse la
        // page parfaitement utilisable : elle défile nativement.
        return;
      }
      if (detruit || !environnementPret() || !racine.current) return;

      const [{ default: gsap }, { ScrollTrigger }, { default: Lenis }] = modules;

      try {
        gsap.registerPlugin(ScrollTrigger as never);
      } catch {
        return;
      }

      // Défilement fluide. `lerp` plutôt que `duration` : la vitesse s'adapte
      // à la vélocité de la molette, ce qui évite l'impression de retard.
      const lenis = new Lenis({
        lerp: 0.09,
        wheelMultiplier: 0.9,
        smoothWheel: niveau === 'complet',
        /*
         * `anchors: false` par défaut chez Lenis : les liens `#immersion`,
         * `#faq`… sauteraient alors que tout le reste est fluide. En l'activant,
         * Lenis intercepte le clic, met à jour l'URL et amène la section.
         * Sans JS, l'ancre native fonctionne de toute façon.
         */
        anchors: true,
      });

      let frame = 0;
      const boucle = (temps: number) => {
        lenis.raf(temps);
        frame = requestAnimationFrame(boucle);
      };
      frame = requestAnimationFrame(boucle);

      // Lenis doit prévenir ScrollTrigger à chaque défilement, sinon les
      // scènes se déclenchent avec un décalage visible.
      lenis.on('scroll', ScrollTrigger.update);

      const ctx = gsap.context(() => {
        const scenes = gsap.utils.toArray<HTMLElement>('[data-scene]');

        scenes.forEach((scene) => {
          const camera = scene.querySelector<HTMLElement>('[data-camera]');
          const panneaux = gsap.utils.toArray<HTMLElement>('[data-panneau]', scene);

          if (camera) {
            // La caméra « entre » dans la scène : elle part en recul et en
            // biais, puis vient se poser face au contenu.
            gsap.fromTo(
              camera,
              { scale: 0.82, rotateY: 14, rotateX: -6, z: -180, opacity: 0.35 },
              {
                scale: 1,
                rotateY: 0,
                rotateX: 0,
                z: 0,
                opacity: 1,
                ease: 'none',
                scrollTrigger: {
                  trigger: scene,
                  start: 'top bottom',
                  end: 'top 45%',
                  scrub: niveau === 'complet' ? 1 : false,
                },
              },
            );
          }

          // Les panneaux se séparent : c'est la transition demandée entre les
          // scènes, obtenue en écartant les colonnes, pas en les effaçant.
          if (panneaux.length >= 2) {
            gsap.fromTo(
              panneaux,
              { x: 0 },
              {
                x: (index: number) => (index === 0 ? -90 : 90),
                ease: 'none',
                scrollTrigger: {
                  trigger: scene,
                  start: 'top top',
                  end: 'bottom top',
                  scrub: niveau === 'complet' ? 1 : false,
                },
              },
            );
          }

          // Typographie cinétique : les mots arrivent par masque et décalage.
          const mots = gsap.utils.toArray<HTMLElement>('[data-mot]', scene);
          if (mots.length) {
            gsap.fromTo(
              mots,
              { yPercent: 110, opacity: 0 },
              {
                yPercent: 0,
                opacity: 1,
                stagger: 0.08,
                ease: 'power3.out',
                scrollTrigger: { trigger: scene, start: 'top 72%', once: true },
              },
            );
          }

          // Compteurs : la valeur finale est écrite dans le HTML, l'animation
          // ne fait que l'atteindre. Sans JS, le chiffre reste lisible.
          const compteurs = gsap.utils.toArray<HTMLElement>('[data-compteur]', scene);
          compteurs.forEach((compteur) => {
            const cible = Number(compteur.dataset.compteur ?? '0');
            if (!Number.isFinite(cible)) return;
            const etat = { valeur: 0 };
            gsap.to(etat, {
              valeur: cible,
              duration: 1.6,
              ease: 'power2.out',
              scrollTrigger: { trigger: compteur, start: 'top 85%', once: true },
              onUpdate: () => {
                compteur.textContent = String(Math.round(etat.valeur));
              },
            });
          });
        });
      }, element);

      nettoyer = () => {
        ctx.revert();
        cancelAnimationFrame(frame);
        lenis.destroy();
      };
    })();

    return () => {
      detruit = true;
      nettoyer?.();
    };
  }, [racine, niveau, pret]);
}
