import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, UserPlus, CheckCircle2 } from 'lucide-react';
import AuthShell from '../components/AuthShell';
import { Button, Card, ErrorState, Input } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { signUp } from '../lib/api';
import { asAppError } from '../lib/errors';

export default function Signup() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accept, setAccept] = useState(false);
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [needConfirmation, setNeedConfirmation] = useState(false);

  useEffect(() => { if (user) navigate('/app', { replace: true }); }, [user, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!fullName.trim()) { setError('Indiquez votre nom.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Adresse e-mail invalide.'); return; }
    if (password.length < 8) { setError('Le mot de passe doit contenir au moins 8 caractères.'); return; }
    if (password !== confirm) { setError('Les deux mots de passe ne correspondent pas.'); return; }
    if (!accept) { setError('Vous devez accepter les conditions d’utilisation.'); return; }
    setSubmitting(true);
    try {
      const data = await signUp(email.trim(), password, fullName.trim());
      if (data.session) { toast.success('Votre espace Reelora est prêt !'); navigate('/app', { replace: true }); }
      else setNeedConfirmation(true);
    } catch (err) { setError(asAppError(err, 'Inscription impossible.').message); }
    finally { setSubmitting(false); }
  };

  if (needConfirmation) {
    return (
      <AuthShell title="Vérifiez votre e-mail" subtitle="Une dernière étape avant de créer vos vidéos.">
        <Card className="p-8 text-center">
          <CheckCircle2 className="mx-auto text-emerald-400" size={38} />
          <p className="mt-4 text-sm leading-relaxed text-slate-300">Un lien de confirmation a été envoyé à <strong className="text-white">{email}</strong>. Cliquez dessus pour activer votre compte.</p>
          <Link to="/connexion" className="btn btn-primary btn-md mt-6">Aller à la connexion</Link>
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Créer un compte" subtitle="9 crédits offerts pour votre première création."
      footer={<>Déjà inscrit ? <Link to="/connexion" className="font-semibold text-brand-300 hover:text-brand-200">Se connecter</Link></>}>
      <Card className="p-6">
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4" noValidate>
          <Input label="Nom complet" autoComplete="name" required value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Prénom Nom" />
          <Input label="Adresse e-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@exemple.com" />
          <div className="relative">
            <Input label="Mot de passe" type={show ? 'text' : 'password'} autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8 caractères minimum" hint="Au moins 8 caractères." />
            <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-3 top-[36px] text-slate-500 hover:text-white" aria-label={show ? 'Masquer' : 'Afficher'}>
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <Input label="Confirmer le mot de passe" type={show ? 'text' : 'password'} autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" />
          <label className="flex items-start gap-2.5 text-xs leading-relaxed text-slate-400">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand-500" />
            <span>J’accepte les <Link to="/conditions" className="text-brand-300">conditions d’utilisation</Link> et la <Link to="/confidentialite" className="text-brand-300">politique de confidentialité</Link>, et je confirme disposer des droits sur les avatars et contenus que je génère.</span>
          </label>
          {error && <ErrorState message={error} />}
          <Button type="submit" className="w-full" size="lg" loading={submitting} icon={<UserPlus size={16} />}>Créer mon compte</Button>
        </form>
      </Card>
    </AuthShell>
  );
}
