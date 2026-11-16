// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Panneau de fichiers : ce qui doit être vrai à l'écran.
 *
 * Les points vérifiés sont ceux qui, s'ils étaient faux, donneraient
 * l'illusion d'un système qui marche :
 *   - un fichier refusé à la validation ne crée AUCUNE ligne ;
 *   - un envoi échoué reste visible avec son motif, il ne disparaît pas ;
 *   - un format non prévisualisable le dit, au lieu d'afficher un cadre vide ;
 *   - le bouton supprimer est inactif pour un fichier dont on n'a pas les droits.
 */

const { list, upload, validate, remove, signedUrl, attachToProject } = vi.hoisted(() => ({
  list: vi.fn(),
  upload: vi.fn(),
  validate: vi.fn(),
  remove: vi.fn(),
  signedUrl: vi.fn(),
  attachToProject: vi.fn(),
}));

vi.mock('../src/files/api', () => ({
  list, upload, validate, remove, signedUrl, attachToProject,
}));

import { FilesPanel } from '../src/files/FilesPanel';

const WORKSPACE = '11111111-2222-3333-4444-555555555555';
const MOI = '99999999-8888-7777-6666-555555555555';

function fichier(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    workspace_id: WORKSPACE,
    owner_id: MOI,
    project_id: null,
    conversation_id: null,
    original_name: 'photo.png',
    storage_path: `${WORKSPACE}/files/images/a.png`,
    mime_type: 'image/png',
    extension: 'png',
    size_bytes: 2048,
    kind: 'image',
    reference_role: null,
    preview_kind: 'image',
    checksum_sha256: null,
    created_at: '2026-11-16T10:00:00Z',
    updated_at: '2026-11-16T10:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([]);
  validate.mockResolvedValue({ file: new File([], 'x'), detected: { kind: 'image' }, sizeBytes: 1 });
  upload.mockResolvedValue(fichier());
  signedUrl.mockResolvedValue('https://exemple/sign/token');
});

afterEach(() => cleanup());

describe('panneau de fichiers', () => {
  it('affiche un état vide honnête quand il n’y a aucun fichier', async () => {
    render(<FilesPanel workspaceId={WORKSPACE} currentUserId={MOI} />);
    expect(await screen.findByText(/Aucun fichier pour l’instant/i)).toBeTruthy();
  });

  it('liste les fichiers avec leurs métadonnées réelles', async () => {
    list.mockResolvedValue([fichier()]);
    render(<FilesPanel workspaceId={WORKSPACE} currentUserId={MOI} />);
    expect(await screen.findByText('photo.png')).toBeTruthy();
    expect(screen.getByText(/image\/png · 2\.0 Ko/)).toBeTruthy();
  });

  it('n’ajoute AUCUNE ligne quand le fichier est refusé', async () => {
    validate.mockRejectedValueOnce(new Error('« virus.exe » refusé. Format non autorisé.'));
    render(<FilesPanel workspaceId={WORKSPACE} currentUserId={MOI} />);
    await screen.findByText(/Aucun fichier/i);

    const input = screen.getByTestId('files-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'virus.exe')] } });

    expect(await screen.findByText(/refusé/i)).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it('garde l’échec d’envoi visible avec son motif', async () => {
    upload.mockRejectedValueOnce(new Error('Le stockage a refusé le fichier (413).'));
    render(<FilesPanel workspaceId={WORKSPACE} currentUserId={MOI} />);
    await screen.findByText(/Aucun fichier/i);

    fireEvent.change(screen.getByTestId('files-input'), {
      target: { files: [new File(['x'], 'grand.png')] },
    });

    expect(await screen.findByText(/413/)).toBeTruthy();
    expect(screen.queryByText('1 fichier(s)')).toBeNull();
  });

  it('dit qu’un DOCX n’a pas d’aperçu au lieu d’un cadre vide', async () => {
    list.mockResolvedValue([fichier({
      id: 'doc1', original_name: 'contrat.docx', kind: 'document',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', preview_kind: null,
    })]);
    render(<FilesPanel workspaceId={WORKSPACE} currentUserId={MOI} />);
    await screen.findByText('contrat.docx');

    fireEvent.click(screen.getByText('contrat.docx'));
    expect(await screen.findByText(/ne peut pas être prévisualisé/i)).toBeTruthy();
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it('désactive la suppression pour le fichier d’un autre membre sans droit admin', async () => {
    list.mockResolvedValue([fichier({ owner_id: 'autre-utilisateur' })]);
    render(<FilesPanel workspaceId={WORKSPACE} currentUserId={MOI} canDeleteOthers={false} />);
    await screen.findByText('photo.png');

    const bouton = screen.getByLabelText(/Supprimer photo\.png/i) as HTMLButtonElement;
    expect(bouton.disabled).toBe(true);
  });

  it('autorise la suppression de son propre fichier', async () => {
    list.mockResolvedValue([fichier()]);
    remove.mockResolvedValue(undefined);
    render(<FilesPanel workspaceId={WORKSPACE} currentUserId={MOI} />);
    await screen.findByText('photo.png');

    fireEvent.click(screen.getByLabelText(/Supprimer photo\.png/i));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('photo.png')).toBeNull());
  });

  it('ne retire pas la ligne quand la suppression est refusée', async () => {
    list.mockResolvedValue([fichier()]);
    remove.mockRejectedValueOnce(new Error('Suppression refusée : vous n’avez pas les droits sur ce fichier.'));
    render(<FilesPanel workspaceId={WORKSPACE} currentUserId={MOI} />);
    await screen.findByText('photo.png');

    fireEvent.click(screen.getByLabelText(/Supprimer photo\.png/i));
    expect(await screen.findByText(/Suppression refusée/i)).toBeTruthy();
    expect(screen.getByText('photo.png')).toBeTruthy();
  });

  it('affiche l’aperçu d’image via une URL SIGNÉE, jamais un lien public', async () => {
    list.mockResolvedValue([fichier()]);
    render(<FilesPanel workspaceId={WORKSPACE} currentUserId={MOI} />);
    await screen.findByText('photo.png');

    fireEvent.click(screen.getByText('photo.png'));
    await waitFor(() => expect(signedUrl).toHaveBeenCalled());
    const image = await screen.findByRole('img', { name: 'photo.png' });
    expect(image.getAttribute('src')).toBe('https://exemple/sign/token');
  });

  it('affiche une erreur de liste avec une action de reprise', async () => {
    list.mockRejectedValueOnce(new Error('Lecture des fichiers impossible : réseau.'));
    render(<FilesPanel workspaceId={WORKSPACE} currentUserId={MOI} />);
    expect(await screen.findByText(/Lecture des fichiers impossible/i)).toBeTruthy();
    expect(screen.getByText('Réessayer')).toBeTruthy();
  });
});
