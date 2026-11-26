/**
 * Registre des outils de l'agent Business Grow.
 *
 * Chaque outil déclare :
 *  - un SCHÉMA de données fermé (`champs`), validé champ par champ ;
 *  - sa SENSIBILITÉ (argent / client / envoi / interne) ;
 *  - une CATÉGORIE de module métier existante, jamais une nouvelle table.
 *
 * Aucun outil n'écrit directement : `preparerAction` produit une proposition,
 * le journal la conserve, et l'écriture n'a lieu qu'après validation (ou
 * automatiquement si — et seulement si — `deciderAutonomie` l'autorise).
 *
 * Aucun outil n'appelle un service externe : pas de WhatsApp, pas de Meta,
 * pas de Google. Les messages sont préparés en texte, à copier par l'utilisateur.
 */

import { deciderAutonomie, type DecisionAutonomie, type SensibiliteAction, type ReglageAutonomie } from './niveaux';

export type TypeChamp = 'texte' | 'nombre' | 'date' | 'identifiant' | 'liste';

export interface ChampSchema {
  nom: string;
  type: TypeChamp;
  obligatoire?: boolean;
  /** Longueur maximale pour un texte, ou valeur maximale pour un nombre. */
  max?: number;
  /** Valeurs autorisées, quand le champ est fermé. */
  valeurs?: readonly string[];
}

export type NomOutil =
  | 'creer_facture'
  | 'modifier_facture'
  | 'creer_devis'
  | 'planifier_relance'
  | 'creer_tache'
  | 'ajouter_contact'
  | 'ouvrir_litige'
  | 'enregistrer_paiement'
  | 'preparer_message';

export interface Outil {
  nom: NomOutil;
  label: string;
  description: string;
  sensibilite: SensibiliteAction;
  /** Catégorie `bg_module_*` réellement utilisée par les écrans métier. */
  categorie: string;
  champs: readonly ChampSchema[];
  /** L'outil peut-il être annulé après exécution ? */
  annulable: boolean;
}

/**
 * Catégories réelles, lues dans `records/useRecords.ts`. Aucune catégorie
 * inventée : si une catégorie manque ici, l'outil ne doit pas exister.
 */
const CATEGORIES = {
  factures: 'bg_module_sales_invoices',
  devis: 'bg_module_sales_quotes',
  relances: 'bg_module_receivable_reminders',
  taches: 'bg_module_crm_tasks',
  contacts: 'bg_module_crm_contacts',
  litiges: 'bg_module_receivable_disputes',
  paiements: 'bg_module_receivable_payments',
} as const;

export const OUTILS: readonly Outil[] = [
  {
    nom: 'creer_facture',
    label: 'Créer une facture',
    description: 'Prépare une facture rattachée à un contact existant.',
    sensibilite: 'argent',
    categorie: CATEGORIES.factures,
    annulable: true,
    champs: [
      { nom: 'contactId', type: 'identifiant', obligatoire: true, max: 64 },
      { nom: 'reference', type: 'texte', max: 60 },
      { nom: 'montant', type: 'nombre', obligatoire: true, max: 1_000_000_000 },
      { nom: 'devise', type: 'texte', max: 8 },
      { nom: 'echeance', type: 'date' },
    ],
  },
  {
    nom: 'modifier_facture',
    label: 'Modifier une facture',
    description: 'Prépare une modification d’une facture existante.',
    sensibilite: 'argent',
    categorie: CATEGORIES.factures,
    annulable: true,
    champs: [
      { nom: 'factureId', type: 'identifiant', obligatoire: true, max: 64 },
      { nom: 'montant', type: 'nombre', max: 1_000_000_000 },
      { nom: 'echeance', type: 'date' },
    ],
  },
  {
    nom: 'creer_devis',
    label: 'Créer un devis',
    description: 'Prépare un devis rattaché à un contact existant.',
    sensibilite: 'argent',
    categorie: CATEGORIES.devis,
    annulable: true,
    champs: [
      { nom: 'contactId', type: 'identifiant', obligatoire: true, max: 64 },
      { nom: 'reference', type: 'texte', max: 60 },
      { nom: 'montant', type: 'nombre', obligatoire: true, max: 1_000_000_000 },
      { nom: 'devise', type: 'texte', max: 8 },
      { nom: 'validite', type: 'date' },
    ],
  },
  {
    nom: 'planifier_relance',
    label: 'Planifier une relance',
    description: 'Prépare une relance à une date donnée, avec un ton choisi.',
    sensibilite: 'client',
    categorie: CATEGORIES.relances,
    annulable: true,
    champs: [
      { nom: 'creanceId', type: 'identifiant', obligatoire: true, max: 64 },
      { nom: 'date', type: 'date', obligatoire: true },
      { nom: 'ton', type: 'texte', max: 30, valeurs: ['courtois', 'neutre', 'ferme'] },
    ],
  },
  {
    nom: 'creer_tache',
    label: 'Créer une tâche',
    description: 'Prépare une tâche interne avec une échéance.',
    sensibilite: 'interne',
    categorie: CATEGORIES.taches,
    annulable: true,
    champs: [
      { nom: 'titre', type: 'texte', obligatoire: true, max: 160 },
      { nom: 'echeance', type: 'date' },
      { nom: 'contactId', type: 'identifiant', max: 64 },
    ],
  },
  {
    nom: 'ajouter_contact',
    label: 'Ajouter un contact',
    description: 'Prépare la création d’une fiche contact.',
    sensibilite: 'client',
    categorie: CATEGORIES.contacts,
    annulable: true,
    champs: [
      { nom: 'nom', type: 'texte', obligatoire: true, max: 120 },
      { nom: 'entreprise', type: 'texte', max: 160 },
      { nom: 'email', type: 'texte', max: 200 },
      { nom: 'telephone', type: 'texte', max: 40 },
    ],
  },
  {
    nom: 'ouvrir_litige',
    label: 'Ouvrir un dossier de litige',
    description: 'Prépare un dossier de litige sur une créance existante.',
    sensibilite: 'argent',
    categorie: CATEGORIES.litiges,
    annulable: true,
    champs: [
      { nom: 'creanceId', type: 'identifiant', obligatoire: true, max: 64 },
      { nom: 'motif', type: 'texte', obligatoire: true, max: 300 },
      { nom: 'montant', type: 'nombre', max: 1_000_000_000 },
      { nom: 'echeance', type: 'date' },
    ],
  },
  {
    nom: 'enregistrer_paiement',
    label: 'Enregistrer un paiement',
    description: 'Prépare l’enregistrement d’un paiement reçu.',
    sensibilite: 'argent',
    categorie: CATEGORIES.paiements,
    annulable: true,
    champs: [
      { nom: 'creanceId', type: 'identifiant', obligatoire: true, max: 64 },
      { nom: 'montant', type: 'nombre', obligatoire: true, max: 1_000_000_000 },
      { nom: 'date', type: 'date', obligatoire: true },
      { nom: 'moyen', type: 'texte', max: 30, valeurs: ['especes', 'mobile_money', 'virement', 'carte', 'cheque', 'autre'] },
    ],
  },
  {
    nom: 'preparer_message',
    label: 'Préparer un message',
    description: 'Rédige un message à copier. Aucun envoi automatique n’existe.',
    sensibilite: 'envoi',
    categorie: CATEGORIES.relances,
    annulable: false,
    champs: [
      { nom: 'contactId', type: 'identifiant', max: 64 },
      { nom: 'objet', type: 'texte', obligatoire: true, max: 160 },
      { nom: 'corps', type: 'texte', obligatoire: true, max: 4000 },
    ],
  },
];

const PAR_NOM = new Map(OUTILS.map((outil) => [outil.nom, outil]));

export function outil(nom: NomOutil): Outil {
  const trouve = PAR_NOM.get(nom);
  if (!trouve) throw new Error(`Outil inconnu : ${nom}`);
  return trouve;
}

export interface ResultatValidation {
  valide: boolean;
  /** Champs rejetés, avec la raison lisible. */
  erreurs: Array<{ champ: string; raison: string }>;
  /** Données nettoyées (texte découpé, nombres bornés). Jamais utilisé si invalide. */
  donnees: Record<string, unknown>;
}

const FORMAT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Vérifie qu'une date ISO existe réellement.
 *
 * `Date.parse('2026-02-31T00:00:00Z')` ne renvoie pas `NaN` : JavaScript
 * REPORTE au 3 mars. Sans ce contrôle, une échéance impossible serait acceptée
 * et deviendrait silencieusement une autre date. On compare donc l'aller-retour.
 */
export function dateReelle(valeur: string): boolean {
  if (!FORMAT_DATE.test(valeur)) return false;
  const temps = Date.parse(`${valeur}T00:00:00Z`);
  if (Number.isNaN(temps)) return false;
  return new Date(temps).toISOString().slice(0, 10) === valeur;
}

/**
 * Valide des arguments contre le schéma de l'outil.
 *
 * Stricte par construction : un champ NON déclaré est refusé. C'est ce qui
 * empêche un contenu externe de glisser un champ arbitraire (par exemple
 * `"statut": "payee"`) dans une écriture.
 */
export function validerArguments(nom: NomOutil, args: unknown): ResultatValidation {
  const definition = outil(nom);
  const erreurs: ResultatValidation['erreurs'] = [];
  const donnees: Record<string, unknown> = {};

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { valide: false, erreurs: [{ champ: '*', raison: 'Les arguments doivent être un objet.' }], donnees: {} };
  }

  const brut = args as Record<string, unknown>;
  const declares = new Set(definition.champs.map((champ) => champ.nom));

  for (const cle of Object.keys(brut)) {
    if (!declares.has(cle)) {
      erreurs.push({ champ: cle, raison: 'Champ non prévu par le schéma de cet outil.' });
    }
  }

  for (const champ of definition.champs) {
    const valeur = brut[champ.nom];

    if (valeur === undefined || valeur === null || valeur === '') {
      if (champ.obligatoire) erreurs.push({ champ: champ.nom, raison: 'Champ obligatoire manquant.' });
      continue;
    }

    if (champ.type === 'nombre') {
      if (typeof valeur !== 'number' || !Number.isFinite(valeur)) {
        erreurs.push({ champ: champ.nom, raison: 'Un nombre fini est attendu.' });
        continue;
      }
      if (valeur < 0) {
        erreurs.push({ champ: champ.nom, raison: 'Une valeur négative n’est pas acceptée.' });
        continue;
      }
      if (champ.max !== undefined && valeur > champ.max) {
        erreurs.push({ champ: champ.nom, raison: `Valeur supérieure au maximum autorisé (${champ.max}).` });
        continue;
      }
      donnees[champ.nom] = valeur;
      continue;
    }

    if (typeof valeur !== 'string') {
      erreurs.push({ champ: champ.nom, raison: 'Un texte est attendu.' });
      continue;
    }

    const texte = valeur.trim();

    if (champ.type === 'date') {
      if (!dateReelle(texte)) {
        erreurs.push({ champ: champ.nom, raison: 'Date attendue au format AAAA-MM-JJ.' });
        continue;
      }
      donnees[champ.nom] = texte;
      continue;
    }

    if (champ.max !== undefined && texte.length > champ.max) {
      erreurs.push({ champ: champ.nom, raison: `Texte trop long (maximum ${champ.max} caractères).` });
      continue;
    }

    if (champ.valeurs && !champ.valeurs.includes(texte)) {
      erreurs.push({ champ: champ.nom, raison: `Valeur hors liste autorisée (${champ.valeurs.join(', ')}).` });
      continue;
    }

    donnees[champ.nom] = texte;
  }

  return { valide: erreurs.length === 0, erreurs, donnees };
}

export interface PropositionAction {
  outil: NomOutil;
  label: string;
  donnees: Record<string, unknown>;
  sensibilite: SensibiliteAction;
  categorie: string;
  decision: DecisionAutonomie;
  /** Résumé lisible présenté à l'utilisateur avant validation. */
  resume: string;
}

/**
 * Prépare une action : validation du schéma PUIS décision d'autonomie.
 *
 * Une proposition n'écrit rien. Même quand l'autonomie autorise l'exécution,
 * l'appelant doit journaliser avant d'écrire (voir `journal.ts`).
 */
export function preparerAction(
  nom: NomOutil,
  args: unknown,
  reglages: Partial<Record<NomOutil, ReglageAutonomie>> = {},
): { ok: true; proposition: PropositionAction } | { ok: false; erreurs: ResultatValidation['erreurs'] } {
  const validation = validerArguments(nom, args);
  if (!validation.valide) return { ok: false, erreurs: validation.erreurs };

  const definition = outil(nom);
  const decision = deciderAutonomie(definition.sensibilite, reglages[nom]);

  return {
    ok: true,
    proposition: {
      outil: nom,
      label: definition.label,
      donnees: validation.donnees,
      sensibilite: definition.sensibilite,
      categorie: definition.categorie,
      decision,
      resume: `${definition.label} — ${resumeDonnees(validation.donnees)}`,
    },
  };
}

function resumeDonnees(donnees: Record<string, unknown>): string {
  const morceaux = Object.entries(donnees)
    .map(([cle, valeur]) => `${cle} : ${String(valeur)}`)
    .join(' · ');
  return morceaux || 'aucune donnée';
}
