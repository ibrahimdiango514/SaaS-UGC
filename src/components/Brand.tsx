import { useId } from 'react';
import { cn } from './ui';

export function BrandSymbol({ className, size = 36 }: { className?: string; size?: number }) {
  // Un dégradé SVG partagé par plusieurs instances porte le même `id` : le
  // navigateur ne résout alors que la première, et les symboles suivants
  // s'affichent vides. L'identifiant est donc unique par instance.
  const gradientId = `sorahnex-mark-${useId().replace(/[:]/g, '')}`;

  return (
    <span
      className={cn(
        'relative grid shrink-0 place-items-center overflow-hidden rounded-xl border border-white/15 bg-[#111b27] text-cyan-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]',
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 40 40" width={size * 0.72} height={size * 0.72} fill="none">
        {/* Monogramme SORAHNEX : un « S » tracé d’un seul geste. */}
        <path
          d="M26.5 14.2c-1.4-1.4-3.7-2.2-6.1-2.2-3.9 0-6.4 2-6.4 5 0 3 2.2 4.2 6.2 5 3.3.7 4.6 1.3 4.6 2.8 0 1.6-1.7 2.6-4.3 2.6-2.6 0-4.9-.9-6.5-2.5"
          stroke={`url(#${gradientId})`}
          strokeLinecap="round"
          strokeWidth="3.2"
        />
        <path d="M30.5 9.5v3.6M28.7 11.3h3.6" stroke="#E8FDFF" strokeLinecap="round" strokeWidth="1.4" />
        <defs>
          <linearGradient id={gradientId} x1="10" y1="10" x2="30" y2="30" gradientUnits="userSpaceOnUse">
            <stop stopColor="#A5F3FC" />
            <stop offset=".58" stopColor="#22D3EE" />
            <stop offset="1" stopColor="#A78BFA" />
          </linearGradient>
        </defs>
      </svg>
    </span>
  );
}

export function BrandName({ className }: { className?: string }) {
  return (
    <span className={cn('font-display font-bold tracking-[0.12em] text-white', className)}>
      SORAHNEX
    </span>
  );
}

export function BrandLockup({
  className,
  symbolSize = 36,
  tagline = false,
}: {
  className?: string;
  symbolSize?: number;
  tagline?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandSymbol size={symbolSize} />
      <span className="flex flex-col leading-none">
        <BrandName className="text-[15px]" />
        {tagline && <span className="mt-1.5 whitespace-nowrap text-[9px] font-medium tracking-[0.14em] text-slate-400">CREATE. EVOLVE. GROW.</span>}
      </span>
    </span>
  );
}
