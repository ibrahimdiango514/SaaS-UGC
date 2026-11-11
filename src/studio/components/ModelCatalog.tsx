import { Check, Clock3, Database, RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge, Button, cn } from '../../components/ui';
import { formatDate } from '../../lib/format';
import type { MuApiModel, VideoCostEstimate } from '../../lib/types';
import {
  MODE_LABELS, isModelAvailable, modelDurations, modelModes,
  modelRatios, modelResolutions,
} from '../model';

function Meta({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-slate-600">{label}</p>
      <p className="mt-0.5 truncate text-[11px] text-slate-300" title={values.join(' · ')}>{values.join(' · ')}</p>
    </div>
  );
}

export function ModelCatalog({ models, selectedId, onSelect, busy, onRefresh, estimate, healthMuapi }: {
  models: MuApiModel[];
  selectedId: string;
  onSelect: (modelId: string) => void;
  busy?: boolean;
  onRefresh: () => void;
  estimate?: VideoCostEstimate | null;
  healthMuapi?: boolean | null;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-panel/60 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-500/15 text-brand-200"><Database size={15} /></span>
          <div>
            <h3 className="text-sm font-semibold text-white">Modèles vidéo VYORA</h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
              Explorez les modèles disponibles et leurs capacités réelles.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" icon={<RefreshCw size={13} className={busy ? 'animate-spin' : ''} />} onClick={onRefresh} disabled={busy}>Actualiser</Button>
      </div>

      {healthMuapi === false && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-200">
          <ShieldCheck size={14} className="mt-0.5 shrink-0" />
          <span>Le service vidéo est momentanément indisponible. Aucune génération ne sera lancée tant qu’il ne sera pas rétabli.</span>
        </div>
      )}

      {models.length === 0 ? (
        <p className="rounded-xl border border-dashed border-white/10 px-3 py-6 text-center text-xs text-slate-500">Aucun modèle actif n’est disponible actuellement. Réessayez après synchronisation.</p>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {models.map((model, index) => {
            const active = selectedId === model.model_id;
            const available = isModelAvailable(model);
            return (
              <button key={model.model_id} type="button" onClick={() => available && onSelect(model.model_id)} disabled={!available}
                className={cn('relative overflow-hidden rounded-xl border p-3.5 text-left transition-all duration-200',
                  active ? 'border-brand-400/50 bg-brand-500/[0.10] shadow-[0_0_0_1px_rgba(114,85,245,0.14)]' : 'border-white/[0.07] bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]',
                  !available && 'cursor-not-allowed opacity-50')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-white">Modèle vidéo {index + 1}</p>
                    <p className="mt-0.5 text-[10px] text-brand-200/80">{MODE_LABELS[modelModes(model)[0]] ?? 'Création vidéo'}</p>
                  </div>
                  {active ? <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-500 text-white"><Check size={12} /></span>
                    : !available ? <Badge tone="warning"><Clock3 size={10} className="mr-1 inline" /> Indisponible</Badge> : <Badge tone="success">Disponible</Badge>}
                </div>
                <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-slate-400">Génération vidéo · capacités et paramètres compatibles affichés ci-dessous.</p>
                <div className="mt-3 grid grid-cols-2 gap-2 border-t border-white/[0.06] pt-2.5">
                  <Meta label="Modes" values={modelModes(model).map((m) => MODE_LABELS[m])} />
                  <Meta label="Formats" values={modelRatios(model)} />
                  <Meta label="Résolutions" values={modelResolutions(model)} />
                  <Meta label="Durées" values={modelDurations(model)} />
                </div>
                {model.synced_at && <p className="mt-1.5 text-[10px] text-slate-600">Synchronisé le {formatDate(model.synced_at, true)}</p>}
              </button>
            );
          })}
        </div>
      )}

      {estimate && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.05] px-3 py-2.5 text-[11px] text-emerald-200">
          <ShieldCheck size={13} /> Estimation serveur vérifiée : <span className="font-semibold">{estimate.credits_cost} crédits Studio</span>
          <span className="text-slate-400">· modèle {estimate.model_available ? 'disponible' : 'indisponible'}</span>
        </div>
      )}
    </div>
  );
}
