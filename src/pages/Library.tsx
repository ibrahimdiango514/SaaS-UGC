import { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, Film, HardDrive, Trash2, Sparkles } from 'lucide-react';
import { PageHeader, Card, Button, Badge, LoadingState, ErrorState, EmptyState, ConfirmDialog } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { asAppError } from '../lib/errors';
import { formatBytes, formatDate } from '../lib/format';
import { deleteAsset, listAssets, signedStorageUrl } from '../lib/api';
import type { GeneratedAsset } from '../lib/types';

function VideoCard({ asset, onDelete }: { asset: GeneratedAsset; onDelete: (a: GeneratedAsset) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    signedStorageUrl(asset.storage_path, 3600)
      .then((u) => { if (active) setUrl(u); })
      .catch((e) => { if (active) setError(asAppError(e).message); });
    return () => { active = false; };
  }, [asset.storage_path]);

  return (
    <Card className="overflow-hidden">
      <div className="relative aspect-video bg-black/60">
        {url ? <video src={url} controls preload="metadata" className="h-full w-full" /> : (
          <div className="grid h-full place-items-center"><Film size={28} className={error ? 'text-rose-400' : 'text-slate-600'} /></div>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-center justify-between gap-2"><Badge tone="success">Vidéo</Badge><span className="text-[11px] text-slate-500">{formatDate(asset.created_at, true)}</span></div>
        <p className="mt-2 truncate text-xs text-slate-400" title={asset.storage_path}>{asset.storage_path}</p>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-500"><span className="flex items-center gap-1"><HardDrive size={12} /> {formatBytes(asset.file_size_bytes)}</span><span>{asset.mime_type ?? 'video/mp4'}</span></div>
        <div className="mt-3 flex gap-1.5">
          {url && <a href={url} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm flex-1"><ExternalLink size={13} /> Ouvrir</a>}
          {url && <a href={url} download className="btn btn-outline btn-sm" title="Télécharger"><Download size={13} /></a>}
          <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => onDelete(asset)} title="Supprimer" />
        </div>
        {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
      </div>
    </Card>
  );
}

export default function Library() {
  const toast = useToast();
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toDelete, setToDelete] = useState<GeneratedAsset | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setAssets(await listAssets()); }
    catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onDelete = async () => {
    if (!toDelete) return;
    try {
      await deleteAsset(toDelete.id, toDelete.storage_path);
      toast.success('Création supprimée.'); setToDelete(null); await load();
    } catch (err) { toast.error(asAppError(err).message); }
  };

  return (
    <>
      <PageHeader eyebrow="Bibliothèque" title="Mes créations" description="Vidéos réellement générées et stockées dans votre espace privé."
        actions={<Button variant="ghost" size="sm" onClick={() => void load()}>Actualiser</Button>} />
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {loading ? <LoadingState label="Chargement de la bibliothèque…" /> : assets.length === 0 ? (
        <EmptyState icon={<Sparkles size={24} />} title="Aucune création" description="Les vidéos produites depuis l’UGC Studio apparaîtront ici. Aucun fichier de démonstration n’est affiché."
          action={<a href="/app/studio" className="btn btn-primary btn-sm">Ouvrir l’UGC Studio</a>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{assets.map((a) => <VideoCard key={a.id} asset={a} onDelete={setToDelete} />)}</div>
      )}
      <ConfirmDialog open={Boolean(toDelete)} title="Supprimer cette création ?" danger confirmLabel="Supprimer" onClose={() => setToDelete(null)} onConfirm={() => void onDelete()}
        message="Le fichier vidéo et sa fiche seront supprimés. Cette action est irréversible." />
    </>
  );
}
