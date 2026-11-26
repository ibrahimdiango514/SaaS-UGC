import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, ArrowUpRight, Brain, Building2, ExternalLink, FileText, Gauge, Lightbulb,
  MessageSquare, Package, Pencil, RefreshCw, ShieldCheck, SlidersHorizontal, Sparkles, TrendingUp, Trash2, Zap,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, LoadingState, Toggle, cn } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { listBrands, listProducts } from '../lib/api';
import { asAppError, humanizeError } from '../lib/errors';
import {
  buildStudioLocationStateFromBrief,
  parseBusinessGrowEntryIntent,
  type BusinessGrowEntryIntent,
} from '../contracts/business-grow';
import CrmWorkspace from './crm/CrmWorkspace';
import FinanceWorkspace from './finance/FinanceWorkspace';
import SalesWorkspace from './sales/SalesWorkspace';
import CatalogWorkspace from './catalog/CatalogWorkspace';
import CashWorkspace from './cash/CashWorkspace';
import AutomationWorkspace from './automation/AutomationWorkspace';
import MarketingWorkspace from './marketing/MarketingWorkspace';
import SuppliersWorkspace from './suppliers/SuppliersWorkspace';
import StorefrontWorkspace from './storefront/StorefrontWorkspace';
import { IntegrationsCenter, type SubscriptionRefusal } from '../integrations/CatalogPage';
import { GrowthOsLayout } from './os/GrowthOsLayout';
import { GrowthOsOverview, GrowthOsReports } from './os/GrowthOsOverview';
import { BriefingDuJour } from './os/BriefingDuJour';
import { HistoriqueAgent } from './agent/HistoriqueAgent';
import { LitigesWorkspace } from './finance/LitigesWorkspace';
import { RecouvrementWorkspace } from './finance/RecouvrementWorkspace';
import { RentabiliteWorkspace } from './catalog/RentabiliteWorkspace';
import { growthOsModule, growthOsModuleFromPath, legacyGrowthOsPath, type GrowthOsModule } from './os/modules';
import { readProspects } from './growth/model';
import AgentReports from './agent/AgentReports';
import { BusinessAssistant } from '../ai/BusinessAssistant';
import type { Brand, Product, Workspace } from '../lib/types';
import {
  BusinessGrowApiError, businessGrowApi, subscriptionRefusalOf,
  type BusinessAgentMemory, type BusinessConversation, type BusinessIntegrationConnection, type BusinessMemory,
  type BusinessMessage, type BusinessModelRecord, type BusinessProviderStatus,
  type BusinessQuotaStatus, type BusinessRoutingPreference, type BusinessSendOptions,
  type BusinessToolExecution, type BusinessVerificationResult, type BusinessRecommendation, type BusinessReport,
} from './api';
import {
  BUSINESS_ROLES, capabilitiesOf,
  type BusinessRoleKey, type RoutingSelectionMode,
} from './ai/registry';

const AGENT_MEMORY_CATEGORY_LABELS: Record<string, string> = {
  company: 'Entreprise',
  user: 'Préférences',
  decision: 'Décision',
  conversation: 'Conversation',
  domain: 'Domaine',
  operational: 'Opérations',
  document: 'Document',
};

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
          <p className="text-xs font-medium uppercase tracking-wide text-brand-200">Compte SORAHNEX partagé</p>
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
          description="Reconnectez-vous à SORAHNEX ou réessayez le chargement de votre espace."
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
              <EmptyState icon={<Building2 size={20} />} title="Aucune marque enregistrée" description="Ajoutez les marques de votre entreprise depuis les paramètres SORAHNEX." />
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
              <EmptyState icon={<Package size={20} />} title="Aucun produit enregistré" description="Ajoutez vos produits ou services depuis les paramètres SORAHNEX." />
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
        <p className="text-xs text-slate-400">
          Ces données proviennent de l’espace SORAHNEX partagé. Elles ne sont pas copiées dans la mémoire IA.
        </p>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void load()} disabled={loading || !workspace}>
          Actualiser
        </Button>
      </div>
    </section>
  );
}

const PROMPT_IDEAS = [
  { label: 'Factures à suivre', text: 'Analyse les factures impayées disponibles et priorise les relances. Signale les données manquantes.', icon: FileText, categories: ['bg_module_payment_recovery'] },
  { label: 'Prospects à relancer', text: 'Quels prospects ou leads nécessitent un suivi ? Appuie-toi seulement sur les données enregistrées.', icon: Lightbulb, categories: ['growth_prospect', 'bg_module_lead_rescue'] },
  { label: 'Paniers en attente', text: 'Examine les paniers ou commandes en attente et propose des suivis sans envoyer de message.', icon: Package, categories: ['bg_module_order_cart_recovery'] },
  { label: 'Clients à réactiver', text: 'Analyse les clients à risque et les demandes support disponibles, sans inventer de chiffres.', icon: MessageSquare, categories: ['bg_module_customer_recovery', 'bg_module_customer_support_ai'] },
  { label: 'Stock & opérations', text: 'Quels stocks et tâches opérationnelles demandent mon attention ? Précise les données manquantes.', icon: Activity, categories: ['bg_module_smart_inventory', 'bg_module_operations_manager'] },
  { label: 'Situation financière', text: 'Analyse les mouvements financiers disponibles sur les 30 derniers jours, en séparant faits et limites.', icon: TrendingUp, categories: ['bg_module_finance_intelligence'] },
];


const TOOL_LABELS: Record<string, string> = {
  propose_memory_save: 'Enregistrer dans la mémoire métier',
  propose_action_plan: 'Structurer un plan d’action',
  propose_campaign_brief: 'Créer un brief campagne marketing',
  handoff_ugc_brief: 'Transférer vers Studio UGC',
  request_connector_read: 'Demander une lecture connecteur',
  create_follow_up_task: 'Créer une tâche dans Operations Manager',
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

/** Fenêtre réelle de validité d'un contrôle fournisseur côté SQL : 24 h. */
const PROVIDER_HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Sélectionne les fournisseurs réellement configurés côté serveur dont le
 * dernier contrôle date de plus de 24 h (ou n'existe pas). Ce sont exactement
 * ceux qui font échouer `messages.send` en `NO_VERIFIED_PROVIDER`.
 */
export function providersNeedingVerification(
  statuses: BusinessProviderStatus[] | null,
  now = Date.now(),
): BusinessProviderStatus[] {
  return (statuses ?? []).filter((provider) => {
    if (provider.provider_key === 'muapi') return false;
    if (provider.config_status !== 'configured') return false;
    if (!provider.checked_at) return true;
    const checked = Date.parse(provider.checked_at);
    return !Number.isFinite(checked) || now - checked > PROVIDER_HEALTH_WINDOW_MS;
  });
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
      return 'La vérification du service IA a échoué. Contactez le support SORAHNEX si le problème persiste.';
    case 'PROVIDER_RATE_LIMITED':
      return 'Le service IA est temporairement saturé. Réessayez plus tard.';
    case 'PROVIDER_PAYMENT_REQUIRED':
      return 'Le crédit du service IA est épuisé. Réessayez plus tard ou contactez le support SORAHNEX.';
    case 'PROVIDER_REQUEST_REJECTED':
      return 'La demande n’a pas été acceptée. Vérifiez votre message puis réessayez.';
    case 'PROVIDER_NOT_CONFIGURED':
      return 'Le service IA est indisponible pour le moment.';
    case 'PROVIDER_TIMEOUT':
    case 'PROVIDER_NETWORK_ERROR':
    case 'PROVIDER_UNAVAILABLE':
      return 'Le service IA ne répond pas pour le moment. Réessayez plus tard.';
    case 'ORIGIN_NOT_ALLOWED':
      return 'Cette connexion n’est pas disponible depuis cet environnement. Réessayez plus tard.';
    case 'BUSINESS_GROW_UNAVAILABLE':
      return 'SORAHNEX Grow est momentanément indisponible. Réessayez plus tard.';
    default:
      return 'Réessayez plus tard ou contactez le support SORAHNEX.';
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
      description: 'Une configuration existe, mais aucun test réussi ne confirme encore sa disponibilité.',
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
      description: `Dernier test dégradé${codePart}. ${describeProviderFailureHint(provider.error_code)}`,
    };
  }
  if (provider.status === 'unavailable' || provider.error_code) {
    const codePart = provider.error_code ? ` (${provider.error_code})` : '';
    return {
      label: 'Échec vérification',
      tone: 'danger',
      description: `Le dernier test a échoué${codePart}. ${describeProviderFailureHint(provider.error_code)}`,
    };
  }
  return {
    label: 'Configuré · Non vérifié',
    tone: 'warning',
    description: 'Le modèle configuré doit réussir un test serveur réel pour être routable.',
  };
}

function ProviderStatusList({ statuses, compact: _compact = false, loading = false }: {
  statuses: BusinessProviderStatus[] | null;
  compact?: boolean;
  loading?: boolean;
}) {
  // La liste vient du service (registre serveur), jamais d'un catalogue figé
  // côté navigateur : un fournisseur ajouté côté serveur apparaît ici seul.
  const providers = statuses ?? [];
  const activeCount = providers.filter((status) => isVerifiedProvider(status)).length;

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-200">Assistant IA SORAHNEX</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
          {loading
            ? 'Le contrôle de disponibilité est en cours.'
            : statuses === null
              ? 'Impossible de vérifier les services IA pour le moment.'
              : activeCount > 0
                ? 'Les services IA sont disponibles.'
                : 'Aucun service IA vérifié pour le moment.'}
        </p>
      </div>
      <Badge tone={!loading && activeCount > 0 ? 'success' : 'warning'}>
        {loading ? 'Vérification…' : statuses === null ? 'Statut inconnu' : activeCount > 0 ? 'Disponible' : 'Non vérifié'}
      </Badge>
    </div>
  );
}

/**
 * Section « Assistant » de SORAHNEX Grow.
 *
 * L'ancienne interface de conversation (fil brut, liste latérale ad hoc,
 * composeur minimal) a été remplacée par le composant SORAHNEX AI commun
 * (`BusinessAssistant`), qui fournit la sidebar repliable, les bulles, les
 * pièces jointes, le mode analyse et la synthèse vocale.
 *
 * Ce qui a été conservé volontairement :
 *   - l'AI Director et le routage : les sélecteurs rôle/routage/service
 *     restent au-dessus du fil, et pilotent le même envoi serveur ;
 *   - le quota, le statut des services IA et l'avertissement données privées,
 *     dans une barre latérale droite ;
 *   - les propositions d'outils (approbation séparée, transfert Studio UGC) ;
 *   - les rapports de l'agent et le pré-remplissage du composeur.
 *
 * Rien de tout cela n'est réimplémenté ici : ce sont les mêmes rappels et les
 * mêmes données que la page hôte fournit déjà.
 */
function AssistantView({
  workspaceId,
  backendReady,
  backendLoading,
  providers,
  models,
  quota,
  tools,
  conversations,
  conversationsLoaded,
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
  onProposeTask,
  onNewConversation,
  onRenameConversation,
  onDeleteConversation,
  onSelectConversation,
  onSend,
  onRetry,
  draftFromReport,
  onDraftConsumed,
  onReportDraft,
  onOpenIntegrations,
}: {
  workspaceId: string | null;
  backendReady: boolean;
  backendLoading: boolean;
  providers: BusinessProviderStatus[] | null;
  models: BusinessModelRecord[];
  quota: BusinessQuotaStatus | null;
  tools: BusinessToolExecution[];
  conversations: BusinessConversation[];
  conversationsLoaded: boolean;
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
  onProposeTask: (finding: BusinessRecommendation) => Promise<boolean>;
  onNewConversation: () => void;
  onRenameConversation: (id: string, title: string) => Promise<boolean>;
  onDeleteConversation: (id: string) => Promise<boolean>;
  onSelectConversation: (id: string) => void;
  /** Envoi réel : `body` contient déjà le mode et les pièces jointes. */
  onSend: (body: string) => Promise<boolean>;
  onRetry: () => void;
  /** Texte proposé par un rapport d'agent, transmis au composeur. */
  draftFromReport: string | null;
  onDraftConsumed: () => void;
  onReportDraft: (text: string) => void;
  onOpenIntegrations: () => void;
}) {
  const [contextReport, setContextReport] = useState<BusinessReport | null>(null);
  const availableProviders = (providers ?? []).filter((provider) => isVerifiedProvider(provider));
  const verifiedModels = models.filter((model) => model.verification_status === 'verified' && model.enabled);
  const pendingTools = tools.filter((tool) => tool.status === 'pending_approval');
  const executedHandoffs = tools.filter((tool) => tool.tool_name === 'handoff_ugc_brief' && tool.status === 'executed');
  const resolvedOtherTools = tools.filter(
    (tool) => tool.tool_name !== 'handoff_ugc_brief' && tool.status !== 'pending_approval',
  );

  return (
    <div className="space-y-3" data-testid="business-assistant-section">
      <div className="min-w-0 space-y-3">
        {/* AI Director : le routage reste visible et pilotable, comme avant.
            Ce bloc n'est pas décoratif — il change réellement le service
            interrogé par le serveur à l'envoi suivant. */}
        <section className="rounded-[1.1rem] border border-white/[0.08] bg-white/[0.02] px-3 py-2.5" aria-label="AI Director">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-violet-200">
              <Sparkles size={12} />
              AI Director
            </span>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span>Rôle</span>
              <select
                aria-label="Rôle de la tâche IA"
                value={roleKey}
                onChange={(event) => onChangeRole(event.target.value as BusinessRoleKey)}
                className="min-h-11 rounded-lg border border-white/10 bg-[#0c111b] px-2 text-xs text-slate-200 outline-none focus:border-violet-300/40 sm:min-h-8"
              >
                {BUSINESS_ROLES.map((role) => (
                  <option key={role.roleKey} value={role.roleKey}>{role.label}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span>Routage</span>
              <select
                aria-label="Mode de routage"
                value={routingMode}
                onChange={(event) => onChangeRoutingMode(event.target.value as RoutingSelectionMode)}
                className="min-h-11 rounded-lg border border-white/10 bg-[#0c111b] px-2 text-xs text-slate-200 outline-none focus:border-violet-300/40 sm:min-h-8"
              >
                <option value="auto">Automatique</option>
                <option value="manual">Manuel</option>
              </select>
            </label>
            {routingMode === 'manual' && (
              <>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <span>Service</span>
                  <select
                    aria-label="Service IA manuel"
                    value={preferredProviderKey}
                    onChange={(event) => onChangePreferredProvider(event.target.value)}
                    className="max-w-[9rem] rounded-lg border border-white/10 bg-[#0c111b] px-2 py-1 text-xs text-slate-200 outline-none focus:border-violet-300/40"
                  >
                    <option value="">Sélectionner…</option>
                    {availableProviders.map((provider) => (
                      <option key={provider.provider_key} value={provider.provider_key}>{provider.provider_key}</option>
                    ))}
                  </select>
                </label>
                {verifiedModels.length > 0 && (
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                    <span>Modèle</span>
                    <select
                      aria-label="Modèle manuel"
                      value={preferredModelKey}
                      onChange={(event) => onChangePreferredModel(event.target.value)}
                      className="max-w-[10rem] rounded-lg border border-white/10 bg-[#0c111b] px-2 py-1 text-xs text-slate-200 outline-none focus:border-violet-300/40"
                    >
                      <option value="">Modèle par défaut</option>
                      {verifiedModels
                        .filter((m) => !preferredProviderKey || m.provider_key === preferredProviderKey)
                        .map((model, index) => (
                          <option key={`${model.provider_key}:${model.model_key}`} value={model.model_key}>{`Modèle SORAHNEX ${index + 1}`}</option>
                        ))}
                    </select>
                  </label>
                )}
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <span>Secours auto</span>
                  <input
                    type="checkbox"
                    aria-label="Autoriser le secours automatique en mode manuel"
                    checked={manualAllowFallback}
                    onChange={(event) => onChangeManualAllowFallback(event.target.checked)}
                  />
                </label>
              </>
            )}
            <span className="ml-auto flex items-center gap-1 text-[11px] text-slate-500" data-testid="business-quota-pill">
              <Gauge size={12} className="text-cyan-300" />
              {quota ? `${quota.available_units ?? 0} unités` : 'quota indisponible'}
            </span>
          </div>
        </section>

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

        {backendReady && messages.length === 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="business-assistant-ideas">
            {[...PROMPT_IDEAS]
              .sort((a, b) => {
                const couverture = (categories: string[]) =>
                  contextReport?.coverage
                    .filter((item) => categories.includes(item.category) && item.status === 'available')
                    .reduce((sum, item) => sum + item.count, 0) ?? 0;
                return couverture(b.categories) - couverture(a.categories);
              })
              .slice(0, 6)
              .map(({ label, text, icon: Icon }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => onReportDraft(text)}
                  className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-slate-300 transition hover:border-violet-200/25 hover:bg-violet-300/[0.05] hover:text-white"
                >
                  <Icon size={12} className="text-violet-200" />
                  {label}
                </button>
              ))}
          </div>
        )}

        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-xs text-amber-100">
            <span className="flex-1">{error}</span>
            <Button size="sm" variant="ghost" onClick={onRetry}>Réessayer</Button>
          </div>
        )}

        {/* Interface de conversation SORAHNEX AI — remplace l'ancienne.
            L'état et les mutations restent la propriété de SORAHNEX Grow :
            l'interface ne fait qu'afficher et déclencher les mêmes rappels. */}
        <BusinessAssistant
          workspaceId={workspaceId}
          backendReady={backendReady}
          backendLoading={backendLoading}
          providers={providers}
          onOpenIntegrations={onOpenIntegrations}
          draftFromReport={draftFromReport}
          onDraftConsumed={onDraftConsumed}
          host={{
            conversations,
            conversationsLoaded,
            selectedConversationId,
            messages,
            loading,
            busy,
            onSelect: onSelectConversation,
            onNew: onNewConversation,
            onRename: onRenameConversation,
            onDelete: onDeleteConversation,
            onSend: (body) => onSend(body),
          }}
        />

        {/* Rapports de l'agent : inchangés, ils alimentent l'analyse et le
            pré-remplissage du composeur. */}
        <AgentReports
          key={workspaceId ?? 'personal'}
          workspaceId={workspaceId}
          ready={backendReady}
          busy={busy}
          onReport={setContextReport}
          onPropose={onProposeTask}
          onAsk={onReportDraft}
        />

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
                {tool.tool_name === 'create_follow_up_task' && Boolean(tool.input_args?.task) && typeof tool.input_args.task === 'object' && (
                  <div className="mt-2 rounded-lg border border-white/[0.07] bg-black/20 p-2.5 text-[11px] leading-relaxed text-slate-300">
                    <p>Priorité : {String((tool.input_args.task as Record<string, unknown>).priority ?? 'à préciser')} · Échéance : {String((tool.input_args.task as Record<string, unknown>).dueDate ?? 'à préciser')}</p>
                    <p className="mt-1 text-slate-400">La confirmation crée une tâche interne ; aucun message ni action externe ne sera envoyé.</p>
                  </div>
                )}
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => { void onResolveTool(tool.id, 'approved'); }} disabled={busy}>
                    {tool.tool_name === 'create_follow_up_task' ? 'Confirmer la création' : 'Approuver'}
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
                  {tool.tool_name === 'create_follow_up_task' && tool.status === 'executed' && typeof tool.output_result?.taskId === 'string' && (
                    <Link to="/app/business/modules/operations-manager" className="text-violet-200 underline">Voir la tâche</Link>
                  )}
                  <Badge tone={tool.status === 'executed' ? 'success' : 'neutral'}>{statusBadge}</Badge>
                </div>
              );
            })}
          </div>
        )}

        {backendReady && providers !== null && !availableProviders.length && (
          <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 text-xs leading-relaxed text-amber-100/80" role="status">
            Aucun service IA vérifié n’est actuellement disponible. Votre demande sera conservée dans l’historique, mais aucune réponse ne sera simulée.
          </div>
        )}
      </div>

      {/* Barre latérale droite : les informations métier restent visibles à côté
          du fil, comme dans l'ancienne interface. */}
      <aside className="space-y-4">
        <section className="vy-surface p-4">
          <div className="mb-3 flex items-center gap-2">
            <Zap size={15} className="text-cyan-300" />
            <h2 className="text-sm font-semibold text-white">Services IA SORAHNEX</h2>
          </div>
          <ProviderStatusList statuses={providers} compact loading={backendLoading} />
          <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
            {backendLoading
              ? 'Vérification en cours.'
              : providers === null
                ? 'Le statut des services IA n’a pas pu être chargé.'
                : availableProviders.length === 0
                  ? 'Aucun service IA vérifié pour le moment.'
                  : 'Disponibilité vérifiée côté serveur.'}
          </p>
        </section>

        <section className="vy-surface p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck size={15} className="text-emerald-300" />
            <h2 className="text-sm font-semibold text-white">Données privées</h2>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            À l’envoi, la conversation, le contexte d’entreprise et la mémoire consentie peuvent être transmis au fournisseur IA sélectionné. Évitez les données sensibles ; aucune action externe n’est exécutée automatiquement.
          </p>
        </section>

        <section className="vy-surface p-4">
          <div className="mb-2 flex items-center gap-2">
            <MessageSquare size={15} className="text-violet-300" />
            <h2 className="text-sm font-semibold text-white">Historique</h2>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            {/* L'état vide est rendu par la sidebar de l'assistant, qui liste
                réellement les conversations : le dupliquer ici afficherait deux
                fois la même information. */}
            {conversationsLoaded
              ? `${conversations.length} conversation(s) conservée(s) pour cette entreprise.`
              : backendLoading
                ? 'Chargement de vos conversations…'
                // Ni vide ni en chargement : la lecture a échoué. Le dire
                // évite de présenter une panne comme un historique vide.
                : 'Historique indisponible'}
          </p>
          {contextReport && (
            <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
              Contexte métier analysé : {contextReport.coverage.filter((c) => c.status === 'available').length} source(s) disponible(s).
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}

function MemoryView({
  workspaceId,
  memory,
  loading,
  busy,
  error,
  onConsent,
  onSaveProfile,
  onPutItem,
  onDeleteItem,
  onImportLegacy,
  onRetry,
}: {
  workspaceId: string | null;
  memory: BusinessMemory | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onConsent: (enabled: boolean) => Promise<void>;
  onSaveProfile: (profile: Record<string, unknown>) => Promise<void>;
  onPutItem: (category: string, content: unknown, itemId?: string) => Promise<void>;
  onDeleteItem: (id: string) => Promise<void>;
  onImportLegacy: () => Promise<{ importedItems: number; importedProfile: boolean } | null>;
  onRetry: () => void;
}) {
  const [profileDraft, setProfileDraft] = useState('{}');
  const [category, setCategory] = useState('business_context');
  const [itemDraft, setItemDraft] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [importNotice, setImportNotice] = useState('');

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
    try { await onPutItem(category, { text: itemDraft.trim() }); setItemDraft(''); }
    catch { /* l'erreur serveur reste visible dans le panneau */ }
  };

  const saveItem = async (itemCategory: string, id: string) => {
    try {
      const value: unknown = JSON.parse(editingDraft);
      await onPutItem(itemCategory, value, id);
      setEditingItem(null); setFormError(null);
    } catch (error) { setFormError(error instanceof Error ? error.message : 'Contenu JSON invalide.'); }
  };
  const importLegacy = async () => {
    try {
      const result = await onImportLegacy();
      if (result) setImportNotice(`${result.importedItems} note(s) importée(s)${result.importedProfile ? ' et profil importé' : ' ; aucun profil copié (déjà présent ou absent)'}. Les données personnelles d’origine restent intactes.`);
      setConfirmImport(false);
    } catch { /* l'erreur serveur reste visible dans le panneau */ }
  };

  return (
    <section className="vy-surface p-5 sm:p-7">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-white">Mémoire métier privée</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Cette mémoire est privée pour votre compte et l’entreprise active. La révocation supprime uniquement les éléments de cette mémoire ; les tâches, rapports et conversations enregistrés restent conservés et peuvent contenir des informations copiées.
        </p>
      </div>
      {error && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs text-rose-100" role="alert">
          <span>{error}</span><button type="button" className="underline" onClick={onRetry}>Réessayer</button>
        </div>
      )}
      {loading ? <p className="mt-6 text-sm text-slate-400">Chargement de votre mémoire…</p> : !memory ? <p className="mt-6 text-sm text-amber-200">État de la mémoire indisponible. Rechargez avant de modifier le consentement.</p> : (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div>
              <p className="text-sm font-medium text-white">Consentement mémoire</p>
              <p className="mt-1 text-xs text-slate-500">
                {memory?.consent ? 'La mémoire métier peut être enregistrée.' : 'La mémoire est désactivée et reste vide.'}
              </p>
            </div>
            <Toggle checked={Boolean(memory?.consent)} onChange={(enabled) => { if (enabled) void onConsent(true); else setConfirmRevoke(true); }} label={memory?.consent ? 'Activée' : 'Désactivée'} />
          </div>

          {confirmRevoke && <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/5 p-3 text-xs text-amber-100" role="alert">
            <p>La désactivation supprimera les notes, le profil, les prospects et les plans de cette mémoire. Les tâches, rapports et conversations déjà enregistrés restent conservés et peuvent contenir des informations copiées.</p>
            <div className="mt-2 flex gap-2"><Button size="sm" disabled={busy} onClick={() => { setConfirmRevoke(false); void onConsent(false); }}>Confirmer la désactivation et la suppression</Button><Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(false)}>Annuler</Button></div>
          </div>}
          {workspaceId && memory?.consent && <div className="mt-3 rounded-xl border border-white/[0.07] p-3 text-xs text-slate-400">
            <p>L’ancienne mémoire personnelle reste séparée. Vous pouvez la copier explicitement dans cette entreprise, sans écraser le profil existant.</p>
            {!confirmImport ? <button type="button" className="mt-2 text-violet-200 underline" onClick={() => setConfirmImport(true)}>Importer l’ancienne mémoire personnelle</button> :
              <div className="mt-2 flex flex-wrap items-center gap-2"><span>Confirmer la copie dans l’entreprise active ?</span><Button size="sm" disabled={busy} onClick={() => void importLegacy()}>Confirmer l’import</Button><Button size="sm" variant="ghost" onClick={() => setConfirmImport(false)}>Annuler</Button></div>}
            {importNotice && <p className="mt-2 text-emerald-200" role="status">{importNotice}</p>}
          </div>}
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
                  <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Catégorie mémoire" className="w-36 rounded-lg border border-white/10 bg-[#0c111b] px-2 py-2 text-xs text-white">
                    <option value="business_context">Contexte</option><option value="sector">Secteur</option><option value="goals">Objectifs</option><option value="preferences">Préférences</option><option value="information">Informations</option><option value="decisions">Décisions</option><option value="plans">Plans</option>
                  </select>
                  <input value={itemDraft} onChange={(event) => setItemDraft(event.target.value)} aria-label="Note mémoire" placeholder="Contexte utile…" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#0c111b] px-3 py-2 text-xs text-white" />
                  <Button size="sm" onClick={() => { void addItem(); }} disabled={busy || !itemDraft.trim()}>Ajouter</Button>
                </div>
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {(memory?.items ?? []).map((item) => (
                    <article key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-white/[0.07] bg-black/15 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] uppercase tracking-wide text-brand-200">{item.category}</p>
                        {editingItem === item.id ? <div className="mt-2 space-y-2">
                          <textarea aria-label="Contenu de la note (JSON)" value={editingDraft} onChange={(event) => setEditingDraft(event.target.value)} rows={4} className="w-full rounded-lg border border-white/10 bg-[#080d15] p-2 font-mono text-xs text-white" />
                          {formError && <p className="text-rose-300" role="alert">{formError}</p>}
                          <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void saveItem(item.category, item.id)}>Enregistrer la note</Button><Button size="sm" variant="ghost" onClick={() => { setEditingItem(null); setFormError(null); }}>Annuler</Button></div>
                        </div> : <p className="mt-1 break-words text-xs text-slate-300">{typeof item.content === 'object' && item.content !== null && 'text' in item.content ? String((item.content as { text: unknown }).text) : JSON.stringify(item.content)}</p>}
                      </div>
                      <button type="button" onClick={() => { setEditingItem(item.id); setEditingDraft(JSON.stringify(item.content, null, 2)); setFormError(null); }} disabled={busy} aria-label="Modifier la note" className="text-slate-500 hover:text-violet-300 disabled:opacity-50"><Pencil size={14} /></button>
                      <button type="button" onClick={() => { void onDeleteItem(item.id).catch(() => undefined); }} disabled={busy} aria-label="Supprimer la note" className="text-slate-500 hover:text-rose-300 disabled:opacity-50"><Trash2 size={14} /></button>
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
  backendLoading,
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
  backendLoading: boolean;
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
  const [routingRole, setRoutingRole] = useState<BusinessRoleKey>('business_advisor');
  const [routingMode, setRoutingMode] = useState<RoutingSelectionMode>('auto');
  const [routingProvider, setRoutingProvider] = useState('');
  const [routingModel, setRoutingModel] = useState('');
  const [routingAllowFallback, setRoutingAllowFallback] = useState(true);

  // Servables = ceux que le serveur considère configurés (registre + secret).
  const configurableProviders = (statuses ?? []).filter(
    (status) => status.config_status === 'configured' || status.enabled,
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
      <section className="vy-surface p-5 sm:p-7">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="text-lg font-semibold text-white">Services IA SORAHNEX</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              L’AI Director sélectionne automatiquement le service adapté selon sa disponibilité réelle. Les détails techniques restent internes à SORAHNEX.
            </p>
          </div>
          {quota && quota.available_units !== null && (
            <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-xs text-slate-300">
              <p className="font-semibold text-white">Quota Business isolé</p>
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
            </p>
            {verifyBanner.hint && <p className="mt-1 text-[11px] opacity-85">Réessayez plus tard ou contactez le support SORAHNEX.</p>}
          </div>
        )}
        {!backendReady && backendLoading && (
          <div className="mb-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-xs text-slate-400" role="status">
            Connexion au registre des fournisseurs…
          </div>
        )}
        <div className="space-y-3">
          {(statuses ?? []).length === 0 ? (
            <p className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5 text-xs text-slate-400" role="status">
              Aucun service IA n’est encore déclaré. L’administrateur peut en ajouter depuis l’espace Admin ; ils
              apparaîtront ici dès qu’ils seront configurés.
            </p>
          ) : (statuses ?? []).map((provider) => {
            const status = providerStatus(provider);
            const providerModels = models.filter((model) => model.provider_key === provider.provider_key);
            const canProbe = backendReady && provider.config_status === 'configured';
            return (
              <article key={provider.provider_key} className="rounded-xl border border-white/[0.07] bg-black/15 p-4" data-testid={`provider-${provider.provider_key}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-white">{provider.display_name || provider.provider_key}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">{status.label === 'Vérifié' ? 'Disponibilité confirmée.' : 'Disponibilité non confirmée.'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {canProbe && (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={verifyingKey === provider.provider_key}
                        disabled={Boolean(verifyingKey)}
                        onClick={() => { void onVerifyProvider(provider.provider_key); }}
                      >
                        Vérifier la connexion
                      </Button>
                    )}
                  </div>
                </div>
                {providerModels.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {providerModels.map((model) => {
                      const modelStateLabel = model.verification_status === 'verified'
                        ? 'Vérifié'
                        : model.verification_status === 'unavailable'
                          ? 'Indisponible'
                          : 'Non vérifié';
                      const capabilities = capabilitiesOf(model.capabilities);
                      return (
                        <button
                          key={model.model_key}
                          type="button"
                          disabled={!canProbe || Boolean(verifyingKey)}
                          title={canProbe ? 'Vérifier ce modèle IA SORAHNEX' : undefined}
                          onClick={() => {
                            if (canProbe) void onVerifyProvider(provider.provider_key, model.provider_model_key);
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
                          {model.display_name || model.model_key} ({modelStateLabel})
                          {capabilities.length > 0 ? ` · ${capabilities.slice(0, 2).join(', ')}` : ''}
                        </button>
                      );
                    })}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="vy-surface p-5 sm:p-7">
        <div className="mb-4 flex items-center gap-2">
          <SlidersHorizontal size={16} className="text-brand-300" />
          <h3 className="text-sm font-semibold text-white">Comment SORAHNEX choisit un service IA</h3>
        </div>
        <p className="text-xs leading-relaxed text-slate-400">
          Le catalogue des services n’est pas figé : la plateforme lit le registre central, qui décrit pour chaque
          fournisseur son protocole, son URL et le nom de son secret. Un service ajouté par l’administrateur apparaît
          donc dans cette liste sans mise à jour de l’application — et n’est utilisé qu’après une vérification réelle.
        </p>
      </section>

      {backendReady && (
        <section className="vy-surface p-5 sm:p-7">
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
                  aria-label="Service IA préféré"
                  value={routingProvider}
                  onChange={(event) => {
                    setRoutingProvider(event.target.value);
                    setRoutingModel('');
                  }}
                  className="rounded-lg border border-white/10 bg-[#0c111b] px-3 py-2 text-xs text-white"
                >
                  <option value="">Service IA…</option>
                  {configurableProviders.length === 0 ? (
                    <option value="" disabled>Aucun service configuré</option>
                  ) : configurableProviders.map((provider) => (
                    <option key={provider.provider_key} value={provider.provider_key}>
                      {provider.display_name || provider.provider_key}
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
                      {model.display_name || model.model_key}
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
                  {pref.preferred_provider_key ? ' · moteur personnalisé' : ''}
                  {pref.preferred_model_key ? ' / modèle personnalisé' : ''}
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
                    <span>{String(req.role_key ?? req.task_role_key ?? 'business_advisor')} · traitement IA SORAHNEX</span>
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


/**
 * A6 — Contrôle IA : le centre de contrôle de l'AI CORE, côté utilisateur.
 * Mémoire de l'agent (consentement, lecture, effacement), règles de routage
 * et activité IA récente. Les détails techniques (fournisseurs) restent
 * anonymisés, conformément à l'identité produit.
 */
function AiControlCenterView({
  memories,
  loading,
  searching,
  error,
  consent,
  consentBusy,
  savedRouting,
  requests,
  onToggleConsent,
  onSearch,
  onForget,
  onRetry,
  onOpenProviders,
}: {
  memories: BusinessAgentMemory[];
  loading: boolean;
  searching: boolean;
  error: string | null;
  consent: boolean;
  consentBusy: boolean;
  savedRouting: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
  onToggleConsent: (enabled: boolean) => Promise<void>;
  onSearch: (query: string) => Promise<void>;
  onForget: (memoryId: string) => Promise<void>;
  onRetry: () => void;
  onOpenProviders: () => void;
}) {
  const [query, setQuery] = useState('');
  const [forgettingId, setForgettingId] = useState<string | null>(null);

  const handleSearch = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed) void onSearch(trimmed);
  };

  const handleForget = async (memoryId: string) => {
    setForgettingId(memoryId);
    try {
      await onForget(memoryId);
    } finally {
      setForgettingId(null);
    }
  };

  const formatDate = (value: string | null | undefined) => {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(value));
    } catch {
      return '';
    }
  };

  return (
    <div className="space-y-4">
      {/* Mémoire de l'agent */}
      <section className="vy-surface p-5 sm:p-7" data-testid="ai-memory-panel">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="text-lg font-semibold text-white">Mémoire de l’agent</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Les éléments que SORAHNEX retient de vous pour personnaliser ses réponses : votre entreprise, vos décisions, vos préférences.
              Seules vos déclarations explicites sont mémorisées. Vous décidez, vous vérifiez, vous effacez.
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-2.5">
            <p className="mb-1.5 text-[11px] font-medium text-slate-400">Mémoire activée</p>
            <Toggle
              checked={consent}
              onChange={(next) => { if (!consentBusy) void onToggleConsent(next); }}
              label={consent ? 'Mémoriser mes déclarations' : 'Ne rien mémoriser'}
            />
            {consentBusy && <p className="mt-1.5 text-[10px] text-slate-500" role="status">Enregistrement…</p>}
          </div>
        </div>

        <form onSubmit={handleSearch} className="mb-4 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher dans la mémoire (ex. « savon », « prix »)…"
            aria-label="Rechercher dans la mémoire de l’agent"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#0c111b] px-3 py-2 text-xs text-white placeholder:text-slate-600"
          />
          <Button size="sm" variant="outline" loading={searching} type="submit">
            Rechercher
          </Button>
          {memories.length > 0 && (
            <Button size="sm" variant="ghost" type="button" onClick={onRetry}>
              Tout afficher
            </Button>
          )}
        </form>

        {error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : loading ? (
          <LoadingState label="Chargement de la mémoire de l’agent…" />
        ) : memories.length === 0 ? (
          <EmptyState
            icon={<Brain size={24} />}
            title={consent ? 'Aucun élément mémorisé pour l’instant' : 'Mémoire désactivée'}
            description={
              consent
                ? 'Vos déclarations explicites (entreprise, décisions, préférences) apparaîtront ici.'
                : 'Activez la mémoire pour que SORAHNEX retienne vos déclarations explicites.'
            }
          />
        ) : (
          <ul className="space-y-2.5">
            {memories.map((memory) => (
              <li key={memory.id} className="rounded-xl border border-white/[0.07] bg-black/15 p-4" data-testid={`ai-memory-${memory.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="brand">{AGENT_MEMORY_CATEGORY_LABELS[memory.category] ?? memory.category}</Badge>
                      <Badge tone={memory.confidence === 'fact' ? 'success' : 'neutral'}>
                        {memory.confidence === 'fact' ? 'Vérifié' : memory.confidence === 'hypothesis' ? 'À confirmer' : 'Incertitude'}
                      </Badge>
                      {memory.created_at && <span className="text-[11px] text-slate-500">{formatDate(memory.created_at)}</span>}
                    </div>
                    <p className="mt-2 text-sm font-medium text-white">{memory.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">{memory.content}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={forgettingId === memory.id}
                    disabled={forgettingId !== null && forgettingId !== memory.id}
                    onClick={() => { void handleForget(memory.id); }}
                    aria-label={`Oublier « ${memory.title} »`}
                  >
                    <Trash2 size={13} /> Oublier
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Règles de routage */}
      <section className="vy-surface p-5 sm:p-7" data-testid="ai-routing-panel">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={16} className="text-brand-300" />
            <h3 className="text-sm font-semibold text-white">Règles de routage</h3>
          </div>
          <Button size="sm" variant="outline" onClick={onOpenProviders}>
            Configurer <ArrowUpRight size={13} />
          </Button>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-slate-400">
          Par défaut, SORAHNEX sélectionne automatiquement le service adapté et le modèle le plus fiable.
          Vous pouvez imposer un moteur précis par rôle d’assistant.
        </p>
        {savedRouting.length === 0 ? (
          <p className="rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2.5 text-xs text-slate-500">
            Aucune règle personnalisée — routage automatique actif pour tous les rôles.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" data-testid="ai-routing-rules">
            {savedRouting.map((pref) => (
              <li key={String(pref.role_key)} className="rounded-lg border border-white/[0.08] bg-black/20 px-2.5 py-1.5 text-[11px] text-slate-300">
                {String(pref.role_key)} · {String(pref.selection_mode) === 'manual' ? 'moteur imposé' : 'auto'}
                {pref.preferred_model_key ? ' / modèle imposé' : ''}
                {pref.allow_fallback === false ? ' (sans secours)' : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Activité IA récente */}
      <section className="vy-surface p-5 sm:p-7" data-testid="ai-activity-panel">
        <div className="mb-4 flex items-center gap-2">
          <Activity size={16} className="text-cyan-300" />
          <h3 className="text-sm font-semibold text-white">Activité IA récente</h3>
        </div>
        {requests.length === 0 ? (
          <p className="rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2.5 text-xs text-slate-500">
            Aucune exécution IA enregistrée pour l’instant.
          </p>
        ) : (
          <ul className="space-y-1.5 text-[11px]">
            {requests.slice(0, 8).map((req) => {
              const inputTokens = typeof req.input_tokens === 'number' ? req.input_tokens : null;
              const outputTokens = typeof req.output_tokens === 'number' ? req.output_tokens : null;
              return (
                <li key={String(req.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-slate-300">
                  <span>{String(req.role_key ?? 'business_advisor')} · réponse IA</span>
                  <span className="text-slate-500">
                    {String(req.status ?? '')}
                    {req.latency_ms ? ` · ${String(req.latency_ms)} ms` : ''}
                    {inputTokens !== null || outputTokens !== null ? ` · ${inputTokens ?? 0}→${outputTokens ?? 0} jetons` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function BusinessGrowWorkspace() {
  const { user, workspaceId } = useAuth();
  // Remonter tout l'état métier à chaque changement de compte/entreprise : une
  // réponse tardive ne peut jamais réafficher le périmètre précédent.
  return <ScopedBusinessGrowWorkspace key={`${user?.id ?? ''}:${workspaceId ?? ''}`} />;
}

function ScopedBusinessGrowWorkspace() {
  // Texte préparé par un rapport d'agent, transmis au composeur de l'assistant.
  const [reportDraft, setReportDraft] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, session, workspace, workspaceId } = useAuth();
  /** Le module Growth OS est dérivé de l'URL : rechargement et bouton retour fiables. */
  const osModule = useMemo<GrowthOsModule>(() => growthOsModuleFromPath(location.pathname), [location.pathname]);
  const go = useCallback((module: GrowthOsModule) => { navigate(growthOsModule(module).path); }, [navigate]);
  const [crmContactId, setCrmContactId] = useState<string | null>(null);
  const [financeContactId, setFinanceContactId] = useState<string | null>(null);
  const accountScope = `${user?.id ?? ''}:${workspaceId ?? ''}`;
  const hasSession = Boolean(user && session);
  const sessionToken = session?.access_token ?? null;
  const parsedIntent = useMemo(() => parseBusinessGrowEntryIntent(location.state), [location.state]);
  const [entryIntent, setEntryIntent] = useState<BusinessGrowEntryIntent | null>(null);
  const [providers, setProviders] = useState<BusinessProviderStatus[] | null>(null);
  const [models, setModels] = useState<BusinessModelRecord[]>([]);
  const [quota, setQuota] = useState<BusinessQuotaStatus | null>(null);
  const [requests, setRequests] = useState<Array<Record<string, unknown>>>([]);
  const [tools, setTools] = useState<BusinessToolExecution[]>([]);
  const [integrations, setIntegrations] = useState<BusinessIntegrationConnection[] | null>(null);
  const [integrationLoadError, setIntegrationLoadError] = useState<string | null>(null);
  /** Refus d'abonnement renvoyé par `integrations.list` : affiché comme tel, pas comme une panne. */
  const [integrationRefusal, setIntegrationRefusal] = useState<SubscriptionRefusal | null>(null);
  const [integrationBusyKey, setIntegrationBusyKey] = useState<string | null>(null);
  const [integrationNotice, setIntegrationNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [conversations, setConversations] = useState<BusinessConversation[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BusinessMessage[]>([]);
  const [memory, setMemory] = useState<BusinessMemory | null>(null);
  /** A6 — Contrôle IA : mémoire persistante de l'agent. */
  const [agentMemories, setAgentMemories] = useState<BusinessAgentMemory[]>([]);
  const [agentMemoriesLoading, setAgentMemoriesLoading] = useState(false);
  const [agentMemoriesError, setAgentMemoriesError] = useState<string | null>(null);
  const [agentSearching, setAgentSearching] = useState(false);
  const [agentConsentBusy, setAgentConsentBusy] = useState(false);
  const [backendReady, setBackendReady] = useState(false);
  /** Premier appel encore en vol : ne jamais présenter cela comme une panne. */
  const [backendLoading, setBackendLoading] = useState(true);
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
  const toolLoadSequence = useRef(0);
  const accountScopeRef = useRef(accountScope);
  const workspaceLoadSequence = useRef(0);
  const conversationLoadSequence = useRef(0);
  const statusLoadSequence = useRef(0);
  const memoryLoadSequence = useRef(0);
  const agentMemoryLoadSequence = useRef(0);
  const detailsLoadSequence = useRef(0);
  const integrationLoadSequence = useRef(0);
  const integrationMutationPending = useRef(false);
  const taskProposalKeys = useRef(new Map<string, string>());
  const selectedConversationRef = useRef(selectedConversationId);
  const selectionRevision = useRef(0);
  selectedConversationRef.current = selectedConversationId;

  useEffect(() => {
    accountScopeRef.current = accountScope;
    return () => { accountScopeRef.current = ''; };
  }, [accountScope]);

  useEffect(() => {
    if (!parsedIntent) return;
    setEntryIntent(parsedIntent);
    if (parsedIntent.section) {
      const target = legacyGrowthOsPath(parsedIntent.section, parsedIntent.growthTab ?? null);
      if (target) navigate(target);
    }
    if (parsedIntent.roleKey) setRoleKey(parsedIntent.roleKey);
    // Le contexte transmis pré-remplit le composeur de l'assistant. Sans cela,
    // arriver depuis un projet ouvrirait une conversation vide — le contexte
    // serait affiché mais inutilisable.
    if (parsedIntent.initialDraft) setReportDraft((current) => current ?? parsedIntent.initialDraft ?? null);
  }, [parsedIntent, navigate]);

  // Anciennes URL (`?section=chat`, `?section=growth&growthTab=relations`…) :
  // redirection vers le module réel du Growth OS, sans perdre le lien profond.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const target = legacyGrowthOsPath(params.get('section'), params.get('growthTab'));
    if (target) navigate(target, { replace: true });
  }, [location.search, navigate]);

  useEffect(() => {
    accountScopeRef.current = accountScope;
    workspaceLoadSequence.current += 1;
    conversationLoadSequence.current += 1;
    statusLoadSequence.current += 1;
    memoryLoadSequence.current += 1;
    agentMemoryLoadSequence.current += 1;
    messageLoadSequence.current += 1;
    toolLoadSequence.current += 1;
    detailsLoadSequence.current += 1;
    integrationLoadSequence.current += 1;
    taskProposalKeys.current.clear();
    setProviders(null);
    setModels([]);
    setQuota(null);
    setRequests([]);
    setTools([]);
    setIntegrations(null);
    setIntegrationLoadError(null);
    setIntegrationRefusal(null);
    setSavedRouting([]);
    setConversations([]);
    setConversationsLoaded(false);
    setSelectedConversationId(null);
    setMessages([]);
    setMemory(null);
    setAgentMemories([]);
    setAgentMemoriesError(null);
    setAgentSearching(false);
    setAgentConsentBusy(false);
    setBackendReady(false);
    setBackendLoading(true);
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
    if (!workspaceId) { setConversations([]); setConversationsLoaded(false); return; }
    try {
      const result = await businessGrowApi.listConversations(workspaceId);
      if (requestId !== conversationLoadSequence.current || accountScopeRef.current !== requestScope) return;
      setConversations(result.conversations);
      setConversationsLoaded(true);
      setSelectedConversationId((current) =>
        current && result.conversations.some((conversation) => conversation.id === current)
          ? current
          : result.conversations[0]?.id ?? null,
      );
    } catch (error) {
      if (requestId === conversationLoadSequence.current && accountScopeRef.current === requestScope) setConversationsLoaded(false);
      throw error;
    }
  }, [accountScope, workspaceId]);

  const loadStatus = useCallback(async () => {
    const requestId = ++statusLoadSequence.current;
    const requestScope = accountScope;
    try {
      const result = await businessGrowApi.getStatus();
      if (requestId !== statusLoadSequence.current || accountScopeRef.current !== requestScope) return;
      setProviders(result.providers);
    } catch (error) {
      if (requestId === statusLoadSequence.current && accountScopeRef.current === requestScope) setProviders(null);
      throw error;
    }
  }, [accountScope]);

  const loadIntegrations = useCallback(async () => {
    if (!workspaceId || typeof businessGrowApi.listIntegrations !== 'function') return;
    const seq = ++integrationLoadSequence.current;
    const scope = accountScope;
    setIntegrationLoadError(null);
    try {
      const result = await businessGrowApi.listIntegrations(workspaceId);
      if (!Array.isArray(result.connections) || result.connections.some((connection) => connection.workspace_id !== workspaceId)) {
        throw new Error('Réponse invalide pour cette entreprise.');
      }
      if (seq === integrationLoadSequence.current && accountScopeRef.current === scope) {
        setIntegrations(result.connections);
        setIntegrationRefusal(null);
      }
    } catch (cause) {
      if (seq === integrationLoadSequence.current && accountScopeRef.current === scope) {
        setIntegrations(null);
        const refus = subscriptionRefusalOf(cause);
        setIntegrationRefusal(refus);
        setIntegrationLoadError(refus ? null : cause instanceof Error ? cause.message : 'Réessayez plus tard.');
      }
      throw cause;
    }
  }, [accountScope, workspaceId]);

  const loadOperationalDetails = useCallback(async () => {
    const requestId = ++detailsLoadSequence.current;
    const requestScope = accountScope;
    const [modelsRes, quotaRes, reqRes, , routingRes] = await Promise.allSettled([
      businessGrowApi.listModels?.() ?? Promise.resolve(null),
      businessGrowApi.getQuota?.() ?? Promise.resolve(null),
      workspaceId ? businessGrowApi.listRequests?.(workspaceId) ?? Promise.resolve(null) : Promise.resolve(null),
      loadIntegrations(),
      businessGrowApi.getRouting?.() ?? Promise.resolve(null),
    ]);
    if (requestId !== detailsLoadSequence.current || accountScopeRef.current !== requestScope) return;
    if (modelsRes.status === 'fulfilled' && modelsRes.value) setModels(modelsRes.value.models);
    if (quotaRes.status === 'fulfilled' && quotaRes.value) setQuota(quotaRes.value);
    if (reqRes.status === 'fulfilled' && reqRes.value) setRequests(reqRes.value.requests);
    if (routingRes.status === 'fulfilled' && routingRes.value && Array.isArray(routingRes.value.preferences)) {
      setSavedRouting(routingRes.value.preferences);
    }
  }, [accountScope, workspaceId, loadIntegrations]);

  const handleIntegrationAction = useCallback(async (
    action: 'request' | 'cancel' | 'disconnect', connectorKey: string,
  ) => {
    if (!workspaceId || integrationMutationPending.current) return;
    integrationMutationPending.current = true;
    integrationLoadSequence.current++; // invalider toute lecture antérieure à la mutation
    const scope = accountScope;
    setIntegrationBusyKey(`${connectorKey}:${action}`);
    setIntegrationNotice(null);
    try {
      let text: string;
      let tone: 'success' | 'error' = 'success';
      if (action === 'request') {
        const result = await businessGrowApi.requestIntegration(connectorKey, workspaceId);
        if (result.status === 'connected') text = 'Une association existe déjà dans cette entreprise.';
        else if (result.status === 'pending') text = 'Demande enregistrée pour cette entreprise. Aucun service externe n’a été connecté.';
        else throw new Error('Réponse de demande invalide.');
      } else if (action === 'cancel') {
        const result = await businessGrowApi.cancelIntegration(connectorKey, workspaceId);
        if (typeof result.cancelled !== 'boolean') throw new Error('Réponse d’annulation invalide.');
        tone = result.cancelled ? 'success' : 'error';
        text = result.cancelled ? 'Demande annulée dans cette entreprise.' : 'Aucune demande en attente à annuler dans cette entreprise.';
      } else {
        const result = await businessGrowApi.disconnectIntegration(connectorKey, workspaceId);
        if (typeof result.disconnected !== 'boolean') throw new Error('Réponse de déconnexion invalide.');
        tone = result.disconnected ? 'success' : 'error';
        text = result.disconnected
          ? 'Association locale retirée. Aucune révocation n’a été effectuée chez le fournisseur : révoquez-la également auprès de celui-ci si nécessaire.'
          : 'Aucune association locale à retirer dans cette entreprise.';
      }
      if (accountScopeRef.current !== scope) return;
      try { await loadIntegrations(); }
      catch { text += ' État non rechargé : actualisez avant toute nouvelle opération.'; }
      if (accountScopeRef.current === scope) setIntegrationNotice({ tone, text });
    } catch (error) {
      if (accountScopeRef.current === scope) {
        setIntegrations(null);
        const refus = subscriptionRefusalOf(error);
        setIntegrationRefusal(refus);
        setIntegrationLoadError(refus ? null : 'Opération non confirmée. Rechargez l’état avant de poursuivre.');
        setIntegrationNotice({
          tone: 'error',
          text: refus
            ? 'Opération refusée : abonnement SORAHNEX Grow requis. Rien n’a été enregistré.'
            : `${asAppError(error).message} Vérifiez l’état avant de recommencer.`,
        });
      }
    } finally {
      integrationMutationPending.current = false;
      if (accountScopeRef.current === scope) setIntegrationBusyKey(null);
    }
  }, [accountScope, workspaceId, loadIntegrations]);

  const refreshWorkspace = useCallback(async () => {
    const requestId = ++workspaceLoadSequence.current;
    const requestScope = accountScope;
    if (!hasSession) {
      setBackendReady(false);
      setBackendLoading(false);
      setProviders(null);
      setConversations([]);
      setConversationsLoaded(false);
      setSelectedConversationId(null);
      setMessages([]);
      setError('Session SORAHNEX indisponible. Reconnectez-vous pour charger SORAHNEX Grow.');
      return;
    }
    setBackendReady(false);
    setProviders(null);
    setConversationsLoaded(false);
    setError(null);
    setBackendLoading(true);
    let [statusResult, conversationsResult] = await Promise.allSettled([loadStatus(), loadConversations()]);
    if (requestId !== workspaceLoadSequence.current || accountScopeRef.current !== requestScope) return;
    // Un seul aller-retour supplémentaire : un incident réseau transitoire au
    // montage ne doit pas figer la page en « backend indisponible ».
    if (statusResult.status === 'rejected' && conversationsResult.status === 'rejected') {
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (requestId !== workspaceLoadSequence.current || accountScopeRef.current !== requestScope) return;
      [statusResult, conversationsResult] = await Promise.allSettled([loadStatus(), loadConversations()]);
      if (requestId !== workspaceLoadSequence.current || accountScopeRef.current !== requestScope) return;
    }
    setBackendLoading(false);
    if (statusResult.status === 'fulfilled' || conversationsResult.status === 'fulfilled') {
      setBackendReady(true);
      if (statusResult.status === 'rejected') setError('Impossible de vérifier les services IA. Réessayez.');
      else if (conversationsResult.status === 'rejected') setError('Impossible de charger l’historique des conversations. Réessayez.');
      void loadOperationalDetails();
      return;
    }
    setBackendReady(false);
    setError(statusResult.status === 'rejected'
      ? statusResult.reason instanceof Error ? statusResult.reason.message : 'Le registre IA est indisponible.'
      : conversationsResult.status === 'rejected' && conversationsResult.reason instanceof Error
        ? conversationsResult.reason.message
        : 'SORAHNEX Grow ne répond pas pour le moment. Réessayez dans quelques instants.');
  }, [accountScope, hasSession, loadConversations, loadOperationalDetails, loadStatus, sessionToken]);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  const loadMessages = useCallback(async () => {
    const sequence = ++messageLoadSequence.current;
    const toolSequence = ++toolLoadSequence.current;
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
        businessGrowApi.listMessages(selectedConversationId, workspaceId),
        businessGrowApi.listTools?.(selectedConversationId, workspaceId).catch(() => null) ?? Promise.resolve(null),
      ]);
      if (messageLoadSequence.current === sequence && accountScopeRef.current === requestScope) {
        setMessages(result.messages);
        if (toolsResult && toolSequence === toolLoadSequence.current) setTools(toolsResult.tools);
        setError(null);
      }
    } catch (loadError) {
      if (messageLoadSequence.current === sequence && accountScopeRef.current === requestScope) {
        setError(loadError instanceof Error ? loadError.message : 'Impossible de charger les messages.');
      }
    } finally {
      if (messageLoadSequence.current === sequence && accountScopeRef.current === requestScope) setLoadingMessages(false);
    }
  }, [accountScope, backendReady, selectedConversationId, workspaceId]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  const loadMemory = useCallback(async () => {
    const requestId = ++memoryLoadSequence.current;
    const requestScope = accountScope;
    if (!workspaceId) { setMemory(null); setLoadingMemory(false); return; }
    setLoadingMemory(true);
    setMemoryError(null);
    try {
      const result = await businessGrowApi.getMemory(workspaceId);
      if (requestId === memoryLoadSequence.current && accountScopeRef.current === requestScope) setMemory(result);
    } catch (loadError) {
      if (requestId === memoryLoadSequence.current && accountScopeRef.current === requestScope) {
        setMemoryError(loadError instanceof Error ? loadError.message : 'Impossible de charger la mémoire.');
      }
    } finally {
      if (requestId === memoryLoadSequence.current && accountScopeRef.current === requestScope) setLoadingMemory(false);
    }
  }, [accountScope, workspaceId]);

  useEffect(() => {
    if (['overview', 'reports', 'crm', 'pipeline', 'tasks', 'relances', 'finance', 'recouvrement', 'company', 'memory'].includes(osModule) && backendReady) void loadMemory();
  }, [backendReady, loadMemory, osModule]);

  const loadAgentMemories = useCallback(async () => {
    const requestId = ++agentMemoryLoadSequence.current;
    const requestScope = accountScope;
    setAgentMemoriesLoading(true);
    setAgentMemoriesError(null);
    try {
      const result = await businessGrowApi.listAgentMemories();
      if (requestId === agentMemoryLoadSequence.current && accountScopeRef.current === requestScope) {
        setAgentMemories(result.memories);
      }
    } catch (loadError) {
      if (requestId === agentMemoryLoadSequence.current && accountScopeRef.current === requestScope) {
        setAgentMemoriesError(loadError instanceof Error ? loadError.message : 'Impossible de charger la mémoire de l’agent.');
      }
    } finally {
      if (requestId === agentMemoryLoadSequence.current && accountScopeRef.current === requestScope) setAgentMemoriesLoading(false);
    }
  }, [accountScope]);

  useEffect(() => {
    if (osModule === 'ai' && backendReady) void loadAgentMemories();
  }, [backendReady, loadAgentMemories, osModule]);

  const searchAgentMemory = useCallback(async (query: string) => {
    const requestId = ++agentMemoryLoadSequence.current;
    const requestScope = accountScope;
    setAgentSearching(true);
    setAgentMemoriesError(null);
    try {
      const result = await businessGrowApi.searchAgentMemories(query);
      if (requestId === agentMemoryLoadSequence.current && accountScopeRef.current === requestScope) {
        setAgentMemories(result.memories);
      }
    } catch (searchError) {
      if (requestId === agentMemoryLoadSequence.current && accountScopeRef.current === requestScope) {
        setAgentMemoriesError(searchError instanceof Error ? searchError.message : 'Recherche impossible.');
      }
    } finally {
      if (requestId === agentMemoryLoadSequence.current && accountScopeRef.current === requestScope) setAgentSearching(false);
    }
  }, [accountScope]);

  const forgetAgentMemory = useCallback(async (memoryId: string) => {
    const requestScope = accountScope;
    try {
      await businessGrowApi.forgetAgentMemory(memoryId);
      if (accountScopeRef.current !== requestScope) return;
      // Optimiste : l'entrée disparaît de la liste ; la relecture corrige l'état.
      setAgentMemories((current) => current.filter((item) => item.id !== memoryId));
      void loadAgentMemories();
    } catch (forgetError) {
      if (accountScopeRef.current === requestScope) {
        setAgentMemoriesError(forgetError instanceof Error ? forgetError.message : 'Effacement impossible.');
      }
    }
  }, [accountScope, loadAgentMemories]);

  const toggleAgentMemoryConsent = useCallback(async (enabled: boolean) => {
    const requestScope = accountScope;
    setAgentConsentBusy(true);
    setAgentMemoriesError(null);
    try {
      await businessGrowApi.setMemoryConsent(enabled);
      if (accountScopeRef.current !== requestScope) return;
      await loadMemory();
      await loadAgentMemories();
    } catch (consentError) {
      if (accountScopeRef.current === requestScope) {
        setAgentMemoriesError(consentError instanceof Error ? consentError.message : 'Impossible de modifier le consentement.');
      }
    } finally {
      if (accountScopeRef.current === requestScope) setAgentConsentBusy(false);
    }
  }, [accountScope, loadMemory, loadAgentMemories]);

  const createConversation = useCallback(async () => {
    if (!workspaceId) return;
    const requestScope = accountScope;
    const initialSelection = selectionRevision.current;
    setBusy(true);
    setError(null);
    try {
      const result = await businessGrowApi.createConversation('Nouvelle conversation', workspaceId);
      if (accountScopeRef.current !== requestScope) return;
      await loadConversations();
      if (accountScopeRef.current !== requestScope || selectionRevision.current !== initialSelection) return;
      selectedConversationRef.current = result.conversationId;
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
      await businessGrowApi.renameConversation(conversationId, title, workspaceId);
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
  }, [accountScope, loadConversations, workspaceId]);

  const deleteConversation = useCallback(async (conversationId: string): Promise<boolean> => {
    const requestScope = accountScope;
    setError(null);
    try {
      await businessGrowApi.deleteConversation(conversationId, workspaceId);
      if (accountScopeRef.current !== requestScope) return false;
      if (selectedConversationRef.current === conversationId) {
        selectionRevision.current++;
        selectedConversationRef.current = null;
        messageLoadSequence.current++;
        toolLoadSequence.current++;
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
  }, [accountScope, loadConversations, workspaceId]);

  const sendMessage = useCallback(async (content: string): Promise<boolean> => {
    if (!workspaceId) { setError('Sélectionnez une entreprise avant de commencer.'); return false; }
    const requestScope = accountScope;
    const initialSelection = selectionRevision.current;
    setError(null);
    setBusy(true);
    let conversationId = selectedConversationId;
    try {
      if (!conversationId) {
        const result = await businessGrowApi.createConversation('Nouvelle conversation', workspaceId);
        if (accountScopeRef.current !== requestScope) return false;
        conversationId = result.conversationId;
        if (selectionRevision.current === initialSelection) {
          selectedConversationRef.current = conversationId;
          setSelectedConversationId(conversationId);
        }
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
      // L'envoi a réussi : une erreur de rafraîchissement ne doit jamais
      // laisser croire qu'il faut le renvoyer. Ne pas invalider une lecture
      // de la conversation B si l'utilisateur a quitté A pendant l'envoi.
      const refreshes: Promise<unknown>[] = [loadConversations(), loadOperationalDetails()];
      let messageSequence: number | null = null;
      if (selectedConversationRef.current === conversationId) {
        messageSequence = ++messageLoadSequence.current;
        const toolSequence = ++toolLoadSequence.current;
        const currentMessageSequence = messageSequence;
        refreshes.push(businessGrowApi.listMessages(conversationId, workspaceId).then((result) => {
          if (accountScopeRef.current === requestScope && selectedConversationRef.current === conversationId && currentMessageSequence === messageLoadSequence.current) setMessages(result.messages);
        }));
        refreshes.push(businessGrowApi.listTools?.(conversationId).then((res) => {
          if (accountScopeRef.current === requestScope && selectedConversationRef.current === conversationId && toolSequence === toolLoadSequence.current && res) setTools(res.tools);
        }).catch(() => undefined) ?? Promise.resolve());
      }
      const refreshed = await Promise.allSettled(refreshes);
      if (accountScopeRef.current !== requestScope) return false;
      if (messageSequence !== null && messageSequence === messageLoadSequence.current && selectedConversationRef.current === conversationId) setLoadingMessages(false);
      if (refreshed.some((result) => result.status === 'rejected')) setError('Message envoyé, mais l’historique n’a pas pu être actualisé. Réessayez le chargement avant toute nouvelle demande.');
      return true;
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
        'PROVIDER_PAYMENT_REQUIRED',
        'PROVIDER_UNAVAILABLE',
        'PROVIDER_TIMEOUT',
        'PROVIDER_NETWORK_ERROR',
        'PROVIDER_REQUEST_REJECTED',
        'PROVIDER_INVALID_RESPONSE',
        'PROVIDER_EMPTY_RESPONSE',
        'BG_INSUFFICIENT_QUOTA',
      ].includes(code)) {
        const errorMessage = humanizeError(code, 'Impossible de traiter votre demande. Réessayez.');
        // Un service réel non vérifié depuis 24 h donne exactement ce code :
        // on guide vers la vérification plutôt que d'afficher une panne générique.
        setError(
          code === 'NO_VERIFIED_PROVIDER'
            ? 'Aucun service IA n’est vérifié pour le moment. Ouvrez « Services IA » puis lancez « Vérifier la connexion » sur un fournisseur configuré : votre message reste enregistré et aucun crédit n’a été débité.'
            : errorMessage,
        );
        const refreshes: Promise<unknown>[] = [loadConversations()];
        let messageSequence: number | null = null;
        if (conversationId && selectedConversationRef.current === conversationId) {
          messageSequence = ++messageLoadSequence.current;
          const currentMessageSequence = messageSequence;
          refreshes.push(businessGrowApi.listMessages(conversationId, workspaceId).then((result) => {
            if (accountScopeRef.current === requestScope && selectedConversationRef.current === conversationId && currentMessageSequence === messageLoadSequence.current) setMessages(result.messages);
          }));
        }
        await Promise.allSettled(refreshes);
        if (accountScopeRef.current !== requestScope) return false;
        if (messageSequence !== null && messageSequence === messageLoadSequence.current && selectedConversationRef.current === conversationId) setLoadingMessages(false);
        return true;
      }
      setError(sendError instanceof Error ? sendError.message : 'Impossible d’envoyer la demande.');
      return false;
    } finally {
      if (accountScopeRef.current === requestScope) setBusy(false);
    }
  }, [accountScope, loadConversations, loadOperationalDetails, manualAllowFallback, preferredModelKey, preferredProviderKey, roleKey, routingMode, savedRouting, selectedConversationId, workspaceId]);

  const proposeTask = useCallback(async (finding: BusinessRecommendation): Promise<boolean> => {
    if (!workspaceId) throw new Error('Sélectionnez une entreprise pour préparer une tâche.');
    const requestScope = accountScope;
    const initialSelection = selectionRevision.current;
    setBusy(true); setError(null);
    let conversationId = selectedConversationId;
    try {
      if (!conversationId) {
        const created = await businessGrowApi.createConversation('Nouvelle conversation', workspaceId);
        if (accountScopeRef.current !== requestScope) return false;
        conversationId = created.conversationId;
        if (selectionRevision.current === initialSelection) {
          selectedConversationRef.current = conversationId;
          setSelectedConversationId(conversationId);
        }
        await loadConversations();
      }
      if (accountScopeRef.current !== requestScope) return false;
      const key = `${workspaceId}:${conversationId}:${finding.sourceCategory}:${finding.sourceRecordId}`;
      if (!taskProposalKeys.current.has(key)) taskProposalKeys.current.set(key, crypto.randomUUID());
      const proposal = await businessGrowApi.proposeTask(workspaceId, conversationId, finding.sourceCategory, finding.sourceRecordId, taskProposalKeys.current.get(key)!);
      if (accountScopeRef.current !== requestScope) return false;
      if (proposal.status !== 'pending_approval') {
        taskProposalKeys.current.delete(key);
        throw new Error('Cette proposition a déjà été traitée. Consultez l’historique des actions.');
      }
      if (selectedConversationRef.current === conversationId) {
        const sequence = ++toolLoadSequence.current;
        try {
          const result = await businessGrowApi.listTools(conversationId, workspaceId);
          if (accountScopeRef.current === requestScope && selectedConversationRef.current === conversationId && toolLoadSequence.current === sequence) setTools(result.tools);
        } catch {
          if (accountScopeRef.current === requestScope && selectedConversationRef.current === conversationId) setError('Proposition enregistrée, mais l’historique des actions n’a pas pu être rechargé.');
        }
      }
      taskProposalKeys.current.delete(key);
      return accountScopeRef.current === requestScope;
    } finally { if (accountScopeRef.current === requestScope) setBusy(false); }
  }, [accountScope, selectedConversationId, workspaceId, loadConversations]);

  const resolveTool = useCallback(async (executionId: string, decision: 'approved' | 'rejected') => {
    const requestScope = accountScope;
    if (!businessGrowApi.resolveTool) return;
    setBusy(true);
    setError(null);
    try {
      await businessGrowApi.resolveTool(executionId, decision, workspaceId);
      if (accountScopeRef.current !== requestScope) return;
      if (selectedConversationId && selectedConversationRef.current === selectedConversationId && businessGrowApi.listTools) {
        const sequence = ++toolLoadSequence.current;
        try {
          const res = await businessGrowApi.listTools(selectedConversationId, workspaceId);
          if (accountScopeRef.current === requestScope && selectedConversationRef.current === selectedConversationId && toolLoadSequence.current === sequence) setTools(res.tools);
        } catch {
          if (accountScopeRef.current === requestScope && selectedConversationRef.current === selectedConversationId) setError('Action traitée, mais son historique n’a pas pu être rechargé. Vérifiez-le avant de recommencer.');
        }
      }
    } catch (resolveError) {
      if (accountScopeRef.current === requestScope) {
        setError(resolveError instanceof Error ? resolveError.message : 'Impossible de traiter cette action.');
      }
    } finally {
      if (accountScopeRef.current === requestScope) setBusy(false);
    }
  }, [accountScope, selectedConversationId, workspaceId]);

  const verifyProvider = useCallback(async (
    providerKey: string,
    modelKey?: string,
    options: { silent?: boolean } = {},
  ) => {
    const requestScope = accountScope;
    if (!businessGrowApi.verifyProvider) return;
    setVerifyingKey(providerKey);
    // Une sonde silencieuse (auto-réparation) ne doit jamais effacer un message
    // explicite déjà affiché : sinon un échec diagnostiqué devenait « succès ».
    if (!options.silent) setVerifyBanner(null);
    try {
      const result: BusinessVerificationResult = modelKey
        ? await businessGrowApi.verifyProvider(providerKey, modelKey)
        : await businessGrowApi.verifyProvider(providerKey);
      if (accountScopeRef.current !== requestScope) return;
      if (!options.silent) {
        const discoveredCount = Array.isArray(result.availableModels) ? result.availableModels.length : 0;
        setVerifyBanner({
          tone: 'success',
          message: `Connexion vérifiée avec succès · ${result.latencyMs} ms.`,
          hint: discoveredCount > 0 ? `${discoveredCount} modèle(s) actif(s).` : null,
        });
      }
      await Promise.allSettled([loadStatus(), loadOperationalDetails()]);
    } catch (verifyError) {
      if (accountScopeRef.current === requestScope) {
        const errorCode = verifyError instanceof BusinessGrowApiError ? verifyError.code : null;
        if (!options.silent || errorCode) {
          setVerifyBanner({
            tone: 'error',
            code: errorCode,
            message: 'Impossible de vérifier la connexion au service IA.',
            hint: errorCode ? describeProviderFailureHint(errorCode) : null,
          });
        }
        await Promise.allSettled([loadStatus(), loadOperationalDetails()]);
      }
    } finally {
      if (accountScopeRef.current === requestScope) setVerifyingKey(null);
    }
  }, [accountScope, loadOperationalDetails, loadStatus]);

  // Auto-réparation des fournisseurs : un fournisseur configuré dont le contrôle
  // est expiré n'est plus routable, et la page se figeait en « aucun service IA
  // vérifié » jusqu'à un clic manuel. On relance le contrôle une seule fois par
  // fournisseur et par session de page (garde `autoProbeRef`) : la sonde est
  // gratuite (aucune génération, aucun crédit consommé).
  const autoProbeRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!backendReady || verifyingKey) return;
    const pending = providersNeedingVerification(providers)
      .filter((provider) => !autoProbeRef.current.has(provider.provider_key))
      .slice(0, 1);
    const target = pending[0];
    if (!target) return;
    autoProbeRef.current.add(target.provider_key);
    let cancelled = false;
    void (async () => {
      setVerifyingKey(target.provider_key);
      try {
        await verifyProvider(target.provider_key, undefined, { silent: true });
        if (!cancelled) await Promise.allSettled([loadStatus(), loadOperationalDetails()]);
      } catch {
        // Échec silencieux : le diagnostic reste dans la carte « Services IA SORAHNEX ».
      } finally {
        if (!cancelled) setVerifyingKey(null);
      }
    })();
    return () => { cancelled = true; };
  }, [backendReady, providers, verifyProvider, verifyingKey]);

  const saveRouting = useCallback(async (pref: BusinessRoutingPreference) => {
    const requestScope = accountScope;
    if (!businessGrowApi.saveRouting) return;
    setVerifyBanner(null);
    try {
      await businessGrowApi.saveRouting(pref);
      if (accountScopeRef.current === requestScope) {
        setVerifyBanner({
          tone: 'success',
          message: 'Préférence de routage enregistrée.',
        });
        void loadOperationalDetails();
      }
    } catch (saveError) {
      if (accountScopeRef.current === requestScope) {
        const errorCode = saveError instanceof BusinessGrowApiError ? saveError.code : null;
        setVerifyBanner({
          tone: 'error',
          code: errorCode,
          message: 'Impossible d’enregistrer la préférence de routage. Réessayez.',
          hint: errorCode ? describeProviderFailureHint(errorCode) : null,
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
    if (!workspaceId) { setMemoryError('Aucune entreprise active.'); return; }
    const requestScope = accountScope;
    setBusy(true);
    setMemoryError(null);
    try {
      await businessGrowApi.setMemoryConsent(enabled, workspaceId);
      if (accountScopeRef.current !== requestScope) return;
      await loadMemory();
    } catch (consentError) {
      if (accountScopeRef.current === requestScope) {
        setMemoryError(consentError instanceof Error ? consentError.message : 'Impossible de modifier le consentement.');
      }
    } finally {
      if (accountScopeRef.current === requestScope) setBusy(false);
    }
  }, [accountScope, loadMemory, workspaceId]);

  const saveMemoryProfile = useCallback(async (profile: Record<string, unknown>) => {
    if (!workspaceId) { setMemoryError('Aucune entreprise active.'); return; }
    const requestScope = accountScope;
    setBusy(true);
    setMemoryError(null);
    try {
      await businessGrowApi.saveMemoryProfile(profile, workspaceId);
      if (accountScopeRef.current !== requestScope) return;
      await loadMemory();
    } catch (saveError) {
      if (accountScopeRef.current === requestScope) {
        setMemoryError(saveError instanceof Error ? saveError.message : 'Impossible d’enregistrer le profil.');
      }
    } finally {
      if (accountScopeRef.current === requestScope) setBusy(false);
    }
  }, [accountScope, loadMemory, workspaceId]);

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
      throw itemError;
    } finally {
      if (accountScopeRef.current === requestScope) setBusy(false);
    }
  }, [accountScope, loadMemory]);

  const importLegacyMemory = useCallback(async () => {
    if (!workspaceId) return null;
    const requestScope = accountScope; setBusy(true); setMemoryError(null);
    try {
      const result = await businessGrowApi.importLegacyMemory(workspaceId);
      if (accountScopeRef.current !== requestScope) return null;
      await loadMemory(); return result;
    } catch (importError) {
      if (accountScopeRef.current === requestScope) setMemoryError(importError instanceof Error ? importError.message : 'Import impossible.');
      throw importError;
    } finally { if (accountScopeRef.current === requestScope) setBusy(false); }
  }, [accountScope, loadMemory, workspaceId]);

  const availableProviderCount = (providers ?? []).filter((provider) => isVerifiedProvider(provider)).length;
  // Un contrôle fournisseur expire au bout de 24 h côté SQL : sans nouveau
  // sondage explicite, l'envoi de messages échoue en NO_VERIFIED_PROVIDER.
  const staleProviders = providersNeedingVerification(providers);
  const showStaleNotice = backendReady && staleProviders.length > 0;
  const noVerifiedProvider = availableProviderCount === 0;

  const legacyProspects = useMemo(() => readProspects(memory).map((prospect) => ({
    id: prospect.id,
    name: prospect.name,
    company: prospect.company,
    email: prospect.email,
    phone: prospect.phone,
    stage: prospect.stage,
    value: prospect.value,
    currency: prospect.currency,
    nextAction: prospect.nextAction,
    nextActionAt: prospect.nextActionAt,
    notes: prospect.notes,
  })), [memory]);

  return (
    <div data-testid="business-grow">
    <GrowthOsLayout active={osModule} workspaceName={workspace?.name ?? 'Aucune entreprise active'}>
      <section
        aria-label="État des services IA"
        data-testid="business-overall-status"
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[10.5px] text-slate-300"
      >
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 rounded-full', backendLoading ? 'bg-slate-500' : providers === null ? 'bg-slate-500' : availableProviderCount ? 'bg-emerald-300' : 'bg-amber-300')} />
          {backendLoading
            ? 'Connexion…'
            : providers === null
              ? 'Statut IA indisponible'
              : availableProviderCount
                ? `${availableProviderCount} service(s) IA vérifié(s)`
                : 'IA non disponible'}
        </span>
        <Link to="/app/business/providers" className="inline-flex min-h-11 items-center rounded-lg px-2 text-slate-400 transition hover:bg-white/[0.04] hover:text-violet-200">
          Gérer les services IA
        </Link>
      </section>
      {showStaleNotice && (
        <section
          className={cn(
            'flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-4 py-3 text-[11.5px] leading-relaxed',
            noVerifiedProvider
              ? 'border-amber-400/25 bg-amber-400/[0.06] text-amber-100'
              : 'border-white/[0.08] bg-white/[0.02] text-slate-300',
          )}
          role="status"
          data-testid="business-stale-providers"
        >
          <span className="min-w-0">
            {noVerifiedProvider
              ? 'Le contrôle de disponibilité de vos services IA a expiré (validité serveur : 24 h). Aucune réponse ne sera simulée tant qu’un service n’aura pas été re-vérifié.'
              : `Le secours automatique est dégradé : ${staleProviders.length} service(s) configuré(s) n’a plus de contrôle valide (24 h).`}
          </span>
          <Button size="sm" variant="outline" icon={<RefreshCw size={12} />} onClick={() => go('providers')}>
            Ouvrir les services IA
          </Button>
        </section>
      )}

      {osModule === 'litiges' && (
        <LitigesWorkspace workspaceId={workspaceId} onOpenFinance={() => go('finance')} />
      )}

      {osModule === 'rentabilite' && (
        <RentabiliteWorkspace workspaceId={workspaceId} onOpenCatalog={() => go('catalog')} />
      )}

      {osModule === 'historique' && <HistoriqueAgent workspaceId={workspaceId} />}

      {osModule === 'overview' && (
        <>
          {/* Briefing quotidien en tête de l'accueil : trois priorités, une action préparée par l'agent. */}
          <BriefingDuJour workspaceId={workspaceId} onNavigate={go} />
          <GrowthOsOverview workspaceId={workspaceId} onNavigate={go} />
        </>
      )}
      {osModule === 'reports' && <GrowthOsReports workspaceId={workspaceId} />}

      {workspaceId && osModule === 'crm' && (
        <CrmWorkspace
          key="crm"
          workspaceId={workspaceId}
          legacyProspects={legacyProspects}
          initialContactId={crmContactId}
          onInitialContactHandled={() => setCrmContactId(null)}
          onCreateReceivable={(contactId) => { setFinanceContactId(contactId); go('finance'); }}
          onOpenFinance={() => go('finance')}
          onOpenAssistant={(prompt) => { setReportDraft(prompt); go('assistant'); }}
        />
      )}
      {workspaceId && osModule === 'pipeline' && (
        <CrmWorkspace
          key="pipeline"
          workspaceId={workspaceId}
          legacyProspects={legacyProspects}
          initialTab="pipeline"
          lockTab
          initialContactId={crmContactId}
          onInitialContactHandled={() => setCrmContactId(null)}
          onCreateReceivable={(contactId) => { setFinanceContactId(contactId); go('finance'); }}
          onOpenFinance={() => go('finance')}
          onOpenAssistant={(prompt) => { setReportDraft(prompt); go('assistant'); }}
        />
      )}
      {workspaceId && osModule === 'tasks' && (
        <CrmWorkspace
          key="tasks"
          workspaceId={workspaceId}
          legacyProspects={legacyProspects}
          initialTab="tasks"
          lockTab
          initialContactId={crmContactId}
          onInitialContactHandled={() => setCrmContactId(null)}
          onCreateReceivable={(contactId) => { setFinanceContactId(contactId); go('finance'); }}
          onOpenFinance={() => go('finance')}
          onOpenAssistant={(prompt) => { setReportDraft(prompt); go('assistant'); }}
        />
      )}
      {/* Relances : vraie séquence progressive de recouvrement. L'onglet CRM
          « relances » reste accessible depuis la fiche contact. */}
      {workspaceId && osModule === 'relances' && (
        <RecouvrementWorkspace
          key="relances"
          workspaceId={workspaceId}
          onOpenFinance={(contactId) => { if (contactId) setFinanceContactId(contactId); go('finance'); }}
        />
      )}

      {workspaceId && osModule === 'sales' && (
        <SalesWorkspace
          workspaceId={workspaceId}
          onOpenContact={(contactId) => { setCrmContactId(contactId); go('crm'); }}
          onOpenFinance={(contactId) => { if (contactId) setFinanceContactId(contactId); go('finance'); }}
        />
      )}
      {workspaceId && osModule === 'catalog' && <CatalogWorkspace workspaceId={workspaceId} />}
      {workspaceId && osModule === 'suppliers' && <SuppliersWorkspace workspaceId={workspaceId} />}
      {workspaceId && osModule === 'storefront' && (
        <StorefrontWorkspace
          workspaceId={workspaceId}
          workspaceName={workspace?.name ?? 'Mon entreprise'}
          onOpenContact={(contactId) => { setCrmContactId(contactId); go('crm'); }}
        />
      )}
      {workspaceId && osModule === 'cash' && (
        <CashWorkspace workspaceId={workspaceId} onOpenFinance={() => go('finance')} />
      )}
      {workspaceId && osModule === 'automation' && (
        <AutomationWorkspace
          workspaceId={workspaceId}
          onOpenContact={(contactId) => { setCrmContactId(contactId); go('crm'); }}
        />
      )}
      {workspaceId && osModule === 'marketing' && (
        <MarketingWorkspace
          workspaceId={workspaceId}
          onOpenContact={(contactId) => { setCrmContactId(contactId); go('crm'); }}
        />
      )}

      {workspaceId && osModule === 'finance' && (
        <FinanceWorkspace
          key="finance"
          workspaceId={workspaceId}
          initialContactId={financeContactId}
          onInitialContactHandled={() => setFinanceContactId(null)}
          onOpenContact={(contactId) => { setCrmContactId(contactId); go('crm'); }}
        />
      )}
      {workspaceId && osModule === 'recouvrement' && (
        <FinanceWorkspace
          key="recouvrement"
          workspaceId={workspaceId}
          initialTab="recouvrement"
          lockTab
          initialContactId={financeContactId}
          onInitialContactHandled={() => setFinanceContactId(null)}
          onOpenContact={(contactId) => { setCrmContactId(contactId); go('crm'); }}
        />
      )}

      {workspaceId && osModule === 'assistant' && (
        <AssistantView
          workspaceId={workspaceId}
          backendReady={backendReady}
          backendLoading={backendLoading}
          providers={providers}
          models={models}
          quota={quota}
          tools={tools}
          conversations={conversations}
          conversationsLoaded={conversationsLoaded}
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
          onProposeTask={proposeTask}
          onNewConversation={() => { void createConversation(); }}
          onRenameConversation={renameConversation}
          onDeleteConversation={deleteConversation}
          onSelectConversation={(id) => { if (selectedConversationRef.current === id) return; selectionRevision.current++; messageLoadSequence.current++; toolLoadSequence.current++; selectedConversationRef.current = id; setSelectedConversationId(id); setMessages([]); setTools([]); }}
          onSend={sendMessage}
          onRetry={() => { void refreshWorkspace(); void loadMessages(); }}
          draftFromReport={reportDraft}
          onDraftConsumed={() => setReportDraft(null)}
          onReportDraft={setReportDraft}
          onOpenIntegrations={() => go('integrations')}
        />
      )}

      {workspaceId && osModule === 'company' && <CompanyContextView workspace={workspace} />}

      {workspaceId && osModule === 'memory' && (
        <MemoryView
          workspaceId={workspaceId}
          memory={memory}
          loading={loadingMemory}
          busy={busy}
          error={memoryError}
          onConsent={saveMemoryConsent}
          onSaveProfile={saveMemoryProfile}
          onPutItem={(category, content, itemId) => mutateMemoryItem(() => { if (!workspaceId) throw new Error('Aucune entreprise active.'); return businessGrowApi.putMemoryItem(category, content, itemId ?? null, workspaceId); })}
          onDeleteItem={(id) => mutateMemoryItem(() => { if (!workspaceId) throw new Error('Aucune entreprise active.'); return businessGrowApi.deleteMemoryItem(id, workspaceId); })}
          onImportLegacy={importLegacyMemory}
          onRetry={() => { void loadMemory(); }}
        />
      )}

      {osModule === 'providers' && (
        <ProvidersView
          backendReady={backendReady}
          backendLoading={backendLoading}
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

      {osModule === 'ai' && (
        <AiControlCenterView
          memories={agentMemories}
          loading={agentMemoriesLoading}
          searching={agentSearching}
          error={agentMemoriesError}
          consent={memory?.consent === true}
          consentBusy={agentConsentBusy}
          savedRouting={savedRouting}
          requests={requests}
          onToggleConsent={toggleAgentMemoryConsent}
          onSearch={searchAgentMemory}
          onForget={forgetAgentMemory}
          onRetry={() => { void loadAgentMemories(); }}
          onOpenProviders={() => go('providers')}
        />
      )}

      {workspaceId && osModule === 'integrations' && (
        <section className="vy-surface p-5 sm:p-7" data-testid="business-integrations">
          <IntegrationsCenter
            workspaceId={workspaceId}
            embedded
            controller={{
              connections: integrations,
              loadError: integrationLoadError,
              subscriptionRefusal: integrationRefusal,
              busyKey: integrationBusyKey,
              notice: integrationNotice,
              onRetry: () => { void loadIntegrations().catch(() => {}); },
              onRequest: (connectorKey) => { void handleIntegrationAction('request', connectorKey); },
              onCancel: (connectorKey) => { void handleIntegrationAction('cancel', connectorKey); },
              onDisconnect: (connectorKey) => { void handleIntegrationAction('disconnect', connectorKey); },
            }}
          />
        </section>
      )}
    </GrowthOsLayout>
    </div>
  );
}
