/**
 * Journal des actions de l'agent.
 *
 * Chaque demande, décision et action est enregistrée DANS L'ESPACE DE TRAVAIL
 * (catégorie `bg_module_agent_journal`), avec : qui, quand, quoi, l'état avant,
 * l'état après, et le résultat. Le journal est la contrepartie de l'autonomie :
 * si l'agent peut agir, l'utilisateur doit pouvoir relire et annuler.
 *
 * Aucune donnée n'est écrite ici : ce fichier ne fait que construire et
 * interpréter des enregistrements. L'écriture passe par `useRecords`, donc par
 * l'Edge Function et ses contrôles de droits (`bg_can_workspace`).
 */

import type { NomOutil } from './outils';

export const CATEGORIE_JOURNAL = 'bg_module_agent_journal';

export type StatutEntree = 'proposee' | 'validee' | 'refusee' | 'executee' | 'echouee' | 'annulee';

export interface EntreeJournal {
  id: string;
  /** Horodatage ISO de la décision ou de l'action. */
  horodatage: string;
  outil: NomOutil | null;
  resume: string;
  statut: StatutEntree;
  /** Qui a décidé : l'utilisateur ou la règle automatique. */
  decidePar: 'utilisateur' | 'regle';
  regleId: string | null;
  /** État avant/après, quand une écriture a eu lieu. */
  avant: Record<string, unknown> | null;
  apres: Record<string, unknown> | null;
  /** Résultat lisible renvoyé par le service, jamais une supposition. */
  resultat: string;
  /** Identifiant de l'enregistrement métier écrit, pour pouvoir l'annuler. */
  enregistrementId: string | null;
  categorie: string | null;
  annulable: boolean;
}

export interface EntreeJournalBrute {
  id: string;
  data: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

const STATUTS: readonly StatutEntree[] = ['proposee', 'validee', 'refusee', 'executee', 'echouee', 'annulee'];

function texte(valeur: unknown, max = 500): string {
  return typeof valeur === 'string' ? valeur.slice(0, max) : '';
}

function objet(valeur: unknown): Record<string, unknown> | null {
  return valeur && typeof valeur === 'object' && !Array.isArray(valeur) ? valeur as Record<string, unknown> : null;
}

/**
 * Relit une entrée de journal depuis la base.
 *
 * Tout champ inconnu retombe sur une valeur neutre : un enregistrement
 * incomplet ne doit jamais faire croire qu'une action a réussi.
 */
export function entreeFromRecord(record: EntreeJournalBrute): EntreeJournal {
  const data = record.data ?? {};
  const statut = STATUTS.includes(data.statut as StatutEntree) ? data.statut as StatutEntree : 'proposee';
  return {
    id: record.id,
    horodatage: texte(data.horodatage, 40) || record.created_at || '',
    outil: typeof data.outil === 'string' ? data.outil as NomOutil : null,
    resume: texte(data.resume, 400),
    statut,
    decidePar: data.decidePar === 'regle' ? 'regle' : 'utilisateur',
    regleId: texte(data.regleId, 80) || null,
    avant: objet(data.avant),
    apres: objet(data.apres),
    resultat: texte(data.resultat, 600),
    enregistrementId: texte(data.enregistrementId, 64) || null,
    categorie: texte(data.categorie, 80) || null,
    annulable: data.annulable === true,
  };
}

export function entreeToData(entree: EntreeJournal): Record<string, unknown> {
  return {
    horodatage: entree.horodatage,
    outil: entree.outil,
    resume: entree.resume,
    statut: entree.statut,
    decidePar: entree.decidePar,
    regleId: entree.regleId,
    avant: entree.avant,
    apres: entree.apres,
    resultat: entree.resultat,
    enregistrementId: entree.enregistrementId,
    categorie: entree.categorie,
    annulable: entree.annulable,
  };
}

/**
 * Une entrée peut-elle être annulée ?
 *
 * Trois conditions cumulatives : l'action a été EXÉCUTÉE, elle est déclarée
 * annulable par son outil, et on connaît l'enregistrement à défaire. Une
 * proposition non exécutée n'a rien à annuler ; une action déjà annulée non plus.
 */
export function peutAnnuler(entree: EntreeJournal): boolean {
  return entree.statut === 'executee'
    && entree.annulable
    && typeof entree.enregistrementId === 'string'
    && entree.enregistrementId.length > 0
    && typeof entree.categorie === 'string'
    && entree.categorie.startsWith('bg_module_');
}

/**
 * Marque une entrée comme annulée.
 *
 * On conserve `avant`/`apres` intacts : l'annulation est un événement de plus
 * dans le journal, pas un effacement de l'historique.
 */
export function marquerAnnulee(entree: EntreeJournal, parQui: string, quand = new Date().toISOString()): EntreeJournal {
  if (!peutAnnuler(entree)) return entree;
  return {
    ...entree,
    statut: 'annulee',
    resultat: `Annulée par ${parQui || 'l’utilisateur'} le ${quand.slice(0, 10)} : ${entree.resultat}`.slice(0, 600),
    annulable: false,
  };
}

/** Journal ordonné du plus récent au plus ancien, borné pour l'affichage mobile. */
export function journalRecent(entrees: readonly EntreeJournal[], limite = 50): EntreeJournal[] {
  return [...entrees]
    .sort((a, b) => (a.horodatage < b.horodatage ? 1 : a.horodatage > b.horodatage ? -1 : 0))
    .slice(0, limite);
}
