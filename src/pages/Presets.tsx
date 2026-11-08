import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Pencil, Plus, SlidersHorizontal, Star, Trash2 } from 'lucide-react';
import { PageHeader, Card, Button, Input, Select, Modal, Badge, LoadingState, ErrorState, EmptyState, ConfirmDialog, Toggle, Banner } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { formatDate } from '../lib/format';
import { createPreset, deletePreset, listPresets, updatePreset } from '../lib/api';
import type { GenerationPreset } from '../lib/types';

interface Config {
  provider: string; duration_seconds: number; aspect_ratio: string; resolution: string;
  style: string; voice_speed: number; captions: boolean; background_color: string; model: string;
}

const DEFAULT_CONFIG: Config = {
  provider: 'muapi', duration_seconds: 5, aspect_ratio: '9:16', resolution: '480p',
  style: 'ugc_naturel', voice_speed: 1, captions: true, background_color: '#FFFFFF', model: 'seedance-lite-t2v',
};

export default function Presets() {
  const toast = useToast();
  const { user, workspaceId } = useAuth();
  const [presets, setPresets] = useState<GenerationPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<GenerationPreset | null>(null);
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<GenerationPreset | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try { setPresets(await listPresets(workspaceId)); }
    catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => { setEditing(null); setName(''); setConfig(DEFAULT_CONFIG); setIsDefault(false); setModal(true); };
  const openEdit = (p: GenerationPreset) => {
    setEditing(p); setName(p.name); setIsDefault(p.is_default);
    setConfig({ ...DEFAULT_CONFIG, ...(p.config as Partial<Config>) }); setModal(true);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { toast.warning('Nommez ce réglage.'); return; }
    if (!workspaceId || !user) { toast.error('Espace de travail indisponible.'); return; }
    setSaving(true);
    try {
      if (editing) await updatePreset(editing.id, { name, config: config as unknown as Record<string, unknown>, is_default: isDefault });
      else await createPreset({ workspace_id: workspaceId, created_by: user.id, name, config: config as unknown as Record<string, unknown>, is_default: isDefault });
      toast.success(editing ? 'Réglages mis à jour.' : 'Réglages créés.');
      setModal(false); await load();
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setSaving(false); }
  };

  const onSetDefault = async (p: GenerationPreset) => {
    try { await updatePreset(p.id, { is_default: true }); toast.success('Réglage par défaut mis à jour.'); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  const onDelete = async () => {
    if (!toDelete) return;
    try { await deletePreset(toDelete.id); toast.success('Réglages supprimés.'); setToDelete(null); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  return (
    <>
      <PageHeader eyebrow="Studio" title="Paramètres de génération vidéo" description="Enregistrez des combinaisons de réglages réutilisables pour vos campagnes."
        actions={<Button icon={<Plus size={15} />} onClick={openCreate}>Nouveau réglage</Button>} />

      <div className="mb-5"><Banner tone="info" title="Réglages réels, pas de simulation">Ces valeurs servent de référence pour vos campagnes. Dans l’UGC Studio, seuls les paramètres réellement pris en charge par le modèle MuAPI choisi sont transmis au fournisseur. Elles ne créent aucun résultat fictif.</Banner></div>

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {loading ? <LoadingState label="Chargement des réglages…" /> : presets.length === 0 ? (
        <EmptyState icon={<SlidersHorizontal size={24} />} title="Aucun réglage enregistré" description="Créez un préréglage pour standardiser vos vidéos." action={<Button icon={<Plus size={15} />} onClick={openCreate}>Créer un réglage</Button>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {presets.map((p) => {
            const c = { ...DEFAULT_CONFIG, ...(p.config as Partial<Config>) };
            return (
              <Card key={p.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-500/15 text-brand-300"><SlidersHorizontal size={18} /></div>
                  {p.is_default && <Badge tone="success"><Star size={11} fill="currentColor" /> Par défaut</Badge>}
                </div>
                <h3 className="mt-3 text-sm font-semibold text-white">{p.name}</h3>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  {[['Fournisseur', c.provider], ['Durée', `${c.duration_seconds} s`], ['Format', c.aspect_ratio], ['Résolution', c.resolution], ['Style', c.style], ['Vitesse voix', String(c.voice_speed)]].map(([k, v]) => (
                    <div key={k} className="rounded-lg bg-white/5 px-2.5 py-2"><p className="text-[10px] uppercase text-slate-500">{k}</p><p className="mt-0.5 truncate font-medium text-slate-200">{v}</p></div>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-slate-500"><Badge tone={c.captions ? 'success' : 'neutral'}>{c.captions ? 'Sous-titres activés' : 'Sans sous-titres'}</Badge></div>
                <p className="mt-3 text-[11px] text-slate-600">{formatDate(p.created_at)}</p>
                <div className="mt-auto flex gap-1.5 pt-4">
                  {!p.is_default && <Button size="sm" variant="outline" className="flex-1" icon={<Star size={13} />} onClick={() => void onSetDefault(p)}>Défaut</Button>}
                  <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openEdit(p)} title="Modifier" />
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setToDelete(p)} title="Supprimer" />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? 'Modifier les réglages' : 'Nouveau réglage'} description="Ces paramètres seront proposés dans l’UGC Studio."
        footer={<><Button variant="ghost" onClick={() => setModal(false)}>Annuler</Button><Button type="submit" form="preset-form" loading={saving}>{editing ? 'Enregistrer' : 'Créer'}</Button></>}>
        <form id="preset-form" onSubmit={(e) => void onSubmit(e)} className="space-y-4">
          <Input label="Nom" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Témoignage 15 s vertical" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Fournisseur" value={config.provider} onChange={(e) => setConfig({ ...config, provider: e.target.value })}>
              <option value="muapi">MuAPI (vidéo UGC)</option>
            </Select>
            <Select label="Format" value={config.aspect_ratio} onChange={(e) => setConfig({ ...config, aspect_ratio: e.target.value })}>{['9:16', '1:1', '4:5', '16:9'].map((x) => <option key={x}>{x}</option>)}</Select>
            <Input label="Durée (secondes)" type="number" min={5} max={60} value={config.duration_seconds} onChange={(e) => setConfig({ ...config, duration_seconds: Number(e.target.value) })} />
            <Select label="Résolution" value={config.resolution} onChange={(e) => setConfig({ ...config, resolution: e.target.value })}><option value="480p">480p</option><option value="720p">720p</option><option value="1080p">1080p</option></Select>
            <Input label="Style" value={config.style} onChange={(e) => setConfig({ ...config, style: e.target.value })} placeholder="ugc_naturel" />
            <Input label="Vitesse de la voix" type="number" min={0.5} max={2} step={0.1} value={config.voice_speed} onChange={(e) => setConfig({ ...config, voice_speed: Number(e.target.value) })} />
            <Input label="Couleur de fond" value={config.background_color} onChange={(e) => setConfig({ ...config, background_color: e.target.value })} placeholder="#FFFFFF" />
            <Input label="Modèle MuAPI (optionnel)" value={config.model} onChange={(e) => setConfig({ ...config, model: e.target.value })} placeholder="seedance-lite-t2v…" />
          </div>
          <Toggle checked={config.captions} onChange={(v) => setConfig({ ...config, captions: v })} label="Activer les sous-titres" />
          <Toggle checked={isDefault} onChange={setIsDefault} label="Utiliser comme réglage par défaut" />
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(toDelete)} title="Supprimer ces réglages ?" danger confirmLabel="Supprimer" onClose={() => setToDelete(null)} onConfirm={() => void onDelete()} message="Les générations déjà lancées conservent leurs paramètres." />
    </>
  );
}
