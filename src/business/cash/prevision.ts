/**
 * Prévision de trésorerie — fonctionnalité 3.
 *
 * Projette la trésorerie à 4, 8 et 12 semaines à partir de données RÉELLES :
 *  - les créances en cours (entrées attendues, pondérées par leur probabilité
 *    d'encaissement) ;
 *  - les dépenses récurrentes et engagées (sorties attendues).
 *
 * Règles d'honnêteté :
 *  - aucun taux « magique » : la probabilité d'encaissement vient de l'ancienneté
 *    du retard, et elle est AFFICHÉE pour que l'utilisateur la conteste ;
 *  - une créance sans échéance n'est pas inventée : elle est comptée « non datée »
 *    et signalée à part ;
 *  - les montants de devises différentes ne sont jamais additionnés ;
 *  - sans donnée, la prévision le dit au lieu d'afficher zéro.
 */

export type SemainesHorizon = 4 | 8 | 12;
export const HORIZONS: readonly SemainesHorizon[] = [4, 8, 12];

export interface CreanceAttendue {
  id: string;
  reference: string;
  /** Solde restant dû, jamais le montant initial. */
  solde: number;
  devise: string;
  /** Date d'échéance ; vide si la créance n'en a pas. */
  echeance: string;
  joursDeRetard: number;
  /** Statut effectif (payee, annulee, litige…). Les soldées sont exclues. */
  statut: string;
}

export interface DepenseAttendue {
  id: string;
  label: string;
  montant: number;
  /** Date où la sortie est attendue. */
  date: string;
  statut: 'engagee' | 'payee' | 'annulee';
  recurrence: 'aucune' | 'mensuelle' | 'trimestrielle' | 'annuelle';
}

export interface EntreePrevision {
  aujourdhui: string;
  devise: string;
  /** Trésorerie constatée aujourd'hui (encaissé − dépenses payées). */
  tresorerieActuelle: number;
  creances: readonly CreanceAttendue[];
  depenses: readonly DepenseAttendue[];
}

export interface SemaineProjetee {
  /** Numéro de semaine, 1 = semaine en cours. */
  semaine: number;
  /** Date de fin de la semaine (AAAA-MM-JJ). */
  fin: string;
  entrees: number;
  sorties: number;
  net: number;
  /** Trésorerie cumulée à la fin de la semaine. */
  cumul: number;
}

export interface Prevision {
  devise: string;
  horizon: SemainesHorizon;
  semaines: SemaineProjetee[];
  /** Trésorerie à la fin de l'horizon. */
  tresorerieFin: number;
  /** Semaine où le cumul passe sous zéro, `null` si aucun trou. */
  premiereSemaineNegative: number | null;
  /** Créances sans échéance : non projetées, signalées pour ne pas mentir. */
  creancesNonDatees: number;
  /** Le total en jeu dans les créances non datées. */
  montantNonDate: number;
  /** Absence totale de données : la prévision ne peut rien affirmer. */
  vide: boolean;
}

/**
 * Probabilité d'encaissement selon l'ancienneté du retard.
 *
 * Ce sont des hypothèses PRUDENTES, pas des statistiques de l'entreprise de
 * l'utilisateur. Elles sont affichées dans l'interface ; toute la projection
 * peut être relue à la lumière de ces chiffres.
 */
export function probabiliteEncaissement(joursDeRetard: number): number {
  if (joursDeRetard <= 0) return 0.9;
  if (joursDeRetard <= 15) return 0.8;
  if (joursDeRetard <= 30) return 0.65;
  if (joursDeRetard <= 60) return 0.45;
  if (joursDeRetard <= 90) return 0.3;
  return 0.15;
}

/** Échéances d'une dépense récurrente entre deux bornes (incluses). */
function echeancesRecurrentes(depense: DepenseAttendue, apres: string, jusqu: string): string[] {
  if (depense.recurrence === 'aucune' || depense.statut === 'annulee') return [];
  const pas = depense.recurrence === 'mensuelle' ? 30 : depense.recurrence === 'trimestrielle' ? 91 : 365;
  const dates: string[] = [];
  let curseur = Date.parse(`${depense.date}T00:00:00Z`);
  const fin = Date.parse(`${jusqu}T00:00:00Z`);
  const debut = Date.parse(`${apres}T00:00:00Z`);
  if (Number.isNaN(curseur)) return [];
  // Avance jusqu'à la première échéance postérieure à la date de départ.
  let garde = 0;
  while (curseur <= debut && garde < 400) {
    curseur += pas * 86_400_000;
    garde++;
  }
  garde = 0;
  while (curseur <= fin && garde < 60) {
    dates.push(new Date(curseur).toISOString().slice(0, 10));
    curseur += pas * 86_400_000;
    garde++;
  }
  return dates;
}

function finDeSemaine(aujourdhui: string, semaine: number): string {
  const base = Date.parse(`${aujourdhui}T00:00:00Z`);
  if (Number.isNaN(base)) return aujourdhui;
  return new Date(base + semaine * 7 * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Construit la prévision pour un horizon donné.
 *
 * Les entrées d'une créance sont placées dans la semaine de son échéance si
 * elle est future, sinon dans la semaine 1 (retard déjà constaté).
 */
export function prevoirTresorerie(entree: EntreePrevision, horizon: SemainesHorizon = 8): Prevision {
  const creancesActives = entree.creances.filter(
    (creance) => creance.solde > 0 && creance.devise === entree.devise && !['payee', 'annulee', 'brouillon'].includes(creance.statut),
  );

  const nonDatees = creancesActives.filter((creance) => !creance.echeance);
  const datees = creancesActives.filter((creance) => Boolean(creance.echeance));

  const semaines: SemaineProjetee[] = [];
  let cumul = entree.tresorerieActuelle;
  let premiereSemaineNegative: number | null = null;

  for (let semaine = 1; semaine <= horizon; semaine += 1) {
    const fin = finDeSemaine(entree.aujourdhui, semaine);
    const debutSemaine = semaine === 1 ? entree.aujourdhui : finDeSemaine(entree.aujourdhui, semaine - 1);

    let entrees = 0;
    for (const creance of datees) {
      const estDansLaSemaine = creance.echeance <= fin && creance.echeance > debutSemaine;
      const estEnRetard = creance.echeance < entree.aujourdhui && semaine === 1;
      if (estDansLaSemaine || estEnRetard) {
        entrees += creance.solde * probabiliteEncaissement(creance.joursDeRetard);
      }
    }

    let sorties = 0;
    for (const depense of entree.depenses) {
      if (depense.statut === 'annulee') continue;
      if (depense.recurrence === 'aucune') {
        if (depense.date > debutSemaine && depense.date <= fin) sorties += depense.montant;
        // Une dépense engagée et déjà échue reste due : elle pèse sur la semaine 1.
        if (semaine === 1 && depense.statut === 'engagee' && depense.date < entree.aujourdhui) sorties += depense.montant;
        continue;
      }
      sorties += echeancesRecurrentes(depense, debutSemaine, fin)
        .reduce((somme, _date) => somme + depense.montant, 0);
    }

    const net = Math.round((entrees - sorties) * 100) / 100;
    cumul = Math.round((cumul + net) * 100) / 100;
    if (cumul < 0 && premiereSemaineNegative === null) premiereSemaineNegative = semaine;

    semaines.push({
      semaine,
      fin,
      entrees: Math.round(entrees * 100) / 100,
      sorties: Math.round(sorties * 100) / 100,
      net,
      cumul,
    });
  }

  return {
    devise: entree.devise,
    horizon,
    semaines,
    tresorerieFin: cumul,
    premiereSemaineNegative,
    creancesNonDatees: nonDatees.length,
    montantNonDate: Math.round(nonDatees.reduce((somme, creance) => somme + creance.solde, 0) * 100) / 100,
    // « Vide » doit signifier « rien de projetable », pas « tableau non vide ».
    // Une dépense annulée n'est pas une donnée : la compter rendrait la
    // prévision « non vide » alors qu'elle ne projette rien.
    vide: creancesActives.length === 0 && entree.depenses.every((depense) => depense.statut === 'annulee'),
  };
}

export interface ActionChiffree {
  label: string;
  /** Effet estimé sur la trésorerie de l'horizon. */
  effet: number;
  /** Sur quoi repose ce chiffre — jamais une promesse de résultat. */
  fondement: string;
}

/**
 * Propose 2 à 3 actions chiffrées en cas de trou de trésorerie.
 *
 * Chaque action est calculée depuis les données fournies, et son fondement est
 * écrit noir sur blanc. Aucune n'est présentée comme garantie.
 */
export function actionsContreTrouDeCash(prevision: Prevision, entree: EntreePrevision): ActionChiffree[] {
  if (prevision.premiereSemaineNegative === null) return [];
  const actions: ActionChiffree[] = [];

  // 1. Accélérer les créances en retard non encore projetées à leur valeur pleine.
  const enRetard = entree.creances.filter(
    (creance) => creance.solde > 0 && creance.devise === entree.devise && creance.joursDeRetard > 0 && creance.echeance,
  );
  if (enRetard.length > 0) {
    const escompte = enRetard.reduce((somme, creance) => {
      const probabilite = probabiliteEncaissement(creance.joursDeRetard);
      return somme + creance.solde * (1 - probabilite);
    }, 0);
    actions.push({
      label: `Relancer les ${enRetard.length} créance(s) en retard dès cette semaine`,
      effet: Math.round(escompte * 100) / 100,
      fondement: 'Différence entre le montant dû et ce que la prévision compte déjà encaisser, pondéré par l’ancienneté du retard.',
    });
  }

  // 2. Reporter les dépenses récurrentes non indispensables d'un mois.
  const recurrentes = entree.depenses.filter(
    (depense) => depense.recurrence !== 'aucune' && depense.statut !== 'annulee',
  );
  if (recurrentes.length > 0) {
    const total = recurrentes.reduce((somme, depense) => somme + depense.montant, 0);
    actions.push({
      label: `Reporter d’un mois ${recurrentes.length} dépense(s) récurrente(s) non critique(s)`,
      effet: Math.round(total * 100) / 100,
      fondement: 'Somme des dépenses récurrentes déclarées ; à vous de choisir lesquelles peuvent attendre.',
    });
  }

  // 3. Encaisser les créances sans échéance (souvent oubliées).
  if (prevision.creancesNonDatees > 0) {
    actions.push({
      label: `Fixer une échéance pour ${prevision.creancesNonDatees} créance(s) non datée(s)`,
      effet: prevision.montantNonDate,
      fondement: 'Montant total des créances sans échéance, aujourd’hui absent de toute projection.',
    });
  }

  return actions.slice(0, 3);
}

export function formatMontantPrevision(montant: number, devise: string): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(montant)} ${devise}`;
}
