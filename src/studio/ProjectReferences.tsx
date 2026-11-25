/**
 * Studio — références du projet (images et vidéos).
 *
 * ## Ce que ce panneau apporte
 * Les références sont enregistrées dans `vyora_files`, rattachées au PROJET, et
 * donc réutilisables d'une génération à l'autre. Auparavant, une image de
 * référence vivait dans le formulaire courant : recharger la page la perdait.
 *
 * ## Ce qu'il ne fait pas
 * - Il n'envoie aucune référence au modèle : c'est `planReferences` qui décide,
 *   à partir des champs RÉELLEMENT déclarés par le modèle sélectionné.
 * - Il n'affiche pas « acceptée » une référence que le modèle ne sait pas lire :
 *   le verdict est calculé et affiché par référence, avec le motif.
 * - Il ne mélange jamais les projets : chaque liste est filtrée par projet ET
 *   par entreprise (la RLS le re-vérifie côté base).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Film, ImageIcon, Loader2, Trash2, Upload, X } from 'lucide-react';
import { Badge, Button, ProgressBar, cn } from '../components/ui';
import { asAppError } from '../lib/errors';
import {
  attachToProject, list, remove, signedUrl, upload, validate, type SorahnnexFile,
} from '../files/api';
import { IMAGE_REFERENCE_ROLES, REFERENCE_ROLE_LABELS, type ReferenceRole } from '../files/types';
import {
  planReferences, referenceSupport, type ResolvedReference,
} from './references';

export interface ProjectReferencesProps {
  workspaceId: string;
  projectId: string;
  /** Champs d'entrée déclarés par le modèle sélectionné. */
  modelInputFields: string[];
  /** Nom du modèle, pour un message explicite. */
  modelLabel?: string;
  currentUserId?: string | null;
  /** Remonte la répartition calculée, pour l'envoi. */
  onPlanChange?: (plan: ReturnType<typeof planReferences> | null) => void;
}

const ROLES_PAR_GENRE: Record<'image' | 'video', ReferenceRole[]> = {
  image: IMAGE_REFERENCE_ROLES,
  video: ['video_reference'],
};

export function ProjectReferences({
  workspaceId,
  projectId,
  modelInputFields,
  modelLabel,
  currentUserId = null,
  onPlanChange,
}: ProjectReferencesProps) {
  const [fichiers, setFichiers] = useState<SorahnnexFile[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [roleChoisi, setRoleChoisi] = useState<ReferenceRole>('product');
  const [envoi, setEnvoi] = useState<{ name: string; percent: number } | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const champ = useRef<HTMLInputElement>(null);

  const support = useMemo(() => referenceSupport(modelInputFields), [modelInputFields]);

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      // Uniquement les images et vidéos : les documents du projet n'ont pas
      // leur place dans les références visuelles.
      const rows = await list(workspaceId, { projectId });
      setFichiers(rows.filter((row) => row.kind === 'image' || row.kind === 'video'));
    } catch (error) {
      setErreur(asAppError(error).message);
      setFichiers([]);
    } finally {
      setChargement(false);
    }
  }, [workspaceId, projectId]);

  useEffect(() => { void charger(); }, [charger]);

  // Les vignettes passent par des URL signées, demandées après le rendu pour
  // ne pas bloquer la liste si la signature échoue.
  useEffect(() => {
    let actif = true;
    void (async () => {
      const manquants = fichiers.filter((f) => !urls[f.id]);
      if (manquants.length === 0) return;
      const paires: Array<[string, string]> = [];
      for (const fichier of manquants) {
        try {
          paires.push([fichier.id, await signedUrl(fichier, 900)]);
        } catch {
          // Une vignette indisponible n'empêche pas d'utiliser la référence.
        }
      }
      if (actif && paires.length > 0) {
        setUrls((prev) => ({ ...prev, ...Object.fromEntries(paires) }));
      }
    })();
    return () => { actif = false; };
  }, [fichiers, urls]);

  const references: ResolvedReference[] = useMemo(
    () => fichiers.map((fichier) => ({
      fileId: fichier.id,
      name: fichier.original_name,
      kind: fichier.kind === 'video' ? 'video' as const : 'image' as const,
      role: fichier.reference_role,
      storagePath: fichier.storage_path,
      url: urls[fichier.id] ?? '',
    })),
    [fichiers, urls],
  );

  const plan = useMemo(() => planReferences(references, support), [references, support]);

  useEffect(() => {
    onPlanChange?.(references.length > 0 ? plan : null);
  }, [plan, references.length, onPlanChange]);

  const statutDe = useCallback((fileId: string) => {
    if (plan.images.some((r) => r.fileId === fileId) || plan.videos.some((r) => r.fileId === fileId)) {
      return { ok: true, texte: 'Transmise à ce modèle' };
    }
    const rejet = plan.rejected.find((r) => r.reference.fileId === fileId);
    return { ok: false, texte: rejet?.reason ?? 'Non transmise' };
  }, [plan]);

  const ajouter = useCallback(async (selection: FileList | null) => {
    if (!selection || selection.length === 0) return;
    setErreur(null);
    for (const file of Array.from(selection)) {
      setEnvoi({ name: file.name, percent: 0 });
      try {
        const valide = await validate(file);
        if (valide.detected.kind !== 'image' && valide.detected.kind !== 'video') {
          throw new Error(`« ${file.name} » n’est ni une image ni une vidéo : inutilisable comme référence.`);
        }
        const cree = await upload(workspaceId, valide, {
          referenceRole: roleChoisi,
          projectId,
          onProgress: (percent) => setEnvoi({ name: file.name, percent }),
        });
        // Rattachement explicite : la référence appartient au projet, donc
        // réutilisable dans les générations suivantes.
        const rattache = await attachToProject(cree.id, projectId, roleChoisi);
        setFichiers((prev) => [rattache, ...prev]);
      } catch (error) {
        setErreur(asAppError(error).message);
      } finally {
        setEnvoi(null);
      }
    }
  }, [workspaceId, projectId, roleChoisi]);

  const retirer = useCallback(async (fichier: SorahnnexFile) => {
    try {
      await remove(fichier);
      setFichiers((prev) => prev.filter((f) => f.id !== fichier.id));
    } catch (error) {
      setErreur(asAppError(error).message);
    }
  }, []);

  return (
    <section className="space-y-3" aria-label="Références du projet" data-testid="project-references">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-white">Références du projet</h3>
          <p className="text-[11px] text-slate-500">
            Personnages, produits, décors, environnements et vidéos. Conservées avec le projet.
          </p>
        </div>
        <span className="text-[11px] text-slate-500">
          {support.imageField
            ? `${support.imageLimit} image(s) max${support.videoField ? ' · 1 vidéo' : ''}`
            : 'Ce modèle n’accepte aucun média'}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" onClick={() => champ.current?.click()} disabled={Boolean(envoi)}>
          <Upload className="h-4 w-4" aria-hidden /> Ajouter une référence
        </Button>
        <input
          ref={champ}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime"
          className="sr-only"
          data-testid="reference-input"
          onChange={(event) => {
            void ajouter(event.target.files);
            event.target.value = '';
          }}
        />
        <label className="flex items-center gap-2 text-[11px] text-slate-400">
          Type
          <select
            aria-label="Type de référence"
            className="rounded-md border border-white/10 bg-ink px-2 py-1 text-[11px] text-slate-200"
            value={roleChoisi}
            onChange={(event) => setRoleChoisi(event.target.value as ReferenceRole)}
          >
            {ROLES_PAR_GENRE.image.map((role) => (
              <option key={role} value={role}>{REFERENCE_ROLE_LABELS[role]}</option>
            ))}
            <option value="video_reference">{REFERENCE_ROLE_LABELS.video_reference}</option>
          </select>
        </label>
      </div>

      {envoi && (
        <div className="text-[11px] text-slate-400">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{envoi.name}</span>
            <span className="tabular-nums">{envoi.percent} %</span>
          </div>
          <ProgressBar value={envoi.percent} max={100} tone="cyan" />
        </div>
      )}

      {erreur && (
        <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-2 text-[11px] text-amber-200" role="alert">
          {erreur}
          <button type="button" className="ml-2 underline" onClick={() => setErreur(null)} aria-label="Masquer">
            <X className="inline h-3 w-3" aria-hidden />
          </button>
        </div>
      )}

      {plan.warning && (
        <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-2 text-[11px] text-amber-200">
          {plan.warning} {modelLabel ? `Modèle : ${modelLabel}.` : ''}
        </p>
      )}

      {chargement ? (
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Chargement…
        </div>
      ) : fichiers.length === 0 ? (
        <p className="text-[11px] text-slate-500">
          Aucune référence. Les fichiers ajoutés ici resteront attachés à ce projet.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {fichiers.map((fichier) => {
            const statut = statutDe(fichier.id);
            const Icone = fichier.kind === 'video' ? Film : ImageIcon;
            return (
              <li
                key={fichier.id}
                className={cn(
                  'group relative overflow-hidden rounded-lg border bg-black/30',
                  statut.ok ? 'border-cyan-400/30' : 'border-white/10 opacity-70',
                )}
              >
                {urls[fichier.id] && fichier.kind === 'image' ? (
                  <img
                    src={urls[fichier.id]}
                    alt={fichier.original_name}
                    className="h-24 w-full object-cover"
                  />
                ) : urls[fichier.id] && fichier.kind === 'video' ? (
                  <video src={urls[fichier.id]} className="h-24 w-full object-cover" muted playsInline />
                ) : (
                  <div className="flex h-24 w-full items-center justify-center">
                    <Icone className="h-6 w-6 text-slate-600" aria-hidden />
                  </div>
                )}

                <div className="space-y-1 p-1.5">
                  <p className="truncate text-[10px] text-slate-300" title={fichier.original_name}>
                    {fichier.original_name}
                  </p>
                  <div className="flex items-center justify-between gap-1">
                    <Badge status={statut.ok ? 'ok' : 'inactif'}>{statut.ok ? 'utilisée' : 'ignorée'}</Badge>
                    {(currentUserId === fichier.owner_id) && (
                      <button
                        type="button"
                        aria-label={`Retirer ${fichier.original_name}`}
                        className="rounded p-0.5 text-slate-500 hover:text-rose-300"
                        onClick={() => void retirer(fichier)}
                      >
                        <Trash2 className="h-3 w-3" aria-hidden />
                      </button>
                    )}
                  </div>
                  {!statut.ok && (
                    <p className="text-[9px] leading-tight text-amber-300/80">{statut.texte}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
