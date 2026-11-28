/**
 * Vitrine SORAHNEX — refonte immersive (phase 1).
 *
 * ## Ce qui change par rapport à la vitrine précédente
 * - Le hero est une scène 3D (téléphone 9:16) avec repli CSS, suivie de deux
 *   scènes pilotées par le scroll (Studio, Grow).
 * - La marque bascule du cyan/violet vers magenta/rose/orange ; le texte, la
 *   structure et les engagements ne changent pas.
 * - Un seul CTA, « Créer ma première vidéo », répété à chaque section.
 *
 * ## Ce qui ne change pas, volontairement
 * Les engagements de la vitrine précédente restent mot pour mot : devis vérifié
 * avant génération, aucun prix inventé, fonctionnalités non branchées annoncées
 * comme telles. Une refonte visuelle ne doit pas adoucir une promesse.
 *
 * ## Accessibilité et performance
 * Le titre et le CTA sont dans le HTML au premier rendu ; la 3D, GSAP et Lenis
 * sont chargés après. En mouvement réduit, la page est entièrement statique et
 * lisible.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Brain, Check, Clapperboard, Coins, Layers3,
  LockKeyhole, ShieldCheck, Sparkles, TrendingUp, Wand2, Zap,
} from 'lucide-react';
import { ExperienceImmersion } from '../landing/ExperienceImmersion';
import { SceneMoteurProgres } from '../landing/SceneMoteurProgres';
import {
  SceneAutomatisation,
  SceneAgent,
  SceneGrow,
  SceneVerdict,
} from '../landing/ScenesImmersives';
import { LogoHorizontal } from '../systeme/Logo';
import { CurseurPersonnalise } from '../systeme/CurseurPersonnalise';
import { observerMoitiePage, suivre } from '../systeme/tracking';
import { BIENTOT, CTA_PRINCIPAL, PALETTE, REASSURANCE, SLOGAN } from '../systeme/palette';

const DEUX_ESPACES = [
  {
    cle: 'studio',
    eyebrow: '01 · Créer',
    titre: 'SORAHNEX Studio',
    texte:
      'Brief, script, storyboard, paramètres vérifiés, devis réel, génération suivie et montage. Un studio de production relié à de vrais outils.',
    points: ['Scripts et hooks IA', 'Catalogue vidéo vérifié', 'Devis avant génération', 'Montage et export'],
    icone: Clapperboard,
    teinte: PALETTE.magenta,
  },
  {
    cle: 'grow',
    eyebrow: '02 · Développer',
    titre: 'SORAHNEX Grow',
    texte:
      'Un cerveau commercial qui connaît votre entreprise, vos objectifs, vos produits et vos marchés — et transforme ces données en actions.',
    points: ['Mémoire par entreprise', 'Objectifs et priorités', 'Veille marché et concurrence', 'Prospects et opportunités'],
    icone: Brain,
    teinte: PALETTE.violet,
  },
  {
    cle: 'agent',
    eyebrow: '03 · Déléguer',
    titre: 'Agent IA',
    texte:
      'Un espace dédié : vous discutez, joignez vos fichiers, et l’agent propose des actions. Rien ne s’exécute sans votre validation.',
    points: ['Fichiers et images', 'Actions proposées', 'Validation avant exécution', 'Journal consultable'],
    icone: Sparkles,
    teinte: PALETTE.rose,
  },
] as const;

const FONCTIONNALITES = [
  { icone: Wand2, titre: 'Scripts UGC structurés', texte: 'Accroche, scènes, sous-titres et appel à l’action, versionnés dans votre historique.' },
  { icone: Layers3, titre: 'Catalogue vidéo réel', texte: 'Modèles, formats, durées et résolutions issus du catalogue fournisseur, sans option inventée.' },
  { icone: Coins, titre: 'Devis avant génération', texte: 'Le tarif fournisseur et le coût en crédits sont vérifiés côté serveur avant toute réservation.' },
  { icone: Brain, titre: 'Mémoire métier', texte: 'Chaque entreprise conserve son contexte : offre, cible, marché, objectifs et décisions.' },
  { icone: TrendingUp, titre: 'Pilotage commercial', texte: 'Objectifs, prospects, opportunités et plans d’action réunis dans un tableau de bord lisible.' },
  { icone: ShieldCheck, titre: 'Sécurité par conception', texte: 'Authentification Supabase, isolation par espace et clés fournisseur exclusivement serveur.' },
];

const ETAPES = [
  { numero: '01', titre: 'Décrivez votre entreprise', texte: 'Offre, cible, marché, objectifs et produits : SORAHNEX construit le contexte.' },
  { numero: '02', titre: 'L’IA analyse et propose', texte: 'Diagnostic, priorités et angles d’acquisition appuyés sur vos données réelles.' },
  { numero: '03', titre: 'Produisez vos contenus', texte: 'Scripts, publicités et vidéos UGC avec devis vérifié avant chaque génération.' },
  { numero: '04', titre: 'Mesurez et ajustez', texte: 'Suivez vos résultats, vos prospects et vos actions, puis adaptez la stratégie.' },
];

const FAQ = [
  { q: 'SORAHNEX génère-t-il réellement des vidéos ?', r: 'Oui. Les créations finalisées sont enregistrées dans votre bibliothèque privée. Le lecteur ne s’affiche qu’une fois le fichier vidéo réellement disponible.' },
  { q: 'Comment le devis fonctionne-t-il ?', r: 'Le devis est calculé côté serveur. Pour les modèles à tarification dynamique, SORAHNEX interroge l’endpoint de devis officiel du fournisseur et affiche le montant exact. Si ce montant ne peut pas être vérifié, le devis est indiqué comme indisponible : aucun prix n’est inventé.' },
  { q: 'Que se passe-t-il si un service est indisponible ?', r: 'La génération est bloquée tant que le service n’est pas rétabli. Les crédits réservés sont restitués en cas d’échec ou d’annulation autorisée.' },
  { q: 'Mes données sont-elles isolées ?', r: 'Chaque espace de travail est isolé et les clés techniques restent sécurisées côté serveur. Vos contenus et votre mémoire métier ne sont pas exposés aux autres espaces.' },
  { q: 'Les réseaux sociaux sont-ils connectés ?', r: 'Les connecteurs Meta (Facebook, Instagram), WhatsApp Business et Google sont préparés côté architecture. Ils restent désactivés et sont annoncés « Bientôt » tant qu’ils ne sont pas branchés.' },
];

/** Barre de navigation : logo recoloré, slogan, CTA unique. */
function Navigation() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.07] bg-[#05030A]/72 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6">
        <Link to="/" aria-label="SORAHNEX, accueil">
          <LogoHorizontal size={32} compact />
        </Link>
        <nav aria-label="Sections de la page" className="ml-6 hidden items-center gap-6 text-[13px] text-slate-300 lg:flex">
          <a href="#immersion" className="transition hover:text-white">Studio</a>
          <a href="#deux-espaces" className="transition hover:text-white">Les espaces</a>
          <a href="#fonctionnalites" className="transition hover:text-white">Fonctionnalités</a>
          <a href="#workflow" className="transition hover:text-white">Comment ça marche</a>
          <a href="#faq" className="transition hover:text-white">FAQ</a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link to="/connexion" className="hidden rounded-lg px-3 py-2 text-[13px] text-slate-300 transition hover:bg-white/[0.06] hover:text-white sm:inline-flex">
            Connexion
          </Link>
          <Link
            to="/inscription"
            onClick={() => suivre('cta_clic', { emplacement: 'nav' })}
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold text-white transition hover:brightness-110"
            style={{ background: `linear-gradient(96deg, ${PALETTE.magenta}, ${PALETTE.rose})` }}
          >
            {CTA_PRINCIPAL}
          </Link>
        </div>
      </div>
    </header>
  );
}

function SectionEspaces() {
  return (
    <section id="deux-espaces" className="relative scroll-mt-20 border-t border-white/[0.06] py-16 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: PALETTE.rose }}>
          Trois espaces, une seule plateforme
        </p>
        <h2 className="mt-3 max-w-2xl font-display text-[1.9rem] font-bold leading-[1.12] text-white sm:text-[2.5rem]">
          Créer, développer, déléguer — sans changer d’outil.
        </h2>
        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {DEUX_ESPACES.map(({ cle, eyebrow, titre, texte, points, icone: Icone, teinte }) => (
            <article key={cle} className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025] p-5 transition hover:border-white/20">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full opacity-40 blur-3xl transition group-hover:opacity-70"
                style={{ background: teinte }}
              />
              <span className="relative inline-grid h-10 w-10 place-items-center rounded-xl border border-white/10" style={{ background: `${teinte}22` }}>
                <Icone size={18} style={{ color: teinte }} />
              </span>
              <p className="relative mt-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">{eyebrow}</p>
              <h3 className="relative mt-1 font-display text-lg font-bold text-white">{titre}</h3>
              <p className="relative mt-2 text-[13.5px] leading-6 text-slate-400">{texte}</p>
              <ul className="relative mt-4 space-y-1.5 text-[12.5px] text-slate-300">
                {points.map((point) => (
                  <li key={point} className="flex items-start gap-1.5">
                    <Check size={13} className="mt-0.5 shrink-0" style={{ color: teinte }} />
                    {point}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionFonctionnalites() {
  return (
    <section id="fonctionnalites" className="scroll-mt-20 border-t border-white/[0.06] bg-[#06030B] py-16 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <h2 className="max-w-2xl font-display text-[1.9rem] font-bold leading-[1.12] text-white sm:text-[2.5rem]">
          Tout ce qu’il faut pour produire et piloter.
        </h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FONCTIONNALITES.map(({ icone: Icone, titre, texte }) => (
            <div key={titre} className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
              <Icone size={17} style={{ color: PALETTE.rose }} />
              <h3 className="mt-3 text-sm font-semibold text-white">{titre}</h3>
              <p className="mt-1.5 text-[13px] leading-6 text-slate-400">{texte}</p>
            </div>
          ))}
        </div>

        {/* « Bientôt » : aucune intégration non branchée n'est présentée comme acquise. */}
        <div data-testid="bientot-fonctionnalites" className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Bientôt disponible</p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {BIENTOT.map((nom) => (
              <li key={nom} className="rounded-full border border-white/10 px-3 py-1 text-[11.5px] text-slate-400">
                {nom}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] text-slate-500">
            Ces connexions sont préparées mais désactivées. Elles ne sont pas incluses aujourd’hui.
          </p>
        </div>
      </div>
    </section>
  );
}


/** Défis réels et réponses apportées — repris de la vitrine précédente. */
const DEFIS = [
  {
    espace: 'SORAHNEX Grow',
    teinte: PALETTE.violet,
    titre: 'Votre activité avance, mais vous n’avez pas le temps de la piloter.',
    intro: 'Les décisions importantes se prennent trop souvent sans vision claire de l’ensemble.',
    points: [
      { defi: 'Suivre et organiser les activités devient un travail à part entière.', reponse: 'L’assistant analyse vos données et structure un plan d’action priorisé, avec des jalons concrets.' },
      { defi: 'Les performances restent invisibles entre deux imprévus.', reponse: 'Le tableau de bord Croissance réunit objectifs, prospects et opportunités en un seul lieu.' },
      { defi: 'Les relances, les impayés et les litiges commerciaux se perdent.', reponse: 'L’assistant structure le suivi des encaissements, des relances et des litiges, étape par étape.' },
      { defi: 'Décider sans données, c’est risquer de se tromper de priorité.', reponse: 'Chaque recommandation s’appuie sur le contexte réel de votre entreprise : offre, marché, produits.' },
    ],
  },
  {
    espace: 'Studio UGC',
    teinte: PALETTE.magenta,
    titre: 'Produire du contenu régulier coûte trop cher et prend trop de temps.',
    intro: 'Entre le script, les scènes, la génération et le montage, chaque vidéo devient un projet.',
    points: [
      { defi: 'Écrire des scripts qui sonnent naturels prend des heures.', reponse: 'L’IA rédige des scripts UGC structurés : accroche, scènes, texte dit, sous-titres et appel à l’action.' },
      { defi: 'Chaque génération est un risque budgétaire en aveugle.', reponse: 'Le devis fournisseur est vérifié côté serveur avant toute réservation : aucun coût surprise.' },
      { defi: 'Les productions s’accumulent sans organisation.', reponse: 'Chaque projet garde son fil : scripts versionnés, bibliothèque privée, historique complet.' },
      { defi: 'Garder un rythme de publication régulier est le premier challenge.', reponse: 'Les scripts, hooks et visuels se préparent en minutes, pas en jours.' },
    ],
  },
] as const;

function SectionDefis() {
  return (
    <section id="defis" className="scroll-mt-20 border-t border-white/[0.06] bg-[#06030B] py-16 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: PALETTE.rose }}>
          Les défis que vous connaissez
        </p>
        <h2 className="mt-3 max-w-2xl font-display text-[1.9rem] font-bold leading-[1.12] text-white sm:text-[2.5rem]">
          Chaque jour, les mêmes obstacles
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">
          SORAHNEX est construit pour les résoudre — pas pour vous en donner une autre liste de fonctionnalités.
        </p>

        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          {DEFIS.map((bloc) => (
            <div key={bloc.espace} className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: bloc.teinte }}>
                {bloc.espace}
              </p>
              <h3 className="mt-2 text-base font-semibold leading-snug text-white">{bloc.titre}</h3>
              <p className="mt-2 text-[13px] leading-6 text-slate-400">{bloc.intro}</p>
              <ul className="mt-4 space-y-3">
                {bloc.points.map(({ defi, reponse }) => (
                  <li key={defi}>
                    <p className="text-[13px] font-medium text-slate-300">{defi}</p>
                    <p className="mt-1 flex items-start gap-1.5 text-[13px] leading-6 text-slate-400">
                      <Check size={13} className="mt-1 shrink-0" style={{ color: bloc.teinte }} />
                      {reponse}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionWorkflow() {
  return (
    <section id="workflow" className="scroll-mt-20 border-t border-white/[0.06] py-16 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <h2 className="max-w-2xl font-display text-[1.9rem] font-bold leading-[1.12] text-white sm:text-[2.5rem]">
          Quatre étapes, aucun détour.
        </h2>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ETAPES.map(({ numero, titre, texte }) => (
            <li key={numero} className="relative rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
              <span className="font-display text-2xl font-bold" style={{ color: PALETTE.magenta }}>{numero}</span>
              <h3 className="mt-2 text-sm font-semibold text-white">{titre}</h3>
              <p className="mt-1.5 text-[13px] leading-6 text-slate-400">{texte}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** Compteurs : uniquement des valeurs produit, jamais des résultats clients. */
function SectionCompteurs() {
  return (
    <section className="border-t border-white/[0.06] bg-[#06030B] py-14">
      <div className="mx-auto grid max-w-7xl gap-6 px-4 sm:grid-cols-3 sm:px-6">
        {[
          { valeur: 3, suffixe: '', label: 'espaces de travail, un seul compte' },
          { valeur: 1, suffixe: '', label: 'devis vérifié avant chaque génération' },
          { valeur: 0, suffixe: '', label: 'prix affiché sans source fournisseur' },
        ].map(({ valeur, suffixe, label }) => (
          <div key={label} className="text-center sm:text-left">
            <p className="font-display text-3xl font-bold text-white sm:text-4xl">
              <span data-compteur={valeur}>{valeur}</span>
              {suffixe}
            </p>
            <p className="mt-1.5 text-[13px] text-slate-400">{label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionFaq() {
  const [ouvert, setOuvert] = useState<number | null>(0);
  return (
    <section id="faq" className="scroll-mt-20 border-t border-white/[0.06] py-16 sm:py-24">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h2 className="text-center font-display text-[1.9rem] font-bold text-white sm:text-[2.3rem]">
          Questions fréquentes
        </h2>
        <div className="mt-9 space-y-2.5">
          {FAQ.map((item, index) => {
            const ouvertIci = ouvert === index;
            return (
              <div key={item.q} className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
                <button
                  type="button"
                  onClick={() => setOuvert(ouvertIci ? null : index)}
                  aria-expanded={ouvertIci}
                  className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left text-sm font-semibold text-white"
                >
                  {item.q}
                  <span className="transition" style={{ color: PALETTE.rose, transform: ouvertIci ? 'rotate(45deg)' : undefined }}>
                    +
                  </span>
                </button>
                {ouvertIci && <p className="px-5 pb-5 text-sm leading-relaxed text-slate-400">{item.r}</p>}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function SectionCtaFinale() {
  return (
    <section className="px-4 py-16 sm:px-6 sm:py-24">
      <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl border border-white/10 p-8 text-center sm:p-14"
        style={{ background: `radial-gradient(ellipse at 50% 0%, rgba(240,56,158,0.18), transparent 62%), #08040E` }}>
        <Zap size={24} className="mx-auto" style={{ color: PALETTE.orange }} />
        <h2 className="mx-auto mt-4 max-w-2xl font-display text-[1.9rem] font-bold text-white sm:text-[2.4rem]">
          Prêt à créer votre première vidéo ?
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm text-slate-300">
          Un compte, trois espaces. Le devis s’affiche avant chaque génération.
        </p>
        <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/inscription"
            onClick={() => suivre('cta_clic', { emplacement: 'cta_finale' })}
            className="btn inline-flex items-center gap-2 rounded-xl px-6 py-3.5 font-semibold text-white transition hover:brightness-110"
            style={{ background: `linear-gradient(96deg, ${PALETTE.magenta}, ${PALETTE.rose})` }}
          >
            {CTA_PRINCIPAL} <ArrowRight size={16} />
          </Link>
          <Link to="/connexion" className="btn inline-flex items-center rounded-xl border border-white/15 px-6 py-3.5 font-semibold text-white transition hover:bg-white/[0.06]">
            J’ai déjà un compte
          </Link>
        </div>
        <p className="mt-4 text-[12.5px] text-slate-400">{REASSURANCE}</p>
      </div>
    </section>
  );
}

function PiedDePage() {
  return (
    <footer className="relative overflow-hidden border-t border-white/[0.06] pt-10">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 text-xs text-slate-500 sm:flex-row sm:px-6">
        <LogoHorizontal size={30} />
        <div className="flex flex-wrap items-center justify-center gap-5">
          <Link to="/confidentialite" className="hover:text-white">Confidentialité</Link>
          <Link to="/conditions" className="hover:text-white">Conditions d’utilisation</Link>
          <Link to="/connexion" className="hover:text-white">Connexion</Link>
          <span className="flex items-center gap-1.5"><LockKeyhole size={12} /> UE</span>
        </div>
      </div>

      {/* Gros logo coupé en bas de l'écran, comme demandé. */}
      <p
        aria-hidden="true"
        className="pointer-events-none mt-10 select-none text-center font-display font-bold leading-[0.72]"
        style={{
          fontSize: 'clamp(3.5rem, 19vw, 16rem)',
          letterSpacing: '-0.02em',
          transform: 'translateY(28%)',
          backgroundImage: `linear-gradient(180deg, rgba(240,56,158,0.55), rgba(240,56,158,0.06))`,
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        }}
      >
        SORAHNEX
      </p>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 pb-6 text-[10px] text-slate-600 sm:px-6">
        <span>© {new Date().getFullYear()} SORAHNEX — {SLOGAN}</span>
        <Link to="/proprietaire" className="transition-colors hover:text-slate-400">Espace propriétaire</Link>
      </div>
    </footer>
  );
}

export default function LandingImmersive() {
  const racine = useRef<HTMLDivElement>(null);
  /*
   * Le défilement est piloté par `SceneMoteurProgres` (épinglage des scènes).
   * L'ancien `useScrollImmersif` a été retiré : il appliquait encore un
   * décalage aux panneaux et se battait avec le nouveau moteur — les textes
   * partaient à −88 px sur mobile. Deux moteurs de défilement, c'est un de trop.
   */

  // Mesure d'audience : un seul observateur, retiré au démontage.
  useEffect(() => observerMoitiePage(), []);

  // Le champ de saisie des CTA est le lien d'inscription : on mesure son focus
  // via la délégation, sans attacher un écouteur par bouton.
  useEffect(() => {
    const surFocus = (evenement: FocusEvent) => {
      const cible = evenement.target as HTMLElement | null;
      if (cible?.closest('a[href="/inscription"], a[href^="/inscription"], input')) {
        suivre('champ_focus', { emplacement: 'cta' });
      }
    };
    document.addEventListener('focusin', surFocus);
    return () => document.removeEventListener('focusin', surFocus);
  }, []);

  return (
    <>
      <CurseurPersonnalise />
    <div ref={racine} className="relative min-h-screen">
      <a
        href="#contenu"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-xl focus:bg-white focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-black"
      >
        Aller au contenu
      </a>

      <Navigation />

      <main id="contenu" className="pt-16">
        <SceneMoteurProgres>
          {/* Hero + Studio : une seule scène WebGL épinglée (voir ExperienceImmersion). */}
          <ExperienceImmersion />
          <SceneGrow />
          <SceneAgent />
          <SceneAutomatisation />
        </SceneMoteurProgres>

        {/* Les blocs classiques viennent APRÈS le récit, jamais à sa place. */}
        <SceneVerdict />
        <SectionEspaces />
        <SectionFonctionnalites />
        <SectionDefis />
        <SectionWorkflow />
        <SectionCompteurs />
        <SectionFaq />
        <SectionCtaFinale />
      </main>

      <PiedDePage />
    </div>
    </>
  );
}
