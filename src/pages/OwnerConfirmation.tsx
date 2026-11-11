import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import AuthShell from '../components/AuthShell';
import { Card, ErrorState, LoadingState } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { claimFirstOwnerAdmin } from '../lib/api';
import { asAppError } from '../lib/errors';

export default function OwnerConfirmation() {
  const { user, loading, isAdmin, refreshAll } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    if (loading || !user || isAdmin || complete || error) return;
    let active = true;
    claimFirstOwnerAdmin()
      .then(async () => {
        await refreshAll();
        if (active) setComplete(true);
      })
      .catch((cause) => {
        if (active) setError(asAppError(cause, 'Initialisation du compte administrateur impossible.').message);
      });
    return () => { active = false; };
  }, [complete, error, isAdmin, loading, refreshAll, user]);

  useEffect(() => {
    if (isAdmin) navigate('/admin', { replace: true });
  }, [isAdmin, navigate]);

  if (loading || (!user && !error)) {
    return <div className="grid min-h-screen place-items-center px-4"><LoadingState label="Vérification de l’adresse et du compte propriétaire…" /></div>;
  }

  return (
    <AuthShell title="Initialisation du compte administrateur" subtitle="Le rôle est attribué uniquement après confirmation par Supabase Auth.">
      <Card className="p-6 text-center">
        {complete ? <CheckCircle2 className="mx-auto text-emerald-400" size={36} /> : null}
        {error ? <ErrorState message={error} /> : <p className="text-sm text-slate-300">{complete ? 'Compte propriétaire vérifié. Votre accès administrateur est prêt.' : 'Finalisation sécurisée en cours…'}</p>}
        {complete && <Link to="/admin" className="btn btn-primary btn-md mt-6 w-full">Accéder au dashboard administrateur</Link>}
        {error && (
          <div className="mt-5 space-y-3">
            <Link to="/proprietaire/connexion" className="btn btn-primary btn-md w-full">Connexion administrateur</Link>
            <Link to="/app" className="block text-sm text-brand-300">Continuer vers l’espace utilisateur</Link>
          </div>
        )}
      </Card>
    </AuthShell>
  );
}
