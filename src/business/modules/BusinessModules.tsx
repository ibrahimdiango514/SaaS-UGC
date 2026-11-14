import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, ArrowUpRight, Bot, CheckCircle2, Database, Plug, Search,
  ShieldCheck, Sparkles, Users,
} from 'lucide-react';
import { Badge, Button, Card } from '../../components/ui';
import {
  FOUNDATION_MODULES, MODULE_DEFINITIONS, MODULE_GROUPS, isModuleKey,
} from './registry';

const FOUNDATION_ICONS = { 'ai-agent': Bot, 'integrations-hub': Plug, 'smart-crm': Users } as const;

export default function BusinessModules() {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string>('all');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return MODULE_DEFINITIONS.filter((module) => {
      if (group !== 'all' && module.group !== group) return false;
      if (!needle) return true;
      return `${module.title} ${module.description} ${module.shortTitle}`.toLowerCase().includes(needle);
    });
  }, [group, query]);

  return (
    <div className="space-y-6 pb-10" data-testid="business-modules">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link to="/app/business" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-slate-400 hover:text-white">
          <ArrowLeft size={15} /> Business Growth
        </Link>
        <span className="text-slate-600">/</span>
        <span className="inline-flex min-h-11 items-center px-2 text-slate-300">Modules métier</span>
      </div>

      <section className="relative isolate overflow-hidden rounded-2xl border border-line bg-panel px-5 py-6 sm:px-7 sm:py-8">
        <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-violet-500/10 blur-[90px]" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-300">
              <Sparkles size={13} /> VYORA Business Growth
            </p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">Vos modules métier</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
              Chaque module écrit dans vos propres données Business Growth. Rien n’est partagé avec le Studio,
              aucun crédit Studio n’est consommé et aucun chiffre n’est simulé.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3 py-1.5 text-emerald-200">
              <Database size={13} /> 13 modules avec stockage réel
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-slate-300">
              <ShieldCheck size={13} /> 3 fondations existantes
            </span>
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setGroup('all')}
            className={`min-h-11 rounded-full border px-4 text-sm transition ${group === 'all' ? 'border-brand-400/40 bg-brand-500/15 text-brand-100' : 'border-line text-slate-400 hover:text-white'}`}
          >
            Tous
          </button>
          {MODULE_GROUPS.map((item) => (
            <button
              key={item.id}
              onClick={() => setGroup(item.id)}
              className={`min-h-11 rounded-full border px-4 text-sm transition ${group === item.id ? 'border-brand-400/40 bg-brand-500/15 text-brand-100' : 'border-line text-slate-400 hover:text-white'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="relative block w-full lg:w-72">
          <span className="sr-only">Rechercher un module</span>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher un module…"
            className="input min-h-11 pl-9"
          />
        </label>
      </div>

      <section className="rounded-2xl border border-line bg-panel/50 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-white">Fondations déjà opérationnelles</h2>
          <Badge tone="success">Disponible</Badge>
        </div>
        <p className="mt-1 text-sm text-slate-400">Agent, connecteurs et CRM existants : ce socle alimente les modules métier ci-dessous.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {FOUNDATION_MODULES.map((module) => {
            const Icon = FOUNDATION_ICONS[module.key as keyof typeof FOUNDATION_ICONS];
            return (
              <Link
                key={module.key}
                to={module.to}
                className="group flex min-h-full flex-col rounded-xl border border-line bg-white/[0.02] p-4 transition hover:border-violet-400/30 hover:bg-violet-500/[0.06]"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-violet-400/10 text-violet-300"><Icon size={19} /></span>
                  <ArrowUpRight size={16} className="text-slate-500 transition group-hover:text-violet-200" />
                </div>
                <h3 className="mt-3 text-sm font-semibold text-white">{module.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{module.description}</p>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-violet-200">
                  <CheckCircle2 size={12} /> {module.status}
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {MODULE_GROUPS.map((groupItem) => {
        const modules = filtered.filter((module) => module.group === groupItem.id);
        if (!modules.length) return null;
        return (
          <section key={groupItem.id} className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-white">{groupItem.label}</h2>
                <p className="text-sm text-slate-400">{groupItem.description}</p>
              </div>
              <span className="text-xs text-slate-500">{modules.length} module(s)</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {modules.map((module) => {
                const Icon = module.icon;
                const available = isModuleKey(module.key);
                return (
                  <Link
                    key={module.key}
                    to={`/app/business/modules/${module.key}`}
                    className="group flex min-h-full flex-col rounded-xl border border-line bg-panel p-4 transition hover:-translate-y-0.5 hover:border-brand-400/30 hover:bg-white/[0.03]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-lg bg-brand-500/10 text-brand-300"><Icon size={19} /></span>
                      <Badge tone={available ? 'info' : 'neutral'}>{available ? 'Prêt' : 'Bientôt'}</Badge>
                    </div>
                    <h3 className="mt-3 text-base font-semibold text-white">{module.title}</h3>
                    <p className="mt-1 flex-1 text-sm leading-relaxed text-slate-400">{module.description}</p>
                    <span className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-brand-200">
                      Ouvrir le module <ArrowUpRight size={15} className="transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
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
          <p className="font-medium text-white">Aucun module ne correspond à cette recherche.</p>
          <p className="mt-1 text-sm text-slate-400">Changez de groupe ou effacez la recherche.</p>
          <Button variant="outline" className="mt-4" onClick={() => { setQuery(''); setGroup('all'); }}>Réinitialiser les filtres</Button>
        </Card>
      )}
    </div>
  );
}
