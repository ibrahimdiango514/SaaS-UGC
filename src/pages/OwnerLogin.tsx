import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import AuthShell from '../components/AuthShell';
import { Button, Card, ErrorState, Input } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { bootstrap, signIn, signOut } from '../lib/api';
import { asAppError } from '../lib/errors';

export default function OwnerLogin() {
  const { user, isAdmin, loading, logout } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isAdmin) navigate('/admin', { replace: true });
  }, [isAdmin, navigate]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      const result = await bootstrap();
      if (!result.is_admin) {
        await signOut();
        throw new Error('Ce compte ne possède pas le rôle administrateur.');
      }
      navigate('/admin', { replace: true });
    } catch (cause) {
      setError(asAppError(cause, 'Connexion administrateur impossible.').message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="grid min-h-screen place-items-center px-4"><p className="text-sm text-slate-400">Vérification de la session…</p></div>;

  return (
    <AuthShell title="Connexion administrateur" subtitle="Seul le rôle administrateur vérifié côté serveur ouvre le dashboard.">
      <Card className="p-6">
        {user && !isAdmin ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-300">La session ouverte n’a pas le rôle administrateur.</p>
            <Button className="w-full" variant="outline" onClick={() => void logout()}>Se déconnecter</Button>
          </div>
        ) : (
          <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
            <Input label="Adresse e-mail" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
            <div className="relative">
              <Input label="Mot de passe" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
              <button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-[36px] text-slate-500 hover:text-white" aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {error && <ErrorState message={error} />}
            <Button type="submit" className="w-full" size="lg" loading={submitting} icon={<LockKeyhole size={16} />}>Se connecter</Button>
          </form>
        )}
        {!user && error && <div className="sr-only" role="alert">{error}</div>}
      </Card>
      <p className="mt-5 text-center text-xs text-slate-500"><Link to="/" className="text-brand-300">Retour à l’accueil</Link></p>
    </AuthShell>
  );
}
