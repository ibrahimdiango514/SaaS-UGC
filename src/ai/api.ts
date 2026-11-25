/**
 * SORAHNEX AI — accès aux conversations de l'assistant personnel.
 *
 * ## Pourquoi ce module plutôt qu'un nouvel appel
 *
 * Le socle est déjà déployé en production : les tables `saas_business.conversations`
 * et `saas_business.messages`, les fonctions `bg_create_conversation`,
 * `bg_list_conversations`, `bg_rename_conversation`, `bg_delete_conversation`,
 * `bg_list_messages` et `bg_submit_user_message`, plus la fonction Edge
 * `business-grow` qui expose tout cela sous `conversations.*` / `messages.*`.
 *
 * On passe donc par `businessGrowApi`, qui :
 *   - signe chaque requête avec le JWT de l'utilisateur (jamais un UUID lu dans
 *     un en-tête) ;
 *   - délègue l'autorisation à la RLS et aux fonctions SQL, côté serveur ;
 *   - utilise le relais Netlify same-origin quand il est disponible.
 *
 * Aucune nouvelle table n'est créée, aucune duplication de logique. Si le socle
 * n'est pas déployé sur un environnement, l'erreur remonte telle quelle et
 * l'interface l'affiche — elle ne fabrique pas de conversation locale.
 */
import { businessGrowApi, type BusinessConversation, type BusinessMessage } from '../business/api';

export type { BusinessConversation as AiConversation, BusinessMessage as AiMessage };

/** Profil de raisonnement demandé à l'assistant. */
export type AiMode = 'standard' | 'analyse';

/** Pièce jointe rattachée à un message. */
export interface AiAttachment {
  name: string;
  /** Chemin Storage, ou `null` si le fichier n'a pas pu être téléversé. */
  storagePath: string | null;
  sizeBytes: number;
  mimeType: string;
  /** Texte extrait côté navigateur, pour les formats lisibles. */
  excerpt?: string;
  /**
   * Ce que le modèle peut réellement faire de ce fichier, en une phrase.
   *
   * Renseigné par `files/intoAssistant`. Il est transmis AU MODÈLE (pour qu'il
   * ne prétende pas avoir lu une vidéo) et affiché à l'utilisateur.
   */
  note?: string;
  /** Identifiant en base, une fois le fichier téléversé et enregistré. */
  fileId?: string;
  /**
   * Image redimensionnée, transmise au modèle vision (Gemini). Le binaire
   * n'est jamais placé dans le texte du message ni dans un log.
   */
  visionImage?: { mimeType: string; dataBase64: string };
}

const HISTORY_KEY = 'vyora.ai.history.v1';

/**
 * Liste les conversations de l'utilisateur.
 *
 * `workspaceId` vaut `null` pour l'espace assistant autonome, et l'identifiant
 * de l'entreprise active lorsque l'interface est hébergée dans SORAHNEX Grow :
 * les conversations y sont alors rattachées à cette entreprise, et la RLS
 * serveur garantit qu'un membre d'une autre entreprise ne les voit pas.
 */
export async function listConversations(workspaceId: string | null = null): Promise<BusinessConversation[]> {
  const { conversations } = await businessGrowApi.listConversations(workspaceId);
  return conversations ?? [];
}

export async function createConversation(title: string, workspaceId: string | null = null): Promise<string> {
  const { conversationId } = await businessGrowApi.createConversation(title, workspaceId);
  return conversationId;
}

export async function renameConversation(conversationId: string, title: string, workspaceId: string | null = null): Promise<void> {
  await businessGrowApi.renameConversation(conversationId, title, workspaceId);
}

export async function deleteConversation(conversationId: string, workspaceId: string | null = null): Promise<void> {
  await businessGrowApi.deleteConversation(conversationId, workspaceId);
}

export async function listMessages(conversationId: string, workspaceId: string | null = null): Promise<BusinessMessage[]> {
  const { messages } = await businessGrowApi.listMessages(conversationId, workspaceId);
  return messages ?? [];
}

/**
 * Envoie un message et attend la réponse de l'assistant.
 *
 * Le serveur écrit le message utilisateur, appelle `vyora-ai`, puis enregistre
 * la réponse. On recharge ensuite l'historique : c'est la source de vérité, et
 * cela évite de reconstruire côté client une réponse que le serveur a produite.
 *
 * Aucune réponse n'est inventée si l'appel échoue : l'erreur est propagée.
 */
export async function sendMessage(params: {
  conversationId: string;
  content: string;
  mode: AiMode;
  attachments: AiAttachment[];
  workspaceId?: string | null;
}): Promise<{ providerAvailable: boolean; provider?: { key: string; model: string } }> {
  const body = composeMessageBody(params.content, params.mode, params.attachments);
  const images = params.attachments.flatMap((attachment) => (
    attachment.visionImage ? [attachment.visionImage] : []
  ));
  const result = await businessGrowApi.sendMessage(
    params.conversationId,
    body,
    crypto.randomUUID(),
    {
      // `workspaceId` rattache l'échange à l'entreprise active quand l'interface
      // est hébergée dans SORAHNEX Grow. Absent pour l'assistant autonome, le
      // socle retombe sur son comportement d'origine.
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(images.length ? { images } : {}),
    },
  );
  return { providerAvailable: result.providerAvailable, provider: result.provider };
}

/**
 * Compose le texte transmis au modèle.
 *
 * Le mode « analyse » n'est pas un moteur distinct : c'est une consigne de
 * raisonnement ajoutée au message. Le dire explicitement évite de laisser
 * croire à une capacité séparée qui n'existe pas.
 *
 * Les pièces jointes sont résumées en fin de message : nom, type, taille, et
 * l'extrait lisible s'il existe. On n'envoie jamais un binaire au modèle.
 */
export function composeMessageBody(content: string, mode: AiMode, attachments: AiAttachment[]): string {
  const parts: string[] = [];

  if (mode === 'analyse') {
    parts.push(
      '[Mode analyse] Réponds de façon structurée : constats, analyse, puis '
        + 'recommandations. Distingue clairement ce qui provient des éléments '
        + 'fournis de ce qui relève d’une hypothèse.',
    );
  }

  parts.push(content.trim());

  const lisibles = attachments.filter((a) => a.excerpt);
  const vision = attachments.filter((a) => a.visionImage);
  const muettes = attachments.filter((a) => !a.excerpt && !a.visionImage);

  if (lisibles.length > 0) {
    parts.push(
      '--- Documents joints ---',
      ...lisibles.map((a) => `### ${a.name}\n${a.excerpt}`),
    );
  }
  if (vision.length > 0) {
    parts.push(
      '--- Images jointes (transmises au modèle vision) ---',
      ...vision.map((a) => `- ${a.name} (${a.mimeType})`),
      'Analyse réellement le contenu visuel de ces images. Si une image est '
        + 'illisible ou ambiguë, dis-le au lieu d’inventer.',
    );
  }
  if (muettes.length > 0) {
    parts.push(
      '--- Fichiers joints (contenu non transmis) ---',
      ...muettes.map((a) => {
        // La raison est donnée au modèle : sans elle, il pourrait affirmer
        // avoir « analysé la vidéo » alors qu'il n'a reçu qu'un nom de fichier.
        const motif = a.note ? ` — ${a.note}` : '';
        return `- ${a.name} (${a.mimeType}, ${Math.round(a.sizeBytes / 1024)} Ko)${motif}`;
      }),
      'Consigne : ne prétends pas avoir lu le contenu de ces fichiers. Dis '
        + 'explicitement ce qui manque et propose comment procéder autrement.',
    );
  }

  return parts.join('\n\n');
}

/**
 * Mémorise localement les conversations récemment ouvertes.
 *
 * Ce n'est pas un stockage de conversation : seulement un ordre de récence
 * pour l'affichage. Les messages restent en base, sous RLS.
 */
export function readRecentIds(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, 50) : [];
  } catch {
    return [];
  }
}

export function rememberConversation(conversationId: string): void {
  try {
    const next = [conversationId, ...readRecentIds().filter((id) => id !== conversationId)].slice(0, 50);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* quota dépassé ou mode privé : la récence est un confort, pas une donnée */
  }
}

/** Filtre les conversations pour la recherche de la barre latérale. */
export function filterConversations(
  conversations: BusinessConversation[],
  query: string,
): BusinessConversation[] {
  const q = query.trim().toLowerCase();
  if (!q) return conversations;
  return conversations.filter((c) => {
    const titre = (c.title ?? '').toLowerCase();
    const extrait = (c.last_message ?? '').toLowerCase();
    return titre.includes(q) || extrait.includes(q);
  });
}

/** Regroupe les conversations par période, comme l'attend la barre latérale. */
export function groupByRecency(conversations: BusinessConversation[]): Array<{
  label: string;
  items: BusinessConversation[];
}> {
  const now = Date.now();
  const jour = 86_400_000;
  const groupes: Array<{ label: string; items: BusinessConversation[] }> = [
    { label: 'Aujourd’hui', items: [] },
    { label: 'Hier', items: [] },
    { label: '7 derniers jours', items: [] },
    { label: '30 derniers jours', items: [] },
    { label: 'Plus ancien', items: [] },
  ];

  for (const c of conversations) {
    const age = now - new Date(c.updated_at ?? c.created_at).getTime();
    if (age < jour) groupes[0].items.push(c);
    else if (age < 2 * jour) groupes[1].items.push(c);
    else if (age < 7 * jour) groupes[2].items.push(c);
    else if (age < 30 * jour) groupes[3].items.push(c);
    else groupes[4].items.push(c);
  }

  return groupes.filter((g) => g.items.length > 0);
}

/** Titre par défaut d'une conversation créée sans contenu. */
export function defaultTitle(): string {
  return 'Nouvelle conversation';
}

/**
 * Dérive un titre depuis le premier message.
 *
 * Limité à 80 caractères : c'est la contrainte appliquée par le socle.
 */
export function titleFromMessage(content: string): string {
  const plat = content.replace(/\s+/g, ' ').trim();
  if (!plat) return defaultTitle();
  return plat.length <= 80 ? plat : `${plat.slice(0, 77)}…`;
}
