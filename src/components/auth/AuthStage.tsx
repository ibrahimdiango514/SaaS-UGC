import { Component, Suspense, lazy, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, ShieldCheck, Sparkles } from 'lucide-react';
import { BrandLockup, BrandSymbol } from '../Brand';
import { cn } from '../ui';
import { useSceneCapability } from './useSceneCapability';

/**
 * Panneau visuel du parcours d'authentification.
 *
 * Deux rendus interchangeables, strictement de même structure :
 *  1. `AuthScene` (react-three/fiber) chargé en lazy, chunk three.js séparé ;
 *  2. repli CSS (« anneaux + noyau lumineux ») si WebGL est absent, si
 *     `prefers-reduced-motion` est actif, ou si la scène échoue.
 *
 * Le panneau n'est jamais la seule source d'information : le formulaire reste
 * lisible et utilisable sur mobile, où le visuel se réduit à un bandeau.
 */
const AuthScene = lazy(() => import('./AuthScene'));

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export type AuthVariant = 'create' | 'enter' | 'secure';

const COPY: Record<AuthVariant, { eyebrow: string; title: ReactNode; lead: string; points: string[] }> = {
  create: {
    eyebrow: 'Créer · Piloter · Grandir',
    title: (
      <>
        Votre atelier créatif
        <br />
        et votre cockpit métier.
      </>
    ),
    lead: 'Un compte, deux espaces : produisez vos contenus UGC et pilotez votre croissance depuis une même intelligence.',
    points: ['Devis vérifié avant chaque génération', 'Données isolées par espace', 'Clés fournisseur côté serveur'],
  },
  enter: {
    eyebrow: 'Heureux de vous revoir',
    title: (
      <>
        Votre espace
        <br />
        vous attend.
      </>
    ),
    lead: 'Reprenez exactement où vous vous êtes arrêté : vos projets, vos scripts et vos modules métier sont en place.',
    points: ['Session sécurisée Supabase', 'Vos travaux sauvegardés', 'Accès direct à vos deux espaces'],
  },
  secure: {
    eyebrow: 'Sécurité du compte',
    title: (
      <>
        Un lien sûr,
        <br />
        une étape suffit.
      </>
    ),
    lead: 'Les opérations sensibles passent par un lien envoyé à votre adresse e-mail : personne d’autre ne peut agir à votre place.',
    points: ['Lien à usage limité', 'Aucune donnée exposée', 'Mot de passe jamais transmis'],
  },
};

/** Repli statique : composition CSS, aucune animation si le mouvement est réduit. */
export function StaticAtrium({ variant }: { variant: AuthVariant }) {
  const accent = variant === 'enter' ? 'violet' : 'cyan';
  const core = accent === 'violet'
    ? 'radial-gradient(circle at 34% 28%, rgba(255,255,255,0.8), transparent 40%), radial-gradient(circle at 68% 72%, #22d3ee 0%, transparent 60%), radial-gradient(circle at 50% 50%, #a78bfa 0%, #6d28d9 62%, #2e1065 100%)'
    : 'radial-gradient(circle at 34% 28%, rgba(255,255,255,0.85), transparent 42%), radial-gradient(circle at 68% 72%, #a78bfa 0%, transparent 58%), radial-gradient(circle at 50% 50%, #22d3ee 0%, #0e7490 62%, #082f49 100%)';

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="relative aspect-square w-[64%] max-w-[300px]">
        <div className="vy-auth-orbit inset-0 opacity-70" />
        <div className="vy-auth-orbit inset-[13%] opacity-60" />
        <div className="vy-auth-orbit inset-[26%] opacity-50" />
        <div className="vy-auth-core inset-[36%]" style={{ background: core }} />
        <div className="absolute -inset-6 rounded-full bg-cyan-400/10 blur-3xl" />
      </div>
    </div>
  );
}

export function AuthStage({ variant = 'create' }: { variant?: AuthVariant }) {
  const copy = COPY[variant];
  const { canRender3d } = useSceneCapability();
  const staticStage = <StaticAtrium variant={variant} />;

  return (
    <div className="relative isolate hidden overflow-hidden border-r border-white/[0.06] lg:flex lg:flex-col lg:justify-between lg:p-10 xl:p-14">
      <div aria-hidden="true" className="absolute inset-0 -z-20 bg-[#04070d]" />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_24%_8%,rgba(34,211,238,0.16),transparent_58%),radial-gradient(ellipse_at_88%_74%,rgba(139,92,246,0.16),transparent_58%)]" />
      <div aria-hidden="true" className="vy-auth-grid absolute inset-0 -z-10 opacity-40" />

      {/* Scène 3D (ou repli CSS) : au centre, derrière le texte inférieur. */}
      <div className="vy-auth-stage absolute inset-x-0 top-[12%] -z-10 mx-auto h-[54%] w-full max-w-[620px]">
        {canRender3d ? (
          <SceneBoundary fallback={staticStage}>
            <Suspense fallback={staticStage}>
              <AuthScene variant={variant === 'enter' ? 'enter' : 'create'} />
            </Suspense>
          </SceneBoundary>
        ) : staticStage}
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#04070d] to-transparent" />
      </div>

      <div className="relative">
        <Link to="/" aria-label="SORAHNEX, accueil" className="inline-flex items-center gap-2.5">
          <BrandLockup symbolSize={40} tagline />
        </Link>
      </div>

      <div className="relative max-w-lg">
        <span className="vyora-eyebrow">
          <Sparkles size={12} /> {copy.eyebrow}
        </span>
        <h2 className="vyora-display mt-5 text-[2.1rem] leading-[1.06] text-white xl:text-[2.5rem]">{copy.title}</h2>
        <p className="mt-4 max-w-md text-[13.5px] leading-relaxed text-slate-300">{copy.lead}</p>
        <ul className="mt-6 grid gap-2">
          {copy.points.map((point) => (
            <li key={point} className="flex items-center gap-2.5 rounded-xl border border-white/[0.08] bg-black/25 px-3 py-2.5 text-[12px] text-slate-200 backdrop-blur">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-400/15 text-emerald-300">
                <Check size={11} strokeWidth={3} />
              </span>
              {point}
            </li>
          ))}
        </ul>
      </div>

      <div className="relative flex items-center justify-between gap-4 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck size={12} className="text-emerald-400" /> Authentification Supabase · politiques RLS
        </span>
        <span>© {new Date().getFullYear()} SORAHNEX</span>
      </div>
    </div>
  );
}

/**
 * Bandeau mobile : identité + accroche courte, sans scène 3D (autonomie).
 */
export function AuthStageMobile({ variant = 'create' }: { variant?: AuthVariant }) {
  const copy = COPY[variant];
  return (
    <div className="relative mb-7 overflow-hidden rounded-[1.4rem] border border-white/[0.08] bg-[#05090f] px-4 py-4 lg:hidden">
      <div aria-hidden="true" className="absolute -right-10 -top-14 h-40 w-40 rounded-full bg-cyan-400/15 blur-3xl" />
      <div aria-hidden="true" className="absolute -bottom-16 -left-8 h-36 w-36 rounded-full bg-violet-500/15 blur-3xl" />
      <div className="relative flex items-center gap-3">
        <BrandSymbol size={38} />
        <div className="min-w-0">
          <p className="font-display text-[13px] font-semibold tracking-[0.16em] text-white">SORAHNEX</p>
          <p className="truncate text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">{copy.eyebrow}</p>
        </div>
        <Link to="/" className="ml-auto shrink-0 text-[11px] text-slate-400 transition hover:text-white">Accueil</Link>
      </div>
    </div>
  );
}

export { cn };
