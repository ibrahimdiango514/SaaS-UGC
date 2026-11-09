import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Clapperboard, FolderKanban, Plus, Scissors, Search, Trash2, Wand2, SlidersHorizontal } from 'lucide-react';
import { PageHeader, Card, Button, Input, Textarea, Select, Modal, Badge, LoadingState, ErrorState, EmptyState, ConfirmDialog } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { formatDate, statusLabel, truncate } from '../lib/format';
import { createProject, deleteProject, listProjects } from '../lib/api';
import type { Project } from '../lib/types';

const EMPTY_FORM = {
  title: '', brief: '', platform: 'TikTok', language: 'fr', aspect_ratio: '9:16',
  campaign_objective: '', target_audience: '', target_market: '',
};

export default function Projects({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast();
  const { refreshQuota } = useAuth();
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState('all');
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [toDelete, setToDelete] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setProjects(await listProjects({ status, search })); }
    catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [status, search]);

  useEffect(() => { void load(); }, [load]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault(); setFormError('');
    if (!form.title.trim()) { setFormError('Le titre du projet est obligatoire.'); return; }
    setSaving(true);
    try {
      const id = await createProject(form);
      toast.success('Projet créé.');
      setModal(false); setForm(EMPTY_FORM);
      await refreshQuota();
      await load();
      setParams({});
      window.dispatchEvent(new CustomEvent('reelora:project-created', { detail: id }));
    } catch (err) { setFormError(asAppError(err).message); }
    finally { setSaving(false); }
  };

  const onDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try { await deleteProject(toDelete.id); toast.success('Projet supprimé.'); setToDelete(null); await refreshQuota(); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
    finally { setDeleting(false); }
  };

  return (
    <>
      {embedded ? (
        <div className="mb-4 flex justify-end"><Button icon={<Plus size={15} />} onClick={() => setModal(true)}>Nouveau projet</Button></div>
      ) : (
        <PageHeader eyebrow="Production" title="Mes projets" description="Organisez vos campagnes UGC, du brief à la vidéo finale."
          actions={<Button icon={<Plus size={15} />} onClick={() => setModal(true)}>Nouveau projet</Button>} />
      )}

      <Card className="mb-5 flex flex-wrap items-center gap-3 p-4">
        <div className="relative min-w-[220px] flex-1">
          <Search size={15} className="absolute left-3 top-3 text-slate-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher un projet…"
            className="input pl-9" aria-label="Rechercher un projet" />
        </div>
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={15} className="text-slate-500" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto min-w-[150px]" aria-label="Filtrer par statut">
            <option value="all">Tous les statuts</option>
            <option value="draft">Brouillon</option>
            <option value="queued">En file</option>
            <option value="generating">En cours</option>
            <option value="completed">Terminé</option>
            <option value="failed">Échoué</option>
            <option value="archived">Archivé</option>
          </Select>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()}>Actualiser</Button>
      </Card>

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {loading && <LoadingState label="Chargement des projets…" />}
      {!loading && !error && projects.length === 0 && (
        <EmptyState icon={<FolderKanban size={24} />} title="Aucun projet" description="Créez un projet pour y associer un script, des avatars et des générations vidéo."
          action={<Button icon={<Plus size={15} />} onClick={() => setModal(true)}>Créer un projet</Button>} />
      )}

      {!loading && !error && projects.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <Card key={p.id} className="flex flex-col p-5 transition-colors hover:border-brand-400/30">
              <div className="flex items-start justify-between gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-500/15 text-brand-300"><Clapperboard size={18} /></div>
                <Badge status={p.status}>{statusLabel(p.status)}</Badge>
              </div>
              <h3 className="mt-4 truncate text-base font-semibold text-white">{p.title}</h3>
              <p className="mt-1 line-clamp-2 min-h-[40px] text-xs leading-relaxed text-slate-400">{truncate(p.brief || p.campaign_objective || 'Aucun brief renseigné', 130)}</p>
              <div className="mt-4 flex flex-wrap gap-1.5 text-[11px] text-slate-500">
                <span className="rounded-md bg-white/5 px-2 py-1">{p.platform ?? 'Multi-plateforme'}</span>
                <span className="rounded-md bg-white/5 px-2 py-1">{p.aspect_ratio}</span>
                <span className="rounded-md bg-white/5 px-2 py-1">{p.language.toUpperCase()}</span>
              </div>
              <p className="mt-4 text-[11px] text-slate-600">Mis à jour {formatDate(p.updated_at, true)}</p>
              <div className="mt-auto flex gap-2 pt-4">
                <Link to={`/app/projets/${p.id}`} className="btn btn-secondary btn-sm flex-1">Ouvrir</Link>
                <Link to={`/app/studio?projet=${p.id}`} className="btn btn-outline btn-sm" title="Ouvrir dans le Studio"><Wand2 size={14} /></Link>
                <Link to={`/app/studio/montage?projet=${p.id}`} className="btn btn-outline btn-sm" title="Ouvrir dans l’éditeur intelligent"><Scissors size={14} /></Link>
                <button onClick={() => setToDelete(p)} className="btn btn-ghost btn-sm text-rose-300" title="Supprimer"><Trash2 size={14} /></button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title="Nouveau projet" description="Décrivez la campagne. Ces informations alimenteront la génération IA."
        footer={<><Button variant="ghost" onClick={() => setModal(false)}>Annuler</Button><Button type="submit" form="project-form" loading={saving}>Créer le projet</Button></>}>
        <form id="project-form" onSubmit={(e) => void onSubmit(e)} className="space-y-4">
          <Input label="Titre du projet" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Ex. Lancement du sérum éclat" />
          <Textarea label="Brief" value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} placeholder="Produit, problème résolu, bénéfices concrets, ton souhaité…" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Plateforme" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
              {['TikTok', 'Instagram Reels', 'YouTube Shorts', 'Facebook', 'LinkedIn', 'Site web'].map((x) => <option key={x}>{x}</option>)}
            </Select>
            <Select label="Format" value={form.aspect_ratio} onChange={(e) => setForm({ ...form, aspect_ratio: e.target.value })}>
              {['9:16', '1:1', '4:5', '16:9'].map((x) => <option key={x}>{x}</option>)}
            </Select>
            <Select label="Langue" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
              <option value="fr">Français</option><option value="en">Anglais</option><option value="es">Espagnol</option>
            </Select>
            <Input label="Marché cible" value={form.target_market} onChange={(e) => setForm({ ...form, target_market: e.target.value })} placeholder="Mali, France…" />
          </div>
          <Input label="Objectif de campagne" value={form.campaign_objective} onChange={(e) => setForm({ ...form, campaign_objective: e.target.value })} placeholder="Notoriété, conversions, lancement…" />
          <Input label="Audience cible" value={form.target_audience} onChange={(e) => setForm({ ...form, target_audience: e.target.value })} placeholder="Femmes 25-35 ans, entrepreneurs…" />
          {formError && <ErrorState message={formError} />}
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(toDelete)} title="Supprimer ce projet ?" danger confirmLabel="Supprimer" loading={deleting}
        message={`Le projet « ${toDelete?.title ?? ''} » et ses scripts, scènes et variantes seront supprimés. Les vidéos déjà générées restent dans la bibliothèque.`}
        onClose={() => setToDelete(null)} onConfirm={() => void onDelete()} />
    </>
  );
}
