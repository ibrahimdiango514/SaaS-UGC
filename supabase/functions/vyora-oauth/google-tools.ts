// VYORA — outils Google exposables en MCP (Gmail, Drive, Calendar).
//
// ## Pourquoi ce module est séparé du serveur MCP
// Le serveur `vyora-mcp` exécute ses outils par une RPC Postgres
// (`deps.callRpc(tool.rpc, args)`). Cela ne peut pas convenir ici : lire un
// e-mail demande de DÉCHIFFRER un jeton Google puis d'appeler `googleapis.com`,
// deux opérations impossibles en SQL seul. Ces outils ont donc leur propre
// exécuteur, dans la fonction qui détient déjà la clé de chiffrement.
//
// Le registre ci-dessous produit des définitions au format attendu par
// `McpToolDefinition` (nom, titre, description, schéma d'entrée, portée). Le
// branchement futur dans `tools/list` est donc mécanique : aucune réécriture.
//
// ## Isolation
// Aucun outil n'accepte d'identifiant de compte Google depuis le client : le
// compte est résolu côté serveur à partir de l'utilisateur du jeton, puis la
// capacité requise est vérifiée AVANT tout appel réseau. Un client ne peut donc
// ni désigner le compte d'un autre, ni obtenir une action que l'utilisateur n'a
// pas autorisée.

import {
  assertCapability,
  type GoogleProvider,
  type OAuthCapability,
} from '../_shared/oauth/index.ts';

export type GoogleToolName =
  | 'vyora_gmail_search'
  | 'vyora_gmail_read'
  | 'vyora_gmail_draft'
  | 'vyora_gmail_send'
  | 'vyora_drive_list'
  | 'vyora_calendar_list';

export interface GoogleToolDefinition {
  readonly name: GoogleToolName;
  readonly title: string;
  readonly description: string;
  /** Capacité exigée. Vérifiée avant tout appel réseau. */
  readonly capability: OAuthCapability;
  readonly provider: GoogleProvider;
  /** `true` si l'outil n'écrit rien chez Google. */
  readonly readOnly: boolean;
  readonly inputSchema: Record<string, unknown>;
}

const LIMIT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: 50,
  default: 10,
  description: 'Nombre maximum de résultats (1 à 50).',
} as const;

const EMAIL_SCHEMA = {
  type: 'string',
  minLength: 3,
  maxLength: 254,
  description: 'Adresse e-mail du destinataire.',
} as const;

export const GOOGLE_TOOLS: readonly GoogleToolDefinition[] = [
  {
    name: 'vyora_gmail_search',
    title: 'Chercher dans mes e-mails',
    description:
      'Recherche des messages dans la boîte Gmail connectée, avec la syntaxe de recherche Google (par exemple « from:client@exemple.com » ou « has:attachment »). Renvoie uniquement des métadonnées : expéditeur, objet, date. Aucun corps de message.',
    capability: 'read',
    provider: 'gmail',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 512,
          description: 'Requête de recherche Gmail. Vide = messages récents.',
        },
        limit: LIMIT_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vyora_gmail_read',
    title: 'Lire un e-mail',
    description:
      'Renvoie l’objet, l’expéditeur, les destinataires et un extrait d’un message précis. Le corps complet n’est pas renvoyé : seuls les 2 000 premiers caractères de l’extrait normalisé par Gmail.',
    capability: 'read',
    provider: 'gmail',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          minLength: 5,
          maxLength: 128,
          description: 'Identifiant Gmail du message, tel que renvoyé par la recherche.',
        },
      },
      required: ['message_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'vyora_gmail_draft',
    title: 'Préparer un brouillon',
    description:
      'Crée un brouillon dans la boîte Gmail connectée. Le brouillon N’EST PAS envoyé : il reste visible dans Gmail pour que l’utilisateur le relise et décide. Nécessite la permission « rédiger ».',
    capability: 'draft',
    provider: 'gmail',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        to: EMAIL_SCHEMA,
        subject: { type: 'string', maxLength: 200, description: 'Objet du brouillon.' },
        body: { type: 'string', maxLength: 10000, description: 'Corps du message en texte brut.' },
      },
      required: ['to', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'vyora_gmail_send',
    title: 'Envoyer un e-mail',
    description:
      'Envoie réellement un e-mail depuis la boîte connectée. Action IRRÉVERSIBLE : elle nécessite la permission « envoyer », distincte de « rédiger ». Ne pas utiliser sans confirmation explicite de l’utilisateur.',
    capability: 'send',
    provider: 'gmail',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        to: EMAIL_SCHEMA,
        subject: { type: 'string', maxLength: 200, description: 'Objet du message.' },
        body: { type: 'string', maxLength: 10000, description: 'Corps du message en texte brut.' },
      },
      required: ['to', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'vyora_drive_list',
    title: 'Lister mes fichiers Drive',
    description:
      'Liste les fichiers Google Drive accessibles par l’application, triés par dernière modification. Les fichiers créés hors de VYORA ne sont visibles que si la permission « lire » a été accordée.',
    capability: 'read',
    provider: 'google_drive',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 512,
          description: 'Recherche sur le nom du fichier. Vide = fichiers récents.',
        },
        limit: LIMIT_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vyora_calendar_list',
    title: 'Lister mes prochains événements',
    description:
      'Liste les prochains événements de l’agenda principal Google Calendar, à partir de maintenant. Renvoie le titre, les horaires et les participants.',
    capability: 'read',
    provider: 'google_calendar',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        limit: LIMIT_SCHEMA,
        days_ahead: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          default: 30,
          description: 'Fenêtre de recherche en jours (1 à 365).',
        },
      },
      additionalProperties: false,
    },
  },
];

export function googleToolByName(name: string): GoogleToolDefinition | undefined {
  return GOOGLE_TOOLS.find((tool) => tool.name === name);
}

/* -------------------------------------------------------------------------- */
/* Construction des requêtes — fonctions pures, testables sans réseau         */
/* -------------------------------------------------------------------------- */

export interface BuiltRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly body: string | null;
  readonly contentType: string | null;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';

/** Encode un message RFC 5322 minimal, puis en base64url (exigence Gmail). */
export function encodeGmailMessage(input: { to: string; subject?: string; body: string }): string {
  const headers = [
    `To: ${input.to}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    `Subject: ${input.subject ?? ''}`,
  ];
  const raw = `${headers.join('\r\n')}\r\n\r\n${input.body}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Refuse une adresse manifestement invalide plutôt que de laisser Google le faire. */
export function isValidEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 254) return false;
  // Un seul arobase, un domaine avec un point, aucun espace ni saut de ligne.
  // Le motif est volontairement strict : il empêche aussi l'injection d'en-têtes
  // (« \r\n Bcc: … ») dans le message envoyé.
  return /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]{2,}$/.test(trimmed);
}

export function buildGoogleRequest(
  tool: GoogleToolDefinition,
  args: Record<string, unknown>,
): BuiltRequest {
  switch (tool.name) {
    case 'vyora_gmail_search': {
      const params = new URLSearchParams({
        maxResults: String(args.limit ?? 10),
        // On ne demande QUE les en-têtes : le corps n'a pas à transiter.
        fields: 'messages(id,threadId),nextPageToken,resultSizeEstimate',
      });
      if (typeof args.query === 'string' && args.query.trim() !== '') {
        params.set('q', args.query.trim());
      }
      return { url: `${GMAIL}/messages?${params}`, method: 'GET', body: null, contentType: null };
    }
    case 'vyora_gmail_read': {
      const id = encodeURIComponent(String(args.message_id ?? ''));
      // `format=metadata` : Gmail renvoie les en-têtes et un extrait, jamais le
      // corps complet. C'est une contrainte de conception, pas un oubli.
      const params = new URLSearchParams({
        format: 'metadata',
        metadataHeaders: 'From',
      });
      params.append('metadataHeaders', 'To');
      params.append('metadataHeaders', 'Subject');
      params.append('metadataHeaders', 'Date');
      return { url: `${GMAIL}/messages/${id}?${params}`, method: 'GET', body: null, contentType: null };
    }
    case 'vyora_gmail_draft': {
      const raw = encodeGmailMessage({
        to: String(args.to),
        subject: args.subject ? String(args.subject) : undefined,
        body: String(args.body),
      });
      return {
        url: `${GMAIL}/drafts`,
        method: 'POST',
        body: JSON.stringify({ message: { raw } }),
        contentType: 'application/json',
      };
    }
    case 'vyora_gmail_send': {
      const raw = encodeGmailMessage({
        to: String(args.to),
        subject: args.subject ? String(args.subject) : undefined,
        body: String(args.body),
      });
      return {
        url: `${GMAIL}/messages/send`,
        method: 'POST',
        body: JSON.stringify({ raw }),
        contentType: 'application/json',
      };
    }
    case 'vyora_drive_list': {
      const params = new URLSearchParams({
        pageSize: String(args.limit ?? 10),
        orderBy: 'modifiedTime desc',
        // Uniquement des métadonnées : aucun contenu de fichier.
        fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
        // Les fichiers supprimés ne doivent pas apparaître.
        q: 'trashed = false',
      });
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query !== '') {
        // Échappement de l'apostrophe : une requête Drive est délimitée par '.
        params.set('q', `trashed = false and name contains '${query.replace(/'/g, "\\'")}'`);
      }
      return { url: `${DRIVE}/files?${params}`, method: 'GET', body: null, contentType: null };
    }
    case 'vyora_calendar_list': {
      const daysAhead = typeof args.days_ahead === 'number' ? args.days_ahead : 30;
      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + daysAhead * 86_400_000).toISOString();
      const params = new URLSearchParams({
        maxResults: String(args.limit ?? 10),
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        fields: 'items(summary,start,end,attendees(email),htmlLink,status)',
      });
      return {
        url: `${CALENDAR}/calendars/primary/events?${params}`,
        method: 'GET',
        body: null,
        contentType: null,
      };
    }
    default: {
      // Exhaustivité vérifiée à la compilation : ce cas est inatteignable.
      const exhaustive: never = tool.name;
      throw new Error(`outil inconnu: ${String(exhaustive)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Normalisation des réponses — on ne republie jamais de données brutes       */
/* -------------------------------------------------------------------------- */

function headerValue(headers: unknown, name: string): string | null {
  if (!Array.isArray(headers)) return null;
  const found = headers.find(
    (header) => typeof header === 'object' && header !== null
      && String((header as { name?: unknown }).name ?? '').toLowerCase() === name.toLowerCase(),
  );
  const value = found ? (found as { value?: unknown }).value : null;
  return typeof value === 'string' ? value : null;
}

export function normalizeGoogleResponse(
  tool: GoogleToolDefinition,
  payload: unknown,
): Record<string, unknown> {
  const data = (payload ?? {}) as Record<string, unknown>;
  switch (tool.name) {
    case 'vyora_gmail_search': {
      const messages = Array.isArray(data.messages) ? data.messages : [];
      return {
        count: messages.length,
        messages: messages.map((message) => {
          const record = (message ?? {}) as Record<string, unknown>;
          return { id: String(record.id ?? ''), thread_id: String(record.threadId ?? '') };
        }),
        // `estimated_total` évite de laisser croire que `count` est un total.
        estimated_total: typeof data.resultSizeEstimate === 'number' ? data.resultSizeEstimate : null,
      };
    }
    case 'vyora_gmail_read': {
      const headers = data.payload ? (data.payload as { headers?: unknown }).headers : undefined;
      return {
        id: String(data.id ?? ''),
        thread_id: String(data.threadId ?? ''),
        from: headerValue(headers, 'From'),
        to: headerValue(headers, 'To'),
        subject: headerValue(headers, 'Subject'),
        date: headerValue(headers, 'Date'),
        snippet: typeof data.snippet === 'string' ? data.snippet.slice(0, 2000) : null,
        labels: Array.isArray(data.labelIds) ? data.labelIds : [],
      };
    }
    case 'vyora_gmail_draft': {
      const message = (data.message ?? {}) as Record<string, unknown>;
      return {
        draft_created: true,
        draft_id: String(data.id ?? ''),
        message_id: String(message.id ?? ''),
        // Rappel explicite : un brouillon n'est pas un envoi.
        sent: false,
      };
    }
    case 'vyora_gmail_send': {
      return {
        sent: true,
        message_id: String(data.id ?? ''),
        thread_id: String(data.threadId ?? ''),
        labels: Array.isArray(data.labelIds) ? data.labelIds : [],
      };
    }
    case 'vyora_drive_list': {
      const files = Array.isArray(data.files) ? data.files : [];
      return {
        count: files.length,
        files: files.map((file) => {
          const record = (file ?? {}) as Record<string, unknown>;
          return {
            id: String(record.id ?? ''),
            name: String(record.name ?? ''),
            mime_type: String(record.mimeType ?? ''),
            modified_at: typeof record.modifiedTime === 'string' ? record.modifiedTime : null,
            size_bytes: typeof record.size === 'string' ? Number(record.size) : null,
            link: typeof record.webViewLink === 'string' ? record.webViewLink : null,
          };
        }),
      };
    }
    case 'vyora_calendar_list': {
      const items = Array.isArray(data.items) ? data.items : [];
      return {
        count: items.length,
        events: items.map((event) => {
          const record = (event ?? {}) as Record<string, unknown>;
          const start = (record.start ?? {}) as Record<string, unknown>;
          const end = (record.end ?? {}) as Record<string, unknown>;
          const attendees = Array.isArray(record.attendees) ? record.attendees : [];
          return {
            title: String(record.summary ?? 'Sans titre'),
            // Un événement a soit une date/heure, soit une date seule.
            start: typeof start.dateTime === 'string' ? start.dateTime : (start.date ?? null),
            end: typeof end.dateTime === 'string' ? end.dateTime : (end.date ?? null),
            attendees: attendees
              .map((attendee) => (attendee as { email?: unknown }).email)
              .filter((email): email is string => typeof email === 'string'),
            link: typeof record.htmlLink === 'string' ? record.htmlLink : null,
            status: typeof record.status === 'string' ? record.status : null,
          };
        }),
      };
    }
    default:
      throw new Error('outil inconnu');
  }
}

/* -------------------------------------------------------------------------- */
/* Exécution                                                                  */
/* -------------------------------------------------------------------------- */

export class GoogleToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string = code) {
    super(message);
    this.name = 'GoogleToolError';
    this.code = code;
  }
}

export interface GoogleToolContext {
  /** Capacités réellement accordées au compte, lues en base. */
  readonly grantedCapabilities: readonly string[];
  readonly provider: GoogleProvider;
  /** Jeton d'accès DÉCHIFFRÉ. Ne doit jamais être journalisé ni renvoyé. */
  readonly accessToken: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Valide les arguments, vérifie la capacité, appelle Google, normalise.
 *
 * L'ordre importe : la capacité est contrôlée AVANT la construction de la
 * requête. Un jeton `read` ne déclenche donc jamais ne serait-ce qu'une
 * intention d'envoi.
 */
export async function executeGoogleTool(
  name: GoogleToolName,
  rawArgs: unknown,
  context: GoogleToolContext,
): Promise<Record<string, unknown>> {
  const tool = googleToolByName(name);
  if (!tool) throw new GoogleToolError('tool_unknown', `Outil inconnu : ${name}`);
  if (tool.provider !== context.provider) {
    throw new GoogleToolError('provider_mismatch', 'Ce compte ne correspond pas à cet outil.');
  }

  // Barrière de capacité : lève CapabilityDeniedError si absente.
  try {
    assertCapability(context.grantedCapabilities, tool.capability, context.provider);
  } catch {
    throw new GoogleToolError(
      'capability_not_granted',
      `Cette action demande la permission « ${tool.capability} », que ce compte n’a pas accordée.`,
    );
  }

  const args = validateGoogleArgs(tool, rawArgs);
  const request = buildGoogleRequest(tool, args);
  const doFetch = context.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(request.url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${context.accessToken}`,
        ...(request.contentType ? { 'Content-Type': request.contentType } : {}),
      },
      ...(request.body ? { body: request.body } : {}),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // Message générique : on ne remonte jamais l'URL complète, qui contient
    // l'identifiant du message ou la requête de recherche de l'utilisateur.
    throw new GoogleToolError('google_unreachable', 'Le service Google est injoignable.');
  }

  if (response.status === 401) {
    throw new GoogleToolError('google_unauthorized', 'L’autorisation Google n’est plus valide.');
  }
  if (response.status === 403) {
    throw new GoogleToolError('google_forbidden', 'Google a refusé cette action pour ce compte.');
  }
  if (response.status === 429) {
    throw new GoogleToolError('google_rate_limited', 'Trop de requêtes vers Google. Réessayez dans un instant.');
  }
  if (!response.ok) {
    throw new GoogleToolError('google_error', `Google a répondu ${response.status}.`);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    throw new GoogleToolError('google_invalid_response', 'Réponse Google illisible.');
  }
  return normalizeGoogleResponse(tool, payload);
}

const INTEGER_KEYS = new Set(['limit', 'days_ahead']);

/**
 * Validation des arguments — même philosophie que `validateToolArguments` du
 * serveur MCP : un argument inconnu est REJETÉ, jamais ignoré. Un client ne
 * peut donc pas espérer faire passer `account_id` ou `user_id` par ce chemin.
 */
export function validateGoogleArgs(
  tool: GoogleToolDefinition,
  raw: unknown,
): Record<string, unknown> {
  const input = raw === undefined || raw === null ? {} : raw;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new GoogleToolError('invalid_arguments', 'Les arguments doivent être un objet JSON.');
  }
  const record = input as Record<string, unknown>;
  const schema = tool.inputSchema as {
    properties?: Record<string, { type?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
  const properties = schema.properties ?? {};

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!(key in properties)) {
        throw new GoogleToolError('unknown_argument', `Argument non supporté : ${key}`);
      }
    }
  }
  for (const key of schema.required ?? []) {
    const value = record[key];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      throw new GoogleToolError('missing_argument', `Argument requis manquant : ${key}`);
    }
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    const spec = properties[key];
    if (!spec) continue;
    if (spec.type === 'string') {
      if (typeof value !== 'string') throw new GoogleToolError('invalid_argument', `${key} doit être une chaîne.`);
      const trimmed = value.trim();
      if (spec.minLength !== undefined && trimmed.length < spec.minLength) {
        throw new GoogleToolError('invalid_argument', `${key} est trop court.`);
      }
      if (spec.maxLength !== undefined && trimmed.length > spec.maxLength) {
        throw new GoogleToolError('invalid_argument', `${key} est trop long.`);
      }
      normalized[key] = trimmed;
    } else if (spec.type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new GoogleToolError('invalid_argument', `${key} doit être un entier.`);
      }
      if (spec.minimum !== undefined && value < spec.minimum) {
        throw new GoogleToolError('invalid_argument', `${key} est inférieur au minimum.`);
      }
      if (spec.maximum !== undefined && value > spec.maximum) {
        throw new GoogleToolError('invalid_argument', `${key} est supérieur au maximum.`);
      }
      normalized[key] = value;
    }
  }
  void INTEGER_KEYS;

  // Une adresse e-mail est revérifiée ici : la validation de schéma ne sait pas
  // reconnaître une tentative d'injection d'en-tête.
  if (typeof normalized.to === 'string' && !isValidEmail(normalized.to)) {
    throw new GoogleToolError('invalid_argument', 'L’adresse du destinataire est invalide.');
  }
  return normalized;
}

/** Charge utile `tools/list` pour ces outils, au format MCP attendu. */
export function googleToolsListPayload(): {
  tools: Array<{
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  }>;
} {
  return {
    tools: GOOGLE_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        readOnlyHint: tool.readOnly,
        // Envoyer est destructif au sens MCP : l'action est irréversible.
        destructiveHint: tool.name === 'vyora_gmail_send',
        idempotentHint: tool.readOnly,
        // Ces outils parlent à un service externe : openWorld = true.
        openWorldHint: true,
      },
    })),
  };
}
