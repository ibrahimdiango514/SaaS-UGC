import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, ArrowUpRight, Brain, Check, Clapperboard, Clock3, Coins, LockKeyhole,
  Settings2, ShieldCheck, Sparkles, Split, Wand2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { BrandLockup } from '../components/Brand';
import { Reveal } from '../components/landing/motion';
import { localGreeting, localTimeLabel } from '../lib/greeting';

const STUDIO_BENEFITS = [
  'Vidéos UGC et publicités verticales',
  'Scripts, hooks et contenus créatifs',
  'Avatars IA et images produits animées',
  'Devis serveur avant chaque génération',
  'Montage, sous-titres et export',
  'Bibliothèque privée de vos créations',
];

const BUSINESS_BENEFITS = [
  'Prospects, clients et pipeline commercial',
  'Récupération des revenus perdus',
  'Automatisation des relances et des ventes',
  'Intelligence financière et opérationnelle',
  'Agent IA connecté à votre contexte métier',
  'Modules de protection des revenus',
];

function firstNameOf(displayName: string | null | undefined, email: string | undefined): string {
  const raw = (displayName ?? '').trim() || (email ?? '').split('@')[0] || '';
  const first = raw.split(/\s+/).filter(Boolean)[0] ?? '';
  if (!first) return '';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const VISIT_KEY = 'vyora.home.visited.v1';

export default function Home() {
  const { user, profile, workspace } = useAuth();
  const firstName = useMemo(() => firstNameOf(profile?.display_name, user?.email), [profile?.display_name, user?.email]);
  const [now] = useState(() => new Date());
  const greeting = useMemo(() => localGreeting(now), [now]);
  const localTime = useMemo(() => localTimeLabel(now, greeting.timeZone), [now, greeting.timeZone]);
  const [firstVisit] = useState(() => {
    try { return !window.localStorage.getItem(VISIT_KEY); } catch { return false; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(VISIT_KEY, JSON.stringify({ at: new Date().toISOString() })); } catch { /* stockage local optionnel */ }
  }, []);
  const heading = firstName ? `${greeting.greeting}, ${firstName}.` : `${greeting.greeting}.`;

  return (
    <div className="pb-10" data-testid="vyora-home">
      <Reveal>
        <section className="relative isolate overflow-hidden rounded-[1.9rem] border border-white/[0.09] bg-[#070c13] px-5 py-7 sm:px-8 sm:py-10 lg:px-11 lg:py-12">
          <img
            src="/brand/vyora-hero.jpg"
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 -z-20 hidden h-full w-[56%] object-cover object-[62%_38%] opacity-45 lg:block [mask-image:linear-gradient(to_right,transparent,black_42%)]"
          />
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(100deg,#070c13_0%,#070c13_52%,rgba(7,12,19,0.55)_78%,rgba(7,12,19,0.25))]" />
          <div aria-hidden="true" className="pointer-events-none absolute -left-24 -top-24 -z-10 h-72 w-72 rounded-full bg-cyan-400/10 blur-[90px]" />
          <div aria-hidden="true" className="pointer-events-none absolute -bottom-28 right-0 -z-10 h-72 w-72 rounded-full bg-violet-500/10 blur-[90px]" />

          <div className="relative grid items-center gap-10 lg:grid-cols-[1.05fr_.95fr]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <BrandLockup tagline symbolSize={34} />
                <span className="hidden h-7 w-px bg-white/10 sm:block" />
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-300">
                  <Sparkles size={10} className="text-cyan-300" /> Espace personnel
                </span>
              </div>

              <div className="mt-8 flex flex-wrap items-center gap-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-200/85">
                  {firstVisit ? 'Première visite · votre espace est prêt' : 'Ravi de vous revoir'}
                </p>
                {localTime && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 text-[9.5px] font-medium text-slate-400">
                    <Clock3 size={10} className="text-cyan-300" /> {localTime} · heure locale
                  </span>
                )}
              </div>
              <h1 className="mt-2 font-display text-[2.3rem] font-medium leading-[1.04] tracking-[-0.045em] text-white sm:text-5xl lg:text-[2.9rem] xl:text-[3.4rem]">
                {heading}
                <span className="mt-2 block text-slate-400">Deux espaces. Une même ambition.</span>
              </h1>
              <p className="mt-5 max-w-xl text-sm leading-6 text-slate-300 sm:text-[15px] sm:leading-7">
                {firstVisit
                  ? <>Bienvenue dans <strong className="font-semibold text-white">{workspace?.name || 'votre espace VYORA'}</strong>. </>
                  : <>Heureux de vous retrouver dans <strong className="font-semibold text-white">{workspace?.name || 'votre espace VYORA'}</strong>. </>}
                VYORA vous donne les moyens de <strong className="font-semibold text-white">créer ce qui attire</strong> et de
                <strong className="font-semibold text-white"> piloter ce qui grandit</strong>. Un seul compte,
                deux espaces spécialisés — jamais mélangés.
              </p>

              <div className="mt-6 flex flex-wrap items-center gap-2.5">
                <a href="#espaces" className="btn btn-primary btn-md vyora-btn-sheen">
                  Choisir mon espace <ArrowRight size={15} />
                </a>
                <Link to="/app/parametres" className="btn btn-outline btn-md">
                  <Settings2 size={15} /> Mon compte
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
              <div className="absolute left-0 top-6 w-[61%] -rotate-[2.5deg] overflow-hidden rounded-[1.25rem] border border-white/15 bg-[#0b1118] shadow-[0_28px_80px_rgba(0,0,0,0.55)]">
                <img src="/brand/studio-creator.jpg" alt="" className="h-[188px] w-full object-cover object-[50%_25%]" />
                <div className="flex items-center justify-between border-t border-white/10 bg-[#0b1118]/95 px-3.5 py-3">
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-cyan-100"><Clapperboard size={12} /> Studio</span>
                  <span className="text-[9px] uppercase tracking-[0.16em] text-slate-500">Créer</span>
                </div>
              </div>
              <div className="absolute bottom-0 right-0 w-[57%] rotate-[2deg] overflow-hidden rounded-[1.25rem] border border-white/15 bg-[#0d0b15] shadow-[0_28px_80px_rgba(0,0,0,0.55)]">
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

      <Reveal delay={0.08}>
        <section className="mt-6 overflow-hidden rounded-[1.5rem] border border-white/[0.08] bg-gradient-to-r from-cyan-400/[0.045] via-white/[0.02] to-violet-400/[0.05] px-5 py-5 sm:px-7 sm:py-6">
          <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-6">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Notre mission</p>
            <p className="max-w-4xl font-display text-lg font-medium leading-snug tracking-[-0.02em] text-slate-200 sm:text-xl">
              Donner à chaque créateur et à chaque entreprise les moyens de <span className="text-cyan-200">créer ce qui attire</span>,
              de <span className="text-violet-200">comprendre ce qui se passe</span> et de <span className="text-white">décider ce qui fait grandir</span>.
              Sans complexité inutile, sans données mélangées.
            </p>
          </div>
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
          <Link
            to="/app/studio"
            className="group relative flex h-full flex-col overflow-hidden rounded-[1.7rem] border border-cyan-200/15 bg-[#081018] transition duration-300 hover:-translate-y-0.5 hover:border-cyan-200/35"
          >
            <div className="relative h-44 overflow-hidden sm:h-52">
              <img src="/brand/studio-creator.jpg" alt="Créatrice UGC préparant une vidéo publicitaire" className="h-full w-full object-cover object-[50%_28%] transition duration-700 group-hover:scale-[1.03]" />
              <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-[#081018] via-[#081018]/45 to-transparent" />
            </div>

            <div className="flex flex-1 flex-col p-5 sm:p-7">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display text-2xl font-medium tracking-[-0.03em] text-white sm:text-[1.8rem]">VYORA Studio</h3>
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/75">Création & production marketing</p>
                </div>
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-cyan-200/20 bg-cyan-400/[0.08] text-cyan-200 transition group-hover:bg-cyan-400/15">
                  <ArrowUpRight size={17} />
                </span>
              </div>

              <p className="mt-4 max-w-lg text-[13px] leading-relaxed text-slate-300">
                Transformez une idée, un produit ou une image en vidéo UGC, publicité ou contenu marketing — avec un devis vérifié et des outils de production réels.
              </p>

              <ul className="mt-5 grid gap-2.5 sm:grid-cols-2">
                {STUDIO_BENEFITS.map((benefit) => (
                  <li key={benefit} className="flex items-start gap-2 text-[11.5px] leading-snug text-slate-300">
                    <Check size={13} className="mt-0.5 shrink-0 text-cyan-300" /> {benefit}
                  </li>
                ))}
              </ul>

              <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-5">
                <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                  <LockKeyhole size={11} /> Vos fichiers restent dans Studio
                </div>
                <span className="inline-flex items-center gap-2 text-[12px] font-semibold text-cyan-200">
                  Entrer dans Studio <ArrowRight size={14} className="transition group-hover:translate-x-0.5" />
                </span>
              </div>
            </div>
          </Link>

          <Link
            to="/app/business"
            className="group relative flex h-full flex-col overflow-hidden rounded-[1.7rem] border border-violet-200/15 bg-[#0b0a13] transition duration-300 hover:-translate-y-0.5 hover:border-violet-200/35"
          >
            <div className="relative h-44 overflow-hidden sm:h-52">
              <img src="/brand/business-visual.jpg" alt="Interface de pilotage Business Growth avec courbes et indicateurs" className="h-full w-full object-cover object-center opacity-80 transition duration-700 group-hover:scale-[1.03]" />
              <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-[#0b0a13] via-[#0b0a13]/55 to-[#0b0a13]/10" />
            </div>

            <div className="flex flex-1 flex-col p-5 sm:p-7">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display text-2xl font-medium tracking-[-0.03em] text-white sm:text-[1.8rem]">VYORA Business Growth</h3>
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-200/75">Pilotage, revenus & opérations</p>
                </div>
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-violet-200/20 bg-violet-400/[0.08] text-violet-200 transition group-hover:bg-violet-400/15">
                  <ArrowUpRight size={17} />
                </span>
              </div>

              <p className="mt-4 max-w-lg text-[13px] leading-relaxed text-slate-300">
                Pilotez votre activité, récupérez les revenus perdus et automatisez les actions commerciales grâce à un agent IA et des modules métier connectés à vos données.
              </p>

              <ul className="mt-5 grid gap-2.5 sm:grid-cols-2">
                {BUSINESS_BENEFITS.map((benefit) => (
                  <li key={benefit} className="flex items-start gap-2 text-[11.5px] leading-snug text-slate-300">
                    <Check size={13} className="mt-0.5 shrink-0 text-violet-300" /> {benefit}
                  </li>
                ))}
              </ul>

              <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-5">
                <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                  <LockKeyhole size={11} /> Aucun accès aux crédits Studio
                </div>
                <span className="inline-flex items-center gap-2 text-[12px] font-semibold text-violet-200">
                  Entrer dans Business Growth <ArrowRight size={14} className="transition group-hover:translate-x-0.5" />
                </span>
              </div>
            </div>
          </Link>
      </div>

      <section className="mt-6 grid gap-3 rounded-[1.5rem] border border-white/[0.08] bg-white/[0.02] p-5 sm:grid-cols-3 sm:p-6">
          {[
            { icon: ShieldCheck, title: 'Données isolées', text: 'Studio ne lit pas vos données Business Growth, et inversement. Chaque espace garde ses propres protections.' },
            { icon: Coins, title: 'Crédits et quotas séparés', text: 'Les crédits Studio restent dans Studio. Business Growth ne les lit ni ne les débite.' },
            { icon: Wand2, title: 'Retour au sélecteur', text: 'Le logo et le lien « Tous les espaces » vous ramènent ici, sans perdre votre travail.' },
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
    </div>
  );
}
