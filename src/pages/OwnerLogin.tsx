import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import AuthShell from '../components/AuthShell';
import { AuthField, AuthNotice, AuthSubmit, type AuthSubmitState } from '../components/auth/AuthForm';
import { useAuth } from '../context/AuthContext';
import { bootstrap, signIn, signOut } from '../lib/api';
import { asAppError } from '../lib/errors';

/**
 * Connexion administrateur.
 *
 * **Contrôle d'accès inchangé** : la session est fermée si `bootstrap()` ne
 * renvoie pas `is_admin` — un compte ordinaire ne peut pas entrer ici. Seul
 * l'habillage suit désormais le parcours d'authentification VYORA.
 */
export default function OwnerLogin() {
  const { user, isAdmin, loading, logout } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [state, setState] = useState<AuthSubmitState>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (isAdmin) navigate('/admin', { replace: true });
  }, [isAdmin, navigate]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    setState('loading');
    try {
      await signIn(email.trim(), password);
      const result = await bootstrap();
      if (!result.is_admin) {
        await signOut();
        throw new Error('Ce compte ne possède pas le rôle administrateur.');
      }
      setState('success');
      navigate('/admin', { replace: true });
    } catch (cause) {
      setState('idle');
      setError(asAppError(cause, 'Connexion administrateur impossible.').message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="grid min-h-screen place-items-center px-4"><p className="text-sm text-slate-400">Vérification de la session…</p></div>;

  return (
    <AuthShell
      variant="secure"
      eyebrow="Console propriétaire"
      title="Connexion administrateur"
      subtitle="Seul le rôle administrateur vérifié côté serveur ouvre le dashboard."
      footer={<Link to="/connexion" className="font-semibold text-cyan-300 transition hover:text-cyan-200">Connexion utilisateur standard</Link>}
    >
      <div className="vy-auth-card p-5 sm:p-7" data-state={state === 'success' ? 'success' : error ? 'error' : undefined}>
        {user && !isAdmin ? (
          <div className="space-y-4">
            <AuthNotice tone="info">
              La session ouverte n’a pas le rôle administrateur. Déconnectez-vous pour utiliser un compte propriétaire.
            </AuthNotice>
            <button type="button" onClick={() => void logout()} className="vy-btn vy-btn-ghost-accent min-h-12 w-full text-[13px]">
              Se déconnecter
            </button>
          </div>
        ) : (
          <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
            <AuthField
              label="Adresse e-mail"
              type="email"
              autoComplete="username"
              required
              autoFocus
              inputMode="email"
              spellCheck={false}
              value={email}
              onChange={(event) => { setEmail(event.target.value); if (error) setError(''); }}
              placeholder="vous@exemple.com"
              icon={<Mail size={15} />}
            />
            <AuthField
              label="Mot de passe"
              autoComplete="current-password"
              required
              revealable
              value={password}
              onChange={(event) => { setPassword(event.target.value); if (error) setError(''); }}
              placeholder="••••••••"
              icon={<LockKeyhole size={15} />}
            />
            {error && <AuthNotice>{error}</AuthNotice>}
            <AuthSubmit
              state={state}
              disabled={submitting}
              loadingLabel="Vérification du rôle…"
              successLabel="Rôle vérifié — ouverture"
              icon={<ShieldCheck size={16} />}
            >
              Se connecter
            </AuthSubmit>
          </form>
        )}
      </div>
      <p className="mt-4 text-center text-[10.5px] leading-relaxed text-slate-500">
        Aucune élévation de privilège n’est possible depuis cette page : le rôle vient du serveur.
      </p>
    </AuthShell>
  );
}
