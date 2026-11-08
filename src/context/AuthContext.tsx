import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { bootstrap, getProfile, getQuota, getWorkspaces, signOut as apiSignOut } from '../lib/api';
import { asAppError } from '../lib/errors';
import type { Profile, QuotaStatus, Workspace } from '../lib/types';

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  workspace: Workspace | null;
  workspaceId: string | null;
  quota: QuotaStatus | null;
  isAdmin: boolean;
  loading: boolean;
  bootstrapError: string | null;
  refreshQuota: () => Promise<void>;
  refreshAll: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const currentUid = useRef<string | null>(null);

  const loadUserData = useCallback(async (activeUser: User) => {
    setBootstrapError(null);
    try {
      const boot = await bootstrap();
      setIsAdmin(Boolean(boot.is_admin));
      const [p, q, ws] = await Promise.all([
        getProfile(activeUser.id),
        getQuota(),
        getWorkspaces(),
      ]);
      setProfile(p);
      setQuota(q);
      setWorkspace(ws.find((w) => w.id === boot.workspace_id) ?? ws[0] ?? null);
    } catch (error) {
      setBootstrapError(asAppError(error, 'Impossible de charger votre espace Reelora.').message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setUser(data.session?.user ?? null);
      if (data.session?.user) {
        currentUid.current = data.session.user.id;
        void loadUserData(data.session.user).finally(() => { if (!cancelled) setLoading(false); });
      } else {
        setLoading(false);
      }
    }).catch(() => { if (!cancelled) setLoading(false); });

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) return;
      setSession(nextSession);
      const nextUser = nextSession?.user ?? null;
      setUser(nextUser);
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && nextUser && currentUid.current !== nextUser.id) {
        currentUid.current = nextUser.id;
        setLoading(true);
        void loadUserData(nextUser).finally(() => setLoading(false));
      }
      if (event === 'SIGNED_OUT') {
        currentUid.current = null;
        setProfile(null); setWorkspace(null); setQuota(null); setIsAdmin(false);
        setBootstrapError(null);
        setLoading(false);
      }
    });

    return () => { cancelled = true; listener.subscription.unsubscribe(); };
  }, [loadUserData]);

  const refreshQuota = useCallback(async () => {
    try { setQuota(await getQuota()); } catch { /* keep previous value */ }
  }, []);

  const refreshAll = useCallback(async () => {
    if (!user) return;
    await loadUserData(user);
  }, [user, loadUserData]);

  const logout = useCallback(async () => {
    await apiSignOut();
    setSession(null); setUser(null); setProfile(null); setWorkspace(null); setQuota(null); setIsAdmin(false);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user, session, profile, workspace, workspaceId: workspace?.id ?? null,
    quota, isAdmin, loading, bootstrapError, refreshQuota, refreshAll, logout,
  }), [user, session, profile, workspace, quota, isAdmin, loading, bootstrapError, refreshQuota, refreshAll, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans AuthProvider');
  return ctx;
}
