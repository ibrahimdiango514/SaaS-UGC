// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../src/context/AuthContext';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  bootstrap: vi.fn(),
  getProfile: vi.fn(),
  getQuota: vi.fn(),
  getWorkspaces: vi.fn(),
  signOut: vi.fn(),
  state: {
    listener: null as null | ((event: string, session: unknown) => void),
  },
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuthStateChange,
    },
  },
}));

vi.mock('../src/lib/api', () => ({
  bootstrap: mocks.bootstrap,
  getProfile: mocks.getProfile,
  getQuota: mocks.getQuota,
  getWorkspaces: mocks.getWorkspaces,
  signOut: mocks.signOut,
}));

function session(userId: string) {
  return {
    access_token: `token-${userId}`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 1893456000,
    user: { id: userId, email: `${userId}@example.test` },
  };
}

function ContextProbe() {
  const { user, profile, workspace, loading } = useAuth();
  return (
    <output data-testid="auth-state">
      {user?.id ?? 'anonymous'}|{profile?.display_name ?? 'no-profile'}|{workspace?.id ?? 'no-workspace'}|{loading ? 'loading' : 'ready'}
    </output>
  );
}

function renderAuth() {
  return render(<AuthProvider><ContextProbe /></AuthProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.listener = null;
  mocks.onAuthStateChange.mockImplementation((listener: (event: string, session: unknown) => void) => {
    mocks.state.listener = listener;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  mocks.getQuota.mockResolvedValue({ credits: 5 });
  mocks.getProfile.mockImplementation(async (userId: string) => ({
    user_id: userId,
    display_name: `Profile ${userId}`,
  }));
  mocks.getWorkspaces.mockImplementation(async () => [{
    id: 'workspace-user-b',
    owner_user_id: 'user-b',
    name: 'Workspace B',
  }]);
  mocks.bootstrap.mockResolvedValue({
    user_id: 'user-b',
    workspace_id: 'workspace-user-b',
    is_admin: false,
  });
});

afterEach(cleanup);

describe('isolation des données chargées par AuthContext', () => {
  it('efface les données précédentes et ignore une réponse tardive lors du changement de compte', async () => {
    let resolveBootstrapA!: (value: { user_id: string; workspace_id: string; is_admin: boolean }) => void;
    mocks.getSession.mockResolvedValue({ data: { session: session('user-a') } });
    mocks.bootstrap
      .mockImplementationOnce(() => new Promise((resolve) => { resolveBootstrapA = resolve; }))
      .mockResolvedValueOnce({
        user_id: 'user-b',
        workspace_id: 'workspace-user-b',
        is_admin: false,
      });

    renderAuth();
    await waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('auth-state').textContent).toContain('user-a|no-profile|no-workspace');

    act(() => mocks.state.listener?.('SIGNED_IN', session('user-b')));
    expect(screen.getByTestId('auth-state').textContent).toBe('user-b|no-profile|no-workspace|loading');
    await waitFor(() => expect(screen.getByTestId('auth-state').textContent).toBe('user-b|Profile user-b|workspace-user-b|ready'));

    await act(async () => {
      resolveBootstrapA({ user_id: 'user-a', workspace_id: 'workspace-user-a', is_admin: true });
    });

    expect(screen.getByTestId('auth-state').textContent).toBe('user-b|Profile user-b|workspace-user-b|ready');
    expect(mocks.getProfile).toHaveBeenCalledTimes(1);
    expect(mocks.getProfile).toHaveBeenCalledWith('user-b');
  });

  it('ne laisse pas un getSession obsolète écraser la session arrivée par le listener', async () => {
    let resolveSession!: (value: { data: { session: ReturnType<typeof session> } }) => void;
    mocks.getSession.mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; }));

    renderAuth();
    act(() => mocks.state.listener?.('SIGNED_IN', session('user-b')));
    await waitFor(() => expect(screen.getByTestId('auth-state').textContent).toBe('user-b|Profile user-b|workspace-user-b|ready'));

    await act(async () => {
      resolveSession({ data: { session: session('user-a') } });
    });

    expect(screen.getByTestId('auth-state').textContent).toBe('user-b|Profile user-b|workspace-user-b|ready');
    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
  });
});
