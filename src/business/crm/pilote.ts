/**
 * Prospects en pilote automatique — fonctionnalité 6 (complète le CRM existant).
 *
 * Le score, la priorité et `nextAction` existent déjà (`crm/model.ts`). Ce module
 * ajoute ce qui manquait pour que le CRM « pilote » réellement :
 *  - une PROCHAINE ACTION OBLIGATOIRE, avec une date, déduite de l'état réel ;
 *  - la liste des prospects à traiter aujourd'hui, dans l'ordre ;
 *  - un formulaire de capture intégrable, qui n'enregistre rien sans l'action
 *    explicite de l'utilisateur (aucune écriture depuis une page publique) ;
 *  - un modèle de message prêt à copier — aucun envoi.
 *
 * Rien ici n'invente une donnée : si `lastContactAt` est inconnu, on le dit.
 */

import type { Contact, Opportunity } from './model';
import { daysBetween, todayIso } from './model';

export interface ProchaineActionRecommandee {
  contactId: string;
  libelle: string;
  /** Date ISO à laquelle agir. */
  quand: string;
  /** Pourquoi cette action, en une phrase factuelle. */
  pourquoi: string;
  /** L'action est-elle déjà renseignée par l'utilisateur ? */
  dejaPlanifiee: boolean;
}

/** Délai par défaut avant relance, selon l'ancienneté du dernier contact. */
export function delaiRelance(daysSinceContact: number | null): number {
  if (daysSinceContact === null) return 1;
  if (daysSinceContact >= 30) return 1;
  if (daysSinceContact >= 14) return 2;
  if (daysSinceContact >= 7) return 3;
  return 7;
}

/**
 * Prochaine action obligatoire.
 *
 * Règle : un prospect sans action datée n'est pas « suivi », il est oublié.
 * On renvoie donc TOUJOURS quelque chose, mais en distinguant clairement ce que
 * l'utilisateur a déjà planifié de ce que le système propose.
 */
export function prochaineAction(
  contact: Contact,
  contexte: { daysSinceContact: number | null; openValue: number; aujourdhui?: string },
): ProchaineActionRecommandee {
  const aujourdhui = contexte.aujourdhui ?? todayIso();
  const dejaPlanifiee = Boolean(contact.nextAction && contact.nextActionAt);

  if (dejaPlanifiee) {
    return {
      contactId: contact.id,
      libelle: contact.nextAction,
      quand: contact.nextActionAt,
      pourquoi: 'Action déjà planifiée par vous.',
      dejaPlanifiee: true,
    };
  }

  const jours = delaiRelance(contexte.daysSinceContact);
  const quand = ajouterJours(aujourdhui, jours);

  if (contexte.openValue > 0) {
    return {
      contactId: contact.id,
      libelle: 'Relancer sur l’opportunité en cours',
      quand,
      pourquoi: `${formaterMontant(contexte.openValue)} encore en jeu et aucune action planifiée.`,
      dejaPlanifiee: false,
    };
  }

  if (contexte.daysSinceContact === null) {
    return {
      contactId: contact.id,
      libelle: 'Renseigner la date du dernier contact',
      quand: aujourdhui,
      pourquoi: 'Dernier contact inconnu : impossible de savoir s’il faut relancer.',
      dejaPlanifiee: false,
    };
  }

  return {
    contactId: contact.id,
    libelle: 'Prendre des nouvelles',
    quand,
    pourquoi: `Aucun contact depuis ${contexte.daysSinceContact} jour(s) et aucune action planifiée.`,
    dejaPlanifiee: false,
  };
}

export interface ProspectPrioritaire {
  contact: Contact;
  action: ProchaineActionRecommandee;
  /** Score explicable fourni par `scoreContact`. */
  score: number;
  /** Montant encore en jeu, `null` si aucun n'est renseigné (jamais 0 inventé). */
  montantEnJeu: number | null;
}

/**
 * Prospects à traiter, classés.
 *
 * Ordre : action due ou dépassée d'abord, puis montant en jeu décroissant, puis
 * score décroissant. Aucune priorité n'est inventée : tout vient des données.
 */
export function prospectsAPiloter(
  contacts: readonly Contact[],
  contexte: {
    scoreDe: (contact: Contact) => number;
    montantDe: (contact: Contact) => number | null;
    daysSinceContactDe: (contact: Contact) => number | null;
    aujourdhui?: string;
  },
  limite = 5,
): ProspectPrioritaire[] {
  const aujourdhui = contexte.aujourdhui ?? todayIso();

  return contacts
    .filter((contact) => contact.status !== 'archive' && contact.type !== 'fournisseur' && contact.type !== 'partenaire')
    .map((contact) => {
      const montant = contexte.montantDe(contact);
      const score = contexte.scoreDe(contact);
      const action = prochaineAction(contact, {
        daysSinceContact: contexte.daysSinceContactDe(contact),
        openValue: montant ?? 0,
        aujourdhui,
      });
      return { contact, action, score, montantEnJeu: montant };
    })
    .sort((a, b) => {
      const due = (p: ProspectPrioritaire) => (p.action.quand <= aujourdhui ? 0 : 1);
      if (due(a) !== due(b)) return due(a) - due(b);
      const diff = (b.montantEnJeu ?? 0) - (a.montantEnJeu ?? 0);
      if (diff !== 0) return diff;
      if (b.score !== a.score) return b.score - a.score;
      return a.contact.id < b.contact.id ? -1 : a.contact.id > b.contact.id ? 1 : 0;
    })
    .slice(0, limite);
}

export interface ChampCapture {
  nom: 'nom' | 'email' | 'telephone' | 'entreprise' | 'besoin';
  label: string;
  obligatoire: boolean;
  type: 'text' | 'email' | 'tel' | 'textarea';
}

/** Champs du formulaire de capture : le minimum utile, pas un questionnaire. */
export const CHAMPS_CAPTURE: readonly ChampCapture[] = [
  { nom: 'nom', label: 'Votre nom', obligatoire: true, type: 'text' },
  { nom: 'email', label: 'E-mail', obligatoire: false, type: 'email' },
  { nom: 'telephone', label: 'Téléphone', obligatoire: false, type: 'tel' },
  { nom: 'entreprise', label: 'Entreprise', obligatoire: false, type: 'text' },
  { nom: 'besoin', label: 'Votre besoin', obligatoire: false, type: 'textarea' },
];

/**
 * Nettoie une capture de prospect.
 *
 * Le formulaire est public : tout ce qui en vient est une DONNÉE non fiable.
 * On borne, on retire les balises, et on valide l'e-mail sans jamais l'exiger.
 * Aucune écriture n'a lieu ici : l'appelant doit faire confirmer par
 * l'utilisateur avant d'enregistrer.
 */
export function validerCapture(brut: Record<string, unknown>): {
  valide: boolean;
  erreurs: string[];
  donnees: { nom: string; email: string; telephone: string; entreprise: string; besoin: string };
} {
  const nettoyer = (valeur: unknown, max: number): string => (typeof valeur === 'string'
    ? valeur.replace(/<[^>]*>/g, '').trim().slice(0, max)
    : '');
  const donnees = {
    nom: nettoyer(brut.nom, 120),
    email: nettoyer(brut.email, 200),
    telephone: nettoyer(brut.telephone, 40),
    entreprise: nettoyer(brut.entreprise, 160),
    besoin: nettoyer(brut.besoin, 1000),
  };
  const erreurs: string[] = [];
  if (!donnees.nom) erreurs.push('Le nom est obligatoire.');
  if (donnees.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(donnees.email)) {
    erreurs.push('L’adresse e-mail ne semble pas valide.');
  }
  return { valide: erreurs.length === 0, erreurs, donnees };
}

/**
 * Modèle de message de relance, prêt à COPIER.
 *
 * Aucun envoi : le produit n'a pas de connecteur de messagerie, et le message
 * est rendu en texte brut pour que l'utilisateur le relise.
 */
export function messageRelance(
  contact: Contact,
  action: ProchaineActionRecommandee,
  entreprise: string,
): string {
  const nom = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Bonjour';
  return [
    `Bonjour ${nom},`,
    '',
    `Je reviens vers vous concernant ${entreprise ? `${entreprise}` : 'notre échange'}.`,
    action.dejaPlanifiee ? `Suite prévue : ${action.libelle}.` : '',
    '',
    'Dites-moi ce qui vous conviendrait comme prochaine étape.',
    '',
    'Bien cordialement,',
  ].filter((ligne, index, tableau) => !(ligne === '' && tableau[index - 1] === '')).join('\n').slice(0, 2000);
}

/** Valeur encore en jeu d'un contact, `null` si rien n'est chiffré. */
export function montantEnJeu(contact: Contact, opportunites: readonly Opportunity[]): number | null {
  const ouvertes = opportunites.filter((opportunite) => opportunite.contactId === contact.id
    && ['qualifie', 'proposition', 'negociation'].includes(opportunite.stage));
  if (ouvertes.length === 0) return null;
  const total = ouvertes.reduce((somme, opportunite) => somme + (opportunite.amount ?? 0), 0);
  return total > 0 ? total : null;
}

export function joursDepuisContact(contact: Contact, aujourdhui = todayIso()): number | null {
  if (!contact.lastContactAt) return null;
  return daysBetween(contact.lastContactAt, aujourdhui);
}

function ajouterJours(date: string, jours: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(base)) return date;
  return new Date(base + jours * 86_400_000).toISOString().slice(0, 10);
}

function formaterMontant(montant: number): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(montant)} FCFA`;
}
