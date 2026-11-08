import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, MailCheck } from 'lucide-react';
import AuthShell from '../components/AuthShell';
import { Button, Card, ErrorState, Input } from '../components/ui';
import { sendPasswordReset } from '../lib/api';
import { asAppError } from '../lib/errors';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Adresse e-mail invalide.'); return; }
    setSending(true);
    try { await sendPasswordReset(email.trim()); setSent(true); }
    catch (err) { setError(asAppError(err).message); }
    finally { setSending(false); }
  };

  return (
    <AuthShell title="Mot de passe oublié" subtitle="Nous vous envoyons un lien sécurisé pour le réinitialiser."
      footer={<Link to="/connexion" className="inline-flex items-center gap-1.5 font-semibold text-brand-300"><ArrowLeft size={14} /> Retour à la connexion</Link>}>
      <Card className="p-6">
        {sent ? (
          <div className="py-6 text-center">
            <MailCheck className="mx-auto text-emerald-400" size={38} />
            <h2 className="mt-4 text-base font-semibold text-white">E-mail envoyé</h2>
            <p className="mt-2 text-sm text-slate-400">Si un compte existe pour <strong className="text-white">{email}</strong>, vous recevrez un lien de réinitialisation. Vérifiez aussi vos courriers indésirables.</p>
          </div>
        ) : (
          <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
            <Input label="Adresse e-mail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@exemple.com" />
            {error && <ErrorState message={error} />}
            <Button type="submit" size="lg" className="w-full" loading={sending}>Envoyer le lien</Button>
          </form>
        )}
      </Card>
    </AuthShell>
  );
}
