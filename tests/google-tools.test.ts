// VYORA — outils Google exposables en MCP.
//
// Le point critique de ces tests : la capacité est vérifiée AVANT tout appel
// réseau. Un compte autorisé en lecture seule ne doit pas provoquer ne
// serait-ce qu'une requête vers Gmail pour envoyer un message.
import { describe, expect, it } from 'vitest';
import {
  GOOGLE_TOOLS,
  GoogleToolError,
  buildGoogleRequest,
  encodeGmailMessage,
  executeGoogleTool,
  googleToolByName,
  googleToolsListPayload,
  isValidEmail,
  normalizeGoogleResponse,
  validateGoogleArgs,
} from '../supabase/functions/vyora-oauth/google-tools.ts';

const gmailSearch = googleToolByName('vyora_gmail_search')!;
const gmailRead = googleToolByName('vyora_gmail_read')!;
const gmailDraft = googleToolByName('vyora_gmail_draft')!;
const gmailSend = googleToolByName('vyora_gmail_send')!;
const driveList = googleToolByName('vyora_drive_list')!;
const calendarList = googleToolByName('vyora_calendar_list')!;

function fakeFetch(spec: { status?: number; body?: unknown; throws?: boolean }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    if (spec.throws) throw new Error('réseau');
    calls.push({ url: String(url), init });
    return {
      ok: (spec.status ?? 200) < 400,
      status: spec.status ?? 200,
      json: async () => spec.body ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('registre des outils Google', () => {
  it('expose six outils nommés vyora_*', () => {
    expect(GOOGLE_TOOLS.map((tool) => tool.name)).toEqual([
      'vyora_gmail_search', 'vyora_gmail_read', 'vyora_gmail_draft',
      'vyora_gmail_send', 'vyora_drive_list', 'vyora_calendar_list',
    ]);
  });

  it('chaque outil déclare la capacité minimale nécessaire', () => {
    expect(gmailSearch.capability).toBe('read');
    expect(gmailRead.capability).toBe('read');
    expect(gmailDraft.capability).toBe('draft');
    expect(gmailSend.capability).toBe('send');
    expect(driveList.capability).toBe('read');
    expect(calendarList.capability).toBe('read');
  });

  it('seuls les outils de lecture sont marqués readOnly', () => {
    const readOnly = GOOGLE_TOOLS.filter((tool) => tool.readOnly).map((tool) => tool.name);
    expect(readOnly).toEqual(['vyora_gmail_search', 'vyora_gmail_read', 'vyora_drive_list', 'vyora_calendar_list']);
  });

  it('aucun schéma n’accepte d’identifiant de compte ou d’utilisateur', () => {
    for (const tool of GOOGLE_TOOLS) {
      const serialized = JSON.stringify(tool.inputSchema);
      expect(serialized, tool.name).not.toContain('user_id');
      expect(serialized, tool.name).not.toContain('account_id');
      expect(serialized, tool.name).not.toContain('access_token');
    }
  });

  it('produit une charge utile tools/list conforme à MCP', () => {
    const payload = googleToolsListPayload();
    expect(payload.tools).toHaveLength(6);
    for (const tool of payload.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations.openWorldHint).toBe(true);
    }
    // Envoyer est signalé comme destructif, jamais la simple lecture.
    const send = payload.tools.find((tool) => tool.name === 'vyora_gmail_send')!;
    expect(send.annotations.destructiveHint).toBe(true);
    expect(send.annotations.readOnlyHint).toBe(false);
    const search = payload.tools.find((tool) => tool.name === 'vyora_gmail_search')!;
    expect(search.annotations.destructiveHint).toBe(false);
    expect(search.annotations.readOnlyHint).toBe(true);
  });
});

describe('barrière de capacités — avant tout appel réseau', () => {
  it('refuse l’envoi pour un compte en lecture seule, SANS appeler Google', async () => {
    const { impl, calls } = fakeFetch({ body: {} });
    await expect(executeGoogleTool('vyora_gmail_send', {
      to: 'a@b.co', body: 'texte',
    }, { grantedCapabilities: ['read'], provider: 'gmail', accessToken: 'jeton', fetchImpl: impl }))
      .rejects.toThrow(/permission « send »/);
    // Le point central : aucune requête n'a quitté le serveur.
    expect(calls).toHaveLength(0);
  });

  it('refuse le brouillon pour un compte en lecture seule', async () => {
    const { impl, calls } = fakeFetch({ body: {} });
    await expect(executeGoogleTool('vyora_gmail_draft', {
      to: 'a@b.co', body: 'texte',
    }, { grantedCapabilities: ['read'], provider: 'gmail', accessToken: 'jeton', fetchImpl: impl }))
      .rejects.toThrow(/permission « draft »/);
    expect(calls).toHaveLength(0);
  });

  it('« rédiger » ne donne JAMAIS « envoyer »', async () => {
    const { impl, calls } = fakeFetch({ body: { id: 'm1', labelIds: ['DRAFT'] } });
    // Le brouillon passe…
    await executeGoogleTool('vyora_gmail_draft', { to: 'a@b.co', body: 'x' }, {
      grantedCapabilities: ['read', 'draft'], provider: 'gmail', accessToken: 'jeton', fetchImpl: impl,
    });
    expect(calls).toHaveLength(1);
    // …mais l'envoi reste refusé.
    await expect(executeGoogleTool('vyora_gmail_send', { to: 'a@b.co', body: 'x' }, {
      grantedCapabilities: ['read', 'draft'], provider: 'gmail', accessToken: 'jeton', fetchImpl: impl,
    })).rejects.toThrow(/permission « send »/);
    expect(calls).toHaveLength(1);
  });

  it('refuse un outil Gmail sur un compte Drive', async () => {
    const { impl, calls } = fakeFetch({ body: {} });
    await expect(executeGoogleTool('vyora_gmail_search', {}, {
      grantedCapabilities: ['read'], provider: 'google_drive', accessToken: 'jeton', fetchImpl: impl,
    })).rejects.toThrow(/ne correspond pas/);
    expect(calls).toHaveLength(0);
  });

  it('refuse un compte sans aucune capacité', async () => {
    const { impl, calls } = fakeFetch({ body: {} });
    await expect(executeGoogleTool('vyora_drive_list', {}, {
      grantedCapabilities: [], provider: 'google_drive', accessToken: 'jeton', fetchImpl: impl,
    })).rejects.toThrow(/permission « read »/);
    expect(calls).toHaveLength(0);
  });
});

describe('construction des requêtes', () => {
  it('la recherche Gmail ne demande QUE des métadonnées', () => {
    const request = buildGoogleRequest(gmailSearch, { query: 'from:a@b.co', limit: 5 });
    expect(request.method).toBe('GET');
    expect(request.url).toContain('maxResults=5');
    expect(request.url).toContain('q=from%3Aa%40b.co');
    // Le corps des messages n'est pas demandé : seuls id et threadId.
    const fields = new URL(request.url).searchParams.get('fields') ?? '';
    expect(fields).toContain('messages(id,threadId)');
    expect(fields).not.toContain('payload');
  });

  it('la lecture Gmail demande le format metadata, jamais full', () => {
    const request = buildGoogleRequest(gmailRead, { message_id: 'abc123' });
    expect(request.url).toContain('format=metadata');
    expect(request.url).not.toContain('format=full');
    expect(request.url).toContain('Subject');
  });

  it('la lecture échappe l’identifiant de message', () => {
    const request = buildGoogleRequest(gmailRead, { message_id: 'a/b?c' });
    expect(request.url).toContain('a%2Fb%3Fc');
  });

  it('la recherche Drive exclut les fichiers supprimés', () => {
    const request = buildGoogleRequest(driveList, { limit: 3 });
    const params = new URL(request.url).searchParams;
    expect(params.get('q')).toBe('trashed = false');
    expect(params.get('fields')).not.toContain('content');
  });

  it('la recherche Drive échappe l’apostrophe', () => {
    const request = buildGoogleRequest(driveList, { query: "l'ete" });
    const q = new URL(request.url).searchParams.get('q') ?? '';
    expect(q).toContain("\\'");
  });

  it('le calendrier borne la fenêtre de recherche', () => {
    const request = buildGoogleRequest(calendarList, { days_ahead: 7, limit: 5 });
    const params = new URL(request.url).searchParams;
    const min = new Date(params.get('timeMin')!).getTime();
    const max = new Date(params.get('timeMax')!).getTime();
    expect(Math.round((max - min) / 86_400_000)).toBe(7);
    expect(params.get('singleEvents')).toBe('true');
  });

  it('le brouillon et l’envoi visent des points d’entrée DIFFÉRENTS', () => {
    const draft = buildGoogleRequest(gmailDraft, { to: 'a@b.co', body: 'x' });
    const send = buildGoogleRequest(gmailSend, { to: 'a@b.co', body: 'x' });
    expect(draft.url).toContain('/drafts');
    expect(draft.url).not.toContain('/send');
    expect(send.url).toContain('/messages/send');
  });
});

describe('encodage des messages', () => {
  it('produit du base64url sans caractère réservé', () => {
    const raw = encodeGmailMessage({ to: 'a@b.co', subject: 'Test', body: 'Bonjour' });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    // Décodable, et contient bien les en-têtes attendus.
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: a@b.co');
    expect(decoded).toContain('Subject: Test');
    expect(decoded).toContain('Bonjour');
  });

  it('accepte un corps accentué', () => {
    const raw = encodeGmailMessage({ to: 'a@b.co', body: 'Félicitations, très bien' });
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toContain('Félicitations');
  });

  it('refuse un destinataire contenant un saut de ligne (injection d’en-tête)', () => {
    expect(isValidEmail('a@b.co\r\nBcc: victime@x.co')).toBe(false);
    expect(isValidEmail('a@b.co\nBcc: victime@x.co')).toBe(false);
  });

  it('accepte une adresse normale', () => {
    expect(isValidEmail('camille@exemple.com')).toBe(true);
  });

  it('rejette les adresses manifestement invalides', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('sans-arobase')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.co')).toBe(false);
  });
});

describe('validation des arguments', () => {
  it('rejette un argument inconnu au lieu de l’ignorer', () => {
    expect(() => validateGoogleArgs(gmailSearch, { query: 'x', user_id: 'autre' }))
      .toThrow(/Argument non supporté/);
  });

  it('exige les arguments déclarés requis', () => {
    expect(() => validateGoogleArgs(gmailRead, {})).toThrow(/message_id/);
    expect(() => validateGoogleArgs(gmailSend, { to: 'a@b.co' })).toThrow(/body/);
  });

  it('refuse un entier hors bornes', () => {
    expect(() => validateGoogleArgs(gmailSearch, { limit: 500 })).toThrow(/maximum/);
    expect(() => validateGoogleArgs(gmailSearch, { limit: 0 })).toThrow(/minimum/);
    expect(() => validateGoogleArgs(gmailSearch, { limit: 2.5 })).toThrow(/entier/);
  });

  it('refuse un destinataire invalide même si le schéma passe', () => {
    // Le schéma ne connaît pas le format e-mail : la validation métier le fait.
    expect(() => validateGoogleArgs(gmailSend, { to: 'pas-une-adresse', body: 'x' }))
      .toThrow(/destinataire est invalide/);
  });

  it('nettoie les espaces autour des chaînes', () => {
    const args = validateGoogleArgs(gmailSearch, { query: '  from:a@b.co  ' });
    expect(args.query).toBe('from:a@b.co');
  });

  it('refuse un tableau à la place d’un objet', () => {
    expect(() => validateGoogleArgs(gmailSearch, ['x'])).toThrow(/objet JSON/);
  });
});

describe('normalisation des réponses', () => {
  it('la recherche renvoie un compte et des identifiants, sans corps', () => {
    const result = normalizeGoogleResponse(gmailSearch, {
      messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't1' }],
      resultSizeEstimate: 42,
      // Un payload ne doit jamais ressortir même s'il était présent.
      payload: { body: { data: 'SECRET' } },
    });
    expect(result.count).toBe(2);
    expect(result.estimated_total).toBe(42);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('la lecture extrait les en-têtes utiles', () => {
    const result = normalizeGoogleResponse(gmailRead, {
      id: 'm1', threadId: 't1', snippet: 'Bonjour…',
      payload: { headers: [
        { name: 'From', value: 'client@exemple.com' },
        { name: 'Subject', value: 'Devis' },
        { name: 'To', value: 'moi@vyora.app' },
        { name: 'Date', value: 'Fri, 14 Nov 2026 10:00:00 +0000' },
      ] },
      labelIds: ['INBOX'],
    });
    expect(result.from).toBe('client@exemple.com');
    expect(result.subject).toBe('Devis');
    expect(result.to).toBe('moi@vyora.app');
    expect(result.labels).toEqual(['INBOX']);
  });

  it('la lecture tronque un extrait trop long', () => {
    const result = normalizeGoogleResponse(gmailRead, { id: 'm', snippet: 'a'.repeat(5000) });
    expect(String(result.snippet).length).toBe(2000);
  });

  it('un brouillon indique sent:false', () => {
    const result = normalizeGoogleResponse(gmailDraft, { id: 'd1', message: { id: 'm1' } });
    expect(result.draft_created).toBe(true);
    expect(result.sent).toBe(false);
  });

  it('un envoi indique sent:true', () => {
    const result = normalizeGoogleResponse(gmailSend, { id: 'm1', threadId: 't1' });
    expect(result.sent).toBe(true);
  });

  it('Drive renvoie des métadonnées typées', () => {
    const result = normalizeGoogleResponse(driveList, {
      files: [{ id: 'f1', name: 'Rapport.pdf', mimeType: 'application/pdf', modifiedTime: '2026-11-01T00:00:00Z', size: '1024', webViewLink: 'https://drive/x' }],
    });
    const files = result.files as Array<Record<string, unknown>>;
    expect(files[0].size_bytes).toBe(1024);
    expect(files[0].name).toBe('Rapport.pdf');
  });

  it('Calendar gère un événement à date seule', () => {
    const result = normalizeGoogleResponse(calendarList, {
      items: [{ summary: 'Férié', start: { date: '2026-12-25' }, end: { date: '2026-12-26' } }],
    });
    const events = result.events as Array<Record<string, unknown>>;
    expect(events[0].start).toBe('2026-12-25');
    expect(events[0].title).toBe('Férié');
  });

  it('Calendar ne garde que les adresses des participants', () => {
    const result = normalizeGoogleResponse(calendarList, {
      items: [{ summary: 'Réunion', start: { dateTime: '2026-11-20T10:00:00Z' }, attendees: [{ email: 'a@b.co' }, {}] }],
    });
    const events = result.events as Array<Record<string, unknown>>;
    expect(events[0].attendees).toEqual(['a@b.co']);
  });

  it('une réponse vide ne lève pas', () => {
    expect(normalizeGoogleResponse(gmailSearch, null).count).toBe(0);
    expect(normalizeGoogleResponse(driveList, {}).count).toBe(0);
    expect(normalizeGoogleResponse(calendarList, {}).count).toBe(0);
  });
});

describe('exécution complète contre un faux Google', () => {
  it('transmet le jeton en en-tête Authorization, jamais en URL', async () => {
    const { impl, calls } = fakeFetch({ body: { messages: [] } });
    await executeGoogleTool('vyora_gmail_search', {}, {
      grantedCapabilities: ['read'], provider: 'gmail', accessToken: 'ya29.jeton', fetchImpl: impl,
    });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ya29.jeton');
    expect(calls[0].url).not.toContain('ya29');
  });

  it('ne renvoie jamais le jeton dans le résultat', async () => {
    const { impl } = fakeFetch({ body: { messages: [{ id: 'm1' }] } });
    const result = await executeGoogleTool('vyora_gmail_search', {}, {
      grantedCapabilities: ['read'], provider: 'gmail', accessToken: 'ya29.jeton-secret', fetchImpl: impl,
    });
    expect(JSON.stringify(result)).not.toContain('ya29');
  });

  it('traduit un 401 en autorisation invalide', async () => {
    const { impl } = fakeFetch({ status: 401, body: {} });
    await expect(executeGoogleTool('vyora_gmail_search', {}, {
      grantedCapabilities: ['read'], provider: 'gmail', accessToken: 'x', fetchImpl: impl,
    })).rejects.toThrow(/n’est plus valide/);
  });

  it('traduit un 403 en refus Google', async () => {
    const { impl } = fakeFetch({ status: 403, body: {} });
    await expect(executeGoogleTool('vyora_drive_list', {}, {
      grantedCapabilities: ['read'], provider: 'google_drive', accessToken: 'x', fetchImpl: impl,
    })).rejects.toThrow(/refusé/);
  });

  it('traduit un 429 en limitation de débit', async () => {
    const { impl } = fakeFetch({ status: 429, body: {} });
    await expect(executeGoogleTool('vyora_calendar_list', {}, {
      grantedCapabilities: ['read'], provider: 'google_calendar', accessToken: 'x', fetchImpl: impl,
    })).rejects.toThrow(/Trop de requêtes/);
  });

  it('un réseau coupé donne un message générique, sans URL', async () => {
    const { impl } = fakeFetch({ throws: true });
    await expect(executeGoogleTool('vyora_gmail_read', { message_id: 'abc123' }, {
      grantedCapabilities: ['read'], provider: 'gmail', accessToken: 'x', fetchImpl: impl,
    })).rejects.toThrow(/injoignable/);
  });

  it('une réponse non JSON est signalée proprement', async () => {
    const impl = (async () => ({
      ok: true, status: 200, json: async () => { throw new Error('pas du json'); },
    })) as unknown as typeof fetch;
    await expect(executeGoogleTool('vyora_gmail_search', {}, {
      grantedCapabilities: ['read'], provider: 'gmail', accessToken: 'x', fetchImpl: impl,
    })).rejects.toThrow(/illisible/);
  });

  it('un outil inconnu est refusé', async () => {
    await expect(executeGoogleTool('vyora_tiktok_publish' as never, {}, {
      grantedCapabilities: ['read'], provider: 'gmail', accessToken: 'x',
    })).rejects.toThrow(GoogleToolError);
  });
});
