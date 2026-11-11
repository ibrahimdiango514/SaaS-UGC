import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertCircle, ArrowRight, BarChart3, Brain, Building2, Check, ChevronRight, Clapperboard,
  FileText, History, Lightbulb, Package, Plug, RefreshCw, Settings2, ShieldCheck, Sparkles,
  Target, TrendingUp, Users, Zap,
} from 'lucide-react';
import { Button, LoadingState, ProgressBar, cn } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { businessGrowApi, type BusinessMemory } from '../api';
import { asAppError } from '../../lib/errors';
import { listProducts } from '../../lib/api';
import type { Workspace } from '../../lib/types';
import {
  buildGrowthPrompt, formatGrowthAmount, goalProgress, healthLabel, isGoalOverdue,
  mergeCompanyProfile, pipelineSummary, profileFromMemory, readCompetitors, readGoals,
  readProspects, readSignals, readStrategies, upcomingActions, GROWTH_CATEGORY,
  type CompanyProfile, type GrowthAiTask, type GrowthSnapshot,
} from './model';
const PIPELINE_STAGES = [
  { key: 'prospect' as const, label: 'Prospects', color: 'bg-cyan-400/80', dot: 'bg-cyan-300' },
  { key: 'contacte' as const, label: 'Contactés', color: 'bg-sky-400/80', dot: 'bg-sky-300' },
  { key: 'qualifie' as const, label: 'Qualifiés', color: 'bg-violet-400/80', dot: 'bg-violet-300' },
  { key: 'proposition' as const, label: 'Propositions', color: 'bg-amber-300/80', dot: 'bg-amber-200' },
  { key: 'gagne' as const, label: 'Gagnés', color: 'bg-emerald-400/80', dot: 'bg-emerald-300' },
  { key: 'perdu' as const, label: 'Perdus', color: 'bg-rose-400/70', dot: 'bg-rose-300' },
];

import {
  CatalogPanel, CompanyPanel, CrmPanel, GoalsPanel, GrowthKpi, MarketPanel, StrategyPanel,
} from './GrowthPanels';

type GrowthTab = 'overview' | 'company' | 'goals' | 'catalog' | 'market' | 'crm' | 'strategy' | 'activity' | 'settings';

const TABS: { id: GrowthTab; label: string; icon: typeof Target }[] = [
  { id: 'overview', label: 'Vue d’ensemble', icon: BarChart3 },
  { id: 'company', label: 'Entreprise', icon: Building2 },
  { id: 'goals', label: 'Objectifs', icon: Target },
  { id: 'catalog', label: 'Catalogue', icon: Package },
  { id: 'market', label: 'Marché', icon: TrendingUp },
  { id: 'crm', label: 'Prospects', icon: Users },
  { id: 'strategy', label: 'Stratégie', icon: FileText },
  { id: 'activity', label: 'Historique', icon: History },
  { id: 'settings', label: 'Paramètres', icon: Settings2 },
];

const CATEGORY_LABELS: Record<string, string> = {
  [GROWTH_CATEGORY.goal]: 'Objectif',
  [GROWTH_CATEGORY.prospect]: 'Prospect',
  [GROWTH_CATEGORY.competitor]: 'Concurrent',
  [GROWTH_CATEGORY.signal]: 'Signal marché',
  [GROWTH_CATEGORY.strategy]: 'Stratégie',
};

const TASK_LABEL: Record<GrowthAiTask, string> = {
  diagnostic: 'Diagnostic business',
  strategy: 'Plan de croissance',
  competition: 'Analyse concurrentielle',
  content: 'Stratégie de contenu UGC',
  sales: 'Analyse commerciale',
};

const TASK_ROLE: Record<GrowthAiTask, 'business_analysis' | 'action_plan' | 'content_strategy' | 'sales_analysis'> = {
  diagnostic: 'business_analysis',
  strategy: 'action_plan',
  competition: 'business_analysis',
  content: 'content_strategy',
  sales: 'sales_analysis',
};

function extractActions(answer: string): string[] {
  return answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-•*]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^([-•*]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 3)
    .slice(0, 12);
}

export default function GrowthWorkspace({
  workspace, workspaceId, memory, loadingMemory, memoryError, onReloadMemory, onOpenAssistant,
  onOpenIntegrations, onOpenProviders,
}: {
  workspace: Workspace | null;
  workspaceId: string | null;
  memory: BusinessMemory | null;
  loadingMemory: boolean;
  memoryError: string | null;
  onReloadMemory: () => Promise<void>;
  onOpenAssistant: (prompt?: string) => void;
  onOpenIntegrations?: () => void;
  onOpenProviders?: () => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<GrowthTab>('overview');
  const [products, setProducts] = useState<Array<{ name: string; description?: string | null; price?: string | null }>>([]);
  const [productsError, setProductsError] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiAnswer, setAiAnswer] = useState('');
  const [aiError, setAiError] = useState('');
  const [aiProvider, setAiProvider] = useState('');
  const [aiTask, setAiTask] = useState<GrowthAiTask>('diagnostic');
  const [consentBusy, setConsentBusy] = useState(false);

  const consent = Boolean(memory?.consent);
  const profile = useMemo(() => profileFromMemory(memory), [memory]);
  const goals = useMemo(() => readGoals(memory), [memory]);
  const prospects = useMemo(() => readProspects(memory), [memory]);
  const competitors = useMemo(() => readCompetitors(memory), [memory]);
  const signals = useMemo(() => readSignals(memory), [memory]);
  const strategies = useMemo(() => readStrategies(memory), [memory]);
  const pipeline = useMemo(() => pipelineSummary(prospects), [prospects]);
  const nextActions = useMemo(() => upcomingActions(prospects), [prospects]);
  const recordCount = goals.length + prospects.length + competitors.length + signals.length + strategies.length;
  const activity = useMemo(() => {
    const known = new Set<string>(Object.values(GROWTH_CATEGORY));
    return [...(memory?.items ?? [])]
      .filter((item) => known.has(item.category))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, 40)
      .map((item) => {
        const content = (item.content ?? {}) as Record<string, unknown>;
        const raw = content.title ?? content.name ?? content.company ?? content.nextAction;
        const title = typeof raw === 'string' && raw.trim() ? raw.trim() : (CATEGORY_LABELS[item.category] ?? 'Enregistrement');
        const parsed = Date.parse(item.updated_at);
        return {
          id: item.id,
          category: item.category,
          title: title.slice(0, 120),
          date: Number.isFinite(parsed)
            ? new Date(parsed).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
            : '—',
        };
      });
  }, [memory]);

  useEffect(() => {
    if (!workspaceId) { setProducts([]); return; }
    let active = true;
    void listProducts(workspaceId)
      .then((items) => {
        if (!active) return;
        setProductsError('');
        setProducts(items.map((product) => ({
          name: product.name, description: product.description,
          price: product.price_amount === null || product.price_amount === undefined
            ? null
            : formatGrowthAmount(Number(product.price_amount), product.price_currency ?? 'XOF'),
        })));
      })
      .catch((error) => { if (active) setProductsError(asAppError(error).message); });
    return () => { active = false; };
  }, [workspaceId]);

  const snapshot: GrowthSnapshot = useMemo(() => ({
    company: profile,
    goals,
    prospects,
    competitors,
    signals,
    products,
    workspaceName: workspace?.name,
  }), [profile, goals, prospects, competitors, signals, products, workspace?.name]);

  const putRecord = useCallback(async (category: string, content: unknown, itemId?: string | null) => {
    await businessGrowApi.putMemoryItem(category, content, itemId ?? null);
    await onReloadMemory();
  }, [onReloadMemory]);

  const deleteRecord = useCallback(async (itemId: string) => {
    await businessGrowApi.deleteMemoryItem(itemId);
    await onReloadMemory();
  }, [onReloadMemory]);

  const saveCompany = useCallback(async (patch: Partial<CompanyProfile>) => {
    try {
      await businessGrowApi.saveMemoryProfile(mergeCompanyProfile(memory?.profile, patch));
      await onReloadMemory();
      toast.success('Informations de l’entreprise enregistrées.');
    } catch (error) {
      toast.error(asAppError(error).message);
      throw error;
    }
  }, [memory?.profile, onReloadMemory, toast]);

  const setConsent = useCallback(async (enabled: boolean) => {
    setConsentBusy(true);
    try {
      await businessGrowApi.setMemoryConsent(enabled);
      await onReloadMemory();
      toast.success(enabled ? 'Mémoire métier activée.' : 'Mémoire métier désactivée.');
    } catch (error) {
      toast.error(asAppError(error).message);
    } finally {
      setConsentBusy(false);
    }
  }, [onReloadMemory, toast]);

  const askAi = useCallback(async (task: GrowthAiTask) => {
    if (!workspaceId) {
      setAiError('Aucun espace de travail actif : impossible de charger le contexte entreprise.');
      return;
    }
    setAiTask(task);
    setAiBusy(true);
    setAiError('');
    setAiAnswer('');
    setAiProvider('');
    try {
      const conversation = await businessGrowApi.createConversation(`VYORA Croissance · ${TASK_LABEL[task]}`, workspaceId);
      const sent = await businessGrowApi.sendMessage(
        conversation.conversationId,
        buildGrowthPrompt(task, snapshot),
        crypto.randomUUID(),
        { roleKey: TASK_ROLE[task], workspaceId },
      );
      const listed = await businessGrowApi.listMessages(conversation.conversationId);
      const reply = [...listed.messages].reverse().find((message) => message.author_role === 'assistant' && message.content.trim());
      if (!reply) {
        setAiError('Le service IA n’a pas renvoyé de réponse exploitable. Réessayez ou vérifiez les services IA dans l’onglet Services IA.');
        return;
      }
      setAiProvider(sent.provider?.key ?? '');
      setAiAnswer(reply.content);
      toast.success('Analyse IA générée.');
    } catch (error) {
      const message = asAppError(error).message;
      setAiError(message);
      toast.error(message);
    } finally {
      setAiBusy(false);
    }
  }, [snapshot, toast, workspaceId]);

  const saveAiStrategy = useCallback(async () => {
    if (!aiAnswer) return;
    try {
      await putRecord(GROWTH_CATEGORY.strategy, {
        title: TASK_LABEL[aiTask],
        horizon: aiTask === 'strategy' ? '30/60/90 jours' : '',
        summary: aiAnswer,
        actions: extractActions(aiAnswer),
        source: 'ia',
        createdAt: new Date().toISOString(),
      });
      toast.success('Plan IA enregistré dans votre mémoire métier.');
    } catch (error) {
      toast.error(asAppError(error).message);
    }
  }, [aiAnswer, aiTask, putRecord, toast]);

  const activeGoals = goals.filter((goal) => goal.status === 'en_cours');
  const overdueGoals = goals.filter((goal) => isGoalOverdue(goal));
  const openTab = (next: GrowthTab) => setTab(next);

  return (
    <div className="space-y-4 animate-fadeUp" data-testid="growth-os">
      <header className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#080d15] px-5 py-6 sm:px-7">
        <div aria-hidden="true" className="pointer-events-none absolute -left-16 -top-24 h-56 w-56 rounded-full bg-violet-500/20 blur-[90px]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-28 right-4 h-56 w-56 rounded-full bg-cyan-400/10 blur-[90px]" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-200">
              <Brain size={14} /> VYORA · Growth OS
            </div>
            <h2 className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">Votre cerveau commercial</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
              Entreprise, objectifs, catalogue, marché, contenus et pipeline réunis dans une mémoire que l’IA exploite réellement.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium',
              consent
                ? 'border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-100'
                : 'border-amber-400/25 bg-amber-400/[0.07] text-amber-100')}>
              <span className={cn('h-1.5 w-1.5 rounded-full', consent ? 'bg-emerald-300' : 'bg-amber-300')} />
              {healthLabel(consent, recordCount)}
            </span>
            <Link
              to="/app/studio"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
            >
              <Clapperboard size={13} /> Créer dans le Studio
            </Link>
            <Button size="sm" variant="outline" icon={<RefreshCw size={13} />} onClick={() => void onReloadMemory()} disabled={loadingMemory}>
              Actualiser
            </Button>
          </div>
        </div>
      </header>

      {!consent && (
        <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.05] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-2xl">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-100"><ShieldCheck size={15} /> Mémoire métier requise</p>
              <p className="mt-1 text-xs leading-relaxed text-amber-100/80">
                VYORA conserve le contexte de votre entreprise dans une mémoire privée, isolée par compte et supprimable à tout moment.
                Sans consentement, aucune information ne peut être enregistrée et l’IA ne dispose d’aucun contexte.
              </p>
            </div>
            <Button size="sm" variant="primary" loading={consentBusy} icon={<Check size={13} />} onClick={() => void setConsent(true)}>
              Activer la mémoire métier
            </Button>
          </div>
        </section>
      )}

      {memoryError && (
        <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2.5 text-xs text-rose-200">
          <p className="flex items-center gap-1.5 font-semibold"><AlertCircle size={13} /> {memoryError}</p>
        </div>
      )}

      <nav aria-label="Navigation Growth OS" className="no-scrollbar flex gap-1.5 overflow-x-auto rounded-2xl border border-white/[0.07] bg-[#080d15]/70 p-1.5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" onClick={() => openTab(id)} aria-current={tab === id ? 'page' : undefined}
            className={cn('flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium transition',
              tab === id ? 'bg-gradient-to-r from-cyan-400/15 to-violet-400/10 text-white ring-1 ring-inset ring-cyan-300/20' : 'text-slate-400 hover:bg-white/[0.04] hover:text-white')}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </nav>

      {loadingMemory && !memory ? (
        <LoadingState label="Chargement de votre mémoire métier…" />
      ) : tab === 'overview' ? (
        <div className="space-y-4">
          <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <GrowthKpi icon={<Target size={13} className="text-cyan-300" />} label="Objectifs en cours" value={String(activeGoals.length)} hint={overdueGoals.length ? `${overdueGoals.length} en retard` : `${goals.length} objectif(s) au total`} />
            <GrowthKpi icon={<Users size={13} className="text-violet-300" />} label="Pipeline ouvert" value={formatGrowthAmount(pipeline.openValue, prospects[0]?.currency ?? 'XOF')} hint={`${pipeline.openCount} opportunité(s) active(s)`} />
            <GrowthKpi icon={<TrendingUp size={13} className="text-emerald-300" />} label="Ventes gagnées" value={formatGrowthAmount(pipeline.wonValue, prospects[0]?.currency ?? 'XOF')} hint={`${pipeline.byStage.gagne} client(s) gagné(s)`} />
            <GrowthKpi icon={<Activity size={13} className="text-amber-300" />} label="Signaux marché" value={String(signals.length)} hint={`${competitors.length} concurrent(s) suivi(s)`} />
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)]">
            <section className="vyora-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Progression</p>
                  <h3 className="mt-1 text-sm font-semibold text-white">Objectifs commerciaux</h3>
                </div>
                <Button size="sm" variant="ghost" onClick={() => openTab('goals')}>Gérer <ChevronRight size={12} /></Button>
              </div>
              {goals.length === 0 ? (
                <div className="mt-4 rounded-xl border border-dashed border-white/15 p-4 text-center">
                  <Target size={18} className="mx-auto text-slate-600" />
                  <p className="mt-2 text-xs font-semibold text-white">Aucun objectif défini</p>
                  <p className="mt-1 text-[11px] text-slate-500">Un objectif mesurable permet à l’IA de prioriser ses recommandations.</p>
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => openTab('goals')}>Définir un objectif</Button>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  {goals.slice(0, 4).map((goal) => (
                    <div key={goal.id}>
                      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate text-slate-300">{goal.title}</span>
                        <span className="shrink-0 text-slate-500">{goal.current}/{goal.target} {goal.unit}</span>
                      </div>
                      <ProgressBar value={goalProgress(goal)} max={100} tone={goalProgress(goal) >= 100 ? 'emerald' : 'cyan'} />
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="vyora-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-200">Relances</p>
                  <h3 className="mt-1 text-sm font-semibold text-white">Prochaines actions</h3>
                </div>
                <Button size="sm" variant="ghost" onClick={() => openTab('crm')}>Pipeline <ChevronRight size={12} /></Button>
              </div>
              {nextActions.length === 0 ? (
                <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
                  Aucune relance planifiée. Ajoutez un prospect avec une prochaine action et une date pour la voir apparaître ici.
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {nextActions.map((prospect) => (
                    <li key={prospect.id} className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2">
                      <p className="truncate text-[12px] font-medium text-white">{prospect.nextAction}</p>
                      <p className="mt-0.5 text-[10px] text-slate-500">{prospect.name || prospect.company}{prospect.nextActionAt ? ` · ${prospect.nextActionAt}` : ''}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="vyora-card p-5" data-testid="growth-pipeline-chart">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-200">Pipeline commercial</p>
                <h3 className="mt-1 text-sm font-semibold text-white">Répartition réelle de vos opportunités</h3>
              </div>
              <span className="text-[11px] text-slate-400">{pipeline.totalCount} opportunité(s) · {formatGrowthAmount(pipeline.openValue + pipeline.wonValue, prospects[0]?.currency ?? 'XOF')}</span>
            </div>
            {pipeline.totalCount === 0 ? (
              <p className="mt-3 text-[11px] text-slate-500">Aucune opportunité enregistrée. Ajoutez un prospect pour voir votre pipeline se construire.</p>
            ) : (
              <>
                <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-white/[0.06]" role="img" aria-label="Répartition du pipeline par étape">
                  {PIPELINE_STAGES.map(({ key, label, color }) => {
                    const count = pipeline.byStage[key];
                    if (!count) return null;
                    return (
                      <div
                        key={key}
                        className={cn('h-full transition-all', color)}
                        style={{ width: `${(count / pipeline.totalCount) * 100}%` }}
                        title={`${label} : ${count}`}
                      />
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                  {PIPELINE_STAGES.map(({ key, label, dot }) => (
                    <span key={key} className="inline-flex items-center gap-1.5 text-[10px] text-slate-400">
                      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} /> {label} <span className="font-semibold text-slate-200">{pipeline.byStage[key]}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="vyora-card overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 p-5">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Intelligence</p>
                <h3 className="mt-1 text-sm font-semibold text-white">Diagnostic business par l’IA</h3>
                <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-slate-400">
                  L’IA lit votre contexte réel et propose un diagnostic actionnable. Elle n’invente aucun chiffre et ne prétend pas naviguer sur le web.
                </p>
              </div>
              <Button size="sm" variant="primary" icon={<Sparkles size={13} />} loading={aiBusy} onClick={() => void askAi('diagnostic')}>
                Lancer le diagnostic
              </Button>
            </div>
            {(aiAnswer || aiError) && aiTask === 'diagnostic' && (
              <div className="border-t border-white/[0.06] p-5">
                {aiError ? <p className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-200">{aiError}</p>
                  : <div className="max-h-[420px] overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-slate-200">{aiAnswer}</div>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {aiAnswer && <Button size="sm" variant="outline" icon={<Check size={12} />} onClick={() => void saveAiStrategy()}>Enregistrer dans la mémoire</Button>}
                  {aiAnswer && <Button size="sm" variant="ghost" icon={<ArrowRight size={12} />} onClick={() => openTab('strategy')}>Voir les plans</Button>}
                </div>
              </div>
            )}
          </section>

          <section className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { label: 'Compléter l’entreprise', hint: 'Offre, cible, marché, canaux', tab: 'company' as GrowthTab, icon: Building2 },
              { label: 'Importer le catalogue', hint: 'Produits et prix réels', tab: 'catalog' as GrowthTab, icon: Package },
              { label: 'Analyser la concurrence', hint: 'Concurrents et signaux', tab: 'market' as GrowthTab, icon: TrendingUp },
              { label: 'Suivre les prospects', hint: 'Pipeline et relances', tab: 'crm' as GrowthTab, icon: Users },
              { label: 'Générer une stratégie', hint: 'Plan 30/60/90 jours', tab: 'strategy' as GrowthTab, icon: Lightbulb },
              { label: 'Ouvrir l’assistant', hint: 'Conversation avec mémoire', tab: 'overview' as GrowthTab, icon: Brain, action: () => onOpenAssistant() },
            ].map(({ label, hint, tab: target, icon: Icon, action }) => (
              <button key={label} type="button" onClick={() => { if (action) action(); else openTab(target); }}
                className="group flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5 text-left transition hover:border-cyan-300/25 hover:bg-cyan-400/[0.04]">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-black/20 text-cyan-200"><Icon size={15} /></span>
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-semibold text-white">{label}</span>
                  <span className="block truncate text-[10px] text-slate-500">{hint}</span>
                </span>
                <ChevronRight size={13} className="ml-auto shrink-0 text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-cyan-200" />
              </button>
            ))}
          </section>

          {!workspaceId && (
            <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2.5 text-xs text-amber-100">
              Aucun espace de travail actif : certaines actions restent bloquées jusqu’à la création ou la sélection d’un espace.
            </div>
          )}
        </div>
      ) : tab === 'company' ? (
        <CompanyPanel profile={profile} workspace={workspace} busy={consentBusy} consent={consent} onSave={saveCompany} onConsent={setConsent} />
      ) : tab === 'goals' ? (
        <GoalsPanel goals={goals} busy={false} onPut={putRecord} onDelete={deleteRecord} />
      ) : tab === 'catalog' ? (
        <CatalogPanel workspaceId={workspaceId} />
      ) : tab === 'market' ? (
        <MarketPanel competitors={competitors} signals={signals} busy={false} onPut={putRecord} onDelete={deleteRecord}
          analyzing={aiBusy && aiTask === 'competition'} onAnalyze={() => askAi('competition')} />
      ) : tab === 'crm' ? (
        <CrmPanel prospects={prospects} busy={false} onPut={putRecord} onDelete={deleteRecord} />
      ) : tab === 'activity' ? (
        <div className="space-y-4" data-testid="growth-activity">
          <section className="vyora-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Historique</p>
                <h3 className="mt-1 text-sm font-semibold text-white">Activité enregistrée dans votre mémoire</h3>
              </div>
              <span className="text-[11px] text-slate-400">{activity.length} entrée(s)</span>
            </div>
            {activity.length === 0 ? (
              <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
                Aucune activité métier enregistrée pour le moment. Les objectifs, prospects, concurrents, signaux et plans créés apparaîtront ici.
              </p>
            ) : (
              <ol className="mt-4 space-y-2">
                {activity.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5">
                    <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-cyan-200">
                      {CATEGORY_LABELS[entry.category] ?? 'Métier'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200">{entry.title}</span>
                    <span className="text-[10px] text-slate-500">{entry.date}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section className="grid gap-3 sm:grid-cols-3">
            <GrowthKpi icon={<Target size={13} className="text-cyan-300" />} label="Objectifs" value={String(goals.length)} hint="Tous statuts" />
            <GrowthKpi icon={<Users size={13} className="text-violet-300" />} label="Prospects" value={String(prospects.length)} hint="Pipeline complet" />
            <GrowthKpi icon={<FileText size={13} className="text-emerald-300" />} label="Plans" value={String(strategies.length)} hint="IA et utilisateur" />
          </section>
        </div>
      ) : tab === 'settings' ? (
        <div className="space-y-4" data-testid="growth-settings">
          <section className="vyora-card p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-200">Mémoire métier</p>
            <h3 className="mt-1 text-sm font-semibold text-white">Consentement et périmètre</h3>
            <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-slate-400">
              La mémoire métier conserve votre entreprise, vos objectifs, vos produits, vos concurrents et vos prospects.
              Elle n’est lue par l’IA que si vous l’avez autorisée, et reste isolée dans votre espace de travail.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Consentement</p>
                <p className={cn('mt-1 text-sm font-semibold', consent ? 'text-emerald-200' : 'text-amber-200')}>
                  {consent ? 'Activé' : 'Désactivé'}
                </p>
                <p className="mt-1 text-[10px] text-slate-500">Version de politique : {memory?.policyVersion ?? '—'}</p>
              </div>
              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Espace de travail</p>
                <p className="mt-1 truncate text-sm font-semibold text-white">{workspace?.name ?? 'Aucun espace actif'}</p>
                <p className="mt-1 text-[10px] text-slate-500">{recordCount} enregistrement(s) métier</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant={consent ? 'outline' : 'primary'} loading={consentBusy} onClick={() => void setConsent(!consent)}>
                {consent ? 'Désactiver la mémoire' : 'Activer la mémoire métier'}
              </Button>
              <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void onReloadMemory()} disabled={loadingMemory}>
                Recharger mes données
              </Button>
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <button type="button" onClick={onOpenIntegrations} disabled={!onOpenIntegrations}
              className="group vyora-card flex items-start gap-3 p-4 text-left transition hover:border-cyan-300/25 disabled:cursor-not-allowed disabled:opacity-60">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-black/20 text-cyan-200"><Plug size={15} /></span>
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold text-white">Intégrations</span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">Facebook, Instagram, WhatsApp, YouTube, TikTok, Shopify — connexions officielles après autorisation.</span>
              </span>
              <ChevronRight size={13} className="ml-auto mt-1 shrink-0 text-slate-600 group-hover:text-cyan-200" />
            </button>
            <button type="button" onClick={onOpenProviders} disabled={!onOpenProviders}
              className="group vyora-card flex items-start gap-3 p-4 text-left transition hover:border-violet-300/25 disabled:cursor-not-allowed disabled:opacity-60">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-black/20 text-violet-200"><Brain size={15} /></span>
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold text-white">Fournisseurs IA</span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">Disponibilité et clés vérifiées côté serveur. Aucune clé n’est exposée au navigateur.</span>
              </span>
              <ChevronRight size={13} className="ml-auto mt-1 shrink-0 text-slate-600 group-hover:text-violet-200" />
            </button>
          </section>

          <section className="rounded-xl border border-white/[0.07] bg-black/20 px-4 py-3">
            <p className="flex items-center gap-2 text-[11px] text-slate-300"><ShieldCheck size={13} className="text-emerald-300" /> Vos données restent isolées par espace et ne sont jamais partagées entre comptes.</p>
          </section>
        </div>
      ) : (
        <StrategyPanel
          strategies={strategies}
          busy={false}
          answer={aiAnswer}
          aiBusy={aiBusy}
          aiError={aiError}
          aiProvider={aiProvider}
          aiTask={TASK_LABEL[aiTask]}
          onGenerate={() => askAi('strategy')}
          onSaveAnswer={saveAiStrategy}
          onPut={putRecord}
          onDelete={deleteRecord}
        />
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2.5 text-[10px] text-slate-500">
        <span className="flex items-center gap-1.5"><Zap size={11} className="text-cyan-300" /> Quota Business Grow distinct des crédits Studio UGC.</span>
        <span className="flex items-center gap-1.5"><Plug size={11} /> Connecteurs sociaux et e-commerce : autorisation utilisateur requise avant toute lecture.</span>
      </footer>

      {productsError && (
        <p className="text-[10px] text-amber-200">Catalogue produits partiellement indisponible : {productsError}</p>
      )}
    </div>
  );
}
