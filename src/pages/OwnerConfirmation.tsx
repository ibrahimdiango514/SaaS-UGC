import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import AuthShell from '../components/AuthShell';
import { ErrorState, LoadingState } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { claimFirstOwnerAdmin } from '../lib/api';
import { asAppError } from '../lib/errors';

/**
 * Confirmation de l'adresse du propriétaire.
 *
 * **Logique inchangée** : le rôle n'est attribué qu'après confirmation Supabase
 * Auth, via `claimFirstOwnerAdmin()` (vérification serveur). Seul l'habillage
 * rejoint le parcours d'authentification.
 */
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
    <AuthShell
      variant="secure"
      eyebrow="Vérification"
      title="Initialisation du compte administrateur"
      subtitle="Le rôle est attribué uniquement après confirmation par Supabase Auth."
    >
      <div className="vy-auth-card p-6 text-center sm:p-8" data-state={complete ? 'success' : error ? 'error' : undefined}>
        {complete && (
          <>
            <span className="vy-in-scale mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.09] text-emerald-300">
              <CheckCircle2 size={30} />
            </span>
            <p className="mt-5 text-sm leading-relaxed text-slate-300">Compte propriétaire vérifié. Votre accès administrateur est prêt.</p>
            <Link to="/admin" className="vy-btn vy-btn-accent mt-6 flex min-h-12 w-full text-[14px]">
              Accéder au dashboard administrateur
            </Link>
          </>
        )}

        {!complete && !error && (
          <>
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-white/[0.09] bg-white/[0.04] text-cyan-200">
              <Loader2 size={26} className="animate-spin" />
            </span>
            <p className="mt-5 text-sm text-slate-300" role="status">Finalisation sécurisée en cours…</p>
            <p className="mt-2 text-[11px] text-slate-500">Aucune action n’est requise de votre part.</p>
          </>
        )}

        {error && (
          <>
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-rose-400/25 bg-rose-400/[0.08] text-rose-300">
              <AlertCircle size={28} />
            </span>
            <div className="mt-5 text-left"><ErrorState message={error} /></div>
            <div className="mt-5 grid gap-2">
              <Link to="/proprietaire/connexion" className="vy-btn vy-btn-accent flex min-h-12 w-full text-[13.5px]">Connexion administrateur</Link>
              <Link to="/app" className="vy-btn min-h-11 w-full text-[12px] text-slate-400 hover:text-white">Continuer vers l’espace utilisateur</Link>
            </div>
          </>
        )}
      </div>
    </AuthShell>
  );
}
