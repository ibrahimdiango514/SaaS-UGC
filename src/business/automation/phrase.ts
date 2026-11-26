/**
 * Règles d'automatisation écrites en une phrase — fonctionnalité 9.
 *
 * L'utilisateur écrit « si une facture a 7 jours de retard, prépare la relance »
 * et l'agent produisait déjà des règles structurées (`automation/model.ts`).
 * Ce module fait la conversion, avec une exigence centrale :
 *
 *   **une phrase non comprise ne devient JAMAIS une règle approximative.**
 *
 * On ne devine pas. Si un élément manque, la conversion renvoie les questions à
 * poser, et l'utilisateur choisit. Une règle mal comprise qui déclencherait des
 * relances au mauvais client coûterait plus cher que pas de règle du tout.
 *
 * Le déclencheur et l'action doivent exister dans le catalogue réel :
 * `AUTOMATION_TRIGGERS` et `AUTOMATION_ACTIONS`. Aucune création ici.
 */

import type { AutomationAction, AutomationTrigger } from './model';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS } from './model';

/** Forme reconnaissable d'un déclencheur dans une phrase. */
interface MotifDeclencheur {
  trigger: AutomationTrigger;
  motifs: RegExp[];
}

const MOTIFS_DECLENCHEURS: readonly MotifDeclencheur[] = [
  { trigger: 'facture_retard', motifs: [/\bfactures?\b/i, /\binvoices?\b/i] },
  { trigger: 'creance_retard', motifs: [/\bcr[ée]ances?\b/i, /\bimpay[ée]s?\b/i] },
  { trigger: 'devis_sans_suivi', motifs: [/\bdevis\b/i, /\bquotes?\b/i] },
  { trigger: 'tache_retard', motifs: [/\bt[âa]ches?\s+(?:en\s+)?retard/i, /\bt[âa]che\s+d[ée]pass[ée]e/i, /\boverdue\s+tasks?\b/i] },
  { trigger: 'opportunite_stagnante', motifs: [/\bopportunit[ée]/i, /\bprospects?\s+bloqu/i, /\baffaire\s+qui\s+stagne/i] },
  { trigger: 'promesse_non_respectee', motifs: [/\bpromesses?\b/i] },
  { trigger: 'stock_faible', motifs: [/\bstock\b/i, /\brupture\b/i] },
  { trigger: 'depense_inhabituelle', motifs: [/\bd[ée]penses?\b/i, /\bfactures?\s+fournisseur/i] },
];

interface MotifAction {
  action: AutomationAction;
  motifs: RegExp[];
}

const MOTIFS_ACTIONS: readonly MotifAction[] = [
  { action: 'preparer_relance', motifs: [/\brelanc/i, /\bpr[ée]pare[rz]?\s+(?:une\s+)?relance/i, /\brappel/i] },
  { action: 'creer_tache', motifs: [/\bcr[ée]e[rz]?\s+(?:une\s+)?t[âa]che/i, /\bt[âa]che\b/i] },
  { action: 'notifier', motifs: [/\bnotif/i, /\bsignale[rz]?\b/i, /\bpr[ée]viens?/i, /\balerte/i] },
];

export interface RegleProposee {
  name: string;
  trigger: AutomationTrigger;
  thresholdDays: number;
  action: AutomationAction;
  /** Texte original conservé : c'est la règle que l'utilisateur a écrite. */
  phrase: string;
  /** Explication en clair de ce qui a été compris. */
  explication: string;
}

export interface ConversionReussie {
  ok: true;
  regle: RegleProposee;
}

export interface ConversionIncomplete {
  ok: false;
  /** Ce qui manque, formulé comme une question fermée. */
  questions: string[];
  /** Éléments déjà reconnus, pour ne pas redemander ce qui est compris. */
  compris: Partial<Pick<RegleProposee, 'trigger' | 'action' | 'thresholdDays'>>;
}

export type Conversion = ConversionReussie | ConversionIncomplete;

/** Extrait un nombre de jours : « 7 jours », « 7j », « dans 3 jours ». */
export function extraireJours(phrase: string): number | null {
  const trouve = phrase.match(/(\d{1,3})\s*(?:jours?|j)\b/i);
  if (trouve) {
    const valeur = Number.parseInt(trouve[1], 10);
    return Number.isFinite(valeur) && valeur >= 0 && valeur <= 365 ? valeur : null;
  }
  if (/\b(?:aujourd['’]?hui|le jour m[êe]me)\b/i.test(phrase)) return 0;
  if (/\bsemaine\s+prochaine\b/i.test(phrase)) return 7;
  if (/\bun\s+mois\b/i.test(phrase)) return 30;
  return null;
}

function trouverDeclencheur(phrase: string): AutomationTrigger | null {
  for (const motif of MOTIFS_DECLENCHEURS) {
    if (motif.motifs.some((regex) => regex.test(phrase))) return motif.trigger;
  }
  return null;
}

function trouverAction(phrase: string): AutomationAction | null {
  for (const motif of MOTIFS_ACTIONS) {
    if (motif.motifs.some((regex) => regex.test(phrase))) return motif.action;
  }
  return null;
}

/**
 * Convertit une phrase en règle structurée.
 *
 * Comportement fermé : si le déclencheur ou l'action n'est pas reconnu, on
 * renvoie `ok: false` avec des questions. Aucune règle n'est créée par défaut.
 */
export function convertirPhrase(phrase: string): Conversion {
  const texte = typeof phrase === 'string' ? phrase.trim().slice(0, 400) : '';
  if (!texte) {
    return {
      ok: false,
      questions: ['Décrivez la règle en une phrase, par exemple : « si une facture a 7 jours de retard, prépare la relance ».'],
      compris: {},
    };
  }

  const trigger = trouverDeclencheur(texte);
  const action = trouverAction(texte);
  const seuil = extraireJours(texte);

  const questions: string[] = [];
  const compris: ConversionIncomplete['compris'] = {};

  if (trigger) compris.trigger = trigger;
  else questions.push('Sur quoi la règle doit-elle se déclencher ? (facture, créance, devis, tâche, opportunité, promesse, stock, dépense)');

  if (action) compris.action = action;
  else questions.push('Que doit faire l’agent ? (préparer une relance, créer une tâche, signaler)');

  // Le seuil n'est exigé que pour les déclencheurs datés.
  const seuilRequis = trigger !== null && trigger !== 'stock_faible' && trigger !== 'depense_inhabituelle';
  if (seuil !== null) compris.thresholdDays = seuil;
  else if (seuilRequis) questions.push('Au bout de combien de jours ? (par exemple 7 jours)');

  if (!trigger || !action || (seuilRequis && seuil === null)) {
    return { ok: false, questions, compris };
  }

  const libelleDeclencheur = AUTOMATION_TRIGGERS.find((t) => t.value === trigger)?.label ?? trigger;
  const libelleAction = AUTOMATION_ACTIONS.find((a) => a.value === action)?.label ?? action;
  const thresholdDays = seuil ?? 0;

  return {
    ok: true,
    regle: {
      name: texte.slice(0, 120),
      trigger,
      thresholdDays,
      action,
      phrase: texte,
      explication: `Quand « ${libelleDeclencheur} »${seuilRequis ? ` depuis ${thresholdDays} jour(s)` : ''} → « ${libelleAction} ». Rien n’est envoyé : l’action est préparée et vous la validez.`,
    },
  };
}

export interface ResultatTestABlanc {
  /** Éléments qui AURAIENT déclenché la règle, avec leur libellé réel. */
  declenchements: Array<{ cle: string; label: string; detail: string }>;
  /** Nombre d'éléments examinés, pour distinguer « rien à signaler » de « rien à examiner ». */
  examines: number;
  /** Message honnête sur ce que le test montre — et ne montre pas. */
  message: string;
}

/**
 * Test à blanc : applique la règle aux données actuelles, sans RIEN exécuter.
 *
 * Le message distingue explicitement « aucun élément concerné » de « aucune
 * donnée à examiner ». Les deux se ressemblent à l'écran et n'ont pas le même
 * sens : le premier rassure, le second doit alerter.
 */
export function testerABlanc(
  regle: Pick<RegleProposee, 'trigger' | 'thresholdDays'>,
  elements: readonly { cle: string; label: string; detail: string; jours: number | null }[],
): ResultatTestABlanc {
  const declenchements = elements
    .filter((element) => element.jours !== null && element.jours >= regle.thresholdDays)
    .map((element) => ({ cle: element.cle, label: element.label, detail: element.detail }));

  let message: string;
  if (elements.length === 0) {
    message = 'Aucune donnée à examiner : activez la règle plus tard, ou enregistrez d’abord les éléments concernés.';
  } else if (declenchements.length === 0) {
    message = `${elements.length} élément(s) examiné(s) : aucun ne déclencherait la règle aujourd’hui.`;
  } else {
    message = `${declenchements.length} élément(s) sur ${elements.length} déclencheraient la règle. Rien n’a été exécuté : c’est un aperçu.`;
  }

  return { declenchements, examines: elements.length, message };
}

/** Le message préparé par une règle ne doit jamais partir seul. */
export function actionNecessiteValidation(action: AutomationAction): boolean {
  // Toutes les actions actuelles préparent quelque chose : aucune n'envoie.
  return action === 'preparer_relance' || action === 'creer_tache' || action === 'notifier';
}
