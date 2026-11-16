import {
  forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode,
} from 'react';
import { AlertCircle, Check, Eye, EyeOff, Loader2, ShieldAlert } from 'lucide-react';
import { cn } from '../ui';

/**
 * Primitives de formulaire du parcours d'authentification.
 *
 * Elles regroupent les états visuels (repos, focus, valide, invalide) et
 * l'accessibilité (label lié, `aria-invalid`, `aria-describedby`, annonce des
 * erreurs). Aucune logique métier : les pages gardent leurs validations et
 * leurs messages existants.
 */

export interface AuthFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string;
  icon?: ReactNode;
  hint?: string;
  error?: string;
  /** Affiche une coche quand le champ est valide (jamais sur un champ vide). */
  valid?: boolean;
  /** Bouton œil pour les champs mot de passe. */
  revealable?: boolean;
  /** Slot à droite (compteur, unité…). */
  trailing?: ReactNode;
}

export const AuthField = forwardRef<HTMLInputElement, AuthFieldProps>(function AuthField(
  { label, icon, hint, error, valid, revealable, trailing, id, type = 'text', value, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? `vy-field-${autoId.replace(/[:]/g, '')}`;
  const [revealed, setRevealed] = useState(false);
  const messageId = `${inputId}-msg`;
  const inputType = revealable ? (revealed ? 'text' : 'password') : type;
  const showValid = Boolean(valid) && !error;

  return (
    <div className="vy-field">
      <label htmlFor={inputId} className="vy-field-label">{label}</label>
      <div className="vy-field-shell" data-invalid={error ? 'true' : undefined} data-valid={showValid ? 'true' : undefined}>
        {icon && <span className="vy-field-icon" aria-hidden="true">{icon}</span>}
        <input
          ref={ref}
          id={inputId}
          type={inputType}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? messageId : undefined}
          className="vy-field-input"
          {...props}
        />
        {revealable && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
            aria-pressed={revealed}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:text-white"
          >
            {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
        {!revealable && showValid && (
          <span className="grid h-11 w-9 shrink-0 place-items-center text-emerald-400" aria-hidden="true">
            <Check size={15} strokeWidth={2.6} />
          </span>
        )}
        {trailing}
      </div>
      {(error || hint) && (
        <p
          id={messageId}
          role={error ? 'alert' : undefined}
          className={cn('vy-field-msg', error ? 'text-rose-300' : 'text-slate-500')}
        >
          {error || hint}
        </p>
      )}
    </div>
  );
});

/** Message d'état global (erreur serveur, information, succès). */
export function AuthNotice({ tone = 'error', children }: { tone?: 'error' | 'info' | 'success'; children: ReactNode }) {
  const tones = {
    error: 'border-rose-400/30 bg-rose-500/[0.09] text-rose-100',
    info: 'border-cyan-300/25 bg-cyan-400/[0.07] text-cyan-100',
    success: 'border-emerald-400/30 bg-emerald-500/[0.09] text-emerald-100',
  } as const;
  const Icon = tone === 'error' ? AlertCircle : tone === 'success' ? Check : ShieldAlert;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[12.5px] leading-relaxed', tones[tone])}>
      <Icon size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export type AuthSubmitState = 'idle' | 'loading' | 'success';

/** Bouton principal : états repos / chargement / réussite (coche animée). */
export function AuthSubmit({
  children, loadingLabel, successLabel, state = 'idle', icon, className, disabled,
}: {
  children: ReactNode;
  loadingLabel: string;
  successLabel: string;
  state?: AuthSubmitState;
  icon?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const success = state === 'success';
  return (
    <button
      type="submit"
      disabled={disabled || state !== 'idle'}
      aria-busy={state === 'loading'}
      className={cn('vy-btn vy-btn-accent min-h-12 w-full px-5 text-[14px]', className)}
      style={success ? { backgroundImage: 'linear-gradient(120deg,#34d399,#10b981)', color: '#03140e' } : undefined}
    >
      {state === 'loading' && <Loader2 size={17} className="animate-spin" aria-hidden="true" />}
      {success && (
        <svg className="vy-success-check" width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M4 10.5 8 14.5 16 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {state === 'idle' && icon}
      <span aria-live="polite">{state === 'loading' ? loadingLabel : success ? successLabel : children}</span>
    </button>
  );
}

/** Découpage visuel du parcours : segments qui se remplissent. */
export function AuthSteps({ labels, current }: { labels: readonly string[]; current: number }) {
  return (
    <div className="mb-5">
      <div className="vy-stepper" aria-hidden="true">
        {labels.map((label, index) => (
          <span
            key={label}
            className="vy-stepper-dot"
            data-state={index < current ? 'done' : index === current ? 'current' : 'todo'}
          />
        ))}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Étape {Math.min(current + 1, labels.length)} sur {labels.length}
        </p>
        <p className="truncate text-[11px] text-slate-500" aria-live="polite">{labels[current] ?? labels[labels.length - 1]}</p>
      </div>
    </div>
  );
}

/**
 * Indicateur de robustesse d'un mot de passe — purement indicatif.
 * Il ne remplace jamais la règle serveur (8 caractères minimum) : il aide
 * seulement à composer un mot de passe plus solide.
 */
export function passwordStrength(value: string): { score: 0 | 1 | 2 | 3 | 4; label: string; color: string } {
  if (!value) return { score: 0, label: '', color: 'bg-transparent' };
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value) || /[^A-Za-z0-9]/.test(value)) score += 1;
  const clamped = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  const meta = [
    { label: 'Trop court', color: 'bg-rose-400' },
    { label: 'Faible', color: 'bg-amber-400' },
    { label: 'Correct', color: 'bg-sky-400' },
    { label: 'Solide', color: 'bg-emerald-400' },
    { label: 'Excellent', color: 'bg-emerald-300' },
  ][clamped];
  return { score: clamped, ...meta };
}

export function PasswordMeter({ value, minimum = 8 }: { value: string; minimum?: number }) {
  const strength = passwordStrength(value);
  if (!value) return null;
  return (
    <div className="mt-1">
      <div className="vy-strength">
        <div
          className={cn('vy-strength-bar', strength.color)}
          style={{ width: `${Math.max(8, (strength.score / 4) * 100)}%` }}
        />
      </div>
      <p className="mt-1.5 flex items-center justify-between text-[10.5px] text-slate-500">
        <span>{value.length < minimum ? `Encore ${minimum - value.length} caractère(s)` : 'Longueur minimale atteinte'}</span>
        <span aria-live="polite" className="font-medium text-slate-400">{strength.label}</span>
      </p>
    </div>
  );
}
