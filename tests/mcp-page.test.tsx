// @vitest-environment jsdom
// VYORA MCP — tests de l'interface : aucun outil fantôme, aucun secret
// persistant, aucune intégration fictive présentée comme connectée.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listMcpTokens: vi.fn(),
  listMcpActivity: vi.fn(),
  createMcpToken: vi.fn(),
  revokeMcpToken: vi.fn(),
  rotateMcpToken: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../src/lib/mcp', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/mcp')>('../src/lib/mcp');
  return {
    ...actual,
    listMcpTokens: mocks.listMcpTokens,
    listMcpActivity: mocks.listMcpActivity,
    createMcpToken: mocks.createMcpToken,
    revokeMcpToken: mocks.revokeMcpToken,
    rotateMcpToken: mocks.rotateMcpToken,
  };
});

vi.mock('../src/context/ToastContext', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error, info: vi.fn(), push: vi.fn() }),
}));

import Mcp from '../src/pages/Mcp';
import { MCP_TOOLS, MCP_WRITE_TOOL, mcpClientConfig, mcpEndpoint } from '../src/lib/mcp';

const TOKEN_ACTIF = {
  id: 'dddddddd-0000-4000-8000-00000000000a',
  label: 'Portable bureau',
  token_prefix: 'vyora_mcp_abcd1234',
  scopes: ['read'] as ('read' | 'write')[],
  client_name: 'Claude Desktop',
  client_kind: 'claude' as const,
  created_at: '2026-11-15T10:00:00.000Z',
  last_used_at: '2026-11-16T09:30:00.000Z',
  use_count: 4,
  expires_at: null,
  revoked: false,
};

async function renderPage() {
  const view = render(
    <MemoryRouter>
      <Mcp />
    </MemoryRouter>,
  );
  // Signal de disponibilité : l'URL du serveur n'apparaît qu'après le chargement.
  await screen.findByText(mcpEndpoint());
  return view;
}

/** Ouvre un onglet de la page (les libellés sont uniques dans la barre). */
async function openTab(label: string) {
  fireEvent.click(screen.getByText(label));
}

beforeEach(() => {
  mocks.listMcpTokens.mockResolvedValue([TOKEN_ACTIF]);
  mocks.listMcpActivity.mockResolvedValue([
    {
      id: 1,
      method: 'tools/call',
      tool_name: 'vyora_projects_list',
      outcome: 'ok',
      error_code: null,
      duration_ms: 12,
      token_prefix: 'vyora_mcp_abcd1234',
      created_at: '2026-11-16T09:30:00.000Z',
    },
    {
      id: 2,
      method: 'tools/call',
      tool_name: 'vyora_project_create',
      outcome: 'invalid',
      error_code: 'unknown_tool',
      duration_ms: null,
      token_prefix: 'vyora_mcp_abcd1234',
      created_at: '2026-11-16T09:31:00.000Z',
    },
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('page VYORA MCP — vue d’ensemble', () => {
  it('affiche l’URL réelle du serveur déployé', async () => {
    await renderPage();
    expect(screen.getByText(mcpEndpoint())).toBeTruthy();
    expect(mcpEndpoint()).toContain('/functions/v1/vyora-mcp');
  });

  it('compte les jetons actifs à partir des données réelles', async () => {
    mocks.listMcpTokens.mockResolvedValue([TOKEN_ACTIF, { ...TOKEN_ACTIF, id: 'f-2', label: 'Vieux', revoked: true }]);
    await renderPage();
    // 1 actif sur 2 au total.
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText(/2 jetons au total/)).toBeTruthy();
  });

  it('n’annonce que les cinq outils de lecture effectivement exposés', async () => {
    await renderPage();
    for (const tool of MCP_TOOLS) {
      expect(screen.getByText(tool.name)).toBeTruthy();
    }
    // Aucun outil fantôme : l'outil d'écriture n'est pas dans la vue d'ensemble.
    expect(screen.queryAllByText(MCP_WRITE_TOOL.name)).toHaveLength(0);
  });
});

describe('page VYORA MCP — jetons', () => {
  it('liste les jetons avec leur préfixe public, jamais un secret complet', async () => {
    await renderPage();
    await openTab('Jetons');
    expect(screen.getByText('Portable bureau')).toBeTruthy();
    expect(screen.getByText('vyora_mcp_abcd1234…')).toBeTruthy();
  });

  it('refuse de créer un jeton sans nom et n’appelle pas la base', async () => {
    await renderPage();
    await openTab('Jetons');
    const bouton = await screen.findByText('Générer le jeton');
    fireEvent.click(bouton);
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.createMcpToken).not.toHaveBeenCalled();
  });

  it('affiche le secret une seule fois après création', async () => {
    mocks.createMcpToken.mockResolvedValue({
      token_id: 'eeeeeeee-0000-4000-8000-00000000000e',
      connection_id: 'cccccccc-0000-4000-8000-00000000000a',
      secret: 'vyora_mcp_secret_visible_une_fois',
      token_prefix: 'vyora_mcp_secret_v',
      scopes: ['read'],
    });
    await renderPage();
    await openTab('Jetons');

    fireEvent.change(screen.getByPlaceholderText('Ex. « Portable bureau »'), {
      target: { value: 'Nouveau portable' },
    });
    fireEvent.click(await screen.findByText('Générer le jeton'));

    expect(await screen.findByText('vyora_mcp_secret_visible_une_fois')).toBeTruthy();
    expect(screen.getByText(/ne sera plus jamais affiché/)).toBeTruthy();
    // Le bouton de confirmation reste bloqué tant que l'utilisateur n'a pas
    // coché la case : impossible de fermer par inadvertance.
    const confirmer = screen.getByText('J’ai conservé mon jeton') as HTMLButtonElement;
    expect(confirmer.disabled).toBe(true);
  });
});

describe('page VYORA MCP — outils et honnêteté', () => {
  it('présente l’outil d’écriture comme inactif, pas comme disponible', async () => {
    await renderPage();
    await openTab('Outils');
    expect(await screen.findByText(MCP_WRITE_TOOL.name)).toBeTruthy();
    expect(screen.getByText('Inactif')).toBeTruthy();
  });

  it('affiche l’historique réel et distingue un refus d’un succès', async () => {
    await renderPage();
    await openTab('Activité');
    expect(await screen.findByText('vyora_projects_list')).toBeTruthy();
    expect(screen.getByText('Succès')).toBeTruthy();
    expect(screen.getByText('Invalide')).toBeTruthy();
    expect(screen.getByText('unknown_tool')).toBeTruthy();
  });

  it('indique un état vide honnête quand aucun appel n’a eu lieu', async () => {
    mocks.listMcpActivity.mockResolvedValue([]);
    await renderPage();
    await openTab('Activité');
    expect(screen.getByText('Aucun appel enregistré')).toBeTruthy();
  });
});

describe('page VYORA MCP — configuration client', () => {
  it('génère une configuration avec en-tête Authorization pour Claude/Cursor', () => {
    const config = JSON.parse(mcpClientConfig('vyora_mcp_test', 'claude'));
    expect(config.mcpServers.vyora.url).toBe(mcpEndpoint());
    expect(config.mcpServers.vyora.headers.Authorization).toBe('Bearer vyora_mcp_test');
    expect(config.mcpServers.vyora.type).toBe('http');
  });

  it('utilise la clé « servers » et le type http pour VS Code', () => {
    const config = JSON.parse(mcpClientConfig('vyora_mcp_test', 'vscode'));
    expect(config.servers.vyora.type).toBe('http');
    expect(config.servers.vyora.headers.Authorization).toBe('Bearer vyora_mcp_test');
    expect(config.mcpServers).toBeUndefined();
  });
});
