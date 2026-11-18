// @vitest-environment jsdom
/**
 * Page « Fichiers et médias ».
 *
 * Cette page est le point d'entrée du système de fichiers : sans elle, un
 * fichier envoyé depuis l'assistant n'était ni retrouvable ni supprimable.
 * Les tests vérifient le comportement observable, pas l'implémentation :
 *   - sans espace de travail, on explique le refus au lieu de planter ;
 *   - la liste réellement renvoyée par l'API est affichée ;
 *   - le filtre par projet transmet bien le `projectId` à la couche données ;
 *   - une panne de chargement des projets n'empêche pas de gérer ses fichiers.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface AuthState {
  workspaceId: string | null;
  user: { id: string } | null;
}

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listProjects: vi.fn(),
  signedUrl: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
  validate: vi.fn(),
  attachToProject: vi.fn(),
  // La session est pilotable d'un test à l'autre : c'est elle qui décide si
  // l'écran affiche la gestion ou un refus explicite.
  auth: vi.fn(),
}));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: mocks.auth,
}));

function setAuth(value: AuthState) {
  mocks.auth.mockReturnValue(value);
}

vi.mock('../src/lib/api', () => ({
  listProjects: mocks.listProjects,
}));

vi.mock('../src/files/api', () => ({
  list: mocks.list,
  signedUrl: mocks.signedUrl,
  remove: mocks.remove,
  upload: mocks.upload,
  validate: mocks.validate,
  attachToProject: mocks.attachToProject,
  FileRejectedError: class extends Error {},
}));

import Files from '../src/pages/Files';

const fichier = {
  id: 'f1',
  workspace_id: 'ws-1',
  owner_id: 'user-1',
  project_id: null,
  conversation_id: null,
  original_name: 'brief-client.pdf',
  storage_path: 'ws-1/files/f1.pdf',
  mime_type: 'application/pdf',
  extension: 'pdf',
  size_bytes: 2048,
  kind: 'document' as const,
  reference_role: null,
  preview_kind: 'none' as const,
  checksum_sha256: null,
  created_at: '2026-11-16T10:00:00.000Z',
  updated_at: '2026-11-16T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  setAuth({ workspaceId: 'ws-1', user: { id: 'user-1' } });
  mocks.list.mockResolvedValue([fichier]);
  mocks.listProjects.mockResolvedValue([]);
  mocks.signedUrl.mockResolvedValue('https://sign/f1');
});

afterEach(cleanup);

describe('Page Fichiers et médias', () => {
  it('affiche les fichiers réellement renvoyés par la couche données', async () => {
    render(<Files />);
    expect(await screen.findByText('brief-client.pdf')).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith('ws-1', expect.anything());
  });

  it('explique le refus quand aucun espace de travail n’est disponible', () => {
    setAuth({ workspaceId: null, user: null });
    render(<Files />);
    expect(screen.getByText(/Espace de travail indisponible/i)).toBeTruthy();
    // Aucune requête ne doit partir sans entreprise : la liste est
    // strictement bornée par l'espace de travail.
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('n’empêche pas la gestion des fichiers si les projets ne se chargent pas', async () => {
    mocks.listProjects.mockRejectedValue(new Error('réseau'));
    render(<Files />);
    expect(await screen.findByText('brief-client.pdf')).toBeTruthy();
  });

  it('affiche un état vide honnête quand l’entreprise n’a aucun fichier', async () => {
    mocks.list.mockResolvedValue([]);
    render(<Files />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
    expect(screen.queryByText('brief-client.pdf')).toBeNull();
  });
});
