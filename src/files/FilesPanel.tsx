/**
 * VYORA FILES — panneau de gestion des fichiers d'une entreprise.
 *
 * ## Ce que l'utilisateur peut faire ici
 * Importer (avec progression réelle), voir la liste, prévisualiser, télécharger,
 * rattacher à un projet Studio avec un rôle de référence, et supprimer selon
 * ses droits.
 *
 * ## Ce que le panneau ne fait JAMAIS
 * - Il n'affiche pas un fichier comme « envoyé » avant que la base ait confirmé.
 *   La ligne n'apparaît qu'après le retour de `vyora_file_register`.
 * - Il ne prétend pas prévisualiser ce qui n'est pas prévisualisable : un DOCX
 *   affiche son absence d'aperçu, avec le motif.
 * - Il ne rend pas le bouton supprimer actif pour un fichier qu'on n'a pas le
 *   droit de supprimer : le droit est calculé à partir du propriétaire et du
 *   rôle, et la base reste l'arbitre final.
 * - Aucun lien public : la prévisualisation passe par une URL signée, obtenue
 *   à la demande.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Download, FileAudio, FileText, Film, ImageIcon, Loader2, Trash2, Upload, X,
} from 'lucide-react';
import { Badge, Button, EmptyState, ProgressBar, cn } from '../components/ui';
import { asAppError } from '../lib/errors';
import {
  attachToProject, list, remove, signedUrl, upload, validate,
  type VyoraFile,
} from './api';
import {
  IMAGE_REFERENCE_ROLES, MAX_FILE_BYTES, REFERENCE_ROLE_LABELS,
  roleAcceptsKind, type ReferenceRole,
} from './types';

/** Envoi en cours, avec sa progression réelle. */
interface PendingUpload {
  key: string;
  name: string;
  percent: number;
  error?: string;
}

/** Aperçu ouvert : l'URL signée est demandée au moment de l'ouverture. */
interface Preview {
  file: VyoraFile;
  url?: string;
  text?: string;
  error?: string;
  loading: boolean;
}

export interface FilesPanelProps {
  workspaceId: string;
  /** Projet Studio auquel rattacher les nouveaux fichiers (facultatif). */
  projectId?: string | null;
  /** Conversation de l'assistant (facultatif). */
  conversationId?: string | null;
  /** Rôle proposé par défaut à l'import. */
  defaultRole?: ReferenceRole | null;
  /** Le panneau peut-il proposer le rattachement à un projet ? */
  allowProjectAttach?: boolean;
  /** Identifiant du porteur de session, pour calculer les droits d'affichage. */
  currentUserId?: string | null;
  /** Peut-on supprimer les fichiers des autres membres (admin d'entreprise) ? */
  canDeleteOthers?: boolean;
  /** Compact : liste seulement, sans en-tête (intégration dans une colonne). */
  compact?: boolean;
}

function iconFor(kind: VyoraFile['kind']) {
  if (kind === 'image') return ImageIcon;
  if (kind === 'video') return Film;
  if (kind === 'audio') return FileAudio;
  return FileText;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

export function FilesPanel({
  workspaceId,
  projectId = null,
  conversationId = null,
  defaultRole = null,
  allowProjectAttach = false,
  currentUserId = null,
  canDeleteOthers = false,
  compact = false,
}: FilesPanelProps) {
  const [fichiers, setFichiers] = useState<VyoraFile[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreurListe, setErreurListe] = useState<string | null>(null);
  const [envois, setEnvois] = useState<PendingUpload[]>([]);
  const [refus, setRefus] = useState<string[]>([]);
  const [role, setRole] = useState<ReferenceRole | null>(defaultRole);
  const [apercu, setApercu] = useState<Preview | null>(null);
  const [suppression, setSuppression] = useState<string | null>(null);
  const [glisser, setGlisser] = useState(false);
  const champ = useRef<HTMLInputElement>(null);

  const charger = useCallback(async () => {
    setChargement(true);
    setErreurListe(null);
    try {
      const rows = await list(workspaceId, { projectId, conversationId });
      setFichiers(rows);
    } catch (error) {
      setErreurListe(asAppError(error).message);
      setFichiers([]);
    } finally {
      setChargement(false);
    }
  }, [workspaceId, projectId, conversationId]);

  useEffect(() => { void charger(); }, [charger]);

  const accepter = useCallback(
    async (selection: FileList | null) => {
      if (!selection || selection.length === 0) return;
      setRefus([]);

      for (const file of Array.from(selection)) {
        const cle = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
        // Le fichier n'apparaît dans la file qu'une fois VALIDÉ : un format
        // refusé produit un message, pas une ligne fantôme à 0 %.
        let valide;
        try {
          valide = await validate(file);
        } catch (error) {
          setRefus((prev) => [...prev, asAppError(error).message]);
          continue;
        }

        setEnvois((prev) => [...prev, { key: cle, name: file.name, percent: 0 }]);
        try {
          const cree = await upload(workspaceId, valide, {
            referenceRole: role,
            projectId,
            conversationId,
            onProgress: (percent) => {
              setEnvois((prev) => prev.map((e) => (e.key === cle ? { ...e, percent } : e)));
            },
          });
          setFichiers((prev) => [cree, ...prev]);
          setEnvois((prev) => prev.filter((e) => e.key !== cle));
        } catch (error) {
          const message = asAppError(error).message;
          setEnvois((prev) => prev.map((e) => (e.key === cle ? { ...e, error: message } : e)));
        }
      }
    },
    [workspaceId, role, projectId, conversationId],
  );

  const ouvrirApercu = useCallback(async (file: VyoraFile) => {
    setApercu({ file, loading: true });
    if (!file.preview_kind) {
      setApercu({ file, loading: false, error: 'Ce format ne peut pas être prévisualisé. Vous pouvez le télécharger.' });
      return;
    }
    try {
      const url = await signedUrl(file, 300);
      if (file.preview_kind === 'text') {
        // Le texte est lu via l'URL signée : aucun accès public, et le contenu
        // reste dans le navigateur (jamais réenvoyé ailleurs).
        const response = await fetch(url);
        if (!response.ok) throw new Error(`lecture refusée (${response.status})`);
        const texte = await response.text();
        setApercu({ file, url, loading: false, text: texte.slice(0, 20_000) });
        return;
      }
      setApercu({ file, url, loading: false });
    } catch (error) {
      setApercu({ file, loading: false, error: asAppError(error).message });
    }
  }, []);

  const supprimer = useCallback(async (file: VyoraFile) => {
    setSuppression(file.id);
    try {
      await remove(file);
      setFichiers((prev) => prev.filter((f) => f.id !== file.id));
      if (apercu?.file.id === file.id) setApercu(null);
    } catch (error) {
      // L'erreur est affichée dans la liste, à la place du fichier : on ne
      // laisse pas croire à une suppression qui n'a pas eu lieu.
      setErreurListe(asAppError(error).message);
    } finally {
      setSuppression(null);
    }
  }, [apercu]);

  const rattacher = useCallback(async (file: VyoraFile, nouveauRole: ReferenceRole) => {
    if (!projectId) return;
    try {
      const misAJour = await attachToProject(file.id, projectId, nouveauRole);
      setFichiers((prev) => prev.map((f) => (f.id === misAJour.id ? misAJour : f)));
    } catch (error) {
      setErreurListe(asAppError(error).message);
    }
  }, [projectId]);

  const peutSupprimer = useCallback(
    (file: VyoraFile) => Boolean(currentUserId && file.owner_id === currentUserId) || canDeleteOthers,
    [currentUserId, canDeleteOthers],
  );

  const total = useMemo(
    () => fichiers.reduce((somme, f) => somme + Number(f.size_bytes ?? 0), 0),
    [fichiers],
  );

  return (
    <section className={cn('flex flex-col gap-4', compact && 'gap-3')} aria-label="Fichiers de l’entreprise">
      {!compact && (
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-lg text-white">Fichiers et médias</h2>
            <p className="mt-1 text-sm text-slate-400">
              Images, vidéos, documents et tableurs. Stockage privé, isolé par entreprise.
            </p>
          </div>
          <div className="text-right text-xs text-slate-500">
            <div>{fichiers.length} fichier(s) · {formatSize(total)}</div>
            <div>Plafond par fichier : {Math.round(MAX_FILE_BYTES / 1024 / 1024)} Mo</div>
          </div>
        </header>
      )}

      {/* Zone de dépôt : cliquer ou glisser. Le champ est le même que le bouton
          — il n'y a pas deux chemins d'import concurrents. */}
      <div
        onDragOver={(event) => { event.preventDefault(); setGlisser(true); }}
        onDragLeave={() => setGlisser(false)}
        onDrop={(event) => {
          event.preventDefault();
          setGlisser(false);
          void accepter(event.dataTransfer?.files ?? null);
        }}
        className={cn(
          'rounded-xl border border-dashed p-4 transition-colors',
          glisser ? 'border-cyan-400/60 bg-cyan-400/5' : 'border-white/10 bg-white/[0.02]',
        )}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => champ.current?.click()}
            disabled={envois.some((e) => !e.error)}
          >
            <Upload className="h-4 w-4" aria-hidden /> Importer des fichiers
          </Button>
          <input
            ref={champ}
            type="file"
            multiple
            className="sr-only"
            data-testid="files-input"
            onChange={(event) => {
              void accepter(event.target.files);
              event.target.value = '';
            }}
          />
          {allowProjectAttach && (
            <label className="flex items-center gap-2 text-xs text-slate-400">
              Usage
              <select
                className="rounded-md border border-white/10 bg-ink px-2 py-1 text-xs text-slate-200"
                value={role ?? ''}
                onChange={(event) => setRole((event.target.value || null) as ReferenceRole | null)}
              >
                <option value="">Sans usage particulier</option>
                {IMAGE_REFERENCE_ROLES.map((value) => (
                  <option key={value} value={value}>{REFERENCE_ROLE_LABELS[value]}</option>
                ))}
                <option value="video_reference">{REFERENCE_ROLE_LABELS.video_reference}</option>
              </select>
            </label>
          )}
          <span className="text-xs text-slate-500">
            PNG, JPG, WEBP, MP4, MOV, PDF, DOCX, XLSX, CSV, TXT · 50 Mo max
          </span>
        </div>

        {role && (
          <p className="mt-2 text-xs text-amber-300/80">
            Un rôle de référence n’est accepté que si le format correspond :{' '}
            {roleAcceptsKind(role, 'video') ? 'vidéo uniquement' : 'image uniquement'}.
            Les autres formats sont refusés à l’envoi plutôt que mal classés.
          </p>
        )}

        {envois.length > 0 && (
          <ul className="mt-3 space-y-2" aria-live="polite">
            {envois.map((envoi) => (
              <li key={envoi.key} className="text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-slate-300">{envoi.name}</span>
                  {envoi.error ? (
                    <Badge status="erreur">Échec</Badge>
                  ) : (
                    <span className="tabular-nums text-slate-400">{envoi.percent} %</span>
                  )}
                </div>
                <ProgressBar value={envoi.percent} max={100} tone={envoi.error ? 'amber' : 'cyan'} />
                {envoi.error && <p className="mt-1 text-rose-300">{envoi.error}</p>}
              </li>
            ))}
          </ul>
        )}

        {refus.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <ul className="space-y-1">
                {refus.map((message) => <li key={message}>{message}</li>)}
              </ul>
            </div>
          </div>
        )}
      </div>

      {erreurListe && (
        <div className="rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-sm text-rose-200" role="alert">
          {erreurListe}
          <button type="button" className="ml-2 underline" onClick={() => void charger()}>Réessayer</button>
        </div>
      )}

      {chargement ? (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Chargement des fichiers…
        </div>
      ) : fichiers.length === 0 ? (
        <EmptyState
          title="Aucun fichier pour l’instant"
          description="Les fichiers importés ici restent privés à votre entreprise."
          icon={<FileText className="h-5 w-5" aria-hidden />}
        />
      ) : (
        <ul className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.06]">
          {fichiers.map((file) => {
            const Icone = iconFor(file.kind);
            return (
              <li key={file.id} className="flex flex-wrap items-center gap-3 p-3">
                <Icone className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => void ouvrirApercu(file)}
                >
                  <span className="block truncate text-sm text-slate-200">{file.original_name}</span>
                  <span className="block text-xs text-slate-500">
                    {file.mime_type} · {formatSize(Number(file.size_bytes))} · {formatDate(file.created_at)}
                    {file.reference_role ? ` · ${REFERENCE_ROLE_LABELS[file.reference_role]}` : ''}
                    {file.project_id ? ' · rattaché au projet' : ''}
                  </span>
                </button>

                <div className="flex items-center gap-1">
                  {file.preview_kind && (
                    <Button variant="ghost" size="sm" onClick={() => void ouvrirApercu(file)}>
                      Aperçu
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Supprimer ${file.original_name}`}
                    disabled={!peutSupprimer(file) || suppression === file.id}
                    title={peutSupprimer(file) ? 'Supprimer' : 'Vous n’avez pas les droits sur ce fichier'}
                    onClick={() => void supprimer(file)}
                  >
                    {suppression === file.id
                      ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      : <Trash2 className="h-4 w-4" aria-hidden />}
                  </Button>
                </div>

                {allowProjectAttach && projectId && file.kind !== 'document' && file.kind !== 'spreadsheet' && (
                  <select
                    className="rounded-md border border-white/10 bg-ink px-2 py-1 text-xs text-slate-200"
                    value={file.reference_role ?? ''}
                    aria-label={`Usage de ${file.original_name}`}
                    onChange={(event) => {
                      const valeur = event.target.value as ReferenceRole;
                      if (valeur) void rattacher(file, valeur);
                    }}
                  >
                    <option value="">Usage…</option>
                    {(file.kind === 'video' ? ['video_reference'] as ReferenceRole[] : IMAGE_REFERENCE_ROLES)
                      .map((value) => (
                        <option key={value} value={value}>{REFERENCE_ROLE_LABELS[value]}</option>
                      ))}
                  </select>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {apercu && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Aperçu de ${apercu.file.original_name}`}
          onClick={() => setApercu(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-2xl border border-white/10 bg-ink p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm text-white">{apercu.file.original_name}</h3>
                <p className="text-xs text-slate-500">{apercu.file.mime_type}</p>
              </div>
              <button type="button" aria-label="Fermer" onClick={() => setApercu(null)}>
                <X className="h-4 w-4 text-slate-400" aria-hidden />
              </button>
            </div>

            {apercu.loading && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Préparation de l’aperçu…
              </div>
            )}

            {apercu.error && (
              <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-sm text-amber-200">
                {apercu.error}
              </p>
            )}

            {apercu.url && apercu.file.preview_kind === 'image' && (
              <img src={apercu.url} alt={apercu.file.original_name} className="max-h-[60vh] w-auto rounded-lg" />
            )}
            {apercu.url && apercu.file.preview_kind === 'video' && (
              <video src={apercu.url} controls className="max-h-[60vh] w-full rounded-lg" />
            )}
            {apercu.url && apercu.file.preview_kind === 'pdf' && (
              <iframe src={apercu.url} title={apercu.file.original_name} className="h-[60vh] w-full rounded-lg" />
            )}
            {apercu.text && (
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-xs text-slate-300">
                {apercu.text}
              </pre>
            )}

            {apercu.url && (
              <a
                href={apercu.url}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-2 text-xs text-cyan-300 underline"
              >
                <Download className="h-3.5 w-3.5" aria-hidden /> Ouvrir dans un onglet
              </a>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
