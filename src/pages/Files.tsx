/**
 * SORAHNEX FILES — page de gestion des fichiers de l'entreprise.
 *
 * ## Pourquoi cette page existe
 * Le panneau `FilesPanel` savait déjà importer, lister, prévisualiser,
 * télécharger, rattacher à un projet et supprimer — mais il n'était monté nulle
 * part. Un fichier téléversé depuis l'assistant n'était donc consultable que
 * dans le fil de la conversation, sans moyen de le retrouver, de le réutiliser
 * ailleurs ni de le supprimer. Cette page lui donne sa place : c'est le point
 * d'entrée unique du système de fichiers, commun à Grow et au Studio.
 *
 * ## Ce qu'elle ne fait pas
 * Elle n'invente aucun droit : `workspaceId` vient de la session, et la base
 * reste l'arbitre (RLS + fonctions `SECURITY DEFINER`). Aucune URL publique
 * n'est exposée : chaque aperçu demande une URL signée à durée limitée.
 */
import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, HardDrive } from 'lucide-react';
import { Card, CardHeader, EmptyState, LoadingState, Select } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { FilesPanel } from '../files/FilesPanel';
import { MAX_FILE_BYTES } from '../files/types';
import { listProjects } from '../lib/api';
import type { Project } from '../lib/types';

export default function Files() {
  const { workspaceId, user } = useAuth();
  const [projets, setProjets] = useState<Project[]>([]);
  const [projetId, setProjetId] = useState('');
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    let actif = true;
    void (async () => {
      try {
        // Les projets servent à rattacher un fichier et à filtrer la liste.
        const rows = await listProjects();
        if (actif) setProjets(rows);
      } catch {
        // L'absence de projets ne doit pas empêcher de gérer ses fichiers.
      } finally {
        if (actif) setChargement(false);
      }
    })();
    return () => { actif = false; };
  }, []);

  const limite = useMemo(
    () => `${Math.round(MAX_FILE_BYTES / (1024 * 1024))} Mo par fichier`,
    [],
  );

  if (!workspaceId) {
    return (
      <EmptyState
        title="Espace de travail indisponible"
        description="Les fichiers sont rattachés à votre entreprise. Rechargez la page ou vérifiez votre session."
      />
    );
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Fichiers et médias"
          description={`Images, vidéos, documents, tableurs et fichiers professionnels. ${limite}, formats contrôlés à l’envoi, accès limité à votre entreprise.`}
          action={<HardDrive className="h-4 w-4 text-slate-500" aria-hidden />}
        />
        <div className="p-5">
          {chargement ? (
            <LoadingState label="Chargement des fichiers…" />
          ) : (
            <FilesPanel
              workspaceId={workspaceId}
              projectId={projetId || null}
              allowProjectAttach
              currentUserId={user?.id ?? null}
            />
          )}
        </div>
      </Card>

      {projets.length > 0 && (
        <Card>
          <CardHeader
            title="Filtrer par projet"
            description="Un fichier rattaché à un projet devient une référence réutilisable dans le Studio."
            action={<FolderOpen className="h-4 w-4 text-slate-500" aria-hidden />}
          />
          <div className="p-5">
            <Select
              label="Projet"
              value={projetId}
              onChange={(event) => setProjetId(event.target.value)}
              hint="Sans sélection, tous les fichiers de l’entreprise sont affichés."
            >
              <option value="">Tous les fichiers de l’entreprise</option>
              {projets.map((projet) => (
                <option key={projet.id} value={projet.id}>{projet.title}</option>
              ))}
            </Select>
          </div>
        </Card>
      )}
    </div>
  );
}
