import { useMemo, useState } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, Coins, Database, ImagePlus, Info,
  Lock, RefreshCw, RotateCcw, Search, SlidersHorizontal, Upload, X,
} from 'lucide-react';
import { Badge, Button, cn } from '../../components/ui';
import type { MuApiModel, VideoCatalogDiagnostics, VideoCostEstimate } from '../../lib/types';
import {
  MODE_LABELS, modelDurations, modelModes, modelRatios, type ParamValue,
} from '../model';
import {
  CATALOG_CAPABILITIES, CATALOG_CATEGORIES, CATALOG_SORTS,
  CATALOG_STATUSES, DEFAULT_CATALOG_FILTERS, catalogModelStatus,
  creditSummary, filterModels, modelCapabilities, type CatalogFilters,
} from '../catalog';
import { DynamicParams } from './DynamicParams';

function FilterSelect({ id, label, value, options, onChange }: {
  id: string;
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label htmlFor={id} className="min-w-0 flex-1 sm:max-w-[190px]">
      <span className="sr-only">{label}</span>
      <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="studio-select w-full">
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function CatalogBrowser({ models, catalog, selectedId, onSelect, onClose, onRefresh, detailLoading, model, params, onParamsChange, onClearSelection, estimate, balance, referenceFile, lastReferenceFile, onReferenceChange, onLastReferenceChange, loading, catalogError, estimateError, quoteBusy, providerUnavailable }: {
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
  loading?: boolean;
  catalogError?: string;
  estimateError?: string;
  quoteBusy?: boolean;
  providerUnavailable?: boolean;
}) {
  const [filters, setFilters] = useState<CatalogFilters>(DEFAULT_CATALOG_FILTERS);
  const [visible, setVisible] = useState(36);
  const result = useMemo(() => filterModels(models, filters), [models, filters]);
  const shown = result.items.slice(0, visible);
  const selected = model ?? models.find((m) => m.model_id === selectedId) ?? null;
  const selectedStatus = selected ? catalogModelStatus(selected) : null;
  const selectedCapabilities = selected ? modelCapabilities(selected) : null;
  const summary = creditSummary(estimate, balance, Boolean(selected?.dynamic_pricing));
  const patchFilters = (p: Partial<CatalogFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setVisible(36);
  };

  return (
    <section id="catalog-muapi" data-testid="catalog-muapi" className="studio-v2 mt-5 rounded-[24px] border border-cyan-400/15 bg-[#05090e] p-3 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.2em] text-cyan-300">Création vidéo VYORA</p>
          <h2 className="mt-1 text-lg font-bold text-white sm:text-xl">Explorer les capacités vidéo</h2>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-slate-500">
            Parcourez les modes, formats, durées et résolutions disponibles. Les options non compatibles ne peuvent pas être sélectionnées.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onRefresh && <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={onRefresh} disabled={loading}>Actualiser</Button>}
          <Button size="sm" variant="outline" icon={<X size={13} />} onClick={onClose}>Fermer</Button>
        </div>
      </div>

      {(catalogError || providerUnavailable) && (
        <div data-testid="catalog-provider-error" className="mt-4 rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-rose-200">
          <p className="flex items-center gap-1.5 font-semibold"><AlertCircle size={13} /> Catalogue momentanément indisponible</p>
          <p className="mt-1 text-rose-100/80">Les options de génération seront rétablies dès que le service sera disponible. Aucune génération ne sera lancée entre-temps.</p>
        </div>
      )}

      {catalog && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            ['Modèles répertoriés', catalog.detected_video, 'text-white'],
            ['Disponibles dans VYORA', catalog.active, 'text-emerald-300'],
            ['Indisponibles', catalog.unavailable, 'text-amber-300'],
          ].map(([label, value, tone]) => (
            <div key={String(label)} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
              <p className="text-[10px] leading-tight text-slate-500">{label}</p>
              <p className={cn('mt-1 text-lg font-bold', String(tone))}>{value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label htmlFor="catalog-search" className="relative block min-w-0 flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input id="catalog-search" data-testid="catalog-search" aria-label="Capacité, format ou durée…"
                value={filters.query} onChange={(e) => patchFilters({ query: e.target.value })}
                placeholder="Capacité, format ou durée…"
                className="studio-input pl-9" />
            </label>
            <FilterSelect id="catalog-sort" label="Trier les modèles" value={filters.sort} options={CATALOG_SORTS} onChange={(v) => patchFilters({ sort: v as CatalogFilters['sort'] })} />
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <FilterSelect id="catalog-status" label="Filtrer par statut" value={filters.status} options={CATALOG_STATUSES} onChange={(v) => patchFilters({ status: v as CatalogFilters['status'] })} />
            <FilterSelect id="catalog-capability" label="Filtrer par capacité" value={filters.capability} options={CATALOG_CAPABILITIES} onChange={(v) => patchFilters({ capability: v as CatalogFilters['capability'] })} />
            <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} disabled={result.activeFilters === 0}
              onClick={() => { setFilters(DEFAULT_CATALOG_FILTERS); setVisible(36); }}>
              Réinitialiser{result.activeFilters ? ` (${result.activeFilters})` : ''}
            </Button>
          </div>

          <div className="no-scrollbar mt-3 flex gap-1.5 overflow-x-auto pb-1">
            {CATALOG_CATEGORIES.map((c) => (
              <button key={c.id} type="button" data-testid={`catalog-category-${c.id}`}
                onClick={() => patchFilters({ category: c.id })}
                className={cn('studio-chip shrink-0', filters.category === c.id && 'border-cyan-400/45 bg-cyan-400/10 text-cyan-100')}
                aria-pressed={filters.category === c.id}>
                {c.label} <span className="text-[9px] opacity-70">{result.counts[c.id] ?? 0}</span>
              </button>
            ))}
          </div>

          <p data-testid="catalog-results-count" className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span><b className="text-slate-300">{result.total}</b> résultat{result.total > 1 ? 's' : ''} · {shown.length} affiché{shown.length > 1 ? 's' : ''} sur {models.length} modèles disponibles</span>
            {filters.sort !== 'relevance' && <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[9px] text-cyan-200">{CATALOG_SORTS.find((s) => s.id === filters.sort)?.label}</span>}
            {quoteBusy && <span className="text-cyan-200">Calcul des crédits en cours…</span>}
          </p>

          {loading && (
            <div data-testid="catalog-loading" className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-live="polite">
              {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-36 animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.03]" />)}
              <p className="text-[11px] text-slate-500 sm:col-span-2 xl:col-span-3">Chargement des modèles vidéo…</p>
            </div>
          )}

          {!loading && models.length === 0 && (
            <div data-testid="catalog-empty" className="mt-5 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-6 text-center">
              <Database size={20} className="mx-auto mb-2 text-slate-600" />
              <p className="text-sm font-semibold text-white">Aucun modèle disponible</p>
              <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-slate-500">Aucun modèle vidéo n’est actuellement disponible. Réessayez ultérieurement.</p>
              {onRefresh && <Button size="sm" variant="outline" icon={<RefreshCw size={13} />} className="mt-3" onClick={onRefresh}>Réessayer</Button>}
            </div>
          )}

          {!loading && models.length > 0 && result.total === 0 && (
            <div data-testid="catalog-no-results" className="mt-5 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-6 text-center">
              <Search size={20} className="mx-auto mb-2 text-slate-600" />
              <p className="text-sm font-semibold text-white">Aucun modèle ne correspond aux filtres</p>
              <p className="mt-1 text-[11px] text-slate-500">Modifiez la recherche, la catégorie, la capacité ou le statut. Les {models.length} modèles du catalogue restent disponibles.</p>
              <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} className="mt-3" onClick={() => { setFilters(DEFAULT_CATALOG_FILTERS); setVisible(36); }}>Effacer les filtres</Button>
            </div>
          )}

          {!loading && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((m, index) => {
                const s = catalogModelStatus(m);
                const capabilities = modelCapabilities(m);
                const active = selectedId === m.model_id;
                const selectable = s.status === 'active';
                return (
                  <button key={m.model_id} id={`model-card-${m.model_id}`} data-testid="catalog-model-card" type="button"
                    disabled={!selectable} onClick={() => selectable && onSelect(m.model_id)}
                    className={cn('relative min-w-0 rounded-2xl border p-3 text-left transition',
                      active ? 'border-cyan-400/50 bg-cyan-400/[0.09] shadow-[0_0_0_1px_rgba(34,211,238,0.12)]'
                        : 'border-white/[0.07] bg-[#080d14] hover:border-cyan-400/25',
                      !selectable && 'cursor-not-allowed opacity-60')}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-semibold text-white">Modèle vidéo {index + 1}</p>
                        <p className="mt-0.5 truncate text-[10px] text-cyan-200/80">{MODE_LABELS[modelModes(m)[0]] ?? 'Vidéo'}</p>
                      </div>
                      {active ? <CheckCircle2 size={16} className="shrink-0 text-cyan-300" />
                        : selectable ? <Badge tone="success">Actif</Badge>
                          : <Badge tone="warning">Indisponible</Badge>}
                    </div>
                    <p className="mt-2 line-clamp-2 text-[10px] leading-relaxed text-slate-500">Options de création et paramètres pris en charge.</p>
                    <div className="mt-2 flex flex-wrap gap-1 text-[9px]">
                      <span className={cn('rounded-md px-1.5 py-0.5', selectable ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-200')}>{selectable ? 'Disponible' : 'Indisponible'}</span>
                      {capabilities.tags.slice(0, 3).map((tag) => <span key={tag} data-testid="catalog-card-tag" className="rounded-md bg-cyan-400/[0.07] px-1.5 py-0.5 text-cyan-200/80">{tag}</span>)}
                    </div>
                    {!selectable && <p className="mt-1.5 flex items-start gap-1 text-[9px] leading-snug text-amber-200/80"><Lock size={9} className="mt-0.5 shrink-0" /> Ce modèle n’est pas disponible pour le moment.</p>}
                  </button>
                );
              })}
            </div>
          )}

          {!loading && result.total > shown.length && (
            <button type="button" data-testid="catalog-show-more" onClick={() => setVisible((v) => v + 36)} className="studio-chip mt-3 w-full justify-center">
              <ChevronDown size={12} /> Afficher {Math.min(36, result.total - shown.length)} modèles supplémentaires
            </button>
          )}
        </div>

        <aside className="space-y-3" id="modele-selectionne">
          <div className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-300">Modèle sélectionné</p>
                <h3 className="mt-1 truncate text-sm font-bold text-white">{selected ? `Modèle vidéo ${models.findIndex((item) => item.model_id === selected.model_id) + 1}` : 'Aucun modèle'}</h3>
              </div>
              {selected && <Button size="sm" variant="ghost" onClick={onClearSelection}>Mode simplifié</Button>}
            </div>
            {selectedStatus && (
              <div className={cn('mt-3 rounded-xl border px-3 py-2 text-[11px] leading-relaxed',
                selectedStatus.status === 'active' ? 'border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-200' : 'border-amber-400/20 bg-amber-400/[0.05] text-amber-200')}>
                {selectedStatus.status === 'active' ? <CheckCircle2 size={12} className="mr-1 inline" /> : <AlertCircle size={12} className="mr-1 inline" />}
                {selectedStatus.status === 'active' ? 'Disponible' : 'Indisponible pour le moment'}
              </div>
            )}
            {detailLoading && <p data-testid="catalog-detail-loading" className="mt-2 text-[11px] text-cyan-200">Chargement des paramètres disponibles…</p>}
            {selectedCapabilities && (
              <div className="mt-3" data-testid="catalog-capabilities">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Capacités disponibles</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {selectedCapabilities.tags.length
                    ? selectedCapabilities.tags.map((tag) => <span key={tag} className="rounded-md bg-cyan-400/[0.07] px-1.5 py-0.5 text-[9px] text-cyan-200">{tag}</span>)
                    : <span className="text-[10px] text-slate-500">Prompt uniquement.</span>}
                </div>
                <p className="mt-1.5 text-[9px] leading-relaxed text-slate-600">Formats, durées et résolutions proviennent des capacités vérifiées du modèle.</p>
              </div>
            )}
            {selected && (
              <dl className="mt-3 space-y-1.5 text-[10px]">
                {[
                  ['Mode', MODE_LABELS[modelModes(selected)[0]] ?? 'Vidéo'],
                  ['Formats', modelRatios(selected).join(' · ') || '—'],
                  ['Durées', modelDurations(selected).join(' · ') || '—'],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 border-b border-white/[0.04] pb-1">
                    <dt className="shrink-0 text-slate-600">{k}</dt><dd className="truncate text-right text-slate-300" title={String(v)}>{v}</dd>
                  </div>
                ))}
              </dl>
            )}

            {selectedId && (estimate || estimateError || quoteBusy) && (
              <div data-testid="catalog-quote" className={cn('mt-3 rounded-xl border p-3 text-[11px]',
                summary.quoteToConfirm || estimateError ? 'border-amber-400/25 bg-amber-400/[0.05] text-amber-100' : 'border-cyan-400/20 bg-cyan-400/[0.05] text-cyan-100')}>
                <p className="flex items-center gap-1.5 font-semibold"><Coins size={12} />
                  {quoteBusy ? 'Estimation des crédits en cours…' : estimate ? `Coût VYORA : ${estimate.credits_cost} crédits Studio` : 'Coût en crédits indisponible'}
                </p>
                {estimate && <p className="mt-1 text-slate-300">Solde {balance} · après réservation {summary.remaining ?? '—'}</p>}
                {estimateError && <p data-testid="catalog-quote-error" className="mt-1 text-amber-200">Impossible de confirmer le coût en crédits. Réessayez.</p>}
                {summary.quoteToConfirm && !quoteBusy && <p className="mt-1 font-semibold text-amber-200">Génération bloquée : le coût en crédits doit être confirmé.</p>}
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
              Sélectionnez un modèle disponible pour afficher ses paramètres et estimer le coût en crédits.
            </div>
          )}

          {selected && (selected.input_fields.includes('image_url') || selected.input_fields.includes('last_image')) && (
            <div className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4" data-testid="catalog-references">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white"><ImagePlus size={13} /> Images de référence</p>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-500">Votre image est stockée de manière privée et utilisée pour la génération.</p>
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
            <Info size={11} className="mt-0.5 shrink-0" /> Les modèles, paramètres et disponibilités sont vérifiés en temps réel. Seul le coût en crédits VYORA est présenté.
          </p>
        </aside>
      </div>
    </section>
  );
}
