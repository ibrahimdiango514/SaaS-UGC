import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { AuthStage, AuthStageMobile, type AuthVariant } from './auth/AuthStage';
import { cn } from './ui';

/**
 * Coquille du parcours d'authentification VYORA.
 *
 * L'API publique (`title`, `subtitle`, `children`, `footer`) est conservée à
 * l'identique : les pages existantes continuent de fonctionner sans
 * modification. `variant` choisit seulement l'univers visuel du panneau :
 *  - `create`  → inscription (cyan, création) ;
 *  - `enter`   → connexion (violet, reprise d'activité) ;
 *  - `secure`  → mot de passe oublié / parcours propriétaire.
 *
 * Structure : colonne visuelle à gauche (≥ lg), formulaire à droite, toujours
 * lisible en pleine largeur sur mobile.
 */
export default function AuthShell({
  title,
  subtitle,
  children,
  footer,
  variant = 'create',
  eyebrow,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
  variant?: AuthVariant;
  eyebrow?: string;
}) {
  return (
    <div className="vy-auth vy-auth-bg grid lg:grid-cols-[1.02fr_1fr]">
      <AuthStage variant={variant} />

      <main id="contenu" className="relative flex min-h-screen flex-col px-4 py-7 sm:px-8 lg:px-10 lg:py-10">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(ellipse_at_50%_-30%,rgba(34,211,238,0.10),transparent_70%)]" />

        <AuthStageMobile variant={variant} />

        <div className="relative mx-auto flex w-full max-w-[27rem] flex-1 flex-col justify-center py-2">
          <div className="vy-in">
            <div className="mb-6 hidden items-center justify-end gap-3 lg:flex">
              <Link to="/" className="text-[11.5px] text-slate-400 transition hover:text-white">← Retour à l’accueil</Link>
            </div>

            {eyebrow && <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200/80">{eyebrow}</p>}
            <h1 className="vyora-display text-[1.85rem] leading-[1.1] text-white sm:text-[2.15rem]">{title}</h1>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-slate-400">{subtitle}</p>
          </div>

          <div className="vy-in mt-7" style={{ ['--vy-delay' as string]: '90ms' }}>
            {children}
          </div>

          {footer && (
            <div className="vy-in mt-6 text-center text-[13px] text-slate-400" style={{ ['--vy-delay' as string]: '180ms' }}>
              {footer}
            </div>
          )}
        </div>

        <div className={cn('relative mx-auto mt-8 flex w-full max-w-[27rem] flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[10.5px] text-slate-500')}>
          <span className="inline-flex items-center gap-1.5"><Lock size={11} className="text-emerald-400/80" /> Connexion chiffrée</span>
          <span aria-hidden="true" className="h-3 w-px bg-white/10" />
          <Link to="/confidentialite" className="transition hover:text-slate-300">Confidentialité</Link>
          <Link to="/conditions" className="transition hover:text-slate-300">Conditions</Link>
        </div>
      </main>
    </div>
  );
}
