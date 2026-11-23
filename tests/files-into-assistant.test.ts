// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Pont fichiers → assistant.
 *
 * L'enjeu : le modèle ne doit jamais laisser croire qu'il a lu un contenu qu'il
 * n'a pas reçu. Ces tests vérifient que la capacité annoncée correspond au
 * format réel, et que la note est transmise au modèle.
 */

const { validate, upload } = vi.hoisted(() => ({ validate: vi.fn(), upload: vi.fn() }));

vi.mock('../src/files/api', () => ({ validate, upload }));

import { prepareAttachment, readCapability, summarizeCapabilities } from '../src/files/intoAssistant';
import { composeMessageBody } from '../src/ai/api';

const WORKSPACE = '11111111-2222-3333-4444-555555555555';

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    workspace_id: WORKSPACE,
    owner_id: 'moi',
    project_id: null,
    conversation_id: null,
    original_name: 'fichier.txt',
    storage_path: `${WORKSPACE}/files/documents/f1.txt`,
    mime_type: 'text/plain',
    extension: 'txt',
    size_bytes: 20,
    kind: 'document',
    reference_role: null,
    preview_kind: 'text',
    checksum_sha256: null,
    created_at: '2026-11-16T10:00:00Z',
    updated_at: '2026-11-16T10:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  validate.mockResolvedValue({ file: new File([], 'x'), detected: {}, sizeBytes: 20 });
  upload.mockResolvedValue(stored());
});

describe('capacité de lecture annoncée', () => {
  it('transmet le contenu d’un fichier texte', () => {
    expect(readCapability('document', 'text')).toMatchObject({ transmitted: true });
  });

  it('ne prétend pas lire une vidéo', () => {
    const cap = readCapability('video', 'video');
    expect(cap.transmitted).toBe(false);
    expect(cap.note).toMatch(/aucun modèle de texte ne peut la lire/i);
  });

  it('transmet une image au modèle vision', () => {
    const cap = readCapability('image', 'image');
    expect(cap.transmitted).toBe(true);
    expect(cap.note).toMatch(/modèle vision/i);
  });

  it('annonce l’absence d’extraction pour PDF/DOCX/XLSX', () => {
    expect(readCapability('document', null).note).toMatch(/PDF, DOCX et XLSX/i);
    expect(readCapability('spreadsheet', null).transmitted).toBe(false);
  });

  it('annonce l’absence de transcription audio', () => {
    expect(readCapability('audio', null).note).toMatch(/pas transcrit/i);
  });

  it('a toujours une explication, quel que soit le genre', () => {
    for (const kind of ['image', 'video', 'document', 'spreadsheet', 'audio', 'other'] as const) {
      expect(readCapability(kind, null).note.length).toBeGreaterThan(10);
    }
  });
});

describe('préparation d’une pièce jointe', () => {
  it('téléverse AVANT de constituer la pièce jointe (pas de fausse pièce jointe)', async () => {
    const ordre: string[] = [];
    validate.mockImplementation(async () => { ordre.push('validate'); return { file: new File([], 'x'), detected: {}, sizeBytes: 20 }; });
    upload.mockImplementation(async () => { ordre.push('upload'); return stored(); });

    const fichier = new File(['bonjour le monde'], 'notes.txt', { type: 'text/plain' });
    const prepared = await prepareAttachment(WORKSPACE, fichier);

    expect(ordre).toEqual(['validate', 'upload']);
    expect(prepared.attachment.storagePath).toBe(`${WORKSPACE}/files/documents/f1.txt`);
    expect(prepared.attachment.fileId).toBe('f1');
  });

  it('transmet l’extrait d’un fichier texte', async () => {
    const fichier = new File(['ligne une\nligne deux'], 'notes.txt', { type: 'text/plain' });
    const prepared = await prepareAttachment(WORKSPACE, fichier);
    expect(prepared.attachment.excerpt).toContain('ligne une');
    expect(prepared.capability.transmitted).toBe(true);
  });

  it('ne transmet aucun extrait pour une vidéo, mais l’annonce', async () => {
    upload.mockResolvedValue(stored({
      original_name: 'demo.mp4', kind: 'video', preview_kind: 'video', mime_type: 'video/mp4',
      storage_path: `${WORKSPACE}/files/videos/f1.mp4`,
    }));
    const fichier = new File([new Uint8Array([0, 0, 0, 0x18])], 'demo.mp4', { type: 'video/mp4' });
    const prepared = await prepareAttachment(WORKSPACE, fichier);

    expect(prepared.attachment.excerpt).toBeUndefined();
    expect(prepared.capability.transmitted).toBe(false);
    expect(prepared.attachment.note).toMatch(/aucun modèle/i);
  });

  it('joint la note au message transmis au modèle', async () => {
    upload.mockResolvedValue(stored({
      original_name: 'demo.mp4', kind: 'video', preview_kind: 'video', mime_type: 'video/mp4',
      storage_path: `${WORKSPACE}/files/videos/f1.mp4`,
    }));
    const prepared = await prepareAttachment(WORKSPACE, new File(['x'], 'demo.mp4', { type: 'video/mp4' }));
    const body = composeMessageBody('Que penses-tu ?', 'standard', [prepared.attachment]);

    expect(body).toContain('demo.mp4');
    expect(body).toContain('ne prétends pas avoir lu');
  });

  it('ne fabrique pas de pièce jointe si l’envoi échoue', async () => {
    upload.mockRejectedValueOnce(new Error('Le stockage a refusé le fichier (413).'));
    await expect(prepareAttachment(WORKSPACE, new File(['x'], 'a.txt', { type: 'text/plain' })))
      .rejects.toThrow(/413/);
  });

  it('transmet la conversation pour rattacher le fichier', async () => {
    await prepareAttachment(WORKSPACE, new File(['x'], 'a.txt', { type: 'text/plain' }), { conversationId: 'conv-1' });
    expect(upload.mock.calls[0][2]).toMatchObject({ conversationId: 'conv-1' });
  });

  it('résume ce qui n’a pas été lu, pour l’utilisateur', () => {
    const resume = summarizeCapabilities([
      { attachment: { name: 'a.txt', storagePath: 'x', sizeBytes: 1, mimeType: 'text/plain' }, stored: stored() as never, capability: { transmitted: true, note: 'ok' } },
      { attachment: { name: 'b.mp4', storagePath: 'y', sizeBytes: 2, mimeType: 'video/mp4' }, stored: stored({ original_name: 'b.mp4' }) as never, capability: { transmitted: false, note: 'non lu' } },
    ]);
    expect(resume).toContain('b.mp4');
    expect(resume).not.toContain('a.txt');
  });
});
