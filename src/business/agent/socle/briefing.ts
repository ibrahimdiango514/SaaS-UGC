/**
 * Briefing quotidien — fonctionnalité 8.
 *
 * Trois priorités MAXIMUM, tirées des DONNÉES RÉELLES de l'espace de travail,
 * chacune avec une action que l'agent peut préparer. Aucun chiffre n'est
 * inventé : si une donnée manque, la priorité n'existe pas.
 *
 * Ce module est pur : il reçoit des tableaux déjà chargés et rend un classement
 * déterministe. Il ne lit ni le réseau ni la base, ce qui rend chaque règle
 * testable sans infrastructure.
 */

import type { NomOutil } from './outils';

export interface Priorite {
  /** Clé stable, utile pour ne pas répéter deux fois la même priorité. */
  cle: string;
  titre: string;
  /** Pourquoi cette priorité apparaît, en une phrase factuelle. */
  justification: string;
  /** Gravité : sert au tri, jamais à dramatiser. */
  gravite: 'critique' | 'haute' | 'moyenne';
  /** Montant réellement en jeu, si la donnée existe. `null` sinon — jamais 0 inventé. */
  montantEnJeu: number | null;
  devise: string | null;
  /** Outil que l'agent peut préparer pour cette priorité. */
  outil: NomOutil | null;
  /** Arguments pré-remplis pour cet outil (validés avant tout usage). */
  argumentsOutil: Record<string, unknown>;
}

export interface DonneesBriefing {
  /** Date du jour, injectable pour rendre les tests déterministes. */
  aujourdhui: string;
  creances: readonly {
    id: string; reference: string; solde: number; devise: string;
    joursDeRetard: number; statut: string; contactId: string;
  }[];
  taches: readonly { id: string; titre: string; echeance: string; fait: boolean; contactId?: string }[];
  litiges: readonly { id: string; creanceId: string; montant: number; devise: string; echeance: string; statut: string }[];
  contacts: readonly { id: string; nom: string; prochaineAction: string; prochaineActionAt: string }[];
}

/** Nombre de priorités affichées. Trois : au-delà, l'utilisateur ne lit plus. */
export const MAX_PRIORITES = 3;

const POIDS_GRAVITE: Record<Priorite['gravite'], number> = { critique: 0, haute: 1, moyenne: 2 };

/**
 * Litiges dont l'échéance est proche ou dépassée.
 *
 * Un litige n'est jamais « gagné » ni « perdu » ici : on signale seulement
 * qu'une échéance approche, pour que l'utilisateur agisse à temps.
 */
function prioritesLitiges(donnees: DonneesBriefing): Priorite[] {
  return donnees.litiges
    .filter((litige) => litige.statut === 'ouvert' || litige.statut === 'en_cours')
    .map((litige) => ({
      litige,
      jours: joursEntre(donnees.aujourdhui, litige.echeance),
    }))
    .filter(({ jours }) => jours !== null && jours <= 7)
    .map(({ litige, jours }) => ({
      cle: `litige:${litige.id}`,
      titre: jours !== null && jours < 0
        ? `Litige à traiter : échéance dépassée de ${Math.abs(jours)} jour(s)`
        : `Litige à traiter : échéance dans ${jours} jour(s)`,
      justification: jours !== null && jours < 0
        ? `Le dossier de litige de ${formaterMontant(litige.montant, litige.devise)} a dépassé son échéance du ${litige.echeance}. Les preuves déjà présentes doivent être relues et la réponse préparée.`
        : `Le dossier de litige de ${formaterMontant(litige.montant, litige.devise)} arrive à échéance le ${litige.echeance}. Les preuves déjà présentes doivent être relues et la réponse préparée.`,
      gravite: jours !== null && jours < 0 ? 'critique' as const : 'haute' as const,
      montantEnJeu: litige.montant,
      devise: litige.devise,
      outil: null,
      argumentsOutil: {},
    }));
}

/** Créances en retard : la priorité la plus fréquente, et celle qui rapporte. */
function prioritesCreances(donnees: DonneesBriefing): Priorite[] {
  return donnees.creances
    .filter((creance) => creance.solde > 0 && creance.joursDeRetard > 0 && !['annulee', 'litige'].includes(creance.statut))
    .sort((a, b) => (b.solde - a.solde) || (b.joursDeRetard - a.joursDeRetard))
    .slice(0, 2)
    .map((creance) => ({
      cle: `creance:${creance.id}`,
      titre: `Relancer ${creance.reference || 'une créance'} — ${formaterMontant(creance.solde, creance.devise)}`,
      justification: `Impayée depuis ${creance.joursDeRetard} jour(s). Une relance planifiée évite l'oubli sans contact manuel.`,
      gravite: creance.joursDeRetard >= 30 ? 'critique' as const : 'haute' as const,
      montantEnJeu: creance.solde,
      devise: creance.devise,
      outil: 'planifier_relance' as const,
      argumentsOutil: { creanceId: creance.id, date: ajouterJours(donnees.aujourdhui, 2), ton: creance.joursDeRetard >= 30 ? 'ferme' : 'courtois' },
    }));
}

/** Tâches en retard ou du jour. */
function prioritesTaches(donnees: DonneesBriefing): Priorite[] {
  return donnees.taches
    .filter((tache) => !tache.fait && tache.echeance && tache.echeance <= donnees.aujourdhui)
    .sort((a, b) => (a.echeance < b.echeance ? -1 : 1))
    .slice(0, 2)
    .map((tache) => ({
      cle: `tache:${tache.id}`,
      titre: tache.echeance < donnees.aujourdhui ? `Tâche en retard : ${tache.titre}` : `Tâche du jour : ${tache.titre}`,
      justification: `Échéance fixée au ${tache.echeance}.`,
      gravite: tache.echeance < donnees.aujourdhui ? 'haute' as const : 'moyenne' as const,
      montantEnJeu: null,
      devise: null,
      outil: null,
      argumentsOutil: {},
    }));
}

/** Contacts dont la prochaine action est due ou dépassée. */
function prioritesContacts(donnees: DonneesBriefing): Priorite[] {
  return donnees.contacts
    .filter((contact) => contact.prochaineAction && contact.prochaineActionAt && contact.prochaineActionAt <= donnees.aujourdhui)
    .slice(0, 2)
    .map((contact) => ({
      cle: `contact:${contact.id}`,
      titre: `Prochaine action due : ${contact.nom}`,
      justification: `${contact.prochaineAction} (prévu le ${contact.prochaineActionAt}).`,
      gravite: 'moyenne' as const,
      montantEnJeu: null,
      devise: null,
      outil: null,
      argumentsOutil: {},
    }));
}

/**
 * Construit le briefing.
 *
 * Le tri est STABLE et explicite : gravité, puis montant en jeu décroissant,
 * puis clé alphabétique. Deux appels avec les mêmes données produisent le même
 * briefing — sans quoi l'utilisateur verrait les priorités « bouger » seules.
 */
export function construireBriefing(donnees: DonneesBriefing): Priorite[] {
  const toutes = [
    ...prioritesLitiges(donnees),
    ...prioritesCreances(donnees),
    ...prioritesTaches(donnees),
    ...prioritesContacts(donnees),
  ];

  return toutes
    .sort((a, b) => {
      const gravite = POIDS_GRAVITE[a.gravite] - POIDS_GRAVITE[b.gravite];
      if (gravite !== 0) return gravite;
      const montant = (b.montantEnJeu ?? 0) - (a.montantEnJeu ?? 0);
      if (montant !== 0) return montant;
      return a.cle < b.cle ? -1 : a.cle > b.cle ? 1 : 0;
    })
    .slice(0, MAX_PRIORITES);
}

/** Somme réellement connue des montants en jeu. Ignore les priorités sans montant. */
export function totalEnJeu(priorites: readonly Priorite[]): { montant: number; devise: string | null } {
  let montant = 0;
  let devise: string | null = null;
  for (const priorite of priorites) {
    if (priorite.montantEnJeu === null) continue;
    if (devise === null) devise = priorite.devise;
    // On n'additionne pas des devises différentes : ce serait un chiffre faux.
    if (priorite.devise === devise) montant += priorite.montantEnJeu;
  }
  return { montant, devise };
}

function formaterMontant(montant: number, devise: string): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(montant)} ${devise}`;
}

function joursEntre(depuis: string, jusqu: string): number | null {
  const a = Date.parse(`${depuis}T00:00:00Z`);
  const b = Date.parse(`${jusqu}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function ajouterJours(date: string, jours: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(base)) return date;
  return new Date(base + jours * 86_400_000).toISOString().slice(0, 10);
}
