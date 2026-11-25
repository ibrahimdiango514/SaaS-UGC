import { AlertCircle, CheckCircle2, Clock3, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui';
import type { ProviderQuote } from '../../lib/types';

/** Le prix client en crédits est affiché séparément par CostConfirm. */
export function ProviderQuotePanel({ quote, busy, error, onRefresh, compact = false }: {
  quote: ProviderQuote | null;
  busy?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  compact?: boolean;
}) {
  const state = busy && !quote ? 'loading' : error ? 'error' : !quote ? 'empty' : (quote.verified ?? quote.available) ? 'available' : 'unavailable';
  const message = state === 'loading' ? 'Calcul du devis en cours…'
    : state === 'error' ? 'Impossible de vérifier le devis. Réessayez.'
    : state === 'empty' ? 'Sélectionnez un modèle et des paramètres valides.'
    : state === 'available' ? 'Vérification effectuée. Consultez le coût en crédits SORAHNEX.'
    : quote?.error_code === 'PROMPT_REQUIRED' ? 'Ajoutez une instruction pour obtenir un devis.'
    : 'Le coût en crédits est temporairement indisponible.';
  return (
    <div data-testid={`provider-quote-${state}`} className={compact ? 'text-xs text-slate-300' : 'rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs text-slate-300'}>
      <p className="flex items-center gap-1.5">
        {state === 'available' ? <CheckCircle2 size={12} /> : state === 'loading' ? <Clock3 size={12} /> : <AlertCircle size={12} />}
        {message}
      </p>
      {onRefresh && !busy && <Button type="button" size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={onRefresh} aria-label="Recalculer le devis">Recalculer</Button>}
    </div>
  );
}
