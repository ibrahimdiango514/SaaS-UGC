import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, ArrowUpRight, BadgeCheck, Brain, Check, Clapperboard, Coins, Database,
  Gauge, Layers3, LockKeyhole, Play, ShieldCheck, Sparkles, TrendingUp, Users, Wand2, Zap,
} from 'lucide-react';
import { BrandLockup } from '../components/Brand';
import { cn } from '../components/ui';

const DIMENSIONS = [
  {
    key: 'studio',
    eyebrow: '01 · Créer',
    title: 'VYORA Studio',
    text: 'Brief, script, storyboard, paramètres vérifiés, devis réel, génération suivie et montage. Un studio de production relié à de vrais outils.',
    image: '/studio-examples/cosmetique.jpg',
    icon: Clapperboard,
    points: ['Scripts et hooks IA', 'Catalogue vidéo vérifié', 'Devis avant génération', 'Montage et export'],
    accent: 'cyan',
    to: '/inscription',
  },
  {
    key: 'business',
    eyebrow: '02 · Développer',
    title: 'VYORA Business',
    text: 'Un cerveau commercial qui connaît votre entreprise, vos objectifs, vos produits et vos marchés — et transforme ces données en actions.',
    image: '/brand/vyora-growth.jpg',
    icon: Brain,
    points: ['Mémoire par entreprise', 'Objectifs et priorités', 'Veille marché et concurrence', 'Prospects et opportunités'],
    accent: 'violet',
    to: '/inscription',
  },
] as const;

const FEATURES = [
  { icon: Wand2, title: 'Scripts UGC structurés', text: 'Accroche, scènes, sous-titres et appel à l’action, versionnés dans votre historique.' },
  { icon: Layers3, title: 'Catalogue vidéo réel', text: 'Modèles, formats, durées et résolutions issus du catalogue fournisseur, sans option inventée.' },
  { icon: Coins, title: 'Devis avant génération', text: 'Le tarif fournisseur et le coût en crédits sont vérifiés côté serveur avant toute réservation.' },
  { icon: Brain, title: 'Mémoire métier', text: 'Chaque entreprise conserve son contexte : offre, cible, marché, objectifs et décisions.' },
  { icon: TrendingUp, title: 'Pilotage commercial', text: 'Objectifs, prospects, opportunités et plans d’action réunis dans un tableau de bord lisible.' },
  { icon: ShieldCheck, title: 'Sécurité par conception', text: 'Authentification Supabase, isolation par espace et clés fournisseur exclusivement serveur.' },
];

const STEPS = [
  { n: '01', title: 'Décrivez votre entreprise', text: 'Offre, cible, marché, objectifs et produits : VYORA construit le contexte.' },
  { n: '02', title: 'L’IA analyse et propose', text: 'Diagnostic, priorités et angles d’acquisition appuyés sur vos données réelles.' },
  { n: '03', title: 'Produisez vos contenus', text: 'Scripts, publicités et vidéos UGC avec devis vérifié avant chaque génération.' },
  { n: '04', title: 'Mesurez et ajustez', text: 'Suivez vos résultats, vos prospects et vos actions, puis adaptez la stratégie.' },
];

const PAINS = [
  {
    key: 'business',
    eyebrow: 'Business Grow',
    accent: 'violet' as const,
    title: 'Votre activité avance, mais vous n’avez pas le temps de la piloter.',
    intro: 'Les décisions importantes se prennent trop souvent sans vision claire de l’ensemble.',
    items: [
      { pain: 'Suivre et organiser les activités devient un travail à part entière.', fix: 'L’assistant Business Grow analyse vos données et structure un plan d’action priorisé, avec des jalons concrets.' },
      { pain: 'Les performances restent invisibles entre deux imprévus.', fix: 'Le tableau de bord Croissance réunit objectifs, prospects et opportunités en un seul lieu de travail.' },
      { pain: 'Les relances, les impayés et les litiges commerciaux se perdent.', fix: 'L’assistant structure le suivi des encaissements, des relances et des litiges, étape par étape.' },
      { pain: 'Des opportunités commerciales passent entre les mailles.', fix: 'Le CRM intégré fait remonter les prospects et les opportunités avant qu’ils n’échappent à votre contrôle.' },
      { pain: 'Décider sans données, c’est risquer de se tromper de priorité.', fix: 'Chaque recommandation s’appuie sur le contexte réel de votre entreprise : offre, marché, produits.' },
    ],
  },
  {
    key: 'studio',
    eyebrow: 'Studio UGC',
    accent: 'cyan' as const,
    title: 'Produire du contenu régulier coûte trop cher et prend trop de temps.',
    intro: 'Entre le script, les scènes, la génération et le montage, chaque vidéo devient un projet d’équipe.',
    items: [
      { pain: 'Écrire des scripts qui sonnent naturels prend des heures.', fix: 'L’IA rédige des scripts UGC structurés : accroche, scènes, texte dit, sous-titres et appel à l’action.' },
      { pain: 'La production vidéo suppose d’enchaîner des dizaines d’outils.', fix: 'Un seul studio : brief, script, catalogue vidéo vérifié, génération suivie et montage.' },
      { pain: 'Chaque génération est un risque budgétaire en aveugle.', fix: 'Le devis fournisseur est vérifié côté serveur avant toute réservation : aucun coût surprise.' },
      { pain: 'Les productions s’accumulent sans organisation.', fix: 'Chaque projet garde son fil : scripts versionnés, bibliothèque privée, historique complet.' },
      { pain: 'Garder un rythme de publication régulier est le premier challenge.', fix: 'Les scripts, hooks et visuels se préparent en minutes, pas en jours.' },
    ],
  },
];

const FAQ = [
  { q: 'VYORA génère-t-il réellement des vidéos ?', a: 'Oui. Les créations finalisées sont enregistrées dans votre bibliothèque privée. Le lecteur ne s’affiche qu’une fois le fichier vidéo réellement disponible.' },
  { q: 'Comment le devis fonctionne-t-il ?', a: 'Le devis est calculé côté serveur. Pour les modèles à tarification dynamique, VYORA interroge l’endpoint de devis officiel du fournisseur et affiche le montant exact en USD. Si ce montant ne peut pas être vérifié, le devis est indiqué comme indisponible : aucun prix n’est inventé.' },
  { q: 'Que se passe-t-il si un service est indisponible ?', a: 'La génération est bloquée tant que le service n’est pas rétabli. Les crédits réservés sont restitués en cas d’échec ou d’annulation autorisée.' },
  { q: 'Mes données sont-elles isolées ?', a: 'Chaque espace de travail est isolé et les clés techniques restent sécurisées côté serveur. Vos contenus et votre mémoire métier ne sont pas exposés aux autres espaces.' },
  { q: 'Les réseaux sociaux sont-ils connectés ?', a: 'Les connecteurs Facebook, Instagram, WhatsApp, YouTube, TikTok et Shopify sont préparés côté architecture. Ils restent désactivés tant que vous n’avez pas autorisé la connexion et que les secrets serveur ne sont pas configurés.' },
];

const TRUST = ['Un compte, deux espaces', 'Devis vérifié avant génération', 'Clés API côté serveur'];

/* B3 — Hero 3D (react-three/fiber) : chargé en lazy (chunk three.js séparé),
   avec repli systématique sur l'image statique si WebGL est absent, si le
   mouvement est réduit (accessibilité), ou si la scène échoue. */
const HeroScene = lazy(() => import('../components/HeroScene'));

class HeroSceneBoundary extends Component<{
  onFail: () => void;
  fallback: ReactNode;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFail(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

const HERO_HEIGHT_CLASSES = 'h-[380px] w-full sm:h-[440px] lg:h-[560px]';

function HeroVisual() {
  const [webgl, setWebgl] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [sceneFailed, setSceneFailed] = useState(false);

  useEffect(() => {
    try {
      const canvas = document.createElement('canvas');
      setWebgl(Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl')));
    } catch {
      setWebgl(false);
    }
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const staticImage = (
    <img
      src="/brand/vyora-hero.jpg"
      alt="Direction artistique VYORA : lumière, matière et profondeur"
      className={cn('object-cover object-center', HERO_HEIGHT_CLASSES)}
    />
  );

  if (!webgl || reducedMotion || sceneFailed) return staticImage;

  // L'image sert de fond pendant le chargement du chunk 3D et reste visible
  // derrière la scène (canvas transparent) : l'aurora flotte sur la DA.
  return (
    <div className={`relative ${HERO_HEIGHT_CLASSES}`}>
      <img
        src="/brand/vyora-hero.jpg"
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover object-center"
      />
      <HeroSceneBoundary onFail={() => setSceneFailed(true)} fallback={staticImage}>
        <Suspense fallback={null}>
          <HeroScene />
        </Suspense>
      </HeroSceneBoundary>
    </div>
  );
}

export default function Landing() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Nav */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.06] bg-[#05080e]/70 backdrop-blur-2xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Link to="/" aria-label="VYORA, accueil" className="flex items-center gap-2.5">
            <BrandLockup tagline />
          </Link>
          <nav className="ml-8 hidden items-center gap-7 text-[13px] text-slate-300 lg:flex">
            <a href="#dimensions" className="transition hover:text-white">Les deux espaces</a>
            <a href="#fonctionnalites" className="transition hover:text-white">Fonctionnalités</a>
            <a href="#workflow" className="transition hover:text-white">Comment ça marche</a>
            <a href="#defis" className="transition hover:text-white">Défis résolus</a>
            <a href="#faq" className="transition hover:text-white">FAQ</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/connexion" className="btn btn-ghost btn-sm hidden sm:inline-flex">Connexion</Link>
            <Link to="/inscription" className="btn btn-primary btn-sm vyora-btn-sheen">Commencer <ArrowRight size={14} /></Link>
          </div>
        </div>
      </header>

      <main className="pt-16">
        {/* ---------------------------------------------------------------- */}
        {/* Hero                                                              */}
        {/* ---------------------------------------------------------------- */}
        <section className="relative isolate overflow-hidden">
          <div aria-hidden="true" className="absolute inset-0 -z-20 bg-[#05080e]" />
          <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_16%_-10%,rgba(34,211,238,0.16),transparent_55%),radial-gradient(ellipse_at_92%_18%,rgba(139,92,246,0.16),transparent_52%)]" />
          <div aria-hidden="true" className="vyora-grid-bg absolute inset-0 -z-10 opacity-25" />
          <div aria-hidden="true" className="vyora-glow-ring -left-40 top-10 h-[28rem] w-[28rem] animate-aurora bg-cyan-400/20" />
          <div aria-hidden="true" className="vyora-glow-ring right-[-8rem] top-40 h-[26rem] w-[26rem] animate-aurora bg-violet-500/20" style={{ animationDelay: '-6s' }} />

          <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 pb-10 pt-14 sm:px-6 sm:pb-14 sm:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
            <div className="relative z-10 max-w-2xl">
              <div className="vyora-eyebrow animate-riseIn">
                <Sparkles size={13} /> Create. Evolve. Grow.
              </div>
              <h1 className="vyora-display mt-6 text-[2.6rem] leading-[1.02] text-white sm:text-[3.4rem] lg:text-[3.9rem]">
                Vos idées prennent forme.<br />
                <span className="bg-gradient-to-r from-cyan-200 via-white to-violet-300 bg-clip-text text-transparent">Votre activité prend de l’ampleur.</span>
              </h1>
              <p className="mt-6 max-w-xl text-[15px] leading-7 text-slate-300 sm:text-base sm:leading-8">
                VYORA réunit la création de contenus UGC et le pilotage de votre croissance dans une même plateforme. Deux espaces spécialisés, une seule intelligence nourrie par les données de votre entreprise.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link to="/inscription" className="btn btn-primary btn-lg vyora-btn-sheen">Découvrir VYORA <ArrowRight size={17} /></Link>
                <a href="#dimensions" className="btn btn-outline btn-lg"><Play size={15} /> Explorer la plateforme</a>
              </div>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-xs text-slate-300">
                {TRUST.map((item) => (
                  <span key={item} className="flex items-center gap-2"><BadgeCheck size={15} className="text-cyan-300" /> {item}</span>
                ))}
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-xl lg:max-w-none">
              <div aria-hidden="true" className="absolute -inset-6 rounded-[2.5rem] bg-gradient-to-br from-cyan-400/15 via-transparent to-violet-500/20 blur-2xl" />
              <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#080d15] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.95)]">
                <HeroVisual />
                <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(to_top,rgba(5,8,14,0.94),rgba(5,8,14,0.18)_58%,rgba(5,8,14,0.28))]" />
                <span className="absolute right-4 top-4 rounded-full border border-white/15 bg-[#05080e]/75 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-white backdrop-blur">
                  Créer · Développer
                </span>
                <div className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
                  <div className="rounded-2xl border border-white/10 bg-[#05080e]/85 p-3.5 backdrop-blur-xl">
                    <p className="text-[10px] uppercase tracking-[0.22em] text-cyan-200">VYORA · Studio &amp; Business</p>
                    <p className="mt-1 text-sm font-semibold text-white">Une seule mémoire, deux espaces de travail.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="relative mx-auto max-w-7xl px-4 pb-20 sm:px-6 sm:pb-24">
            {/* Floating product preview */}
            <div className="relative mt-16 sm:mt-20">
              <div className="pointer-events-none absolute -inset-x-10 -top-10 h-40 bg-gradient-to-b from-cyan-400/10 to-transparent blur-3xl" aria-hidden="true" />
              <div className="vyora-panel-hero animate-riseIn">
                <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3 sm:px-5">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-300/70" />
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
                    <span className="ml-3 text-[11px] text-slate-500">vyora.app/app/studio</span>
                  </div>
                  <span className="vyora-badge-soft"><Database size={10} /> Aperçu de l’interface</span>
                </div>
                <div className="grid gap-3 p-3 sm:grid-cols-[190px_minmax(0,1fr)_260px] sm:p-4">
                  <aside className="hidden rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3 sm:block">
                    {[
                      ['Tableau de bord', Gauge, true],
                      ['Studio UGC', Clapperboard, false],
                      ['Business Grow', Brain, false],
                      ['Bibliothèque', Sparkles, false],
                      ['Historique', TrendingUp, false],
                    ].map(([label, Icon, active]) => {
                      const ItemIcon = Icon as typeof Gauge;
                      return (
                        <div key={String(label)} className={cn('mb-1 flex items-center gap-2 rounded-xl px-2.5 py-2 text-[11px]', active ? 'bg-cyan-400/10 text-cyan-100 ring-1 ring-inset ring-cyan-300/20' : 'text-slate-400')}>
                          <ItemIcon size={13} /> {String(label)}
                        </div>
                      );
                    })}
                    <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 p-2.5">
                      <p className="text-[9px] uppercase tracking-wide text-slate-500">Crédits Studio</p>
                      <p className="mt-1 text-lg font-semibold text-white">120</p>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full w-2/3 rounded-full bg-gradient-to-r from-cyan-400 to-violet-400" /></div>
                    </div>
                  </aside>

                  <div className="space-y-3">
                    <div className="rounded-2xl border border-white/[0.07] bg-gradient-to-br from-cyan-400/[0.07] to-transparent p-3.5">
                      <p className="text-[9px] uppercase tracking-[0.18em] text-cyan-200">Studio UGC</p>
                      <p className="mt-1.5 text-sm font-semibold text-white">Publicité verticale · 15 s · 9:16</p>
                      <div className="mt-3 grid grid-cols-4 gap-1.5">
                        {[38, 62, 48, 78].map((h, i) => (
                          <div key={i} className="flex h-16 items-end overflow-hidden rounded-lg bg-black/30">
                            <div className="w-full rounded-t-md bg-gradient-to-t from-cyan-500/50 to-cyan-300/80" style={{ height: `${h}%` }} />
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[9px] text-slate-400">
                        {['Script validé', '3 scènes', 'Sous-titres', 'CTA'].map((tag) => (
                          <span key={tag} className="rounded-md border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5">{tag}</span>
                        ))}
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                        <p className="text-[9px] uppercase tracking-wide text-slate-500">Devis fournisseur</p>
                        <p className="mt-1 text-sm font-semibold text-white">Vérifié côté serveur</p>
                        <p className="mt-1 text-[9px] text-slate-500">Aucune génération sans devis</p>
                      </div>
                      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                        <p className="text-[9px] uppercase tracking-wide text-slate-500">Business Grow</p>
                        <p className="mt-1 text-sm font-semibold text-white">Contexte entreprise</p>
                        <p className="mt-1 text-[9px] text-slate-500">Mémoire métier consentie</p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-semibold text-white">Croissance</p>
                      <span className="vyora-badge-soft"><TrendingUp size={10} /> Suivi</span>
                    </div>
                    <div className="mt-3 flex h-24 items-end gap-1.5">
                      {[26, 40, 32, 52, 44, 68, 58, 82, 74, 92].map((h, i) => (
                        <div key={i} className="flex-1 rounded-t bg-gradient-to-t from-violet-500/30 to-cyan-300/70" style={{ height: `${h}%` }} />
                      ))}
                    </div>
                    <div className="mt-3 space-y-1.5">
                      {['Objectifs actifs', 'Prospects suivis', 'Actions planifiées'].map((label, i) => (
                        <div key={label} className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-black/20 px-2 py-1.5 text-[9px] text-slate-400">
                          <span>{label}</span><span className="font-semibold text-slate-200">{['—', '—', '—'][i]}</span>
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-[8px] leading-snug text-slate-600">Aperçu illustratif : aucun chiffre client réel n’est affiché.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Dimensions                                                        */}
        {/* ---------------------------------------------------------------- */}
        <section id="dimensions" className="mx-auto max-w-7xl scroll-mt-24 px-4 pb-8 pt-16 sm:px-6 sm:pt-24">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-200">Une identité. Deux dimensions.</p>
              <h2 className="vyora-display mt-3 max-w-xl text-3xl text-white sm:text-4xl">Tout avance mieux, ensemble.</h2>
            </div>
            <p className="max-w-md text-sm leading-relaxed text-slate-400">Passez naturellement de la création de vos contenus au pilotage de votre croissance. Votre compte, vos données, votre espace.</p>
          </div>

          <div className="mt-9 grid gap-4 lg:grid-cols-2">
            {DIMENSIONS.map((dimension) => {
              const Icon = dimension.icon;
              const cyan = dimension.accent === 'cyan';
              return (
                <article key={dimension.key} className="vyora-card vyora-card-hover group">
                  <div className="relative h-56 overflow-hidden sm:h-64">
                    <img src={dimension.image} alt="" aria-hidden="true" className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.04]" />
                    <div className="absolute inset-0 bg-gradient-to-t from-[#080d15] via-[#080d15]/30 to-transparent" />
                    <span className={cn('absolute left-5 top-5 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] backdrop-blur', cyan ? 'border-cyan-300/25 bg-cyan-400/10 text-cyan-100' : 'border-violet-300/25 bg-violet-400/10 text-violet-100')}>
                      <Icon size={12} /> {dimension.eyebrow}
                    </span>
                  </div>
                  <div className="relative -mt-14 p-5 sm:p-6">
                    <h3 className="vyora-display text-2xl text-white">{dimension.title}</h3>
                    <p className="mt-2 max-w-lg text-sm leading-relaxed text-slate-400">{dimension.text}</p>
                    <ul className="mt-4 grid gap-1.5 sm:grid-cols-2">
                      {dimension.points.map((point) => (
                        <li key={point} className="flex items-center gap-2 text-[12px] text-slate-300">
                          <span className={cn('grid h-4 w-4 place-items-center rounded-full', cyan ? 'bg-cyan-400/15 text-cyan-200' : 'bg-violet-400/15 text-violet-200')}><Check size={10} /></span>
                          {point}
                        </li>
                      ))}
                    </ul>
                    <Link to={dimension.to} className={cn('mt-5 inline-flex items-center gap-1.5 text-[12px] font-semibold transition', cyan ? 'text-cyan-200 hover:text-cyan-100' : 'text-violet-200 hover:text-violet-100')}>
                      Découvrir cet espace <ArrowUpRight size={13} />
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Features                                                          */}
        {/* ---------------------------------------------------------------- */}
        <section id="fonctionnalites" className="mx-auto max-w-7xl scroll-mt-24 px-4 py-16 sm:px-6 sm:py-24">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-200">La plateforme</p>
            <h2 className="vyora-display mt-3 text-3xl text-white sm:text-4xl">Tout le cycle, de l’idée au résultat</h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-400">Chaque étape est reliée à des services réels et à votre base de données. Rien n’est simulé.</p>
          </div>
          <div className="mt-11 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <article key={feature.title} className={cn('vyora-card vyora-card-hover p-5 sm:p-6', index === 0 && 'lg:row-span-1')}>
                  <div className="flex items-start justify-between">
                    <div className="grid h-11 w-11 place-items-center rounded-xl border border-cyan-300/20 bg-cyan-400/[0.08] text-cyan-200">
                      <Icon size={19} />
                    </div>
                    <span className="text-[10px] font-semibold text-white/15">0{index + 1}</span>
                  </div>
                  <h3 className="mt-4 text-[15px] font-semibold text-white">{feature.title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-slate-400">{feature.text}</p>
                </article>
              );
            })}
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Workflow                                                          */}
        {/* ---------------------------------------------------------------- */}
        <section id="workflow" className="relative scroll-mt-24 border-y border-white/[0.06] bg-[#060a11] py-16 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-violet-200">Workflow</p>
                <h2 className="vyora-display mt-3 text-3xl text-white sm:text-4xl">Quatre étapes, une seule plateforme</h2>
              </div>
              <Link to="/inscription" className="btn btn-outline btn-md">Lancer mon premier projet <ArrowRight size={15} /></Link>
            </div>
            <div className="mt-10 grid gap-3 md:grid-cols-4">
              {STEPS.map((step, index) => (
                <div key={step.n} className="relative rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
                  {index < STEPS.length - 1 && (
                    <span aria-hidden="true" className="absolute -right-1.5 top-9 hidden h-px w-3 bg-white/15 md:block" />
                  )}
                  <span className="font-display text-3xl font-bold text-white/10">{step.n}</span>
                  <h3 className="mt-2 text-sm font-semibold text-white">{step.title}</h3>
                  <p className="mt-2 text-xs leading-relaxed text-slate-400">{step.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Défis résolus (les vrais problèmes des utilisateurs)             */}
        {/* ---------------------------------------------------------------- */}
        <section id="defis" className="relative scroll-mt-24 border-y border-white/[0.06] bg-[#060a11] py-16 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-violet-200">Les défis que vous connaissez</p>
              <h2 className="vyora-display mt-3 text-3xl text-white sm:text-4xl">Chaque jour, les mêmes obstacles</h2>
              <p className="mt-3 text-sm leading-relaxed text-slate-400">VYORA est construit pour les résoudre — pas pour vous en donner une autre liste de fonctionnalités.</p>
            </div>
            <div className="mt-11 grid gap-4 lg:grid-cols-2">
              {PAINS.map((block) => {
                const violet = block.accent === 'violet';
                return (
                  <article key={block.key} className="vyora-card p-6 sm:p-7">
                    <span className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]',
                      violet ? 'border-violet-300/25 bg-violet-400/10 text-violet-100' : 'border-cyan-300/25 bg-cyan-400/10 text-cyan-100')}>
                      {violet ? <Brain size={12} /> : <Clapperboard size={12} />} {block.eyebrow}
                    </span>
                    <h3 className="vyora-display mt-4 text-xl text-white">{block.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">{block.intro}</p>
                    <ul className="mt-5 space-y-3">
                      {block.items.map((item) => (
                        <li key={item.pain} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
                          <p className="text-[13px] font-medium text-slate-200">{item.pain}</p>
                          <p className={cn('mt-1.5 flex items-start gap-2 text-xs leading-relaxed', violet ? 'text-violet-100/80' : 'text-cyan-100/80')}>
                            <Check size={13} className="mt-0.5 shrink-0" /> {item.fix}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* FAQ                                                               */}
        {/* ---------------------------------------------------------------- */}
        <section id="faq" className="scroll-mt-24 border-t border-white/[0.06] bg-[#060a11] py-16 sm:py-24">
          <div className="mx-auto max-w-3xl px-4 sm:px-6">
            <h2 className="vyora-display text-center text-3xl text-white sm:text-4xl">Questions fréquentes</h2>
            <div className="mt-10 space-y-2.5">
              {FAQ.map((item, index) => {
                const open = openFaq === index;
                return (
                  <div key={item.q} className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02]">
                    <button
                      type="button"
                      onClick={() => setOpenFaq(open ? null : index)}
                      aria-expanded={open}
                      className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left text-sm font-semibold text-white"
                    >
                      {item.q}
                      <span className={cn('text-cyan-300 transition', open && 'rotate-45')}>+</span>
                    </button>
                    {open && <p className="px-5 pb-5 text-sm leading-relaxed text-slate-400">{item.a}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* CTA                                                               */}
        {/* ---------------------------------------------------------------- */}
        <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24">
          <div className="relative isolate overflow-hidden rounded-[2rem] border border-cyan-300/20 bg-[#070d16] p-8 text-center sm:p-16">
            <img src="/brand/vyora-hero.jpg" alt="" aria-hidden="true" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-25" />
            <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-br from-[#05080e]/90 via-[#05080e]/70 to-violet-900/40" />
            <div aria-hidden="true" className="vyora-glow-ring left-1/4 top-0 h-56 w-56 animate-pulseGlow bg-cyan-400/25" />
            <Zap className="mx-auto text-cyan-200" size={26} />
            <h2 className="vyora-display mx-auto mt-5 max-w-2xl text-3xl text-white sm:text-4xl">Prêt à faire grandir votre activité ?</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-300">Un seul espace pour créer vos contenus, comprendre votre marché et développer vos ventes avec VYORA.</p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Link to="/inscription" className="btn btn-primary btn-lg vyora-btn-sheen">Créer mon compte <ArrowRight size={17} /></Link>
              <Link to="/connexion" className="btn btn-outline btn-lg">J’ai déjà un compte</Link>
            </div>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[11px] text-slate-400">
              <span className="flex items-center gap-1.5"><Users size={12} /> Espaces isolés</span>
              <span className="flex items-center gap-1.5"><LockKeyhole size={12} /> Données hébergées dans l’UE</span>
              <span className="flex items-center gap-1.5"><ShieldCheck size={12} /> Aucun résultat fictif</span>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 text-xs text-slate-500 sm:flex-row sm:px-6">
          <div className="flex items-center gap-3"><BrandLockup tagline /> <span className="hidden text-slate-600 sm:inline">One platform. Two dimensions.</span></div>
          <div className="flex flex-wrap items-center gap-5">
            <Link to="/confidentialite" className="hover:text-white">Confidentialité</Link>
            <Link to="/conditions" className="hover:text-white">Conditions d’utilisation</Link>
            <Link to="/connexion" className="hover:text-white">Connexion</Link>
            <span className="flex items-center gap-1.5"><LockKeyhole size={12} /> UE</span>
          </div>
        </div>
        <div className="mx-auto mt-5 flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 text-[10px] text-slate-600 sm:px-6">
          <span>© {new Date().getFullYear()} VYORA — Create. Evolve. Grow.</span>
          <Link to="/proprietaire" className="transition-colors hover:text-slate-400">Espace propriétaire</Link>
        </div>
      </footer>
    </div>
  );
}
