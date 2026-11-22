import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, ArrowUpRight, Brain, Check, Clapperboard, Clock3, Coins, CreditCard,
  Image as ImageIcon, LayoutDashboard, MessagesSquare, Settings2, ShieldCheck, Sparkles,
  Split, Wallet,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { BrandLockup } from '../components/Brand';
import { Reveal } from '../components/landing/motion';
import { FeatureCard, MetricPill, SectionHeader, WorkspaceCard } from '../components/ui-premium';
import { localGreeting, localTimeLabel } from '../lib/greeting';
import { welcomeMessage, workspaceHint } from '../lib/welcome';

/**
 * Accueil personnalisé après connexion.
 *
 * - Message humain construit uniquement sur le prénom réel du profil
 *   (`display_name`) : aucun nom n'est inventé (voir `src/lib/welcome.ts`).
 * - Deux espaces clairement séparés, avec leurs vraies destinations.
 * - Accès rapides vers des fonctionnalités **existantes** et opérationnelles.
 * - Aucune donnée chiffrée n'est affichée si elle n'a pas été chargée.
 */
const STUDIO_BENEFITS = [
  'Vidéos UGC et publicités verticales',
  'Scripts, hooks et contenus créatifs',
  'Avatars IA et images produits',
  'Devis serveur avant génération',
  'Montage, sous-titres et export',
  'Bibliothèque privée de vos créations',
];

const BUSINESS_BENEFITS = [
  'Prospects, clients et pipeline',
  'Récupération des revenus perdus',
  'Relances et ventes automatisées',
  'Intelligence financière',
  'Agent IA relié à votre contexte',
  'Modules de protection des revenus',
];

interface StudioQuickLink {
  to: string;
  icon: typeof Sparkles;
  title: string;
  description: string;
  meta?: string;
}

interface BusinessQuickLink extends StudioQuickLink {
  badge?: string;
}

const STUDIO_QUICK: StudioQuickLink[] = [
  { to: '/app/studio', icon: Sparkles, title: 'Créer une vidéo', description: 'Brief, script et génération avec devis vérifié.', meta: 'Création' },
  { to: '/app/studio/montage', icon: Clapperboard, title: 'Monter un projet', description: 'Timeline, sous-titres et export des rushes.', meta: 'Montage' },
  { to: '/app/projets', icon: LayoutDashboard, title: 'Mes projets', description: 'Reprendre un projet et suivre son avancement.', meta: 'Projets' },
  { to: '/app/bibliotheque', icon: ImageIcon, title: 'Bibliothèque', description: 'Vos créations enregistrées et vos médias.', meta: 'Médias' },
];

const BUSINESS_QUICK: BusinessQuickLink[] = [
  { to: '/app/business/assistant', icon: MessagesSquare, title: 'Agent métier', description: 'Poser une question à l’agent relié à votre contexte.', meta: 'Assistant' },
  { to: '/app/business/modules', icon: Brain, title: 'Modules métier', description: 'Catalogue complet des modules Business Growth.', meta: 'Modules' },
  { to: '/app/business/crm', icon: ArrowUpRight, title: 'CRM intelligent', description: 'Contacts, pipeline, priorités et relances.', meta: 'Commercial' },
  { to: '/app/business/finance', icon: ArrowUpRight, title: 'Finances & recouvrement', description: 'Créances, paiements et promesses.', meta: 'Finance' },
  { to: '/app/business/modules/finance-intelligence', icon: Wallet, title: 'Finance Intelligence', description: 'Revenus, dépenses et marge réels.', meta: 'Finance' },
];

const VISIT_KEY = 'vyora.home.visited.v1';

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default function Home() {
  const { user, profile, workspace, quota } = useAuth();
  const [now] = useState(() => new Date());
  const greeting = useMemo(() => localGreeting(now), [now]);
  const localTime = useMemo(() => localTimeLabel(now, greeting.timeZone), [now, greeting.timeZone]);
  const [firstVisit] = useState(() => {
    try { return !window.localStorage.getItem(VISIT_KEY); } catch { return false; }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(VISIT_KEY, JSON.stringify({ at: new Date().toISOString(), day: todayKey() }));
    } catch {
      // Le stockage local est optionnel : l'accueil reste complet sans lui.
    }
  }, []);

  const welcome = useMemo(
    () => welcomeMessage({
      displayName: profile?.display_name,
      greeting: greeting.greeting,
      seed: `${user?.id ?? 'anonyme'}:${todayKey()}`,
      firstVisit,
    }),
    [profile?.display_name, greeting.greeting, user?.id, firstVisit],
  );
  const hint = workspaceHint(workspace?.name);

  return (
    <div className="pb-10" data-testid="vyora-home">
      <Reveal>
        <section className="relative isolate overflow-hidden rounded-[1.9rem] border border-white/[0.09] bg-[#070c13] px-5 py-7 sm:px-8 sm:py-10 lg:px-11 lg:py-12">
          <img
            src="/brand/vyora-hero.jpg"
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 -z-20 hidden h-full w-[56%] object-cover object-[62%_38%] opacity-40 lg:block [mask-image:linear-gradient(to_right,transparent,black_42%)]"
          />
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(100deg,#070c13_0%,#070c13_52%,rgba(7,12,19,0.55)_78%,rgba(7,12,19,0.25))]" />
          <div aria-hidden="true" className="pointer-events-none absolute -left-24 -top-24 -z-10 h-72 w-72 rounded-full bg-cyan-400/10 blur-[90px]" />
          <div aria-hidden="true" className="pointer-events-none absolute -bottom-28 right-0 -z-10 h-72 w-72 rounded-full bg-violet-500/10 blur-[90px]" />

          <div className="relative grid items-center gap-10 lg:grid-cols-[1.08fr_.92fr]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <BrandLockup tagline symbolSize={34} />
                <span className="hidden h-7 w-px bg-white/10 sm:block" />
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-300">
                  <Sparkles size={10} className="text-cyan-300" /> {welcome.status}
                </span>
              </div>

              <div className="vy-in mt-8 flex flex-wrap items-center gap-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-200/85">
                  {firstVisit ? 'Votre première visite' : 'Heureux de vous revoir'}
                </p>
                {localTime && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 text-[9.5px] font-medium text-slate-400">
                    <Clock3 size={10} className="text-cyan-300" /> {localTime} · heure locale
                  </span>
                )}
              </div>

              {/* Titre personnalisé : le prénom vient du profil, jamais d'une supposition. */}
              <h1
                className="vy-in mt-2 font-display text-[2.15rem] font-medium leading-[1.05] tracking-[-0.045em] text-white sm:text-[2.7rem] lg:text-[2.55rem] xl:text-[3rem]"
                style={{ ['--vy-delay' as string]: '60ms' }}
              >
                {welcome.heading}
                <span className="mt-2 block text-slate-400">Deux espaces. Une même ambition.</span>
              </h1>

              <p
                className="vy-in mt-5 max-w-xl text-[13.5px] leading-6 text-slate-300 sm:text-[14.5px] sm:leading-7"
                style={{ ['--vy-delay' as string]: '130ms' }}
              >
                {welcome.sentence}
                {hint && <> <span className="text-slate-400">{hint}</span></>}
              </p>

              <div className="vy-in mt-6 flex flex-wrap items-center gap-2.5" style={{ ['--vy-delay' as string]: '200ms' }}>
                <a href="#espaces" className="vy-btn vy-btn-accent min-h-11 px-5 text-[13px]">
                  Choisir mon espace <ArrowRight size={15} />
                </a>
                <Link to="/app/parametres" className="vy-btn vy-btn-ghost-accent min-h-11 px-4 text-[12.5px]">
                  <Settings2 size={14} /> Mon compte
                </Link>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10.5px] text-slate-500">
                <span className="flex items-center gap-1.5"><Check size={12} className="text-emerald-400" /> Crédits Studio séparés</span>
                <span className="flex items-center gap-1.5"><Check size={12} className="text-emerald-400" /> Données métier isolées</span>
                <span className="flex items-center gap-1.5"><Check size={12} className="text-emerald-400" /> Aucune redirection d’abonnement</span>
              </div>
            </div>

            <div className="relative hidden min-h-[360px] lg:block" aria-hidden="true">
              <div className="absolute inset-x-3 top-2 h-[330px] rounded-[1.6rem] border border-white/[0.06] bg-white/[0.015]" />
              <div className="vyora-float absolute left-0 top-6 w-[61%] -rotate-[2.5deg] overflow-hidden rounded-[1.25rem] border border-white/15 bg-[#0b1118] shadow-[0_28px_80px_rgba(0,0,0,0.55)]">
                <img src="/brand/studio-creator.jpg" alt="" className="h-[188px] w-full object-cover object-[50%_25%]" />
                <div className="flex items-center justify-between border-t border-white/10 bg-[#0b1118]/95 px-3.5 py-3">
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-cyan-100"><Clapperboard size={12} /> Studio</span>
                  <span className="text-[9px] uppercase tracking-[0.16em] text-slate-500">Créer</span>
                </div>
              </div>
              <div className="vyora-float-soft absolute bottom-0 right-0 w-[57%] rotate-[2deg] overflow-hidden rounded-[1.25rem] border border-white/15 bg-[#0d0b15] shadow-[0_28px_80px_rgba(0,0,0,0.55)]">
                <img src="/brand/business-visual.jpg" alt="" className="h-[176px] w-full object-cover object-center opacity-90" />
                <div className="flex items-center justify-between border-t border-white/10 bg-[#0d0b15]/95 px-3.5 py-3">
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-violet-100"><Brain size={12} /> Business Growth</span>
                  <span className="text-[9px] uppercase tracking-[0.16em] text-slate-500">Piloter</span>
                </div>
              </div>
              <div className="absolute bottom-[102px] left-[31%] rounded-2xl border border-white/15 bg-[#0a1118]/95 px-3.5 py-2.5 shadow-2xl backdrop-blur">
                <div className="flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-cyan-300/25 to-violet-400/25 text-white"><Sparkles size={14} /></span>
                  <div>
                    <p className="text-[9px] font-semibold uppercase tracking-[0.15em] text-slate-400">Un même élan</p>
                    <p className="text-[11px] font-medium text-white">Créer · Piloter · Grandir</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </Reveal>

      {/* Accès rapides : uniquement des destinations réelles */}
      <Reveal delay={0.06}>
        <section className="mt-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <MetricPill
            label="Crédits Studio"
            value={quota ? `${quota.credits} crédits` : '—'}
            icon={Coins}
            hint={quota ? `${quota.plan?.display_name ?? 'Formule active'}` : 'Chargement du solde'}
          />
          <MetricPill
            label="Espace Studio"
            value="Création UGC"
            icon={Clapperboard}
            hint="Scripts, vidéos, montage"
          />
          <MetricPill
            label="Espace Business"
            value="Pilotage"
            icon={Brain}
            hint="Agent, CRM, modules"
          />
          <MetricPill
            label="Compte"
            value={workspace?.name || (profile?.display_name ? 'VYORA' : 'VYORA')}
            icon={ShieldCheck}
            hint="Isolation par espace active"
          />
        </section>
      </Reveal>

      <div className="mt-10 flex items-end justify-between gap-4" id="espaces">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Vos deux univers</p>
          <h2 className="mt-2 font-display text-2xl font-medium tracking-[-0.03em] text-white sm:text-3xl">Où voulez-vous avancer aujourd’hui ?</h2>
        </div>
        <span className="hidden items-center gap-1.5 text-[10px] text-slate-500 sm:flex"><Split size={12} className="text-cyan-300" /> Deux interfaces indépendantes</span>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <WorkspaceCard
          to="/app/studio"
          name="VYORA Studio"
          tagline="Création & production marketing"
          description="Transformez une idée, un produit ou une image en vidéo UGC, publicité ou contenu marketing — avec un devis vérifié et des outils de production réels."
          image="/brand/studio-creator.jpg"
          imageAlt="Créatrice UGC préparant une vidéo publicitaire"
          icon={Clapperboard}
          benefits={STUDIO_BENEFITS}
          accent="cyan"
          cta="Entrer dans Studio"
          footer="Vos fichiers restent dans Studio."
          delay={80}
        />
        <WorkspaceCard
          to="/app/business"
          name="VYORA Business Growth"
          tagline="Pilotage, revenus & opérations"
          description="Pilotez votre activité, récupérez les revenus perdus et automatisez les actions commerciales grâce à un agent IA et des modules métier connectés à vos données."
          image="/brand/business-visual.jpg"
          imageAlt="Interface de pilotage Business Growth avec courbes et indicateurs"
          icon={Brain}
          benefits={BUSINESS_BENEFITS}
          accent="violet"
          cta="Entrer dans Business Growth"
          footer="Aucun accès aux crédits Studio."
          delay={150}
        />
      </div>

      {/* Fonctionnalités essentielles, par espace */}
      <div className="mt-10 grid gap-6 xl:grid-cols-2">
        <div className="vy-scope-studio">
          <SectionHeader
            eyebrow="Raccourcis Studio"
            title="Créer sans chercher"
            action={<Link to="/app/studio/accueil" className="text-[11px] font-medium text-cyan-300 hover:text-cyan-200">Tableau de bord →</Link>}
          />
          <div className="grid gap-2.5 sm:grid-cols-2">
            {STUDIO_QUICK.map((item, index) => (
              <FeatureCard key={item.to} {...item} delay={index * 60} />
            ))}
          </div>
        </div>

        <div className="vy-scope-business">
          <SectionHeader
            eyebrow="Raccourcis Business"
            title="Piloter avec méthode"
            action={<Link to="/app/business" className="text-[11px] font-medium text-violet-300 hover:text-violet-200">Vue d’ensemble →</Link>}
          />
          <div className="grid gap-2.5 sm:grid-cols-2">
            {BUSINESS_QUICK.map((item, index) => (
              <FeatureCard key={item.to} {...item} delay={index * 60} />
            ))}
          </div>
        </div>
      </div>

      <Reveal delay={0.08}>
        <section className="mt-6 grid gap-3 rounded-[1.5rem] border border-white/[0.08] bg-white/[0.02] p-5 sm:grid-cols-3 sm:p-6">
          {[
            { icon: ShieldCheck, title: 'Données isolées', text: 'Studio ne lit pas vos données Business Growth, et inversement. Chaque espace garde ses propres protections.' },
            { icon: Coins, title: 'Crédits et quotas séparés', text: 'Les crédits Studio restent dans Studio. Business Growth ne les lit ni ne les débite.' },
            { icon: CreditCard, title: 'Retour au sélecteur', text: 'Le logo et le lien « Tous les espaces » vous ramènent ici, sans perdre votre travail.' },
          ].map((item) => (
            <div key={item.title} className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-black/15 p-4">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-200">
                <item.icon size={16} />
              </span>
              <div>
                <p className="text-[12.5px] font-semibold text-white">{item.title}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{item.text}</p>
              </div>
            </div>
          ))}
        </section>
      </Reveal>
    </div>
  );
}
