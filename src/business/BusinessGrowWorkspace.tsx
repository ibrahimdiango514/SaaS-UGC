import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Activity, ArrowUpRight, Brain, Building2, Check, ExternalLink, FileText, Gauge, Lightbulb, LockKeyhole,
  MessageSquare, Package, Pencil, Plug, RefreshCw, Send, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, X, Zap,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, LoadingState, Toggle, cn } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { listBrands, listProducts } from '../lib/api';
import {
  buildStudioLocationStateFromBrief,
  parseBusinessGrowEntryIntent,
  type BusinessGrowEntryIntent,
} from '../contracts/business-grow';
import { INTEGRATION_DEFINITIONS, type IntegrationDefinition } from '../integrations/contracts';
import type { Brand, Product, Workspace } from '../lib/types';
import {
  BusinessGrowApiError, businessGrowApi,
  type BusinessConversation, type BusinessIntegrationConnection, type BusinessMemory,
  type BusinessMessage, type BusinessModelRecord, type BusinessProviderStatus,
  type BusinessQuotaStatus, type BusinessRoutingPreference, type BusinessSendOptions,
  type BusinessToolExecution, type BusinessVerificationResult,
} from './api';
import {
  BUSINESS_PROVIDERS, BUSINESS_ROLES, EXTENSIBLE_PROVIDER_ADAPTERS,
  type BusinessCapability, type BusinessRoleKey, type RoutingSelectionMode,
} from './ai/registry';

type BusinessSection = 'chat' | 'company' | 'memory' | 'providers' | 'integrations';

const SECTIONS: { id: BusinessSection; label: string; icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Assistant', icon: MessageSquare },
  { id: 'company', label: 'Entreprise', icon: Building2 },
  { id: 'memory', label: 'Mémoire métier', icon: Building2 },
  { id: 'providers', label: 'Fournisseurs IA', icon: Zap },
  { id: 'integrations', label: 'Intégrations', icon: Plug },
];

function CompanyContextView({ workspace }: { workspace: Workspace | null }) {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    if (!workspace) {
      setBrands([]);
      setProducts([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setBrands([]);
    setProducts([]);
    try {
      const [nextBrands, nextProducts] = await Promise.all([
        listBrands(workspace.id),
        listProducts(workspace.id),
      ]);
      if (requestId !== loadRequestRef.current) return;
      setBrands(nextBrands);
      setProducts(nextProducts);
    } catch (loadError) {
      if (requestId === loadRequestRef.current) {
        setError(loadError instanceof Error ? loadError.message : 'Impossible de charger les données de l’entreprise.');
      }
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    void load();
    return () => { loadRequestRef.current += 1; };
  }, [load]);

  return (
    <section className="space-y-4" data-testid="business-company-context">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-white/[0.08] bg-panel/50 p-5 sm:p-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-brand-200">Compte Reelora partagé</p>
          <h2 className="mt-1 text-lg font-semibold text-white">{workspace?.name ?? 'Aucun espace de travail actif'}</h2>
          {workspace && (
            <p className="mt-1 text-sm text-slate-400">
              {workspace.country_code} · Langue par défaut : {workspace.default_language}
            </p>
          )}
        </div>
        <Link to="/app/parametres" className="btn btn-outline btn-sm">
          Gérer les informations <ExternalLink size={14} />
        </Link>
      </div>

      {!workspace ? (
        <EmptyState
          icon={<Building2 size={22} />}
          title="Espace de travail indisponible"
          description="Reconnectez-vous à Reelora ou réessayez le chargement de votre espace."
        />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading ? (
        <LoadingState label="Chargement des données de l’entreprise…" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/[0.08] bg-panel/50">
            <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
              <div>
                <h3 className="text-sm font-semibold text-white">Marques</h3>
                <p className="mt-1 text-xs text-slate-500">{brands.length} enregistrée(s) dans l’espace commun</p>
              </div>
              <Building2 size={17} className="text-brand-300" />
            </div>
            {brands.length ? (
              <div className="divide-y divide-white/[0.06]">
                {brands.map((brand) => (
                  <article key={brand.id} className="px-5 py-3.5">
                    <h4 className="text-sm font-medium text-slate-100">{brand.name}</h4>
                    <p className="mt-1 text-xs text-slate-400">{brand.industry || 'Secteur non renseigné'}</p>
                    {brand.description && <p className="mt-2 text-xs leading-relaxed text-slate-500">{brand.description}</p>}
                    {brand.voice_guidelines && (
                      <p className="mt-2 rounded-lg bg-white/[0.03] p-2 text-xs text-slate-400">
                        Ton : {brand.voice_guidelines}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState icon={<Building2 size={20} />} title="Aucune marque enregistrée" description="Ajoutez les marques de votre entreprise depuis les paramètres Reelora." />
            )}
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-panel/50">
            <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
              <div>
                <h3 className="text-sm font-semibold text-white">Produits et services</h3>
                <p className="mt-1 text-xs text-slate-500">{products.length} enregistré(s) dans l’espace commun</p>
              </div>
              <Package size={17} className="text-cyan-300" />
            </div>
            {products.length ? (
              <div className="divide-y divide-white/[0.06]">
                {products.map((product) => (
                  <article key={product.id} className="px-5 py-3.5">
                    <h4 className="text-sm font-medium text-slate-100">{product.name}</h4>
                    {product.description && <p className="mt-1 text-xs leading-relaxed text-slate-400">{product.description}</p>}
                    {product.key_benefits.length > 0 && (
                      <p className="mt-2 text-xs text-slate-500">Bénéfices : {product.key_benefits.join(' · ')}</p>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState icon={<Package size={20} />} title="Aucun produit enregistré" description="Ajoutez vos produits ou services depuis les paramètres Reelora." />
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
        <p className="text-xs text-slate-400">
          Ces données proviennent de l’espace Reelora partagé. Elles ne sont pas copiées dans la mémoire IA.
        </p>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void load()} disabled={loading || !workspace}>
          Actualiser
        </Button>
      </div>
    </section>
  );
}

const PROMPT_IDEAS = [
  { label: 'Rédiger', text: 'Aidez-moi à rédiger un contenu pour mon activité.', icon: FileText },
  { label: 'Analyser', text: 'Aidez-moi à analyser une campagne marketing.', icon: Lightbulb },
  { label: 'Planifier', text: 'Aidez-moi à structurer les prochaines étapes de mon activité.', icon: Sparkles },
];

const CAPABILITY_LABELS: Record<BusinessCapability, string> = {
  writing: 'Rédaction',
  images: 'Images',
  documents: 'Documents',
  scripts: 'Scripts',
  hooks: 'Hooks',
  reasoning: 'Raisonnement',
  analysis: 'Analyse',
  'economic-routing': 'Routage économique',
  fallback: 'Secours',
  'specialized-models': 'Modèles spécialisés',
  'model-comparison': 'Comparaison de modèles',
  experimentation: 'Expérimentation',
  'video-generation': 'Génération vidéo',
};

const TOOL_LABELS: Record<string, string> = {
  propose_memory_save: 'Enregistrer dans la mémoire métier',
  propose_action_plan: 'Structurer un plan d’action',
  propose_campaign_brief: 'Créer un brief campagne marketing',
  handoff_ugc_brief: 'Transférer vers Studio UGC',
  request_connector_read: 'Demander une lecture connecteur',
};

interface VerifyBanner {
  tone: 'success' | 'error';
  message: string;
  code?: string | null;
  hint?: string | null;
}

function isVerifiedProvider(provider: BusinessProviderStatus | undefined): boolean {
  return Boolean(
    provider
      && provider.config_status === 'configured'
      && provider.enabled
      && provider.status === 'available'
      && provider.checked_at,
  );
}

function formatProbeTime(checkedAt: string | null | undefined): string {
  if (!checkedAt) return '';
  const date = new Date(checkedAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function describeProviderFailureHint(code: string | null | undefined): string {
  switch (code) {
    case 'PROVIDER_AUTH_FAILED':
      return 'Clé API rejetée par le fournisseur. Vérifiez ou renouvelez le secret serveur dans Supabase Edge Functions Secrets.';
    case 'PROVIDER_RATE_LIMITED':
      return 'Limite de débit ou quota fournisseur atteint pour ce modèle. Sélectionnez un autre modèle vérifié ou basculez vers l’autre fournisseur.';
    case 'PROVIDER_REQUEST_REJECTED':
      return 'Le modèle configuré ou la requête a été rejeté par le fournisseur. Vérifiez l’identifiant exact du modèle.';
    case 'PROVIDER_NOT_CONFIGURED':
      return 'Clé API ou modèle manquant côté serveur. Renseignez les variables BUSINESS_GROW_* sur Supabase.';
    case 'PROVIDER_TIMEOUT':
    case 'PROVIDER_NETWORK_ERROR':
    case 'PROVIDER_UNAVAILABLE':
      return 'Le fournisseur n’a pas répondu dans le délai imparti ou est momentanément indisponible. Relancez le test ou activez le secours auto.';
    case 'ORIGIN_NOT_ALLOWED':
      return 'Origine du navigateur refusée par CORS sur business-grow. Vérifiez BUSINESS_GROW_ALLOWED_ORIGINS ou utilisez le relais preview Netlify.';
    case 'BUSINESS_GROW_UNAVAILABLE':
      return 'Backend Business Grow injoignable depuis le navigateur. Vérifiez le déploiement de la fonction ou le relais Netlify.';
    default:
      return 'Relancez une vérification serveur ou inspectez les journaux Supabase Edge Functions pour obtenir le détail.';
  }
}

function providerStatus(provider: BusinessProviderStatus | undefined): {
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  description: string;
} {
  if (!provider) {
    return {
      label: 'Non vérifié',
      tone: 'neutral',
      description: 'Le statut serveur n’a pas encore été interrogé.',
    };
  }
  if (provider.config_status !== 'configured') {
    return {
      label: 'Non configuré',
      tone: 'neutral',
      description: 'Aucune clé API ou configuration serveur utilisable n’est active.',
    };
  }
  if (!provider.checked_at) {
    return {
      label: 'Configuré · Non vérifié',
      tone: 'warning',
      description: 'Une configuration serveur existe, mais aucun test réel réussi n’a encore validé ce fournisseur.',
    };
  }
  if (isVerifiedProvider(provider)) {
    const at = formatProbeTime(provider.checked_at);
    const verifiedCount = provider.verified_model_keys?.length ?? 0;
    const modelSummary = verifiedCount > 0 ? ` · ${verifiedCount} modèle(s) actif(s)` : '';
    return {
      label: 'Vérifié',
      tone: 'success',
      description: `Test serveur réel réussi${at ? ` le ${at}` : ''}${modelSummary}.`,
    };
  }
  if (provider.status === 'degraded') {
    const codePart = provider.error_code ? ` (${provider.error_code})` : '';
    return {
      label: 'Dégradé',
      tone: 'warning',
      description: `Dernier test serveur dégradé${codePart}. ${describeProviderFailureHint(provider.error_code)}`,
    };
  }
  if (provider.status === 'unavailable' || provider.error_code) {
    const codePart = provider.error_code ? ` (${provider.error_code})` : '';
    return {
      label: 'Échec vérification',
      tone: 'danger',
      description: `Le dernier test serveur a échoué${codePart}. ${describeProviderFailureHint(provider.error_code)}`,
    };
  }
  return {
    label: 'Configuré · Non vérifié',
    tone: 'warning',
    description: 'Le modèle configuré doit réussir un test serveur réel pour être routable.',
  };
}

function ProviderStatusList({ statuses, compact = false }: {
  statuses: BusinessProviderStatus[] | null;
  compact?: boolean;
}) {
  const providers = compact ? BUSINESS_PROVIDERS.filter((provider) => provider.id !== 'muapi').slice(0, 3) : BUSINESS_PROVIDERS;
  const byKey = new Map((statuses ?? []).map((status) => [status.provider_key, status]));

  return (
    <div className="space-y-2">
      {providers.map((provider) => {
        const status = providerStatus(byKey.get(provider.id));
        return (
          <div key={provider.id} className="flex items-start justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-200">{provider.name}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{status.description}</p>
            </div>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
        );
      })}
    </div>
  );
}

function AssistantView({
  backendReady,
  providers,
  models,
  quota,
  tools,
  conversations,
  selectedConversationId,
  messages,
  loading,
  error,
  busy,
  roleKey,
  routingMode,
  preferredProviderKey,
  preferredModelKey,
  manualAllowFallback,
  entryIntent,
  onChangeRole,
  onChangeRoutingMode,
  onChangePreferredProvider,
  onChangePreferredModel,
  onChangeManualAllowFallback,
  onDismissEntryIntent,
  onResolveTool,
  onNewConversation,
  onRenameConversation,
  onDeleteConversation,
  onSelectConversation,
  onSend,
  onRetry,
}: {
  backendReady: boolean;
  providers: BusinessProviderStatus[] | null;
  models: BusinessModelRecord[];
  quota: BusinessQuotaStatus | null;
  tools: BusinessToolExecution[];
  conversations: BusinessConversation[];
  selectedConversationId: string | null;
  messages: BusinessMessage[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  roleKey: BusinessRoleKey;
  routingMode: RoutingSelectionMode;
  preferredProviderKey: string;
  preferredModelKey: string;
  manualAllowFallback: boolean;
  entryIntent: BusinessGrowEntryIntent | null;
  onChangeRole: (role: BusinessRoleKey) => void;
  onChangeRoutingMode: (mode: RoutingSelectionMode) => void;
  onChangePreferredProvider: (providerKey: string) => void;
  onChangePreferredModel: (modelKey: string) => void;
  onChangeManualAllowFallback: (allow: boolean) => void;
  onDismissEntryIntent: () => void;
  onResolveTool: (executionId: string, decision: 'approved' | 'rejected') => Promise<void>;
  onNewConversation: () => void;
  onRenameConversation: (id: string, title: string) => Promise<boolean>;
  onDeleteConversation: (id: string) => Promise<boolean>;
  onSelectConversation: (id: string) => void;
  onSend: (content: string) => Promise<boolean>;
  onRetry: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const activeConversation = conversations.find((conversation) => conversation.id === selectedConversationId);
  const availableProviders = (providers ?? []).filter((provider) => isVerifiedProvider(provider));
  const verifiedModels = models.filter((model) => model.verification_status === 'verified' && model.enabled);
  const pendingTools = tools.filter((tool) => tool.status === 'pending_approval');
  const executedHandoffs = tools.filter((tool) => tool.tool_name === 'handoff_ugc_brief' && tool.status === 'executed');
  const resolvedOtherTools = tools.filter(
    (tool) => tool.tool_name !== 'handoff_ugc_brief' && tool.status !== 'pending_approval',
  );

  useEffect(() => {
    if (entryIntent?.initialDraft) {
      setDraft((current) => current || entryIntent.initialDraft || '');
    }
  }, [entryIntent]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy || !backendReady) return;
    if (await onSend(content)) setDraft('');
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <section className="flex min-h-[620px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#090d16]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-500/15 text-brand-200"><Brain size={19} /></span>
            <div>
              <h2 className="text-sm font-semibold text-white">Copilote Business Grow</h2>
              <p className="text-xs text-slate-500">AI Director · {availableProviders.length ? 'fournisseurs vérifiés' : 'aucun fournisseur vérifié'}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            icon={<MessageSquare size={14} />}
            onClick={() => { setDraft(''); onNewConversation(); }}
            disabled={!backendReady || busy}
          >
            Nouvelle conversation
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-white/[0.015] px-4 py-2.5 sm:px-6">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span>Rôle :</span>
            <select
              aria-label="Rôle de la tâche IA"
              value={roleKey}
              onChange={(event) => onChangeRole(event.target.value as BusinessRoleKey)}
              className="rounded-lg border border-white/10 bg-[#0c111b] px-2 py-1 text-xs text-slate-200 outline-none focus:border-brand-400/40"
            >
              {BUSINESS_ROLES.map((role) => (
                <option key={role.roleKey} value={role.roleKey}>{role.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span>Routage :</span>
            <select
              aria-label="Mode de routage"
              value={routingMode}
              onChange={(event) => onChangeRoutingMode(event.target.value as RoutingSelectionMode)}
              className="rounded-lg border border-white/10 bg-[#0c111b] px-2 py-1 text-xs text-slate-200 outline-none focus:border-brand-400/40"
            >
              <option value="auto">Automatique (AI Director)</option>
              <option value="manual">Manuel</option>
            </select>
          </label>
          {routingMode === 'manual' && (
            <>
              <select
                aria-label="Fournisseur manuel"
                value={preferredProviderKey}
                onChange={(event) => onChangePreferredProvider(event.target.value)}
                className="rounded-lg border border-white/10 bg-[#0c111b] px-2 py-1 text-xs text-slate-200 outline-none focus:border-brand-400/40"
              >
                <option value="">Fournisseur…</option>
                {availableProviders.map((provider) => (
                  <option key={provider.provider_key} value={provider.provider_key}>{provider.display_name}</option>
                ))}
              </select>
              {verifiedModels.length > 0 && (
                <select
                  aria-label="Modèle manuel"
                  value={preferredModelKey}
                  onChange={(event) => onChangePreferredModel(event.target.value)}
                  className="max-w-[200px] truncate rounded-lg border border-white/10 bg-[#0c111b] px-2 py-1 text-xs text-slate-200 outline-none focus:border-brand-400/40"
                >
                  <option value="">Modèle par défaut</option>
                  {verifiedModels
                    .filter((m) => !preferredProviderKey || m.provider_key === preferredProviderKey)
                    .map((model) => (
                      <option key={`${model.provider_key}:${model.model_key}`} value={model.model_key}>{model.display_name}</option>
                    ))}
                </select>
              )}
              <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-[#0c111b] px-2 py-1 text-[11px] text-slate-300">
                <input
                  type="checkbox"
                  checked={manualAllowFallback}
                  onChange={(event) => onChangeManualAllowFallback(event.target.checked)}
                  aria-label="Autoriser le secours automatique en mode manuel"
                  className="accent-brand-400"
                />
                <span>Secours auto</span>
              </label>
            </>
          )}
          {quota && quota.available_units !== null && (
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-slate-300" data-testid="business-quota-pill">
              <Gauge size={12} className="text-brand-300" />
              Quota Business Grow : {quota.available_units} unités
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-6" aria-live="polite">
          {entryIntent && (entryIntent.projectTitle || entryIntent.brandName || entryIntent.productName || entryIntent.sourceRoute) && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-400/20 bg-brand-500/[0.06] px-3 py-2 text-xs text-brand-100" data-testid="business-entry-intent-banner">
              <span>
                Contexte importé
                {entryIntent.projectTitle ? ` · Projet : ${entryIntent.projectTitle}` : ''}
                {entryIntent.brandName ? ` · Marque : ${entryIntent.brandName}` : ''}
                {entryIntent.productName ? ` · Produit : ${entryIntent.productName}` : ''}
              </span>
              <button type="button" onClick={onDismissEntryIntent} className="text-[11px] text-brand-200 underline">
                Masquer
              </button>
            </div>
          )}
          {error && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs text-rose-100" role="alert">
              <span>{error}</span>
              <button type="button" className="shrink-0 underline" onClick={onRetry}>Réessayer</button>
            </div>
          )}
          {!backendReady && (
            <div className="m-auto w-full max-w-xl rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-4 text-left" role="status" data-testid="business-ai-unavailable">
              <div className="flex gap-3">
                <LockKeyhole size={17} className="mt-0.5 shrink-0 text-amber-300" />
                <div>
                  <p className="text-sm font-semibold text-amber-100">Backend Business Grow indisponible</p>
                  <p className="mt-1 text-xs leading-relaxed text-amber-100/70">
                    L’historique et la mémoire seront activés après installation du schéma et de la fonction serveur. Aucune donnée n’est enregistrée localement comme si elle était persistée.
                  </p>
                </div>
              </div>
            </div>
          )}
          {backendReady && messages.length === 0 && (
            <div className="m-auto max-w-xl text-center">
              <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-brand-400/20 bg-brand-500/10 text-brand-200">
                <Sparkles size={24} />
              </span>
              <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-brand-200">Votre espace de travail IA</p>
              <h3 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">Faites grandir votre activité, à votre façon.</h3>
              <p className="mt-3 text-sm leading-relaxed text-slate-400">
                {activeConversation?.title || 'Créez une conversation et échangez avec votre copilote métier.'}
              </p>
              <div className="mt-7 grid gap-2 sm:grid-cols-3">
                {PROMPT_IDEAS.map(({ label, text, icon: Icon }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setDraft(text)}
                    className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-3 text-left text-xs text-slate-300 transition hover:border-brand-400/30 hover:bg-brand-500/[0.06]"
                  >
                    <Icon size={15} className="shrink-0 text-brand-200" />{label}<ArrowUpRight size={12} className="ml-auto text-slate-600" />
                  </button>
                ))}
              </div>
            </div>
          )}
          {loading && <p className="m-auto text-sm text-slate-400">Chargement de la conversation…</p>}
          {busy && <p className="text-center text-xs text-brand-200" role="status">Demande en attente · traitement par l’AI Director…</p>}
          {messages.map((message) => (
            <article
              key={message.id}
              className={cn(
                'max-w-[90%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed',
                message.author_role === 'user'
                  ? 'ml-auto bg-brand-500/15 text-white'
                  : 'mr-auto border border-white/[0.08] bg-white/[0.03] text-slate-200',
              )}
              data-testid={`business-message-${message.author_role}`}
            >
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                {message.author_role === 'user' ? 'Vous' : 'Business Grow'}
              </p>
              {message.content}
              {message.request_status && (
                <p className={cn(
                  'mt-2 border-t border-white/[0.08] pt-2 text-[10px]',
                  message.request_status === 'failed' ? 'text-amber-200' : 'text-slate-500',
                )}>
                  {message.request_status === 'queued' && 'En attente'}
                  {message.request_status === 'running' && 'Traitement en cours'}
                  {message.request_status === 'succeeded' && 'Traitement réussi'}
                  {message.request_status === 'failed' && `Erreur (${message.request_error_code || 'erreur inconnue'})`}
                  {message.request_status === 'canceled' && 'Traitement annulé'}
                  {message.request_status === 'succeeded' && message.author_role === 'assistant' && message.request_provider_key
                    ? ` · Réponse fournie par ${BUSINESS_PROVIDERS.find((provider) => provider.id === message.request_provider_key)?.name ?? message.request_provider_key}${message.request_model_key ? ` · ${message.request_model_key}` : ''}`
                    : null}
                </p>
              )}
            </article>
          ))}
          {pendingTools.length > 0 && (
            <div className="space-y-2 rounded-xl border border-brand-400/20 bg-brand-500/[0.05] p-3" data-testid="business-tool-proposals">
              <p className="text-xs font-semibold text-brand-100">Actions assistées en attente d’approbation</p>
              {pendingTools.map((tool) => (
                <div key={tool.id} className="rounded-lg border border-white/[0.08] bg-[#0c111b] p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-white">{TOOL_LABELS[tool.tool_name] ?? tool.tool_name}</span>
                    <Badge tone="neutral">{tool.risk_level === 'write_requires_approval' ? 'Validation requise' : 'Publication bloquée'}</Badge>
                  </div>
                  <p className="mt-1.5 text-[11px] text-slate-400">
                    {typeof tool.input_args?.summary === 'string' ? tool.input_args.summary : JSON.stringify(tool.input_args)}
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => { void onResolveTool(tool.id, 'approved'); }} disabled={busy}>
                      Approuver
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { void onResolveTool(tool.id, 'rejected'); }} disabled={busy}>
                      Rejeter
                    </Button>
                    {tool.tool_name === 'handoff_ugc_brief' && (
                      <Link
                        to="/app/studio"
                        state={buildStudioLocationStateFromBrief(tool.input_args, {
                          executionId: tool.id,
                          conversationId: tool.conversation_id,
                        }) ?? { ugcBrief: tool.input_args }}
                        className="btn btn-outline btn-sm"
                      >
                        Ouvrir dans Studio UGC (sans débit) <ArrowUpRight size={13} />
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {executedHandoffs.length > 0 && (
            <div className="space-y-2 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.05] p-3" data-testid="business-handoff-ready">
              {executedHandoffs.slice(0, 3).map((tool) => {
                const draftPayload = (tool.output_result?.handoffDraft && typeof tool.output_result.handoffDraft === 'object')
                  ? tool.output_result.handoffDraft as Record<string, unknown>
                  : tool.input_args;
                return (
                  <div key={tool.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-emerald-100">Brief approuvé prêt pour Studio UGC</span>
                    <Link
                      to="/app/studio"
                      state={buildStudioLocationStateFromBrief(draftPayload, {
                        executionId: tool.id,
                        conversationId: tool.conversation_id,
                      }) ?? { ugcBrief: draftPayload }}
                      className="btn btn-outline btn-sm"
                    >
                      Ouvrir dans Studio UGC (sans débit) <ArrowUpRight size={13} />
                    </Link>
                  </div>
                );
              })}
            </div>
          )}
          {resolvedOtherTools.length > 0 && (
            <div className="space-y-1.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-xs" data-testid="business-tools-history">
              <p className="font-semibold text-slate-300">Historique des actions traitées</p>
              {resolvedOtherTools.slice(0, 4).map((tool) => {
                const statusBadge = tool.status === 'executed'
                  ? 'Exécutée'
                  : tool.status === 'rejected'
                    ? 'Rejetée'
                    : tool.status === 'failed'
                      ? 'Échec'
                      : 'Approuvée';
                return (
                  <div key={tool.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-[#0c111b] px-2.5 py-2">
                    <span className="text-slate-200">{TOOL_LABELS[tool.tool_name] ?? tool.tool_name}</span>
                    <Badge tone={tool.status === 'executed' ? 'success' : 'neutral'}>{statusBadge}</Badge>
                  </div>
                );
              })}
            </div>
          )}
          {backendReady && !availableProviders.length && (
            <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 text-xs leading-relaxed text-amber-100/80" role="status">
              Aucun fournisseur IA vérifié n’est actuellement disponible. Votre demande sera conservée dans l’historique, mais aucune réponse ne sera simulée.
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="border-t border-white/[0.07] bg-black/20 p-3 sm:p-5">
          <label htmlFor="business-chat-draft" className="sr-only">Votre demande</label>
          <div className="flex items-end gap-2 rounded-2xl border border-white/[0.10] bg-[#0c111b] p-2 focus-within:border-brand-400/40">
            <textarea
              id="business-chat-draft"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Décrivez votre besoin métier…"
              rows={2}
              maxLength={12_000}
              disabled={!backendReady || busy}
              className="max-h-40 min-h-12 flex-1 resize-y bg-transparent px-2 py-2 text-sm leading-relaxed text-white outline-none placeholder:text-slate-600 disabled:opacity-50"
            />
            <Button type="submit" disabled={!backendReady || busy || !draft.trim()} loading={busy} icon={<Send size={15} />}>
              Envoyer
            </Button>
          </div>
          <p className="mt-2 text-center text-[10px] text-slate-600">
            {!backendReady ? 'Envoi indisponible tant que le backend n’est pas installé.' : 'Sans fournisseur vérifié, aucune réponse IA ne sera générée.'}
          </p>
        </form>
      </section>

      <aside className="space-y-4">
        <section className="rounded-2xl border border-white/[0.08] bg-panel/50 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white">Conversations</h2>
            <span className="text-[10px] text-slate-500">{conversations.length} enregistrée(s)</span>
          </div>
          {conversations.length ? (
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {conversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={cn(
                    'w-full rounded-xl px-3 py-2 text-left text-xs transition',
                    conversation.id === selectedConversationId ? 'bg-brand-500/15 text-brand-100' : 'text-slate-400 hover:bg-white/[0.04]',
                  )}
                >
                  {editingId === conversation.id ? (
                    <form
                      className="flex items-center gap-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const title = editingTitle.trim();
                        if (title) void onRenameConversation(conversation.id, title).then((success) => { if (success) setEditingId(null); });
                      }}
                    >
                      <input
                        aria-label="Nouveau titre de conversation"
                        autoFocus
                        maxLength={160}
                        value={editingTitle}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        className="min-w-0 flex-1 rounded border border-white/10 bg-[#0c111b] px-2 py-1 text-xs text-white"
                      />
                      <button type="submit" aria-label="Enregistrer le titre" disabled={!editingTitle.trim()} className="rounded p-1 text-emerald-300 hover:bg-white/10 disabled:opacity-40">
                        <Check size={14} />
                      </button>
                      <button type="button" aria-label="Annuler le renommage" onClick={() => setEditingId(null)} className="rounded p-1 text-slate-400 hover:bg-white/10">
                        <X size={14} />
                      </button>
                    </form>
                  ) : deletingId === conversation.id ? (
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-rose-200">Supprimer cette conversation ?</span>
                      <span className="flex gap-1">
                        <button
                          type="button"
                          aria-label="Confirmer la suppression"
                          onClick={() => {
                            void onDeleteConversation(conversation.id).then((success) => { if (success) setDeletingId(null); });
                          }}
                          className="rounded px-2 py-1 text-rose-200 hover:bg-rose-500/15"
                        >
                          Oui
                        </button>
                        <button
                          type="button"
                          aria-label="Annuler la suppression"
                          onClick={() => setDeletingId(null)}
                          className="rounded px-2 py-1 text-slate-400 hover:bg-white/10"
                        >
                          Non
                        </button>
                      </span>
                    </span>
                  ) : (
                    <>
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onSelectConversation(conversation.id)}
                          aria-current={conversation.id === selectedConversationId ? 'page' : undefined}
                          className="block min-w-0 flex-1 truncate text-left font-medium"
                        >
                          {conversation.title || 'Nouvelle conversation'}
                        </button>
                        <button
                          type="button"
                          aria-label="Renommer la conversation"
                          onClick={() => {
                            setEditingId(conversation.id);
                            setEditingTitle(conversation.title || '');
                            setDeletingId(null);
                          }}
                          className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-white"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          aria-label="Supprimer la conversation"
                          onClick={() => {
                            setDeletingId(conversation.id);
                            setEditingId(null);
                          }}
                          className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                      {conversation.last_message && <span className="mt-1 block truncate text-[10px] text-slate-600">{conversation.last_message}</span>}
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-white/[0.10] px-4 py-6 text-center">
              <MessageSquare size={18} className="mx-auto text-slate-600" />
              <p className="mt-2 text-xs font-medium text-slate-400">Aucune conversation enregistrée</p>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                {backendReady ? 'Créez une conversation pour commencer.' : 'Disponible après connexion au backend.'}
              </p>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-white/[0.08] bg-panel/50 p-4">
          <div className="mb-3 flex items-center gap-2">
            <Zap size={15} className="text-cyan-300" />
            <h2 className="text-sm font-semibold text-white">Registre IA</h2>
          </div>
          <ProviderStatusList statuses={providers} compact />
          <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
            {availableProviders.length === 0 ? 'Aucun fournisseur disponible ou validé pour le routage.' : `${availableProviders.length} fournisseur(s) disponible(s) et validé(s).`}
          </p>
        </section>

        <section className="rounded-2xl border border-white/[0.08] bg-panel/50 p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck size={15} className="text-emerald-300" />
            <h2 className="text-sm font-semibold text-white">Données privées</h2>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            Les conversations sont liées à votre compte Reelora. La mémoire n’est utilisée qu’après votre consentement.
          </p>
        </section>
      </aside>
    </div>
  );
}

function MemoryView({
  memory,
  loading,
  busy,
  error,
  onConsent,
  onSaveProfile,
  onPutItem,
  onDeleteItem,
  onRetry,
}: {
  memory: BusinessMemory | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onConsent: (enabled: boolean) => Promise<void>;
  onSaveProfile: (profile: Record<string, unknown>) => Promise<void>;
  onPutItem: (category: string, content: unknown) => Promise<void>;
  onDeleteItem: (id: string) => Promise<void>;
  onRetry: () => void;
}) {
  const [profileDraft, setProfileDraft] = useState('{}');
  const [category, setCategory] = useState('business_context');
  const [itemDraft, setItemDraft] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (memory) setProfileDraft(JSON.stringify(memory.profile ?? {}, null, 2));
  }, [memory]);

  const saveProfile = async () => {
    setFormError(null);
    try {
      const parsed: unknown = JSON.parse(profileDraft);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Le profil doit être un objet JSON.');
      await onSaveProfile(parsed as Record<string, unknown>);
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : 'Profil JSON invalide.');
    }
  };

  const addItem = async () => {
    if (!itemDraft.trim()) return;
    await onPutItem(category, { text: itemDraft.trim() });
    setItemDraft('');
  };

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-panel/50 p-5 sm:p-7">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-white">Mémoire métier privée</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Cette mémoire est rattachée à votre compte Reelora. La révocation supprime les éléments mémorisés; elle n’efface pas vos conversations.
        </p>
      </div>
      {error && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs text-rose-100" role="alert">
          <span>{error}</span><button type="button" className="underline" onClick={onRetry}>Réessayer</button>
        </div>
      )}
      {loading ? <p className="mt-6 text-sm text-slate-400">Chargement de votre mémoire…</p> : (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div>
              <p className="text-sm font-medium text-white">Consentement mémoire</p>
              <p className="mt-1 text-xs text-slate-500">
                {memory?.consent ? 'La mémoire métier peut être enregistrée.' : 'La mémoire est désactivée et reste vide.'}
              </p>
            </div>
            <Toggle checked={Boolean(memory?.consent)} onChange={(enabled) => { void onConsent(enabled); }} label={memory?.consent ? 'Activée' : 'Désactivée'} />
          </div>

          {memory?.consent && (
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <div className="space-y-3">
                <label className="block text-xs font-medium text-slate-300" htmlFor="business-memory-profile">Profil et objectifs (JSON)</label>
                <textarea
                  id="business-memory-profile"
                  value={profileDraft}
                  onChange={(event) => setProfileDraft(event.target.value)}
                  rows={9}
                  className="w-full rounded-xl border border-white/10 bg-[#0c111b] p-3 font-mono text-xs text-slate-200 outline-none focus:border-brand-400/40"
                />
                {formError && <p className="text-xs text-rose-300" role="alert">{formError}</p>}
                <Button onClick={() => { void saveProfile(); }} disabled={busy} loading={busy}>Enregistrer le profil</Button>
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-white">Notes métier</h3>
                <div className="flex gap-2">
                  <input value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Catégorie mémoire" className="w-36 rounded-lg border border-white/10 bg-[#0c111b] px-3 py-2 text-xs text-white" />
                  <input value={itemDraft} onChange={(event) => setItemDraft(event.target.value)} aria-label="Note mémoire" placeholder="Contexte utile…" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#0c111b] px-3 py-2 text-xs text-white" />
                  <Button size="sm" onClick={() => { void addItem(); }} disabled={busy || !itemDraft.trim()}>Ajouter</Button>
                </div>
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {(memory?.items ?? []).map((item) => (
                    <article key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-white/[0.07] bg-black/15 p-3">
                      <div className="min-w-0">
                        <p className="text-[10px] uppercase tracking-wide text-brand-200">{item.category}</p>
                        <p className="mt-1 break-words text-xs text-slate-300">{typeof item.content === 'object' && item.content !== null && 'text' in item.content ? String((item.content as { text: unknown }).text) : JSON.stringify(item.content)}</p>
                      </div>
                      <button type="button" onClick={() => { void onDeleteItem(item.id); }} disabled={busy} aria-label="Supprimer la note" className="text-slate-500 hover:text-rose-300 disabled:opacity-50">
                        <Trash2 size={14} />
                      </button>
                    </article>
                  ))}
                  {!memory?.items.length && <p className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-slate-500">Aucune note enregistrée.</p>}
                </div>
              </div>
            </div>
          )}
        </>
      )}
      <p className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 text-xs leading-relaxed text-amber-100/80" role="status">
        {memory?.consent
          ? 'Seules les données de mémoire explicitement enregistrées sont conservées. Vous pouvez révoquer votre consentement à tout moment.'
          : 'Aucune donnée métier ne sera enregistrée en mémoire sans votre consentement.'}
      </p>
    </section>
  );
}

function ProvidersView({
  backendReady,
  statuses,
  models,
  requests,
  savedRouting,
  quota,
  verifyingKey,
  verifyBanner,
  onVerifyProvider,
  onSaveRouting,
}: {
  backendReady: boolean;
  statuses: BusinessProviderStatus[] | null;
  models: BusinessModelRecord[];
  requests: Array<Record<string, unknown>>;
  savedRouting: Array<Record<string, unknown>>;
  quota: BusinessQuotaStatus | null;
  verifyingKey: string | null;
  verifyBanner: VerifyBanner | null;
  onVerifyProvider: (providerKey: string, modelKey?: string) => Promise<void>;
  onSaveRouting: (pref: BusinessRoutingPreference) => Promise<void>;
}) {
  const byKey = new Map((statuses ?? []).map((status) => [status.provider_key, status]));
  const [routingRole, setRoutingRole] = useState<BusinessRoleKey>('business_advisor');
  const [routingMode, setRoutingMode] = useState<RoutingSelectionMode>('auto');
  const [routingProvider, setRoutingProvider] = useState('');
  const [routingModel, setRoutingModel] = useState('');
  const [routingAllowFallback, setRoutingAllowFallback] = useState(true);

  const configurableProviders = (statuses ?? []).filter(
    (status) => status.provider_key !== 'muapi' && (status.config_status === 'configured' || status.enabled),
  );
  const modelsForSelectedProvider = models.filter(
    (model) => model.enabled && (!routingProvider || model.provider_key === routingProvider),
  );

  const handleSelectRoutingRole = (nextRole: BusinessRoleKey) => {
    setRoutingRole(nextRole);
    const existing = savedRouting.find((pref) => pref.role_key === nextRole);
    if (existing) {
      const nextMode: RoutingSelectionMode = existing.selection_mode === 'manual' ? 'manual' : 'auto';
      setRoutingMode(nextMode);
      setRoutingProvider(typeof existing.preferred_provider_key === 'string' ? existing.preferred_provider_key : '');
      setRoutingModel(typeof existing.preferred_model_key === 'string' ? existing.preferred_model_key : '');
      setRoutingAllowFallback(typeof existing.allow_fallback === 'boolean' ? existing.allow_fallback : nextMode === 'auto');
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-white/[0.08] bg-panel/50 p-5 sm:p-7">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="text-lg font-semibold text-white">Registre des fournisseurs</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Les rôles affichés sont des propositions. L’AI Director ne peut router que vers un fournisseur configuré, vérifié et disponible côté serveur.
            </p>
          </div>
          {quota && quota.available_units !== null && (
            <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-xs text-slate-300">
              <p className="font-semibold text-white">Quota Business Grow isolé</p>
              <p className="mt-0.5 text-slate-400">{quota.available_units} unité(s) · Studio UGC intact ({quota.studio_ugc_untouched ? 'oui' : 'non'})</p>
            </div>
          )}
        </div>
        {verifyBanner && (
          <div
            className={cn(
              'mb-4 rounded-xl border p-3.5 text-xs',
              verifyBanner.tone === 'success'
                ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
                : 'border-rose-400/30 bg-rose-500/10 text-rose-100',
            )}
            role={verifyBanner.tone === 'error' ? 'alert' : 'status'}
          >
            <p className="font-medium">
              {verifyBanner.message}
              {verifyBanner.code ? <span className="ml-2 font-mono text-[10px] opacity-80">[{verifyBanner.code}]</span> : null}
            </p>
            {verifyBanner.hint && (
              <p className="mt-1 text-[11px] opacity-85">{verifyBanner.hint}</p>
            )}
          </div>
        )}
        <div className="space-y-3">
          {BUSINESS_PROVIDERS.map((provider) => {
            const rawStatus = byKey.get(provider.id);
            const status = providerStatus(rawStatus);
            const providerModels = models.filter((model) => model.provider_key === provider.id);
            const canProbe = backendReady && provider.id !== 'muapi' && (rawStatus?.config_status === 'configured' || provider.id === 'groq' || provider.id === 'gemini');
            return (
              <article key={provider.id} className="rounded-xl border border-white/[0.07] bg-black/15 p-4" data-testid={`provider-${provider.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-white">{provider.name}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">{status.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {canProbe && (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={verifyingKey === provider.id}
                        disabled={Boolean(verifyingKey)}
                        onClick={() => { void onVerifyProvider(provider.id); }}
                      >
                        Vérifier la connexion
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {provider.proposedCapabilities.map((capability) => (
                    <span key={capability} className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-2 py-1 text-[10px] text-slate-400">
                      {CAPABILITY_LABELS[capability]}
                    </span>
                  ))}
                </div>
                {providerModels.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {providerModels.map((model) => {
                      const modelStateLabel = model.verification_status === 'verified'
                        ? 'Vérifié'
                        : model.verification_status === 'unavailable'
                          ? `Indisponible${model.error_code ? ` · ${model.error_code}` : ''}`
                          : 'Non vérifié';
                      return (
                        <button
                          key={model.model_key}
                          type="button"
                          disabled={!canProbe || Boolean(verifyingKey)}
                          title={canProbe ? `Exécuter un test serveur réel sur ${model.provider_model_key}` : undefined}
                          onClick={() => {
                            if (canProbe) void onVerifyProvider(provider.id, model.provider_model_key);
                          }}
                          className={cn(
                            'rounded-md border px-2 py-0.5 text-[10px] transition',
                            model.verification_status === 'verified'
                              ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20'
                              : model.verification_status === 'unavailable'
                                ? 'border-rose-400/25 bg-rose-400/10 text-rose-200 hover:bg-rose-400/20'
                                : 'border-white/10 bg-white/[0.02] text-slate-400 hover:bg-white/[0.08]',
                            (!canProbe || Boolean(verifyingKey)) && 'cursor-default opacity-80',
                          )}
                        >
                          {model.display_name} ({modelStateLabel})
                        </button>
                      );
                    })}
                  </div>
                )}
                {provider.note && <p className="mt-3 text-[11px] text-slate-500">{provider.note}</p>}
              </article>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-white/[0.08] bg-panel/50 p-5 sm:p-7">
        <div className="mb-4 flex items-center gap-2">
          <SlidersHorizontal size={16} className="text-brand-300" />
          <h3 className="text-sm font-semibold text-white">Adaptateurs extensibles préparés</h3>
        </div>
        <p className="mb-4 text-xs text-slate-400">
          Ces adaptateurs disposent d’une interface prête côté serveur, sans clé ni exécution distante active tant qu’ils ne sont pas configurés et vérifiés.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {EXTENSIBLE_PROVIDER_ADAPTERS.map((adapter) => (
            <article key={adapter.id} className="rounded-xl border border-white/[0.07] bg-black/15 p-3.5" data-testid={`adapter-${adapter.id}`}>
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-medium text-white">{adapter.name}</h4>
                <Badge tone="neutral">{adapter.statusLabel}</Badge>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">{adapter.statusDescription}</p>
              <p className="mt-2 font-mono text-[10px] text-slate-500">{adapter.envKeyHint}</p>
            </article>
          ))}
        </div>
      </section>

      {backendReady && (
        <section className="rounded-2xl border border-white/[0.08] bg-panel/50 p-5 sm:p-7">
          <h3 className="text-sm font-semibold text-white">Préférence de routage par rôle</h3>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              aria-label="Rôle routage"
              value={routingRole}
              onChange={(event) => handleSelectRoutingRole(event.target.value as BusinessRoleKey)}
              className="rounded-lg border border-white/10 bg-[#0c111b] px-3 py-2 text-xs text-white"
            >
              {BUSINESS_ROLES.map((role) => (
                <option key={role.roleKey} value={role.roleKey}>{role.label}</option>
              ))}
            </select>
            <select
              aria-label="Mode de routage par rôle"
              value={routingMode}
              onChange={(event) => {
                const nextMode = event.target.value as RoutingSelectionMode;
                setRoutingMode(nextMode);
                if (nextMode === 'auto') setRoutingAllowFallback(true);
              }}
              className="rounded-lg border border-white/10 bg-[#0c111b] px-3 py-2 text-xs text-white"
            >
              <option value="auto">Automatique</option>
              <option value="manual">Manuel</option>
            </select>
            {routingMode === 'manual' && (
              <>
                <select
                  aria-label="Fournisseur préféré"
                  value={routingProvider}
                  onChange={(event) => {
                    setRoutingProvider(event.target.value);
                    setRoutingModel('');
                  }}
                  className="rounded-lg border border-white/10 bg-[#0c111b] px-3 py-2 text-xs text-white"
                >
                  <option value="">Fournisseur…</option>
                  {(configurableProviders.length > 0
                    ? configurableProviders
                    : BUSINESS_PROVIDERS.filter((p) => p.id !== 'muapi').map((p) => ({
                        provider_key: p.id,
                        display_name: p.name,
                      }))
                  ).map((provider) => (
                    <option key={provider.provider_key} value={provider.provider_key}>
                      {provider.display_name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Modèle préféré"
                  value={routingModel}
                  onChange={(event) => setRoutingModel(event.target.value)}
                  className="max-w-[240px] truncate rounded-lg border border-white/10 bg-[#0c111b] px-3 py-2 text-xs text-white"
                >
                  <option value="">Modèle par défaut</option>
                  {modelsForSelectedProvider.map((model) => (
                    <option key={`${model.provider_key}:${model.model_key}`} value={model.model_key}>
                      {model.display_name}
                    </option>
                  ))}
                </select>
                <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-[#0c111b] px-2.5 py-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={routingAllowFallback}
                    onChange={(event) => setRoutingAllowFallback(event.target.checked)}
                    aria-label="Autoriser le secours automatique"
                    className="accent-brand-400"
                  />
                  <span>Secours auto</span>
                </label>
              </>
            )}
            <Button
              size="sm"
              onClick={() => {
                void onSaveRouting({
                  roleKey: routingRole,
                  selectionMode: routingMode,
                  preferredProviderKey: routingMode === 'manual' && routingProvider.trim() ? routingProvider.trim() : null,
                  preferredModelKey: routingMode === 'manual' && routingModel.trim() ? routingModel.trim() : null,
                  allowFallback: routingMode === 'auto' ? true : routingAllowFallback,
                });
              }}
            >
              Enregistrer la règle
            </Button>
          </div>
          {savedRouting.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5" data-testid="saved-routing-rules">
              {savedRouting.map((pref) => (
                <span key={String(pref.role_key)} className="rounded-lg border border-white/[0.08] bg-black/20 px-2.5 py-1 text-[11px] text-slate-300">
                  {String(pref.role_key)} : {String(pref.selection_mode)}
                  {pref.preferred_provider_key ? ` · ${String(pref.preferred_provider_key)}` : ''}
                  {pref.preferred_model_key ? ` / ${String(pref.preferred_model_key)}` : ''}
                  {pref.allow_fallback === false ? ' (sans secours)' : ''}
                </span>
              ))}
            </div>
          )}
          {requests.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-300">
                <Activity size={14} className="text-cyan-300" /> Exécutions récentes ({requests.length})
              </div>
              <div className="space-y-1.5 text-[11px]">
                {requests.slice(0, 6).map((req) => (
                  <div key={String(req.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-slate-300">
                    <span>{String(req.role_key ?? req.task_role_key ?? 'business_advisor')} · {String(req.provider_key ?? req.selected_provider_key ?? 'aucun')} / {String(req.model_key ?? req.selected_model_key ?? '—')}</span>
                    <span className="text-slate-500">
                      {String(req.status ?? '')}
                      {req.latency_ms ? ` · ${String(req.latency_ms)} ms` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function IntegrationsView({ connections }: { connections: BusinessIntegrationConnection[] }) {
  const byConnector = new Map(connections.map((conn) => [conn.connector_key, conn]));
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-panel/50 p-5 sm:p-7" data-testid="business-integrations">
      <div className="mb-5 max-w-2xl">
        <h2 className="text-lg font-semibold text-white">Connecteurs métier (planifiés)</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Les contrats d’intégration définissent les autorisations par espace de travail. Aucune connexion ou publication externe n’est simulée.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {INTEGRATION_DEFINITIONS.map((contract: IntegrationDefinition) => {
          const persisted = byConnector.get(contract.id);
          return (
            <article key={contract.id} className="rounded-xl border border-white/[0.07] bg-black/15 p-4" data-testid={`connector-${contract.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-white">{contract.name}</h3>
                  <p className="mt-1 text-[11px] text-slate-500">Authentification : {contract.authorization}</p>
                </div>
                <Badge tone="neutral">{persisted?.status ?? 'Planifié'}</Badge>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Capacités proposées : {contract.proposedCapabilities.join(', ')}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">{contract.note}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default function BusinessGrowWorkspace() {
  const location = useLocation();
  const { user, session, workspace, workspaceId } = useAuth();
  const accountScope = `${user?.id ?? ''}:${workspaceId ?? ''}`;
  const hasSession = Boolean(user && session);
  const sessionToken = session?.access_token ?? null;
  const parsedIntent = useMemo(() => parseBusinessGrowEntryIntent(location.state), [location.state]);
  const [entryIntent, setEntryIntent] = useState<BusinessGrowEntryIntent | null>(null);
  const [section, setSection] = useState<BusinessSection>('chat');
  const [providers, setProviders] = useState<BusinessProviderStatus[] | null>(null);
  const [models, setModels] = useState<BusinessModelRecord[]>([]);
  const [quota, setQuota] = useState<BusinessQuotaStatus | null>(null);
  const [requests, setRequests] = useState<Array<Record<string, unknown>>>([]);
  const [tools, setTools] = useState<BusinessToolExecution[]>([]);
  const [integrations, setIntegrations] = useState<BusinessIntegrationConnection[]>([]);
  const [conversations, setConversations] = useState<BusinessConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BusinessMessage[]>([]);
  const [memory, setMemory] = useState<BusinessMemory | null>(null);
  const [backendReady, setBackendReady] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMemory, setLoadingMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifyingKey, setVerifyingKey] = useState<string | null>(null);
  const [verifyBanner, setVerifyBanner] = useState<VerifyBanner | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [roleKey, setRoleKey] = useState<BusinessRoleKey>('business_advisor');
  const [routingMode, setRoutingMode] = useState<RoutingSelectionMode>('auto');
  const [preferredProviderKey, setPreferredProviderKey] = useState('');
  const [preferredModelKey, setPreferredModelKey] = useState('');
  const [manualAllowFallback, setManualAllowFallback] = useState(false);
  const [savedRouting, setSavedRouting] = useState<Array<Record<string, unknown>>>([]);
  const messageLoadSequence = useRef(0);
  const accountScopeRef = useRef(accountScope);
  const workspaceLoadSequence = useRef(0);
  const conversationLoadSequence = useRef(0);
  const statusLoadSequence = useRef(0);
  const memoryLoadSequence = useRef(0);
  const detailsLoadSequence = useRef(0);

  useEffect(() => {
    if (!parsedIntent) return;
    setEntryIntent(parsedIntent);
    if (parsedIntent.section) setSection(parsedIntent.section);
    if (parsedIntent.roleKey) setRoleKey(parsedIntent.roleKey);
  }, [parsedIntent]);

  useEffect(() => {
    accountScopeRef.current = accountScope;
    workspaceLoadSequence.current += 1;
    conversationLoadSequence.current += 1;
    statusLoadSequence.current += 1;
    memoryLoadSequence.current += 1;
    messageLoadSequence.current += 1;
    detailsLoadSequence.current += 1;
    setProviders(null);
    setModels([]);
    setQuota(null);
    setRequests([]);
    setTools([]);
    setIntegrations([]);
    setSavedRouting([]);
    setConversations([]);
    setSelectedConversationId(null);
    setMessages([]);
    setMemory(null);
    setBackendReady(false);
    setLoadingMessages(false);
    setLoadingMemory(false);
    setBusy(false);
    setVerifyingKey(null);
    setVerifyBanner(null);
    setError(null);
    setMemoryError(null);
  }, [accountScope]);

  const loadConversations = useCallback(async () => {
    const requestId = ++conversationLoadSequence.current;
    const requestScope = accountScope;
    const result = await businessGrowApi.listConversations();
    if (requestId !== conversationLoadSequence.current || accountScopeRef.current !== requestScope) return;
    setConversations(result.conversations);
    setSelectedConversationId((current) =>
      current && result.conversations.some((conversation) => conversation.id === current)
        ? current
        : result.conversations[0]?.id ?? null,
    );
  }, [accountScope]);

  const loadStatus = useCallback(async () => {
    const requestId = ++statusLoadSequence.current;
    const requestScope = accountScope;
    const result = await businessGrowApi.getStatus();
    if (requestId !== statusLoadSequence.current || accountScopeRef.current !== requestScope) return;
    setProviders(result.providers);
  }, [accountScope]);

  const loadOperationalDetails = useCallback(async () => {
    const requestId = ++detailsLoadSequence.current;
    const requestScope = accountScope;
    const [modelsRes, quotaRes, reqRes, integrationsRes, routingRes] = await Promise.allSettled([
      businessGrowApi.listModels?.() ?? Promise.resolve(null),
      businessGrowApi.getQuota?.() ?? Promise.resolve(null),
      businessGrowApi.listRequests?.() ?? Promise.resolve(null),
      businessGrowApi.listIntegrations?.() ?? Promise.resolve(null),
      businessGrowApi.getRouting?.() ?? Promise.resolve(null),
    ]);
    if (requestId !== detailsLoadSequence.current || accountScopeRef.current !== requestScope) return;
    if (modelsRes.status === 'fulfilled' && modelsRes.value) setModels(modelsRes.value.models);
    if (quotaRes.status === 'fulfilled' && quotaRes.value) setQuota(quotaRes.value);
    if (reqRes.status === 'fulfilled' && reqRes.value) setRequests(reqRes.value.requests);
    if (integrationsRes.status === 'fulfilled' && integrationsRes.value) setIntegrations(integrationsRes.value.connections);
    if (routingRes.status === 'fulfilled' && routingRes.value && Array.isArray(routingRes.value.preferences)) {
      setSavedRouting(routingRes.value.preferences);
    }
  }, [accountScope]);

  const refreshWorkspace = useCallback(async () => {
    const requestId = ++workspaceLoadSequence.current;
    const requestScope = accountScope;
    if (!hasSession) {
      setBackendReady(false);
      setProviders(null);
      setConversations([]);
      setSelectedConversationId(null);
      setMessages([]);
      setError('Session Reelora indisponible. Reconnectez-vous pour charger Business Grow.');
      return;
    }
    setBackendReady(false);
    setError(null);
    const [statusResult, conversationsResult] = await Promise.allSettled([loadStatus(), loadConversations()]);
    if (requestId !== workspaceLoadSequence.current || accountScopeRef.current !== requestScope) return;
    if (statusResult.status === 'fulfilled' && conversationsResult.status === 'fulfilled') {
      setBackendReady(true);
      void loadOperationalDetails();
      return;
    }
    setBackendReady(false);
    setError(statusResult.status === 'rejected'
      ? statusResult.reason instanceof Error ? statusResult.reason.message : 'Le registre IA est indisponible.'
      : conversationsResult.status === 'rejected' && conversationsResult.reason instanceof Error
        ? conversationsResult.reason.message
        : 'Le backend Business Grow n’est pas encore installé ou accessible.');
  }, [accountScope, hasSession, loadConversations, loadOperationalDetails, loadStatus, sessionToken]);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  const loadMessages = useCallback(async () => {
    const sequence = ++messageLoadSequence.current;
    const requestScope = accountScope;
    if (!selectedConversationId || !backendReady) {
      setMessages([]);
      setTools([]);
      setLoadingMessages(false);
      return;
    }
    setLoadingMessages(true);
    try {
      const [result, toolsResult] = await Promise.all([
        businessGrowApi.listMessages(selectedConversationId),
        businessGrowApi.listTools?.(selectedConversationId).catch(() => null) ?? Promise.resolve(null),
      ]);
      if (messageLoadSequence.current === sequence && accountScopeRef.current === requestScope) {
        setMessages(result.messages);
        if (toolsResult) setTools(toolsResult.tools);
        setError(null);
      }
    } catch (loadError) {
      if (messageLoadSequence.current === sequence && accountScopeRef.current === requestScope) {
        setError(loadError instanceof Error ? loadError.message : 'Impossible de charger les messages.');
      }
    } finally {
      if (messageLoadSequence.current === sequence && accountScopeRef.current === requestScope) setLoadingMessages(false);
    }
  }, [accountScope, backendReady, selectedConversationId]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  const loadMemory = useCallback(async () => {
    const requestId = ++memoryLoadSequence.current;
    const requestScope = accountScope;
    setLoadingMemory(true);
    setMemoryError(null);
    try {
      const result = await businessGrowApi.getMemory();
      if (requestId === memoryLoadSequence.current && accountScopeRef.current === requestScope) setMemory(result);
    } catch (loadError) {
      if (requestId === memoryLoadSequence.current && accountScopeRef.current === requestScope) {
        setMemoryError(loadError instanceof Error ? loadError.message : 'Impossible de charger la mémoire.');
      }
    } finally {
      if (requestId === memoryLoadSequence.current && accountScopeRef.current === requestScope) setLoadingMemory(false);
    }
  }, [accountScope]);

  useEffect(() => {
    if (section === 'memory' && backendReady) void loadMemory();
  }, [backendReady, loadMemory, section]);

  const createConversation = useCallback(async () => {
    const requestScope = accountScope;
    setBusy(true);
    setError(null);
    try {
      const result = await businessGrowApi.createConversation('Nouvelle conversation', workspaceId);
      if (accountScopeRef.current !== requestScope) return;
      await loadConversations();
      if (accountScopeRef.current !== requestScope) return;
      setSelectedConversationId(result.conversationId);
      setMessages([]);
      setTools([]);
    } catch (createError) {
      if (accountScopeRef.current === requestScope) {
        setError(createError instanceof Error ? createError.message : 'Impossible de créer la conversation.');
      }
    } finally {
      if (accountScopeRef.current === requestScope) setBusy(false);
    }
  }, [accountScope, loadConversations, workspaceId]);

  const renameConversation = useCallback(async (conversationId: string, title: string): Promise<boolean> => {
    const requestScope = accountScope;
    setError(null);
    try {
      await businessGrowApi.renameConversation(conversationId, title);
      if (accountScopeRef.current !== requestScope) return false;
      await loadConversations();
      if (accountScopeRef.current !== requestScope) return false;
      return true;
    } catch (renameError) {
      if (accountScopeRef.current === requestScope) {
        setError(renameError instanceof Error ? renameError.message : 'Impossible de renommer la conversation.');
      }
      return false;
    }
  }, [accountScope, loadConversations]);

  const deleteConversation = useCallback(async (conversationId: string): Promise<boolean> => {
    const requestScope = accountScope;
    setError(null);
    try {
      await businessGrowApi.deleteConversation(conversationId);
      if (accountScopeRef.current !== requestScope) return false;
      if (selectedConversationId === conversationId) {
        setSelectedConversationId(null);
        setMessages([]);
        setTools([]);
      }
      await loadConversations();
      if (accountScopeRef.current !== requestScope) return false;
      return true;
    } catch (deleteError) {
      if (accountScopeRef.current === requestScope) {
        setError(deleteError instanceof Error ? deleteError.message : 'Impossible de supprimer la conversation.');
      }
      return false;
    }
  }, [accountScope, loadConversations, selectedConversationId]);

  const sendMessage = useCallback(async (content: string): Promise<boolean> => {
    const requestScope = accountScope;
    setError(null);
    setBusy(true);
    let conversationId = selectedConversationId;
    try {
      if (!conversationId) {
        const result = await businessGrowApi.createConversation('Nouvelle conversation', workspaceId);
        if (accountScopeRef.current !== requestScope) return false;
        conversationId = result.conversationId;
        setSelectedConversationId(conversationId);
      }
      const hasSavedManualOverride = savedRouting.some(
        (pref) => pref.role_key === roleKey && pref.selection_mode === 'manual',
      );
      const sendOptions: BusinessSendOptions | undefined =
        roleKey === 'business_advisor' && routingMode === 'auto' && !workspaceId && !hasSavedManualOverride
          ? undefined
          : {
            roleKey,
            ...(workspaceId ? { workspaceId } : {}),
            ...(routingMode === 'manual'
              ? {
                routing: {
                  selectionMode: 'manual',
                  preferredProviderKey: preferredProviderKey || null,
                  preferredModelKey: preferredModelKey || null,
                  allowFallback: manualAllowFallback,
                },
              }
              : {
                routing: {
                  selectionMode: 'auto',
                  allowFallback: true,
                },
              }),
          };
      if (sendOptions) {
        await businessGrowApi.sendMessage(conversationId, content, crypto.randomUUID(), sendOptions);
      } else {
        await businessGrowApi.sendMessage(conversationId, content, crypto.randomUUID());
      }
      if (accountScopeRef.current !== requestScope) return false;
      await Promise.all([
        loadConversations(),
        businessGrowApi.listMessages(conversationId).then((result) => {
          if (accountScopeRef.current === requestScope) setMessages(result.messages);
        }),
        businessGrowApi.listTools?.(conversationId).then((res) => {
          if (accountScopeRef.current === requestScope && res) setTools(res.tools);
        }).catch(() => undefined),
        loadOperationalDetails(),
      ]);
      return accountScopeRef.current === requestScope;
    } catch (sendError) {
      if (accountScopeRef.current !== requestScope) return false;
      const code = sendError instanceof BusinessGrowApiError
        ? sendError.code
        : typeof sendError === 'object' && sendError !== null && 'code' in sendError && typeof sendError.code === 'string'
          ? sendError.code
          : null;
      if (code && [
        'NO_VERIFIED_PROVIDER',
        'PROVIDER_NOT_CONFIGURED',
        'PROVIDER_ADAPTER_NOT_IMPLEMENTED',
        'PROVIDER_MODEL_MISMATCH',
        'PROVIDER_AUTH_FAILED',
        'PROVIDER_RATE_LIMITED',
        'PROVIDER_UNAVAILABLE',
        'PROVIDER_TIMEOUT',
        'PROVIDER_NETWORK_ERROR',
        'PROVIDER_REQUEST_REJECTED',
        'PROVIDER_INVALID_RESPONSE',
        'PROVIDER_EMPTY_RESPONSE',
        'BG_INSUFFICIENT_QUOTA',
      ].includes(code)) {
        setError(sendError instanceof Error ? sendError.message : 'Aucun fournisseur IA vérifié n’est disponible.');
        await Promise.allSettled([
          loadConversations(),
          conversationId
            ? businessGrowApi.listMessages(conversationId).then((result) => {
              if (accountScopeRef.current === requestScope) setMessages(result.messages);
            })
            : Promise.resolve(),
        ]);
        return true;
      }
      setError(sendError instanceof Error ? sendError.message : 'Impossible d’envoyer la demande.');
      return false;
    } finally {
      if (accountScopeRef.current === requestScope) setBusy(false);
    }
  }, [accountScope, loadConversations, loadOperationalDetails, manualAllowFallback, preferredModelKey, preferredProviderKey, roleKey, routingMode, savedRouting, selectedConversationId, workspaceId]);

  const resolveTool = useCallback(async (executionId: string, decision: 'approved' | 'rejected') => {
    const requestScope = accountScope;
    if (!businessGrowApi.resolveTool) return;
    setBusy(true);
    setError(null);
    try {
      await businessGrowApi.resolveTool(executionId, decision);
      if (accountScopeRef.current !== requestScope) return;
      if (selectedConversationId && businessGrowApi.listTools) {
        const res = await businessGrowApi.listTools(selectedConversationId);
        if (accountScopeRef.current === requestScope) setTools(res.tools);
      }
    } catch (resolveError) {
      if (accountScopeRef.current === requestScope) {
        setError(resolveError instanceof Error ? resolveError.message : 'Impossible de traiter cette action.');
      }
    } finally {
      if (accountScopeRef.current === requestScope) setBusy(false);
    }
  }, [accountScope, selectedConversationId]);

  const verifyProvider = useCallback(async (providerKey: string, modelKey?: string) => {
    const requestScope = accountScope;
    if (!businessGrowApi.verifyProvider) return;
    setVerifyingKey(providerKey);
    setVerifyBanner(null);
    try {
      const result: BusinessVerificationResult = modelKey
        ? await businessGrowApi.verifyProvider(providerKey, modelKey)
        : await businessGrowApi.verifyProvider(providerKey);
      if (accountScopeRef.current !== requestScope) return;
      const discoveredCount = Array.isArray(result.availableModels) ? result.availableModels.length : 0;
      setVerifyBanner({
        tone: 'success',
        message: `Test serveur réel : ${result.providerKey} (${result.modelKey}) vérifié avec succès (${result.latencyMs} ms).`,
        hint: discoveredCount > 0 ? `${discoveredCount} modèle(s) détecté(s) sur l’API du fournisseur.` : null,
      });
      await Promise.allSettled([loadStatus(), loadOperationalDetails()]);
    } catch (verifyError) {
      if (accountScopeRef.current === requestScope) {
        const errorCode = verifyError instanceof BusinessGrowApiError ? verifyError.code : null;
        setVerifyBanner({
          tone: 'error',
          code: errorCode,
          message: verifyError instanceof Error ? verifyError.message : 'La vérification du fournisseur a échoué.',
          hint: describeProviderFailureHint(errorCode),
        });
        await Promise.allSettled([loadStatus(), loadOperationalDetails()]);
      }
    } finally {
      if (accountScopeRef.current === requestScope) setVerifyingKey(null);
    }
  }, [accountScope, loadOperationalDetails, loadStatus]);

  const saveRouting = useCallback(async (pref: BusinessRoutingPreference) => {
    const requestScope = accountScope;
    if (!businessGrowApi.saveRouting) return;
    setVerifyBanner(null);
    try {
      await businessGrowApi.saveRouting(pref);
      if (accountScopeRef.current === requestScope) {
        setVerifyBanner({
          tone: 'success',
          message: `Règle de routage enregistrée pour ${pref.roleKey}.`,
        });
        void loadOperationalDetails();
      }
    } catch (saveError) {
      if (accountScopeRef.current === requestScope) {
        const errorCode = saveError instanceof BusinessGrowApiError ? saveError.code : null;
        setVerifyBanner({
          tone: 'error',
          code: errorCode,
          message: saveError instanceof Error ? saveError.message : 'Impossible d’enregistrer le routage.',
          hint: describeProviderFailureHint(errorCode),
        });
      }
    }
  }, [accountScope, loadOperationalDetails]);

  const handleChangeRole = useCallback((nextRole: BusinessRoleKey) => {
    setRoleKey(nextRole);
    const saved = savedRouting.find((pref) => pref.role_key === nextRole);
    if (saved) {
      const nextMode: RoutingSelectionMode = saved.selection_mode === 'manual' ? 'manual' : 'auto';
      setRoutingMode(nextMode);
      setPreferredProviderKey(typeof saved.preferred_provider_key === 'string' ? saved.preferred_provider_key : '');
      setPreferredModelKey(typeof saved.preferred_model_key === 'string' ? saved.preferred_model_key : '');
      setManualAllowFallback(typeof saved.allow_fallback === 'boolean' ? saved.allow_fallback : false);
    }
  }, [savedRouting]);

  const handleChangePreferredProvider = useCallback((nextProvider: string) => {
    setPreferredProviderKey(nextProvider);
    setPreferredModelKey('');
  }, []);

  const saveMemoryConsent = useCallback(async (enabled: boolean) => {
    const requestScope = accountScope;
    setBusy(true);
    setMemoryError(null);
    try {
      await businessGrowApi.setMemoryConsent(enabled);
      if (accountScopeRef.current !== requestScope) return;
      await loadMemory();
    } catch (consentError) {
      if (accountScopeRef.current === requestScope) {
        setMemoryError(consentError instanceof Error ? consentError.message : 'Impossible de modifier le consentement.');
      }
    } finally {
      if (accountScopeRef.current === requestScope) setBusy(false);
    }
  }, [accountScope, loadMemory]);

  const saveMemoryProfile = useCallback(async (profile: Record<string, unknown>) => {
    const requestScope = accountScope;
    setBusy(true);
    setMemoryError(null);
    try {
      await businessGrowApi.saveMemoryProfile(profile);
      if (accountScopeRef.current !== requestScope) return;
      await loadMemory();
    } catch (saveError) {
      if (accountScopeRef.current === requestScope) {
        setMemoryError(saveError instanceof Error ? saveError.message : 'Impossible d’enregistrer le profil.');
      }
    } finally {
      if (accountScopeRef.current === requestScope) setBusy(false);
    }
  }, [accountScope, loadMemory]);

  const mutateMemoryItem = useCallback(async (operation: () => Promise<unknown>) => {
    const requestScope = accountScope;
    setBusy(true);
    setMemoryError(null);
    try {
      await operation();
      if (accountScopeRef.current !== requestScope) return;
      await loadMemory();
    } catch (itemError) {
      if (accountScopeRef.current === requestScope) {
        setMemoryError(itemError instanceof Error ? itemError.message : 'Impossible de modifier la mémoire.');
      }
    } finally {
      if (accountScopeRef.current === requestScope) setBusy(false);
    }
  }, [accountScope, loadMemory]);

  const activeSection = useMemo(() => SECTIONS.find((item) => item.id === section) ?? SECTIONS[0], [section]);
  const ActiveIcon = activeSection.icon;
  const availableProviderCount = (providers ?? []).filter((provider) => isVerifiedProvider(provider)).length;

  return (
    <div className="animate-fadeUp space-y-5" data-testid="business-grow">
      <header className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0b0d18] px-5 py-6 sm:px-7">
        <div aria-hidden="true" className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-brand-500/20 blur-[90px]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-28 right-0 h-56 w-56 rounded-full bg-cyan-400/10 blur-[90px]" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-200">
              <Brain size={14} /> Reelora · Business Grow
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Votre copilote business</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
              Votre espace métier intégré à Reelora, avec le même compte et les mêmes droits que le Studio UGC.
            </p>
          </div>
          <span
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium',
              availableProviderCount
                ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100'
                : 'border-amber-400/20 bg-amber-400/[0.06] text-amber-100',
            )}
            data-testid="business-overall-status"
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', availableProviderCount ? 'bg-emerald-300' : 'bg-amber-300')} />
            {availableProviderCount ? `${availableProviderCount} fournisseur(s) vérifié(s)` : backendReady ? 'IA non disponible' : 'Backend en attente'}
          </span>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Navigation Business Grow" className="flex gap-2 overflow-x-auto rounded-2xl border border-white/[0.07] bg-panel/40 p-2 lg:flex-col lg:self-start">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              aria-current={section === id ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition',
                section === id ? 'bg-brand-500/15 text-brand-100' : 'text-slate-400 hover:bg-white/[0.04] hover:text-white',
              )}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
          <div className="hidden border-t border-white/[0.07] px-2 pt-3 lg:block">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-600">Historique</p>
            <p className="text-xs leading-relaxed text-slate-500">{conversations.length} conversation(s) dans Reelora.</p>
          </div>
        </nav>

        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <ActiveIcon size={14} className="text-brand-300" /> {activeSection.label}
          </div>
          {section === 'chat' && (
            <AssistantView
              backendReady={backendReady}
              providers={providers}
              models={models}
              quota={quota}
              tools={tools}
              conversations={conversations}
              selectedConversationId={selectedConversationId}
              messages={messages}
              loading={loadingMessages}
              error={error}
              busy={busy}
              roleKey={roleKey}
              routingMode={routingMode}
              preferredProviderKey={preferredProviderKey}
              preferredModelKey={preferredModelKey}
              manualAllowFallback={manualAllowFallback}
              entryIntent={entryIntent}
              onChangeRole={handleChangeRole}
              onChangeRoutingMode={setRoutingMode}
              onChangePreferredProvider={handleChangePreferredProvider}
              onChangePreferredModel={setPreferredModelKey}
              onChangeManualAllowFallback={setManualAllowFallback}
              onDismissEntryIntent={() => setEntryIntent(null)}
              onResolveTool={resolveTool}
              onNewConversation={() => { void createConversation(); }}
              onRenameConversation={renameConversation}
              onDeleteConversation={deleteConversation}
              onSelectConversation={setSelectedConversationId}
              onSend={sendMessage}
              onRetry={() => { void refreshWorkspace(); void loadMessages(); }}
            />
          )}
          {section === 'company' && <CompanyContextView workspace={workspace} />}
          {section === 'memory' && (
            <MemoryView
              memory={memory}
              loading={loadingMemory}
              busy={busy}
              error={memoryError}
              onConsent={saveMemoryConsent}
              onSaveProfile={saveMemoryProfile}
              onPutItem={(category, content) => mutateMemoryItem(() => businessGrowApi.putMemoryItem(category, content))}
              onDeleteItem={(id) => mutateMemoryItem(() => businessGrowApi.deleteMemoryItem(id))}
              onRetry={() => { void loadMemory(); }}
            />
          )}
          {section === 'providers' && (
            <ProvidersView
              backendReady={backendReady}
              statuses={providers}
              models={models}
              requests={requests}
              savedRouting={savedRouting}
              quota={quota}
              verifyingKey={verifyingKey}
              verifyBanner={verifyBanner}
              onVerifyProvider={verifyProvider}
              onSaveRouting={saveRouting}
            />
          )}
          {section === 'integrations' && <IntegrationsView connections={integrations} />}
        </div>
      </div>
    </div>
  );
}
