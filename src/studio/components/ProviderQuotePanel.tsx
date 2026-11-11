import { AlertCircle, CheckCircle2, Clock3, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Button, cn } from '../../components/ui';
import type { ProviderQuote } from '../../lib/types';

const UNIT_LABELS: Record<string, string> = {
  duration: 'durée',
  resolution: 'résolution',
  quantity: 'quantité',
  audio: 'audio',
  aspect_ratio: 'format',
  fps: 'images/s',
  bitrate: 'débit',
  draft: 'brouillon',
};

const SOURCE_LABELS: Record<ProviderQuote['source'], string> = {
  provider_estimate: 'Tarif exact du fournisseur',
  catalog_tariff: 'Tarif catalogue vérifié',
  none: 'Aucun tarif vérifié',
};

const ERROR_HINTS: Record<string, string> = {
  MODEL_NOT_FOUND: 'Choisissez un autre modèle dans le catalogue.',
  MODEL_UNAVAILABLE: 'Ce modèle n’est pas disponible pour votre compte.',
  PROVIDER_KEY_MISSING: 'Le service vidéo doit être configuré côté serveur.',
  PROMPT_REQUIRED: 'Ajoutez une instruction vidéo pour obtenir un devis exact.',
  PROVIDER_AUTH_FAILED: 'Le fournisseur a refusé la clé serveur. Contactez l’administrateur.',
  PROVIDER_RATE_LIMITED: 'Trop de demandes de devis. Patientez quelques secondes.',
  PROVIDER_UNAVAILABLE: 'Le fournisseur est momentanément indisponible.',
  PROVIDER_TIMEOUT: 'Le fournisseur n’a pas répondu à temps.',
  PROVIDER_PRICE_MISSING: 'Le fournisseur ne communique pas de prix pour ces paramètres.',
  CURRENCY_UNSUPPORTED: 'Seuls les tarifs exprimés en USD vérifiables sont acceptés.',
  CATALOG_TARIFF_MISSING: 'Aucun tarif n’est publié pour ce modèle.',
};

export function formatUsdQuote(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function checkedAtLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'vérification serveur';
  return `vérifié à ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

function syncedAtLabel(value: string | null): string {
  if (!value) return 'date de synchronisation inconnue';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'date de synchronisation inconnue';
  return `catalogue synchronisé le ${date.toLocaleDateString('fr-FR')}`;
}

export function ProviderQuotePanel({
  quote,
  busy,
  error,
  onRefresh,
  compact = false,
}: {
  quote: ProviderQuote | null;
  busy?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  compact?: boolean;
}) {
  const refreshButton = onRefresh ? (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      icon={<RefreshCw size={12} className={busy ? 'animate-spin' : undefined} />}
      onClick={onRefresh}
      disabled={busy}
      aria-label="Recalculer le devis fournisseur"
    >
      {busy ? 'Calcul…' : 'Recalculer'}
    </Button>
  ) : null;

  if (busy && !quote) {
    return (
      <div data-testid="provider-quote-loading" className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.04] p-3">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-cyan-200">
          <Clock3 size={12} /> Calcul du devis fournisseur…
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
          Vérification du tarif réel MyAPI pour ces paramètres, sans lancer de génération.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="provider-quote-error" className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] p-3">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-rose-200">
          <AlertCircle size={12} /> Devis fournisseur indisponible
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-rose-100/80">{error}</p>
        {refreshButton && <div className="mt-2">{refreshButton}</div>}
      </div>
    );
  }

  if (!quote) {
    return (
      <div data-testid="provider-quote-empty" className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
        <p className="text-[11px] font-semibold text-slate-300">Devis fournisseur en attente</p>
        <p className="mt-1 text-[10px] text-slate-500">Sélectionnez un modèle et des paramètres valides.</p>
        {refreshButton && <div className="mt-2">{refreshButton}</div>}
      </div>
    );
  }

  if (!quote.available) {
    const hint = quote.error_code ? ERROR_HINTS[quote.error_code] : null;
    return (
      <div data-testid="provider-quote-unavailable" className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-3">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-200">
          <TriangleAlert size={12} /> Devis indisponible pour ce modèle
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-amber-100/85">
          {quote.error_message ?? 'Aucun tarif vérifiable n’a été renvoyé par le fournisseur.'}
        </p>
        {hint && <p className="mt-1 text-[10px] text-amber-100/60">{hint}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-black/20 px-1.5 py-0.5 font-mono text-[9px] text-amber-200/80">{quote.error_code ?? 'UNKNOWN'}</span>
          {refreshButton}
        </div>
        <p className="mt-2 text-[10px] text-slate-500">Aucun montant n’est affiché : VYORA ne complète jamais un prix manquant.</p>
      </div>
    );
  }

  const basisEntries = Object.entries(quote.pricing_basis ?? {});

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.08] px-2 py-1 font-semibold text-emerald-200">
          {formatUsdQuote(quote.cost_usd ?? 0)}
        </span>
        <span className="text-slate-500">{SOURCE_LABELS[quote.source]}</span>
        {refreshButton}
      </div>
    );
  }

  return (
    <div data-testid="provider-quote-available" className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.05] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200">
            <CheckCircle2 size={12} /> Devis fournisseur vérifié
          </p>
          <p className="mt-1 text-2xl font-bold leading-none text-white">
            {formatUsdQuote(quote.cost_usd ?? 0)}
            <span className="ml-1 text-[11px] font-medium text-emerald-200/80">USD</span>
          </p>
          <p className="mt-1 text-[10px] text-slate-400">{SOURCE_LABELS[quote.source]} · {checkedAtLabel(quote.checked_at)}</p>
        </div>
        {refreshButton}
      </div>

      {basisEntries.length > 0 && (
        <div className="mt-2.5">
          <p className="text-[10px] text-slate-500">Paramètres facturés transmis au fournisseur</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {basisEntries.map(([key, value]) => (
              <span key={key} className="rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-slate-300">
                {UNIT_LABELS[key] ?? key} : {String(value)}
              </span>
            ))}
          </div>
        </div>
      )}

      {quote.billing_units.length > 0 && (
        <p className="mt-2 text-[10px] text-slate-500">
          Unités facturées par le modèle : {quote.billing_units.map((unit) => UNIT_LABELS[unit] ?? unit).join(', ')}.
        </p>
      )}

      {quote.stale_catalog && (
        <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-amber-200">
          <ShieldAlert size={11} className="mt-0.5 shrink-0" />
          {syncedAtLabel(quote.catalog_synced_at)} — tarif à revérifier avant une décision d’achat.
        </p>
      )}

      <p className={cn('mt-2 text-[10px] leading-relaxed text-slate-500')}>
        Ce montant provient du fournisseur, pas d’une estimation locale. Il ne déclenche aucune génération et n’est pas débité de vos crédits.
      </p>
    </div>
  );
}
