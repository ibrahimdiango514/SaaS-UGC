import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Clapperboard, Coins, FolderKanban, Play, Plus, Sparkles, Wand2,
  CheckCircle2, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { StatCard, Card, CardHeader, Badge, Button, LoadingState, ErrorState, EmptyState, ProgressBar, Banner } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { BrandLockup } from '../components/Brand';
import { asAppError } from '../lib/errors';
import { formatDate, relativeDate, statusLabel, truncate } from '../lib/format';
import { countAssets, healthCheck, listJobs, listProjects } from '../lib/api';
import type { GenerationJob, Project } from '../lib/types';
import { localGreeting } from '../lib/greeting';

export default function Dashboard() {
  const { profile, quota, refreshQuota } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [assetCount, setAssetCount] = useState(0);
  const [health, setHealth] = useState<Record<string, boolean> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [p, j, totalAssets] = await Promise.all([
        listProjects(), listJobs(8), countAssets(),
      ]);
      setProjects(p); setJobs(j); setAssetCount(totalAssets);
      try { setHealth((await healthCheck()).configured); } catch { setHealth(null); }
      await refreshQuota();
    } catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [refreshQuota]);

  useEffect(() => { void load(); }, [load]);

  const { greeting } = localGreeting();
  const videosUsed = quota?.usage?.video ?? 0;
  const scriptsUsed = quota?.usage?.script ?? 0;
  const promptsUsed = quota?.usage?.prompt ?? 0;
  const firstName = profile?.display_name?.split(' ')[0] || 'bienvenue';

  return (
    <>
      <section className="relative isolate mb-6 overflow-hidden rounded-[1.75rem] border border-cyan-200/[0.12] bg-[#080d15] px-5 py-6 sm:px-8 sm:py-8 lg:px-10 lg:py-9" aria-label="Tableau de bord Studio">
        <img src="/brand/studio-creator.jpg" alt="" aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 -z-20 hidden h-full w-[58%] object-cover object-[50%_30%] opacity-30 lg:block [mask-image:linear-gradient(to_right,transparent,black_42%)]" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-r from-[#080d15] via-[#080d15]/90 to-[#080d15]/35" />
        <div aria-hidden="true" className="pointer-events-none absolute -left-24 -top-24 -z-10 h-64 w-64 rounded-full bg-cyan-400/10 blur-[90px]" />
        <div className="relative max-w-2xl">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <BrandLockup tagline />
            <span className="hidden h-8 w-px bg-white/10 sm:block" />
            <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-200/20 bg-cyan-400/[0.07] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-cyan-100">
              <Clapperboard size={11} /> Espace Studio
            </span>
          </div>
          <p className="mt-7 text-sm font-medium text-cyan-100">{greeting}, {firstName}.</p>
          <h1 className="mt-2 max-w-2xl font-display text-3xl font-medium leading-[1.08] tracking-[-0.04em] text-white sm:text-4xl lg:text-[2.9rem]">
            Créez avec intention.<br /><span className="text-slate-400">Produisez sans friction.</span>
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-slate-400 sm:text-base">
            Scripts, avatars, images produits et vidéos UGC : retrouvez tous vos outils de création,
            votre bibliothèque et vos crédits Studio dans un seul espace.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            <Link to="/app/studio" className="btn btn-primary btn-md vyora-btn-sheen"><Play size={15} /> Créer avec Studio</Link>
            <Link to="/app/projets" className="btn btn-outline btn-md"><FolderKanban size={15} /> Mes projets</Link>
            <Button variant="ghost" size="md" onClick={() => void load()} icon={<RefreshCw size={14} />}>Actualiser</Button>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] text-slate-500">
            <span className="flex items-center gap-1.5"><CheckCircle2 size={11} className="text-emerald-400" /> Devis vérifié avant génération</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 size={11} className="text-emerald-400" /> Espace isolé par compte</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 size={11} className="text-emerald-400" /> Aucun résultat simulé</span>
          </div>
        </div>
      </section>

      {health && (!health.groq || !health.muapi) && (
        <div className="mb-6">
          <Banner tone="warning" title="Certaines fonctionnalités sont temporairement indisponibles">
            {!health.groq && 'L’assistance IA pour les scripts et prompts est indisponible. '}
            {!health.muapi && 'La génération vidéo est indisponible. '}
            Réessayez plus tard.
          </Banner>
        </div>
      )}

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Projets actifs" value={loading ? '…' : quota?.projects ?? 0} icon={<FolderKanban size={19} />} hint={`${quota?.plan?.max_projects ?? 0} autorisés par votre formule`} />
        <StatCard label="Vidéos ce mois-ci" value={quota?.usage?.video ?? '—'} icon={<Clapperboard size={19} />} hint={`Période ${quota?.period ?? 'indisponible'}`} tone="cyan" />
        <StatCard label="Crédits Studio UGC" value={quota?.credits ?? 0} icon={<Coins size={19} />} hint={`Formule ${quota?.plan?.display_name ?? '—'}`} tone="amber" />
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
                  <div className="min-w-0 flex-1"><p className="truncate text-sm text-white">Création vidéo</p><p className="text-[11px] text-slate-500">{relativeDate(j.created_at)}</p></div>
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
              { to: '/app/projets', icon: FolderKanban, title: 'Projets', text: 'Reprendre un brief' },
              { to: '/app/scripts', icon: Wand2, title: 'Scripts IA', text: 'Générer un script' },
              { to: '/app/avatars', icon: Sparkles, title: 'Avatars', text: 'Gérer les présentateurs' },
              { to: '/app/bibliotheque', icon: Play, title: 'Bibliothèque', text: 'Retrouver mes vidéos' },
            ].map((x) => (
              <Link key={x.to} to={x.to} className="group rounded-xl border border-line bg-white/[0.025] p-4 hover:border-brand-400/30 hover:bg-brand-500/5">
                <x.icon size={18} className="text-brand-300" />
                <p className="mt-3 text-sm font-semibold text-white">{x.title}</p>
                <p className="text-xs text-slate-500">{x.text}</p>
              </Link>
            ))}
          </div>
        </Card>
      </div>
      <p className="mt-4 text-xs text-slate-600">Période d’usage : {quota?.period ?? '—'} · Renouvellement le {quota ? formatDate(quota.period_end) : '—'}.</p>
    </>
  );
}
