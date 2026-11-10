import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight, Brain, Building2, Check, ExternalLink, FileText, Lightbulb, LockKeyhole,
  MessageSquare, Package, Pencil, RefreshCw, Send, ShieldCheck, Sparkles, Trash2, X, Zap,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, LoadingState, Toggle, cn } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { listBrands, listProducts } from '../lib/api';
import type { Brand, Product, Workspace } from '../lib/types';
import {
  BusinessGrowApiError, businessGrowApi,
  type BusinessConversation, type BusinessMemory, type BusinessMessage, type BusinessProviderStatus,
} from './api';
import {
  BUSINESS_PROVIDERS, type BusinessCapability,
} from './ai/registry';

type BusinessSection = 'chat' | 'company' | 'memory' | 'providers';

const SECTIONS: { id: BusinessSection; label: string; icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Assistant', icon: MessageSquare },
  { id: 'company', label: 'Entreprise', icon: Building2 },
  { id: 'memory', label: 'Mémoire métier', icon: Building2 },
  { id: 'providers', label: 'Fournisseurs IA', icon: Zap },
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

function providerStatus(provider: BusinessProviderStatus | undefined) {
  if (!provider) return { label: 'Non vérifié', description: 'Le statut serveur n’a pas pu être vérifié.' };
  if (provider.config_status !== 'configured') {
    return { label: 'Non configuré', description: 'Aucune configuration serveur utilisable n’est disponible.' };
  }
  if (!provider.enabled) {
    return { label: 'Non vérifié', description: 'Le modèle configuré n’a pas été vérifié récemment.' };
  }
  if (provider.status === 'available') {
    return { label: 'Disponible', description: 'La disponibilité a été vérifiée côté serveur.' };
  }
  if (provider.status === 'degraded') {
    return { label: 'Dégradé', description: 'Le service nécessite une nouvelle vérification.' };
  }
  return { label: provider.status === 'unavailable' ? 'Indisponible' : 'Non vérifié', description: 'Le fournisseur n’est pas disponible pour le routage.' };
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
            <Badge tone={status.label === 'Disponible' ? 'success' : 'neutral'}>{status.label}</Badge>
          </div>
        );
      })}
    </div>
  );
}

function AssistantView({
  backendReady,
  providers,
  conversations,
  selectedConversationId,
  messages,
  loading,
  error,
  busy,
  onNewConversation,
  onRenameConversation,
  onDeleteConversation,
  onSelectConversation,
  onSend,
  onRetry,
}: {
  backendReady: boolean;
  providers: BusinessProviderStatus[] | null;
  conversations: BusinessConversation[];
  selectedConversationId: string | null;
  messages: BusinessMessage[];
  loading: boolean;
  error: string | null;
  busy: boolean;
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
  const availableProviders = (providers ?? []).filter((provider) =>
    provider.enabled && provider.status === 'available' && provider.config_status === 'configured',
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy || !backendReady) return;
    if (await onSend(content)) setDraft('');
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <section className="flex min-h-[620px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#090d16]">
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-4 sm:px-6">
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

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-6" aria-live="polite">
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
                    ? `Réponse fournie par ${BUSINESS_PROVIDERS.find((provider) => provider.id === message.request_provider_key)?.name ?? message.request_provider_key}${message.request_model_key ? ` · ${message.request_model_key}` : ''}`
                    : null}
                </p>
              )}
            </article>
          ))}
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

function ProvidersView({ statuses }: { statuses: BusinessProviderStatus[] | null }) {
  const byKey = new Map((statuses ?? []).map((status) => [status.provider_key, status]));
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-panel/50 p-5 sm:p-7">
      <div className="mb-5 max-w-2xl">
        <h2 className="text-lg font-semibold text-white">Registre des fournisseurs</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Les rôles affichés sont des propositions. L’AI Director ne peut router que vers un fournisseur configuré, vérifié et disponible côté serveur.
        </p>
      </div>
      <div className="space-y-3">
        {BUSINESS_PROVIDERS.map((provider) => {
          const status = providerStatus(byKey.get(provider.id));
          return (
            <article key={provider.id} className="rounded-xl border border-white/[0.07] bg-black/15 p-4" data-testid={`provider-${provider.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-white">{provider.name}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">{status.description}</p>
                </div>
                <Badge tone="neutral">{status.label}</Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {provider.proposedCapabilities.map((capability) => (
                  <span key={capability} className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-2 py-1 text-[10px] text-slate-400">
                    {CAPABILITY_LABELS[capability]}
                  </span>
                ))}
              </div>
              {provider.note && <p className="mt-3 text-[11px] text-slate-500">{provider.note}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default function BusinessGrowWorkspace() {
  const { user, session, workspace, workspaceId } = useAuth();
  const [section, setSection] = useState<BusinessSection>('chat');
  const [providers, setProviders] = useState<BusinessProviderStatus[] | null>(null);
  const [conversations, setConversations] = useState<BusinessConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BusinessMessage[]>([]);
  const [memory, setMemory] = useState<BusinessMemory | null>(null);
  const [backendReady, setBackendReady] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMemory, setLoadingMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const messageLoadSequence = useRef(0);

  const loadConversations = useCallback(async () => {
    const result = await businessGrowApi.listConversations();
    setConversations(result.conversations);
    setSelectedConversationId((current) =>
      current && result.conversations.some((conversation) => conversation.id === current)
        ? current
        : result.conversations[0]?.id ?? null,
    );
  }, []);

  const loadStatus = useCallback(async () => {
    const result = await businessGrowApi.getStatus();
    setProviders(result.providers);
  }, []);

  const refreshWorkspace = useCallback(async () => {
    if (!user || !session) {
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
    if (statusResult.status === 'fulfilled' && conversationsResult.status === 'fulfilled') {
      setBackendReady(true);
      return;
    }
    setBackendReady(false);
    setError(statusResult.status === 'rejected'
      ? statusResult.reason instanceof Error ? statusResult.reason.message : 'Le registre IA est indisponible.'
      : conversationsResult.status === 'rejected' && conversationsResult.reason instanceof Error
        ? conversationsResult.reason.message
        : 'Le backend Business Grow n’est pas encore installé ou accessible.');
  }, [loadConversations, loadStatus, session, user]);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  const loadMessages = useCallback(async () => {
    const sequence = ++messageLoadSequence.current;
    if (!selectedConversationId || !backendReady) {
      setMessages([]);
      setLoadingMessages(false);
      return;
    }
    setLoadingMessages(true);
    try {
      const result = await businessGrowApi.listMessages(selectedConversationId);
      if (messageLoadSequence.current === sequence) {
        setMessages(result.messages);
        setError(null);
      }
    } catch (loadError) {
      if (messageLoadSequence.current === sequence) {
        setError(loadError instanceof Error ? loadError.message : 'Impossible de charger les messages.');
      }
    } finally {
      if (messageLoadSequence.current === sequence) setLoadingMessages(false);
    }
  }, [backendReady, selectedConversationId]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  const loadMemory = useCallback(async () => {
    setLoadingMemory(true);
    setMemoryError(null);
    try {
      setMemory(await businessGrowApi.getMemory());
    } catch (loadError) {
      setMemoryError(loadError instanceof Error ? loadError.message : 'Impossible de charger la mémoire.');
    } finally {
      setLoadingMemory(false);
    }
  }, []);

  useEffect(() => {
    if (section === 'memory' && backendReady) void loadMemory();
  }, [backendReady, loadMemory, section]);

  const createConversation = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await businessGrowApi.createConversation('Nouvelle conversation', workspaceId);
      await loadConversations();
      setSelectedConversationId(result.conversationId);
      setMessages([]);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Impossible de créer la conversation.');
    } finally {
      setBusy(false);
    }
  }, [loadConversations, workspaceId]);

  const renameConversation = useCallback(async (conversationId: string, title: string): Promise<boolean> => {
    setError(null);
    try {
      await businessGrowApi.renameConversation(conversationId, title);
      await loadConversations();
      return true;
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : 'Impossible de renommer la conversation.');
      return false;
    }
  }, [loadConversations]);

  const deleteConversation = useCallback(async (conversationId: string): Promise<boolean> => {
    setError(null);
    try {
      await businessGrowApi.deleteConversation(conversationId);
      if (selectedConversationId === conversationId) {
        setSelectedConversationId(null);
        setMessages([]);
      }
      await loadConversations();
      return true;
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Impossible de supprimer la conversation.');
      return false;
    }
  }, [loadConversations, selectedConversationId]);

  const sendMessage = useCallback(async (content: string): Promise<boolean> => {
    setError(null);
    setBusy(true);
    let conversationId = selectedConversationId;
    try {
      if (!conversationId) {
        const result = await businessGrowApi.createConversation('Nouvelle conversation', workspaceId);
        conversationId = result.conversationId;
        setSelectedConversationId(conversationId);
      }
      await businessGrowApi.sendMessage(conversationId, content, crypto.randomUUID());
      await Promise.all([
        loadConversations(),
        businessGrowApi.listMessages(conversationId).then((result) => setMessages(result.messages)),
      ]);
      return true;
    } catch (sendError) {
      const code = sendError instanceof BusinessGrowApiError
        ? sendError.code
        : typeof sendError === 'object' && sendError !== null && 'code' in sendError && typeof sendError.code === 'string'
          ? sendError.code
          : null;
      if (code && [
        'NO_VERIFIED_PROVIDER',
        'PROVIDER_NOT_CONFIGURED',
        'PROVIDER_MODEL_MISMATCH',
        'PROVIDER_AUTH_FAILED',
        'PROVIDER_RATE_LIMITED',
        'PROVIDER_UNAVAILABLE',
        'PROVIDER_TIMEOUT',
        'PROVIDER_NETWORK_ERROR',
        'PROVIDER_REQUEST_REJECTED',
        'PROVIDER_INVALID_RESPONSE',
        'PROVIDER_EMPTY_RESPONSE',
      ].includes(code)) {
        setError(sendError instanceof Error ? sendError.message : 'Aucun fournisseur IA vérifié n’est disponible.');
        await Promise.allSettled([
          loadConversations(),
          conversationId
            ? businessGrowApi.listMessages(conversationId).then((result) => setMessages(result.messages))
            : Promise.resolve(),
        ]);
        return true;
      } else {
        setError(sendError instanceof Error ? sendError.message : 'Impossible d’envoyer la demande.');
        return false;
      }
    } finally {
      setBusy(false);
    }
  }, [loadConversations, loadMessages, selectedConversationId, workspaceId]);

  const saveMemoryConsent = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setMemoryError(null);
    try {
      await businessGrowApi.setMemoryConsent(enabled);
      await loadMemory();
    } catch (consentError) {
      setMemoryError(consentError instanceof Error ? consentError.message : 'Impossible de modifier le consentement.');
    } finally {
      setBusy(false);
    }
  }, [loadMemory]);

  const saveMemoryProfile = useCallback(async (profile: Record<string, unknown>) => {
    setBusy(true);
    setMemoryError(null);
    try {
      await businessGrowApi.saveMemoryProfile(profile);
      await loadMemory();
    } catch (saveError) {
      setMemoryError(saveError instanceof Error ? saveError.message : 'Impossible d’enregistrer le profil.');
    } finally {
      setBusy(false);
    }
  }, [loadMemory]);

  const mutateMemoryItem = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setMemoryError(null);
    try {
      await operation();
      await loadMemory();
    } catch (itemError) {
      setMemoryError(itemError instanceof Error ? itemError.message : 'Impossible de modifier la mémoire.');
    } finally {
      setBusy(false);
    }
  }, [loadMemory]);

  const activeSection = useMemo(() => SECTIONS.find((item) => item.id === section) ?? SECTIONS[0], [section]);
  const ActiveIcon = activeSection.icon;
  const availableProviderCount = (providers ?? []).filter((provider) =>
    provider.enabled && provider.status === 'available' && provider.config_status === 'configured',
  ).length;

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
          <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/[0.06] px-3 py-1.5 text-xs font-medium text-amber-100" data-testid="business-overall-status">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
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
              conversations={conversations}
              selectedConversationId={selectedConversationId}
              messages={messages}
              loading={loadingMessages}
              error={error}
              busy={busy}
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
          {section === 'providers' && <ProvidersView statuses={providers} />}
        </div>
      </div>
    </div>
  );
}
