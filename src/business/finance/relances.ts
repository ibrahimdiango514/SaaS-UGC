/**
 * Relances d'impayés — séquence progressive, ton, langue, calendrier.
 *
 * ## Le principe
 * Une relance n'est pas un clic : c'est une suite de messages de plus en plus
 * fermes, espacés dans le temps. Relancer trop tôt agace un client qui allait
 * payer ; relancer trop tard laisse filer la trésorerie. Ce module calcule
 * l'étape RÉELLE de chaque créance à partir de sa date d'échéance et des
 * relances déjà faites, sans jamais envoyer quoi que ce soit : le message est
 * préparé, l'utilisateur le copie ou l'ouvre dans son propre outil.
 *
 * ## Ce qui n'est pas fait ici, volontairement
 *  - Aucun envoi : pas d'API de messagerie, pas de connecteur WhatsApp/Meta.
 *  - Aucun conseil juridique : au-delà de la dernière étape, on signale qu'il
 *    faut décider (mise en demeure, litige) sans dire quoi faire.
 *  - Aucun montant inventé : une créance sans montant n'affiche pas 0.
 */

import {
  computeReceivableView, daysBetween, type CollectionReminder, type Payment, type Receivable,
} from '../finance/model';
import type { Contact } from '../crm/model';

/** Étape de la séquence. L'ordre est le sens de lecture, pas un tri. */
export type EtapeRelance = 'rappel_court' | 'relance_ferme' | 'mise_en_demeure' | 'contentieux' | 'termine';

export interface EtapeDefinition {
  etape: EtapeRelance;
  /** Jours de retard à partir desquels cette étape s'applique. */
  aPartirDe: number;
  label: string;
  ton: 'cordial' | 'ferme' | 'formel';
  description: string;
}

/**
 * Barème par défaut. Ce ne sont pas des règles de droit : ce sont des repères
 * commerciaux, modifiables par l'utilisateur (voir `SequenceRelances.jours`).
 */
export const SEQUENCE_PAR_DEFAUT: readonly EtapeDefinition[] = [
  { etape: 'rappel_court', aPartirDe: 1, label: 'Rappel cordial', ton: 'cordial', description: 'Échéance dépassée de peu : on suppose un oubli.' },
  { etape: 'relance_ferme', aPartirDe: 15, label: 'Relance ferme', ton: 'ferme', description: 'Le retard s’installe : on demande une date de paiement.' },
  { etape: 'mise_en_demeure', aPartirDe: 30, label: 'Mise en demeure', ton: 'formel', description: 'Le retard est important : le courrier devient formel.' },
  { etape: 'contentieux', aPartirDe: 60, label: 'À décider', ton: 'formel', description: 'Au-delà, la décision vous revient : rien n’est engagé automatiquement.' },
  { etape: 'termine', aPartirDe: Number.POSITIVE_INFINITY, label: 'Soldée', ton: 'cordial', description: 'Plus rien à relancer.' },
];

/** Barème utilisateur, fusionné avec les repères par défaut. */
export function sequence(jours: Partial<Record<EtapeRelance, number>> = {}): EtapeDefinition[] {
  return SEQUENCE_PAR_DEFAUT.map((definition) => {
    const remplace = jours[definition.etape];
    return typeof remplace === 'number' && Number.isFinite(remplace) && remplace >= 0
      ? { ...definition, aPartirDe: remplace }
      : { ...definition };
  });
}

/** Étapes réellement franchissables, dans l'ordre croissant de retard. */
function etapesOrdonnees(sequenceUtilisee: readonly EtapeDefinition[]): EtapeDefinition[] {
  return sequenceUtilisee
    .filter((definition) => Number.isFinite(definition.aPartirDe))
    .slice()
    .sort((a, b) => a.aPartirDe - b.aPartirDe);
}

/**
 * Étape à appliquer pour un retard donné.
 *
 * Un retard nul (créance pas encore échue) ne déclenche AUCUNE relance : il
 * n'y a rien à réclamer. C'est une différence importante avec un simple tri par
 * date — relancer une facture non échue abîme la relation client.
 */
export function etapePour(joursDeRetard: number, sequenceUtilisee: readonly EtapeDefinition[] = SEQUENCE_PAR_DEFAUT): EtapeRelance {
  if (!Number.isFinite(joursDeRetard) || joursDeRetard <= 0) return 'termine';
  let retenue: EtapeRelance = 'termine';
  for (const definition of etapesOrdonnees(sequenceUtilisee)) {
    if (joursDeRetard >= definition.aPartirDe) retenue = definition.etape;
  }
  return retenue;
}

export type Langue = 'fr' | 'en' | 'es' | 'ar';

export const LANGUES: readonly { value: Langue; label: string }[] = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'ar', label: 'العربية' },
];

/**
 * Langue du message.
 *
 * On part de la langue du CONTACT (champ libre `langue` ou pays), pas de la
 * langue de l'interface : relancer en français un client qui ne le lit pas est
 * la façon la plus sûre de ne pas être payé. Le français reste le défaut
 * explicite quand rien n'est renseigné.
 */
export function langueDuClient(contact: Contact | null): Langue {
  const brut = `${contact?.country ?? ''}`.trim().toLowerCase();
  if (!brut) return 'fr';
  // Les tests anglophones passent EN PREMIER : « niger » est un pays
  // francophone, « nigeria » un pays anglophone, et une liste francophone
  // placée avant happait « nigeria ». Même piège pour « guinea »/« guinée ».
  if (/(nigeria|ghana|kenya|south africa|united kingdom|\buk\b|united states|\busa\b|canada)/.test(brut)) return 'en';
  if (/(sénégal|senegal|mali|côte|ivoire|burkina|guinée|guinee|togo|bénin|benin|^niger$|cameroun|congo|gabon|madagascar)/.test(brut)) return 'fr';
  if (/(espagne|spain|méxico|mexico|colombia|argentina|chile|perú|peru)/.test(brut)) return 'es';
  if (/(maroc|morocco|algérie|algerie|tunisie|tunisia|égypte|egypte|egypt|arabie|saudi|émirats|emirats|uae)/.test(brut)) return 'ar';
  return 'fr';
}

export interface ContexteRelance {
  contact: Contact | null;
  /** Nom de l'entreprise qui relance, tel qu'il doit apparaître. */
  entreprise: string;
  /** Montant dû, déjà calculé (jamais `0` par défaut). */
  montantDu: number | null;
  devise: string;
  reference: string;
  echeance: string;
  /** Date du jour, injectable pour les tests. */
  aujourdHui?: string;
}

function montantLisible(montant: number | null, devise: string, langue: Langue): string {
  if (montant === null || !Number.isFinite(montant)) {
    return langue === 'en' ? '(amount to be confirmed)' : langue === 'es' ? '(importe a confirmar)' : langue === 'ar' ? '(المبلغ قيد التأكيد)' : '(montant à confirmer)';
  }
  try {
    return new Intl.NumberFormat(
      langue === 'en' ? 'en-GB' : langue === 'es' ? 'es-ES' : langue === 'ar' ? 'ar-MA' : 'fr-FR',
      { style: 'currency', currency: devise || 'XOF', maximumFractionDigits: 2 },
    ).format(montant);
  } catch {
    // Devise inconnue de l'environnement : on n'invente pas de symbole.
    return `${montant} ${devise}`.trim();
  }
}

/**
 * Prépare le message de relance.
 *
 * Le texte est affiché puis copié par l'utilisateur. Aucun envoi n'est effectué,
 * et rien n'est promis sur le résultat : la formulation reste factuelle.
 */
export function messageRelanceImpaye(etape: EtapeRelance, contexte: ContexteRelance): string {
  const langue = langueDuClient(contexte.contact);
  const nom = [contexte.contact?.firstName, contexte.contact?.lastName].filter(Boolean).join(' ').trim();
  const montant = montantLisible(contexte.montantDu, contexte.devise, langue);
  const reference = contexte.reference || (langue === 'en' ? 'your invoice' : langue === 'es' ? 'su factura' : langue === 'ar' ? 'فاتورتكم' : 'votre facture');
  const signataire = contexte.entreprise || (langue === 'en' ? 'our team' : langue === 'es' ? 'nuestro equipo' : langue === 'ar' ? 'فريقنا' : 'notre équipe');

  if (langue === 'en') {
    const tete = nom ? `Hello ${nom},` : 'Hello,';
    if (etape === 'rappel_court') return `${tete}\n\nThis is a friendly reminder that ${reference} (${montant}) was due on ${contexte.echeance}. It may simply have slipped through — could you confirm it is on its way?\n\nThank you,\n${signataire}`;
    if (etape === 'relance_ferme') return `${tete}\n\n${reference} (${montant}) is still outstanding, due since ${contexte.echeance}. Could you tell us the date payment will be made?\n\nThank you,\n${signataire}`;
    if (etape === 'mise_en_demeure') return `${tete}\n\nDespite our previous reminders, ${reference} (${montant}) remains unpaid since ${contexte.echeance}.\n\nPlease settle this amount or contact us within eight days so we can find a solution.\n\n${signataire}`;
    return `${tete}\n\n${reference} (${montant}) is still unpaid since ${contexte.echeance}. Please let us know how you intend to proceed.\n\n${signataire}`;
  }

  if (langue === 'es') {
    const tete = nom ? `Hola ${nom}:` : 'Hola:';
    if (etape === 'rappel_court') return `${tete}\n\nLe recordamos amablemente que ${reference} (${montant}) venció el ${contexte.echeance}. Es posible que se haya pasado por alto; ¿puede confirmarnos que está en camino?\n\nGracias,\n${signataire}`;
    if (etape === 'relance_ferme') return `${tete}\n\n${reference} (${montant}) sigue pendiente desde el ${contexte.echeance}. ¿Puede indicarnos la fecha de pago?\n\nGracias,\n${signataire}`;
    if (etape === 'mise_en_demeure') return `${tete}\n\nA pesar de nuestros recordatorios, ${reference} (${montant}) sigue sin pagarse desde el ${contexte.echeance}.\n\nLe rogamos regularice el importe o nos contacte en un plazo de ocho días.\n\n${signataire}`;
    return `${tete}\n\n${reference} (${montant}) sigue pendiente desde el ${contexte.echeance}. Indíquenos cómo piensa proceder.\n\n${signataire}`;
  }

  if (langue === 'ar') {
    const tete = nom ? `مرحباً ${nom}،` : 'مرحباً،';
    if (etape === 'rappel_court') return `${tete}\n\nنذكّركم بلطف بأن ${reference} (${montant}) كان مستحقاً في ${contexte.echeance}. ربما سهوٌ بسيط — هل يمكنكم تأكيد أن الدفع في طريقه؟\n\nشكراً،\n${signataire}`;
    if (etape === 'relance_ferme') return `${tete}\n\nلا يزال ${reference} (${montant}) غير مسدد منذ ${contexte.echeance}. هل يمكنكم إبلاغنا بتاريخ الدفع؟\n\nشكراً،\n${signataire}`;
    if (etape === 'mise_en_demeure') return `${tete}\n\nرغم تذكيراتنا السابقة، لا يزال ${reference} (${montant}) غير مسدد منذ ${contexte.echeance}.\n\nنرجو تسوية المبلغ أو التواصل معنا خلال ثمانية أيام.\n\n${signataire}`;
    return `${tete}\n\nلا يزال ${reference} (${montant}) غير مسدد منذ ${contexte.echeance}. نرجو إبلاغنا بالخطوات المقبلة.\n\n${signataire}`;
  }

  const tete = nom ? `Bonjour ${nom},` : 'Bonjour,';
  if (etape === 'rappel_court') {
    return `${tete}\n\nSauf erreur de notre part, ${reference} (${montant}) était due le ${contexte.echeance}. Il s’agit peut-être d’un simple oubli : pouvez-vous nous confirmer que le règlement est en cours ?\n\nBien cordialement,\n${signataire}`;
  }
  if (etape === 'relance_ferme') {
    return `${tete}\n\n${reference} (${montant}) reste impayée depuis le ${contexte.echeance}. Pouvez-vous nous indiquer la date à laquelle le règlement sera effectué ?\n\nBien cordialement,\n${signataire}`;
  }
  if (etape === 'mise_en_demeure') {
    return `${tete}\n\nMalgré nos précédentes relances, ${reference} (${montant}) demeure impayée depuis le ${contexte.echeance}.\n\nNous vous invitons à régulariser ce montant ou à nous contacter sous huit jours afin de trouver une solution.\n\n${signataire}`;
  }
  return `${tete}\n\n${reference} (${montant}) demeure impayée depuis le ${contexte.echeance}. Merci de nous indiquer comment vous souhaitez procéder.\n\n${signataire}`;
}

export interface RelanceDue {
  receivable: Receivable;
  contact: Contact | null;
  /** Montant restant dû. `null` quand le montant d'origine est inconnu. */
  montantDu: number | null;
  joursDeRetard: number;
  etape: EtapeRelance;
  etapeLabel: string;
  ton: EtapeDefinition['ton'];
  /** La relance a-t-elle déjà été préparée ou faite pour cette étape ? */
  dejaFaite: boolean;
  /** Prochaine relance à préparer, vide si rien ne reste à faire. */
  prochaine: string;
  /** Message prêt à copier. */
  message: string;
  /** Vrai quand l'étape sort du cadre commercial et exige une décision humaine. */
  decisionRequise: boolean;
}

function datePlus(jours: number, depuis: string): string {
  if (!depuis) return '';
  const base = new Date(`${depuis.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return '';
  base.setUTCDate(base.getUTCDate() + jours);
  return base.toISOString().slice(0, 10);
}

/**
 * Construit la liste des relances à traiter, la plus urgente d'abord.
 *
 * Une créance sans échéance exploitable n'est PAS relancée : on ne peut pas
 * calculer de retard, donc on ne prétend pas en connaître un. Elle est écartée
 * silencieusement ici et signalée par l'écran, qui compte les créances non
 * exploitables.
 */
export function relancesDues(
  receivables: readonly Receivable[],
  payments: readonly Payment[],
  reminders: readonly CollectionReminder[],
  contacts: readonly Contact[],
  options: {
    aujourdHui?: string;
    entreprise?: string;
    sequenceUtilisee?: readonly EtapeDefinition[];
    /** Devises par créance, lues dans la facture d'origine. */
    devises?: Record<string, string>;
  } = {},
): RelanceDue[] {
  const aujourdHui = options.aujourdHui ?? new Date().toISOString().slice(0, 10);
  const parId = new Map(contacts.map((contact) => [contact.id, contact]));
  const sequenceUtilisee = options.sequenceUtilisee ?? SEQUENCE_PAR_DEFAUT;
  const dues: RelanceDue[] = [];

  for (const receivable of receivables) {
    const vue = computeReceivableView(receivable, payments, aujourdHui);
    // Ni soldée, ni annulée, ni en litige : un litige suit son propre circuit.
    if (['payee', 'annulee', 'brouillon', 'litige'].includes(vue.effectiveStatus)) continue;

    /*
     * Montant inconnu (`initialAmount === null`) : `computeReceivableView`
     * renvoie alors 0 jour de retard, ce qui ferait DISPARAÎTRE la créance de
     * la relance. C'est précisément la créance la plus risquée — on ne sait pas
     * combien elle vaut, mais on sait quand elle était due. On calcule donc le
     * retard sur l'échéance, et le montant reste affiché comme inconnu.
     */
    const joursDeRetard = receivable.initialAmount === null
      ? Math.max(0, daysBetween(receivable.dueDate, aujourdHui) ?? 0)
      : vue.daysOverdue;
    if (joursDeRetard <= 0) continue;

    const contact = parId.get(receivable.contactId) ?? null;
    const etape = etapePour(joursDeRetard, sequenceUtilisee);
    if (etape === 'termine') continue;
    const definition = sequenceUtilisee.find((item) => item.etape === etape) ?? SEQUENCE_PAR_DEFAUT[0];

    const faitesPourCetteEtape = reminders.filter((reminder) => reminder.receivableId === receivable.id
      && reminder.status !== 'annule' && reminder.template === etape);

    const suivante = sequenceUtilisee
      .filter((item) => Number.isFinite(item.aPartirDe) && item.aPartirDe > joursDeRetard)
      .sort((a, b) => a.aPartirDe - b.aPartirDe)[0];

    const montantDu = receivable.initialAmount === null ? null : vue.balance;
    dues.push({
      receivable,
      contact,
      montantDu,
      joursDeRetard,
      etape,
      etapeLabel: definition.label,
      ton: definition.ton,
      dejaFaite: faitesPourCetteEtape.length > 0,
      prochaine: suivante && suivante.etape !== 'termine'
        ? `Prochaine étape « ${suivante.label} » à partir du ${datePlus(suivante.aPartirDe - joursDeRetard, aujourdHui)}`
        : 'Dernière étape commerciale : à vous de décider de la suite',
      message: messageRelanceImpaye(etape, {
        contact,
        entreprise: options.entreprise ?? '',
        montantDu,
        devise: options.devises?.[receivable.id] ?? '',
        reference: receivable.reference,
        echeance: receivable.dueDate,
        aujourdHui,
      }),
      decisionRequise: etape === 'contentieux',
    });
  }

  return dues.sort((a, b) => b.joursDeRetard - a.joursDeRetard);
}

/** Total réellement relançable, par devise. Jamais additionné entre devises. */
export function totalRelancable(dues: readonly RelanceDue[], devise: string): number | null {
  const montants = dues
    .filter((due) => due.montantDu !== null)
    .map((due) => due.montantDu as number);
  if (montants.length === 0) return null;
  // Sans devise connue, additionner n'aurait pas de sens : on ne le fait pas.
  if (!devise) return null;
  return montants.reduce((somme, montant) => somme + montant, 0);
}
