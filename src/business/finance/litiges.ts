/**
 * Dossiers de litige — fonctionnalité 1.
 *
 * Complète `ReceivableDispute` (qui n'avait ni montant, ni échéance, ni preuves)
 * sans le remplacer : les nouveaux champs sont OPTIONNELS et les dossiers
 * existants restent lisibles tels quels.
 *
 * Garanties tenues par ce module :
 *  - **aucune preuve inventée** : seules les preuves RÉELLEMENT présentes dans
 *    l'espace de travail sont listées, avec leur source ; une preuve absente est
 *    affichée comme absente, jamais comblée ;
 *  - **aucune promesse de victoire** : le module ne qualifie pas les chances de
 *    gagner, il prépare une réponse structurée que l'utilisateur relit ;
 *  - les délais sont des **rappels** calculés depuis la date saisie, pas du
 *    conseil juridique.
 */

import type { ReceivableDispute } from './model';

/** Type de preuve, rattaché à une donnée réellement présente dans le produit. */
export type TypePreuve = 'facture' | 'echeances' | 'paiements' | 'conditions' | 'echanges' | 'relances' | 'livraison';

export interface PreuveDisponible {
  type: TypePreuve;
  label: string;
  /** Vrai si la source existe réellement dans l'espace de travail. */
  disponible: boolean;
  /** Où l'utilisateur peut la retrouver, en clair. */
  source: string;
  /** Résumé factuel, construit depuis les données. Vide si indisponible. */
  detail: string;
}

export interface DossierLitige {
  /** Champs historiques, inchangés. */
  dispute: ReceivableDispute;
  /** Nouveaux champs, tous optionnels : les dossiers existants restent valides. */
  montant: number | null;
  devise: string | null;
  echeance: string;
  /** Échéance dépassée ? `null` si aucune échéance n'est renseignée. */
  enRetard: boolean | null;
  joursRestants: number | null;
}

export interface SourcePreuves {
  /** Référence et montant de la créance liée — toujours disponible. */
  creance: { reference: string; montantInitial: number | null; devise: string; dueDate: string; conditions: string } | null;
  /** Échéances/relances réellement enregistrées. */
  relances: number;
  /** Paiements réellement enregistrés sur cette créance. */
  paiements: number;
  /** Concerne une livraison : la donnée existe-t-elle (commande liée) ? */
  commande: { numero: string; statut: string } | null;
  /** Échanges client réellement journalisés (contact). */
  echanges: number;
}

/**
 * Relit un dossier depuis un enregistrement. Les anciens enregistrements, qui
 * n'ont ni `montant` ni `echeance`, sont acceptés sans erreur.
 */
export function dossierFrom(
  dispute: ReceivableDispute,
  data: Record<string, unknown>,
  aujourdhui: string,
): DossierLitige {
  const montant = typeof data.montant === 'number' && Number.isFinite(data.montant) && data.montant >= 0
    ? data.montant : null;
  const devise = typeof data.devise === 'string' && data.devise.trim() ? data.devise.trim().toUpperCase().slice(0, 8) : null;
  const echeance = typeof data.echeance === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.echeance) ? data.echeance : '';

  let joursRestants: number | null = null;
  if (echeance) {
    const a = Date.parse(`${aujourdhui}T00:00:00Z`);
    const b = Date.parse(`${echeance}T00:00:00Z`);
    if (!Number.isNaN(a) && !Number.isNaN(b)) joursRestants = Math.round((b - a) / 86_400_000);
  }

  return {
    dispute,
    montant,
    devise,
    echeance,
    enRetard: joursRestants === null ? null : joursRestants < 0,
    joursRestants,
  };
}

export function dossierToData(dossier: DossierLitige): Record<string, unknown> {
  return {
    ...dossier.dispute,
    montant: dossier.montant,
    devise: dossier.devise,
    echeance: dossier.echeance,
  } as unknown as Record<string, unknown>;
}

/**
 * Inventaire des preuves.
 *
 * Chaque entrée dit si la source EXISTE. On ne dit jamais « preuve fournie »
 * quand la donnée est absente : c'est la différence entre un dossier utile et
 * un dossier qui fait perdre du temps.
 */
export function inventorierPreuves(sources: SourcePreuves): PreuveDisponible[] {
  const creance = sources.creance;
  const preuves: PreuveDisponible[] = [];

  preuves.push({
    type: 'facture',
    label: 'Facture d’origine',
    disponible: Boolean(creance?.reference),
    source: 'Ventes et facturation',
    detail: creance?.reference
      ? `Facture ${creance.reference}${creance.montantInitial !== null ? ` — ${formatMontant(creance.montantInitial, creance.devise)}` : ''}`
      : '',
  });

  preuves.push({
    type: 'echeances',
    label: 'Échéance et conditions de paiement',
    disponible: Boolean(creance?.dueDate || creance?.conditions),
    source: 'Fiche de la créance',
    detail: creance?.dueDate
      ? `Échéance ${creance.dueDate}${creance.conditions ? ` · ${creance.conditions}` : ''}`
      : (creance?.conditions ?? ''),
  });

  preuves.push({
    type: 'paiements',
    label: 'Paiements reçus',
    disponible: sources.paiements > 0,
    source: 'Recouvrement — paiements',
    detail: sources.paiements > 0 ? `${sources.paiements} paiement(s) enregistré(s)` : '',
  });

  preuves.push({
    type: 'echanges',
    label: 'Échanges avec le client',
    disponible: sources.echanges > 0,
    source: 'CRM — activités du contact',
    detail: sources.echanges > 0 ? `${sources.echanges} échange(s) journalisé(s)` : '',
  });

  preuves.push({
    type: 'relances',
    label: 'Relances déjà envoyées',
    disponible: sources.relances > 0,
    source: 'Recouvrement — relances',
    detail: sources.relances > 0 ? `${sources.relances} relance(s) enregistrée(s)` : '',
  });

  preuves.push({
    type: 'livraison',
    label: 'Preuve de livraison',
    disponible: Boolean(sources.commande),
    source: 'Ventes — commandes',
    detail: sources.commande ? `Commande ${sources.commande.numero} (${sources.commande.statut})` : '',
  });

  return preuves;
}

/** Les preuves manquantes, à réclamer à l'utilisateur — jamais à fabriquer. */
export function preuvesManquantes(preuves: readonly PreuveDisponible[]): PreuveDisponible[] {
  return preuves.filter((preuve) => !preuve.disponible);
}

export interface BrouillonReponse {
  objet: string;
  corps: string;
  /** Avertissements affichés sous le brouillon. */
  avertissements: string[];
}

/**
 * Prépare un brouillon de réponse structuré.
 *
 * Le brouillon ne contient QUE des faits présents dans les preuves. Aucune
 * mention de chances de succès, aucune menace, aucune reconnaissance de dette
 * au nom du client. L'utilisateur relit et envoie lui-même : aucun envoi
 * automatique n'existe dans ce module.
 */
export function brouillonReponse(dossier: DossierLitige, preuves: readonly PreuveDisponible[]): BrouillonReponse {
  const reference = sourcesReference(preuves);
  const montant = dossier.montant !== null && dossier.devise
    ? formatMontant(dossier.montant, dossier.devise)
    : 'le montant contesté';
  const joignables = preuves.filter((preuve) => preuve.disponible);

  const lignes = [
    'Bonjour,',
    '',
    `Nous faisons suite à votre contestation concernant ${reference}${dossier.montant !== null ? ` (${montant})` : ''}.`,
    `Motif enregistré de notre côté : ${dossier.dispute.reason || 'non précisé'}.`,
    '',
    'Éléments que nous pouvons transmettre :',
    ...(joignables.length > 0
      ? joignables.map((preuve) => `- ${preuve.label} : ${preuve.detail}`)
      : ['- Aucun élément n’est encore disponible de notre côté.']),
    '',
    'Merci de nous indiquer les pièces que vous souhaitez recevoir, ou la date à laquelle vous pourrez régler.',
    '',
    'Cordialement,',
  ];

  const avertissements = [
    'Ce texte est un brouillon : relisez-le avant envoi. Aucun envoi n’est automatique.',
    'Il ne contient aucune évaluation de vos chances et ne constitue pas un conseil juridique.',
  ];
  if (joignables.length === 0) {
    avertissements.push('Aucune preuve n’est disponible : réunissez-les avant d’envoyer une réponse.');
  }

  return {
    objet: `Contestation ${reference} — éléments de réponse`.slice(0, 160),
    corps: lignes.join('\n').slice(0, 4000),
    avertissements,
  };
}

/** Alerte d'échéance : renvoie une sévérité, jamais une conclusion. */
export function alerteEcheance(dossier: DossierLitige): { niveau: 'aucune' | 'proche' | 'aujourdhui' | 'depassee'; label: string } {
  if (dossier.joursRestants === null) return { niveau: 'aucune', label: 'Aucune échéance renseignée.' };
  const jours = dossier.joursRestants;
  if (jours < 0) return { niveau: 'depassee', label: `Échéance dépassée de ${Math.abs(jours)} jour(s).` };
  if (jours === 0) return { niveau: 'aujourdhui', label: 'Échéance aujourd’hui.' };
  if (jours <= 7) return { niveau: 'proche', label: `Échéance dans ${jours} jour(s).` };
  return { niveau: 'aucune', label: `Échéance dans ${jours} jour(s).` };
}

/** Litiges à traiter, triés par urgence RÉELLE (pas de priorité inventée). */
export function dossiersAQctiver(dossiers: readonly DossierLitige[], limite = 5): DossierLitige[] {
  return [...dossiers]
    .filter((dossier) => dossier.dispute.status === 'ouvert' || dossier.dispute.status === 'en_cours')
    .sort((a, b) => {
      const rang = (d: DossierLitige) => (d.joursRestants === null ? Number.MAX_SAFE_INTEGER : d.joursRestants);
      const diff = rang(a) - rang(b);
      if (diff !== 0) return diff;
      return (b.montant ?? 0) - (a.montant ?? 0);
    })
    .slice(0, limite);
}

function sourcesReference(preuves: readonly PreuveDisponible[]): string {
  const facture = preuves.find((preuve) => preuve.type === 'facture' && preuve.disponible);
  if (!facture) return 'votre dossier';
  const trouve = facture.detail.match(/Facture\s+(\S+)/);
  return trouve ? `la facture ${trouve[1]}` : 'votre dossier';
}

function formatMontant(montant: number, devise: string): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(montant)} ${devise}`;
}
