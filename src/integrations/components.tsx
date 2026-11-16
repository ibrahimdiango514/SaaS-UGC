// VYORA Connect — briques d'affichage pures.
//
// Aucun de ces composants ne décide d'une autorisation : ils rendent ce qu'on
// leur donne. Les règles (« peut-on connecter ? ») vivent dans
// `providers.ts`, testables sans DOM.

import type { ReactNode } from 'react';
import { AlertTriangle, Check, Lock, Minus } from 'lucide-react';
import { cn } from '../components/ui';
import {
  CAPABILITIES,
  type ConnectedAccountView,
  type OAuthCapability,
  type ProviderCardViewModel,
  capabilityLabel,
  capabilityRisk,
} from './providers';

/* ----------------------------- Statut ----------------------------------- */

const STATUS_STYLES: Record<string, { className: string; icon: ReactNode }> = {
  ready: { className: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30', icon: <Check size={12} /> },
  needs_setup: { className: 'bg-amber-500/10 text-amber-300 ring-amber-500/30', icon: <AlertTriangle size={12} /> },
  awaiting_review: { className: 'bg-slate-500/10 text-slate-300 ring-slate-500/30', icon: <Lock size={12} /> },
  unavailable: { className: 'bg-slate-500/10 text-slate-400 ring-slate-500/30', icon: <Minus size={12} /> },
};

export function StatusChip({ status, label }: { status: string; label: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.unavailable;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset',
        style.className,
      )}
      data-status={status}
    >
      {style.icon}
      {label}
    </span>
  );
}

/* --------------------------- Capacités ---------------------------------- */

const RISK_STYLES: Record<string, string> = {
  low: 'text-emerald-300/90',
  medium: 'text-amber-300/90',
  high: 'text-rose-300/90',
};

/**
 * Sélecteur de permissions.
 *
 * Chaque capacité est une case indépendante : cocher « rédiger » ne coche
 * jamais « envoyer ». Les capacités à risque élevé portent un avertissement
 * explicite, parce que l'utilisateur doit comprendre ce qu'il accorde.
 */
export function CapabilityPicker({
  available,
  selected,
  onChange,
  disabled,
}: {
  available: readonly OAuthCapability[];
  selected: readonly OAuthCapability[];
  onChange: (next: OAuthCapability[]) => void;
  disabled?: boolean;
}) {
  if (available.length === 0) return null;

  return (
    <fieldset className="space-y-2" disabled={disabled} aria-label="Permissions demandées">
      <legend className="sr-only">Permissions demandées</legend>
      {CAPABILITIES.filter((capability) => available.includes(capability.id)).map((capability) => {
        const checked = selected.includes(capability.id);
        return (
          <label
            key={capability.id}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition',
              checked
                ? 'border-brand-400/40 bg-brand-400/5'
                : 'border-white/10 bg-white/[0.02] hover:border-white/20',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/20 bg-transparent accent-brand-400"
              checked={checked}
              onChange={() => {
                const next = checked
                  ? selected.filter((item) => item !== capability.id)
                  : [...selected, capability.id];
                // On conserve l'ordre de moindre privilège, pas l'ordre de clic.
                onChange(CAPABILITIES.map((c) => c.id).filter((id) => next.includes(id)));
              }}
            />
            <span className="min-w-0">
              <span className={cn('text-sm font-medium', RISK_STYLES[capability.risk])}>
                {capability.label}
                {capability.risk === 'high' && (
                  <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-rose-400/80">
                    action irréversible
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">
                {capability.description}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** Permissions réellement accordées — jamais celles demandées. */
export function GrantedCapabilities({ capabilities }: { capabilities: readonly string[] }) {
  if (capabilities.length === 0) {
    return <span className="text-xs text-slate-500">Aucune permission accordée</span>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Permissions accordées">
      {capabilities.map((capability) => (
        <li
          key={capability}
          className={cn(
            'rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
            capabilityRisk(capability) === 'high'
              ? 'bg-rose-500/10 text-rose-300 ring-rose-500/25'
              : 'bg-white/5 text-slate-300 ring-white/10',
          )}
        >
          {capabilityLabel(capability)}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------- Carte fournisseur ---------------------------- */

export function ProviderCard({
  card,
  onConnect,
  connecting,
}: {
  card: ProviderCardViewModel;
  onConnect: () => void;
  connecting?: boolean;
}) {
  const { provider, status, statusLabel, actionable, reason } = card;
  return (
    <article
      className="flex h-full flex-col justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5"
      data-provider={provider.id}
      data-status={status}
    >
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-white">{provider.name}</h3>
          <StatusChip status={status} label={statusLabel} />
        </div>
        <p className="text-sm leading-relaxed text-slate-400">{reason}</p>
        {provider.capabilities.length > 0 && (
          <p className="text-xs text-slate-500">
            Permissions proposées :{' '}
            {provider.capabilities.map((c) => capabilityLabel(c)).join(', ')}.
          </p>
        )}
      </div>

      <div>
        {actionable ? (
          <button
            type="button"
            onClick={onConnect}
            disabled={connecting}
            className="w-full rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {connecting ? 'Ouverture…' : 'Connecter'}
          </button>
        ) : (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-2.5 text-center text-xs text-slate-500">
            {status === 'needs_setup'
              ? 'Connexion indisponible tant que la configuration serveur est incomplète.'
              : 'Aucune action possible pour le moment.'}
          </div>
        )}
      </div>
    </article>
  );
}

/* --------------------------- Compte connecté ---------------------------- */

export function ConnectedAccountCard({
  account,
  onRevoke,
  onRefresh,
  busy,
}: {
  account: ConnectedAccountView;
  onRevoke: () => void;
  onRefresh: () => void;
  busy?: boolean;
}) {
  const degraded = account.status === 'expired' || account.status === 'error';
  return (
    <article
      className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-5"
      data-account-id={account.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-white">{account.providerName}</h3>
          <p className="truncate text-sm text-slate-400">
            {account.email ?? account.displayName ?? 'Compte sans adresse connue'}
          </p>
        </div>
        <StatusChip status={account.status} label={account.statusLabel} />
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Permissions réellement accordées
        </p>
        <GrantedCapabilities capabilities={account.capabilities} />
      </div>

      {degraded && account.lastError && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {account.lastError}
        </p>
      )}

      <p className="text-xs text-slate-500">
        Vérifié {account.lastVerifiedLabel} · Connecté le {account.createdLabel}
      </p>

      <div className="flex flex-wrap gap-2">
        {degraded && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white transition hover:border-white/30 disabled:opacity-50"
          >
            Renouveler l’autorisation
          </button>
        )}
        <button
          type="button"
          onClick={onRevoke}
          disabled={busy}
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-50"
        >
          Déconnecter
        </button>
      </div>
    </article>
  );
}
