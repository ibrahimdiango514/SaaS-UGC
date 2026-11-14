import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, LockKeyhole, ShieldCheck, UserPlus } from 'lucide-react';
import AuthShell from '../components/AuthShell';
import { AuthField, AuthNotice, AuthSubmit, PasswordMeter, type AuthSubmitState } from '../components/auth/AuthForm';
import { ErrorState, LoadingState } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { claimFirstOwnerAdmin, getOwnerBootstrapStatus, type OwnerBootstrapStatus } from '../lib/api';
import { asAppError } from '../lib/errors';
import { SITE_URL, supabase } from '../lib/supabase';

/**
 * Initialisation du premier compte propriétaire.
 *
 * **Règles d'accès strictement inchangées** : l'attribution du rôle est décidée
 * par le serveur (`claimFirstOwnerAdmin`), jamais par ce formulaire ; la page se
 * ferme dès que l'initialisation est terminée ; une session ordinaire ne peut
 * pas s'auto-promouvoir. Seul l'habillage adopte le parcours d'authentification.
 */
export default function OwnerBootstrap() {
  const { user, loading, isAdmin, refreshAll } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<OwnerBootstrapStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [state, setState] = useState<AuthSubmitState>('idle');
  const [error, setError] = useState('');
  const [needConfirmation, setNeedConfirmation] = useState(false);

  useEffect(() => {
    let active = true;
    getOwnerBootstrapStatus()
      .then((result) => { if (active) setStatus(result); })
      .catch((cause) => { if (active) setStatusError(asAppError(cause).message); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (isAdmin) navigate('/admin', { replace: true });
  }, [isAdmin, navigate]);

  const submitOwnerSignup = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Adresse e-mail invalide.');
      return;
    }
    if (password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    if (password !== confirm) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }

    setSubmitting(true);
    setState('loading');
    try {
      const { data, error: signupError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name: 'Propriétaire VYORA', app_scope: 'vyora_owner' },
          emailRedirectTo: `${SITE_URL}/proprietaire/confirmation`,
        },
      });
      if (signupError) throw signupError;
      if (data.session) {
        await claimFirstOwnerAdmin();
        setState('success');
        await refreshAll();
        navigate('/admin', { replace: true });
      } else {
        setState('idle');
        setNeedConfirmation(true);
      }
    } catch (cause) {
      setState('idle');
      setError(asAppError(cause, 'Création du compte administrateur impossible.').message);
    } finally {
      setSubmitting(false);
    }
  };

  const finishExistingSession = async () => {
    setError('');
    setSubmitting(true);
    setState('loading');
    try {
      await claimFirstOwnerAdmin();
      setState('success');
      await refreshAll();
      navigate('/admin', { replace: true });
    } catch (cause) {
      setState('idle');
      setError(asAppError(cause, 'Initialisation du compte administrateur impossible.').message);
      try {
        setStatus(await getOwnerBootstrapStatus());
      } catch (statusCause) {
        setStatusError(asAppError(statusCause).message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || (!status && !statusError)) {
    return <div className="grid min-h-screen place-items-center px-4"><LoadingState label="Vérification de l’initialisation administrateur…" /></div>;
  }

  if (statusError) {
    return (
      <AuthShell variant="secure" eyebrow="Accès propriétaire" title="Création du compte administrateur" subtitle="Initialisation sécurisée du premier compte propriétaire.">
        <div className="vy-auth-card p-5 sm:p-6">
          <ErrorState message={`Vérification serveur impossible : ${statusError}`} />
          <Link to="/" className="vy-btn vy-btn-ghost-accent mt-5 flex min-h-11 w-full text-[12.5px]">Retour à l’accueil</Link>
        </div>
      </AuthShell>
    );
  }

  if (status?.initialized) {
    return (
      <AuthShell variant="secure" eyebrow="Accès propriétaire" title="Espace propriétaire" subtitle="L’initialisation du premier administrateur est déjà terminée.">
        <div className="vy-auth-card p-6 text-center sm:p-8">
          <span className="vy-in-scale mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.09] text-emerald-300">
            <CheckCircle2 size={30} />
          </span>
          <p className="mt-5 text-sm leading-relaxed text-slate-300">La création d’un administrateur supplémentaire depuis cette page est fermée.</p>
          <Link to="/proprietaire/connexion" className="vy-btn vy-btn-accent mt-6 flex min-h-12 w-full text-[14px]">Connexion administrateur</Link>
        </div>
      </AuthShell>
    );
  }

  if (!status?.configured) {
    return (
      <AuthShell variant="secure" eyebrow="Accès propriétaire" title="Création du compte administrateur" subtitle="Initialisation réservée au propriétaire du projet.">
        <div className="vy-auth-card p-5 sm:p-6">
          <ErrorState message="Le bootstrap propriétaire n’est pas encore configuré côté serveur. Aucun compte ne peut être promu depuis cette page." />
          <Link to="/" className="vy-btn vy-btn-ghost-accent mt-5 flex min-h-11 w-full text-[12.5px]">Retour à l’accueil</Link>
        </div>
      </AuthShell>
    );
  }

  if (user) {
    return (
      <AuthShell variant="secure" eyebrow="Accès propriétaire" title="Création du compte administrateur" subtitle="Le serveur vérifiera l’identité propriétaire et la confirmation de l’adresse avant toute attribution de rôle.">
        <div className="vy-auth-card p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
            <ShieldCheck className="shrink-0 text-cyan-300" size={20} />
            <p className="text-[12.5px] text-slate-300">Session ouverte pour <strong className="text-white">{user.email}</strong></p>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); void finishExistingSession(); }}>
            {error && <div className="mb-4"><AuthNotice>{error}</AuthNotice></div>}
            <AuthSubmit
              state={state}
              disabled={submitting}
              loadingLabel="Vérification serveur…"
              successLabel="Rôle vérifié"
              icon={<ShieldCheck size={16} />}
              className="w-full"
            >
              Finaliser le compte propriétaire
            </AuthSubmit>
          </form>
          <p className="mt-4 text-center text-[10.5px] leading-relaxed text-slate-500">Un compte ordinaire ne peut pas s’attribuer le rôle administrateur.</p>
        </div>
      </AuthShell>
    );
  }

  if (needConfirmation) {
    return (
      <AuthShell variant="secure" eyebrow="Accès propriétaire" title="Confirmez votre adresse e-mail" subtitle="Le rôle administrateur ne sera attribué qu’après confirmation.">
        <div className="vy-auth-card p-6 text-center sm:p-8">
          <span className="vy-in-scale mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.09] text-emerald-300">
            <CheckCircle2 size={30} />
          </span>
          <p className="mt-5 text-sm leading-relaxed text-slate-300">
            Un lien de confirmation a été envoyé à <strong className="text-white">{email}</strong>. Ouvrez-le pour terminer l’initialisation sécurisée.
          </p>
          <Link to="/" className="mt-6 inline-block text-[12.5px] text-cyan-300 hover:text-cyan-200">Retour à l’accueil</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell variant="secure" eyebrow="Accès propriétaire" title="Création du compte administrateur" subtitle="Ce formulaire est ouvert uniquement pour l’initialisation du premier compte propriétaire.">
      <div className="vy-auth-card p-5 sm:p-7" data-state={state === 'success' ? 'success' : error ? 'error' : undefined}>
        <form onSubmit={(event) => void submitOwnerSignup(event)} className="space-y-4" noValidate>
          <AuthField
            label="Adresse e-mail"
            type="email"
            autoComplete="email"
            required
            autoFocus
            inputMode="email"
            spellCheck={false}
            value={email}
            onChange={(event) => { setEmail(event.target.value); if (error) setError(''); }}
            placeholder="vous@exemple.com"
            icon={<ShieldCheck size={15} />}
          />
          <div>
            <AuthField
              label="Mot de passe"
              autoComplete="new-password"
              required
              revealable
              value={password}
              onChange={(event) => { setPassword(event.target.value); if (error) setError(''); }}
              placeholder="8 caractères minimum"
              icon={<LockKeyhole size={15} />}
              hint="Au moins 8 caractères."
            />
            <PasswordMeter value={password} />
          </div>
          <AuthField
            label="Confirmation du mot de passe"
            autoComplete="new-password"
            required
            revealable
            value={confirm}
            onChange={(event) => { setConfirm(event.target.value); if (error) setError(''); }}
            placeholder="••••••••"
            icon={<LockKeyhole size={15} />}
          />
          {error && <AuthNotice>{error}</AuthNotice>}
          <AuthSubmit
            state={state}
            disabled={submitting}
            loadingLabel="Création du compte…"
            successLabel="Compte administrateur prêt"
            icon={<UserPlus size={16} />}
          >
            Créer mon compte administrateur
          </AuthSubmit>
        </form>
        <p className="mt-4 text-center text-[10.5px] leading-relaxed text-slate-500">
          L’attribution du rôle est vérifiée côté serveur et n’est jamais effectuée par ce formulaire.
        </p>
      </div>
      <div className="mt-4 text-center">
        <Link to="/connexion" className="text-[11.5px] text-slate-400 transition hover:text-white">Je possède déjà un compte</Link>
      </div>
    </AuthShell>
  );
}
