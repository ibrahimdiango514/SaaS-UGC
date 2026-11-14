import { useCallback, useEffect, useState } from 'react';
import { Bot, Cpu, Gauge, History, Plus, Power } from 'lucide-react';
import { Banner, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Input, LoadingState } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import {
  adminAiCoreCalls,
  adminAiCoreProviderDisable,
  adminAiCoreProviderUpsert,
  adminAiCoreRegistry,
  adminAiCoreSettingsGet,
  adminAiCoreSettingsSet,
} from '../../lib/api';
import type { AiCoreAdminSettings, AiCoreCallEntry, AiCoreRegistrySnapshot } from '../../lib/types';

const formatUsd = (amount: number | null) => {
  if (amount === null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(amount);
};

const SPACE_LABELS: Record<string, string> = {
  business: 'Business Grow',
  studio: 'Studio UGC',
  system: 'Système',
};

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  success: 'success',
  error: 'danger',
  timeout: 'warning',
  blocked: 'warning',
};

/**
 * A7 — Contrôle IA (admin) : pilotage du VYORA AI CORE par le propriétaire.
 * Budgets, état du registre multi-fournisseurs et journal des appels IA.
 * Les lectures sont servies par les façades admin (ugc_is_admin côté serveur).
 */
export default function AiCoreControl() {
  const toast = useToast();
  const [registry, setRegistry] = useState<AiCoreRegistrySnapshot | null>(null);
  const [registryError, setRegistryError] = useState('');
  const [calls, setCalls] = useState<AiCoreCallEntry[] | null>(null);
  const [callsError, setCallsError] = useState('');
  const [settings, setSettings] = useState<AiCoreAdminSettings | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [monthlyDraft, setMonthlyDraft] = useState('');
  const [dailyDraft, setDailyDraft] = useState('');
  const [thresholdDraft, setThresholdDraft] = useState('80');
  const [busy, setBusy] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [providerDraft, setProviderDraft] = useState({
    provider_key: '',
    display_name: '',
    adapter_kind: 'openai' as 'openai' | 'gemini' | 'cloudflare' | 'none',
    base_url: '',
    api_key_env: '',
  });

  const load = useCallback(async () => {
    setRegistryError('');
    setCallsError('');
    setSettingsError('');
    const [regRes, callsRes, setRes] = await Promise.allSettled([
      adminAiCoreRegistry(),
      adminAiCoreCalls(50),
      adminAiCoreSettingsGet(),
    ]);
    if (regRes.status === 'fulfilled') { setRegistry(regRes.value); } else { setRegistryError(asAppError(regRes.reason).message); }
    if (callsRes.status === 'fulfilled') { setCalls(callsRes.value); } else { setCallsError(asAppError(callsRes.reason).message); }
    if (setRes.status === 'fulfilled') {
      setSettings(setRes.value);
      setMonthlyDraft(setRes.value.monthly_budget_usd === null ? '' : String(setRes.value.monthly_budget_usd));
      setDailyDraft(setRes.value.max_daily_cost_usd === null ? '' : String(setRes.value.max_daily_cost_usd));
      setThresholdDraft(String(setRes.value.alert_threshold_pct ?? 80));
    } else {
      setSettingsError(asAppError(setRes.reason).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const parseOptionalUsd = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
  };

  const saveSettings = async () => {
    const monthly = parseOptionalUsd(monthlyDraft);
    const daily = parseOptionalUsd(dailyDraft);
    const threshold = Number(thresholdDraft);
    if (Number.isNaN(monthly) || Number.isNaN(daily)) {
      toast.error('Budget invalide : montant positif ou vide.');
      return;
    }
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      toast.error('Seuil d’alerte invalide (0 à 100).');
      return;
    }
    setBusy(true);
    try {
      const saved = await adminAiCoreSettingsSet({
        monthly_budget_usd: monthly,
        alert_threshold_pct: threshold,
        max_daily_cost_usd: daily,
      });
      setSettings(saved);
      setMonthlyDraft(saved.monthly_budget_usd === null ? '' : String(saved.monthly_budget_usd));
      setDailyDraft(saved.max_daily_cost_usd === null ? '' : String(saved.max_daily_cost_usd));
      setThresholdDraft(String(saved.alert_threshold_pct ?? 80));
      toast.success('Réglages IA enregistrés.');
    } catch (err) {
      toast.error(asAppError(err).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Ajoute un fournisseur au registre : il naît désactivé et non vérifié, et
   * n'est servi qu'après une sonde réelle. On ne transmet QUE le descripteur
   * de protocole — jamais une clé, qui reste un secret Edge.
   */
  const submitProvider = async () => {
    const key = providerDraft.provider_key.trim().toLowerCase();
    const name = providerDraft.display_name.trim();
    const baseUrl = providerDraft.base_url.trim();
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(key)) {
      setProviderError('Identifiant invalide : minuscules, chiffres, « - » et « _ » (2 à 40 caractères).');
      return;
    }
    if (!name) { setProviderError('Le nom affiché est obligatoire.'); return; }
    if (!/^https:\/\//.test(baseUrl)) { setProviderError('L’URL de base doit commencer par https://.'); return; }
    setProviderBusy(true);
    setProviderError('');
    try {
      const created = await adminAiCoreProviderUpsert({
        provider_key: key,
        display_name: name,
        adapter_kind: providerDraft.adapter_kind,
        base_url: baseUrl,
        api_key_env: providerDraft.api_key_env.trim() || null,
      });
      toast.success(`${created.provider_key} enregistré (désactivé, non vérifié).`);
      setProviderOpen(false);
      setProviderDraft({ provider_key: '', display_name: '', adapter_kind: 'openai', base_url: '', api_key_env: '' });
      await load();
    } catch (err) {
      setProviderError(asAppError(err).message);
    } finally {
      setProviderBusy(false);
    }
  };

  const disableProvider = async (providerKey: string) => {
    setBusy(true);
    try {
      await adminAiCoreProviderDisable(providerKey);
      toast.success(`${providerKey} désactivé. Les règles de routage associées ne le proposent plus.`);
      await load();
    } catch (err) {
      toast.error(asAppError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const verifiedCount = registry ? registry.models.filter((model) => model.verified).length : 0;
  const spend = registry?.monthly_spend_usd ?? 0;
  const budgetMonthly = registry?.budget.monthly ?? null;
  const budgetPct = budgetMonthly && budgetMonthly > 0 ? Math.min(100, Math.round((spend / budgetMonthly) * 100)) : null;

  return (
    <div className="space-y-5">
      {/* Budgets IA */}
      <Card>
        <CardHeader
          title="Budgets IA (AI CORE)"
          description="Plafonds appliqués côté serveur au moteur IA central. Vide = sans plafond ; les valeurs sont en USD."
        />
        {settingsError && <div className="px-5 pb-3"><Banner tone="warning" title="Réglages IA indisponibles">{settingsError}</Banner></div>}
        <div className="grid gap-3 px-5 pb-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-line bg-white/[0.03] p-3">
            <p className="text-xs text-slate-500">Dépense IA du mois</p>
            <p className="mt-1 text-lg font-semibold text-white">{formatUsd(spend)}</p>
            {budgetPct !== null && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full ${budgetPct >= (registry?.budget.alert ?? 80) ? 'bg-amber-400' : 'bg-emerald-400'}`}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
            )}
            {budgetPct !== null && <p className="mt-1 text-[11px] text-slate-500">{budgetPct} % du budget mensuel</p>}
          </div>
          <label className="block">
            <span className="text-xs text-slate-500">Budget mensuel (USD)</span>
            <Input
              value={monthlyDraft}
              onChange={(e) => setMonthlyDraft(e.target.value)}
              placeholder="vide = sans plafond"
              className="mt-1"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Plafond journalier (USD)</span>
            <Input
              value={dailyDraft}
              onChange={(e) => setDailyDraft(e.target.value)}
              placeholder="vide = sans plafond"
              className="mt-1"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Seuil d’alerte (%)</span>
            <Input
              value={thresholdDraft}
              onChange={(e) => setThresholdDraft(e.target.value)}
              className="mt-1"
            />
          </label>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="text-[11px] text-slate-500">
            {settings?.updated_at ? `Dernier changement : ${formatDate(settings.updated_at)}` : 'Aucun changement enregistré.'}
          </p>
          <Button size="sm" loading={busy} onClick={() => { void saveSettings(); }}>Enregistrer</Button>
        </div>
      </Card>

      {/* Registre */}
      <Card>
        <CardHeader
          title="Registre multi-fournisseurs"
          description="Le registre est la source unique : il décrit le protocole de chaque fournisseur. Ajouter un fournisseur ne demande aucune modification de code."
          action={
            <Button
              size="sm"
              variant="outline"
              icon={<Plus size={14} />}
              onClick={() => { setProviderOpen((open) => !open); setProviderError(''); }}
              aria-expanded={providerOpen}
            >
              {providerOpen ? 'Fermer' : 'Ajouter un fournisseur'}
            </Button>
          }
        />
        {registryError ? (
          <div className="px-5 pb-5"><ErrorState message={registryError} onRetry={() => void load()} /></div>
        ) : !registry ? (
          <div className="px-5 pb-5"><LoadingState label="Chargement du registre…" /></div>
        ) : (
          <div className="space-y-4 px-5 pb-5">
            {providerOpen && (
              <section
                className="rounded-xl border border-line bg-white/[0.02] p-4"
                aria-label="Déclarer un fournisseur"
              >
                <p className="text-xs leading-relaxed text-slate-400">
                  Seul le <strong className="text-slate-200">descripteur</strong> est enregistré ici. La clé API reste un
                  secret Edge (Supabase Secrets) : indiquez uniquement le <em>nom</em> de la variable qui la porte.
                  Le fournisseur est créé désactivé et non vérifié — il ne sera servi qu’après une sonde réelle réussie.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-xs text-slate-500">Identifiant (minuscules)</span>
                    <Input
                      value={providerDraft.provider_key}
                      onChange={(e) => setProviderDraft((d) => ({ ...d, provider_key: e.target.value }))}
                      placeholder="ex. fournisseur-x"
                      className="mt-1"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-slate-500">Nom affiché</span>
                    <Input
                      value={providerDraft.display_name}
                      onChange={(e) => setProviderDraft((d) => ({ ...d, display_name: e.target.value }))}
                      placeholder="ex. Fournisseur X"
                      className="mt-1"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-slate-500">Gabarit de protocole</span>
                    <select
                      aria-label="Gabarit de protocole"
                      value={providerDraft.adapter_kind}
                      onChange={(e) => setProviderDraft((d) => ({ ...d, adapter_kind: e.target.value as typeof d.adapter_kind }))}
                      className="mt-1 w-full rounded-lg border border-line bg-[#0c111b] px-3 py-2 text-sm text-white"
                    >
                      <option value="openai">openai — /chat/completions</option>
                      <option value="gemini">gemini — protocole natif Google</option>
                      <option value="cloudflare">cloudflare — URL par compte</option>
                      <option value="none">none — protocole dédié, non appelé</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-slate-500">URL de base (https)</span>
                    <Input
                      value={providerDraft.base_url}
                      onChange={(e) => setProviderDraft((d) => ({ ...d, base_url: e.target.value }))}
                      placeholder="https://api.exemple.com/v1"
                      className="mt-1"
                    />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="text-xs text-slate-500">Variable du secret (nom uniquement)</span>
                    <Input
                      value={providerDraft.api_key_env}
                      onChange={(e) => setProviderDraft((d) => ({ ...d, api_key_env: e.target.value }))}
                      placeholder="ex. FOURNISSEUR_X_API_KEY"
                      className="mt-1"
                    />
                  </label>
                </div>
                {providerError && (
                  <p className="mt-3 rounded-lg border border-rose-400/30 bg-rose-400/[0.06] p-2.5 text-xs text-rose-200" role="alert">
                    {providerError}
                  </p>
                )}
                <div className="mt-3 flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setProviderOpen(false)}>Annuler</Button>
                  <Button size="sm" loading={providerBusy} onClick={() => { void submitProvider(); }}>Enregistrer le fournisseur</Button>
                </div>
              </section>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.03] p-3">
                <Bot size={18} className="text-brand-300" />
                <div>
                  <p className="text-lg font-semibold text-white">{registry.providers.length}</p>
                  <p className="text-[11px] text-slate-500">fournisseur(s) actif(s)</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.03] p-3">
                <Cpu size={18} className="text-cyan-300" />
                <div>
                  <p className="text-lg font-semibold text-white">{registry.models.length}</p>
                  <p className="text-[11px] text-slate-500">modèle(s) au catalogue</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.03] p-3">
                <Gauge size={18} className="text-emerald-300" />
                <div>
                  <p className="text-lg font-semibold text-white">{verifiedCount}</p>
                  <p className="text-[11px] text-slate-500">modèle(s) vérifié(s)</p>
                </div>
              </div>
            </div>
            {registry.providers.length === 0 ? (
              <EmptyState title="Aucun fournisseur actif" description="Le registre IA central ne contient aucun fournisseur actif." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Fournisseur</th><th>Statut</th><th>Protocole</th><th>Modèles (vérifiés)</th><th /></tr>
                  </thead>
                  <tbody>
                    {registry.providers.map((provider) => {
                      const providerModels = registry.models.filter((model) => model.provider === provider.key);
                      const providerVerified = providerModels.filter((model) => model.verified).length;
                      return (
                        <tr key={provider.key}>
                          <td>
                            <p className="font-medium text-white">{provider.name}</p>
                            <p className="text-[11px] text-slate-500">{provider.key}</p>
                          </td>
                          <td><Badge tone={provider.status === 'active' ? 'success' : 'neutral'}>{provider.status}</Badge></td>
                          <td>
                            <span className="text-xs text-slate-300">
                              {provider.adapter_kind ?? 'openai'}
                              {provider.aggregator ? ' · agrégateur' : ''}
                            </span>
                            <p className="max-w-[220px] truncate text-[11px] text-slate-500" title={provider.base_url ?? ''}>
                              {provider.base_url ?? 'URL non déclarée'}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              {provider.api_key_env ? `secret : ${provider.api_key_env}` : 'secret non déclaré'}
                            </p>
                          </td>
                          <td><span className="text-xs text-slate-300">{providerVerified} / {providerModels.length}</span></td>
                          <td className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<Power size={13} />}
                              disabled={busy}
                              onClick={() => { void disableProvider(provider.key); }}
                              aria-label={`Désactiver ${provider.name}`}
                            >
                              Désactiver
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Journal des appels */}
      <Card>
        <CardHeader title="Journal des appels IA" description="Dernières exécutions du moteur IA (tous espaces). Les identifiants clients ne sont pas journalisés ici." />
        {callsError ? (
          <div className="px-5 pb-5"><ErrorState message={callsError} onRetry={() => void load()} /></div>
        ) : calls === null ? (
          <div className="px-5 pb-5"><LoadingState label="Chargement du journal…" /></div>
        ) : calls.length === 0 ? (
          <div className="px-5 pb-5"><EmptyState icon={<History size={24} />} title="Aucun appel IA enregistré" description="Le journal se remplit au fil des conversations Business Grow et des tâches IA." /></div>
        ) : (
          <div className="table-wrap px-5 pb-5">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Espace</th><th>Fournisseur</th><th>Modèle</th><th>Statut</th><th>Jetons</th><th>Coût</th><th>Latence</th></tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr key={call.id}>
                    <td className="whitespace-nowrap text-xs text-slate-400">{formatDate(call.created_at)}</td>
                    <td className="text-xs text-slate-300">{SPACE_LABELS[call.space] ?? call.space}</td>
                    <td className="text-xs text-slate-300">{call.provider}</td>
                    <td className="max-w-[220px] truncate text-xs text-slate-400" title={call.provider_model ?? call.model ?? ''}>{call.provider_model ?? call.model ?? '—'}</td>
                    <td>
                      <Badge tone={STATUS_TONE[call.status] ?? 'neutral'}>
                        {call.status === 'success' ? 'Réussi' : call.status === 'error' ? 'Erreur' : call.status === 'timeout' ? 'Délai' : 'Bloqué'}
                      </Badge>
                    </td>
                    <td className="text-xs text-slate-400">
                      {call.input_tokens !== null && call.output_tokens !== null ? `${call.input_tokens} → ${call.output_tokens}` : '—'}
                    </td>
                    <td className="text-xs text-slate-300">{call.cost_usd > 0 ? formatUsd(call.cost_usd) : '—'}</td>
                    <td className="text-xs text-slate-400">{call.latency_ms !== null ? `${call.latency_ms} ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
