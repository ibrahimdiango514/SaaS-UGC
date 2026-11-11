import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, Sparkles } from 'lucide-react';
import { BrandLockup, BrandSymbol } from './Brand';

export default function AuthShell({ title, subtitle, children, footer }: {
  title: string; subtitle: string; children: ReactNode; footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden overflow-hidden border-r border-white/[0.06] bg-[#05080e] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <img src="/brand/vyora-hero.jpg" alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover opacity-55" />
        <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(to_top,#05080e_8%,rgba(5,8,14,0.55)_55%,rgba(5,8,14,0.25))]" />
        <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_25%,transparent,rgba(5,8,14,0.55))]" />
        <div aria-hidden="true" className="absolute -left-24 top-10 h-96 w-96 animate-aurora rounded-full bg-cyan-500/15 blur-[100px]" />
        <div className="relative">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandLockup symbolSize={40} tagline />
          </Link>
          <div className="mt-24 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-100 backdrop-blur">
            <Sparkles size={12} /> Votre espace de travail
          </div>
          <h2 className="vyora-display mt-5 max-w-md text-4xl leading-tight text-white">
            Une plateforme. <span className="gradient-text">Deux dimensions.</span> Tout votre potentiel.
          </h2>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-slate-300">
            Créez des contenus qui marquent. Développez votre activité avec l’IA. Une seule plateforme, un même espace de travail.
          </p>
          <div className="mt-9 grid max-w-md gap-2">
            {['Authentification sécurisée Supabase', 'Clés d’API exclusivement côté serveur', 'Isolation des données par espace'].map((x) => (
              <p key={x} className="flex items-center gap-2.5 rounded-xl border border-white/[0.08] bg-black/25 px-3 py-2.5 text-[12px] text-slate-200 backdrop-blur"><ShieldCheck size={15} className="text-emerald-300" /> {x}</p>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-slate-500">© {new Date().getFullYear()} VYORA · Create. Evolve. Grow.</p>
      </div>

      <div className="relative flex flex-col px-4 py-8 sm:px-8">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(ellipse_at_50%_-30%,rgba(34,211,238,0.10),transparent_70%)]" />
        <div className="mb-8 flex items-center justify-between lg:hidden">
          <Link to="/" aria-label="VYORA, accueil"><BrandSymbol size={34} /><span className="sr-only">VYORA</span></Link>
          <Link to="/" className="text-xs text-slate-400 hover:text-white">Retour à l’accueil</Link>
        </div>
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
          <h1 className="text-2xl font-bold text-white sm:text-3xl">{title}</h1>
          <p className="mt-2 text-sm text-slate-400">{subtitle}</p>
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-6 text-center text-sm text-slate-400">{footer}</div>}
        </div>
      </div>
    </div>
  );
}
