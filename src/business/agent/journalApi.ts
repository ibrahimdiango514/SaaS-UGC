/**
 * Le journal de l'agent, en écriture et en lecture réelles.
 *
 * ## Pourquoi ce fichier existe
 * L'écran « Historique de l'agent » écrivait jusqu'ici via `useRecords`, donc via
 * la création d'enregistrement de module partagée. Deux conséquences :
 *  1. la limite de 500 enregistrements par catégorie arrêtait le journal ;
 *  2. changer le statut d'une entrée obligeait à réécrire toute la donnée, ce qui
 *     permettait de réécrire un `resume` ou un montant déjà journalisé.
 *
 * La migration `20261126120000_business_grow_agent_autonomy` fournit trois
 * fonctions dédiées (`bg_journal_append`, `bg_journal_list`,
 * `bg_journal_set_status`) et l'Edge les expose sous `agent.journal`. Ce module
 * est le SEUL point d'accès : aucun autre code ne doit écrire `bg_module_agent_journal`.
 *
 * ## Repli explicite, jamais silencieux
 * Tant que l'Edge n'expose pas `agent.journal` (déploiement non fait), l'appel
 * échoue avec `UNKNOWN_ACTION`. On retombe alors sur l'API générique de module,
 * et on le DIT (`mode`), pour que l'écran puisse afficher un avertissement plutôt
 * que de laisser croire que les garanties du journal sont actives.
 */
import { BusinessGrowApiError, businessGrowApi, type BusinessModuleRecord } from '../api';
import {
  CATEGORIE_JOURNAL,
  entreeFromRecord,
  entreeToData,
  type EntreeJournal,
} from './socle/journal';

/** D'où viennent réellement les entrées affichées. */
export type ModeJournal = 'dedie' | 'repli';

export interface PageJournal {
  entrees: EntreeJournal[];
  /** Nombre de lignes brutes reçues, avant lecture des entrées. */
  brut: number;
  mode: ModeJournal;
}

/**
 * Une action inconnue de l'Edge déployé n'est pas une panne : c'est un
 * déploiement en retard. On la distingue de toute autre erreur pour ne pas
 * masquer un vrai refus de droits (401, 403) derrière un repli.
 */
function actionAbsente(cause: unknown): boolean {
  return cause instanceof BusinessGrowApiError && cause.code === 'UNKNOWN_ACTION';
}

/**
 * Historique trié du plus récent au plus ancien.
 *
 * `workspaceId` nul n'est pas une erreur de saisie : il n'y a simplement pas de
 * journal hors espace de travail (le serveur refuse, on ne tente pas).
 */
export async function lireJournal(
  workspaceId: string | null,
  limite = 100,
  avant: string | null = null,
): Promise<PageJournal> {
  if (!workspaceId) return { entrees: [], brut: 0, mode: 'dedie' };

  if (businessGrowApi.listAgentJournal) {
    try {
      const result = await businessGrowApi.listAgentJournal(workspaceId, limite, avant);
      const records = result.entries ?? [];
      return { entrees: records.map((entree) => entreeFromRecord(entree as unknown as { id: string; data: Record<string, unknown>; created_at?: string })), brut: records.length, mode: 'dedie' };
    } catch (cause) {
      if (!actionAbsente(cause)) throw cause;
    }
  }

  const result = await businessGrowApi.listModuleRecords(CATEGORIE_JOURNAL, workspaceId);
  const records = result.records ?? [];
  return {
    entrees: records.map((entree) => entreeFromRecord(entree as BusinessModuleRecord)),
    brut: records.length,
    mode: 'repli',
  };
}

/** Ajoute une entrée. Le statut « exécutée » exige l'enregistrement écrit. */
export async function ajouterEntree(
  workspaceId: string,
  entree: EntreeJournal,
): Promise<{ id: string; mode: ModeJournal }> {
  const data = entreeToData(entree);

  if (businessGrowApi.appendAgentJournal) {
    try {
      const result = await businessGrowApi.appendAgentJournal(workspaceId, data);
      return { id: result.entryId, mode: 'dedie' };
    } catch (cause) {
      // On ne replie QUE si l'action manque côté serveur. Un refus de droits ou
      // une entrée invalide doit remonter tel quel : la replier reviendrait à
      // contourner la validation du serveur.
      if (!actionAbsente(cause)) throw cause;
    }
  }

  const recordId = await businessGrowApi.createModuleRecord(CATEGORIE_JOURNAL, data, null, workspaceId);
  return { id: recordId.recordId, mode: 'repli' };
}

/**
 * Change le STATUT d'une entrée existante.
 *
 * En mode dédié, seul le statut est transmis : le serveur ne réécrit pas le
 * reste. En repli, on renvoie la donnée complète, faute de mieux — d'où
 * l'intérêt de la voie dédiée.
 */
export async function changerStatutEntree(
  workspaceId: string,
  entree: EntreeJournal,
  statut: EntreeJournal['statut'],
  resultat?: string,
): Promise<ModeJournal> {
  if (businessGrowApi.setAgentJournalStatus) {
    try {
      await businessGrowApi.setAgentJournalStatus(workspaceId, entree.id, statut, resultat ?? null);
      return 'dedie';
    } catch (cause) {
      if (!actionAbsente(cause)) throw cause;
    }
  }

  await businessGrowApi.updateModuleRecord(
    CATEGORIE_JOURNAL,
    entree.id,
    entreeToData({ ...entree, statut, resultat: resultat ?? entree.resultat }),
    workspaceId,
  );
  return 'repli';
}

/** Supprime l'enregistrement métier visé par une action annulée. */
export async function retirerEnregistrement(
  workspaceId: string,
  categorie: string,
  enregistrementId: string,
): Promise<void> {
  await businessGrowApi.deleteModuleRecord(categorie, enregistrementId, workspaceId);
}
