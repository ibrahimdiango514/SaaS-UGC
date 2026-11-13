import { useId, type ReactNode } from 'react';
import {
  ArrowRight, ArrowUpRight, BadgeCheck, Bot, Brain, Check, Clapperboard, Clock3,
  Coins, Layers3, LockKeyhole, MessageSquare, Play, ShieldCheck, Sparkles,
  Target, TrendingUp, Users, Wand2, Zap, type LucideIcon,
} from 'lucide-react';
import { BrandSymbol } from '../Brand';
import { cn } from '../ui';

/* -------------------------------------------------------------------------- */
/* Visuel du hero : deux espaces côte à côte, jamais fusionnés.               */
/* -------------------------------------------------------------------------- */

export function HeroConsole() {
  return (
    <div className="relative mx-auto w-full max-w-[560px]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-10 -z-10 rounded-[3rem] bg-[radial-gradient(ellipse_at_30%_20%,rgba(34,211,238,0.18),transparent_58%),radial-gradient(ellipse_at_78%_82%,rgba(167,139,250,0.2),transparent_60%)] blur-2xl"
      />
      <div className="relative rounded-[1.6rem] border border-white/[0.12] bg-[#070c14]/[0.94] p-2.5 shadow-[0_40px_90px_-45px_rgba(0,0,0,0.95),inset_0_1px_0_rgba(255,255,255,0.07)] backdrop-blur-xl sm:hidden">
        <HeroConsoleCompact />
      </div>

      <div className="relative hidden rounded-[1.8rem] border border-white/[0.12] bg-[#070c14]/[0.92] p-2.5 shadow-[0_50px_120px_-50px_rgba(0,0,0,0.95),inset_0_1px_0_rgba(255,255,255,0.07)] backdrop-blur-xl sm:block">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="h-2 w-2 rounded-full bg-rose-400/70" />
          <span className="h-2 w-2 rounded-full bg-amber-300/70" />
          <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
          <span className="ml-2 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 text-[9px] text-slate-400">
            vyora.app · écosystème
          </span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[8px] font-semibold uppercase tracking-[0.14em] text-slate-300">
            <LockKeyhole size={8} /> Un seul compte
          </span>
        </div>

        <div className="grid gap-2 rounded-[1.4rem] border border-white/[0.06] bg-[#05080e] p-2 sm:grid-cols-2">
          <StudioMiniPanel />
          <GrowthMiniPanel />
        </div>

        <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-2.5 text-[8.5px] uppercase tracking-[0.16em] text-slate-500">
          <span>Deux espaces distincts</span>
          <span className="inline-flex items-center gap-1 text-cyan-200/80">
            <ShieldCheck size={9} /> Données isolées
          </span>
        </div>
      </div>

    </div>
  );
}

function HeroConsoleCompact() {
  return (
    <>
      <div className="flex items-center gap-2 px-1 py-1">
        <span className="h-2 w-2 rounded-full bg-rose-400/70" />
        <span className="h-2 w-2 rounded-full bg-amber-300/70" />
        <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[8px] font-semibold uppercase tracking-[0.12em] text-slate-300">
          <LockKeyhole size={8} /> Un seul compte
        </span>
      </div>

      <div className="mt-2 space-y-2">
        <a href="#studio" className="flex items-stretch gap-2.5 rounded-2xl border border-cyan-300/20 bg-cyan-400/[0.05] p-2 transition hover:border-cyan-300/40">
          <img
            src="/brand/studio-creator.jpg"
            alt="Créatrice UGC présentant un sérum dans une vidéo verticale"
            width={941}
            height={1672}
            className="h-[104px] w-[82px] shrink-0 rounded-xl border border-white/10 object-cover object-center"
            loading="eager"
            decoding="async"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-[8.5px] font-bold uppercase tracking-[0.16em] text-cyan-200">VYORA Studio</span>
            <span className="mt-1 block text-[12px] font-semibold leading-snug text-white">Créer des vidéos qui attirent</span>
            <span className="mt-1 block text-[10px] leading-snug text-slate-400">UGC, publicités, produits mis en scène, montage.</span>
            <span className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-cyan-200">
              Explorer <ArrowRight size={10} />
            </span>
          </span>
        </a>

        <a href="#business" className="flex items-stretch gap-2.5 rounded-2xl border border-violet-300/20 bg-violet-400/[0.06] p-2 transition hover:border-violet-300/40">
          <span className="flex h-[104px] w-[82px] shrink-0 flex-col justify-between rounded-xl border border-violet-300/20 bg-black/30 p-1.5">
            <span className="text-[8px] uppercase tracking-[0.1em] text-violet-200/80">Pipeline</span>
            <svg viewBox="0 0 70 40" className="h-9 w-full" role="img" aria-label="Illustration d’une progression commerciale">
              <path d="M0 34 L12 29 L24 31 L36 21 L48 24 L60 12 L70 7" fill="none" stroke="#c4b5fd" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="70" cy="7" r="2" fill="#e9d5ff" />
            </svg>
            <span className="space-y-0.5">
              {['bg-cyan-400/80 w-full', 'bg-violet-400/80 w-2/3', 'bg-emerald-400/80 w-1/3'].map((tone) => (
                <span key={tone} className="block h-1 rounded-full bg-white/[0.06]">
                  <span className={cn('block h-full rounded-full opacity-80', tone)} />
                </span>
              ))}
            </span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[8.5px] font-bold uppercase tracking-[0.16em] text-violet-200">Business Growth</span>
            <span className="mt-1 block text-[12px] font-semibold leading-snug text-white">Développer votre activité</span>
            <span className="mt-1 block text-[10px] leading-snug text-slate-400">Agent IA, prospects, objectifs, marché et stratégie.</span>
            <span className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-violet-200">
              Explorer <ArrowRight size={10} />
            </span>
          </span>
        </a>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 px-1 text-[8px] uppercase tracking-[0.14em] text-slate-500">
        <span>Deux espaces distincts</span>
        <span className="inline-flex items-center gap-1 text-cyan-200/80"><ShieldCheck size={9} /> Données isolées</span>
      </div>
    </>
  );
}

function StudioMiniPanel() {
  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-[1.05rem] border border-cyan-300/15 bg-gradient-to-b from-cyan-400/[0.08] via-cyan-400/[0.02] to-transparent p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="grid h-5 w-5 place-items-center rounded-md bg-cyan-400/15 text-cyan-200">
          <Clapperboard size={11} />
        </span>
        <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-cyan-100">VYORA Studio</span>
        <span className="ml-auto rounded-full border border-cyan-300/20 bg-cyan-400/10 px-1.5 py-0.5 text-[8.5px] font-semibold text-cyan-100">CRÉER</span>
      </div>

      <div className="relative mt-2 min-h-[168px] flex-1 overflow-hidden rounded-xl border border-white/10 bg-black">
        <img
          src="/brand/studio-creator.jpg"
          alt="Créatrice UGC présentant un sérum dans un format vertical"
          width={941}
          height={1672}
          className="absolute inset-0 h-full w-full object-cover object-center"
          loading="eager"
          decoding="async"
        />
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/45" />
        <div className="absolute inset-x-2 top-2 flex items-center justify-between">
          <span className="rounded-md bg-black/60 px-1.5 py-0.5 text-[8.5px] font-semibold text-white backdrop-blur">9:16 · 15 s</span>
          <span className="rounded-md bg-cyan-400/20 px-1.5 py-0.5 text-[8.5px] font-semibold text-cyan-50 backdrop-blur">UGC</span>
        </div>
        <span className="absolute left-1/2 top-1/2 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-black/40 text-white backdrop-blur">
          <Play size={13} className="ml-0.5" />
        </span>
        <p className="absolute inset-x-2 bottom-2 rounded-md bg-black/70 px-2 py-1 text-center text-[8px] font-medium text-white backdrop-blur">
          « Une routine, un résultat. »
        </p>
      </div>

      <div className="mt-2 rounded-lg border border-white/[0.07] bg-black/25 px-2 py-1.5">
        <p className="text-[8.5px] uppercase tracking-[0.16em] text-slate-500">Brief</p>
        <p className="mt-0.5 text-[8.5px] leading-snug text-slate-200">
          Publicité UGC · sérum éclat · 15 s · sous-titres
        </p>
      </div>
      <div className="mt-1.5 flex items-center justify-between rounded-lg bg-cyan-400/20 px-2 py-1.5">
        <span className="text-[8.5px] font-bold text-cyan-100">Générer</span>
        <Sparkles size={9} className="text-cyan-200" />
      </div>
      <p className="mt-1.5 flex items-center gap-1 text-[8.5px] text-emerald-300/90">
        <BadgeCheck size={8} /> Devis vérifié avant génération
      </p>
    </article>
  );
}

function GrowthMiniPanel() {
  const chartId = `hero-growth-${useId().replace(/[:]/g, '')}`;
  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-[1.05rem] border border-violet-300/15 bg-gradient-to-b from-violet-400/[0.09] via-violet-400/[0.02] to-transparent p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="grid h-5 w-5 place-items-center rounded-md bg-violet-400/15 text-violet-200">
          <Brain size={11} />
        </span>
        <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-violet-100">Business Growth</span>
        <span className="ml-auto rounded-full border border-violet-300/20 bg-violet-400/10 px-1.5 py-0.5 text-[8.5px] font-semibold text-violet-100">DÉVELOPPER</span>
      </div>

      <div className="mt-2 rounded-xl border border-white/[0.08] bg-black/25 p-2">
        <div className="flex items-center justify-between">
          <p className="text-[8px] font-semibold text-white">Vue d’ensemble</p>
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[8px] text-slate-400">Aperçu</span>
        </div>
        <svg viewBox="0 0 220 66" className="mt-1.5 h-12 w-full" role="img" aria-label="Illustration d’une courbe de progression commerciale">
          <defs>
            <linearGradient id={chartId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.42" />
              <stop offset="100%" stopColor="#a78bfa" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d="M0 56 L28 50 L56 53 L84 40 L112 44 L140 30 L168 32 L196 18 L220 11 L220 66 L0 66 Z" fill={`url(#${chartId})`} />
          <path
            className="vyora-chart-line"
            pathLength={1}
            d="M0 56 L28 50 L56 53 L84 40 L112 44 L140 30 L168 32 L196 18 L220 11"
            fill="none"
            stroke="#c4b5fd"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="220" cy="11" r="2.4" fill="#e9d5ff" />
        </svg>
        <div className="mt-1 grid grid-cols-5 gap-1">
          {[
            ['bg-cyan-400/80', 'Prospect'],
            ['bg-sky-400/80', 'Contacté'],
            ['bg-violet-400/80', 'Qualifié'],
            ['bg-amber-300/80', 'Offre'],
            ['bg-emerald-400/80', 'Gagné'],
          ].map(([tone, label]) => (
            <div key={label} className="min-w-0">
              <span className={cn('block h-1 rounded-full', tone)} />
              <span className="mt-1 block truncate text-[8px] text-slate-400">{label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-2 rounded-xl border border-white/[0.08] bg-black/25 p-2">
        <div className="flex items-center justify-between">
          <p className="text-[8px] font-semibold text-white">Pipeline</p>
          <Users size={8} className="text-slate-500" />
        </div>
        <div className="mt-1.5 space-y-1">
          {[
            ['bg-cyan-400/80', 'Prospect', 'w-[92%]'],
            ['bg-violet-400/80', 'Qualifié', 'w-[58%]'],
            ['bg-emerald-400/80', 'Gagné', 'w-[26%]'],
          ].map(([tone, label, width]) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className={cn('h-1 w-1 shrink-0 rounded-full', tone)} />
              <span className="w-9 shrink-0 text-[8px] text-slate-400">{label}</span>
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                <span className={cn('block h-full rounded-full opacity-80', tone, width)} />
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-2 flex flex-1 flex-col rounded-xl border border-violet-300/15 bg-violet-400/[0.06] p-2">
        <div className="flex items-center gap-1">
          <span className="grid h-4 w-4 place-items-center rounded bg-violet-400/20 text-violet-100"><Bot size={9} /></span>
          <span className="text-[8px] font-semibold text-violet-50">Agent IA Business</span>
          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </div>
        <p className="mt-1.5 text-[8px] leading-snug text-slate-300">
          « Brief marketing prêt : produit, angle, accroche et cible. À valider. »
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <span className="rounded border border-white/10 bg-black/25 px-1.5 py-0.5 text-[8px] text-slate-400">Mémoire métier</span>
          <span className="rounded border border-white/10 bg-black/25 px-1.5 py-0.5 text-[8px] text-slate-400">Validation humaine</span>
        </div>
        <div className="mt-auto space-y-1 pt-2">
          {['Relancer les prospects inactifs', 'Valider le plan 30/60/90'].map((item) => (
            <p key={item} className="flex items-center gap-1 rounded border border-white/[0.06] bg-black/20 px-1.5 py-1 text-[8px] text-slate-300">
              <Check size={7} className="text-violet-300" /> {item}
            </p>
          ))}
        </div>
      </div>

      <p className="mt-auto flex items-center gap-1 pt-1.5 text-[8px] text-slate-500">
        <Zap size={7} /> Quota Business Growth distinct
      </p>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Studio : la scène de production (images réelles + interface).               */
/* -------------------------------------------------------------------------- */

export function StudioShowcase() {
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-6 -z-10 rounded-[3rem] bg-[radial-gradient(ellipse_at_25%_20%,rgba(34,211,238,0.2),transparent_62%),radial-gradient(ellipse_at_85%_85%,rgba(56,189,248,0.1),transparent_60%)] blur-2xl"
      />
      <div className="relative overflow-hidden rounded-[1.8rem] border border-cyan-200/15 bg-[#060d14] p-2.5 shadow-[0_50px_130px_-60px_rgba(8,145,178,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] sm:p-3.5">
        <div className="flex flex-wrap items-center gap-2 px-1 pb-2.5">
          <BrandSymbol size={28} />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-white">VYORA Studio</p>
            <p className="text-[8px] uppercase tracking-[0.18em] text-cyan-200/75">Création vidéo assistée</p>
          </div>
          <span className="ml-auto rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2 py-1 text-[8px] font-semibold text-cyan-100">
            Nouveau projet
          </span>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.64fr)]">
          <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black">
            <img
              src="/brand/studio-creator.jpg"
              alt="Créatrice UGC présentant un sérum dans une vidéo verticale"
              width={941}
              height={1672}
              className="aspect-[5/6] w-full object-cover object-center sm:aspect-[4/5]"
              loading="lazy"
              decoding="async"
            />
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/40" />
            <div className="absolute inset-x-2.5 top-2.5 flex items-center justify-between">
              <span className="rounded-md bg-black/65 px-2 py-1 text-[9.5px] font-semibold text-white backdrop-blur sm:text-[8.5px]">9:16 · 15 s</span>
              <span className="rounded-md bg-cyan-400/20 px-2 py-1 text-[9.5px] font-semibold text-cyan-50 backdrop-blur sm:text-[8.5px]">UGC</span>
            </div>
            <span className="absolute left-1/2 top-[42%] grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-black/40 text-white backdrop-blur">
              <Play size={15} className="ml-0.5" />
            </span>
            <div className="absolute inset-x-2.5 bottom-2.5 space-y-1.5">
              <p className="rounded-lg bg-black/70 px-2 py-1.5 text-center text-[11px] font-medium text-white backdrop-blur sm:text-[9.5px]">
                « Ce sérum a changé ma routine. »
              </p>
              <div className="flex flex-wrap gap-1">
                {['Script validé', '3 scènes', 'Sous-titres', 'CTA'].map((tag) => (
                  <span key={tag} className="rounded border border-white/15 bg-black/45 px-1.5 py-0.5 text-[8.5px] text-slate-200 backdrop-blur sm:text-[8.5px]">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-2 gap-2.5 sm:flex sm:flex-col">
            <div className="relative aspect-square overflow-hidden rounded-2xl border border-white/10 bg-black sm:aspect-auto sm:min-h-[140px] sm:flex-1">
              <img
                src="/brand/studio-product.jpg"
                alt="Produit cosmétique mis en scène sous une lumière publicitaire"
                width={941}
                height={1672}
                className="absolute inset-0 h-full w-full object-cover object-center"
                loading="lazy"
                decoding="async"
              />
              <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black/85 to-transparent" />
              <span className="absolute inset-x-2 bottom-2 rounded-md bg-black/65 px-1.5 py-1 text-center text-[9.5px] font-medium text-white backdrop-blur sm:text-[8px]">
                Image produit → vidéo
              </span>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-2.5">
              <p className="text-[9px] uppercase tracking-[0.16em] text-slate-500 sm:text-[8px]">Prompt</p>
              <p className="mt-1 text-[11px] leading-snug text-slate-100 sm:text-[9.5px]">
                Publicité UGC · sérum · 15 s
              </p>
              <div className="mt-2 flex items-center justify-between rounded-lg bg-cyan-400/20 px-2 py-1.5">
                <span className="text-[10px] font-bold text-cyan-100 sm:text-[9px]">Générer</span>
                <Wand2 size={10} className="text-cyan-200" />
              </div>
              <p className="mt-1.5 flex items-center gap-1 text-[8.5px] text-emerald-300/90 sm:text-[8.5px]">
                <BadgeCheck size={8} /> Devis vérifié
              </p>
            </div>
          </div>
        </div>

        <div className="mt-2.5 rounded-2xl border border-white/[0.08] bg-black/30 p-2.5">
          <div className="flex items-center justify-between gap-2 text-[9.5px] sm:text-[8.5px]">
            <span className="font-semibold text-slate-200">Montage</span>
            <span className="text-slate-500">4 scènes · sous-titres · export</span>
          </div>
          <div className="mt-2 grid grid-cols-[1fr_0.72fr_1.15fr_0.58fr] gap-1">
            {[
              ['Hook', 'from-cyan-400/45 to-cyan-400/20'],
              ['Produit', 'from-sky-400/40 to-sky-400/15'],
              ['Démonstration', 'from-cyan-300/50 to-violet-400/20'],
              ['CTA', 'from-violet-400/45 to-violet-400/15'],
            ].map(([label, tone]) => (
              <div key={label} className={cn('min-w-0 rounded-md bg-gradient-to-r px-1.5 py-1', tone)}>
                <span className="block truncate text-[8.5px] font-medium text-white/90 sm:text-[8.5px]">{label}</span>
              </div>
            ))}
          </div>
          <div className="relative mt-2 flex h-8 items-end gap-[3px] overflow-hidden rounded-lg bg-white/[0.03] px-1.5 pb-1">
            {[30, 52, 44, 68, 38, 74, 58, 86, 48, 66, 34, 72, 54, 90, 62, 42, 76, 50, 68, 36, 82, 56, 70, 46, 64, 40, 78, 52, 60, 34].map((height, index) => (
              <span
                key={index}
                className="w-full flex-1 rounded-sm bg-gradient-to-t from-cyan-500/25 to-cyan-300/70"
                style={{ height: `${height}%` }}
              />
            ))}
            <span aria-hidden="true" className="absolute inset-y-0 left-[58%] w-px bg-cyan-200/80" />
            <span aria-hidden="true" className="absolute left-[58%] top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-cyan-200" />
          </div>
        </div>
      </div>

    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Business Growth : tableau de bord (qualitatif, sans chiffre inventé).       */
/* -------------------------------------------------------------------------- */

export function GrowthShowcase() {
  const ringId = `growth-ring-${useId().replace(/[:]/g, '')}`;
  return (
    <div className="relative">
      <div className="relative overflow-hidden rounded-[1.8rem] border border-violet-200/15 bg-[#080a13] shadow-[0_50px_130px_-60px_rgba(124,58,237,0.5),inset_0_1px_0_rgba(255,255,255,0.06)]">
        <img
          src="/brand/business-visual.jpg"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-25 [mask-image:linear-gradient(to_top,transparent,black_70%)]"
          loading="lazy"
          decoding="async"
        />
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-[#080a13] via-[#080a13]/80 to-[#080a13]/40" />

        <div className="relative p-2.5 sm:p-3.5">
          <div className="flex flex-wrap items-center gap-2 px-1 pb-2.5">
            <BrandSymbol size={28} />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-white">VYORA Business Growth</p>
              <p className="text-[8px] uppercase tracking-[0.18em] text-violet-200/75">Pilotage & croissance</p>
            </div>
            <span className="ml-auto rounded-full border border-white/10 bg-white/[0.05] px-2 py-1 text-[8px] font-medium text-slate-300">
              Aperçu de l’interface
            </span>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)]">
            <div className="space-y-2.5">
              <div className="rounded-2xl border border-white/[0.08] bg-black/30 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <TrendingUp size={11} className="text-violet-200" />
                    <span className="text-[9px] font-semibold text-white">Vue d’ensemble</span>
                  </div>
                  <span className="text-[8.5px] text-slate-500">Plan 30/60/90</span>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <div className="relative h-14 w-14 shrink-0">
                    <svg viewBox="0 0 44 44" className="h-full w-full -rotate-90" role="img" aria-label="Illustration d’un objectif en progression">
                      <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
                      <circle
                        cx="22" cy="22" r="18" fill="none" stroke={`url(#${ringId})`} strokeWidth="4" strokeLinecap="round"
                        strokeDasharray="113" strokeDashoffset="38" className="vyora-ring-draw"
                      />
                      <defs>
                        <linearGradient id={ringId} x1="0" y1="0" x2="44" y2="44">
                          <stop offset="0%" stopColor="#22d3ee" />
                          <stop offset="100%" stopColor="#a78bfa" />
                        </linearGradient>
                      </defs>
                    </svg>
                    <span className="absolute inset-0 grid place-items-center text-[8px] font-bold text-white">Objectif</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[8px] uppercase tracking-[0.14em] text-slate-500">Priorité du trimestre</p>
                    <p className="mt-0.5 text-[9.5px] font-medium leading-snug text-slate-100">Structurer la relance des prospects inactifs</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <span className="rounded border border-violet-300/20 bg-violet-400/10 px-1.5 py-0.5 text-[8px] text-violet-100">Actions à valider</span>
                      <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[8px] text-slate-400">Suivi</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-white/[0.08] bg-black/30 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-semibold text-white">Pipeline commercial</span>
                  <Users size={10} className="text-slate-500" />
                </div>
                <div className="mt-2 space-y-1.5">
                  {[
                    ['Prospect', 'bg-cyan-400/80', 'w-[92%]'],
                    ['Contacté', 'bg-sky-400/80', 'w-[74%]'],
                    ['Qualifié', 'bg-violet-400/80', 'w-[58%]'],
                    ['Offre', 'bg-amber-300/80', 'w-[40%]'],
                    ['Gagné', 'bg-emerald-400/80', 'w-[26%]'],
                  ].map(([label, dot, width]) => (
                    <div key={label} className="flex items-center gap-2">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
                      <span className="w-14 shrink-0 text-[8.5px] text-slate-400">{label}</span>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                        <span className={cn('vyora-bar-grow block h-full rounded-full opacity-80', dot, width)} />
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5 text-[8.5px] leading-snug text-slate-500">
                  Chaque étape garde son historique. Aucun compteur client réel n’est affiché sur cette page.
                </div>
              </div>
            </div>

            <div className="space-y-2.5">
              <div className="rounded-2xl border border-violet-300/15 bg-violet-400/[0.05] p-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="grid h-5 w-5 place-items-center rounded-md bg-violet-400/20 text-violet-100"><Bot size={11} /></span>
                  <span className="text-[9px] font-semibold text-white">Agent IA Business</span>
                  <span className="ml-auto inline-flex items-center gap-1 text-[8px] text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Mémoire consentie
                  </span>
                </div>
                <p className="mt-2 ml-auto w-fit max-w-[92%] rounded-lg rounded-br-sm bg-white/[0.08] px-2 py-1.5 text-[8px] leading-snug text-slate-100">
                  « Prépare un brief vidéo pour notre nouvelle collection. »
                </p>
                <p className="mt-1.5 mr-auto w-fit max-w-[94%] rounded-lg rounded-bl-sm border border-violet-300/15 bg-violet-400/10 px-2 py-1.5 text-[8px] leading-snug text-violet-50">
                  « Brief prêt : produit, angle, accroche et cible. À valider avant transfert vers Studio. »
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className="rounded border border-white/10 bg-black/25 px-1.5 py-0.5 text-[8px] text-slate-400">Validation humaine</span>
                  <span className="rounded border border-white/10 bg-black/25 px-1.5 py-0.5 text-[8px] text-slate-400">Sans débit Studio</span>
                </div>
              </div>

              <div className="rounded-2xl border border-white/[0.08] bg-black/30 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-semibold text-white">Prochaines actions</span>
                  <Target size={10} className="text-slate-500" />
                </div>
                <ul className="mt-2 space-y-1.5 text-[8px] text-slate-300">
                  {['Relancer les prospects sans réponse', 'Valider le plan 30/60/90', 'Préparer un brief de campagne'].map((item) => (
                    <li key={item} className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                      <span className="grid h-3 w-3 shrink-0 place-items-center rounded border border-white/20 text-transparent"><Check size={7} /></span>
                      <span className="min-w-0 truncate">{item}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[8px] text-slate-500">Rien ne s’exécute sans votre approbation.</p>
              </div>
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-1.5 rounded-xl border border-white/[0.07] bg-black/25 px-2.5 py-1.5 text-[8.5px] text-slate-500">
            <span className="inline-flex items-center gap-1"><MessageSquare size={8} /> Exemple d’échange et interface illustratifs</span>
            <span className="inline-flex items-center gap-1"><LockKeyhole size={8} /> Quota Business Growth distinct des crédits Studio</span>
          </div>
        </div>
      </div>

    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Écosystème : deux espaces reliés par un compte, sans fusion.               */
/* -------------------------------------------------------------------------- */

export function EcosystemFlow() {
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 -z-10 h-64 -translate-y-1/2 bg-[radial-gradient(ellipse_at_50%_50%,rgba(34,211,238,0.1),transparent_58%),radial-gradient(ellipse_at_50%_50%,rgba(167,139,250,0.12),transparent_66%)] blur-2xl"
      />

      <div className="grid items-center gap-2.5 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-3">
        <article className="relative overflow-hidden rounded-2xl border border-cyan-200/20 bg-[#071019]/95 p-4">
          <div aria-hidden="true" className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-cyan-400/[0.08] to-transparent" />
          <div className="relative flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-200">
              <Clapperboard size={17} />
            </span>
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-cyan-200/80">Espace 01</p>
              <h3 className="text-sm font-semibold text-white">VYORA Studio</h3>
            </div>
          </div>
          <p className="relative mt-3 text-xs leading-relaxed text-slate-300">
            Produit les vidéos, les scripts et les contenus marketing. Les fichiers restent dans votre bibliothèque Studio.
          </p>
          <div className="relative mt-3 flex flex-wrap gap-1.5">
            {['Vidéos UGC', 'Publicités', 'Projets', 'Bibliothèque'].map((tag) => (
              <span key={tag} className="rounded-md border border-cyan-300/15 bg-cyan-400/[0.06] px-2 py-1 text-[9px] text-cyan-100">{tag}</span>
            ))}
          </div>
        </article>

        <div className="relative flex items-center justify-center py-2 lg:w-[170px]">
          <span aria-hidden="true" className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-white/15 to-transparent lg:left-0 lg:top-1/2 lg:h-px lg:w-full lg:bg-gradient-to-r" />
          <span aria-hidden="true" className="vyora-flow-dot absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-200 shadow-[0_0_16px_rgba(103,232,249,0.9)] lg:left-2" />
          <div className="relative z-10 rounded-2xl border border-white/[0.12] bg-[#070c14] px-4 py-3 text-center shadow-2xl">
            <BrandSymbol size={34} className="mx-auto" />
            <p className="mt-1.5 text-[11px] font-semibold text-white">Un seul compte</p>
            <p className="mt-0.5 text-[8.5px] uppercase tracking-[0.14em] text-slate-500">Deux espaces distincts</p>
            <div className="mt-2 flex flex-col gap-1">
              <span className="rounded-md border border-violet-300/20 bg-violet-400/10 px-1.5 py-0.5 text-[9px] text-violet-100">Brief vidéo validé</span>
              <span className="rounded-md border border-cyan-300/20 bg-cyan-400/10 px-1.5 py-0.5 text-[9px] text-cyan-100">Crédits Studio</span>
            </div>
          </div>
          <span aria-hidden="true" className="vyora-flow-dot absolute left-1/2 top-1/2 hidden h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-200 shadow-[0_0_16px_rgba(196,181,253,0.9)] lg:right-2 lg:left-auto lg:block" style={{ animationDelay: '-1.8s' }} />
        </div>

        <article className="relative overflow-hidden rounded-2xl border border-violet-200/20 bg-[#0b0916]/95 p-4">
          <div aria-hidden="true" className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-violet-400/[0.1] to-transparent" />
          <div className="relative flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-violet-300/25 bg-violet-400/10 text-violet-200">
              <Brain size={17} />
            </span>
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-violet-200/80">Espace 02</p>
              <h3 className="text-sm font-semibold text-white">VYORA Business Growth</h3>
            </div>
          </div>
          <p className="relative mt-3 text-xs leading-relaxed text-slate-300">
            Identifie les besoins marketing, suit les prospects et prépare les briefs. Aucun de vos contenus Studio n’est mélangé à vos données métier.
          </p>
          <div className="relative mt-3 flex flex-wrap gap-1.5">
            {['Agent IA', 'Prospects', 'Stratégie', 'Briefs'].map((tag) => (
              <span key={tag} className="rounded-md border border-violet-300/15 bg-violet-400/[0.07] px-2 py-1 text-[9px] text-violet-100">{tag}</span>
            ))}
          </div>
        </article>
      </div>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { n: '01', title: 'Le besoin', text: 'Business Growth identifie un angle marketing à partir de votre contexte réel.' },
          { n: '02', title: 'Le brief', text: 'L’agent prépare produit, angle, accroche et cible. Rien n’est envoyé sans votre validation.' },
          { n: '03', title: 'Le transfert', text: 'Vous ouvrez le brief dans Studio. Le transfert ne consomme aucun crédit.' },
          { n: '04', title: 'La génération', text: 'Studio produit la vidéo avec vos crédits Studio et votre formule.' },
          { n: '05', title: 'La bibliothèque', text: 'La vidéo reste accessible dans votre espace Studio : projets, historique, fichiers.' },
        ].map((step) => (
          <div key={step.n} className="relative rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
            <span className="font-display text-[10px] font-bold tracking-[0.14em] text-cyan-200/80">{step.n}</span>
            <p className="mt-1 text-[11px] font-semibold text-white">{step.title}</p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{step.text}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-start gap-3 rounded-2xl border border-emerald-300/15 bg-emerald-500/[0.05] p-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-emerald-300/20 bg-emerald-400/10 text-emerald-200">
          <ShieldCheck size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-emerald-50">Périmètre et droits inchangés</p>
          <p className="mt-1 text-[11px] leading-relaxed text-emerald-100/80">
            Business Growth ne lit ni ne débite le portefeuille Studio. La création pilotée depuis Business Growth
            est destinée aux abonnés Business Growth lorsque la facturation de cet espace sera officiellement activée.
            En attendant, les droits d’accès existants restent exactement les mêmes.
          </p>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Bandeau de confiance (aucune statistique inventée).                        */
/* -------------------------------------------------------------------------- */

const TRUST_ITEMS = [
  { icon: BadgeCheck, label: 'Devis vérifié avant génération' },
  { icon: LockKeyhole, label: 'Clés API côté serveur' },
  { icon: ShieldCheck, label: 'Zéro résultat simulé' },
  { icon: Layers3, label: 'Un compte, deux espaces distincts' },
  { icon: Clock3, label: 'Suivi serveur des rendus' },
  { icon: Coins, label: 'Crédits et quotas séparés' },
];

export function TrustStrip() {
  return (
    <div className="relative border-y border-white/[0.06] bg-white/[0.015]">
      <div className="mx-auto grid max-w-[1240px] grid-cols-2 gap-x-4 gap-y-2.5 px-4 py-4 sm:grid-cols-3 sm:px-6 lg:grid-cols-6">
        {TRUST_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <span key={item.label} className="inline-flex min-w-0 items-center gap-1.5 text-[9.5px] leading-snug text-slate-400">
              <Icon size={11} className="shrink-0 text-cyan-300/80" /> <span className="min-w-0">{item.label}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* Petites pastilles utilisées dans les en-têtes de section. */
export function SectionBadge({ icon: Icon, children, tone }: { icon: LucideIcon; children: ReactNode; tone: 'cyan' | 'violet' | 'neutral' }) {
  return (
    <span
      className={cn(
        'landing-eyebrow',
        tone === 'cyan' && 'border-cyan-300/25 bg-cyan-400/[0.07] text-cyan-100',
        tone === 'violet' && 'border-violet-300/25 bg-violet-400/[0.08] text-violet-100',
        tone === 'neutral' && 'border-white/[0.12] bg-white/[0.04] text-slate-300',
      )}
    >
      <Icon size={12} /> {children}
    </span>
  );
}

export function InlineArrow() {
  return <ArrowUpRight size={13} className="transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />;
}

export function ArrowRightIcon() {
  return <ArrowRight size={15} />;
}
