import { useEffect, useState } from 'react';
import { Coins, Info, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Button, Modal } from '../../components/ui';
import type { MuApiModel, VideoCostEstimate } from '../../lib/types';
import { paramsSummary, providerCostLabel, type ParamValue } from '../model';

export function CostSummary({ model, estimate, balance, params, compact }: {
  model: MuApiModel;
  estimate: VideoCostEstimate | null;
  balance: number;
  params: Record<string, ParamValue>;
  compact?: boolean;
}) {
  const cost = estimate?.credits_cost ?? 0;
  const remaining = Math.max(0, balance - cost);
  const enough = cost > 0 && balance >= cost;

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="rounded-lg bg-white/[0.05] px-2 py-1 text-slate-300">{cost} crédits</span>
        <span className="text-slate-500">Solde {balance} · après réservation {remaining}</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">Modèle sélectionné</p>
        <p className="mt-1 text-sm font-semibold text-white">{model.display_name}</p>
        <p className="mt-0.5 font-mono text-[10px] text-slate-500">{model.model_id}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{paramsSummary(params)}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Coût Reelora', `${cost} crédits`, 'text-amber-300'],
          ['Solde actuel', `${balance} crédits`, 'text-white'],
          ['Après réservation', `${remaining} crédits`, enough ? 'text-emerald-300' : 'text-rose-300'],
          ['Coût fournisseur', providerCostLabel(estimate?.provider_cost_usd, estimate?.provider_cost_currency), 'text-cyan-300'],
        ].map(([label, value, tone]) => (
          <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
            <p className="text-[10px] text-slate-500">{label}</p>
            <p className={`mt-1 text-sm font-bold ${tone}`}>{value}</p>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-brand-400/20 bg-brand-500/[0.06] p-3 text-[11px] leading-relaxed text-slate-300">
        <p className="flex items-center gap-1.5 font-semibold text-brand-100"><ShieldCheck size={13} /> Réservation, idempotence et capture existantes</p>
        <p className="mt-1.5">Les crédits sont réservés avant l’envoi à MuAPI, puis capturés uniquement si une vidéo réelle est produite. Échec, expiration ou annulation : restitution automatique. Un identifiant d’idempotence unique empêche tout double débit ; la soumission est protégée par un claim atomique côté serveur.</p>
        <p className="mt-1.5 flex items-center gap-1.5"><Coins size={12} /> Les crédits achetés n’expirent pas. Aucun crédit gratuit mensuel n’est ajouté par ce parcours.</p>
      </div>
    </div>
  );
}

export function CostConfirm({ open, onClose, onConfirm, model, estimate, balance, params, loading, blockedReason }: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  model: MuApiModel; estimate: VideoCostEstimate | null; balance: number;
  params: Record<string, ParamValue>; loading?: boolean; blockedReason?: string;
}) {
  const [accepted, setAccepted] = useState(false);
  useEffect(() => { if (!open) setAccepted(false); }, [open]);
  const cost = estimate?.credits_cost ?? 0;
  const canConfirm = accepted && cost > 0 && balance >= cost && estimate?.service_active !== false && estimate?.model_available !== false && !blockedReason && !loading;

  return (
    <Modal open={open} onClose={onClose} title="Confirmer la génération vidéo" size="lg"
      description="Vérifiez le modèle, les paramètres réellement acceptés et le coût avant la réservation."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Annuler</Button>
        <Button icon={<LockKeyhole size={14} />} loading={loading} disabled={!canConfirm} onClick={onConfirm}>
          Je confirme · réserver {cost} crédits
        </Button>
      </>}>
      <CostSummary model={model} estimate={estimate} balance={balance} params={params} />
      {blockedReason && <p className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2.5 text-xs text-rose-200">{blockedReason}</p>}
      {balance < cost && <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-200"><Info size={13} /> Crédits insuffisants : rechargez depuis l’abonnement avant de lancer.</p>}
      <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-xs leading-relaxed text-slate-300">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-brand-500" />
        <span>J’ai vérifié le modèle, les paramètres et le coût. J’accepte la réservation de {cost} crédits et je comprends que le débit définitif n’intervient qu’après un résultat MuAPI réel.</span>
      </label>
      <p className="mt-3 text-[10px] leading-relaxed text-slate-600">Aucun résultat fictif : sans clé serveur MuAPI valide, la tâche échoue explicitement et les crédits réservés sont restitués.</p>
    </Modal>
  );
}
