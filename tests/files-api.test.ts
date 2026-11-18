import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Téléversement et enregistrement des fichiers.
 *
 * On simule le transport (XMLHttpRequest) et les RPC, pour vérifier les
 * décisions qui ne peuvent pas être vues à l'œil nu :
 *   - un fichier refusé ne part JAMAIS sur le réseau ;
 *   - un binaire envoyé sans métadonnée valide est nettoyé (pas d'orphelin) ;
 *   - un fichier validé part sous `${workspace_id}/`, avec le bon type MIME
 *     (celui des octets, pas celui déclaré) ;
 *   - une suppression refusée par la RLS ne touche pas au binaire.
 */

const { rpc, from, storageRemove, createSignedUrl, getSession } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  storageRemove: vi.fn(),
  createSignedUrl: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({
  STORAGE_BUCKET: 'ugc-assets',
  SUPABASE_URL: 'https://exemple.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'cle-publique',
  supabase: {
    rpc,
    from,
    auth: { getSession },
    storage: {
      from: () => ({ remove: storageRemove, createSignedUrl }),
    },
  },
}));

/** Fabrique un faux XMLHttpRequest contrôlable. */
class FakeXhr {
  static instances: FakeXhr[] = [];
  static nextStatus = 200;
  static nextBody = '';
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = '';
  headers: Record<string, string> = {};
  url = '';
  sent: Blob | null = null;
  aborted = false;

  constructor() { FakeXhr.instances.push(this); }
  open(_method: string, url: string) { this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; }
  addEventListener() { /* abort géré par appel direct */ }
  abort() { this.aborted = true; this.onabort?.(); }
  send(body: Blob) {
    this.sent = body;
    // Progression réelle : 40 puis 100 % de l'octet total.
    this.upload.onprogress?.({ lengthComputable: true, loaded: 40, total: 100 });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    this.status = FakeXhr.nextStatus;
    this.responseText = FakeXhr.nextBody;
    if (FakeXhr.nextStatus === 0) { this.onerror?.(); return; }
    this.onload?.();
  }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

function pngFile(name = 'photo.png'): File {
  return new File([PNG_BYTES], name, { type: 'image/png' });
}

const WORKSPACE = '11111111-2222-3333-4444-555555555555';

let files: typeof import('../src/files/api');

beforeEach(async () => {
  vi.clearAllMocks();
  FakeXhr.instances = [];
  FakeXhr.nextStatus = 200;
  FakeXhr.nextBody = '';
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  getSession.mockResolvedValue({ data: { session: { access_token: 'jeton' } } });
  storageRemove.mockResolvedValue({ error: null });
  files = await import('../src/files/api');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validation avant envoi', () => {
  it('refuse un fichier vide sans rien envoyer', async () => {
    const vide = new File([], 'vide.png', { type: 'image/png' });
    await expect(files.validate(vide)).rejects.toThrow(/vide/i);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('classe un faux PNG selon son CONTENU réel, pas selon son nom', async () => {
    // Un fichier nommé .png qui contient du texte est un fichier TEXTE.
    // Il n'est pas « refusé » : il est correctement typé, et surtout il n'est
    // jamais traité comme une image (aucun aperçu image, mimeType text/plain).
    const faux = new File([new TextEncoder().encode('%PDF-1.7 contenu')], 'photo.png', { type: 'image/png' });
    const result = await files.validate(faux);
    expect(result.detected.mimeType).not.toBe('image/png');
    expect(result.detected.kind).not.toBe('image');
  });

  it('refuse un EXÉCUTABLE renommé en image', async () => {
    const exe = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0])], 'photo.png', { type: 'image/png' });
    await expect(files.validate(exe)).rejects.toThrow(/refusé/i);
  });

  it('refuse un fichier trop gros avant lecture', async () => {
    const gros = new File([PNG_BYTES], 'gros.png', { type: 'image/png' });
    Object.defineProperty(gros, 'size', { value: 60 * 1024 * 1024 });
    await expect(files.validate(gros)).rejects.toThrow(/dépasse/i);
  });

  it('accepte un vrai PNG et rapporte le type détecté', async () => {
    const result = await files.validate(pngFile());
    expect(result.detected).toMatchObject({ mimeType: 'image/png', kind: 'image', accepted: true });
  });
});

describe('téléversement', () => {
  it('envoie sous le préfixe de l’entreprise, avec le type détecté', async () => {
    const validated = await files.validate(pngFile());
    const registre = { id: 'f1', storage_path: 'x' };
    rpc.mockResolvedValue({ data: registre, error: null });

    const created = await files.upload(WORKSPACE, validated);

    const xhr = FakeXhr.instances[0];
    expect(xhr.url).toContain('/storage/v1/object/ugc-assets/');
    expect(decodeURI(xhr.url)).toContain(`${WORKSPACE}/files/images/`);
    expect(xhr.headers['content-type']).toBe('image/png');
    expect(xhr.headers['x-upsert']).toBe('false');
    expect(xhr.headers.authorization).toBe('Bearer jeton');
    expect(created).toBe(registre);
  });

  it('rapporte une progression réelle', async () => {
    const validated = await files.validate(pngFile());
    rpc.mockResolvedValue({ data: {}, error: null });
    const seen: number[] = [];
    await files.upload(WORKSPACE, validated, { onProgress: (p) => seen.push(p) });
    expect(seen).toContain(40);
    expect(seen.at(-1)).toBe(100);
  });

  it('transmet le rôle de référence Studio et le projet', async () => {
    const validated = await files.validate(pngFile());
    rpc.mockResolvedValue({ data: {}, error: null });
    await files.upload(WORKSPACE, validated, { referenceRole: 'character', projectId: 'projet-1' });

    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(rpc.mock.calls[0][0]).toBe('vyora_file_register');
    expect(args.p_reference_role).toBe('character');
    expect(args.p_project_id).toBe('projet-1');
    expect(args.p_workspace_id).toBe(WORKSPACE);
    // Le chemin déclaré à la base est exactement celui où le binaire est parti.
    expect(String(args.p_storage_path)).toBe(decodeURI(FakeXhr.instances[0].url).split('/object/ugc-assets/')[1]);
  });

  it('nettoie le binaire si la métadonnée est refusée (pas d’orphelin)', async () => {
    const validated = await files.validate(pngFile());
    rpc.mockResolvedValue({ data: null, error: { message: 'objet absent du stockage : envoi incomplet' } });

    await expect(files.upload(WORKSPACE, validated)).rejects.toThrow(/n’a pas abouti|n'a pas abouti/);
    expect(storageRemove).toHaveBeenCalledTimes(1);
    expect(String(storageRemove.mock.calls[0][0][0])).toContain(`${WORKSPACE}/files/images/`);
  });

  it('traduit un refus de taille du stockage', async () => {
    const validated = await files.validate(pngFile());
    FakeXhr.nextStatus = 413;
    await expect(files.upload(WORKSPACE, validated)).rejects.toThrow(/50 Mo/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('traduit un refus de type du stockage', async () => {
    const validated = await files.validate(pngFile());
    FakeXhr.nextStatus = 415;
    await expect(files.upload(WORKSPACE, validated)).rejects.toThrow(/type de fichier/i);
  });

  it('refuse d’envoyer sans session', async () => {
    const validated = await files.validate(pngFile());
    getSession.mockResolvedValue({ data: { session: null } });
    await expect(files.upload(WORKSPACE, validated)).rejects.toThrow(/Session expirée/i);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('signale une coupure réseau sans inventer un succès', async () => {
    const validated = await files.validate(pngFile());
    FakeXhr.nextStatus = 0;
    await expect(files.upload(WORKSPACE, validated)).rejects.toThrow(/réseau/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('aperçu, suppression et droits', () => {
  it('ne délivre qu’une URL signée temporaire, jamais un lien public', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://exemple.supabase.co/storage/v1/object/sign/ugc-assets/x?token=t' }, error: null });
    const url = await files.signedUrl({ storage_path: 'w/fichier.png' } as never, 120);
    expect(url).toContain('/object/sign/');
    expect(createSignedUrl).toHaveBeenCalledWith('w/fichier.png', 120);
  });

  it('signale l’échec de signature au lieu d’afficher un aperçu vide', async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'expiré' } });
    await expect(files.signedUrl({ storage_path: 'w/x.png' } as never)).rejects.toThrow(/Prévisualisation impossible/i);
  });

  it('supprime la métadonnée PUIS le binaire', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: 'f1' }], error: null }),
    };
    from.mockReturnValue(chain);

    await files.remove({ id: 'f1', storage_path: 'w/x.png' } as never);
    expect(storageRemove).toHaveBeenCalledWith(['w/x.png']);
  });

  it('n’efface PAS le binaire quand la RLS refuse la suppression', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    from.mockReturnValue(chain);

    await expect(files.remove({ id: 'f1', storage_path: 'w/x.png' } as never)).rejects.toThrow(/refusée/i);
    expect(storageRemove).not.toHaveBeenCalled();
  });

  it('signale une suppression partielle (métadonnée partie, binaire restant)', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: 'f1' }], error: null }),
    };
    from.mockReturnValue(chain);
    storageRemove.mockResolvedValue({ error: { message: 'refusé' } });

    await expect(files.remove({ id: 'f1', storage_path: 'w/x.png' } as never)).rejects.toThrow(/pas pu être effacé/i);
  });
});

describe('rattachements contrôlés', () => {
  it('refuse un projet d’une autre entreprise avec un message clair', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'projet inconnu pour cette entreprise' } });
    await expect(files.attachToProject('f1', 'p1')).rejects.toThrow(/n’appartient pas à cette entreprise/i);
  });

  it('refuse une conversation d’une autre entreprise', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'conversation rattachee a une autre entreprise' } });
    await expect(files.attachToConversation('f1', 'c1')).rejects.toThrow(/autre entreprise/i);
  });
});
