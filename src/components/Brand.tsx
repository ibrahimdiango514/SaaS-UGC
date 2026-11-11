import { cn } from './ui';

export function BrandSymbol({ className, size = 36 }: { className?: string; size?: number }) {
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
        <path d="M7 11.5h8.2l5.1 15 5.2-15H33L23.1 32h-5.7L7 11.5Z" fill="url(#vyora-mark)" />
        <path d="M28.5 8.5v5M26 11h5" stroke="#E8FDFF" strokeLinecap="round" strokeWidth="1.5" />
        <defs>
          <linearGradient id="vyora-mark" x1="7" y1="11.5" x2="29" y2="31" gradientUnits="userSpaceOnUse">
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
      VYORA
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
        {tagline && <span className="mt-1.5 text-[9px] font-medium tracking-[0.16em] text-slate-400">CREATE. EVOLVE. GROW.</span>}
      </span>
    </span>
  );
}
