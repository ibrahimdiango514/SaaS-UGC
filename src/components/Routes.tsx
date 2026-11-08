import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Button, ErrorState, LoadingState } from './ui';

export function ProtectedRoute() {
  const { user, loading, bootstrapError, refreshAll } = useAuth();
  const location = useLocation();
  if (loading) return <div className="grid min-h-screen place-items-center"><LoadingState label="Chargement de votre session…" /></div>;
  if (!user) return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;
  if (bootstrapError) {
    return (
      <div className="mx-auto grid min-h-screen max-w-xl place-items-center px-4">
        <ErrorState message={`Initialisation de votre espace impossible : ${bootstrapError}`} onRetry={() => void refreshAll()} />
        <div className="mt-4"><Button variant="ghost" onClick={() => { void refreshAll(); }}>Réessayer l'initialisation</Button></div>
      </div>
    );
  }
  return <Outlet />;
}

export function AdminRoute() {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/app" replace />;
  return <Outlet />;
}
