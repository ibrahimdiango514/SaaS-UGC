import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Image as ImageIcon, Pencil, Plus, Star, Trash2, Upload, Users } from 'lucide-react';
import { PageHeader, Card, Button, Input, Textarea, Select, Badge, Modal, LoadingState, ErrorState, EmptyState, ConfirmDialog, Banner } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { formatDate, truncate } from '../lib/format';
import { createAvatar, deleteAvatar, listAvatars, signedStorageUrl, updateAvatar, uploadAvatarPreview } from '../lib/api';
import type { Avatar } from '../lib/types';

const EMPTY = {
  name: '', description: '', provider: 'muapi' as Avatar['provider'], provider_avatar_id: '',
  voice_id: '', language: 'fr', preview_storage_path: '', is_default: false,
  status: 'active' as Avatar['status'],
};

function AvatarThumb({ avatar }: { avatar: Avatar }) {
  const [url, setUrl] = useState<string | null>(avatar.preview_url);
  useEffect(() => {
    let active = true;
    if (!avatar.preview_url && avatar.preview_storage_path) {
      signedStorageUrl(avatar.preview_storage_path).then((u) => { if (active) setUrl(u); }).catch(() => { if (active) setUrl(null); });
    } else setUrl(avatar.preview_url);
    return () => { active = false; };
  }, [avatar.preview_url, avatar.preview_storage_path]);

  return (
    <div className="relative aspect-[4/5] overflow-hidden rounded-xl border border-line bg-gradient-to-br from-brand-900/40 to-cyan-900/20">
      {url ? <img src={url} alt={`Aperçu de ${avatar.name}`} className="h-full w-full object-cover" onError={() => setUrl(null)} /> : (
        <div className="grid h-full place-items-center"><div className="text-center"><Users size={28} className="mx-auto text-brand-300/70" /><p className="mt-2 text-[11px] text-slate-500">Aucune image</p></div></div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2">
        <p className="truncate text-xs font-semibold text-white">{avatar.name}</p>
      </div>
    </div>
  );
}

export default function Avatars() {
  const toast = useToast();
  const { user, workspaceId } = useAuth();
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Avatar | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<Avatar | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try { setAvatars(await listAvatars(workspaceId)); }
    catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => { setEditing(null); setForm(EMPTY); setFile(null); setModal(true); };
  const openEdit = (a: Avatar) => {
    setEditing(a);
    setForm({ name: a.name, description: a.description ?? '', provider: a.provider, provider_avatar_id: a.provider_avatar_id ?? '', voice_id: a.voice_id ?? '', language: a.language, preview_storage_path: a.preview_storage_path ?? '', is_default: a.is_default, status: a.status });
    setFile(null); setModal(true);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { toast.warning('Le nom de l’avatar est obligatoire.'); return; }
    if (!workspaceId || !user) { toast.error('Espace de travail indisponible.'); return; }
    setSaving(true);
    try {
      let path = form.preview_storage_path;
      if (file) path = await uploadAvatarPreview(workspaceId, file);
      const payload = {
        name: form.name, description: form.description || null, provider: form.provider,
        provider_avatar_id: form.provider_avatar_id || null, voice_id: form.voice_id || null,
        language: form.language, preview_storage_path: path || null, preview_url: null,
        is_default: form.is_default, status: form.status,
      };
      if (editing) await updateAvatar(editing.id, payload);
      else await createAvatar({ workspace_id: workspaceId, created_by: user.id, style: {}, ...payload });
      toast.success(editing ? 'Avatar mis à jour.' : 'Avatar créé.');
      setModal(false); await load();
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setSaving(false); }
  };

  const onSetDefault = async (a: Avatar) => {
    try { await updateAvatar(a.id, { is_default: true }); toast.success(`${a.name} est désormais l’avatar par défaut.`); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  const onDelete = async () => {
    if (!toDelete) return;
    try { await deleteAvatar(toDelete.id); toast.success('Avatar supprimé.'); setToDelete(null); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  return (
    <>
      <PageHeader eyebrow="Présentateurs" title="Mes avatars" description="Associez une image de référence (présentateur ou produit) à vos créations vidéo."
        actions={<Button icon={<Plus size={15} />} onClick={openCreate}>Nouvel avatar</Button>} />

      <div className="mb-5"><Banner tone="info" title="Images de référence">Ajoutez une image JPG ou PNG pour animer un présentateur ou un produit. Les clés et traitements techniques restent sécurisés.</Banner></div>

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {loading ? <LoadingState label="Chargement des avatars…" /> : avatars.length === 0 ? (
        <EmptyState icon={<Users size={24} />} title="Aucun avatar" description="Ajoutez une image de référence pour animer un présentateur ou un produit." action={<Button icon={<Plus size={15} />} onClick={openCreate}>Créer un avatar</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {avatars.map((a) => (
            <Card key={a.id} className="flex flex-col p-3">
              <AvatarThumb avatar={a} />
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Badge tone="info">{a.provider === 'custom' ? 'Personnalisé' : a.provider === 'legacy' ? 'Historique' : 'VYORA'}</Badge>
                {a.is_default && <Badge tone="success"><Star size={11} fill="currentColor" /> Par défaut</Badge>}
                {a.status !== 'active' && <Badge tone="danger">{a.status}</Badge>}
              </div>
              <h3 className="mt-2 truncate text-sm font-semibold text-white">{a.name}</h3>
              <p className="mt-1 line-clamp-2 min-h-[32px] text-xs text-slate-500">{truncate(a.description, 90) || 'Aucune description'}</p>
              <p className="text-[11px] text-slate-600">{formatDate(a.created_at)}</p>
              <div className="mt-3 flex gap-1.5">
                {!a.is_default && <Button size="sm" variant="outline" className="flex-1" icon={<Star size={13} />} onClick={() => void onSetDefault(a)}>Défaut</Button>}
                <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openEdit(a)} title="Modifier" />
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setToDelete(a)} title="Supprimer" />
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? 'Modifier l’avatar' : 'Nouvel avatar'} description="L’image est utilisée comme référence pour vos créations vidéo."
        footer={<><Button variant="ghost" onClick={() => setModal(false)}>Annuler</Button><Button type="submit" form="avatar-form" loading={saving}>{editing ? 'Enregistrer' : 'Créer'}</Button></>}>
        <form id="avatar-form" onSubmit={(e) => void onSubmit(e)} className="space-y-4">
          <Input label="Nom" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex. Awa – présentatrice" />
          <Textarea label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Style, tenue, personnalité…" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Type de fiche" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as Avatar['provider'] })}>
              <option value="muapi">VYORA</option><option value="custom">Référence personnalisée</option><option value="legacy">Historique (lecture seule)</option>
            </Select>
            <Select label="Langue" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}><option value="fr">Français</option><option value="en">Anglais</option><option value="es">Espagnol</option></Select>
          </div>
          <label className="field">
            <span className="field-label">Image de référence</span>
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-line bg-white/[0.03] px-4 py-3 hover:border-brand-400/40">
              <Upload size={17} className="text-brand-300" />
              <span className="text-sm text-slate-300">{file ? file.name : form.preview_storage_path ? 'Image déjà enregistrée — remplacer' : 'Choisir une image (JPG/PNG)'}</span>
              <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <span className="field-hint"><ImageIcon size={11} className="inline" /> Stockage privé ugc-assets · 500 Mo maximum par fichier</span>
          </label>
          <Select label="Statut" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Avatar['status'] })}><option value="active">Actif</option><option value="archived">Archivé</option></Select>
          <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} className="h-4 w-4 accent-brand-500" /> Définir comme avatar par défaut</label>
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(toDelete)} title="Supprimer cet avatar ?" danger confirmLabel="Supprimer" onClose={() => setToDelete(null)} onConfirm={() => void onDelete()} message="Les générations déjà réalisées conservent leurs métadonnées, mais cet avatar ne sera plus sélectionnable." />
    </>
  );
}
