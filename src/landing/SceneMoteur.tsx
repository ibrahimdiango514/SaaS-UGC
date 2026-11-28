/**
 * Moteur d'immersion : scènes plein écran pilotées par le défilement.
 *
 * ## Le choix qui commande tout le fichier
 * La caméra n'est PAS une caméra 3D. C'est une animation CSS 3D
 * (`perspective` / `rotateY` / `translate3d`) appliquée à un décor DOM réel.
 * Trois raisons, dans l'ordre d'importance :
 *
 * 1. **Le repli montre exactement la même scène.** Sans WebGL, on ne rend pas
 *    « une autre version » : on gèle la même composition à son état lisible.
 *    Un canvas R3F ne peut pas offrir cela — il n'a pas de repli fidèle.
 * 2. **Le texte reste du texte.** Il est lisible, sélectionnable, indexé, et
 *    il est là dès le premier rendu, animation ou pas.
 * 3. **Aucun téléchargement lourd.** Pas de moteur 3D sur la route critique ;
 *    le budget initial reste sous le seuil même sur un réseau lent.
 *
 * ## Ce qui est réellement animé
 * - la **caméra** : un conteneur `[data-camera]` qui se rapproche, tourne et
 *   glisse pendant que la scène est épinglée (`pin`) ;
 * - les **états** : chaque scène a plusieurs états (le storyboard, les plans,
 *   la vidéo) et le défilement les traverse un par un ;
 * - la **lumière** : un voile coloré dont l'opacité suit le progrès, et qui
 *   n'est jamais totalement opaque — on ne coupe jamais au noir ;
 * - les **panneaux** : deux volets qui s'écartent à la sortie de scène.
 *
 * Toutes ces animations sont des interpolations pures de `--progres` (0 → 1),
 * calculées par GSAP ScrollTrigger. Rien n'est joué « à l'aveugle » dans une
 * boucle de rendu : le défilement est la seule horloge.
 */
import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { CTA_PRINCIPAL, PALETTE, REASSURANCE } from '../systeme/palette';
import { suivre } from '../systeme/tracking';
import type { NiveauImmersion } from '../systeme/immersion';

/* ------------------------------------------------------------------ */
/* Contexte de scène : les enfants lisent le progrès sans le recalculer */
/* ------------------------------------------------------------------ */

type EtatScene = { progres: number; niveau: NiveauImmersion };

export const ContexteScene = createContext<EtatScene>({ progres: 0, niveau: 'statique' });

/** Progrès de défilement de la scène courante, de 0 à 1. */
export function useProgresScene(): EtatScene {
  return useContext(ContexteScene);
}

/* ------------------------------------------------------------------ */
/* CTA — le même partout, mesuré, jamais une image                       */
/* ------------------------------------------------------------------ */

export function CtaScene({ emplacement, compact = false }: { emplacement: string; compact?: boolean }) {
  return (
    <div className={compact ? 'mt-4' : 'mt-6'}>
      <a
        href="/inscription"
        data-cta="principal"
        onClick={() => suivre('cta_clic', { emplacement })}
        className="btn inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{
          background: `linear-gradient(96deg, ${PALETTE.magenta}, ${PALETTE.rose} 62%, ${PALETTE.orange})`,
          outlineColor: PALETTE.rose,
        }}
      >
        {CTA_PRINCIPAL}
      </a>
      <p className="mt-2 text-[11px] leading-5 text-slate-400">{REASSURANCE}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Coquille d'une scène                                                  */
/* ------------------------------------------------------------------ */

type SceneProps = {
  /** Numéro affiché : sert de repère, jamais de décoration gratuite. */
  numero: string;
  /** Étiquette courte, en haut de la scène. */
  etiquette: string;
  /** Titre réel (`h2`), présent dans le HTML avant toute animation. */
  titre: ReactNode;
  /** Couleur de la lumière de la scène. */
  teinte: string;
  /** Nœuds de contenu : texte, CTA. */
  children?: ReactNode;
  /** Le décor animé (écran, tableau de bord, cartes…). */
  decor: ReactNode;
  /** Hauteur d'épinglage, en écrans. 3 = la scène dure 3 hauteurs d'écran. */
  duree?: number;
  /** Classe supplémentaire. */
  className?: string;
  id?: string;
};

/**
 * Une scène = une section épinglée + un décor à états.
 *
 * `data-scene` : cible de ScrollTrigger (`pin`, `scrub`).
 * `data-camera` : le nœud que la caméra transforme.
 * `data-etat` : un état du décor, visible seulement dans sa fenêtre de progrès.
 */
export function Scene({
  numero,
  etiquette,
  titre,
  teinte,
  children,
  decor,
  duree = 3,
  className = '',
  id,
}: SceneProps) {
  const { progres, niveau } = useProgresScene();
  const anime = niveau === 'complet';

  return (
    <section
      id={id}
      data-scene
      data-duree={duree}
      className={`scene relative isolate ${className}`}
      style={{ ['--teinte' as string]: teinte }}
    >
      {/* Lumière de scène : jamais opaque, elle accompagne le décor. */}
      <div
        aria-hidden="true"
        className="scene-lumiere pointer-events-none absolute inset-0 -z-20"
        style={{
          background: `radial-gradient(ellipse 70% 55% at 62% 42%, ${teinte}2E, transparent 62%),
                       radial-gradient(ellipse 90% 60% at 12% 92%, ${PALETTE.magenta}1F, transparent 68%)`,
        }}
      />

      <div data-camera className="scene-camera relative mx-auto flex min-h-[100svh] w-full max-w-7xl flex-col justify-center px-4 py-20 sm:px-6">
        <div className="scene-grille grid items-center gap-8 lg:grid-cols-[0.92fr_1.08fr] lg:gap-12">
          {/* Colonne texte : toujours dans le flux, jamais masquée par défaut. */}
          <div data-panneau="gauche" className="scene-texte relative z-10">
            <p
              className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em]"
              style={{ color: teinte }}
            >
              <span className="inline-block h-px w-6" style={{ background: teinte }} aria-hidden="true" />
              {numero} · {etiquette}
            </p>
            <h2 className="scene-titre mt-4 font-display text-[1.85rem] font-bold leading-[1.08] tracking-[-0.02em] text-white sm:text-[2.6rem] lg:text-[3rem]">
              {titre}
            </h2>
            {children}
          </div>

          {/* Colonne décor : la caméra la traverse. */}
          <div data-panneau="droite" className="scene-decor relative z-0">
            {decor}
          </div>
        </div>
      </div>

      {/* Volets de transition : ils s'écartent, ils ne cachent pas. */}
      {anime ? (
        <>
          <div aria-hidden="true" data-volet="haut" className="scene-volet scene-volet--haut pointer-events-none absolute inset-x-0 top-0 -z-10 h-1/2" />
          <div aria-hidden="true" data-volet="bas" className="scene-volet scene-volet--bas pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-1/2" />
        </>
      ) : null}

      {/* Repère de défilement : indique que la scène se joue en défilant. */}
      {anime ? (
        <div aria-hidden="true" className="pointer-events-none absolute bottom-6 left-1/2 hidden -translate-x-1/2 sm:block">
          <span className="scene-jauge block h-[2px] w-24 overflow-hidden rounded-full bg-white/10">
            <span className="block h-full" style={{ width: `${Math.round(progres * 100)}%`, background: teinte }} />
          </span>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* État animé : visible dans une fenêtre de progrès                      */
/* ------------------------------------------------------------------ */

/**
 * Un état du décor, affiché seulement pendant sa fenêtre de progrès.
 *
 * Le repli (`statique`) n'affiche pas « l'état 0 » : il affiche la scène
 * complète et lisible. C'est `data-fige` sur le décor qui décide, pas ce
 * composant.
 */
export function Etat({
  de,
  a,
  children,
  className = '',
  style,
}: {
  de: number;
  a: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const { progres, niveau } = useProgresScene();
  if (niveau !== 'complet') return null;

  // Fenêtre avec un léger fondu aux deux bords : pas de coupure sèche.
  const dedans = progres >= de && progres <= a;
  const fondu = 0.06;
  const entree = Math.min(1, Math.max(0, (progres - de) / fondu));
  const sortie = Math.min(1, Math.max(0, (a - progres) / fondu));
  const opacite = dedans ? Math.min(entree, sortie) : 0;

  return (
    <div
      aria-hidden={opacite < 0.5 ? 'true' : undefined}
      className={className}
      style={{
        opacity: opacite,
        transform: `translate3d(0, ${(1 - opacite) * 18}px, 0)`,
        transition: 'opacity 80ms linear',
        pointerEvents: opacite > 0.5 ? 'auto' : 'none',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Écran produit : le décor commun, à plusieurs états                    */
/* ------------------------------------------------------------------ */

/**
 * Écran produit en perspective. `etats` reçoit les différents contenus ;
 * l'état visible dépend du mode :
 * - animé : les états se remplacent au fil du progrès ;
 * - figé : un état unique et complet, choisi par la scène.
 */
export function EcranProduit({
  children,
  titreEcran,
  className = '',
}: {
  children: ReactNode;
  titreEcran: string;
  className?: string;
}) {
  return (
    <div
      className={`ecran-produit relative overflow-hidden rounded-2xl border border-white/12 bg-[#0A0511]/95 shadow-[0_50px_140px_-50px_rgba(240,56,158,0.55)] ${className}`}
    >
      <div className="flex items-center gap-2 border-b border-white/8 px-3 py-2">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: PALETTE.magenta }} aria-hidden="true" />
        <span className="h-1.5 w-1.5 rounded-full bg-white/20" aria-hidden="true" />
        <span className="ml-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          {titreEcran}
        </span>
      </div>
      <div className="relative p-3 sm:p-4">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Duo : révélation « carte qui surgit »                                */
/* ------------------------------------------------------------------ */

export function CartesQuiSurgissent({ cartes, teinte }: { cartes: Array<{ titre: string; texte: string }>; teinte: string }) {
  const { progres, niveau } = useProgresScene();
  const anime = niveau === 'complet';

  return (
    <div className="grid gap-2.5">
      {cartes.map((carte, index) => {
        // Chaque carte arrive l'une après l'autre, avec un décalage court.
        const debut = 0.12 + index * 0.14;
        const avance = Math.min(1, Math.max(0, (progres - debut) / 0.16));
        const visible = anime ? avance : 1;
        return (
          <div
            key={carte.titre}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-3"
            style={{
              opacity: visible,
              transform: `translate3d(${(1 - visible) * -24}px, ${(1 - visible) * 14}px, ${(1 - visible) * -40}px) rotateY(${(1 - visible) * 14}deg)`,
              borderLeft: `2px solid ${teinte}`,
            }}
          >
            <p className="text-[12px] font-semibold text-white">{carte.titre}</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-400">{carte.texte}</p>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Décor en perspective : applique la caméra au nœud                     */
/* ------------------------------------------------------------------ */

/**
 * Enveloppe un décor d'une perspective réelle et d'un point de fuite.
 *
 * Le déplacement vient de `--cam-x`, `--cam-y`, `--cam-z` et `--cam-rot`,
 * écrits par GSAP sur la scène. En repli, ces variables restent à 0 et la
 * composition est simplement posée de face.
 */
export function Perspective({ children, intensite = 1 }: { children: ReactNode; intensite?: number }) {
  return (
    <div
      className="scene-perspective relative"
      style={{
        perspective: `${900 * intensite}px`,
        perspectiveOrigin: '50% 45%',
        transformStyle: 'preserve-3d',
      }}
    >
      <div
        className="scene-objet"
        style={{
          transform:
            'translate3d(calc(var(--cam-x, 0px)), calc(var(--cam-y, 0px)), calc(var(--cam-z, 0px))) rotateX(calc(var(--cam-rot-x, 0deg))) rotateY(calc(var(--cam-rot-y, 0deg))) rotateZ(calc(var(--cam-rot, 0deg)))',
          transformStyle: 'preserve-3d',
        }}
      >
        {children}
      </div>
    </div>
  );
}
