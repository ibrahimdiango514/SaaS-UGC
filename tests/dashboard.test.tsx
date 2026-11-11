// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listJobs: vi.fn(),
  countAssets: vi.fn(),
  healthCheck: vi.fn(),
  refreshQuota: vi.fn(),
  getBusinessSnapshot: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  listProjects: mocks.listProjects,
  listJobs: mocks.listJobs,
  countAssets: mocks.countAssets,
  healthCheck: mocks.healthCheck,
}));

vi.mock('../src/business', () => ({
  businessGrowBridge: { getSnapshot: mocks.getBusinessSnapshot },
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

  it('présente les modules dans le même espace et garde les crédits UGC distincts', async () => {
    render(<MemoryRouter><Dashboard /></MemoryRouter>);

    const studio = await screen.findByRole('link', { name: /Studio UGC/ });
    const business = screen.getByRole('link', { name: /Business Grow/ });

    expect(studio.getAttribute('href')).toBe('/app/studio');
    expect(studio.textContent).toContain('Crédits Studio');
    expect(studio.textContent).toContain('87');
    expect(business.getAttribute('href')).toBe('/app/business');
    expect(within(business).getByText('Quota métier distinct des crédits Studio')).toBeTruthy();
    expect(within(business).queryByText(/87/)).toBeNull();
  });
});
