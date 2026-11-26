/**
 * SORAHNEX Agent IA — espace dédié.
 *
 * ## Pourquoi un module à part
 * L'assistant vivait comme une rubrique PARMI celles de SORAHNEX Grow (CRM,
 * Relances, Finance…). C'est un usage différent : une conversation longue,
 * avec un historique, des pièces jointes et des actions proposées. Le noyer
 * dans le menu métier le rendait difficile à retrouver et impossible à
 * présenter comme un espace.
 *
 * Ce module ne contient AUCUNE règle d'accès : il délègue à
 * `business/import-connect/access`, qui lit `public.vyora_import_connect_access()`.
 * Une seule règle d'abonnement dans toute l'application, pas deux.
 *
 * ## Ce qu'il ne fait pas
 * Il n'appelle aucun service IA et n'écrit aucune donnée. C'est une coquille de
 * navigation : la conversation, les outils et le journal restent dans
 * `BusinessAssistant` et dans le socle `business-grow`, déjà testés.
 */

export const AGENT_SPACE_PATH = '/app/agent';

/** Chemins de l'espace Agent, tous réels (aucun onglet mort). */
export const AGENT_SPACE_NAV = [
  {
    key: 'conversation',
    label: 'Conversation',
    shortLabel: 'Chat',
    description: 'Poser une question, joindre un document, demander une action',
    path: `${AGENT_SPACE_PATH}/conversation`,
  },
  {
    key: 'historique',
    label: 'Historique',
    shortLabel: 'Historique',
    description: 'Chaque proposition, décision et action, avec annulation',
    path: `${AGENT_SPACE_PATH}/historique`,
  },
  {
    key: 'capacites',
    label: 'Ce que l’agent peut faire',
    shortLabel: 'Capacités',
    description: 'Actions possibles, niveaux d’autonomie et limites',
    path: `${AGENT_SPACE_PATH}/capacites`,
  },
] as const;

export type AgentSpaceSection = typeof AGENT_SPACE_NAV[number]['key'];

/** Résout la section depuis l'URL ; repli sur la conversation. */
export function agentSectionFromPath(pathname: string): AgentSpaceSection {
  const reste = pathname.replace(/^\/app\/agent\/?/, '').replace(/\/+$/, '');
  const segment = reste.split('/')[0] ?? '';
  return (AGENT_SPACE_NAV.find((item) => item.key === segment)?.key) ?? 'conversation';
}

/**
 * Ce que l'espace apporte, énoncé sans promesse de résultat.
 *
 * Affiché sur l'écran verrouillé : l'utilisateur doit savoir ce qu'il
 * obtiendrait AVANT de souscrire, et rien ici n'est une garantie de performance.
 */
export const AGENT_SPACE_CAPABILITIES: readonly { titre: string; detail: string }[] = [
  {
    titre: 'Lire vos données Grow',
    detail: 'Contacts, ventes, factures, créances, trésorerie, stock, catalogue, litiges et journal — selon vos droits existants.',
  },
  {
    titre: 'Proposer des actions',
    detail: 'Créer ou modifier un devis, planifier une relance, créer une tâche, ajouter un contact, ouvrir un litige, enregistrer un paiement, préparer un message.',
  },
  {
    titre: 'Attendre votre validation',
    detail: 'Par défaut, l’agent prépare et vous validez. Aucune action sur l’argent, un client ou un envoi sans votre accord.',
  },
  {
    titre: 'Garder une trace',
    detail: 'Chaque demande, décision et action est journalisée, avec annulation quand elle est sûre.',
  },
  {
    titre: 'Traiter des documents',
    detail: 'PDF, DOCX, XLSX, CSV, TXT, MD, JSON et images. Leur contenu est une donnée : il ne donne jamais d’ordre à l’agent.',
  },
];
