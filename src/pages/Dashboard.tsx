import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Brain, Clapperboard, Coins, FolderKanban, Play, Plus, Sparkles, Wand2,
  CheckCircle2, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { PageHeader, StatCard, Card, CardHeader, Badge, Button, LoadingState, ErrorState, EmptyState, ProgressBar, Banner } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { businessGrowBridge } from '../business';
import { buildBusinessGrowLocationState, type BusinessGrowPlatformSnapshot } from '../contracts/business-grow';
import { asAppError } from '../lib/errors';
import { formatDate, relativeDate, statusLabel, truncate } from '../lib/format';
import { countAssets, healthCheck, listJobs, listProjects } from '../lib/api';
import type { GenerationJob, Project } from '../lib/types';

export default function Dashboard() {
  const { profile, quota, refreshQuota } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [assetCount, setAssetCount] = useState(0);
  const [health, setHealth] = useState<Record<string, boolean> | null>(null);
  const [businessSnapshot, setBusinessSnapshot] = useState<BusinessGrowPlatformSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [p, j, totalAssets, bgSnap] = await Promise.all([
        listProjects(), listJobs(8), countAssets(),
        businessGrowBridge.getSnapshot().catch(() => null),
      ]);
      setProjects(p); setJobs(j); setAssetCount(totalAssets);
      setBusinessSnapshot(bgSnap);
      try { setHealth((await healthCheck()).configured); } catch { setHealth(null); }
      await refreshQuota();
    } catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [refreshQuota]);

  useEffect(() => { void load(); }, [load]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';
  const videosUsed = quota?.usage?.video ?? 0;
  const scriptsUsed = quota?.usage?.script ?? 0;
  const promptsUsed = quota?.usage?.prompt ?? 0;

  return (
    <>
      <PageHeader eyebrow="Vue d’ensemble" title={`${greeting}, ${profile?.display_name?.split(' ')[0] || 'bienvenue'} 👋`}
        description="Votre activité Reelora en temps réel."
        actions={<>
          <Button variant="ghost" size="sm" onClick={() => void load()} icon={<RefreshCw size={14} />}>Actualiser</Button>
          <Link to="/app/studio" className="btn btn-primary btn-sm"><Play size={14} /> Nouvelle création</Link>
        </>} />

      {health && (!health.groq || !health.muapi) && (
        <div className="mb-6">
          <Banner tone="warning" title="Intégrations IA à finaliser">
            {!health.groq && 'GROQ_API_KEY est absent : la génération de scripts et prompts avec Groq est indisponible. '}
            {!health.muapi && 'MUAPI_API_KEY est absent : la génération vidéo avec MuAPI est indisponible. '}
            Les secrets se configurent côté serveur, dans Supabase → Edge Functions → Secrets. Aucune donnée fictive n’est présentée.
          </Banner>
        </div>
      )}

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Projets actifs" value={loading ? '…' : quota?.projects ?? 0} icon={<FolderKanban size={19} />} hint={`${quota?.plan?.max_projects ?? 0} autorisés par votre formule`} />
        <StatCard label="Vidéos ce mois-ci" value={quota?.usage?.video ?? '—'} icon={<Clapperboard size={19} />} hint={`Période ${quota?.period ?? 'indisponible'}`} tone="cyan" />
        <StatCard label="Crédits disponibles" value={quota?.credits ?? 0} icon={<Coins size={19} />} hint={`Formule ${quota?.plan?.display_name ?? '—'}`} tone="amber" />
        <StatCard label="Créations en bibliothèque" value={loading ? '…' : assetCount} icon={<Sparkles size={19} />} hint="Total enregistré, fichiers privés" tone="emerald" />
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Projets récents" description="Reprenez là où vous vous êtes arrêté."
            action={<Link to="/app/projets" className="text-xs font-semibold text-brand-300 hover:text-brand-200">Tout voir <ArrowRight size={12} className="inline" /></Link>} />
          {loading ? <LoadingState /> : projects.length === 0 ? (
            <EmptyState icon={<FolderKanban size={24} />} title="Aucun projet pour le moment" description="Créez votre premier projet pour démarrer un script ou une vidéo UGC."
              action={<Link to="/app/projets" className="btn btn-primary btn-sm"><Plus size={14} /> Créer un projet</Link>} />
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {projects.slice(0, 5).map((p) => (
                <Link key={p.id} to={`/app/projets/${p.id}`} className="flex items-center gap-4 px-5 py-3.5 hover:bg-white/[0.03]">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-500/15 text-brand-300"><Clapperboard size={17} /></div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-white">{p.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{truncate(p.brief || p.target_audience || 'Aucun brief', 70)} · {formatDate(p.updated_at)}</p>
                  </div>
                  <Badge status={p.status}>{statusLabel(p.status)}</Badge>
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Votre formule" description={quota?.plan?.tagline ?? 'Limites mensuelles'} />
          <div className="space-y-5 p-5">
            <div className="flex items-center justify-between">
              <div><p className="text-xs text-slate-500">Formule active</p><p className="mt-1 text-lg font-bold text-white">{quota?.plan?.display_name ?? '—'}</p></div>
              <Badge tone={quota?.status === 'active' ? 'success' : 'danger'}>{statusLabel(quota?.status)}</Badge>
            </div>
            {[
              { label: 'Vidéos', used: videosUsed, max: quota?.plan?.max_videos_per_month ?? 0, tone: 'brand' as const },
              { label: 'Scripts IA', used: scriptsUsed, max: quota?.plan?.max_scripts_per_month ?? 0, tone: 'cyan' as const },
              { label: 'Prompts IA', used: promptsUsed, max: quota?.plan?.max_prompts_per_month ?? 0, tone: 'emerald' as const },
              { label: 'Projets', used: quota?.projects ?? 0, max: quota?.plan?.max_projects ?? 0, tone: 'amber' as const },
            ].map((x) => (
              <div key={x.label}>
                <div className="mb-1.5 flex justify-between text-xs"><span className="text-slate-400">{x.label}</span><span className="font-semibold text-white">{x.used} / {x.max}</span></div>
                <ProgressBar value={x.used} max={x.max} tone={x.tone} />
              </div>
            ))}
            <Link to="/app/abonnement" className="btn btn-outline btn-sm w-full">Gérer mon abonnement</Link>
          </div>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Dernières générations" action={<Link to="/app/historique" className="text-xs font-semibold text-brand-300">Historique</Link>} />
          {loading ? <LoadingState /> : jobs.length === 0 ? <EmptyState icon={<Wand2 size={22} />} title="Aucune génération" description="Lancez une création depuis l’UGC Studio." /> : (
            <div className="divide-y divide-white/[0.06]">
              {jobs.slice(0, 5).map((j) => (
                <div key={j.id} className="flex items-center gap-3 px-5 py-3">
                  {j.status === 'succeeded' ? <CheckCircle2 size={17} className="shrink-0 text-emerald-400" /> : j.status === 'failed' ? <AlertTriangle size={17} className="shrink-0 text-rose-400" /> : <RefreshCw size={17} className="shrink-0 text-brand-300" />}
                  <div className="min-w-0 flex-1"><p className="truncate text-sm text-white">{j.service_key}</p><p className="text-[11px] text-slate-500">{relativeDate(j.created_at)} · {j.provider ?? 'en attente'}</p></div>
                  <Badge status={j.status}>{statusLabel(j.status)}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Accès rapides" description="Les actions les plus utilisées." />
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            {[
              { to: '/app/studio', icon: Clapperboard, title: 'UGC Studio', text: 'Composer une vidéo' },
              {
                to: '/app/business',
                icon: Brain,
                title: 'Business Grow',
                text: businessSnapshot?.backendReachable
                  ? `${businessSnapshot.availableProviderCount} fournisseur(s) IA prêt(s)`
                  : 'Copilote stratégique IA',
                state: buildBusinessGrowLocationState({ section: 'chat', roleKey: 'business_advisor', sourceRoute: '/app' }),
              },
              { to: '/app/scripts', icon: Wand2, title: 'Scripts IA', text: 'Générer un script' },
              { to: '/app/avatars', icon: Sparkles, title: 'Avatars', text: 'Gérer les présentateurs' },
            ].map((x) => (
              <Link key={x.to} to={x.to} state={x.state} className="group rounded-xl border border-line bg-white/[0.025] p-4 hover:border-brand-400/30 hover:bg-brand-500/5">
                <x.icon size={18} className="text-brand-300" />
                <p className="mt-3 text-sm font-semibold text-white">{x.title}</p>
                <p className="text-xs text-slate-500">{x.text}</p>
              </Link>
            ))}
          </div>
          {businessSnapshot?.backendReachable && businessSnapshot.quota && (
            <div className="border-t border-white/[0.06] px-5 py-3 text-xs text-slate-400">
              Quota Business Grow isolé : <strong className="text-slate-200">{businessSnapshot.quota.availableUnits ?? '—'}</strong> unités
              {businessSnapshot.quota.studioUgcUntouched ? ' · Crédits Studio UGC séparés' : ''}
            </div>
          )}
        </Card>
      </div>
      <p className="mt-4 text-xs text-slate-600">Période d’usage : {quota?.period ?? '—'} · Renouvellement le {quota ? formatDate(quota.period_end) : '—'}.</p>
    </>
  );
}
