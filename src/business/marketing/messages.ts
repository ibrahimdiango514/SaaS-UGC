/**
 * Messages préparés — modèles et réponses suggérées, SANS API de messagerie.
 *
 * ## La règle
 * Aucun connecteur WhatsApp, Meta ou Google. L'application ne peut pas envoyer :
 * elle prépare un texte juste, dans la bonne langue, avec les vrais chiffres de
 * l'utilisateur, puis l'utilisateur le copie ou l'ouvre dans son propre outil.
 *
 * ## Pourquoi des modèles plutôt qu'une génération libre
 * Un message commercial engage l'entreprise. Un modèle relu, dont chaque trou
 * est rempli par une donnée réelle (jamais par une invention), est plus sûr
 * qu'une phrase générée à la volée — et fonctionne sans fournisseur d'IA.
 * L'agent peut PROPOSER un texte via le chat ; il reste une proposition.
 */

export type SituationMessage =
  | 'devis_sans_reponse'
  | 'facture_en_retard'
  | 'relance_douce'
  | 'remerciement_paiement'
  | 'confirmation_commande'
  | 'excuse_retard_livraison'
  | 'demande_recommandation'
  | 'reponse_contestation';

export type LangueMessage = 'fr' | 'en';

export interface ModeleMessage {
  situation: SituationMessage;
  label: string;
  /** Quand l'utiliser. Affiché à l'utilisateur : pas de choix aveugle. */
  quand: string;
  /** Champs que l'utilisateur doit fournir ; un champ vide n'est pas inventé. */
  variables: readonly string[];
}

export const MODELES: readonly ModeleMessage[] = [
  {
    situation: 'devis_sans_reponse',
    label: 'Devis sans réponse',
    quand: 'Un devis a été envoyé et aucune décision n’est revenue.',
    variables: ['client', 'numero', 'montant', 'validite'],
  },
  {
    situation: 'facture_en_retard',
    label: 'Facture en retard',
    quand: 'L’échéance d’une facture est dépassée (voir aussi Relances).',
    variables: ['client', 'numero', 'montant', 'echeance'],
  },
  {
    situation: 'relance_douce',
    label: 'Relance douce',
    quand: 'Le client est fidèle et le retard est probablement un oubli.',
    variables: ['client', 'numero', 'montant'],
  },
  {
    situation: 'remerciement_paiement',
    label: 'Remerciement après paiement',
    quand: 'Un paiement vient d’être encaissé.',
    variables: ['client', 'montant'],
  },
  {
    situation: 'confirmation_commande',
    label: 'Confirmation de commande',
    quand: 'Une commande vient d’être enregistrée.',
    variables: ['client', 'numero'],
  },
  {
    situation: 'excuse_retard_livraison',
    label: 'Retard de livraison',
    quand: 'La livraison prend du retard et il faut le dire avant le client.',
    variables: ['client', 'numero', 'nouvelle_date'],
  },
  {
    situation: 'demande_recommandation',
    label: 'Demande de recommandation',
    quand: 'Un client est satisfait : demander un avis sans le forcer.',
    variables: ['client'],
  },
  {
    situation: 'reponse_contestation',
    label: 'Réponse à une contestation',
    quand: 'Un litige est ouvert : accuser réception sans reconnaître de dette.',
    variables: ['client', 'numero'],
  },
];

const GABARITS: Record<SituationMessage, Record<LangueMessage, string>> = {
  devis_sans_reponse: {
    fr: 'Bonjour {{client}},\n\nJe reviens vers vous au sujet du devis {{numero}} ({{montant}}), valable jusqu’au {{validite}}.\n\nSouhaitez-vous que nous ajustions quelque chose, ou avez-vous besoin d’un complément pour décider ?\n\nBien cordialement,',
    en: 'Hello {{client}},\n\nI am following up on quote {{numero}} ({{montant}}), valid until {{validite}}.\n\nWould you like us to adjust anything, or do you need more detail before deciding?\n\nBest regards,',
  },
  facture_en_retard: {
    fr: 'Bonjour {{client}},\n\nSauf erreur de notre part, la facture {{numero}} ({{montant}}) était due le {{echeance}}.\n\nPouvez-vous nous confirmer que le règlement est en cours ?\n\nBien cordialement,',
    en: 'Hello {{client}},\n\nUnless we are mistaken, invoice {{numero}} ({{montant}}) was due on {{echeance}}.\n\nCould you confirm that payment is on its way?\n\nBest regards,',
  },
  relance_douce: {
    fr: 'Bonjour {{client}},\n\nPetit rappel amical : la facture {{numero}} ({{montant}}) est en attente de règlement. Il s’agit peut-être d’un simple oubli.\n\nMerci d’avance,',
    en: 'Hello {{client}},\n\nA friendly reminder: invoice {{numero}} ({{montant}}) is still awaiting payment. It may simply have slipped through.\n\nThank you,',
  },
  remerciement_paiement: {
    fr: 'Bonjour {{client}},\n\nMerci, nous avons bien reçu votre paiement de {{montant}}. La facture est soldée de notre côté.\n\nÀ très bientôt,',
    en: 'Hello {{client}},\n\nThank you, we have received your payment of {{montant}}. The invoice is settled on our side.\n\nTalk soon,',
  },
  confirmation_commande: {
    fr: 'Bonjour {{client}},\n\nNous confirmons votre commande {{numero}}. Nous revenons vers vous dès qu’elle est prête.\n\nMerci de votre confiance,',
    en: 'Hello {{client}},\n\nWe confirm your order {{numero}}. We will get back to you as soon as it is ready.\n\nThank you for your trust,',
  },
  excuse_retard_livraison: {
    fr: 'Bonjour {{client}},\n\nVotre commande {{numero}} prend du retard. La nouvelle date prévue est le {{nouvelle_date}}.\n\nNous sommes désolés de ce décalage et restons disponibles si cela pose problème.\n\nBien cordialement,',
    en: 'Hello {{client}},\n\nYour order {{numero}} is delayed. The new expected date is {{nouvelle_date}}.\n\nWe apologise for the delay and remain available if this is a problem.\n\nBest regards,',
  },
  demande_recommandation: {
    fr: 'Bonjour {{client}},\n\nNous espérons que tout s’est bien passé. Si vous êtes satisfait, un avis de votre part nous aiderait beaucoup — sans aucune obligation.\n\nMerci,',
    en: 'Hello {{client}},\n\nWe hope everything went well. If you are happy with our work, a short review would help us a lot — with no obligation at all.\n\nThank you,',
  },
  reponse_contestation: {
    fr: 'Bonjour {{client}},\n\nNous avons bien reçu votre message concernant {{numero}} et nous vous en remercions.\n\nNous vérifions les éléments de notre côté et revenons vers vous avec une réponse précise. Aucun prélèvement ne sera effectué d’ici là.\n\nBien cordialement,',
    en: 'Hello {{client}},\n\nThank you for your message about {{numero}}. We have received it.\n\nWe are checking the details on our side and will come back to you with a precise answer. No charge will be made in the meantime.\n\nBest regards,',
  },
};

/**
 * Remplit un gabarit.
 *
 * Une variable manquante reste VISIBLE sous la forme `{{client}}` : c'est
 * volontaire. Un texte parti avec un trou est réparable ; un texte parti avec
 * un nom inventé ne l'est pas. L'écran signale les trous avant la copie.
 */
export function remplirModele(
  situation: SituationMessage,
  langue: LangueMessage,
  valeurs: Record<string, string>,
): string {
  const gabarit = GABARITS[situation]?.[langue] ?? '';
  return gabarit.replace(/\{\{(\w+)\}\}/g, (entier, cle: string) => {
    const valeur = (valeurs[cle] ?? '').trim();
    return valeur ? valeur : entier;
  });
}

/** Variables restées vides, pour les signaler avant l'envoi. */
export function trousDuMessage(texte: string): string[] {
  return [...texte.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
}

/**
 * Suggère une situation à partir d'un fait métier observé.
 *
 * On ne devine pas : sans signal clair, aucune suggestion n'est renvoyée, et
 * l'écran n'affiche pas de « message recommandé » qui n'aurait pas de raison.
 */
export function situationSuggeree(signaux: {
  devisSansReponse?: number;
  facturesEnRetard?: number;
  paiementRecent?: boolean;
  litigeOuvert?: boolean;
}): SituationMessage | null {
  if (signaux.litigeOuvert) return 'reponse_contestation';
  if ((signaux.facturesEnRetard ?? 0) > 3) return 'facture_en_retard';
  if (signaux.paiementRecent) return 'remerciement_paiement';
  if ((signaux.devisSansReponse ?? 0) > 0) return 'devis_sans_reponse';
  return null;
}

/** Lien de préparation : ouvre le logiciel de courrier, n'envoie rien. */
export function lienMailto(email: string, sujet: string, corps: string): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(sujet)}&body=${encodeURIComponent(corps)}`;
}

/** Lien WhatsApp « clic pour discuter » — sans API, sans envoi automatique. */
export function lienWhatsApp(numero: string, texte: string): string {
  const propre = numero.replace(/[^\d]/g, '');
  return propre ? `https://wa.me/${propre}?text=${encodeURIComponent(texte)}` : '';
}
