import type { ReactNode } from 'react';
import { ArrowUpRight, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from './ui';

/**
 * Composants premium réutilisables (phase « expérience »).
 *
 * Tous sont **présentationnels** : ils n'inventent aucune donnée, n'appellent
 * aucune API et n'affichent que ce qu'on leur passe. Un lien `FeatureCard`
 * exige une destination réelle — il n'existe aucune carte décorative.
 */

/** Carte d'espace de travail (identité forte, image, liste d'atouts). */
export function WorkspaceCard({
  to,
  name,
  tagline,
  description,
  image,
  imageAlt,
  icon: Icon,
  benefits,
  footer,
  accent = 'cyan',
  cta,
  delay = 0,
}: {
  to: string;
  name: string;
  tagline: string;
  description: string;
  image: string;
  imageAlt: string;
  icon: LucideIcon;
  benefits: string[];
  footer?: ReactNode;
  accent?: 'cyan' | 'violet';
  cta: string;
  delay?: number;
}) {
  return (
    <Link
      to={to}
      className={cn(
        'vy-in group relative flex h-full flex-col overflow-hidden rounded-[1.7rem] border transition duration-300 hover:-translate-y-1',
        accent === 'cyan'
          ? 'border-cyan-200/15 bg-[#081018] hover:border-cyan-200/40'
          : 'border-violet-200/15 bg-[#0b0a13] hover:border-violet-200/40',
      )}
      style={{ ['--vy-delay' as string]: `${delay}ms` }}
    >
      <div className="relative h-40 overflow-hidden sm:h-48">
        <img src={image} alt={imageAlt} className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.04]" />
        <div
          aria-hidden="true"
          className={cn(
            'absolute inset-0 bg-gradient-to-t to-transparent',
            accent === 'cyan' ? 'from-[#081018] via-[#081018]/45' : 'from-[#0b0a13] via-[#0b0a13]/55',
          )}
        />
        <span className={cn(
          'absolute left-4 top-4 grid h-10 w-10 place-items-center rounded-xl border backdrop-blur',
          accent === 'cyan'
            ? 'border-cyan-200/25 bg-cyan-400/10 text-cyan-100'
            : 'border-violet-200/25 bg-violet-400/10 text-violet-100',
        )}>
          <Icon size={17} />
        </span>
      </div>

      <div className="flex flex-1 flex-col p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-xl font-medium tracking-[-0.03em] text-white sm:text-[1.45rem]">{name}</h3>
            <p className={cn('mt-1 text-[10px] font-semibold uppercase tracking-[0.18em]', accent === 'cyan' ? 'text-cyan-200/75' : 'text-violet-200/75')}>
              {tagline}
            </p>
          </div>
          <span className={cn(
            'grid h-9 w-9 shrink-0 place-items-center rounded-xl border transition',
            accent === 'cyan'
              ? 'border-cyan-200/20 bg-cyan-400/[0.08] text-cyan-200 group-hover:bg-cyan-400/15'
              : 'border-violet-200/20 bg-violet-400/[0.08] text-violet-200 group-hover:bg-violet-400/15',
          )}>
            <ArrowUpRight size={16} />
          </span>
        </div>

        <p className="mt-3 text-[12.5px] leading-relaxed text-slate-300">{description}</p>

        <ul className="mt-4 grid gap-1.5 sm:grid-cols-2">
          {benefits.map((benefit) => (
            <li key={benefit} className="flex items-start gap-1.5 text-[11px] leading-snug text-slate-400">
              <span aria-hidden="true" className={cn('mt-1 h-1 w-1 shrink-0 rounded-full', accent === 'cyan' ? 'bg-cyan-300' : 'bg-violet-300')} />
              <span className="min-w-0">{benefit}</span>
            </li>
          ))}
        </ul>

        {footer && <div className="mt-4 text-[10.5px] leading-relaxed text-slate-500">{footer}</div>}

        <span className={cn(
          'mt-auto inline-flex items-center gap-1.5 pt-5 text-[12px] font-semibold',
          accent === 'cyan' ? 'text-cyan-200' : 'text-violet-200',
        )}>
          {cta}
          <span aria-hidden="true" className="transition group-hover:translate-x-0.5">→</span>
        </span>
      </div>
    </Link>
  );
}

/** Carte de fonctionnalité : icône, titre, description, destination réelle. */
export function FeatureCard({
  to,
  icon: Icon,
  title,
  description,
  meta,
  badge,
  delay = 0,
}: {
  to: string;
  icon: LucideIcon;
  title: string;
  description: string;
  meta?: string;
  badge?: string;
  delay?: number;
}) {
  return (
    <Link
      to={to}
      className="vy-surface vy-surface-hover vy-halo vy-in group flex min-h-[7.5rem] flex-col p-4"
      style={{ ['--vy-delay' as string]: `${delay}ms` }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="vy-icon-tile h-9 w-9">
          <Icon size={16} />
        </span>
        <span className="flex items-center gap-1.5">
          {badge && (
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-400">
              {badge}
            </span>
          )}
          <ArrowUpRight size={14} className="text-slate-600 transition group-hover:text-white" />
        </span>
      </div>
      <p className="mt-3 text-[13px] font-semibold leading-snug text-white">{title}</p>
      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{description}</p>
      {meta && <p className="mt-auto pt-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-600">{meta}</p>}
    </Link>
  );
}

/** En-tête de section avec compteur optionnel. */
export function SectionHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">{eyebrow}</p>
        <h2 className="mt-1 truncate font-display text-lg font-medium tracking-[-0.02em] text-white sm:text-xl">{title}</h2>
      </div>
      {action}
    </div>
  );
}

/** Métrique compacte du tableau de bord d'accueil. */
export function MetricPill({ label, value, icon: Icon, hint }: { label: string; value: ReactNode; icon: LucideIcon; hint?: string }) {
  return (
    <div className="vy-surface-quiet flex items-center gap-3 p-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-cyan-200">
        <Icon size={15} />
      </span>
      <div className="min-w-0">
        <p className="vy-metric-label truncate">{label}</p>
        <p className="truncate font-display text-[15px] font-semibold text-white">{value}</p>
        {hint && <p className="truncate text-[10px] text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}
