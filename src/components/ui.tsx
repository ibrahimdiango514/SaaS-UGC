import { forwardRef, useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertCircle, Inbox, Loader2, X } from 'lucide-react';
import { statusTone } from '../lib/format';

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

/* ------------------------------- Button ---------------------------------- */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...props }, ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn('btn', `btn-${variant}`, `btn-${size}`, className)}
      {...props}
    >
      {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
});

/* -------------------------------- Card ----------------------------------- */
export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card', className)} {...props}>{children}</div>;
}

export function CardHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div>
        <h2 className="text-base font-semibold text-white">{title}</h2>
        {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/* ------------------------------- Inputs ---------------------------------- */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }>(
  function Input({ label, hint, error, className, id, ...props }, ref) {
    const inputId = id || `f-${label?.toLowerCase().replace(/\s/g, '-')}`;
    return (
      <label className="field" htmlFor={inputId}>
        {label && <span className="field-label">{label}</span>}
        <input ref={ref} id={inputId} className={cn('input', error && 'input-error', className)} {...props} />
        {hint && !error && <span className="field-hint">{hint}</span>}
        {error && <span className="field-error">{error}</span>}
      </label>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: string }>(
  function Textarea({ label, hint, className, id, ...props }, ref) {
    const inputId = id || `f-${label?.toLowerCase().replace(/\s/g, '-')}`;
    return (
      <label className="field" htmlFor={inputId}>
        {label && <span className="field-label">{label}</span>}
        <textarea ref={ref} id={inputId} className={cn('input min-h-[110px] resize-y', className)} {...props} />
        {hint && <span className="field-hint">{hint}</span>}
      </label>
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { label?: string; hint?: string }>(
  function Select({ label, hint, className, id, children, ...props }, ref) {
    const inputId = id || `f-${label?.toLowerCase().replace(/\s/g, '-')}`;
    return (
      <label className="field" htmlFor={inputId}>
        {label && <span className="field-label">{label}</span>}
        <select ref={ref} id={inputId} className={cn('input appearance-none pr-9', className)} {...props}>{children}</select>
        {hint && <span className="field-hint">{hint}</span>}
      </label>
    );
  },
);

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex items-center justify-between gap-3 text-sm text-slate-200">
      <span>{label}</span>
      <span className={cn('relative h-6 w-11 rounded-full transition-colors', checked ? 'bg-brand-500' : 'bg-white/15')}>
        <span className={cn('absolute top-1 h-4 w-4 rounded-full bg-white transition-all', checked ? 'left-6' : 'left-1')} />
      </span>
    </button>
  );
}

/* -------------------------------- Badge ---------------------------------- */
export function Badge({ status, children, tone }: { status?: string; children?: ReactNode; tone?: string }) {
  const t = tone || (status ? statusTone(status) : 'neutral');
  return <span className={cn('badge', `badge-${t}`)}>{children ?? status}</span>;
}

/* ------------------------------- Feedback -------------------------------- */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('animate-spin text-brand-300', className)} size={22} />;
}

export function LoadingState({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-slate-400">
      <Spinner />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />;
}

export function EmptyState({ title, description, icon, action }: { title: string; description?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-white/5 text-brand-300">{icon ?? <Inbox size={24} />}</div>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {description && <p className="max-w-md text-sm text-slate-400">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/5 px-6 py-12 text-center">
      <AlertCircle className="text-rose-400" size={26} />
      <p className="max-w-lg text-sm text-rose-100">{message}</p>
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Réessayer</Button>}
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">{eyebrow}</p>}
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-slate-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, icon, hint, tone = 'brand' }: { label: string; value: ReactNode; icon?: ReactNode; hint?: string; tone?: 'brand' | 'cyan' | 'emerald' | 'amber' }) {
  const tones: Record<string, string> = {
    brand: 'from-brand-500/25 to-brand-700/5 text-brand-300',
    cyan: 'from-cyan-400/20 to-cyan-600/5 text-cyan-300',
    emerald: 'from-emerald-400/20 to-emerald-600/5 text-emerald-300',
    amber: 'from-amber-400/20 to-amber-600/5 text-amber-300',
  };
  return (
    <Card className="relative overflow-hidden p-5">
      <div className={cn('absolute -right-6 -top-8 h-28 w-28 rounded-full bg-gradient-to-br blur-2xl', tones[tone])} />
      <div className="relative flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">{label}</p>
          <p className="mt-2 text-2xl font-bold text-white sm:text-3xl">{value}</p>
          {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
        </div>
        {icon && <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br', tones[tone])}>{icon}</div>}
      </div>
    </Card>
  );
}

export function ProgressBar({ value, max, tone = 'brand' }: { value: number; max: number; tone?: 'brand' | 'cyan' | 'emerald' | 'amber' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const colors: Record<string, string> = {
    brand: 'bg-brand-500', cyan: 'bg-cyan-400', emerald: 'bg-emerald-400', amber: 'bg-amber-400',
  };
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.08]">
      <div className={cn('h-full rounded-full transition-all duration-500', colors[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: string; description?: string;
  children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg';
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);

  if (!open) return null;
  const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cn('w-full animate-fadeUp rounded-t-3xl border border-line bg-panel shadow-2xl sm:rounded-2xl', sizes[size])} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Fermer"><X size={18} /></button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirmer', danger, onConfirm, onClose, loading }: {
  open: boolean; title: string; message: string; confirmLabel?: string; danger?: boolean;
  onConfirm: () => void; onClose: () => void; loading?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Annuler</Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
      </>}>
      <p className="text-sm leading-relaxed text-slate-300">{message}</p>
    </Modal>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string; icon?: ReactNode }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-line bg-panel/60 p-1">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)}
          className={cn('flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            active === t.id ? 'bg-brand-500/20 text-brand-200' : 'text-slate-400 hover:bg-white/5 hover:text-white')}>
          {t.icon}{t.label}
        </button>
      ))}
    </div>
  );
}

export function Banner({ tone = 'warning', title, children }: { tone?: 'warning' | 'info' | 'danger' | 'success'; title: string; children?: ReactNode }) {
  const tones = {
    warning: 'border-amber-400/25 bg-amber-400/[0.08] text-amber-200',
    info: 'border-brand-400/25 bg-brand-400/[0.08] text-brand-200',
    danger: 'border-rose-400/25 bg-rose-400/[0.08] text-rose-200',
    success: 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200',
  };
  return (
    <div className={cn('rounded-xl border px-4 py-3 text-sm', tones[tone])}>
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 text-xs opacity-90">{children}</div>}
    </div>
  );
}
