import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, BadgeCheck, Brain, Check, Clapperboard, Coins,
  LockKeyhole, Play, ShieldCheck, Sparkles, Users, Wand2, Zap,
} from 'lucide-react';
import { listPlans } from '../lib/api';
import { formatMoney } from '../lib/format';
import type { Plan } from '../lib/types';
import { BrandLockup } from '../components/Brand';
import { Card, LoadingState, cn } from '../components/ui';

const FEATURES = [
  { icon: Wand2, title: 'Scripts IA en français', text: 'Générez des scripts UGC structurés (accroche, scènes, CTA), puis gardez chaque version dans l’historique.' },
  { icon: Users, title: 'Avatars & voix', text: 'Gérez vos avatars, voix et images de référence pour chaque campagne.' },
  { icon: Clapperboard, title: 'UGC Studio', text: 'Réglez durée, format, style, sous-titres et scènes avant de lancer une vraie génération vidéo.' },
  { icon: Sparkles, title: 'Bibliothèque & historique', text: 'Retrouvez chaque vidéo terminée, ses métadonnées, les événements de production et les mouvements de crédits.' },
  { icon: Coins, title: 'Crédits & quotas maîtrisés', text: 'Réservation, consommation et restitution automatiques des crédits, avec limites par formule.' },
  { icon: ShieldCheck, title: 'Sécurité par conception', text: 'Authentification Supabase, RLS sur chaque table, clés d’API uniquement côté serveur.' },
];

const STEPS = [
  { n: '01', title: 'Décrivez votre produit', text: 'Brief, audience, plateforme, objectif et ton.' },
  { n: '02', title: 'L’IA écrit le script', text: 'Accroche, scènes, sous-titres et appel à l’action.' },
  { n: '03', title: 'Choisissez l’avatar', text: 'Voix, style, format et paramètres vidéo.' },
  { n: '04', title: 'Générez & publiez', text: 'Suivi en temps réel, puis vidéo dans la bibliothèque.' },
];

const FAQ = [
  { q: 'VYORA génère-t-il réellement des vidéos ?', a: 'Oui. Les créations finalisées sont enregistrées dans votre bibliothèque privée. Le lecteur ne s’affiche qu’une fois le fichier vidéo réellement disponible.' },
  { q: 'Que se passe-t-il si un service est indisponible ?', a: 'La génération est bloquée tant que le service n’est pas rétabli. Les crédits réservés sont restitués en cas d’échec ou d’annulation autorisée.' },
  { q: 'Mes données sont-elles isolées ?', a: 'Chaque espace de travail est isolé et les clés techniques restent sécurisées côté serveur. Vos contenus ne sont pas exposés aux autres espaces.' },
  { q: 'Comment fonctionnent les crédits ?', a: 'Le coût estimé est affiché avant confirmation. Chaque service a un coût en crédits, réservé au lancement, consommé uniquement en cas de succès et restitué en cas d’échec, d’expiration ou d’annulation. Une clé d’idempotence empêche tout double débit.' },
];

export default function Landing() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  useEffect(() => {
    let active = true;
    listPlans().then((p) => { if (active) setPlans(p); })
      .catch(() => { if (active) setPlans([]); })
      .finally(() => { if (active) setPlansLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <div className="min-h-screen overflow-hidden">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-line bg-ink/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandLockup tagline />
          </Link>
          <nav className="ml-8 hidden items-center gap-6 text-sm text-slate-400 md:flex">
            <a href="#fonctionnalites" className="hover:text-white">Fonctionnalités</a>
            <a href="#workflow" className="hover:text-white">Comment ça marche</a>
            <a href="#tarifs" className="hover:text-white">Tarifs</a>
            <a href="#faq" className="hover:text-white">FAQ</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/connexion" className="btn btn-ghost btn-sm hidden sm:inline-flex">Connexion</Link>
            <Link to="/inscription" className="btn btn-primary btn-sm">Commencer <ArrowRight size={14} /></Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative mx-auto max-w-7xl px-4 pb-24 pt-16 sm:px-6 sm:pt-24 lg:pb-28">
        <div aria-hidden="true" className="pointer-events-none absolute -left-48 top-0 h-[34rem] w-[34rem] rounded-full bg-cyan-400/[0.06] blur-[120px]" />
        <div aria-hidden="true" className="pointer-events-none absolute right-0 top-24 h-96 w-96 rounded-full bg-violet-500/[0.06] blur-[110px]" />
        <div className="relative grid items-center gap-14 lg:grid-cols-[1.02fr_.98fr]">
          <div className="animate-fadeUp lg:py-8">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/[0.06] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-100">
              <Sparkles size={13} /> Create. Evolve. Grow.
            </div>
            <h1 className="mt-7 max-w-2xl text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.055em] text-white sm:text-6xl lg:text-[4.35rem]">
              Vos idées prennent forme. <span className="gradient-text">Votre activité prend de l’ampleur.</span>
            </h1>
            <p className="mt-7 max-w-xl text-base leading-7 text-slate-300 sm:text-lg sm:leading-8">
              VYORA réunit la création de contenus et le développement de votre activité grâce à l’intelligence artificielle. Deux dimensions complémentaires, un seul espace de travail.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link to="/inscription" className="btn btn-primary btn-lg">Découvrir VYORA <ArrowRight size={17} /></Link>
              <a href="#dimensions" className="btn btn-outline btn-lg"><Play size={16} /> Explorer les deux espaces</a>
            </div>
            <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-3 text-xs text-slate-400">
              {['Un compte partagé', 'Des espaces spécialisés', 'Des quotas indépendants'].map((x) => (
                <span key={x} className="flex items-center gap-2"><BadgeCheck size={15} className="text-cyan-300" /> {x}</span>
              ))}
            </div>
          </div>

          <div className="relative animate-fadeUp">
            <div className="grid grid-cols-[1fr_.72fr] items-center gap-3 sm:gap-4">
              <figure className="group relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#141b24] shadow-2xl">
                <img src="/studio-examples/cosmetique.jpg" alt="Visuel d’inspiration pour la création de contenu beauté" className="aspect-[.8] w-full object-cover transition duration-700 group-hover:scale-[1.025]" />
                <div className="absolute inset-0 bg-gradient-to-t from-[#090d12] via-transparent to-black/10" />
                <figcaption className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Dimension créative</span>
                  <p className="mt-1.5 font-display text-lg font-medium text-white sm:text-xl">Imaginez. Produisez. Publiez.</p>
                  <p className="mt-1 text-[11px] text-slate-300">Studio UGC · Scripts · Montage</p>
                </figcaption>
              </figure>
              <div className="space-y-3 sm:space-y-4">
                <div className="rounded-2xl border border-white/10 bg-[#101721] p-3 sm:p-4">
                  <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-violet-200"><Brain size={14} /> Business</div>
                  <div aria-hidden="true" className="relative mt-4 h-[92px] overflow-hidden rounded-xl bg-[radial-gradient(ellipse_at_55%_80%,rgba(139,92,246,.2),transparent_65%),linear-gradient(145deg,#161525,#10151e)] sm:h-28">
                    <svg viewBox="0 0 220 112" className="absolute inset-0 h-full w-full" fill="none">
                      <path d="M12 91h196M20 78c26-3 32-32 58-28s29 23 53 5 35 1 73-36" stroke="url(#growth-line)" strokeWidth="2" />
                      <path d="M20 78c26-3 32-32 58-28s29 23 53 5 35 1 73-36v73H20V78Z" fill="url(#growth-fill)" />
                      <circle cx="204" cy="19" r="4" fill="#C4B5FD" />
                      <defs>
                        <linearGradient id="growth-line" x1="20" y1="66" x2="204" y2="19" gradientUnits="userSpaceOnUse"><stop stopColor="#A78BFA" stopOpacity=".4"/><stop offset="1" stopColor="#67E8F9"/></linearGradient>
                        <linearGradient id="growth-fill" x1="112" y1="20" x2="112" y2="98" gradientUnits="userSpaceOnUse"><stop stopColor="#8B5CF6" stopOpacity=".2"/><stop offset="1" stopColor="#8B5CF6" stopOpacity="0"/></linearGradient>
                      </defs>
                    </svg>
                    <span className="absolute bottom-2 left-2 text-[9px] text-slate-500">Visualisation illustrative</span>
                  </div>
                  <p className="mt-3 font-display text-sm font-medium text-white">Analysez. Décidez. Développez.</p>
                  <p className="mt-1 text-[10px] text-slate-400">Assistant IA · Mémoire métier · Actions</p>
                </div>
                <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.05] p-3 sm:p-4">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-cyan-100">Une même plateforme</p>
                  <p className="mt-1.5 font-display text-xs font-medium text-white sm:text-sm">One platform. Two dimensions.</p>
                  <p className="mt-1 text-[10px] text-slate-400">Infinite possibilities.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="dimensions" className="mx-auto max-w-7xl scroll-mt-24 px-4 pb-16 sm:px-6">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-200">Une identité. Deux dimensions.</p>
            <h2 className="mt-2 font-display text-2xl font-medium tracking-tight text-white sm:text-3xl">Tout avance mieux, ensemble.</h2>
          </div>
          <p className="max-w-md text-sm leading-relaxed text-slate-400">Passez naturellement de la création de vos contenus au pilotage de votre croissance. Votre compte, vos données, votre espace.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <article className="flex min-h-[170px] items-center gap-5 rounded-2xl border border-cyan-200/15 bg-gradient-to-r from-cyan-300/[0.07] to-transparent p-5 sm:p-7">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-cyan-200/20 bg-cyan-200/[0.08] text-cyan-100"><Clapperboard size={21}/></div>
            <div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">01 · Créer</p><h3 className="mt-1.5 font-display text-xl font-medium text-white">VYORA Studio</h3><p className="mt-1.5 max-w-sm text-sm leading-relaxed text-slate-400">Du brief au montage final, dans un studio de production relié à de vrais outils de génération.</p></div>
          </article>
          <article className="flex min-h-[170px] items-center gap-5 rounded-2xl border border-violet-200/15 bg-gradient-to-r from-violet-300/[0.07] to-transparent p-5 sm:p-7">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-violet-200/20 bg-violet-200/[0.08] text-violet-100"><Brain size={21}/></div>
            <div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-200">02 · Développer</p><h3 className="mt-1.5 font-display text-xl font-medium text-white">VYORA Business</h3><p className="mt-1.5 max-w-sm text-sm leading-relaxed text-slate-400">Un espace intelligent pour éclairer vos décisions, organiser vos actions et faire croître votre activité.</p></div>
          </article>
        </div>
      </section>

      {/* Features */}
      <section id="fonctionnalites" className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-300">La plateforme</p>
          <h2 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Tout le cycle de production UGC</h2>
          <p className="mt-3 text-slate-400">De l’idée à la vidéo stockée, chaque étape est réellement connectée à la base de données et aux services d’IA.</p>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <Card key={f.title} className="group p-6 transition-colors hover:border-brand-400/30">
              <div className="grid h-11 w-11 place-items-center rounded-xl bg-brand-500/15 text-brand-300"><f.icon size={20} /></div>
              <h3 className="mt-4 text-base font-semibold text-white">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{f.text}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Workflow */}
      <section id="workflow" className="border-y border-line bg-panel/30 py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Workflow</p>
              <h2 className="mt-3 text-3xl font-bold text-white">Quatre étapes, une seule plateforme</h2>
            </div>
            <Link to="/inscription" className="btn btn-outline btn-md">Lancer mon premier projet <ArrowRight size={15} /></Link>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-4">
            {STEPS.map((s) => (
              <div key={s.n} className="relative rounded-2xl border border-line bg-panel/60 p-5">
                <span className="text-3xl font-black text-white/10">{s.n}</span>
                <h3 className="mt-2 text-sm font-semibold text-white">{s.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-slate-400">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="tarifs" className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-300">Tarifs</p>
          <h2 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Des formules adaptées à votre cadence</h2>
          <p className="mt-3 text-sm text-slate-400">Les formules et quotas ci-dessous proviennent directement de la base de données.</p>
        </div>
        {plansLoading && <LoadingState label="Chargement des formules…" />}
        {!plansLoading && plans.length === 0 && <p className="mt-10 text-center text-sm text-slate-400">Les formules seront affichées dès que la connexion à la base est disponible.</p>}
        <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan) => (
            <Card key={plan.plan_key} className={cn('flex flex-col p-6', plan.plan_key === 'studio' && 'border-brand-400/50 ring-1 ring-brand-400/20')}>
              {plan.plan_key === 'studio' && <span className="mb-3 w-fit rounded-full bg-brand-500/20 px-2.5 py-1 text-[11px] font-semibold text-brand-200">Le plus choisi</span>}
              <h3 className="text-lg font-bold text-white">{plan.display_name}</h3>
              <p className="mt-1 text-xs text-slate-400">{(plan.tagline ?? '').replace(/\bReelora\b/gi, 'VYORA')}</p>
              <p className="mt-5 text-2xl font-extrabold text-white">{formatMoney(plan.monthly_price_minor, plan.currency)}<span className="text-sm font-normal text-slate-500"> / mois</span></p>
              <ul className="mt-5 flex-1 space-y-2.5">
                {plan.features.map((f) => <li key={f} className="flex items-start gap-2 text-xs text-slate-300"><Check size={14} className="mt-0.5 shrink-0 text-emerald-400" /> {f.replace(/\bReelora\b/gi, 'VYORA')}</li>)}
              </ul>
              <div className="mt-5 rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-xs text-slate-400">
                {plan.max_projects} projets · {plan.max_videos_per_month} vidéos/mois · {plan.max_scripts_per_month} scripts/mois
              </div>
              <Link to="/inscription" className={cn('btn btn-md mt-4 w-full', plan.plan_key === 'studio' ? 'btn-primary' : 'btn-outline')}>Choisir {plan.display_name}</Link>
            </Card>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="border-t border-line bg-panel/30 py-16">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-center text-3xl font-bold text-white">Questions fréquentes</h2>
          <div className="mt-10 space-y-3">
            {FAQ.map((item, i) => (
              <div key={item.q} className="rounded-xl border border-line bg-panel/60">
                <button onClick={() => setOpenFaq(openFaq === i ? null : i)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left text-sm font-semibold text-white">
                  {item.q} <span className="text-brand-300">{openFaq === i ? '−' : '+'}</span>
                </button>
                {openFaq === i && <p className="px-5 pb-5 text-sm leading-relaxed text-slate-400">{item.a}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl border border-brand-400/25 bg-gradient-to-br from-brand-700/40 via-panel to-cyan-900/20 p-10 text-center sm:p-16">
          <div className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-brand-500/20 blur-3xl" />
          <div className="relative">
            <Zap className="mx-auto text-brand-200" size={28} />
            <h2 className="mt-4 text-3xl font-bold text-white sm:text-4xl">Prêt à produire votre première vidéo UGC ?</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-slate-300">Un seul espace pour créer, évoluer et développer votre activité avec VYORA.</p>
            <Link to="/inscription" className="btn btn-primary btn-lg mt-7">Créer mon compte gratuitement <ArrowRight size={17} /></Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 text-xs text-slate-500 sm:flex-row sm:px-6">
          <div className="flex items-center gap-3"><BrandLockup tagline /> <span className="hidden text-slate-600 sm:inline">One platform. Two dimensions.</span></div>
          <div className="flex flex-wrap items-center gap-5">
            <Link to="/confidentialite" className="hover:text-white">Confidentialité</Link>
            <Link to="/conditions" className="hover:text-white">Conditions d’utilisation</Link>
            <Link to="/connexion" className="hover:text-white">Connexion</Link>
            <span className="flex items-center gap-1.5"><LockKeyhole size={12} /> Données hébergées dans l’UE</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
