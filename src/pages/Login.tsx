import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, LockKeyhole, Mail } from 'lucide-react';
import AuthShell from '../components/AuthShell';
import { AuthField, AuthNotice, AuthSubmit, type AuthSubmitState } from '../components/auth/AuthForm';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { bootstrap, signIn } from '../lib/api';
import { asAppError } from '../lib/errors';

/**
 * Connexion — parcours immersif.
 *
 * Comportement strictement conservé : mêmes validations, mêmes messages
 * (« Renseignez votre e-mail et votre mot de passe. »), même redirection
 * (`from` → /app, admin → /admin) et mêmes appels (`signIn` puis `bootstrap`).
 * Seul l'habillage change, avec en plus des états visuels de saisie.
 */
export default function Login() {
  const { user, loading, isAdmin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<AuthSubmitState>('idle');
  const [shaking, setShaking] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading && user) navigate(isAdmin ? '/admin' : '/app', { replace: true });
  }, [user, loading, isAdmin, navigate]);

  const fail = (message: string) => {
    setError(message);
    setState('idle');
    setShaking(true);
    window.setTimeout(() => setShaking(false), 460);
    window.setTimeout(() => errorRef.current?.focus(), 30);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) {
      fail('Renseignez votre e-mail et votre mot de passe.');
      return;
    }
    setSubmitting(true);
    setState('loading');
    try {
      await signIn(email.trim(), password);
      const account = await bootstrap();
      setState('success');
      toast.success('Bienvenue sur SORAHNEX !');
      const from = (location.state as { from?: string } | null)?.from;
      // Laisse la coche de réussite se dessiner avant la navigation.
      window.setTimeout(() => {
        navigate(account.is_admin ? '/admin' : from && from.startsWith('/app') ? from : '/app', { replace: true });
      }, 420);
    } catch (err) {
      setSubmitting(false);
      fail(asAppError(err, 'Connexion impossible.').message);
    }
  };

  if (!loading && user) return <Navigate to={isAdmin ? '/admin' : '/app'} replace />;

  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <AuthShell
      variant="enter"
      eyebrow="Connexion sécurisée"
      title="Connexion"
      subtitle="Accédez à votre espace de création SORAHNEX."
      footer={<>Pas encore de compte ? <Link to="/inscription" className="font-semibold text-cyan-300 transition hover:text-cyan-200">Créer un compte</Link></>}
    >
      <div
        className={`vy-auth-card p-5 sm:p-7 ${shaking ? 'vy-shake' : ''}`}
        data-state={state === 'success' ? 'success' : error ? 'error' : undefined}
      >
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4" noValidate>
          <AuthField
            label="Adresse e-mail"
            type="email"
            autoComplete="email"
            required
            autoFocus
            inputMode="email"
            spellCheck={false}
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (error) setError(''); }}
            placeholder="vous@exemple.com"
            icon={<Mail size={15} />}
            valid={emailLooksValid}
          />

          <AuthField
            label="Mot de passe"
            autoComplete="current-password"
            required
            revealable
            value={password}
            onChange={(e) => { setPassword(e.target.value); if (error) setError(''); }}
            placeholder="••••••••"
            icon={<LockKeyhole size={15} />}
          />

          <div className="flex items-center justify-between gap-3">
            <span className="text-[10.5px] text-slate-500">Session protégée par Supabase</span>
            <Link to="/mot-de-passe-oublie" className="text-[11.5px] font-medium text-cyan-300 transition hover:text-cyan-200">
              Mot de passe oublié ?
            </Link>
          </div>

          <div ref={errorRef} tabIndex={-1} className="outline-none">
            {error && <AuthNotice>{error}</AuthNotice>}
          </div>

          <AuthSubmit
            state={state}
            disabled={submitting}
            loadingLabel="Connexion…"
            successLabel="Connecté — ouverture de l’espace"
            icon={<ArrowRight size={16} />}
          >
            Se connecter
          </AuthSubmit>
        </form>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-t border-white/[0.07] pt-4 text-[10.5px] text-slate-500">
          <span className="inline-flex items-center gap-1.5"><LockKeyhole size={11} className="text-emerald-400/80" /> Vos identifiants ne sont jamais stockés en clair</span>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Link to="/proprietaire/connexion" className="vy-btn vy-btn-ghost-accent min-h-11 px-4 text-[11.5px]">
          Accès propriétaire
        </Link>
        <Link to="/inscription" className="vy-btn min-h-11 border border-white/[0.09] bg-white/[0.03] px-4 text-[11.5px] text-slate-300 hover:text-white">
          Découvrir SORAHNEX
        </Link>
      </div>
    </AuthShell>
  );
}
