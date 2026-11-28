/**
 * Pilotage du défilement : épinglage des scènes, caméra, progrès.
 *
 * ## Le point qui a manqué à la phase 1
 * Il n'y avait **aucun `pin`**. Sans épinglage, une scène défile comme un bloc
 * de contenu : le visiteur lit, il n'entre pas. Ici chaque scène est épinglée
 * sur `duree × 100 vh` et le défilement devient la seule horloge :
 *
 * - `progres` 0 → 1 : distance parcourue dans la scène ;
 * - la caméra se rapproche (`translateZ`), tourne (`rotateY`) et glisse ;
 * - les états du décor se succèdent (fenêtres dans `progres`) ;
 * - à la fin, les volets s'écartent : la scène suivante arrive sans coupure.
 *
 * ## Repli
 * Si le niveau n'est pas `complet` (WebGL absent, mobile, mouvement réduit),
 * on ne branche rien : le CSS force alors la scène à sa composition figée et
 * lisible. Le contenu n'est jamais conditionné à l'animation.
 */
import { useEffect, type RefObject } from 'react';
import type { NiveauImmersion } from '../systeme/immersion';

type Options = {
  racine: RefObject<HTMLElement>;
  niveau: NiveauImmersion;
  pret: boolean;
  /** Reçoit le progrès de chaque scène : clé = id de la scène. */
  surProgres: (id: string, progres: number) => void;
};

/** Paramètres de mouvement de la caméra, par scène (via `data-mouvement`). */
const MOUVEMENTS: Record<string, { de: [number, number, number]; a: [number, number, number]; rot: [number, number] }> = {
  // Le hero : l'objet est déjà là, la caméra recule un peu pour le laisser respirer.
  hero: { de: [0, 0, -120], a: [0, 0, 40], rot: [0, -6] },
  // Studio : la caméra entre dans l'écran.
  studio: { de: [0, 40, -260], a: [0, -30, 140], rot: [-7, 0] },
  // Grow : survol latéral du tableau de bord.
  grow: { de: [-120, 25, -160], a: [110, -18, 110], rot: [5, 7] },
  // Agent IA : la caméra se pose face aux cartes.
  agent: { de: [80, -20, -220], a: [-60, 10, 120], rot: [0, 10] },
  // Automatisation : léger recul pour voir les lignes d'énergie entières.
  automatisation: { de: [0, -40, -160], a: [0, 20, 100], rot: [0, 0] },
};

export function useDefilementImmersion({ racine, niveau, pret, surProgres }: Options): void {
  useEffect(() => {
    if (!pret || niveau !== 'complet') return;
    const element = racine.current;
    if (!element) return;

    /*
     * Garde d'environnement, apprise à la dure : le module GSAP se résout
     * APRÈS la destruction de l'environnement de test et `window.matchMedia`
     * lève alors une erreur NON GÉRÉE qui fait tomber la suite vitest entière.
     *
     * `document.body` sert de témoin : un environnement détruit n'a plus de
     * `body`. On ne teste PAS `matchMedia` ici — un test pourrait le simuler
     * partiellement et bloquer un chemin parfaitement valide en vrai.
     */
    const environnementPret = () =>
      typeof window !== 'undefined' &&
      typeof document !== 'undefined' &&
      document.body != null;

    if (!environnementPret()) return;

    let detruit = false;
    let nettoyer: (() => void) | null = null;

    void (async () => {
      type Nettoyeur = { revert: () => void };
      type Modules = [
        { default: { registerPlugin: (p: unknown) => void; context: (f: () => void, s?: Element) => Nettoyeur; utils: { toArray: <T>(s: string, c?: Element) => T[] }; fromTo: (...a: unknown[]) => unknown; set: (a: unknown, b: Record<string, unknown>) => void } },
        { ScrollTrigger: { update: () => void; refresh: () => void; create: (vars: Record<string, unknown>) => unknown } },
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
        ])) as unknown as Modules;
      } catch {
        // Chunk indisponible : la page reste lisible et défile nativement.
        return;
      }
      if (detruit || !environnementPret() || !racine.current) return;

      const [{ default: gsap }, { ScrollTrigger }, { default: Lenis }] = modules;

      let lenis: InstanceType<Modules[2]['default']> | null = null;
      try {
        gsap.registerPlugin(ScrollTrigger as unknown);
      } catch {
        return;
      }

      const ctx = gsap.context(() => {
        /* Défilement lissé. Pas de `smoothWheel` sans besoin : sur une scène
           épinglée, un lissage trop mou donne l'impression de flotter. */
        try {
          lenis = new Lenis({ anchors: true, smoothWheel: true, lerp: 0.12 });
          lenis.on('scroll', () => ScrollTrigger.update());
          gsap.set(element, {});
        } catch {
          lenis = null;
        }

        /*
         * Les scènes du moteur DOM. Le hero et le Studio portent aussi
         * `data-scene` (ils font partie du récit et sont testés comme tels),
         * mais ils sont pilotés par `ExperienceImmersion` et son propre
         * épinglage : les épingler deux fois produirait deux caméras et un
         * document deux fois plus long.
         */
        const scenes = gsap.utils.toArray<HTMLElement>('[data-scene]:not([data-3d])', element);

        scenes.forEach((scene) => {
          const nom = scene.dataset.mouvement ?? scene.id ?? 'scene';
          const duree = Number(scene.dataset.duree ?? '3');
          const camera = scene.querySelector<HTMLElement>('[data-camera]');
          const objet = scene.querySelector<HTMLElement>('[data-camera] .scene-objet');
          const lumiere = scene.querySelector<HTMLElement>('.scene-lumiere');
          const haut = scene.querySelector<HTMLElement>('[data-volet="haut"]');
          const bas = scene.querySelector<HTMLElement>('[data-volet="bas"]');
          const mouvement = MOUVEMENTS[nom] ?? MOUVEMENTS.studio;
          const cle = scene.id || nom;

          /*
           * ÉPINGLAGE — la pièce maîtresse.
           * La scène reste en place pendant `duree` hauteurs d'écran ; tout ce
           * qui bouge pendant ce temps est piloté par `progres`.
           */
          ScrollTrigger.create({
            trigger: scene,
            start: 'top 4rem',
            end: () => `+=${Math.round(duree * window.innerHeight)}`,
            pin: true,
            pinSpacing: true,
            anticipatePin: 1,
            onUpdate: (self: { progress: number }) => {
              surProgres(cle, self.progress);

              /* Caméra : interpolation directe des paramètres, écrite en
                 variables CSS. Le navigateur n'anime alors qu'une transformée. */
              if (objet) {
                const p = self.progress;
                const x = mouvement.de[0] + (mouvement.a[0] - mouvement.de[0]) * p;
                const y = mouvement.de[1] + (mouvement.a[1] - mouvement.de[1]) * p;
                const z = mouvement.de[2] + (mouvement.a[2] - mouvement.de[2]) * p;
                const rotX = mouvement.rot[0] * Math.sin(Math.PI * p);
                const rotY = mouvement.rot[1] * Math.sin(Math.PI * p);
                objet.style.setProperty('--cam-x', `${x.toFixed(1)}px`);
                objet.style.setProperty('--cam-y', `${y.toFixed(1)}px`);
                objet.style.setProperty('--cam-z', `${z.toFixed(1)}px`);
                objet.style.setProperty('--cam-rot-x', `${rotX.toFixed(2)}deg`);
                objet.style.setProperty('--cam-rot-y', `${rotY.toFixed(2)}deg`);
              }

              // Lumière : monte puis redescend, sans jamais noircir la scène.
              if (lumiere) {
                lumiere.style.opacity = String(0.55 + 0.45 * Math.sin(Math.PI * self.progress));
              }

              /*
               * Volets : au repos ils sont hors champ (-100 % / +100 %).
               * Dans le dernier quart de la scène, ils entrent de 20 % puis
               * repartent — un souffle de rideau, jamais une bande noire
               * permanente, et jamais une coupure sèche.
               */
              if (haut && bas) {
                const phase = Math.max(0, (self.progress - 0.78) / 0.22);
                const entree = Math.sin(Math.PI * phase) * 22;
                haut.style.transform = `translate3d(0, ${(-100 + entree).toFixed(1)}%, 0)`;
                bas.style.transform = `translate3d(0, ${(100 - entree).toFixed(1)}%, 0)`;
              }
            },
          });

          /* Titre en typographie cinétique : chaque mot arrive par masque et
             décalage. Les mots sont déjà dans le DOM ; seule la transformée
             change, et `prefers-reduced-motion` n'arrive jamais ici. */
          const mots = gsap.utils.toArray<HTMLElement>('[data-mot]', scene);
          if (mots.length) {
            gsap.fromTo(
              mots,
              { yPercent: 120, opacity: 0 },
              {
                yPercent: 0,
                opacity: 1,
                stagger: 0.06,
                ease: 'power3.out',
                duration: 0.9,
                scrollTrigger: { trigger: scene, start: 'top 65%', once: true },
              },
            );
          }

          if (camera) {
            // Entrée de scène : la caméra arrive de biais, jamais de face sèche.
            gsap.fromTo(
              camera,
              { yPercent: 8, opacity: 0.35 },
              {
                yPercent: 0,
                opacity: 1,
                ease: 'none',
                scrollTrigger: { trigger: scene, start: 'top 90%', end: 'top 30%', scrub: true },
              },
            );
          }
        });

        ScrollTrigger.refresh();
      }, element);

      const animer = (temps: number) => {
        lenis?.raf(temps);
        requestAnimationFrame(animer);
      };
      const frame = requestAnimationFrame(animer);

      nettoyer = () => {
        cancelAnimationFrame(frame);
        lenis?.destroy();
        ctx.revert();
      };
    })();

    return () => {
      detruit = true;
      nettoyer?.();
    };
  }, [pret, niveau, racine, surProgres]);
}

/** État initial partagé : tout à zéro, aucune scène jouée. */
export function progresInitial(scenes: string[]): Record<string, number> {
  return Object.fromEntries(scenes.map((nom) => [nom, 0]));
}

/** Petit utilitaire conservé pour les tests : la liste des scènes attendues. */
export const SCENES_ATTENDUES = ['hero', 'studio', 'grow', 'agent', 'automatisation'] as const;
