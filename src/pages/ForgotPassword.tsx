import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Mail, MailCheck } from 'lucide-react';
import AuthShell from '../components/AuthShell';
import { AuthField, AuthNotice, AuthSubmit, type AuthSubmitState } from '../components/auth/AuthForm';
import { sendPasswordReset } from '../lib/api';
import { asAppError } from '../lib/errors';

/**
 * Mot de passe oublié — même logique et mêmes messages qu'auparavant
 * (« Adresse e-mail invalide. », message neutre après envoi : aucune
 * divulgation de l'existence d'un compte), habillage immersif.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [state, setState] = useState<AuthSubmitState>('idle');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Adresse e-mail invalide.'); return; }
    setSending(true);
    setState('loading');
    try {
      await sendPasswordReset(email.trim());
      setState('success');
      window.setTimeout(() => { setSent(true); setState('idle'); setSending(false); }, 340);
    } catch (err) {
      setState('idle');
      setSending(false);
      setError(asAppError(err).message);
    }
  };

  return (
    <AuthShell
      variant="secure"
      eyebrow="Récupération d’accès"
      title="Mot de passe oublié"
      subtitle="Nous vous envoyons un lien sécurisé pour le réinitialiser."
      footer={
        <Link to="/connexion" className="inline-flex items-center gap-1.5 font-semibold text-cyan-300 transition hover:text-cyan-200">
          <ArrowLeft size={14} /> Retour à la connexion
        </Link>
      }
    >
      <div className="vy-auth-card p-5 sm:p-7" data-state={sent ? 'success' : error ? 'error' : undefined}>
        {sent ? (
          <div className="vy-step-enter py-4 text-center">
            <span className="vy-in-scale mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.09] text-emerald-300">
              <MailCheck size={30} />
            </span>
            <h2 className="mt-5 font-display text-lg font-semibold text-white">E-mail envoyé</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Si un compte existe pour <strong className="text-white">{email}</strong>, vous recevrez un lien de réinitialisation. Vérifiez aussi vos courriers indésirables.
            </p>
            <Link to="/connexion" className="vy-btn vy-btn-ghost-accent mt-6 inline-flex min-h-11 px-4 text-[12.5px]">
              Retour à la connexion
            </Link>
          </div>
        ) : (
          <form onSubmit={(e) => void onSubmit(e)} className="space-y-4" noValidate>
            <AuthField
              label="Adresse e-mail"
              type="email"
              required
              autoFocus
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (error) setError(''); }}
              placeholder="vous@exemple.com"
              icon={<Mail size={15} />}
              hint="Le lien expire après usage et ne révèle jamais l’existence d’un compte."
            />
            {error && <AuthNotice>{error}</AuthNotice>}
            <AuthSubmit
              state={state}
              disabled={sending}
              loadingLabel="Envoi du lien…"
              successLabel="Lien envoyé"
              icon={<Mail size={16} />}
            >
              Envoyer le lien
            </AuthSubmit>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
