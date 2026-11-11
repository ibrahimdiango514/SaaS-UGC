import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, Eye, EyeOff, ShieldCheck, UserPlus } from 'lucide-react';
import AuthShell from '../components/AuthShell';
import { Button, Card, ErrorState, Input, LoadingState } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { claimFirstOwnerAdmin, getOwnerBootstrapStatus, type OwnerBootstrapStatus } from '../lib/api';
import { asAppError } from '../lib/errors';
import { SITE_URL, supabase } from '../lib/supabase';

export default function OwnerBootstrap() {
  const { user, loading, isAdmin, refreshAll } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<OwnerBootstrapStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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
        await refreshAll();
        navigate('/admin', { replace: true });
      } else {
        setNeedConfirmation(true);
      }
    } catch (cause) {
      setError(asAppError(cause, 'Création du compte administrateur impossible.').message);
    } finally {
      setSubmitting(false);
    }
  };

  const finishExistingSession = async () => {
    setError('');
    setSubmitting(true);
    try {
      await claimFirstOwnerAdmin();
      await refreshAll();
      navigate('/admin', { replace: true });
    } catch (cause) {
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
      <AuthShell title="Création du compte administrateur" subtitle="Initialisation sécurisée du premier compte propriétaire.">
        <Card className="p-6">
          <ErrorState message={`Vérification serveur impossible : ${statusError}`} />
          <Link to="/" className="mt-5 block text-center text-sm text-brand-300">Retour à l’accueil</Link>
        </Card>
      </AuthShell>
    );
  }

  if (status?.initialized) {
    return (
      <AuthShell title="Espace propriétaire" subtitle="L’initialisation du premier administrateur est déjà terminée.">
        <Card className="p-6 text-center">
          <CheckCircle2 className="mx-auto text-emerald-400" size={36} />
          <p className="mt-4 text-sm text-slate-300">La création d’un administrateur supplémentaire depuis cette page est fermée.</p>
          <Link to="/proprietaire/connexion" className="btn btn-primary btn-md mt-6 w-full">Connexion administrateur</Link>
        </Card>
      </AuthShell>
    );
  }

  if (!status?.configured) {
    return (
      <AuthShell title="Création du compte administrateur" subtitle="Initialisation réservée au propriétaire du projet.">
        <Card className="p-6">
          <ErrorState message="Le bootstrap propriétaire n’est pas encore configuré côté serveur. Aucun compte ne peut être promu depuis cette page." />
          <Link to="/" className="mt-5 block text-center text-sm text-brand-300">Retour à l’accueil</Link>
        </Card>
      </AuthShell>
    );
  }

  if (user) {
    return (
      <AuthShell title="Création du compte administrateur" subtitle="Le serveur vérifiera l’identité propriétaire et la confirmation de l’adresse avant toute attribution de rôle.">
        <Card className="p-6">
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-line bg-white/[0.03] p-3">
            <ShieldCheck className="shrink-0 text-brand-300" size={20} />
            <p className="text-sm text-slate-300">Session ouverte pour <strong className="text-white">{user.email}</strong></p>
          </div>
          {error && <div className="mb-4"><ErrorState message={error} /></div>}
          <Button className="w-full" size="lg" loading={submitting} onClick={() => void finishExistingSession()}>
            Finaliser le compte propriétaire
          </Button>
          <p className="mt-4 text-center text-xs text-slate-500">Un compte ordinaire ne peut pas s’attribuer le rôle administrateur.</p>
        </Card>
      </AuthShell>
    );
  }

  if (needConfirmation) {
    return (
      <AuthShell title="Confirmez votre adresse e-mail" subtitle="Le rôle administrateur ne sera attribué qu’après confirmation.">
        <Card className="p-6 text-center">
          <CheckCircle2 className="mx-auto text-emerald-400" size={36} />
          <p className="mt-4 text-sm leading-relaxed text-slate-300">
            Un lien de confirmation a été envoyé à <strong className="text-white">{email}</strong>. Ouvrez-le pour terminer l’initialisation sécurisée.
          </p>
          <Link to="/" className="mt-6 inline-block text-sm text-brand-300">Retour à l’accueil</Link>
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Création du compte administrateur" subtitle="Ce formulaire est ouvert uniquement pour l’initialisation du premier compte propriétaire.">
      <Card className="p-6">
        <form onSubmit={(event) => void submitOwnerSignup(event)} className="space-y-4" noValidate>
          <Input label="Adresse e-mail" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="vous@exemple.com" />
          <div className="relative">
            <Input label="Mot de passe" type={showPassword ? 'text' : 'password'} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} hint="Au moins 8 caractères." />
            <button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-[36px] text-slate-500 hover:text-white" aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}>
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <Input label="Confirmation du mot de passe" type={showPassword ? 'text' : 'password'} autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} />
          {error && <ErrorState message={error} />}
          <Button type="submit" className="w-full" size="lg" loading={submitting} icon={<UserPlus size={16} />}>Créer mon compte administrateur</Button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-500">L’attribution du rôle est vérifiée côté serveur et n’est jamais effectuée par ce formulaire.</p>
      </Card>
    </AuthShell>
  );
}
