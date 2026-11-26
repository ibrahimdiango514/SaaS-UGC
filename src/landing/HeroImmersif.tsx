/**
 * Hero — les cinq premières secondes.
 *
 * ## Contrainte qui commande tout le reste : le LCP
 * Le titre et le CTA doivent être peints AVANT la fin des animations, donc :
 *   1. ils sont dans le HTML au premier rendu, en `h1` réel ;
 *   2. la scène 3D est importée en `lazy` et montée après (elle passe donc
 *      après le texte dans la file de chargement) ;
 *   3. aucune animation ne fait DÉMARRER le titre à `opacity: 0` sans repli :
 *      si le JS n'arrive pas, tout est lisible. La révélation est une
 *      amélioration progressive, jamais une condition d'affichage.
 *
 * ## Chute
 * WebGL absent, mouvement réduit ou appareil modeste : la même composition est
 * rendue en CSS (halo, dégradés) sans canvas. Ce n'est pas une page dégradée,
 * c'est la même page sans la profondeur.
 */
import { Component, Suspense, lazy, useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Play, Sparkles } from 'lucide-react';
import { CTA_PRINCIPAL, PALETTE, REASSURANCE, SLOGAN } from '../systeme/palette';
import { useNiveauImmersion, type NiveauImmersion } from '../systeme/immersion';
import { suivre } from '../systeme/tracking';

const HeroPhoneScene = lazy(() => import('./HeroPhoneScene'));

/** Un échec de la 3D ne doit jamais emporter le hero : on retombe sur le CSS. */
class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { echec: boolean }> {
  state = { echec: false };
  static getDerivedStateFromError() {
    return { echec: true };
  }
  render() {
    return this.state.echec ? this.props.fallback : this.props.children;
  }
}

/** Titre découpé pour être révélé mot par mot, sans casser le `h1`. */
const TITRE = ['Vos vidéos', 'publicitaires.', 'Votre croissance.', 'Un seul endroit.'];
const ACCENT = 'Votre croissance.';

/**
 * Révélation des mots.
 *
 * Les mots sont déjà dans le DOM ; seule leur translation change. Un lecteur
 * d'écran, un moteur d'indexation ou un navigateur sans JS lit le titre complet
 * immédiatement. `prefers-reduced-motion` est respecté par la feuille de style
 * (la classe animée n'est pas appliquée).
 */
function TitreAnime({ niveau }: { niveau: NiveauImmersion }) {
  const anime = niveau !== 'statique';

  return (
    <h1 className="font-display text-[2.1rem] font-bold leading-[1.04] tracking-[-0.02em] text-white sm:text-[3rem] lg:text-[3.9rem]">
      {TITRE.map((mot, index) => (
        <span
          key={mot}
          className={anime ? 'hero-mot inline-block' : 'inline-block'}
          style={anime ? { animationDelay: `${120 + index * 90}ms` } : undefined}
        >
          {mot === ACCENT ? (
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: `linear-gradient(92deg, ${PALETTE.magenta}, ${PALETTE.rose}, ${PALETTE.orange})` }}
            >
              {mot}
            </span>
          ) : (
            mot
          )}
          {index < TITRE.length - 1 ? '\u00A0' : ''}
        </span>
      ))}
    </h1>
  );
}

/** Composition CSS : la même scène, sans canvas. */
function VisuelCss() {
  return (
    <div aria-hidden="true" className="hero-visuel-css relative mx-auto aspect-[9/16] w-full max-w-[15rem] sm:max-w-[17rem]">
      {/* Téléphone stylisé */}
      <div className="absolute inset-0 rounded-[2rem] border border-white/15 bg-[#0B0512] shadow-[0_0_80px_-10px_rgba(240,56,158,0.45)]" />
      <div className="absolute inset-[6px] overflow-hidden rounded-[1.7rem] bg-gradient-to-b from-[#180824] to-[#2A0A2E]">
        <div className="absolute left-4 right-4 top-6 text-[9px] font-semibold uppercase tracking-[0.18em] text-white/40">
          Brief
        </div>
        <div className="absolute left-4 right-4 top-10 text-[11px] leading-5 text-white/85">
          Crème hydratante bio,<br />cible 25-35 ans
        </div>
        <div className="absolute bottom-10 left-4 right-4">
          <div className="h-1 w-full rounded-full bg-white/15">
            <div className="h-1 w-2/3 rounded-full" style={{ background: PALETTE.orange }} />
          </div>
          <p className="mt-3 text-[11px] font-semibold text-white">Vidéo prête</p>
        </div>
      </div>
    </div>
  );
}

export default function HeroImmersif() {
  const { niveau, pret } = useNiveauImmersion();
  const conteneur = useRef<HTMLDivElement>(null);
  const scene3d = pret && niveau === 'complet';

  /*
   * La caméra 3D suit légèrement le pointeur sur desktop uniquement.
   * Le canvas reste `pointer-events: none` : rien de ce qu'il affiche ne
   * capte un clic destiné au CTA.
   */
  useEffect(() => {
    if (!scene3d || !conteneur.current) return;
    const el = conteneur.current;
    const bouger = (evenement: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const x = (evenement.clientX - rect.left) / rect.width - 0.5;
      const y = (evenement.clientY - rect.top) / rect.height - 0.5;
      el.style.setProperty('--hero-tilt-x', `${(-y * 4).toFixed(2)}deg`);
      el.style.setProperty('--hero-tilt-y', `${(x * 6).toFixed(2)}deg`);
    };
    window.addEventListener('pointermove', bouger, { passive: true });
    return () => window.removeEventListener('pointermove', bouger);
  }, [scene3d]);

  return (
    <section
      id="hero"
      ref={conteneur}
      className="relative isolate overflow-hidden"
      style={{ ['--hero-tilt-x' as string]: '0deg', ['--hero-tilt-y' as string]: '0deg' }}
    >
      {/* Fond : noir profond, nébuleuse qui respire, halo, planète en bas. */}
      <div aria-hidden="true" className="absolute inset-0 -z-30" style={{ background: PALETTE.ink }} />
      <div
        aria-hidden="true"
        className="hero-nebuleuse absolute inset-0 -z-20"
        style={{
          background: `radial-gradient(ellipse 60% 50% at 22% 8%, rgba(240,56,158,0.20), transparent 62%),
                       radial-gradient(ellipse 55% 45% at 84% 22%, rgba(124,58,237,0.24), transparent 60%),
                       radial-gradient(ellipse 70% 40% at 50% 108%, rgba(251,113,133,0.18), transparent 66%)`,
        }}
      />
      {/* Planète en bas : simple disque, pas une photo. */}
      <div
        aria-hidden="true"
        className="absolute -bottom-[38%] left-1/2 -z-20 aspect-square w-[160%] -translate-x-1/2 rounded-full sm:w-[110%]"
        style={{
          background: `radial-gradient(circle at 50% 8%, #2A0A2E 0%, #14061F 46%, ${PALETTE.ink} 72%)`,
          boxShadow: '0 -50px 140px -40px rgba(240,56,158,0.35)',
        }}
      />

      <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 pb-16 pt-10 sm:px-6 sm:pb-24 sm:pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:pb-28 lg:pt-20">
        <div className="relative z-10 max-w-2xl">
          <p
            className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: PALETTE.rose }}
          >
            <Sparkles size={12} /> {SLOGAN}
          </p>

          <div className="mt-6">
            <TitreAnime niveau={niveau} />
          </div>

          <p className="mt-5 max-w-xl text-[15px] leading-7 text-slate-300 sm:text-base sm:leading-8">
            Créez des vidéos UGC en quelques minutes et pilotez votre croissance avec une IA qui
            connaît votre entreprise.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              to="/inscription"
              onClick={() => suivre('cta_clic', { emplacement: 'hero' })}
              className="hero-cta btn btn-lg group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-xl px-6 py-3.5 font-semibold text-white"
              style={{ background: `linear-gradient(96deg, ${PALETTE.magenta}, ${PALETTE.rose})` }}
            >
              {CTA_PRINCIPAL}
              <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
            <a
              href="#immersion"
              className="btn btn-lg inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-6 py-3.5 font-semibold text-white transition hover:bg-white/[0.08]"
            >
              <Play size={15} /> Voir comment ça marche
            </a>
          </div>

          {/* Réassurance : identique sous chaque CTA de la page. */}
          <p className="mt-4 text-[13px] text-slate-400">{REASSURANCE}</p>
        </div>

        {/* Visuel produit. Aucune photo de personne : le hero montre le produit. */}
        <div className="relative z-0 mx-auto w-full max-w-md lg:max-w-none">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-10 -z-10 rounded-full blur-3xl"
            style={{ background: `radial-gradient(circle, rgba(240,56,158,0.22), transparent 70%)` }}
          />
          <div
            className="hero-visuel relative h-[22rem] w-full sm:h-[26rem] lg:h-[32rem]"
            style={{
              transform: 'perspective(1200px) rotateX(var(--hero-tilt-x)) rotateY(var(--hero-tilt-y))',
              transition: 'transform 260ms ease-out',
            }}
          >
            {scene3d ? (
              <SceneBoundary fallback={<VisuelCss />}>
                <Suspense fallback={<VisuelCss />}>
                  <HeroPhoneScene />
                </Suspense>
              </SceneBoundary>
            ) : (
              <div className="grid h-full place-items-center">
                <VisuelCss />
              </div>
            )}
          </div>

          {/* Étiquettes reprises dans le HTML : elles restent lisibles même sans 3D. */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[11px]">
            {['Studio', 'Grow', 'Agent IA'].map((nom) => (
              <span
                key={nom}
                className="rounded-full border border-white/12 bg-white/[0.04] px-3 py-1 font-semibold text-slate-200"
              >
                {nom}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Indice de scroll : discret, et masqué quand le mouvement est réduit. */}
      <div className="hero-scroll-indice pointer-events-none absolute bottom-5 left-1/2 hidden -translate-x-1/2 sm:block">
        <span className="block h-8 w-[1px] bg-gradient-to-b from-transparent via-white/40 to-transparent" />
      </div>
    </section>
  );
}
