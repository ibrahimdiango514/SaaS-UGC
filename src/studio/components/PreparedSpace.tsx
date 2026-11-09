import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Construction, Lock, ShieldCheck } from 'lucide-react';
import { Button, Card } from '../../components/ui';
import { NAV_SECTIONS, ROADMAP_SECTIONS, STUDIO_SECTIONS } from '../sections';
import { StudioShell } from './StudioShell';

export function PreparedSpace() {
  const { section } = useParams();
  const found = STUDIO_SECTIONS.find((s) => s.id === section);
  const title = found?.label ?? 'Espace préparé';
  const prepared = found?.status !== 'live';
  const related = [...NAV_SECTIONS, ...ROADMAP_SECTIONS].filter((s) => s.status === 'prepared' && s.id !== found?.id).slice(0, 6);
  const Icon = found?.icon ?? Construction;

  return (
    <StudioShell title={title} eyebrow="Espace architectural préparé · aucune génération disponible">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="p-6 sm:p-8">
            <div className="flex items-start gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-amber-300/20 bg-amber-300/[0.08] text-amber-200">
                <Icon size={20} />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-white">{prepared ? 'Préparé · non opérationnel' : 'Espace disponible'}</h2>
                  {prepared && <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">À venir</span>}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{found?.description ?? 'Cet espace est réservé dans l’architecture modulaire du studio.'}</p>
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <Lock size={16} className="text-slate-500" />
                <p className="mt-2 text-sm font-medium text-white">Aucun bouton de génération</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">Aucun fournisseur, modèle, crédit ou résultat n’est associé à cet espace. Rien n’est simulé.</p>
              </div>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <ShieldCheck size={16} className="text-brand-300" />
                <p className="mt-2 text-sm font-medium text-white">Architecture modulaire</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">La navigation, les routes et les métadonnées sont en place pour accueillir une intégration future sans refonte.</p>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              <Link to="/app/studio" className="btn btn-primary btn-sm"><ArrowLeft size={14} /> Retour au Video Studio</Link>
              <Link to="/app/historique" className="btn btn-outline btn-sm">Voir mes générations réelles</Link>
            </div>
          </div>
        </Card>

        <Card>
          <div className="p-5">
            <h3 className="text-sm font-semibold text-white">Espaces voisins</h3>
            <p className="mt-1 text-xs text-slate-500">Tous les modules ci-dessous sont également affichés comme préparés.</p>
            <div className="mt-4 space-y-2">
              {related.map((s) => (
                <Link key={s.id} to={s.route} className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-xs text-slate-300 transition-colors hover:border-brand-400/30 hover:text-white">
                  <span className="flex items-center gap-2"><s.icon size={13} className="text-slate-500" /> {s.label}</span>
                  <span className="text-[9px] uppercase tracking-wide text-amber-200">Préparé</span>
                </Link>
              ))}
            </div>
            <Button variant="ghost" size="sm" className="mt-4 w-full" onClick={() => window.history.back()}>Revenir en arrière</Button>
          </div>
        </Card>
      </div>
    </StudioShell>
  );
}
