import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, ArrowUpRight, Bot, CheckCircle2, Database, Plug, Search, ShieldCheck,
  Sparkles, Users, Wallet, X,
} from 'lucide-react';
import { Badge, Button, Card } from '../../components/ui';
import { SectionHeader } from '../../components/ui-premium';
import {
  FOUNDATION_MODULES, MODULE_DEFINITIONS, MODULE_GROUPS, isModuleKey,
} from './registry';

const FOUNDATION_ICONS = { 'ai-agent': Bot, 'integrations-hub': Plug, 'smart-crm': Users, 'finance-recovery': Wallet } as const;

/** Accent par groupe : chaque catégorie garde une identité lisible. */
const GROUP_ACCENT: Record<string, { text: string; border: string; bg: string; dot: string }> = {
  all: { text: 'text-violet-200', border: 'border-violet-300/40', bg: 'bg-violet-400/15', dot: 'bg-violet-300' },
  revenue: { text: 'text-emerald-200', border: 'border-emerald-300/40', bg: 'bg-emerald-400/15', dot: 'bg-emerald-300' },
  intelligence: { text: 'text-cyan-200', border: 'border-cyan-300/40', bg: 'bg-cyan-400/15', dot: 'bg-cyan-300' },
  operations: { text: 'text-sky-200', border: 'border-sky-300/40', bg: 'bg-sky-400/15', dot: 'bg-sky-300' },
  protection: { text: 'text-amber-200', border: 'border-amber-300/40', bg: 'bg-amber-400/15', dot: 'bg-amber-300' },
};

/**
 * Catalogue des modules métier Business Growth.
 *
 * - recherche et filtre par catégorie inchangés dans leur comportement ;
 * - hiérarchie visuelle : fondations opérationnelles, puis une section par
 *   groupe avec son accent, ses compteurs et des cartes entièrement cliquables ;
 * - aucun module n'est présenté comme disponible s'il ne l'est pas réellement
 *   (`isModuleKey` reste la seule source de vérité).
 */
export default function BusinessModules() {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string>('all');

  const totalModules = MODULE_DEFINITIONS.length;
  const readyModules = MODULE_DEFINITIONS.filter((module) => isModuleKey(module.key)).length;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return MODULE_DEFINITIONS.filter((module) => {
      if (group !== 'all' && module.group !== group) return false;
      if (!needle) return true;
      return `${module.title} ${module.description} ${module.shortTitle}`.toLowerCase().includes(needle);
    });
  }, [group, query]);

  const visibleGroups = MODULE_GROUPS.filter((item) => group === 'all' || item.id === group);
  const searching = query.trim().length > 0;

  return (
    <div className="space-y-6 pb-10" data-testid="business-modules">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link to="/app/business" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-slate-400 transition hover:text-white">
          <ArrowLeft size={15} /> Business Growth
        </Link>
        <span className="text-slate-600">/</span>
        <span className="inline-flex min-h-11 items-center px-2 text-slate-300">Modules métier</span>
      </div>

      {/* En-tête d'espace ---------------------------------------------------- */}
      <section className="relative isolate overflow-hidden rounded-[1.6rem] border border-violet-200/15 bg-[#0b0a13] px-5 py-6 sm:px-7 sm:py-8">
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-violet-500/[0.18] blur-[100px]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-20 h-64 w-64 rounded-full bg-cyan-400/[0.10] blur-[100px]" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/50 to-transparent" />

        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="vy-chip border-violet-300/25 bg-violet-400/10 text-violet-200">
              <Sparkles size={11} /> VYORA Business Growth
            </p>
            <h1 className="vy-title mt-3 text-[1.75rem] leading-tight sm:text-[2.15rem]">Vos modules métier</h1>
            <p className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-slate-400">
              Chaque module écrit dans vos propres données Business Growth. Rien n’est partagé avec le Studio,
              aucun crédit Studio n’est consommé et aucun chiffre n’est simulé.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3 py-1.5 text-emerald-200">
              <Database size={12} /> {readyModules}/{totalModules} modules avec stockage réel
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-slate-300">
              <ShieldCheck size={12} /> {FOUNDATION_MODULES.length} fondations existantes
            </span>
          </div>
        </div>

        {/* Filtres : catégories en pastilles + recherche */}
        <div className="relative mt-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Filtrer par catégorie">
            {[{ id: 'all', label: 'Tous les modules' }, ...MODULE_GROUPS].map((item) => {
              const accent = GROUP_ACCENT[item.id] ?? GROUP_ACCENT.all;
              const active = group === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setGroup(item.id)}
                  aria-pressed={active}
                  className={`min-h-11 shrink-0 rounded-full border px-4 text-[12.5px] font-medium transition ${active
                    ? `${accent.border} ${accent.bg} ${accent.text}`
                    : 'border-white/[0.08] text-slate-400 hover:border-white/20 hover:text-white'}`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <label className="relative block w-full lg:w-80">
            <span className="sr-only">Rechercher un module</span>
            <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Rechercher un module…"
              className="min-h-11 w-full rounded-xl border border-white/[0.08] bg-white/[0.03] pl-10 pr-10 text-[13px] text-white outline-none transition placeholder:text-slate-500 focus:border-violet-300/50 focus:bg-white/[0.05]"
            />
            {searching && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Effacer la recherche"
                className="absolute right-1 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-slate-500 transition hover:text-white"
              >
                <X size={14} />
              </button>
            )}
          </label>
        </div>
      </section>

      {/* Fondations opérationnelles ------------------------------------------ */}
      <section className="vy-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-[15px] font-semibold text-white">Fondations déjà opérationnelles</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-slate-400">Agent, connecteurs et CRM existants : ce socle alimente les modules métier ci-dessous.</p>
          </div>
          <Badge tone="success">Disponible</Badge>
        </div>
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {FOUNDATION_MODULES.map((module) => {
            const Icon = FOUNDATION_ICONS[module.key as keyof typeof FOUNDATION_ICONS];
            return (
              <Link
                key={module.key}
                to={module.to}
                className="group relative flex min-h-full flex-col overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.022] p-4 transition duration-300 hover:-translate-y-0.5 hover:border-violet-300/35 hover:bg-violet-400/[0.06]"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-xl border border-violet-300/20 bg-violet-400/10 text-violet-200 transition group-hover:bg-violet-400/15">
                    <Icon size={17} />
                  </span>
                  <ArrowUpRight size={15} className="text-slate-600 transition group-hover:text-violet-200" />
                </div>
                <h3 className="mt-3 text-[13px] font-semibold text-white">{module.title}</h3>
                <p className="mt-1 flex-1 text-[11.5px] leading-relaxed text-slate-400">{module.description}</p>
                <span className="mt-3 inline-flex items-center gap-1 text-[10.5px] font-medium text-emerald-300">
                  <CheckCircle2 size={11} /> {module.status}
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Modules par catégorie ------------------------------------------------ */}
      {visibleGroups.map((groupItem) => {
        const modules = filtered.filter((module) => module.group === groupItem.id);
        if (!modules.length) return null;
        const accent = GROUP_ACCENT[groupItem.id] ?? GROUP_ACCENT.all;
        return (
          <section key={groupItem.id} className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/[0.07] pb-2.5">
              <div className="min-w-0">
                <p className={`flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] ${accent.text}`}>
                  <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${accent.dot}`} /> Catégorie
                </p>
                <h2 className="mt-1 font-display text-lg font-medium tracking-[-0.02em] text-white">{groupItem.label}</h2>
                <p className="mt-0.5 text-[12px] text-slate-500">{groupItem.description}</p>
              </div>
              <span className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] font-medium text-slate-400">
                {modules.length} module{modules.length > 1 ? 's' : ''}
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {modules.map((module) => {
                const Icon = module.icon;
                const available = isModuleKey(module.key);
                return (
                  <Link
                    key={module.key}
                    to={`/app/business/modules/${module.key}`}
                    className="group relative flex min-h-full flex-col overflow-hidden rounded-[1.15rem] border border-white/[0.07] bg-[#080d15]/70 p-4 transition duration-300 hover:-translate-y-1 hover:border-violet-300/30"
                  >
                    <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/40 to-transparent opacity-0 transition group-hover:opacity-100" />
                    <div className="flex items-start justify-between gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-xl border border-white/[0.09] bg-white/[0.04] text-slate-200 transition group-hover:border-violet-300/30 group-hover:bg-violet-400/10 group-hover:text-violet-200">
                        <Icon size={18} />
                      </span>
                      <Badge tone={available ? 'info' : 'neutral'}>{available ? 'Prêt' : 'Bientôt'}</Badge>
                    </div>
                    <h3 className="mt-3 text-[14px] font-semibold leading-snug text-white">{module.title}</h3>
                    <p className="mt-1 flex-1 text-[12px] leading-relaxed text-slate-400">{module.description}</p>
                    <span className="mt-4 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-violet-200">
                      Ouvrir le module
                      <ArrowUpRight size={14} className="transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}

      {filtered.length === 0 && (
        <Card className="p-8 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-white/[0.08] bg-white/[0.04] text-slate-400">
            <Search size={20} />
          </span>
          <p className="mt-3 font-medium text-white">Aucun module ne correspond à cette recherche.</p>
          <p className="mt-1 text-sm text-slate-400">Changez de catégorie ou effacez la recherche.</p>
          <Button variant="outline" className="mt-4" onClick={() => { setQuery(''); setGroup('all'); }}>Réinitialiser les filtres</Button>
        </Card>
      )}

      <SectionHeader
        eyebrow="Rappel de périmètre"
        title="Ce que ces modules ne font pas"
        action={<Link to="/app/business" className="text-[11px] font-medium text-violet-300 hover:text-violet-200">Vue d’ensemble →</Link>}
      />
      <div className="grid gap-2.5 sm:grid-cols-3">
        {[
          { icon: ShieldCheck, title: 'Aucun accès Studio', text: 'Ni crédits, ni fichiers, ni projets du Studio UGC.' },
          { icon: Database, title: 'Données réelles uniquement', text: 'Chaque enregistrement est le vôtre, stocké dans votre espace.' },
          { icon: Bot, title: 'Aucun chiffre inventé', text: 'Un KPI vide reste vide : rien n’est extrapolé à votre place.' },
        ].map((item) => (
          <div key={item.title} className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-slate-300">
              <item.icon size={14} />
            </span>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-white">{item.title}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{item.text}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
