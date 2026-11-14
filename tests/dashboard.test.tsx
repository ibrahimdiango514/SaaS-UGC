// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listJobs: vi.fn(),
  countAssets: vi.fn(),
  healthCheck: vi.fn(),
  refreshQuota: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  listProjects: mocks.listProjects,
  listJobs: mocks.listJobs,
  countAssets: mocks.countAssets,
  healthCheck: mocks.healthCheck,
}));


vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    profile: { display_name: 'Camille Martin' },
    quota: {
      credits: 87,
      projects: 3,
      period: '2026-11',
      period_end: '2026-12-01T00:00:00.000Z',
      status: 'active',
      usage: { video: 2, script: 4, prompt: 1 },
      plan: {
        display_name: 'Studio',
        tagline: 'Pour les créateurs réguliers',
        max_projects: 10,
        max_videos_per_month: 20,
        max_scripts_per_month: 80,
        max_prompts_per_month: 60,
      },
    },
    refreshQuota: mocks.refreshQuota,
  }),
}));

import Dashboard from '../src/pages/Dashboard';

describe('espace client Reelora', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjects.mockResolvedValue([]);
    mocks.listJobs.mockResolvedValue([]);
    mocks.countAssets.mockResolvedValue(0);
    mocks.healthCheck.mockResolvedValue({ configured: { groq: true, muapi: true } });
    mocks.refreshQuota.mockResolvedValue(true);
  });

  afterEach(cleanup);

  it('reste strictement dans l’espace Studio et n’affiche aucune fonctionnalité Business Growth', async () => {
    render(<MemoryRouter><Dashboard /></MemoryRouter>);

    const studio = await screen.findByRole('link', { name: /Créer avec Studio/ });
    const projects = screen.getByRole('link', { name: /Mes projets/ });

    expect(studio.getAttribute('href')).toBe('/app/studio');
    expect(projects.getAttribute('href')).toBe('/app/projets');
    expect(screen.getByText('87')).toBeTruthy();
    expect(screen.queryByText(/Business Grow/i)).toBeNull();
    expect(screen.queryByText(/Quota métier/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /Business/i })).toBeNull();
  });
});
