/**
 * Hero — le visiteur entre dans le produit.
 *
 * ## Ce qui a changé après la première livraison, et pourquoi
 * La version précédente était une grille « texte à gauche, petite vignette à
 * droite ». C'est une page de présentation, pas une immersion. Ici :
 *
 * - **un objet central occupe l'écran** : un écran produit 9:16, large, haut,
 *   en rotation et en flottement permanents ; le texte est posé PAR-DESSUS,
 *   il ne prend pas la moitié de la largeur à l'objet ;
 * - **le défilement pilote la caméra** : la scène est épinglée, la caméra
 *   s'approche de l'écran, tourne, puis laisse la main à la scène Studio ;
 * - **les mots du titre sont répartis** sur l'écran (typographie cinétique),
 *   révélés par masque et décalage.
 *
 * ## Ce qui n'a pas changé
 * Le `h1` et le CTA sont dans le HTML dès le premier rendu. Le poids est nul
 * côté 3D : il n'y a pas de moteur 3D dans le hero, seulement du DOM en
 * perspective. Et sans WebGL, sans mouvement accepté ou sur mobile, la même
 * composition s'affiche figée, complète et lisible.
 */
import { useEffect, useRef } from 'react';
import { PALETTE, REASSURANCE, SLOGAN, CTA_PRINCIPAL } from '../systeme/palette';
import { useNiveauImmersion } from '../systeme/immersion';
import { suivre } from '../systeme/tracking';
import { useProgresScene } from './SceneMoteur';

/** Les mots du titre, chacun posé à un endroit différent de l'écran. */
const MOTS = [
  { texte: 'Vos vidéos', position: 'mot-1' },
  { texte: 'publicitaires.', position: 'mot-2' },
  { texte: 'Votre croissance.', position: 'mot-3', accent: true },
  { texte: 'Un seul endroit.', position: 'mot-4' },
];

export function HeroScene() {
  const { progres, niveau } = useProgresScene();
  const { pret } = useNiveauImmersion();
  const scene = useRef<HTMLElement>(null);
  const anime = niveau === 'complet';
  const allege = niveau === 'allege';

  /*
   * Parallaxe au pointeur : uniquement en mode complet, et jamais sur le
   * conteneur du CTA. Le canvas n'existe pas ici — c'est du DOM — donc un
   * clic atteint toujours le bouton.
   */
  useEffect(() => {
    if (!anime || !scene.current) return;
    const el = scene.current;
    const bouger = (evenement: PointerEvent) => {
      const x = evenement.clientX / window.innerWidth - 0.5;
      const y = evenement.clientY / window.innerHeight - 0.5;
      el.style.setProperty('--souris-x', `${(x * 14).toFixed(2)}px`);
      el.style.setProperty('--souris-y', `${(y * 10).toFixed(2)}px`);
    };
    window.addEventListener('pointermove', bouger, { passive: true });
    return () => window.removeEventListener('pointermove', bouger);
  }, [anime]);

  return (
    <section
      id="hero"
      ref={scene}
      data-scene
      data-mouvement="hero"
      data-duree={3.4}
      className="scene scene--hero relative isolate overflow-hidden"
      style={{ ['--teinte' as string]: PALETTE.magenta }}
    >
      {/* Nébuleuse de fond : trois sources de lumière, jamais une image. */}
      <div aria-hidden="true" className="absolute inset-0 -z-30" style={{ background: PALETTE.ink }} />
      <div
        aria-hidden="true"
        className="hero-nebuleuse absolute inset-0 -z-20"
        style={{
          background: `radial-gradient(ellipse 55% 45% at 24% 12%, rgba(240,56,158,0.26), transparent 62%),
                       radial-gradient(ellipse 50% 42% at 78% 26%, rgba(255,138,61,0.16), transparent 60%),
                       radial-gradient(ellipse 80% 50% at 50% 112%, rgba(251,113,133,0.20), transparent 66%)`,
        }}
      />

      <div data-camera className="hero-camera relative mx-auto w-full max-w-[100rem] items-center justify-center px-4 sm:px-6">
        {/* ------------------------------------------------------------ */}
        {/* Objet central : l'écran produit, ≥ 60 % de la hauteur visible */}
        {/* ------------------------------------------------------------ */}
        <div
          className="hero-objet relative flex h-[74svh] w-full items-center justify-center sm:h-[78svh]"
          style={{ perspective: '1200px', perspectiveOrigin: '50% 50%' }}
        >
          <div
            className={`hero-telephone ${anime ? 'hero-telephone--anime' : ''}`}
            style={{
              transformStyle: 'preserve-3d',
              // La caméra du défilement s'ajoute à la rotation permanente.
              ['--cam-rot-y' as string]: `${(progres * 26).toFixed(2)}deg`,
              ['--cam-z' as string]: `${(progres * 220).toFixed(1)}px`,
            }}
          >
            <EcranTelephone progres={progres} anime={anime || allege} fige={!anime} />
          </div>
        </div>

        {/* ------------------------------------------------------------ */}
        {/* Titre cinétique : les mots sont répartis sur l'écran           */}
        {/* ------------------------------------------------------------ */}
        <h1 className="hero-titre-cinetique pointer-events-none">
          <span className="sr-only">
            Vos vidéos publicitaires. Votre croissance. Un seul endroit.
          </span>
          {MOTS.map((mot, index) => (
            <span
              key={mot.texte}
              aria-hidden="true"
              className={`hero-mot ${mot.position} ${mot.accent ? 'hero-mot--accent' : ''} ${anime ? 'hero-mot--anime' : ''}`}
              style={anime ? { animationDelay: `${260 + index * 120}ms` } : undefined}
            >
              <span
                className="hero-mot-interieur"
                style={
                  mot.accent
                    ? {
                        backgroundImage: `linear-gradient(96deg, ${PALETTE.magenta}, ${PALETTE.rose} 55%, ${PALETTE.orange})`,
                        WebkitBackgroundClip: 'text',
                        backgroundClip: 'text',
                        color: 'transparent',
                      }
                    : undefined
                }
              >
                {mot.texte}
              </span>
              {/* L'espace insécable garde les mots séparés dans le texte lu :
                  sans lui, on lisait « briefà la vidéo » — et un lecteur
                  d'écran l'aurait lu de la même façon. */}
              {index < MOTS.length - 1 ? '\u00A0' : ''}
            </span>
          ))}
        </h1>

        {/*
          * Titre de section réel : le `h1` porte le titre cinétique, mais chaque
          * scène doit exposer un `h2` pour la structure du document. Il est
          * lisible par un lecteur d'écran et n'est pas un doublon visuel.
          */}
        <h2 className="sr-only">Le produit en un coup d’œil : Studio UGC, Grow et Agent IA</h2>

        {/* ------------------------------------------------------------ */}
        {/* Texte d'appui + CTA : posés en bas, jamais devant l'objet       */}
        {/* ------------------------------------------------------------ */}
        <div className="hero-bas pointer-events-none z-20 px-4 pb-6 sm:absolute sm:inset-x-0 sm:bottom-0 sm:px-8 sm:pb-7">
          <div className="pointer-events-auto mx-auto flex max-w-3xl flex-col items-center gap-3 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em]" style={{ color: PALETTE.rose }}>
              {SLOGAN}
            </p>
            <p className="max-w-xl text-[13px] leading-6 text-slate-300 sm:text-sm">
              Créez des vidéos UGC en quelques minutes et pilotez votre croissance avec une IA qui
              connaît votre entreprise.
            </p>
            <div className="flex flex-col items-center gap-2 sm:flex-row sm:gap-3">
              <a
                href="/inscription"
                data-cta="principal"
                onClick={() => suivre('cta_clic', { emplacement: 'hero' })}
                className="hero-cta btn inline-flex items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-white shadow-[0_20px_60px_-20px_rgba(240,56,158,0.9)]"
                style={{ background: `linear-gradient(96deg, ${PALETTE.magenta}, ${PALETTE.rose} 62%, ${PALETTE.orange})` }}
              >
                {CTA_PRINCIPAL}
              </a>
              <a
                href="#immersion"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.05] px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.09]"
              >
                Voir comment ça marche
              </a>
            </div>
            <p className="text-[11px] text-slate-400">{REASSURANCE}</p>
          </div>
        </div>

        {/* Indice de défilement : le récit commence en scrollant. */}
        {anime && pret ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-1 left-1/2 hidden -translate-x-1/2 sm:block"
            style={{ opacity: Math.max(0, 1 - progres * 4) }}
          >
            <span className="hero-scroll-indice block" />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* L'écran du téléphone : brief → script → plans → vidéo               */
/* ------------------------------------------------------------------ */

function EcranTelephone({ progres, anime, fige }: { progres: number; anime: boolean; fige: boolean }) {
  /*
   * En repli, la scène est GELÉE : elle doit montrer un état cohérent, pas
   * l'état initial d'une animation qui ne se jouera jamais. Sans cela, l'écran
   * affichait « Vidéo prête » en haut et « Génération en cours » avec une
   * barre vide en bas — constaté à la capture.
   */
  const position = fige ? 1 : progres;
  const etape = anime ? Math.min(3, Math.floor(position * 4)) : 3;

  const plans = [
    { titre: 'Unboxing', teinte: PALETTE.magenta },
    { titre: 'Routine 30 s', teinte: PALETTE.rose },
    { titre: 'Avant / après', teinte: PALETTE.violet },
    { titre: 'Mise en situation', teinte: PALETTE.orange },
  ];

  return (
    <div className="hero-telephone-corps relative h-full w-full overflow-hidden rounded-[2.2rem] border border-white/15 bg-[#0B0512]">
      <div className="flex h-full flex-col p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-semibold uppercase tracking-[0.2em] text-white/40">Studio UGC</span>
          <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold" style={{ background: `${PALETTE.magenta}22`, color: PALETTE.rose }}>
            {etape < 3 ? `Étape ${etape + 1}/4` : 'Vidéo prête'}
          </span>
        </div>

        <div className="mt-3 flex-1 space-y-2.5">
          {/* 1 — brief */}
          <Bloc etape={etape} index={0} titre="Brief" teinte={PALETTE.magenta}>
            Crème hydratante bio, cible 25-35 ans, ton naturel.
          </Bloc>
          {/* 2 — script */}
          <Bloc etape={etape} index={1} titre="Script" teinte={PALETTE.rose}>
            Accroche · problème · démonstration · appel à l’action.
          </Bloc>
          {/* 3 — plans UGC */}
          <Bloc etape={etape} index={2} titre="Plans" teinte={PALETTE.orange}>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5 min-[420px]:grid-cols-4">
              {plans.map((plan) => (
                <div key={plan.titre} className="overflow-hidden rounded-md" style={{ background: `linear-gradient(160deg, ${plan.teinte}44, #0B0512 78%)` }}>
                  <div className="aspect-[9/16]" />
                </div>
              ))}
            </div>
          </Bloc>
        </div>

        {/* 4 — rendu final */}
        <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
          <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-1 rounded-full transition-[width] duration-300"
              style={{ width: `${Math.min(100, 20 + position * 80)}%`, background: `linear-gradient(90deg, ${PALETTE.magenta}, ${PALETTE.orange})` }}
            />
          </div>
          <p className="mt-1.5 text-[10px] font-semibold text-white">
            {position > 0.75 ? 'Vidéo prête' : 'Génération en cours'}
          </p>
          <p className="text-[9px] text-slate-500">Devis vérifié avant lancement</p>
        </div>
      </div>
    </div>
  );
}

function Bloc({
  etape,
  index,
  titre,
  teinte,
  children,
}: {
  etape: number;
  index: number;
  titre: string;
  teinte: string;
  children: React.ReactNode;
}) {
  const actif = etape >= index;
  return (
    <div
      className="rounded-lg border p-2.5 transition-all duration-300"
      style={{
        borderColor: actif ? `${teinte}55` : 'rgba(255,255,255,0.07)',
        background: actif ? `${teinte}12` : 'rgba(255,255,255,0.02)',
        opacity: actif ? 1 : 0.45,
      }}
    >
      <p className="text-[9px] font-semibold uppercase tracking-[0.16em]" style={{ color: actif ? teinte : '#64748b' }}>
        {titre}
      </p>
      <div className="mt-1 text-[10px] leading-4 text-slate-300">{children}</div>
    </div>
  );
}
