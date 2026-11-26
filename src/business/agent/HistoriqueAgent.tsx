/**
 * Historique de l'agent — journal persistant, consultable et annulable.
 *
 * Chaque entrée dit QUI a décidé, QUOI, sur quoi, avec quel résultat. Le bouton
 * « Annuler » n'apparaît que lorsque c'est réellement possible : action
 * exécutée, déclarée annulable, rattachée à un enregistrement, et pas déjà
 * annulée. Proposer une annulation qui échoue serait pire que ne rien proposer.
 *
 * L'annulation CONSERVE l'historique : on écrit une entrée `annulee`, on ne
 * supprime rien.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, cn } from '../../components/ui';
import { useOptionalToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { journalRecent, marquerAnnulee, peutAnnuler, type EntreeJournal, type StatutEntree } from './socle/journal';
import { changerStatutEntree, lireJournal, retirerEnregistrement, type ModeJournal } from './journalApi';

const TON_STATUT: Record<StatutEntree, 'success' | 'warning' | 'danger' | 'neutral'> = {
  proposee: 'warning', validee: 'success', refusee: 'neutral',
  executee: 'success', echouee: 'danger', annulee: 'neutral',
};

const LIBELLE_STATUT: Record<StatutEntree, string> = {
  proposee: 'Proposée', validee: 'Validée', refusee: 'Refusée',
  executee: 'Exécutée', echouee: 'Échouée', annulee: 'Annulée',
};

export function HistoriqueAgent({ workspaceId }: { workspaceId: string | null }) {
  const toast = useOptionalToast();
  const [entrees, setEntrees] = useState<EntreeJournal[]>([]);
  const [mode, setMode] = useState<ModeJournal>('dedie');
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState<string | null>(null);
  const [filtre, setFiltre] = useState<'tous' | 'proposee' | 'executee'>('tous');

  const charger = useCallback(async () => {
    if (!workspaceId) {
      setEntrees([]);
      setErreur('Aucune entreprise active.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setErreur(null);
    try {
      const page = await lireJournal(workspaceId, 100);
      setEntrees(page.entrees);
      setMode(page.mode);
    } catch (cause) {
      setErreur(asAppError(cause).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void charger(); }, [charger]);
  const visibles = useMemo(() => {
    const recentes = journalRecent(entrees, 100);
    return filtre === 'tous' ? recentes : recentes.filter((entree) => entree.statut === filtre);
  }, [entrees, filtre]);

  /** Nombre d'actions réellement exécutées et encore annulables. */
  const annulables = entrees.filter(peutAnnuler).length;

  const annuler = async (entree: EntreeJournal) => {
    if (!workspaceId || !peutAnnuler(entree)) return;
    setEnCours(entree.id);
    try {
      // 1. On retire d'abord la donnée métier écrite.
      await retirerEnregistrement(workspaceId, entree.categorie!, entree.enregistrementId!);
      // 2. Puis on marque l'entrée annulée : le serveur ne réécrit QUE le
      //    statut, le reste de l'entrée (montant, résumé, décision) est figé.
      const annulee = marquerAnnulee(entree, 'vous');
      setMode(await changerStatutEntree(workspaceId, entree, 'annulee', annulee.resultat));
      setEntrees((precedent) => precedent.map((ligne) => (ligne.id === entree.id ? annulee : ligne)));
      toast?.success('Action annulée. L’historique en garde la trace.');
    } catch (cause) {
      // L'entrée n'est PAS marquée annulée si la donnée n'a pas pu être
      // retirée : afficher « annulée » sans l'avoir fait serait un mensonge.
      toast?.error(asAppError(cause).message);
    } finally {
      setEnCours(null);
    }
  };

  if (loading) return <LoadingState label="Chargement de l’historique…" />;
  if (erreur) return <ErrorState message={erreur} onRetry={() => void charger()} />;

  return (
    <Card data-testid="historique-agent">
      <CardHeader
        title="Historique de l’agent"
        description="Chaque demande, décision et action, avec sa trace. Rien n’est effacé."
        action={<Badge tone="neutral">{entrees.length} entrée(s)</Badge>}
      />

      {mode === 'repli' && (
        <p className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5 text-[10.5px] text-amber-200/90">
          Journal en mode compatible : le serveur déployé ne connaît pas encore le journal dédié.
          Les entrées affichées sont réelles, mais la limite de volume est celle du stockage de module.
        </p>
      )}

      {entrees.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="Filtrer l’historique">
          {([['tous', 'Tout'], ['proposee', 'Proposées'], ['executee', 'Exécutées']] as const).map(([valeur, label]) => (
            <Button key={valeur} size="sm" variant={filtre === valeur ? 'primary' : 'ghost'} aria-pressed={filtre === valeur} onClick={() => setFiltre(valeur)}>
              {label}
            </Button>
          ))}
          {annulables > 0 && <span className="self-center text-[10px] text-slate-400">{annulables} annulable(s)</span>}
        </div>
      )}

      {visibles.length === 0 ? (
        <EmptyState
          icon={<History size={22} />}
          title={entrees.length === 0 ? 'Aucune action de l’agent' : 'Aucune entrée dans ce filtre'}
          description={entrees.length === 0
            ? 'Utilisez « L’agent s’en occupe » dans le briefing, ou demandez une action dans l’assistant : chaque proposition apparaîtra ici.'
            : 'Changez de filtre pour voir le reste de l’historique.'}
        />
      ) : (
        <ul className="liste-mobile overflow-hidden rounded-xl border border-white/[0.06]">
          {visibles.map((entree) => (
            <li key={entree.id} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-semibold text-white">{entree.resume || 'Action sans libellé'}</p>
                  <p className="mt-0.5 text-[10.5px] text-slate-500">
                    {formatDate(entree.horodatage)} · {entree.decidePar === 'regle' ? `règle ${entree.regleId ?? ''}` : 'vous'}
                  </p>
                </div>
                <Badge tone={TON_STATUT[entree.statut]}>{LIBELLE_STATUT[entree.statut]}</Badge>
              </div>
              {entree.resultat && <p className="mt-1 text-[10.5px] text-slate-400">{entree.resultat}</p>}
              {peutAnnuler(entree) && (
                <div className="mt-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<RotateCcw size={12} />}
                    loading={enCours === entree.id}
                    onClick={() => void annuler(entree)}
                  >
                    Annuler cette action
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {entrees.length > 0 && (
        <p className={cn('mt-2 text-[10px] text-slate-500')}>
          L’annulation retire la donnée écrite mais conserve la ligne d’historique : vous pouvez toujours savoir ce qui a été fait, et quand.
        </p>
      )}
    </Card>
  );
}

function formatDate(iso: string): string {
  if (!iso) return 'date inconnue';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}
