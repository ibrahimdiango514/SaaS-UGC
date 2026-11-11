import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Clock3, Database, Layers3, Lock, ShieldCheck, Sparkles } from 'lucide-react';
import { Card } from '../components/ui';
import History from '../pages/History';
import Projects from '../pages/Projects';
import Library from '../pages/Library';
import LegacyStudio from '../pages/Studio';
import { StudioShell } from './components/StudioShell';

function Intro({ icon, title, children, to, linkLabel }: {
  icon: ReactNode; title: string; children: ReactNode; to: string; linkLabel: string;
}) {
  return (
    <Card className="mb-4 flex flex-wrap items-center gap-4 p-4 sm:p-5">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-500/15 text-brand-200">{icon}</span>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">{children}</p>
      </div>
      <Link to={to} className="btn btn-outline btn-sm shrink-0">{linkLabel}</Link>
    </Card>
  );
}

export function StudioGenerations() {
  return (
    <StudioShell title="Mes générations" actions={<Link to="/app/studio" className="btn btn-primary btn-sm"><Sparkles size={13} /> Nouvelle création</Link>}>
      <Intro icon={<Clock3 size={18} />} title="Suivi serveur, sans résultat simulé" to="/app/studio" linkLabel="Ouvrir le Studio UGC">
        Chaque tâche expose son statut, ses paramètres, son coût en crédits et son historique. Le suivi continue même après fermeture de la page.
      </Intro>
      <History embedded />
    </StudioShell>
  );
}

export function StudioProjects() {
  return (
    <StudioShell title="Mes projets" actions={<Link to="/app/studio" className="btn btn-outline btn-sm"><Layers3 size={13} /> Créer une vidéo</Link>}>
      <Intro icon={<Database size={18} />} title="Projets existants conservés" to="/app/bibliotheque" linkLabel="Voir les créations">
        Scripts, scènes, statuts et vidéos restent dans les tables existantes, avec RLS et quotas inchangés. Une génération Studio UGC peut être rattachée à l’un de ces projets.
      </Intro>
      <Projects embedded />
    </StudioShell>
  );
}

export function StudioSaved() {
  return (
    <StudioShell title="Mes créations enregistrées" actions={<Link to="/app/historique" className="btn btn-outline btn-sm"><Clock3 size={13} /> Historique</Link>}>
      <Intro icon={<ShieldCheck size={18} />} title="Fichiers privés, pas seulement des URL temporaires" to="/app/studio" linkLabel="Nouvelle génération">
        Les vidéos réellement produites sont conservées dans le bucket Supabase Storage privé. Chaque fiche montre le modèle, les paramètres, la date, le coût et permet lecture, téléchargement, rattachement à un projet ou relance avec des paramètres similaires.
      </Intro>
      <Library embedded />
    </StudioShell>
  );
}

export function StudioLegacy() {
  return (
    <StudioShell title="Parcours classique" eyebrow="Fonctionnalités conservées : brief, script IA, scènes, modèle, coût et suivi.">
      <Intro icon={<Lock size={18} />} title="Ancien parcours en 5 étapes conservé" to="/app/studio" linkLabel="Revenir au Studio UGC">
        Ce parcours reste accessible sans suppression de fonctionnalités. Le nouveau Studio UGC est l’entrée principale et utilise exactement les mêmes RPC, ledger, RLS, Storage et suivi serveur.
      </Intro>
      <LegacyStudio embedded />
    </StudioShell>
  );
}
