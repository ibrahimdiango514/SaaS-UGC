import { useEffect, useState } from 'react';
import { Coins, Info, LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button, Modal, cn } from '../../components/ui';
import type { MuApiModel, ProviderQuote, VideoCostEstimate } from '../../lib/types';
import { paramsSummary, type ParamValue } from '../model';
import { canConfirmGeneration, creditSummary } from '../catalog';
import { ProviderQuotePanel } from './ProviderQuotePanel';

export function CostSummary({ model, estimate, balance, params, compact }: {
  model: MuApiModel;
  estimate: VideoCostEstimate | null;
  balance: number;
  params: Record<string, ParamValue>;
  compact?: boolean;
}) {
  const summary = creditSummary(estimate, balance, Boolean(model.dynamic_pricing));
  const cost = summary.creditsCost;
  const costLabel = cost !== null ? `${cost} crédits` : 'devis en cours';
  const remaining = summary.remaining === null ? '—' : `${summary.remaining} crédits`;

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="rounded-lg bg-white/[0.05] px-2 py-1 text-slate-300">{costLabel}</span>
        <span className="text-slate-500">Solde {balance} · après réservation {remaining}</span>
        {summary.quoteToConfirm && <span className="font-semibold text-amber-200">Estimation en cours de vérification</span>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">Modèle sélectionné</p>
        <p className="mt-1 text-sm font-semibold text-white">Modèle vidéo VYORA</p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{paramsSummary(params)}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Coût Studio UGC', costLabel, 'text-amber-300'],
          ['Solde actuel', `${balance} crédits`, 'text-white'],
          ['Après réservation', remaining, summary.enough ? 'text-emerald-300' : 'text-rose-300'],
        ].map(([label, value, tone]) => (
          <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
            <p className="text-[10px] text-slate-500">{label}</p>
            <p className={cn('mt-1 text-sm font-bold', String(tone))}>{value}</p>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-[10px] leading-relaxed text-slate-400">
        {summary.quoteToConfirm && (
          <p data-testid="quote-to-confirm" className="flex items-start gap-1.5 font-semibold text-amber-200"><TriangleAlert size={13} className="mt-0.5 shrink-0" /> Estimation indisponible : la réservation reste bloquée jusqu’à confirmation du coût en crédits.</p>
        )}
      </div>
      <div className="rounded-xl border border-brand-400/20 bg-brand-500/[0.06] p-3 text-[11px] leading-relaxed text-slate-300">
        <p className="flex items-center gap-1.5 font-semibold text-brand-100"><ShieldCheck size={13} /> Débit sécurisé</p>
        <p className="mt-1.5">Les crédits sont réservés avant la génération puis débités uniquement après réussite. En cas d’échec, d’expiration ou d’annulation, ils sont restitués. La demande est protégée contre les doubles débits.</p>
        <p className="mt-1.5 flex items-center gap-1.5"><Coins size={12} /> Le solde Studio UGC reste indépendant du quota Business.</p>
      </div>
    </div>
  );
}

export function CostConfirm({ open, onClose, onConfirm, model, estimate, balance, params, loading, blockedReason,
  providerQuote = null, providerQuoteBusy = false, onRefreshProviderQuote,
}: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  model: MuApiModel; estimate: VideoCostEstimate | null; balance: number;
  params: Record<string, ParamValue>; loading?: boolean; blockedReason?: string;
  providerQuote?: ProviderQuote | null; providerQuoteBusy?: boolean; onRefreshProviderQuote?: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  useEffect(() => { if (!open) setAccepted(false); }, [open]);
  const summary = creditSummary(estimate, balance, Boolean(model.dynamic_pricing));
  const canConfirm = canConfirmGeneration({
    estimate, balance, accepted, loading, blockedReason,
    requiresExactQuote: Boolean(model.dynamic_pricing),
  });
  const cost = summary.creditsCost;
  const costLabel = cost !== null ? `${cost} crédits` : 'devis en cours';

  return (
    <Modal open={open} onClose={onClose} title="Confirmer la génération vidéo" size="lg"
      description="Vérifiez les paramètres acceptés et le coût en crédits avant la réservation."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Annuler</Button>
        <Button icon={<LockKeyhole size={14} />} loading={loading} disabled={!canConfirm} onClick={onConfirm}>
          Je confirme · réserver {costLabel}
        </Button>
      </>}>
      <div className="mb-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Devis fournisseur réel (MyAPI)</p>
        <ProviderQuotePanel quote={providerQuote} busy={providerQuoteBusy} onRefresh={onRefreshProviderQuote} />
      </div>
      <CostSummary model={model} estimate={estimate} balance={balance} params={params} />
      {blockedReason && <p className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2.5 text-xs text-rose-200">{blockedReason}</p>}
      {!summary.enough && cost !== null && <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-200"><Info size={13} /> Crédits insuffisants : rechargez depuis l’abonnement avant de lancer.</p>}
      <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-xs leading-relaxed text-slate-300">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-brand-500" />
        <span>J’ai vérifié les paramètres et le coût en crédits. J’accepte la réservation de {costLabel}, débitée uniquement après la réussite de la génération.</span>
      </label>
      <p className="mt-3 text-[10px] leading-relaxed text-slate-600">Aucun résultat fictif n’est affiché. Si la génération échoue, les crédits réservés sont restitués.</p>
    </Modal>
  );
}
