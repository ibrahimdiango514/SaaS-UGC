import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, ArrowUpRight, BadgeCheck, Bot, Brain, Check, Clapperboard,
  Coins, CreditCard, EyeOff, FileText, FileWarning, Layers3, LockKeyhole, Menu,
  MessageSquare, Plus, RefreshCw, ShieldCheck, ShoppingCart, Sparkles, Target,
  TrendingUp, UserMinus, Users, Wand2, X, Zap, type LucideIcon,
} from 'lucide-react';
import { listPlans } from '../lib/api';
import { formatMoney } from '../lib/format';
import type { Plan } from '../lib/types';
import { BrandLockup, BrandSymbol } from '../components/Brand';
import { LoadingState, cn } from '../components/ui';
import { Reveal, RotatingText, WordReveal } from '../components/landing/motion';
import {
  ArrowRightIcon, EcosystemFlow, GrowthShowcase, HeroConsole, SectionBadge,
  StudioShowcase, TrustStrip,
} from '../components/landing/visuals';

/* -------------------------------------------------------------------------- */
/* Contenus                                                                    */
/* -------------------------------------------------------------------------- */

const NAV_LINKS = [
  { href: '#studio', label: 'Studio' },
  { href: '#business', label: 'Business Growth' },
  { href: '#ecosysteme', label: 'Écosystème' },
  { href: '#tarifs', label: 'Tarifs' },
  { href: '#faq', label: 'FAQ' },
];

const ROTATING = [
  'créer des contenus qui attirent.',
  'développer votre activité.',
  'structurer votre croissance.',
  'ne plus perdre d’opportunités.',
];

const STUDIO_FEATURES = [
  { icon: Clapperboard, title: 'Vidéos UGC & publicités', text: 'Format vertical, accroche, scènes et appel à l’action.' },
  { icon: Sparkles, title: 'Produit mis en scène', text: 'Animez une image produit importée (image → vidéo).' },
  { icon: Wand2, title: 'Scripts & hooks IA', text: 'Accroche, scènes, sous-titres et CTA générés puis modifiables.' },
  { icon: Coins, title: 'Catalogue & devis vérifiés', text: 'Modèle réel, tarif fournisseur et coût en crédits avant génération.' },
  { icon: Layers3, title: 'Montage & export', text: 'Timeline, sous-titres, voix off importée, export vidéo et .srt.' },
  { icon: LockKeyhole, title: 'Bibliothèque privée', text: 'Vidéos conservées dans un espace privé et rattachées à vos projets.' },
];

const BUSINESS_FEATURES = [
  { icon: Bot, title: 'Agent IA Business', text: 'Conversation avec mémoire consentie, ancrée dans votre contexte.' },
  { icon: Users, title: 'Prospects & pipeline', text: 'De prospect à gagné : étapes, relances et historique au même endroit.' },
  { icon: Target, title: 'Objectifs & plan 30/60/90', text: 'Priorités, progression et actions concrètes.' },
  { icon: TrendingUp, title: 'Marché & concurrence', text: 'Concurrents, signaux et lecture des opportunités.' },
  { icon: Layers3, title: 'Catalogue produits', text: 'Produits, offres et prix réels, saisis ou importés.' },
  { icon: FileText, title: 'Briefs marketing → Studio', text: 'Un brief vidéo à valider, puis à ouvrir dans Studio — sans débit.' },
];

const PROBLEMS: {
  icon: LucideIcon;
  tag: string;
  title: string;
  detail: string;
  solution: string;
  tone: 'cyan' | 'violet' | 'amber';
}[] = [
  {
    icon: MessageSquare,
    tag: 'Prospect',
    title: 'Le message resté sans réponse',
    detail: 'Un prospect intéressé attend. Le temps passe, l’opportunité s’éteint en silence.',
    solution: 'Un pipeline avec étapes, relances et historique pour garder une prochaine action visible.',
    tone: 'cyan',
  },
  {
    icon: FileWarning,
    tag: 'Suivi',
    title: 'Le dossier qui dort',
    detail: 'Une prestation terminée, une relance oubliée, une trésorerie sous tension.',
    solution: 'Gardez les dossiers, les échanges et les actions au même endroit pour ne plus laisser une affaire sans suite.',
    tone: 'amber',
  },
  {
    icon: UserMinus,
    tag: 'Fidélisation',
    title: 'Le client qui ne revient plus',
    detail: 'Un client satisfait disparaît faute de suivi ou d’attention.',
    solution: 'Analysez votre base et préparez une campagne de réactivation soumise à votre validation.',
    tone: 'violet',
  },
  {
    icon: ShoppingCart,
    tag: 'Vente',
    title: 'La commande abandonnée',
    detail: 'Un produit suscite l’intérêt, mais l’acheteur repart sans finaliser.',
    solution: 'Remettez le produit en scène avec une vidéo Studio conçue pour capter l’attention.',
    tone: 'cyan',
  },
  {
    icon: EyeOff,
    tag: 'Visibilité',
    title: 'Le produit invisible',
    detail: 'Un bon produit reste noyé dans un flux saturé de contenus.',
    solution: 'Transformez une image produit en vidéo publicitaire verticale, prête à être publiée.',
    tone: 'violet',
  },
  {
    icon: RefreshCw,
    tag: 'Temps',
    title: 'Les tâches qui se répètent',
    detail: 'Relances, briefs, reportings : les mêmes gestes chaque semaine.',
    solution: 'L’agent prépare plans d’action et briefs. Vous approuvez ou rejetez — rien ne s’exécute seul.',
    tone: 'amber',
  },
];

const STEPS = [
  { n: '01', title: 'Créez votre compte', text: 'Un compte VYORA, un espace de travail isolé et sécurisé.' },
  { n: '02', title: 'Choisissez votre espace', text: 'Studio pour créer, Business Growth pour développer. Aucun mélange.' },
  { n: '03', title: 'Produisez ou analysez', text: 'Une vidéo avec devis vérifié, ou un plan d’action appuyé sur vos données.' },
  { n: '04', title: 'Décidez et avancez', text: 'Vous validez chaque action. VYORA conserve l’historique.' },
];

const FAQ = [
  {
    q: 'Quelle est la différence entre VYORA Studio et Business Growth ?',
    a: 'Studio est l’espace de création : scripts, vidéos UGC et publicités, montage, bibliothèque. Business Growth est l’espace de pilotage : contexte d’entreprise, objectifs, marché, prospects, stratégie et agent IA. Les deux partagent un compte, jamais leurs données ni leurs quotas.',
  },
  {
    q: 'VYORA génère-t-il réellement des vidéos ?',
    a: 'Oui. Les créations finalisées sont enregistrées dans votre bibliothèque privée. Le lecteur ne s’affiche qu’une fois le fichier vidéo réellement disponible.',
  },
  {
    q: 'Comment le devis fonctionne-t-il ?',
    a: 'Le devis est calculé côté serveur. Pour les modèles à tarification dynamique, VYORA interroge l’endpoint de devis officiel du fournisseur et affiche le montant exact. Si ce montant ne peut pas être vérifié, le devis est indiqué comme indisponible : aucun prix n’est inventé.',
  },
  {
    q: 'Business Growth utilise-t-il mes crédits Studio ?',
    a: 'Non. Business Growth dispose de ses propres quotas et ne lit ni ne débite le portefeuille Studio. Un brief transféré vers Studio ne consomme aucun crédit ; la génération lancée dans Studio utilise vos crédits Studio et votre formule.',
  },
  {
    q: 'Puis-je créer une vidéo depuis Business Growth ?',
    a: 'L’agent prépare un brief (produit, angle, accroche, cible). Après votre validation, vous l’ouvrez dans Studio pour le produire. La création pilotée depuis Business Growth est destinée aux abonnés Business Growth lorsque la facturation de cet espace sera officiellement activée ; les droits d’accès actuels restent inchangés.',
  },
  {
    q: 'Que se passe-t-il si un service est indisponible ?',
    a: 'La génération est bloquée tant que le service n’est pas rétabli. Les crédits réservés sont restitués en cas d’échec ou d’annulation autorisée.',
  },
  {
    q: 'Mes données sont-elles isolées ?',
    a: 'Chaque espace de travail est isolé et les clés techniques restent sécurisées côté serveur. Vos contenus, vos prospects et votre mémoire métier ne sont pas exposés aux autres espaces.',
  },
  {
    q: 'Les réseaux sociaux sont-ils connectés ?',
    a: 'Les connecteurs Facebook, Instagram, YouTube, TikTok, Shopify et WooCommerce sont préparés côté architecture. Ils restent désactivés tant que les secrets serveur ne sont pas configurés.',
  },
];

const STUDIO_INSPIRATIONS = [
  { src: '/studio-examples/cosmetique.jpg', label: 'Beauté' },
  { src: '/studio-examples/mode.jpg', label: 'Mode' },
  { src: '/studio-examples/food.jpg', label: 'Food' },
  { src: '/studio-examples/tech.jpg', label: 'Tech' },
];

/* -------------------------------------------------------------------------- */
/* En-tête et pied de page                                                     */
/* -------------------------------------------------------------------------- */

function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && headerRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <>
      {open && (
        <div
          aria-hidden="true"
          className="fixed inset-0 top-16 z-40 bg-[#04070d]/70 backdrop-blur-sm lg:hidden"
        />
      )}

      <header
        ref={headerRef}
      className={cn(
        'fixed inset-x-0 top-0 z-50 border-b transition-colors duration-300',
        scrolled || open
          ? 'border-white/[0.08] bg-[#04070d]/[0.92] backdrop-blur-2xl'
          : 'border-transparent bg-[#04070d]/[0.55] backdrop-blur-xl',
      )}
    >
      <div className="landing-shell flex h-16 items-center gap-3">
        <Link to="/" aria-label="VYORA, accueil" className="flex shrink-0 items-center">
          <BrandLockup tagline />
        </Link>

        <nav aria-label="Navigation principale" className="ml-6 hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-[12.5px] font-medium text-slate-300 transition hover:bg-white/[0.05] hover:text-white"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link to="/connexion" className="hidden rounded-lg px-3 py-2 text-[12.5px] font-medium text-slate-300 transition hover:bg-white/[0.05] hover:text-white sm:inline-flex">
            Connexion
          </Link>
          <Link to="/inscription" className="btn btn-primary btn-sm landing-shine hidden sm:inline-flex">
            Créer mon compte
          </Link>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="landing-mobile-menu"
            aria-label={open ? 'Fermer le menu' : 'Ouvrir le menu'}
            className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-200 lg:hidden"
          >
            {open ? <X size={19} /> : <Menu size={19} />}
          </button>
        </div>
      </div>

      {open && (
        <div id="landing-mobile-menu" className="border-t border-white/[0.07] bg-[#04070d]/[0.97] px-4 pb-5 pt-3 lg:hidden">
          <nav aria-label="Navigation mobile" className="grid gap-1">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="flex min-h-[44px] items-center justify-between rounded-xl px-3 text-sm font-medium text-slate-200 hover:bg-white/[0.05]"
              >
                {link.label} <ArrowRight size={14} className="text-slate-500" />
              </a>
            ))}
          </nav>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Link to="/connexion" onClick={() => setOpen(false)} className="btn btn-outline btn-md">Connexion</Link>
            <Link to="/inscription" onClick={() => setOpen(false)} className="btn btn-primary btn-md">Créer un compte</Link>
          </div>
        </div>
      )}
      </header>
    </>
  );
}

function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-white/[0.06] bg-[#03060b]">
      <div className="landing-shell py-12 sm:py-14">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="min-w-0">
            <BrandLockup tagline symbolSize={38} />
            <p className="mt-4 max-w-xs text-[12.5px] leading-relaxed text-slate-400">
              Deux espaces intelligents, un seul écosystème. Créez des contenus, développez votre activité,
              gardez la maîtrise de vos données.
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              <a href="#studio" className="landing-chip transition hover:text-white"><Clapperboard size={10} className="text-cyan-300" /> Studio</a>
              <a href="#business" className="landing-chip transition hover:text-white"><Brain size={10} className="text-violet-300" /> Business Growth</a>
            </div>
          </div>

          <nav aria-label="VYORA Studio" className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200/80">VYORA Studio</p>
            <ul className="mt-3 space-y-2 text-[12.5px] text-slate-400">
              <li><Link to="/app/studio" className="transition hover:text-white">Ouvrir le Studio</Link></li>
              <li><Link to="/app/projets" className="transition hover:text-white">Projets</Link></li>
              <li><Link to="/app/bibliotheque" className="transition hover:text-white">Bibliothèque</Link></li>
              <li><a href="#tarifs" className="transition hover:text-white">Formules Studio</a></li>
            </ul>
          </nav>

          <nav aria-label="VYORA Business Growth" className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-200/80">Business Growth</p>
            <ul className="mt-3 space-y-2 text-[12.5px] text-slate-400">
              <li><Link to="/app/business" className="transition hover:text-white">Ouvrir Business Growth</Link></li>
              <li><Link to="/app/business/abonnement" className="transition hover:text-white">Formules Business Growth</Link></li>
              <li><a href="#ecosysteme" className="transition hover:text-white">Le lien avec Studio</a></li>
              <li><Link to="/app/parametres" className="transition hover:text-white">Compte et données</Link></li>
            </ul>
          </nav>

          <nav aria-label="Informations" className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-300">Informations</p>
            <ul className="mt-3 space-y-2 text-[12.5px] text-slate-400">
              <li><a href="#problemes" className="transition hover:text-white">Ce que VYORA résout</a></li>
              <li><a href="#tarifs" className="transition hover:text-white">Tarifs</a></li>
              <li><a href="#faq" className="transition hover:text-white">FAQ</a></li>
              <li><Link to="/confidentialite" className="transition hover:text-white">Confidentialité</Link></li>
              <li><Link to="/conditions" className="transition hover:text-white">Conditions d’utilisation</Link></li>
              <li><Link to="/connexion" className="transition hover:text-white">Connexion</Link></li>
            </ul>
          </nav>
        </div>

        <div className="landing-rule mt-10" />
        <div className="mt-5 flex flex-col items-start justify-between gap-3 text-[10.5px] text-slate-500 sm:flex-row sm:items-center">
          <span>© {year} VYORA — Create. Evolve. Grow.</span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="inline-flex items-center gap-1"><LockKeyhole size={11} /> Données isolées</span>
            <span className="inline-flex items-center gap-1"><ShieldCheck size={11} /> Clés côté serveur</span>
            <Link to="/proprietaire" className="transition hover:text-slate-300">Espace propriétaire</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function Landing() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState('');
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const loadPlans = useCallback(() => {
    setPlansLoading(true);
    setPlansError('');
    return listPlans()
      .then((result) => setPlans(result))
      .catch(() => {
        setPlans([]);
        setPlansError('Les formules ne peuvent pas être chargées pour le moment.');
      })
      .finally(() => setPlansLoading(false));
  }, []);

  useEffect(() => { void loadPlans(); }, [loadPlans]);

  return (
    <div className="landing-root">
      <a
        href="#contenu"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-xl focus:bg-cyan-400 focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-[#03131a]"
      >
        Aller au contenu
      </a>

      <SiteHeader />

      <main id="contenu" className="pt-16">
        {/* ------------------------------------------------------------------ */}
        {/* Hero                                                                */}
        {/* ------------------------------------------------------------------ */}
        <section className="relative isolate overflow-hidden" aria-labelledby="hero-title">
          <div aria-hidden="true" className="absolute inset-0 -z-30 bg-[#04070d]" />
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-20 bg-[radial-gradient(ellipse_at_12%_-8%,rgba(34,211,238,0.17),transparent_54%),radial-gradient(ellipse_at_94%_12%,rgba(139,92,246,0.17),transparent_52%),radial-gradient(ellipse_at_50%_100%,rgba(8,145,178,0.08),transparent_60%)]"
          />
          <div aria-hidden="true" className="landing-grid-bg absolute inset-0 -z-20 opacity-60" />
          <div aria-hidden="true" className="landing-aurora vyora-glow-pulse -left-32 top-8 -z-10 h-[26rem] w-[26rem] bg-cyan-400/20" />
          <div aria-hidden="true" className="landing-aurora vyora-glow-pulse -right-24 top-40 -z-10 h-[24rem] w-[24rem] bg-violet-500/20" style={{ animationDelay: '-4s' }} />

          <div className="landing-shell relative grid items-center gap-10 pb-14 pt-12 sm:pb-16 sm:pt-16 lg:grid-cols-[1.03fr_0.97fr] lg:gap-12 lg:pb-24 lg:pt-20">
            <div className="relative z-10 min-w-0 max-w-[640px]">
              <div className="vyora-eyebrow">
                <Sparkles size={12} /> VYORA · L’écosystème IA
              </div>

              <h1 id="hero-title" className="landing-h1 mt-5">
                <WordReveal text="L’intelligence artificielle" />{' '}
                <span className="vyora-line-reveal mt-1 block">
                  <span className="bg-gradient-to-r from-cyan-200 via-white to-violet-300 bg-clip-text text-transparent">
                    qui fait grandir vos ambitions.
                  </span>
                </span>
              </h1>

              <p className="landing-lead mt-5 max-w-[560px]">
                Créez des contenus qui attirent. Développez votre activité. Gagnez du temps sur ce qui se
                répète. Ne laissez plus filer vos opportunités. Deux espaces intelligents, un seul écosystème.
              </p>

              <div className="mt-4 flex min-h-[1.7rem] flex-wrap items-baseline gap-x-1.5 text-[13px] text-slate-500">
                <span>VYORA vous aide à</span>
                <RotatingText items={ROTATING} className="font-semibold text-cyan-100" />
              </div>

              <div className="mt-7 flex flex-wrap items-center gap-2.5">
                <a href="#univers" className="btn btn-primary btn-lg landing-shine w-full sm:w-auto">
                  Découvrir VYORA <ArrowRightIcon />
                </a>
                <Link to="/inscription" className="btn btn-outline btn-lg w-full sm:w-auto">
                  Créer mon compte
                </Link>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-slate-400">
                <span className="inline-flex items-center gap-1.5"><BadgeCheck size={13} className="text-cyan-300" /> Devis vérifié avant génération</span>
                <span className="inline-flex items-center gap-1.5"><LockKeyhole size={13} className="text-cyan-300" /> Clés API côté serveur</span>
                <span className="inline-flex items-center gap-1.5"><ShieldCheck size={13} className="text-cyan-300" /> Espaces isolés</span>
              </div>

              <p className="mt-5 text-[11.5px] text-slate-500">
                Déjà un compte ?{' '}
                <Link to="/connexion" className="font-semibold text-slate-300 underline-offset-4 transition hover:text-white hover:underline">
                  Se connecter
                </Link>
              </p>
            </div>

            <div className="relative z-0 mt-1 min-w-0 lg:mt-0">
              <HeroConsole />
            </div>
          </div>

          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#04070d] to-transparent" />
        </section>

        <TrustStrip />

        {/* ------------------------------------------------------------------ */}
        {/* Deux univers — index                                                */}
        {/* ------------------------------------------------------------------ */}
        <section id="univers" className="landing-shell scroll-mt-24 py-16 sm:py-20">
          <div className="grid items-end gap-6 lg:grid-cols-[0.92fr_1.08fr]">
            <Reveal>
              <SectionBadge icon={Sparkles} tone="neutral">Deux univers, une même exigence</SectionBadge>
              <h2 className="landing-h2 mt-4 max-w-xl">
                Un compte.{' '}
                <span className="bg-gradient-to-r from-cyan-200 to-violet-300 bg-clip-text text-transparent">
                  Deux espaces spécialisés.
                </span>
              </h2>
            </Reveal>
            <Reveal delay={80}>
              <p className="landing-lead max-w-2xl lg:pb-1">
                VYORA n’est pas un tableau de bord fourre-tout. Studio sert à créer. Business Growth sert à
                développer. Chacun garde son interface, ses données et ses quotas — et vous passez de l’un à
                l’autre avec le même compte.
              </p>
            </Reveal>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {[
              {
                href: '#studio', icon: Clapperboard, index: '01', label: 'Créer',
                title: 'VYORA Studio',
                text: 'Vidéos UGC, publicités, produits mis en scène, montage et bibliothèque privée.',
                tone: 'cyan' as const,
              },
              {
                href: '#business', icon: Brain, index: '02', label: 'Développer',
                title: 'VYORA Business Growth',
                text: 'Agent IA, prospects, objectifs, marché, stratégie et briefs marketing.',
                tone: 'violet' as const,
              },
            ].map((item, index) => {
              const Icon = item.icon;
              const cyan = item.tone === 'cyan';
              return (
                <Reveal key={item.title} delay={index * 80}>
                  <a
                    href={item.href}
                    className={cn(
                      'group relative flex h-full items-start gap-3 overflow-hidden rounded-2xl border p-4 transition duration-300 hover:-translate-y-1 sm:p-5',
                      cyan
                        ? 'border-cyan-300/15 bg-cyan-400/[0.04] hover:border-cyan-300/35'
                        : 'border-violet-300/15 bg-violet-400/[0.05] hover:border-violet-300/35',
                    )}
                  >
                    <span
                      className={cn(
                        'grid h-11 w-11 shrink-0 place-items-center rounded-xl border',
                        cyan ? 'border-cyan-300/25 bg-cyan-400/10 text-cyan-200' : 'border-violet-300/25 bg-violet-400/10 text-violet-200',
                      )}
                    >
                      <Icon size={19} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-display text-[10px] font-bold tracking-[0.2em] text-slate-500">{item.index}</span>
                        <span className={cn('text-[9px] font-semibold uppercase tracking-[0.18em]', cyan ? 'text-cyan-200/80' : 'text-violet-200/80')}>
                          {item.label}
                        </span>
                      </span>
                      <span className="mt-1 block font-display text-lg font-semibold text-white">{item.title}</span>
                      <span className="mt-1 block text-[12.5px] leading-relaxed text-slate-400">{item.text}</span>
                      <span className={cn('mt-3 inline-flex items-center gap-1.5 text-[11.5px] font-semibold', cyan ? 'text-cyan-200' : 'text-violet-200')}>
                        Explorer cet espace <ArrowUpRight size={12} className="transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                      </span>
                    </span>
                  </a>
                </Reveal>
              );
            })}
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* VYORA Studio                                                        */}
        {/* ------------------------------------------------------------------ */}
        <section id="studio" aria-labelledby="studio-title" className="relative scroll-mt-24 overflow-hidden border-y border-white/[0.06] py-16 sm:py-24">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_18%_35%,rgba(34,211,238,0.09),transparent_58%)]" />
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/25 to-transparent" />

          <div className="landing-shell grid items-center gap-10 lg:grid-cols-[1.04fr_0.96fr] lg:gap-12">
            <Reveal className="order-2 mx-auto w-full min-w-0 max-w-[600px] lg:order-1 lg:max-w-none">
              <StudioShowcase />
            </Reveal>

            <Reveal className="order-1 min-w-0 lg:order-2" delay={90}>
              <SectionBadge icon={Clapperboard} tone="cyan">01 · Créer — VYORA Studio</SectionBadge>
              <h2 id="studio-title" className="landing-h2 mt-4">
                Transformez vos idées et vos produits en vidéos qui attirent l’attention.
              </h2>
              <p className="landing-lead mt-4">
                Un studio de création assisté par IA : brief, script, plan de production, choix du modèle,
                devis vérifié, génération suivie, montage et export. Chaque étape s’appuie sur un outil réel —
                rien n’est simulé.
              </p>

              <ul className="mt-6 grid gap-2 sm:grid-cols-2">
                {STUDIO_FEATURES.map((feature) => {
                  const Icon = feature.icon;
                  return (
                    <li key={feature.title} className="flex items-start gap-2.5 rounded-xl border border-cyan-300/10 bg-cyan-400/[0.035] p-2.5">
                      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-cyan-300/20 bg-cyan-400/10 text-cyan-200">
                        <Icon size={12} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[12px] font-semibold text-white">{feature.title}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-slate-400">{feature.text}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-6 flex flex-wrap items-center gap-2.5">
                <Link to="/app/studio" className="btn btn-primary btn-md landing-shine w-full sm:w-auto">
                  Découvrir VYORA Studio <ArrowRightIcon />
                </Link>
                <Link to="/inscription" className="btn btn-outline btn-md w-full sm:w-auto">Créer mon compte</Link>
                <a href="#tarifs" className="landing-link px-1 text-cyan-200 hover:text-cyan-100">
                  Voir les formules <ArrowUpRight size={12} />
                </a>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-2.5">
                <span className="text-[10px] uppercase tracking-[0.16em] text-slate-600">Inspirations</span>
                {STUDIO_INSPIRATIONS.map((item) => (
                  <span key={item.label} className="group relative h-[68px] w-[50px] overflow-hidden rounded-lg border border-white/10">
                    <img
                      src={item.src}
                      alt={`Direction visuelle ${item.label} pour une vidéo UGC`}
                      className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                      loading="lazy"
                      decoding="async"
                    />
                    <span className="absolute inset-x-0 bottom-0 bg-black/65 px-1 py-0.5 text-center text-[7.5px] font-medium text-white backdrop-blur-sm">
                      {item.label}
                    </span>
                  </span>
                ))}
                <span className="max-w-[190px] text-[9.5px] leading-snug text-slate-500">
                  Exemples de directions visuelles. Vos vidéos dépendent du catalogue réellement disponible.
                </span>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* VYORA Business Growth                                               */}
        {/* ------------------------------------------------------------------ */}
        <section id="business" aria-labelledby="business-title" className="relative scroll-mt-24 overflow-hidden py-16 sm:py-24">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_82%_35%,rgba(139,92,246,0.1),transparent_58%)]" />

          <div className="landing-shell grid items-center gap-10 lg:grid-cols-[0.96fr_1.04fr] lg:gap-12">
            <Reveal className="min-w-0">
              <SectionBadge icon={Brain} tone="violet">02 · Développer — Business Growth</SectionBadge>
              <h2 id="business-title" className="landing-h2 mt-4">
                Ne laissez plus votre entreprise perdre des clients, du temps et de l’argent.
              </h2>
              <p className="landing-lead mt-4">
                Business Growth réunit votre contexte d’entreprise, vos objectifs, votre catalogue, votre
                marché et vos prospects dans un espace intelligent. Son agent vous aide à décider, préparer et
                suivre — vous gardez la main sur chaque action.
              </p>

              <ul className="mt-6 grid gap-2 sm:grid-cols-2">
                {BUSINESS_FEATURES.map((feature) => {
                  const Icon = feature.icon;
                  return (
                    <li key={feature.title} className="flex items-start gap-2.5 rounded-xl border border-violet-300/10 bg-violet-400/[0.04] p-2.5">
                      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-violet-300/20 bg-violet-400/10 text-violet-200">
                        <Icon size={12} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[12px] font-semibold text-white">{feature.title}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-slate-400">{feature.text}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-6 flex flex-wrap items-center gap-2.5">
                <Link to="/app/business" className="btn btn-primary btn-md landing-shine w-full sm:w-auto">
                  Découvrir Business Growth <ArrowRightIcon />
                </Link>
                <Link to="/app/business/abonnement" className="btn btn-outline btn-md w-full sm:w-auto">
                  Voir les formules
                </Link>
              </div>

              <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-slate-400">
                <ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-300" />
                Quotas Business Growth distincts des crédits Studio. Aucun débit Studio depuis Business Growth.
              </p>
            </Reveal>

            <Reveal className="mx-auto w-full min-w-0 max-w-[640px] lg:max-w-none" delay={90}>
              <GrowthShowcase />
            </Reveal>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Problèmes résolus                                                   */}
        {/* ------------------------------------------------------------------ */}
        <section id="problemes" aria-labelledby="problemes-title" className="relative scroll-mt-24 border-y border-white/[0.06] bg-[#050810] py-16 sm:py-24">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(34,211,238,0.07),transparent_55%)]" />
          <div className="landing-shell relative">
            <Reveal className="mx-auto max-w-2xl text-center">
              <SectionBadge icon={AlertTriangle} tone="neutral">Le quotidien des entrepreneurs</SectionBadge>
              <h2 id="problemes-title" className="landing-h2 mt-4">
                Votre entreprise mérite mieux que de perdre des opportunités.
              </h2>
              <p className="landing-lead mt-4">
                Un message sans réponse, une relance oubliée, un produit invisible : les pertes ne font pas de
                bruit. VYORA relie les informations et prépare les actions — vous décidez de la suite.
              </p>
            </Reveal>

            <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {PROBLEMS.map((problem, index) => {
                const Icon = problem.icon;
                const tone = problem.tone;
                return (
                  <Reveal key={problem.title} delay={(index % 3) * 70} className="h-full">
                    <article className="landing-problem group flex h-full flex-col">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'grid h-9 w-9 place-items-center rounded-xl border',
                            tone === 'cyan' && 'border-cyan-300/20 bg-cyan-400/[0.08] text-cyan-200',
                            tone === 'violet' && 'border-violet-300/20 bg-violet-400/[0.08] text-violet-200',
                            tone === 'amber' && 'border-amber-300/20 bg-amber-400/[0.08] text-amber-200',
                          )}
                        >
                          <Icon size={16} />
                        </span>
                        <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">{problem.tag}</span>
                      </div>

                      <h3 className="mt-3 text-[14px] font-semibold leading-snug text-white">{problem.title}</h3>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-slate-400">{problem.detail}</p>

                      <div className="mt-4 flex-1 rounded-xl border border-white/[0.06] bg-black/20 p-3">
                        <p className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.15em] text-slate-500">
                          <Zap size={10} className="text-cyan-300" /> Ce que VYORA apporte
                        </p>
                        <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-300">{problem.solution}</p>
                      </div>
                    </article>
                  </Reveal>
                );
              })}
            </div>

            <Reveal delay={80}>
              <div className="mt-8 flex flex-col items-start justify-between gap-4 rounded-2xl border border-white/[0.09] bg-white/[0.03] p-5 sm:flex-row sm:items-center">
                <div className="max-w-2xl">
                  <p className="text-[13px] font-semibold text-white">Pas de promesse magique.</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-slate-400">
                    VYORA ne garantit aucun résultat commercial. Les propositions de l’IA restent soumises à
                    votre validation et dépendent de vos données, de votre marché et de votre exécution.
                  </p>
                </div>
                <Link to="/inscription" className="btn btn-primary btn-md landing-shine w-full shrink-0 sm:w-auto">
                  Commencer avec VYORA <ArrowRightIcon />
                </Link>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Écosystème                                                          */}
        {/* ------------------------------------------------------------------ */}
        <section id="ecosysteme" aria-labelledby="ecosysteme-title" className="landing-shell scroll-mt-24 py-16 sm:py-24">
          <Reveal className="mx-auto max-w-3xl text-center">
            <SectionBadge icon={Layers3} tone="neutral">Deux espaces, un écosystème</SectionBadge>
            <h2 id="ecosysteme-title" className="landing-h2 mt-4">
              Studio crée. Business Growth prépare. <span className="text-slate-400">Vous décidez.</span>
            </h2>
            <p className="landing-lead mt-4">
              Les deux espaces restent distincts. Une seule passerelle : un brief vidéo préparé par Business
              Growth, validé par vous, puis ouvert dans Studio. Les crédits et les fichiers restent ceux du
              Studio.
            </p>
          </Reveal>

          <Reveal className="mt-10" delay={80}>
            <EcosystemFlow />
          </Reveal>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Démarrage                                                           */}
        {/* ------------------------------------------------------------------ */}
        <section className="border-y border-white/[0.06] bg-[#050810] py-16 sm:py-20">
          <div className="landing-shell">
            <Reveal className="flex flex-wrap items-end justify-between gap-5">
              <div>
                <SectionBadge icon={Zap} tone="neutral">Comment démarrer</SectionBadge>
                <h2 className="landing-h2 mt-4">Quatre étapes, aucun détour.</h2>
              </div>
              <Link to="/inscription" className="btn btn-outline btn-md">
                Créer mon compte <ArrowRightIcon />
              </Link>
            </Reveal>

            <div className="mt-9 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, index) => (
                <Reveal key={step.n} delay={index * 70} className="h-full">
                  <article className="relative h-full rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
                    <div className="flex items-center justify-between">
                      <span className="font-display text-2xl font-bold text-white/10">{step.n}</span>
                      <span className="grid h-6 w-6 place-items-center rounded-full border border-cyan-300/20 bg-cyan-400/[0.08] text-cyan-200">
                        <Check size={11} />
                      </span>
                    </div>
                    <h3 className="mt-2 text-[13px] font-semibold text-white">{step.title}</h3>
                    <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-400">{step.text}</p>
                  </article>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Tarifs                                                              */}
        {/* ------------------------------------------------------------------ */}
        <section id="tarifs" className="landing-shell scroll-mt-24 py-16 sm:py-24">
          <Reveal className="mx-auto max-w-2xl text-center">
            <SectionBadge icon={CreditCard} tone="cyan">Tarifs Studio</SectionBadge>
            <h2 className="landing-h2 mt-4">Des formules claires, un catalogue serveur.</h2>
            <p className="landing-lead mt-4">
              Les formules et quotas Studio ci-dessous proviennent de la base VYORA. Aucun prix n’est inventé :
              ce qui n’est pas disponible n’est pas affiché.
            </p>
          </Reveal>

          {plansLoading && <LoadingState label="Chargement des formules…" />}

          {!plansLoading && plansError && (
            <div className="mx-auto mt-10 max-w-md rounded-2xl border border-rose-400/25 bg-rose-400/[0.06] p-4 text-center">
              <p className="text-sm text-rose-100">{plansError}</p>
              <button type="button" onClick={() => { void loadPlans(); }} className="btn btn-outline btn-sm mt-3">
                Réessayer
              </button>
            </div>
          )}

          {!plansLoading && !plansError && plans.length === 0 && (
            <p className="mt-10 text-center text-sm text-slate-400">
              Les formules seront affichées dès que le catalogue sera disponible.
            </p>
          )}

          {!plansLoading && !plansError && plans.length > 0 && (
            <div className="mt-10 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {plans.map((plan, index) => {
                const highlighted = plan.plan_key === 'studio';
                return (
                  <Reveal key={plan.plan_key} delay={index * 60} className="h-full">
                    <article className={cn('landing-plan h-full', highlighted && 'landing-plan-featured')}>
                      {highlighted && (
                        <span className="absolute right-4 top-4 rounded-full border border-cyan-300/25 bg-cyan-400/15 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-cyan-100">
                          Le plus choisi
                        </span>
                      )}
                      <h3 className="font-display text-lg font-semibold text-white">{plan.display_name}</h3>
                      <p className="mt-1 min-h-[2.2rem] text-[11.5px] leading-relaxed text-slate-400">
                        {(plan.tagline ?? '').replace(/\bReelora\b/gi, 'VYORA')}
                      </p>
                      <p className="mt-4 text-[1.7rem] font-semibold tracking-[-0.03em] text-white">
                        {plan.monthly_price_minor === 0 ? 'Gratuit' : formatMoney(plan.monthly_price_minor, plan.currency)}
                        {plan.monthly_price_minor > 0 && <span className="text-[13px] font-normal text-slate-500"> / mois</span>}
                      </p>
                      <ul className="mt-4 flex-1 space-y-2">
                        {plan.features.map((feature) => (
                          <li key={feature} className="flex items-start gap-2 text-[11.5px] leading-snug text-slate-300">
                            <Check size={13} className="mt-0.5 shrink-0 text-emerald-400" />
                            {feature.replace(/\bReelora\b/gi, 'VYORA')}
                          </li>
                        ))}
                      </ul>
                      <div className="mt-4 rounded-lg border border-white/[0.07] bg-black/20 px-3 py-2 text-[10.5px] leading-relaxed text-slate-400">
                        {plan.max_projects} projets · {plan.max_videos_per_month} vidéos/mois · {plan.max_scripts_per_month} scripts/mois
                      </div>
                      <Link
                        to="/inscription"
                        className={cn('btn btn-md mt-4 w-full', highlighted ? 'btn-primary landing-shine' : 'btn-outline')}
                      >
                        Choisir {plan.display_name}
                      </Link>
                    </article>
                  </Reveal>
                );
              })}
            </div>
          )}

          <Reveal delay={80}>
            <div className="mt-4 flex flex-col items-start justify-between gap-4 rounded-2xl border border-violet-300/15 bg-violet-400/[0.05] p-4 sm:flex-row sm:items-center sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-violet-300/25 bg-violet-400/10 text-violet-200">
                  <Brain size={16} />
                </span>
                <div>
                  <p className="text-[12.5px] font-semibold text-white">Business Growth : formules dédiées</p>
                  <p className="mt-1 max-w-xl text-[11.5px] leading-relaxed text-slate-400">
                    Quotas et facturation propres à Business Growth, indépendants du Studio. Les formules
                    s’affichent uniquement lorsque le catalogue serveur les rend disponibles.
                  </p>
                </div>
              </div>
              <Link to="/app/business/abonnement" className="btn btn-outline btn-sm shrink-0">
                Voir les formules Business Growth <ArrowUpRight size={13} />
              </Link>
            </div>
          </Reveal>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* FAQ                                                                 */}
        {/* ------------------------------------------------------------------ */}
        <section id="faq" className="scroll-mt-24 border-y border-white/[0.06] bg-[#050810] py-16 sm:py-24">
          <div className="landing-shell">
            <Reveal className="mx-auto max-w-2xl text-center">
              <SectionBadge icon={MessageSquare} tone="neutral">Questions fréquentes</SectionBadge>
              <h2 className="landing-h2 mt-4">Tout ce qu’il faut savoir avant de commencer.</h2>
            </Reveal>

            <div className="mx-auto mt-9 max-w-3xl space-y-2">
              {FAQ.map((item, index) => {
                const open = openFaq === index;
                const panelId = `faq-panel-${index}`;
                return (
                  <Reveal key={item.q} delay={Math.min(index, 4) * 40}>
                    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
                      <button
                        type="button"
                        onClick={() => setOpenFaq(open ? null : index)}
                        aria-expanded={open}
                        aria-controls={panelId}
                        className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3.5 text-left text-[13px] font-semibold text-white sm:px-5"
                      >
                        <span className="min-w-0">{item.q}</span>
                        <Plus
                          size={15}
                          className={cn('shrink-0 text-cyan-300 transition-transform duration-300', open && 'rotate-45')}
                        />
                      </button>
                      <div id={panelId} hidden={!open}>
                        <p className="px-4 pb-4 text-[12.5px] leading-relaxed text-slate-400 sm:px-5">{item.a}</p>
                      </div>
                    </div>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Appel à l’action final                                              */}
        {/* ------------------------------------------------------------------ */}
        <section className="landing-shell py-16 sm:py-24">
          <Reveal>
            <div className="relative isolate overflow-hidden rounded-[2rem] border border-cyan-300/20 bg-[#060b14] px-5 py-12 text-center sm:px-12 sm:py-16">
              <img
                src="/brand/vyora-cta.jpg"
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 -z-20 h-full w-full object-cover opacity-55"
                loading="lazy"
                decoding="async"
              />
              <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,#05080f_10%,rgba(5,8,15,0.82)_55%,rgba(5,8,15,0.55))]" />
              <div aria-hidden="true" className="landing-aurora vyora-glow-pulse left-1/4 top-0 -z-10 h-56 w-56 bg-cyan-400/25" />
              <div aria-hidden="true" className="landing-aurora vyora-glow-pulse bottom-0 right-1/4 -z-10 h-56 w-56 bg-violet-500/25" style={{ animationDelay: '-5s' }} />

              <BrandSymbol size={44} className="mx-auto" />
              <h2 className="landing-h2 mx-auto mt-5 max-w-2xl">Votre prochaine étape commence avec VYORA.</h2>
              <p className="mx-auto mt-4 max-w-xl text-[14px] leading-relaxed text-slate-300 sm:text-[15px]">
                Donnez à vos idées les moyens de prendre forme et à votre entreprise les moyens de grandir.
              </p>

              <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
                <Link to="/inscription" className="btn btn-primary btn-lg landing-shine w-full sm:w-auto">
                  Créer mon compte <ArrowRightIcon />
                </Link>
                <Link to="/app/studio" className="btn btn-outline btn-lg w-full sm:w-auto">Explorer VYORA Studio</Link>
                <Link to="/app/business" className="btn btn-outline btn-lg w-full sm:w-auto">Découvrir Business Growth</Link>
              </div>

              <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[10.5px] text-slate-400">
                <span className="inline-flex items-center gap-1.5"><Users size={12} /> Un compte, deux espaces</span>
                <span className="inline-flex items-center gap-1.5"><LockKeyhole size={12} /> Données isolées</span>
                <span className="inline-flex items-center gap-1.5"><ShieldCheck size={12} /> Aucun résultat fictif</span>
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
