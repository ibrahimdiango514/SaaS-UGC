import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, LockKeyhole, Mail } from 'lucide-react';
import AuthShell from '../components/AuthShell';
import { Button, Card, ErrorState, Input } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { signIn } from '../lib/api';
import { asAppError } from '../lib/errors';

export default function Login() {
  const { user, loading } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (!loading && user) navigate('/app', { replace: true }); }, [user, loading, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) { setError('Renseignez votre e-mail et votre mot de passe.'); return; }
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      toast.success('Bienvenue sur VYORA !');
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith('/app') ? from : '/app', { replace: true });
    } catch (err) {
      setError(asAppError(err, 'Connexion impossible.').message);
    } finally { setSubmitting(false); }
  };

  if (!loading && user) return <Navigate to="/app" replace />;

  return (
    <AuthShell title="Connexion" subtitle="Accédez à votre espace de création VYORA."
      footer={<>Pas encore de compte ? <Link to="/inscription" className="font-semibold text-brand-300 hover:text-brand-200">Créer un compte</Link></>}>
      <Card className="p-6">
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4" noValidate>
          <div className="relative">
            <Input label="Adresse e-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@exemple.com" />
            <Mail size={15} className="pointer-events-none absolute right-3 top-[38px] text-slate-500" />
          </div>
          <div className="relative">
            <Input label="Mot de passe" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-3 top-[36px] text-slate-500 hover:text-white" aria-label={show ? 'Masquer' : 'Afficher'}>
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <div className="flex justify-end"><Link to="/mot-de-passe-oublie" className="text-xs text-brand-300 hover:text-brand-200">Mot de passe oublié ?</Link></div>
          {error && <ErrorState message={error} />}
          <Button type="submit" className="w-full" size="lg" loading={submitting} icon={<LockKeyhole size={16} />}>Se connecter</Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-xs text-slate-500">Vos données sont protégées par l’authentification Supabase et les politiques RLS.</p>
    </AuthShell>
  );
}
