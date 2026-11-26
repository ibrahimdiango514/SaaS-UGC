/**
 * Échéances et conformité — rappels de dates, jamais de conseil.
 *
 * ## La limite, écrite noir sur blanc
 * Cette brique ne dit JAMAIS ce que l'utilisateur doit déclarer, quel taux
 * s'applique, ni ce qu'exige la loi d'un pays donné. Elle rappelle des DATES que
 * l'utilisateur a lui-même saisies ou choisies dans une liste de repères
 * courants, et elle répète systématiquement que la vérification lui revient.
 *
 * ## Pourquoi une liste de repères et pas des règles par pays
 * Un barème fiscal ou social change d'une année à l'autre, varie selon le
 * statut, le chiffre d'affaires et la commune. L'encoder ici donnerait une
 * fausse assurance, et une date fausse coûte une pénalité réelle. Les repères
 * proposés sont donc des ÉTIQUETTES neutres, à confirmer par l'utilisateur.
 */

export type CategorieEcheance =
  | 'taxes'
  | 'social'
  | 'renouvellement'
  | 'contrat'
  | 'licence'
  | 'assurance'
  | 'autre';

export const CATEGORIES_ECHEANCE: readonly { value: CategorieEcheance; label: string }[] = [
  { value: 'taxes', label: 'Taxes et obligations fiscales' },
  { value: 'social', label: 'Cotisations sociales' },
  { value: 'renouvellement', label: 'Renouvellement (registre, agrément)' },
  { value: 'contrat', label: 'Contrat (terme, préavis)' },
  { value: 'licence', label: 'Licence logicielle' },
  { value: 'assurance', label: 'Assurance' },
  { value: 'autre', label: 'Autre' },
];

/**
 * Repères PROPOSÉS à la saisie. Ce sont des libellés à confirmer, pas des
 * obligations légales : aucun taux, aucune sanction, aucun pays imposé.
 */
export const REPERES_COURANTS: readonly { label: string; categorie: CategorieEcheance; aide: string }[] = [
  { label: 'Déclaration périodique de mon activité', categorie: 'taxes', aide: 'La fréquence et la forme dépendent de votre statut : vérifiez auprès de votre administration.' },
  { label: 'Cotisation retraite / santé', categorie: 'social', aide: 'Le montant et la date dépendent de votre caisse.' },
  { label: 'Renouvellement du registre du commerce', categorie: 'renouvellement', aide: 'La durée de validité varie selon le pays.' },
  { label: 'Fin de contrat de prestation', categorie: 'contrat', aide: 'Vérifiez le préavis réellement écrit dans le contrat.' },
  { label: 'Renouvellement de licence logicielle', categorie: 'licence', aide: 'Date de facturation de l’éditeur.' },
  { label: 'Échéance d’assurance professionnelle', categorie: 'assurance', aide: 'Date d’effet figurant sur votre attestation.' },
];

export interface Echeance {
  id: string;
  label: string;
  categorie: CategorieEcheance;
  /** Date seule `YYYY-MM-DD`. Une date impossible est refusée à la saisie. */
  date: string;
  /** Recurrence annuelle ou mensuelle, ou aucune. */
  recurrence: 'aucune' | 'mensuelle' | 'annuelle';
  notes: string;
  /** Vrai quand l'utilisateur a confirmé l'information auprès de sa source. */
  verifiee: boolean;
}

export type UrgenceEcheance = 'passee' | 'aujourdhui' | 'proche' | 'a_venir';

export interface EcheanceVue {
  echeance: Echeance;
  joursRestants: number;
  urgence: UrgenceEcheance;
  /** Date réelle de la prochaine occurrence, si la récurrence en crée une. */
  prochaineDate: string;
}

/** Une date `YYYY-MM-DD` qui existe vraiment (le 31 février est refusé). */
export function dateReelle(valeur: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valeur)) return false;
  const date = new Date(`${valeur}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === valeur;
}

export function joursEntre(depuis: string, jusqu: string): number {
  if (!dateReelle(depuis) || !dateReelle(jusqu)) return 0;
  return Math.round((Date.parse(`${jusqu}T00:00:00Z`) - Date.parse(`${depuis}T00:00:00Z`)) / 86_400_000);
}

/**
 * Prochaine occurrence à partir d'aujourd'hui.
 *
 * Une échéance annuelle dépassée est reportée d'autant d'années que nécessaire :
 * on n'affiche pas « passée depuis 400 jours » pour un rappel qui revient chaque
 * année. La date d'origine reste conservée dans l'enregistrement.
 */
export function prochaineOccurrence(echeance: Echeance, aujourdHui: string): string {
  if (!dateReelle(echeance.date)) return '';
  if (echeance.recurrence === 'aucune') return echeance.date;
  let date = echeance.date;
  let garde = 0;
  while (joursEntre(aujourdHui, date) < 0 && garde < 240) {
    const base = new Date(`${date}T00:00:00Z`);
    if (echeance.recurrence === 'mensuelle') base.setUTCMonth(base.getUTCMonth() + 1);
    else base.setUTCFullYear(base.getUTCFullYear() + 1);
    // Report sûr : un 31 du mois devient le dernier jour du mois suivant.
    const suivante = base.toISOString().slice(0, 10);
    if (suivante === date) break;
    date = suivante;
    garde += 1;
  }
  return date;
}

export function urgenceDe(joursRestants: number): UrgenceEcheance {
  if (joursRestants < 0) return 'passee';
  if (joursRestants === 0) return 'aujourdhui';
  if (joursRestants <= 30) return 'proche';
  return 'a_venir';
}

/** Échéances triées par urgence, avec leur prochaine occurrence réelle. */
export function echeancesVues(
  echeances: readonly Echeance[],
  aujourdHui: string,
  horizonJours = 365,
): EcheanceVue[] {
  return echeances
    .filter((echeance) => dateReelle(echeance.date))
    .map((echeance) => {
      const prochaineDate = prochaineOccurrence(echeance, aujourdHui);
      const joursRestants = joursEntre(aujourdHui, prochaineDate);
      return { echeance, joursRestants, urgence: urgenceDe(joursRestants), prochaineDate };
    })
    // Une échéance sans récurrence et déjà passée reste VISIBLE : l'oublier
    // serait pire que l'afficher, même si elle n'est pas « à venir ».
    .filter((vue) => vue.joursRestants <= horizonJours)
    .sort((a, b) => a.joursRestants - b.joursRestants);
}

/** Nombre d'échéances à traiter sous 30 jours, pour l'accueil. */
export function echeancesProches(vues: readonly EcheanceVue[]): EcheanceVue[] {
  return vues.filter((vue) => vue.urgence !== 'a_venir');
}

/**
 * Avertissement affiché avec chaque liste.
 *
 * Il est dans le code, pas seulement dans la documentation, pour qu'aucun écran
 * ne puisse l'omettre par distraction.
 */
export const AVERTISSEMENT_CONFORMITE =
  'Ces dates sont celles que vous avez saisies. Elles ne constituent ni un conseil fiscal, ni un conseil juridique : vérifiez chaque échéance auprès de votre administration, de votre comptable ou de votre assureur.';

/** Un enregistrement de module redevient une échéance lisible. */
export function echeanceFromRecord(record: { id: string; data: Record<string, unknown> }): Echeance {
  const data = record.data ?? {};
  const categorie = CATEGORIES_ECHEANCE.some((item) => item.value === data.categorie)
    ? data.categorie as CategorieEcheance
    : 'autre';
  const recurrence = data.recurrence === 'mensuelle' || data.recurrence === 'annuelle' ? data.recurrence : 'aucune';
  return {
    id: record.id,
    label: typeof data.label === 'string' ? data.label.slice(0, 160) : '',
    categorie,
    date: typeof data.date === 'string' ? data.date.slice(0, 10) : '',
    recurrence,
    notes: typeof data.notes === 'string' ? data.notes.slice(0, 1000) : '',
    verifiee: data.verifiee === true,
  };
}

export function echeanceToData(echeance: Echeance): Record<string, unknown> {
  return {
    label: echeance.label,
    categorie: echeance.categorie,
    date: echeance.date,
    recurrence: echeance.recurrence,
    notes: echeance.notes,
    verifiee: echeance.verifiee,
  };
}
