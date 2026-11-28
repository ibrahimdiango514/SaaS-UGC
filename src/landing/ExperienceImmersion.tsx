/**
 * Expérience immersive : le hero ET le Studio, dans une seule scène épinglée.
 *
 * ## Pourquoi une section épinglée unique
 * Le visiteur commence face au téléphone, puis la caméra le dépasse et entre
 * dans le Studio. Deux sections épinglées distinctes auraient produit deux
 * caméras et une coupure ; ici, une seule caméra parcourt 4,6 écrans :
 * hero (0 → 15 %), transition (15 → 22 %), Studio (22 → 100 %).
 *
 * ## Le texte n'est jamais conditionné par la 3D
 * - Le `h1`, le sous-titre, le CTA et la réassurance sont dans le HTML du
 *   premier rendu. Le chunk three.js arrive après, en `lazy`.
 * - Sans WebGL, en mouvement réduit, ou si la scène échoue, le même récit
 *   s'affiche en deux panneaux fixes (voir `RepliExperience`).
 *
 * ## Le repli n'est pas une autre page
 * Il reprend exactement les mêmes composants de texte (`ContenuHero`,
 * `ContenuStudio`) et les mêmes engagements ; seules les images changent.
 */
import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { CTA_PRINCIPAL, REASSURANCE, SLOGAN } from '../systeme/palette';
import { useNiveauImmersion } from '../systeme/immersion';
import { suivre } from '../systeme/tracking';
import { ETAPES_STUDIO, etapeStudio } from './monde/camera';
import {
  ecrireProgres,
  phaseExperience,
  type PhaseExperience,
} from './monde/progres';
import {
  PALIERS,
  decision,
  fpsDepuisIntervalles,
  palierDepuisUrl,
  palierInitial,
  palierSuivant,
  type Palier,
} from './monde/qualite';

const Experience3D = lazy(() => import('./monde/Experience3D'));

const LIGNES_HERO = [
  { texte: 'Vos vidéos', accent: false },
  { texte: 'publicitaires.', accent: false },
  { texte: 'Votre croissance.', accent: true },
  { texte: 'Un seul endroit.', accent: false },
] as const;

/* ------------------------------------------------------------------ */
/* Texte du hero — partagé entre 3D et repli                          */
/* ------------------------------------------------------------------ */

function ContenuHero({ anime = true }: { anime?: boolean }) {
  return (
    <div className="exp-hero-texte">
      {/* En mobile : titre en haut, téléphone au milieu, action en bas. */}
      <div className="exp-hero-haut">
        <p className="exp-eyebrow">
          <Sparkles size={11} aria-hidden="true" /> {SLOGAN}
        </p>

        <h1 className="exp-h1">
          {LIGNES_HERO.map((ligne, index) => (
            <span key={ligne.texte} className={`exp-h1-ligne${ligne.accent ? ' exp-h1-accent' : ''}`}>
              <span className="exp-mot-masque">
                <span
                  className={`exp-mot${anime ? ' exp-mot-anime' : ''}`}
                  style={anime ? { animationDelay: `${260 + index * 90}ms` } : undefined}
                >
                  {ligne.texte}
                </span>
              </span>{' '}
            </span>
          ))}
        </h1>
      </div>

      <div className="exp-hero-bas">
        <p className="exp-sous-titre">
          Créez des vidéos UGC en quelques minutes et pilotez votre croissance avec une IA qui
          connaît votre entreprise.
        </p>

        <div className="exp-actions">
          <a
            href="/inscription"
            data-cta="principal"
            onClick={() => suivre('cta_clic', { emplacement: 'hero' })}
            className="exp-cta"
          >
            {CTA_PRINCIPAL}
            <ArrowRight size={15} aria-hidden="true" />
          </a>
          <a href="#immersion" className="exp-cta-secondaire">
            Voir comment ça marche
          </a>
        </div>

        <p className="exp-reassurance">{REASSURANCE}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Texte du Studio                                                     */
/* ------------------------------------------------------------------ */

function ContenuStudio({ etape = 0 }: { etape?: number }) {
  return (
    <div className="exp-studio-texte">
      <div className="exp-studio-tete">
        <span className="exp-pastille">
          <span className="exp-pastille-point" aria-hidden="true" /> Studio UGC
        </span>
        <span className="exp-studio-devis">Devis vérifié avant chaque génération</span>
      </div>

      <h2 className="exp-h2">
        <span className="exp-h2-ligne">Du brief</span>{' '}
        <span className="exp-h2-ligne exp-h2-decale">à la vidéo,</span>{' '}
        <span className="exp-h2-ligne exp-h2-accent">sans quitter l’écran.</span>
      </h2>

      <p className="exp-studio-para">
        Brief, script, storyboard et catalogue de modèles vidéo. La génération est suivie de bout en
        bout, et le devis s’affiche avant chaque lancement.
      </p>

      <ol className="exp-etapes" aria-label="Étapes du Studio">
        {ETAPES_STUDIO.map((item, index) => (
          <li
            key={item.cle}
            className={`exp-etape${index <= etape ? ' exp-etape--faite' : ''}${index === etape ? ' exp-etape--active' : ''}`}
            data-etape-active={index === etape ? 'oui' : 'non'}
          >
            <span className="exp-etape-num" aria-hidden="true">
              0{index + 1}
            </span>
            {item.titre}
          </li>
        ))}
      </ol>

      <div className="exp-actions">
        <a
          href="/inscription"
          data-cta="principal"
          onClick={() => suivre('cta_clic', { emplacement: 'studio' })}
          className="exp-cta"
        >
          {CTA_PRINCIPAL}
          <ArrowRight size={15} aria-hidden="true" />
        </a>
      </div>
      <p className="exp-reassurance">{REASSURANCE}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Repli : les mêmes scènes en images fixes                            */
/* ------------------------------------------------------------------ */

function PanneauFixe({
  id,
  duree,
  image,
  alt,
  children,
  inverse = false,
}: {
  id: string;
  duree: string;
  image: string;
  alt: string;
  children: ReactNode;
  inverse?: boolean;
}) {
  return (
    <section
      id={id}
      data-scene
      data-3d
      data-duree={duree}
      className="relative border-b border-white/[0.06] px-5 py-16 sm:px-6 lg:py-24"
    >
      <div
        className={`mx-auto grid max-w-7xl items-center gap-8 lg:grid-cols-[1.02fr_1fr] lg:gap-14${inverse ? ' lg:[&>*:first-child]:order-2' : ''}`}
      >
        <div>{children}</div>
        <div className="relative overflow-hidden rounded-[1.75rem] border border-white/10 shadow-[0_50px_120px_-60px_rgba(240,56,158,0.55)]">
          <img src={image} alt={alt} className="h-full w-full object-cover" loading="eager" />
          <span aria-hidden="true" className="absolute inset-0 ring-1 ring-inset ring-white/10" />
        </div>
      </div>
    </section>
  );
}

function RepliExperience() {
  return (
    <>
      <PanneauFixe
        id="hero"
        duree="0.8"
        image="/landing/hero-poster.webp"
        alt="Téléphone SORAHNEX en 3D : écran du Studio UGC affichant un brief et une génération en cours"
      >
        <ContenuHero anime={false} />
      </PanneauFixe>
      <PanneauFixe
        id="immersion"
        duree="3.6"
        image="/landing/studio-poster.webp"
        alt="Écran géant du Studio SORAHNEX entouré de plans UGC verticaux"
        inverse
      >
        <ContenuStudio etape={3} />
      </PanneauFixe>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Garde d'erreur : une scène 3D ne casse jamais la page               */
/* ------------------------------------------------------------------ */

class GardeScene3D extends Component<{ repli: ReactNode; onFail: () => void; children: ReactNode }, { echec: boolean }> {
  state = { echec: false };
  static getDerivedStateFromError() {
    return { echec: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.echec ? this.props.repli : this.props.children;
  }
}

/* ------------------------------------------------------------------ */
/* Section principale                                                  */
/* ------------------------------------------------------------------ */

export function ExperienceImmersion() {
  const { niveau, pret } = useNiveauImmersion();
  const racine = useRef<HTMLElement>(null);
  const epingle = useRef<HTMLDivElement>(null);
  const nebuleuse = useRef<HTMLImageElement>(null);
  const [echec, setEchec] = useState(false);
  const [portrait, setPortrait] = useState(false);
  /*
   * Le palier de qualité 3D. Il est choisi par l'URL pour les preuves
   * (`?palier=bas`), sinon il part du plus beau et descend tout seul si la
   * machine ne suit pas. La décision reste dans `qualite.ts`, testée à part.
   */
  const [palier, setPalier] = useState<Palier>(() => {
    if (typeof window === 'undefined') return 'complet';
    return palierDepuisUrl(window.location.search) ?? 'complet';
  });
  const palierFixe = useRef(false);
  const reglages = PALIERS[palier];
  const [phase, setPhase] = useState<PhaseExperience>('hero');
  const [etape, setEtape] = useState(0);

  const statique = niveau === 'statique' || echec;

  /*
   * Palier imposé par l'URL : il ne bouge pas, sinon une capture de preuve
   * changerait de palier pendant la mesure. Sinon, départ selon le format.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const impose = palierDepuisUrl(window.location.search);
    if (impose) {
      palierFixe.current = true;
      setPalier(impose);
      return;
    }
    setPalier(palierInitial(portrait));
  }, [portrait]);

  /*
   * Dégradation automatique : on mesure des fenêtres de ~1,2 s et on descend
   * d'un cran tant que la machine ne tient pas 45 fps. Au plancher, sous
   * 24 fps, on bascule sur le répli 2D — la même histoire, sans WebGL.
   *
   * On ne mesure pas pendant les deux premières secondes : compilation des
   * shaders, upload des textures et apparition du canvas faussent la fenêtre.
   */
  useEffect(() => {
    if (!pret || statique || palierFixe.current) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    let arret = false;
    let dernier = 0;
    let debut = 0;
    let intervalles: number[] = [];
    let amorce = 0;

    const boucle = (t: number) => {
      if (arret) return;
      if (dernier === 0) {
        dernier = t;
        debut = t;
        amorce = t + 1600;
      }
      if (t > dernier) intervalles.push(t - dernier);
      dernier = t;

      if (t - debut > 1200 && intervalles.length >= 6 && t > amorce) {
        const fps = fpsDepuisIntervalles(intervalles);
        const verdict = decision(palier, fps);
        intervalles = [];
        debut = t;
        dernier = t;
        if (verdict === 'descendre') {
          const suivant = palierSuivant(palier);
          if (suivant) {
            setPalier(suivant);
            return;
          }
        }
        if (verdict === 'repli') {
          setEchec(true);
          return;
        }
      }
      requestAnimationFrame(boucle);
    };

    requestAnimationFrame(boucle);
    return () => {
      arret = true;
    };
  }, [pret, statique, palier]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const requete = window.matchMedia('(max-width: 767px)');
    const evaluer = () => setPortrait(requete.matches);
    evaluer();
    requete.addEventListener?.('change', evaluer);
    return () => requete.removeEventListener?.('change', evaluer);
  }, []);

  // Le défilement n'est branché que s'il y a une scène à piloter.
  useEffect(() => {
    if (!pret || statique) {
      ecrireProgres(0);
      return;
    }
    const section = racine.current;
    const ciblePin = epingle.current;
    if (!section || !ciblePin) return;

    let detruit = false;
    let nettoyer: (() => void) | null = null;

    type Modules = [
      { default: { registerPlugin: (plugin: unknown) => void; context: (rappel: () => void, portee?: Element) => { revert: () => void } } },
      { ScrollTrigger: { create: (vars: Record<string, unknown>) => { kill: () => void }; refresh: () => void } },
    ];

    void (async () => {
      let modules: Modules;
      try {
        modules = (await Promise.all([import('gsap'), import('gsap/ScrollTrigger')])) as unknown as Modules;
      } catch {
        return;
      }
      if (detruit || !racine.current || !epingle.current) return;

      const [{ default: gsap }, { ScrollTrigger }] = modules;

      try {
        gsap.registerPlugin(ScrollTrigger);
      } catch {
        return;
      }

      const ctx = gsap.context(() => {
        /*
         * L'ÉPINGLAGE. 460 % de hauteur : ~80 % pour le hero et 380 % pour le
         * Studio, dans la fourchette 300–400 % demandée pour une scène.
         * `pin` porte sur le panneau interne : la section garde sa hauteur
         * réelle dans le document, ce qui évite les sauts d'ancres.
         */
        ScrollTrigger.create({
          trigger: section,
          start: 'top top',
          end: '+=460%',
          pin: ciblePin,
          pinSpacing: true,
          anticipatePin: 1,
          invalidateOnRefresh: true,
          onUpdate: (self: { progress: number }) => {
            const p = self.progress;
            ecrireProgres(p);
            // Observabilité : la progression réelle est lisible dans le DOM
            // (rapport de preuve, tests de non-régression visuels).
            section.dataset.progres = p.toFixed(3);
            const nouvellePhase = phaseExperience(p);
            setPhase((precedente) => (precedente === nouvellePhase ? precedente : nouvellePhase));
            const nouvelEtape = etapeStudio(p);
            setEtape((precedente) => (precedente === nouvelEtape ? precedente : nouvelEtape));
            if (nebuleuse.current) {
              nebuleuse.current.style.transform = `translate3d(0, ${(p * 7).toFixed(2)}%, 0) scale(${(1.04 + p * 0.08).toFixed(3)})`;
            }
          },
        });
        ScrollTrigger.refresh();

        /*
         * Les scènes classiques qui suivent sont épinglées par un autre hook.
         * Quand il s'installe avant ce pin, leurs positions de départ sont
         * calculées sans l'espace réservé par celui-ci : elles se croyaient
         * déjà épinglées et venaient se poser PAR-DESSUS le Studio (constaté à
         * la capture en 360 px). Un rafraîchissement après la pose de tous les
         * déclencheurs recalcule les départs.
         */
        requestAnimationFrame(() => ScrollTrigger.refresh());
      }, section);

      nettoyer = () => ctx.revert();
    })();

    return () => {
      detruit = true;
      nettoyer?.();
    };
  }, [pret, statique]);

  if (statique) {
    return (
      <div data-experience="statique" data-palier="repli">
        <RepliExperience />
      </div>
    );
  }

  const opaciteHero = phase === 'hero' ? 1 : 0;
  const opaciteStudio = phase === 'studio' ? 1 : 0;

  return (
    <section
      id="experience"
      ref={racine}
      className="relative"
      data-experience="3d"
      data-palier={palier}
    >
      <div ref={epingle} data-pin className="relative h-[100svh] overflow-hidden">
        {/* Fond cosmique : une image locale de 27 Ko, sous le canvas. */}
        <div aria-hidden="true" className="absolute inset-0 z-0 bg-[#05030A]">
          <img
            ref={nebuleuse}
            src="/landing/nebula.webp"
            alt=""
            className="h-full w-full scale-105 object-cover opacity-95"
          />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_45%,transparent,rgba(5,3,10,0.72))]" />
        </div>

        {/* Scène WebGL, chargée après le texte. */}
        <div className="absolute inset-0 z-10" aria-hidden="true">
          <GardeScene3D repli={<div data-scene-3d-echec className="h-full w-full" />} onFail={() => setEchec(true)}>
            <Suspense fallback={null}>
              <Experience3D portrait={portrait} allege={niveau === 'allege'} reglages={reglages} />
            </Suspense>
          </GardeScene3D>
        </div>

        {/* Lueurs : remplacement CSS des halos additifs sur les paliers légers. */}
        <div aria-hidden="true" className="exp-lueurs" data-actif={reglages.lueursCss ? 'oui' : 'non'} />

        {/* Panneau hero */}
        <div
          id="hero"
          data-scene
          data-3d
          data-duree="0.8"
          data-actif={phase === 'hero' ? 'oui' : 'non'}
          className="exp-panneau"
          style={{ opacity: opaciteHero, pointerEvents: phase === 'hero' ? 'auto' : 'none' }}
        >
          <div aria-hidden="true" className="exp-voile-texte" />
          <div className="exp-panneau-interieur">
            <ContenuHero />
          </div>
          <div aria-hidden="true" className="exp-indice-defilement" style={{ opacity: opaciteHero }}>
            <span />
            <span className="exp-indice-texte">Défilez</span>
          </div>
        </div>

        {/* Panneau Studio */}
        <div
          id="immersion"
          data-scene
          data-3d
          data-duree="3.6"
          data-actif={phase === 'studio' ? 'oui' : 'non'}
          data-etape={etape}
          className="exp-panneau"
          style={{ opacity: opaciteStudio, pointerEvents: phase === 'studio' ? 'auto' : 'none' }}
        >
          <div aria-hidden="true" className="exp-voile-studio" />
          <div className="exp-panneau-interieur">
            <ContenuStudio etape={etape} />
          </div>
          <div className="exp-etape-courante" aria-hidden="true">
            <span className="exp-etape-courante-num">0{etape + 1}</span>
            <span className="exp-etape-courante-ligne">
              <i style={{ width: `${((etape + 1) / 4) * 100}%` }} />
            </span>
            <span className="exp-etape-courante-titre">{ETAPES_STUDIO[etape].titre}</span>
          </div>
        </div>

        {/* Voile de transition : jamais un noir plein, juste un souffle. */}
        <div
          aria-hidden="true"
          className="exp-voile"
          style={{ opacity: phase === 'transition' ? 0.55 : 0 }}
        />
      </div>
    </section>
  );
}
