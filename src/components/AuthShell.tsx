import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { BrandLockup, BrandSymbol } from './Brand';

export default function AuthShell({ title, subtitle, children, footer }: {
  title: string; subtitle: string; children: ReactNode; footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden overflow-hidden border-r border-line lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="absolute -left-24 top-10 h-96 w-96 rounded-full bg-brand-600/25 blur-3xl" />
        <div className="absolute -bottom-24 right-0 h-80 w-80 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="relative">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandLockup symbolSize={40} tagline />
          </Link>
          <h2 className="mt-20 max-w-md text-4xl font-extrabold leading-tight text-white">
            Une plateforme. <span className="gradient-text">Deux dimensions.</span> Tout votre potentiel.
          </h2>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-slate-400">
            Créez des contenus qui marquent. Développez votre activité avec l’IA. Une seule plateforme, un même espace de travail.
          </p>
          <div className="mt-10 space-y-3">
            {['Authentification sécurisée Supabase', 'Clés d’API exclusivement côté serveur', 'Isolation des données par RLS'].map((x) => (
              <p key={x} className="flex items-center gap-2.5 text-sm text-slate-300"><ShieldCheck size={16} className="text-emerald-400" /> {x}</p>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-slate-600">© {new Date().getFullYear()} VYORA · Create. Evolve. Grow.</p>
      </div>

      <div className="flex flex-col px-4 py-8 sm:px-8">
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
