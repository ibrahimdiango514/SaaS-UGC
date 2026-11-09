import { useMemo, useState } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, Coins, Database, ImagePlus, Info,
  Lock, RefreshCw, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Upload, X,
} from 'lucide-react';
import { Badge, Button, cn } from '../../components/ui';
import type { MuApiModel, VideoCatalogDiagnostics, VideoCostEstimate } from '../../lib/types';
import {
  MODE_LABELS, modelFamily, modelModes, providerCostLabel, providerQuoteCostLabel,
  providerQuoteOriginLabel, statusLabel, type ParamValue,
} from '../model';
import {
  CATALOG_CAPABILITIES, CATALOG_CATEGORIES, CATALOG_PRICING, CATALOG_SORTS,
  CATALOG_STATUSES, DEFAULT_CATALOG_FILTERS, USD_CREDIT_NOTE, catalogModelStatus,
  creditSummary, filterModels, modelCapabilities, type CatalogFilters,
} from '../catalog';
import { DynamicParams } from './DynamicParams';

function accessLabel(access: MuApiModel['account_access']): string {
  if (access === 'account') return 'Retourné avec la clé';
  if (access === 'public_only') return 'Absent du catalogue clé';
  return 'Compte non vérifié';
}

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
  const reasons = catalog?.reasons ?? {};

  return (
    <section id="catalog-muapi" data-testid="catalog-muapi" className="studio-v2 mt-5 rounded-[24px] border border-cyan-400/15 bg-[#05090e] p-3 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.2em] text-cyan-300">Catalogue MuAPI · mode avancé</p>
          <h2 className="mt-1 text-lg font-bold text-white sm:text-xl">Explorer les modèles vidéo réels</h2>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-slate-500">
            Catalogue public et catalogue retourné avec la clé du compte sont distincts. Les capacités affichées proviennent des champs et options déclarés ; une entrée non connectée reste visible mais jamais sélectionnable. « Retourné avec la clé » n’est pas une garantie de droits d’exécution.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onRefresh && <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={onRefresh} disabled={loading}>Actualiser</Button>}
          <Button size="sm" variant="outline" icon={<X size={13} />} onClick={onClose}>Fermer</Button>
        </div>
      </div>

      {(catalogError || providerUnavailable) && (
        <div data-testid="catalog-provider-error" className="mt-4 rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-rose-200">
          <p className="flex items-center gap-1.5 font-semibold"><AlertCircle size={13} /> Fournisseur ou catalogue partiellement indisponible</p>
          <p className="mt-1 text-rose-100/80">{catalogError || 'Clé / compte MuAPI non validée : les modèles restent consultables, mais aucune génération ne peut être confirmée.'} Aucun modèle ni tarif n’est inventé.</p>
        </div>
      )}

      {catalog && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {[
            ['Détectés vidéo', catalog.detected_video, 'text-white'],
            ['Actifs Reelora', catalog.active, 'text-emerald-300'],
            ['Indisponibles', catalog.unavailable, 'text-amber-300'],
            ['Retournés avec la clé', catalog.account_accessible, 'text-cyan-300'],
            ['Absents du catalogue clé', catalog.public_only, 'text-slate-300'],
          ].map(([label, value, tone]) => (
            <div key={String(label)} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
              <p className="text-[10px] leading-tight text-slate-500">{label}</p>
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
              <input id="catalog-search" data-testid="catalog-search" aria-label="Nom, famille, identifiant, capacité…"
                value={filters.query} onChange={(e) => patchFilters({ query: e.target.value })}
                placeholder="Nom, famille, identifiant, capacité…"
                className="studio-input pl-9" />
            </label>
            <FilterSelect id="catalog-sort" label="Trier les modèles" value={filters.sort} options={CATALOG_SORTS} onChange={(v) => patchFilters({ sort: v as CatalogFilters['sort'] })} />
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <FilterSelect id="catalog-status" label="Filtrer par statut" value={filters.status} options={CATALOG_STATUSES} onChange={(v) => patchFilters({ status: v as CatalogFilters['status'] })} />
            <FilterSelect id="catalog-capability" label="Filtrer par capacité" value={filters.capability} options={CATALOG_CAPABILITIES} onChange={(v) => patchFilters({ capability: v as CatalogFilters['capability'] })} />
            <FilterSelect id="catalog-pricing" label="Filtrer par tarification" value={filters.pricing} options={CATALOG_PRICING} onChange={(v) => patchFilters({ pricing: v as CatalogFilters['pricing'] })} />
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
            <span><b className="text-slate-300">{result.total}</b> résultat{result.total > 1 ? 's' : ''} · {shown.length} affiché{shown.length > 1 ? 's' : ''} sur {models.length} modèles réels</span>
            {filters.sort !== 'relevance' && <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[9px] text-cyan-200">{CATALOG_SORTS.find((s) => s.id === filters.sort)?.label}</span>}
            {quoteBusy && <span className="text-cyan-200">Devis serveur en cours…</span>}
          </p>

          {loading && (
            <div data-testid="catalog-loading" className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-live="polite">
              {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-36 animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.03]" />)}
              <p className="text-[11px] text-slate-500 sm:col-span-2 xl:col-span-3">Chargement du catalogue réel côté serveur…</p>
            </div>
          )}

          {!loading && models.length === 0 && (
            <div data-testid="catalog-empty" className="mt-5 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-6 text-center">
              <Database size={20} className="mx-auto mb-2 text-slate-600" />
              <p className="text-sm font-semibold text-white">Aucun modèle disponible</p>
              <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-slate-500">Le fournisseur n’a renvoyé aucun modèle. Aucune liste de secours ni aucun prix fictif n’est utilisé. Vérifiez le secret serveur puis actualisez.</p>
              {onRefresh && <Button size="sm" variant="outline" icon={<RefreshCw size={13} />} className="mt-3" onClick={onRefresh}>Réessayer</Button>}
            </div>
          )}

          {!loading && models.length > 0 && result.total === 0 && (
            <div data-testid="catalog-no-results" className="mt-5 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-6 text-center">
              <Search size={20} className="mx-auto mb-2 text-slate-600" />
              <p className="text-sm font-semibold text-white">Aucun modèle réel ne correspond aux filtres</p>
              <p className="mt-1 text-[11px] text-slate-500">Modifiez la recherche, la catégorie, la capacité ou le statut. Les {models.length} modèles du catalogue restent disponibles.</p>
              <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} className="mt-3" onClick={() => { setFilters(DEFAULT_CATALOG_FILTERS); setVisible(36); }}>Effacer les filtres</Button>
            </div>
          )}

          {!loading && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((m) => {
                const s = catalogModelStatus(m);
                const capabilities = modelCapabilities(m);
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
                      {capabilities.tags.slice(0, 3).map((tag) => <span key={tag} data-testid="catalog-card-tag" className="rounded-md bg-cyan-400/[0.07] px-1.5 py-0.5 text-cyan-200/80">{tag}</span>)}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-1 border-t border-white/[0.06] pt-2 text-[10px]">
                      <span className="text-slate-500">Fournisseur <b className="text-cyan-300">{providerCostLabel(m.cost_usd, m.cost_currency)}</b></span>
                      <span className="max-w-[45%] truncate font-mono text-[9px] text-slate-600" title={m.model_id}>{m.model_id}</span>
                    </div>
                    {!selectable && <p className="mt-1.5 flex items-start gap-1 text-[9px] leading-snug text-amber-200/80"><Lock size={9} className="mt-0.5 shrink-0" /> {s.reason}</p>}
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
                <h3 className="mt-1 truncate text-sm font-bold text-white">{selected?.display_name ?? 'Aucun modèle'}</h3>
                <p className="mt-0.5 truncate font-mono text-[10px] text-slate-600">{selected?.model_id ?? '—'}</p>
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
            {detailLoading && <p data-testid="catalog-detail-loading" className="mt-2 text-[11px] text-cyan-200">Récupération du schéma MuAPI…</p>}
            {selectedCapabilities && (
              <div className="mt-3" data-testid="catalog-capabilities">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Capacités déclarées</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {selectedCapabilities.tags.length
                    ? selectedCapabilities.tags.map((tag) => <span key={tag} className="rounded-md bg-cyan-400/[0.07] px-1.5 py-0.5 text-[9px] text-cyan-200">{tag}</span>)
                    : <span className="text-[10px] text-slate-500">Prompt uniquement.</span>}
                </div>
                <p className="mt-1.5 text-[9px] leading-relaxed text-slate-600">Formats, durées et résolutions exacts sont chargés depuis la fiche MuAPI du modèle sélectionné ; aucune valeur n’est supposée.</p>
              </div>
            )}
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

            {selectedId && (estimate || estimateError || quoteBusy) && (
              <div data-testid="catalog-quote" className={cn('mt-3 rounded-xl border p-3 text-[11px]',
                summary.quoteToConfirm || estimateError ? 'border-amber-400/25 bg-amber-400/[0.05] text-amber-100' : 'border-cyan-400/20 bg-cyan-400/[0.05] text-cyan-100')}>
                <p className="flex items-center gap-1.5 font-semibold"><Coins size={12} />
                  {quoteBusy ? 'Devis backend exact en cours…' : estimate ? `Devis serveur : ${estimate.credits_cost} crédits Reelora` : 'Devis serveur indisponible'}
                </p>
                {estimate && <p className="mt-1 text-slate-300">Fournisseur : <b>{providerQuoteCostLabel(estimate)}</b> · {providerQuoteOriginLabel(estimate)}</p>}
                {estimate && <p className="mt-1 text-slate-500">Solde {balance} · après réservation {summary.remaining ?? '—'} · {USD_CREDIT_NOTE}</p>}
                {estimateError && <p data-testid="catalog-quote-error" className="mt-1 text-amber-200">{estimateError}</p>}
                {summary.quoteToConfirm && !quoteBusy && <p className="mt-1 font-semibold text-amber-200">Génération bloquée : devis fournisseur à confirmer. Aucun prix de remplacement n’est affiché.</p>}
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
            <Info size={11} className="mt-0.5 shrink-0" /> Aucun modèle ni tarif n’est inventé : noms, coûts, endpoints, statuts et schémas proviennent des réponses MuAPI lues côté serveur. La clé n’est jamais envoyée au navigateur.
          </p>
        </aside>
      </div>
    </section>
  );
}
