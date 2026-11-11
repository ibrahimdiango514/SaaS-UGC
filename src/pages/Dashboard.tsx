import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Brain, Clapperboard, Coins, FolderKanban, Play, Plus, Sparkles, Wand2, Zap,
  CheckCircle2, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { StatCard, Card, CardHeader, Badge, Button, LoadingState, ErrorState, EmptyState, ProgressBar, Banner } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { businessGrowBridge } from '../business';
import type { BusinessGrowPlatformSnapshot } from '../contracts/business-grow';
import { BrandLockup } from '../components/Brand';
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
  const firstName = profile?.display_name?.split(' ')[0] || 'bienvenue';

  return (
    <>
      <section className="relative isolate mb-6 overflow-hidden rounded-[1.75rem] border border-white/[0.09] bg-[#080d15] px-5 py-6 sm:px-8 sm:py-8 lg:px-10 lg:py-9" aria-label="Bienvenue dans VYORA">
        <img src="/brand/vyora-hero.jpg" alt="" aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 -z-20 hidden h-full w-[62%] object-cover object-[62%_45%] opacity-40 lg:block [mask-image:linear-gradient(to_right,transparent,black_38%)]" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-r from-[#080d15] via-[#080d15]/85 to-transparent" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 -z-10 hidden w-[54%] bg-[radial-gradient(ellipse_at_68%_45%,rgba(34,211,238,.12),transparent_58%),radial-gradient(ellipse_at_96%_0%,rgba(167,139,250,.12),transparent_55%)] lg:block" />
        <div className="grid items-center gap-8 lg:grid-cols-[1.1fr_.9fr]">
          <div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <BrandLockup tagline />
              <span className="hidden h-8 w-px bg-white/10 sm:block" />
              <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-slate-500">One platform · Two dimensions</p>
            </div>
            <p className="mt-8 text-sm font-medium text-cyan-100">{greeting}, {firstName}.</p>
            <h1 className="mt-2 max-w-2xl font-display text-3xl font-medium leading-[1.08] tracking-[-0.04em] text-white sm:text-4xl lg:text-[2.9rem]">
              Créez avec intention.<br /><span className="text-slate-400">Développez avec intelligence.</span>
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-slate-400 sm:text-base">
              Du contenu qui raconte votre histoire à la stratégie qui fait avancer votre activité : votre prochain pas commence ici.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-2.5">
              <Link to="/app/studio" className="btn btn-primary btn-md vyora-btn-sheen"><Play size={15} /> Créer avec Studio</Link>
              <Link to="/app/business" className="btn btn-outline btn-md"><Brain size={15} /> Explorer Business</Link>
              <Button variant="ghost" size="sm" onClick={() => void load()} icon={<RefreshCw size={14} />}>Actualiser</Button>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] text-slate-500">
              <span className="flex items-center gap-1.5"><CheckCircle2 size={11} className="text-emerald-400" /> Devis vérifié avant génération</span>
              <span className="flex items-center gap-1.5"><CheckCircle2 size={11} className="text-emerald-400" /> Espace isolé par compte</span>
              <span className="flex items-center gap-1.5"><CheckCircle2 size={11} className="text-emerald-400" /> Aucun résultat simulé</span>
            </div>
          </div>
          <div className="relative hidden min-h-[220px] items-center justify-center lg:flex">
            <div className="relative w-full max-w-[410px]">
              <div className="absolute -left-2 top-1/2 h-px w-[calc(100%+16px)] -translate-y-1/2 bg-gradient-to-r from-transparent via-cyan-200/20 to-transparent" />
              <div className="absolute left-1/2 top-1/2 h-[190px] w-[190px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/[0.07]" />
              <div className="absolute left-1/2 top-1/2 h-[138px] w-[138px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-violet-200/20" />
              <div className="absolute left-1/2 top-1/2 grid h-[76px] w-[76px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[1.35rem] border border-white/15 bg-[#111b25] shadow-[0_0_70px_rgba(34,211,238,.12)]">
                <BrandLockup symbolSize={42} />
              </div>
              <div className="relative flex items-center justify-between">
                <div className="flex w-[140px] items-center gap-2.5 rounded-xl border border-cyan-200/15 bg-[#101a22]/95 p-3 shadow-2xl">
                  <Clapperboard size={17} className="shrink-0 text-cyan-200" />
                  <div><p className="text-xs font-semibold text-white">Studio</p><p className="mt-0.5 text-[9px] text-slate-400">Créer & produire</p></div>
                </div>
                <div className="flex w-[140px] items-center gap-2.5 rounded-xl border border-violet-200/15 bg-[#151420]/95 p-3 shadow-2xl">
                  <Brain size={17} className="shrink-0 text-violet-200" />
                  <div><p className="text-xs font-semibold text-white">Business</p><p className="mt-0.5 text-[9px] text-slate-400">Analyser & évoluer</p></div>
                </div>
              </div>
              <p className="mt-8 text-center text-[9px] font-medium uppercase tracking-[0.22em] text-slate-600">Create · Evolve · Grow</p>
            </div>
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

      <section aria-label="Les deux dimensions de VYORA" className="mt-6 grid gap-4 lg:grid-cols-2">
        <Link to="/app/studio" className="group relative isolate flex min-h-[255px] flex-col justify-between overflow-hidden rounded-[1.5rem] border border-cyan-200/15 bg-[#0c141b] p-5 transition duration-300 hover:-translate-y-0.5 hover:border-cyan-200/30 sm:min-h-[290px] sm:p-7">
          <img src="/studio-examples/cosmetique.jpg" alt="Visuel d’inspiration pour les créations du Studio UGC" className="absolute inset-y-0 right-0 -z-10 h-full w-[62%] object-cover object-center opacity-45 transition duration-700 group-hover:scale-[1.03] group-hover:opacity-55 [mask-image:linear-gradient(to_right,transparent,black_45%)]" />
          <div className="absolute inset-0 -z-10 bg-gradient-to-r from-[#0c141b] via-[#0c141b]/95 to-[#0c141b]/25" />
          <div className="flex items-start justify-between">
            <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-100"><Clapperboard size={15} /> 01 · Create</span>
            <ArrowRight size={17} className="text-slate-400 transition group-hover:translate-x-1 group-hover:text-cyan-100" />
          </div>
          <div className="max-w-[360px]">
            <h2 className="font-display text-2xl font-medium tracking-tight text-white sm:text-3xl">Studio UGC</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">Transformez un brief en vidéo. Écrivez, choisissez votre direction visuelle, générez et montez.</p>
            <span className="mt-5 inline-flex items-center gap-2 rounded-xl border border-cyan-200/15 bg-[#071015]/80 px-3.5 py-2.5 text-xs text-cyan-50 backdrop-blur">
              <Coins size={14} className="text-cyan-200" />
              <span><span className="text-slate-400">Crédits Studio · </span><strong>{loading ? '…' : quota?.credits ?? '—'}</strong></span>
            </span>
          </div>
        </Link>

        <Link to="/app/business" className="group relative isolate flex min-h-[255px] flex-col justify-between overflow-hidden rounded-[1.5rem] border border-violet-200/15 bg-[#100f19] p-5 transition duration-300 hover:-translate-y-0.5 hover:border-violet-200/30 sm:min-h-[290px] sm:p-7">
          <div aria-hidden="true" className="absolute inset-y-0 right-0 -z-10 w-[65%] opacity-70 [background:radial-gradient(ellipse_at_70%_25%,rgba(167,139,250,.2),transparent_48%),radial-gradient(ellipse_at_78%_95%,rgba(34,211,238,.1),transparent_50%)]" />
          <div aria-hidden="true" className="absolute right-8 top-10 -z-10 h-40 w-40 rounded-full border border-violet-200/[0.12] sm:right-14 sm:top-8 sm:h-52 sm:w-52">
            <span className="absolute inset-5 rounded-full border border-dashed border-cyan-100/[0.15]" />
            <span className="absolute inset-[42px] rounded-full border border-white/[0.08]" />
            <span className="absolute right-[16%] top-[24%] h-2 w-2 rounded-full bg-violet-200 shadow-[0_0_18px_rgba(196,181,253,.8)]" />
            <span className="absolute bottom-[18%] left-[22%] h-1.5 w-1.5 rounded-full bg-cyan-200 shadow-[0_0_14px_rgba(103,232,249,.7)]" />
          </div>
          <div className="flex items-start justify-between">
            <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-100"><Brain size={15} /> 02 · Grow</span>
            <ArrowRight size={17} className="text-slate-400 transition group-hover:translate-x-1 group-hover:text-violet-100" />
          </div>
          <div className="max-w-[365px]">
            <h2 className="font-display text-2xl font-medium tracking-tight text-white sm:text-3xl">Business Grow</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">Faites le point, explorez vos options et passez à l’action avec un assistant connecté à votre contexte métier.</p>
            <span className="mt-5 inline-flex items-center gap-2 rounded-xl border border-violet-200/15 bg-[#0b0a13]/80 px-3.5 py-2.5 text-xs text-violet-50 backdrop-blur">
              <Zap size={14} className="text-violet-200" />
              {businessSnapshot?.backendReachable && businessSnapshot.quota
                ? <span><span className="text-slate-400">Quota Business · </span><strong>{businessSnapshot.quota.availableUnits ?? '—'} unités</strong></span>
                : <span className="text-slate-300">Quota métier distinct des crédits Studio</span>}
            </span>
          </div>
        </Link>
      </section>

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
