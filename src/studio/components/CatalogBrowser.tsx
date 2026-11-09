import { useMemo, useState } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, Coins, Database, ImagePlus, Info,
  Lock, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Upload, X,
} from 'lucide-react';
import { Badge, Button, cn } from '../../components/ui';
import type { MuApiModel, VideoCatalogDiagnostics, VideoCostEstimate } from '../../lib/types';
import {
  MODE_LABELS, modelFamily, modelModes, providerCostLabel, reeloraModelStatus,
  statusLabel, type ParamValue,
} from '../model';
import { DynamicParams } from './DynamicParams';

type CategoryId = 'all' | 't2v' | 'i2v' | 'a2v' | 'v2v' | 'effects' | 'tools' | 'other';
type StatusFilter = 'all' | 'active' | 'unavailable' | 'account' | 'public_only';

const CATEGORIES: { id: CategoryId; label: string; match: (m: MuApiModel) => boolean }[] = [
  { id: 'all', label: 'Tous', match: () => true },
  { id: 't2v', label: 'Texte → Vidéo', match: (m) => m.category === 'Text to Video' },
  { id: 'i2v', label: 'Image → Vidéo', match: (m) => m.category === 'Image to Video' },
  { id: 'a2v', label: 'Audio / Avatar', match: (m) => m.category === 'Audio to Video' || m.group_of === 'avatar' || m.group_of === 'lipsync' },
  { id: 'v2v', label: 'Vidéo → Vidéo', match: (m) => m.category === 'Video to Video' },
  { id: 'effects', label: 'Effets', match: (m) => m.group_of === 'ai-effects' },
  { id: 'tools', label: 'Outils / édition', match: (m) => m.group_of === 'video-tools' || m.group_of === 'video-edit' },
  { id: 'other', label: 'Autres familles', match: (m) => !['Text to Video', 'Image to Video', 'Audio to Video', 'Video to Video'].includes(m.category) && m.group_of !== 'ai-effects' && m.group_of !== 'avatar' && m.group_of !== 'lipsync' && m.group_of !== 'video-tools' && m.group_of !== 'video-edit' },
];

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'Tous les statuts' },
  { id: 'active', label: 'Actifs Reelora' },
  { id: 'unavailable', label: 'Indisponibles' },
  { id: 'account', label: 'Retourné avec la clé' },
  { id: 'public_only', label: 'Absent du catalogue clé' },
];

function modelStatus(m: MuApiModel) {
  return m.reelora_status ? { status: m.reelora_status, reason: m.reelora_reason ?? '' } : reeloraModelStatus(m);
}

function accessLabel(access: MuApiModel['account_access']): string {
  if (access === 'account') return 'Retourné avec la clé';
  if (access === 'public_only') return 'Absent du catalogue clé';
  return 'Compte non vérifié';
}

export function CatalogBrowser({ models, catalog, selectedId, onSelect, onClose, onRefresh, detailLoading, model, params, onParamsChange, onClearSelection, estimate, balance, referenceFile, lastReferenceFile, onReferenceChange, onLastReferenceChange }: {
  models: MuApiModel[];
  catalog: VideoCatalogDiagnostics | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onRefresh?: () => void;
  detailLoading: boolean;
  model: MuApiModel | null;
  params: Record<string, ParamValue>;
  onParamsChange: (values: Record<string, ParamValue>) => void;
  onClearSelection: () => void;
  estimate: VideoCostEstimate | null;
  balance: number;
  referenceFile: File | null;
  lastReferenceFile: File | null;
  onReferenceChange: (file: File | null) => void;
  onLastReferenceChange: (file: File | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryId>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [visible, setVisible] = useState(36);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cat = CATEGORIES.find((c) => c.id === category)?.match ?? (() => true);
    return models.filter((m) => {
      const s = modelStatus(m);
      if (!cat(m)) return false;
      if (status === 'active' && s.status !== 'active') return false;
      if (status === 'unavailable' && s.status === 'active') return false;
      if (status === 'account' && m.account_access !== 'account') return false;
      if (status === 'public_only' && m.account_access !== 'public_only') return false;
      if (!q) return true;
      return [m.model_id, m.display_name, m.description, m.family, m.group_of, m.category]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    });
  }, [models, query, category, status]);

  const shown = filtered.slice(0, visible);
  const selected = model ?? models.find((m) => m.model_id === selectedId) ?? null;
  const selectedStatus = selected ? modelStatus(selected) : null;
  const reasons = catalog?.reasons ?? {};

  return (
    <section id="catalog-muapi" data-testid="catalog-muapi" className="studio-v2 mt-5 rounded-[24px] border border-cyan-400/15 bg-[#05090e] p-3 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-cyan-300">Catalogue MuAPI · mode avancé</p>
          <h2 className="mt-1 text-lg font-bold text-white sm:text-xl">Tous les modèles vidéo détectés</h2>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-slate-500">
            Catalogue public MuAPI et catalogue retourné avec la clé du compte sont distincts. Les entrées dont le moteur n’est pas connecté restent visibles mais ne sont pas sélectionnables. MuAPI ne publie pas de droits d’exécution par modèle dans <code>/models</code> : « Retourné avec la clé » n’est pas une garantie de génération.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onRefresh && <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={onRefresh}>Actualiser</Button>}
          <Button size="sm" variant="outline" icon={<X size={13} />} onClick={onClose}>Fermer</Button>
        </div>
      </div>

      {catalog && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {[
            ['Détectés vidéo', catalog.detected_video, 'text-white'],
            ['Actifs Reelora', catalog.active, 'text-emerald-300'],
            ['Indisponibles', catalog.unavailable, 'text-amber-300'],
            ['Retournés avec la clé', catalog.account_accessible, 'text-cyan-300'],
            ['Absents du catalogue clé', catalog.public_only, 'text-slate-300'],
          ].map(([label, value, tone]) => (
            <div key={String(label)} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
              <p className="text-[10px] text-slate-500">{label}</p>
              <p className={cn('mt-1 text-lg font-bold', String(tone))}>{value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5 text-[10px] text-slate-400">
        <Database size={12} className="text-cyan-300" />
        <span>Public MuAPI : <b className="text-white">{catalog?.public_total ?? '—'}</b></span>
        <span>Catalogue authentifié : <b className="text-white">{catalog?.authenticated_total ?? '—'}</b></span>
        <span>Source : <b className="text-white">{catalog?.source ?? '—'}</b></span>
        <span className="inline-flex items-center gap-1"><ShieldCheck size={11} className={catalog?.account.key_valid ? 'text-emerald-300' : 'text-amber-300'} />
          Clé compte {catalog?.account.key_valid ? 'validée' : 'non validée'}{catalog?.account.key_is_test ? ' · sandbox' : ''}
        </span>
        {catalog?.endpoints?.length ? <span className="w-full truncate text-slate-600" title={catalog.endpoints.join(' · ')}>Endpoints : {catalog.endpoints.join(' · ')}</span> : null}
        <span className="w-full text-slate-600">Sonde lecture seule : aucun POST de génération, aucun débit, aucun secret ni solde renvoyé au navigateur.</span>
        {catalog?.error && <span className="inline-flex w-full items-center gap-1 text-rose-300"><AlertCircle size={11} /> {catalog.error}</span>}
        {Object.keys(reasons).length > 0 && (
          <span className="w-full text-slate-600">Raisons : {Object.entries(reasons).map(([k, v]) => `${k} (${v})`).join(' · ')}</span>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label htmlFor="catalog-search" className="relative block min-w-0 flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input id="catalog-search" value={query} onChange={(e) => { setQuery(e.target.value); setVisible(36); }}
                placeholder="Rechercher un modèle par nom, famille ou identifiant…"
                className="studio-input pl-9" />
            </label>
            <select aria-label="Filtrer par statut" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="studio-select sm:w-48">
              {STATUS_FILTERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>

          <div className="no-scrollbar mt-3 flex gap-1.5 overflow-x-auto pb-1">
            {CATEGORIES.map((c) => {
              const count = models.filter(c.match).length;
              return (
                <button key={c.id} type="button" onClick={() => { setCategory(c.id); setVisible(36); }}
                  className={cn('studio-chip shrink-0', category === c.id && 'border-cyan-400/45 bg-cyan-400/10 text-cyan-100')}
                  aria-pressed={category === c.id}>
                  {c.label} <span className="text-[9px] opacity-70">{count}</span>
                </button>
              );
            })}
          </div>

          <p className="mt-3 text-[11px] text-slate-500">{filtered.length} résultat{filtered.length > 1 ? 's' : ''} · {shown.length} affiché{shown.length > 1 ? 's' : ''}</p>

          <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((m) => {
              const s = modelStatus(m);
              const active = selectedId === m.model_id;
              const selectable = s.status === 'active';
              return (
                <button key={m.model_id} id={`model-card-${m.model_id}`} data-testid="catalog-model-card" type="button"
                  disabled={!selectable} onClick={() => selectable && onSelect(m.model_id)}
                  title={s.reason}
                  className={cn('relative min-w-0 rounded-2xl border p-3 text-left transition',
                    active ? 'border-cyan-400/50 bg-cyan-400/[0.09] shadow-[0_0_0_1px_rgba(34,211,238,0.12)]'
                      : 'border-white/[0.07] bg-[#080d14] hover:border-cyan-400/25',
                    !selectable && 'cursor-not-allowed opacity-60')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-semibold text-white">{m.display_name}</p>
                      <p className="mt-0.5 truncate text-[10px] text-cyan-200/80">{modelFamily(m)} · {MODE_LABELS[modelModes(m)[0]]}</p>
                    </div>
                    {active ? <CheckCircle2 size={16} className="shrink-0 text-cyan-300" />
                      : selectable ? <Badge tone="success">Actif</Badge>
                        : <Badge tone="warning">{statusLabel(s.status)}</Badge>}
                  </div>
                  <p className="mt-2 line-clamp-2 text-[10px] leading-relaxed text-slate-500">{m.description || 'Modèle déclaré par MuAPI.'}</p>
                  <div className="mt-2 flex flex-wrap gap-1 text-[9px]">
                    <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-slate-400">{m.category}</span>
                    {m.group_of && <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-slate-500">{m.group_of}</span>}
                    <span className={cn('rounded-md px-1.5 py-0.5', m.account_access === 'account' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-200')}>{accessLabel(m.account_access)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-1 border-t border-white/[0.06] pt-2 text-[10px]">
                    <span className="text-slate-500">Fournisseur <b className="text-cyan-300">{providerCostLabel(m.cost_usd, m.cost_currency)}</b></span>
                    <span className="font-mono text-[9px] text-slate-600">{m.model_id}</span>
                  </div>
                  {!selectable && <p className="mt-1.5 flex items-start gap-1 text-[9px] leading-snug text-amber-200/80"><Lock size={9} className="mt-0.5 shrink-0" /> {s.reason}</p>}
                </button>
              );
            })}
          </div>

          {filtered.length > shown.length && (
            <button type="button" onClick={() => setVisible((v) => v + 36)} className="studio-chip mt-3 w-full justify-center">
              <ChevronDown size={12} /> Afficher {Math.min(36, filtered.length - shown.length)} modèles supplémentaires
            </button>
          )}
          {filtered.length === 0 && <p className="mt-6 text-center text-xs text-slate-500">Aucun modèle réel ne correspond à cette recherche.</p>}
        </div>

        <aside className="space-y-3" id="modele-selectionne">
          <div className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-300">Modèle sélectionné</p>
                <h3 className="mt-1 text-sm font-bold text-white">{selected?.display_name ?? 'Aucun modèle'}</h3>
                <p className="mt-0.5 font-mono text-[10px] text-slate-600">{selected?.model_id ?? '—'}</p>
              </div>
              {selected && <Button size="sm" variant="ghost" onClick={onClearSelection}>Mode simplifié</Button>}
            </div>
            {selectedStatus && (
              <div className={cn('mt-3 rounded-xl border px-3 py-2 text-[11px] leading-relaxed',
                selectedStatus.status === 'active' ? 'border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-200' : 'border-amber-400/20 bg-amber-400/[0.05] text-amber-200')}>
                {selectedStatus.status === 'active' ? <CheckCircle2 size={12} className="mr-1 inline" /> : <AlertCircle size={12} className="mr-1 inline" />}
                {statusLabel(selectedStatus.status)} · {selectedStatus.reason}
              </div>
            )}
            {detailLoading && <p className="mt-2 text-[11px] text-cyan-200">Récupération du schéma MuAPI…</p>}
            {selected && (
              <dl className="mt-3 space-y-1.5 text-[10px]">
                {[
                  ['Famille', selected.family || selected.category],
                  ['Groupe', selected.group_of || '—'],
                  ['POST', selected.endpoint],
                  ['Devis', selected.estimate_endpoint || 'tarif catalogue fixe'],
                  ['Tarification', selected.dynamic_pricing ? 'dynamique / estimate-cost' : 'fixe catalogue'],
                  ['Accès compte', accessLabel(selected.account_access)],
                  ['Source', selected.source || 'MuAPI'],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 border-b border-white/[0.04] pb-1">
                    <dt className="shrink-0 text-slate-600">{k}</dt><dd className="truncate text-right text-slate-300" title={String(v)}>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {estimate && selectedId && (
              <div className="mt-3 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] p-3 text-[11px] text-cyan-100">
                <p className="flex items-center gap-1.5 font-semibold"><Coins size={12} /> Devis serveur : {estimate.credits_cost} crédits Reelora</p>
                <p className="mt-1 text-slate-400">Fournisseur : {providerCostLabel(estimate.provider_cost_usd, estimate.provider_cost_currency)} · {estimate.provider_quote_source === 'estimate_cost' ? 'devis exact MuAPI' : 'tarif catalogue'}</p>
                <p className="mt-1 text-slate-500">Solde {balance} · après réservation {Math.max(0, balance - estimate.credits_cost)}</p>
                {estimate.provider_quote_error && <p className="mt-1 text-amber-200">{estimate.provider_quote_error}</p>}
              </div>
            )}
          </div>

          {selected ? (
            <div id="dynamic-params" data-testid="dynamic-params">
              <DynamicParams model={selected} values={params} onChange={onParamsChange} />
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-[11px] leading-relaxed text-slate-500">
              <SlidersHorizontal size={16} className="mx-auto mb-2 text-slate-600" />
              Sélectionnez un modèle actif pour afficher ses paramètres réels et obtenir un devis backend.
            </div>
          )}

          {selected && (selected.input_fields.includes('image_url') || selected.input_fields.includes('last_image')) && (
            <div className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4" data-testid="catalog-references">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white"><ImagePlus size={13} /> Références réelles du modèle</p>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-500">Importées dans le bucket privé <code>ugc-assets</code>, signées côté serveur pour le devis exact et la génération.</p>
              <div className="mt-3 space-y-2">
                {selected.input_fields.includes('image_url') && (
                  <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-slate-300">Image initiale{selected.required_fields.includes('image_url') ? ' *' : ''}</span>
                      {referenceFile && <button type="button" onClick={() => onReferenceChange(null)} className="inline-flex items-center gap-1 text-[9px] text-slate-500 hover:text-rose-300"><X size={9} /> Retirer</button>}
                    </div>
                    <label htmlFor="catalog-first-image" className="mt-1.5 flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-white/15 px-2 py-2 text-[10px] text-slate-400 hover:border-cyan-400/40 hover:text-cyan-200">
                      <Upload size={12} /> <span className="truncate">{referenceFile?.name ?? 'Choisir une image PNG, JPEG ou WebP'}</span>
                      <input id="catalog-first-image" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only"
                        onChange={(e) => onReferenceChange(e.target.files?.[0] ?? null)} />
                    </label>
                  </div>
                )}
                {selected.input_fields.includes('last_image') && (
                  <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-slate-300">Image finale (optionnelle)</span>
                      {lastReferenceFile && <button type="button" onClick={() => onLastReferenceChange(null)} className="inline-flex items-center gap-1 text-[9px] text-slate-500 hover:text-rose-300"><X size={9} /> Retirer</button>}
                    </div>
                    <label htmlFor="catalog-last-image" className="mt-1.5 flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-white/15 px-2 py-2 text-[10px] text-slate-400 hover:border-cyan-400/40 hover:text-cyan-200">
                      <Upload size={12} /> <span className="truncate">{lastReferenceFile?.name ?? 'Choisir une image finale'}</span>
                      <input id="catalog-last-image" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only"
                        onChange={(e) => onLastReferenceChange(e.target.files?.[0] ?? null)} />
                    </label>
                  </div>
                )}
              </div>
            </div>
          )}

          <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-600">
            <Info size={11} className="mt-0.5 shrink-0" /> Aucun modèle n’est inventé : noms, coûts, endpoints, statuts et schémas proviennent des réponses MuAPI lues côté serveur. La clé n’est jamais envoyée au navigateur.
          </p>
        </aside>
      </div>
    </section>
  );
}
