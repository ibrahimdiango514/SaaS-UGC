// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Layout from '../src/components/Layout';

const mocks = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
  refreshQuota: vi.fn(),
  user: { id: 'user-1', email: 'user@example.com', created_at: '2025-01-01T00:00:00.000Z' },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../src/lib/api', () => ({
  listNotifications: mocks.listNotifications,
  markAllNotificationsRead: mocks.markAllNotificationsRead,
  markNotificationRead: mocks.markNotificationRead,
}));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    user: mocks.user,
    profile: null,
    quota: null,
    isAdmin: false,
    loading: false,
    logout: vi.fn(),
    refreshQuota: mocks.refreshQuota,
  }),
}));

vi.mock('../src/context/ToastContext', () => ({
  useToast: () => mocks.toast,
}));

describe('shared app shell notifications', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a load failure instead of presenting it as an empty notification list and allows retry', async () => {
    mocks.listNotifications
      .mockRejectedValueOnce(new Error('Notifications unavailable'))
      .mockResolvedValueOnce([]);

    render(<MemoryRouter><Layout /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Notifications unavailable');
    expect(screen.queryByText('Aucune notification.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('Aucune notification.')).toBeTruthy();
    expect(mocks.listNotifications).toHaveBeenCalledTimes(2);
  });

  it('only confirms a balance refresh after the latest quota was retrieved', async () => {
    mocks.listNotifications.mockResolvedValue([]);
    mocks.refreshQuota.mockResolvedValue(false);

    render(<MemoryRouter><Layout /></MemoryRouter>);
    fireEvent.click(screen.getByTitle('Actualiser le solde'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Impossible d’actualiser le solde. Réessayez.'));
    expect(mocks.toast.success).not.toHaveBeenCalledWith('Solde actualisé.');
  });
});
