import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, CheckCircle2, Clapperboard, LockKeyhole, Mail, Sparkles, UserPlus, UserRound,
} from 'lucide-react';
import AuthShell from '../components/AuthShell';
import {
  AuthField, AuthNotice, AuthSteps, AuthSubmit, PasswordMeter, type AuthSubmitState,
} from '../components/auth/AuthForm';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { signUp } from '../lib/api';
import { asAppError } from '../lib/errors';
import { cn } from '../components/ui';

const STEPS = ['Identité', 'Accès sécurisé', 'Confirmation'] as const;

/**
 * Inscription — parcours en étapes.
 *
 * Les règles et messages d'origine sont conservés au mot près (nom, e-mail,
 * 8 caractères, correspondance, conditions). Elles sont simplement réparties
 * sur trois étapes : « Continuer » valide l'étape courante, « Créer mon
 * compte » envoie le formulaire complet.
 */
export default function Signup() {
  const { user, isAdmin, loading } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accept, setAccept] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [state, setState] = useState<AuthSubmitState>('idle');
  const [error, setError] = useState('');
  const [needConfirmation, setNeedConfirmation] = useState(false);

  useEffect(() => {
    if (user && !loading) navigate(isAdmin ? '/admin' : '/app', { replace: true });
  }, [user, loading, isAdmin, navigate]);

  const emailValid = useMemo(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()), [email]);
  const nameValid = fullName.trim().length > 1;
  const confirmValid = confirm.length > 0 && password === confirm;

  const validateStep = (index: number): string | null => {
    if (index === 0) {
      if (!fullName.trim()) return 'Indiquez votre nom.';
      if (!emailValid) return 'Adresse e-mail invalide.';
      return null;
    }
    if (index === 1) {
      if (password.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères.';
      if (password !== confirm) return 'Les deux mots de passe ne correspondent pas.';
      return null;
    }
    return null;
  };

  const goNext = () => {
    setError('');
    const problem = validateStep(step);
    if (problem) { setError(problem); return; }
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const goBack = () => {
    setError('');
    setState('idle');
    setStep((current) => Math.max(current - 1, 0));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!fullName.trim()) { setStep(0); setError('Indiquez votre nom.'); return; }
    if (!emailValid) { setStep(0); setError('Adresse e-mail invalide.'); return; }
    if (password.length < 8) { setStep(1); setError('Le mot de passe doit contenir au moins 8 caractères.'); return; }
    if (password !== confirm) { setStep(1); setError('Les deux mots de passe ne correspondent pas.'); return; }
    if (!accept) { setError('Vous devez accepter les conditions d’utilisation.'); return; }
    setSubmitting(true);
    setState('loading');
    try {
      const data = await signUp(email.trim(), password, fullName.trim());
      if (data.session) {
        setState('success');
        toast.success('Votre espace SORAHNEX est prêt !');
        window.setTimeout(() => navigate('/app', { replace: true }), 380);
      } else {
        setState('idle');
        setSubmitting(false);
        setNeedConfirmation(true);
      }
    } catch (err) {
      setState('idle');
      setSubmitting(false);
      setError(asAppError(err, 'Inscription impossible.').message);
    }
  };

  if (needConfirmation) {
    return (
      <AuthShell
        variant="create"
        eyebrow="Dernière étape"
        title="Vérifiez votre e-mail"
        subtitle="Une dernière étape avant de créer vos vidéos."
      >
        <div className="vy-auth-card p-6 text-center sm:p-8">
          <span className="vy-in-scale mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.09] text-emerald-300">
            <CheckCircle2 size={30} />
          </span>
          <h2 className="mt-5 font-display text-lg font-semibold text-white">Le lien est parti</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            Un lien de confirmation a été envoyé à <strong className="text-white">{email}</strong>. Cliquez dessus pour activer votre compte.
          </p>
          <div className="mt-6 grid gap-2">
            <Link to="/connexion" className="vy-btn vy-btn-accent min-h-12 w-full px-5 text-[14px]">
              Aller à la connexion <ArrowRight size={16} />
            </Link>
            <button
              type="button"
              onClick={() => { setNeedConfirmation(false); setStep(1); }}
              className="vy-btn min-h-11 w-full text-[12px] text-slate-400 hover:text-white"
            >
              Modifier mon adresse e-mail
            </button>
          </div>
        </div>
      </AuthShell>
    );
  }

  const currentStep = Math.min(step, 2);

  return (
    <AuthShell
      variant="create"
      eyebrow="9 crédits offerts"
      title="Créer un compte"
      subtitle="9 crédits offerts pour votre première création."
      footer={<>Déjà inscrit ? <Link to="/connexion" className="font-semibold text-cyan-300 transition hover:text-cyan-200">Se connecter</Link></>}
    >
      <div className="vy-auth-card p-5 sm:p-7" data-state={state === 'success' ? 'success' : error ? 'error' : undefined}>
        <AuthSteps labels={STEPS} current={currentStep} />

        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4" noValidate>
          {/* -------- Étape 1 : identité -------- */}
          {currentStep === 0 && (
            <div className="vy-step-enter space-y-4">
              <AuthField
                label="Nom complet"
                autoComplete="name"
                required
                autoFocus
                value={fullName}
                onChange={(e) => { setFullName(e.target.value); if (error) setError(''); }}
                placeholder="Prénom Nom"
                icon={<UserRound size={15} />}
                valid={nameValid}
                hint="Ce nom personnalisera votre accueil SORAHNEX."
              />
              <AuthField
                label="Adresse e-mail"
                type="email"
                autoComplete="email"
                required
                inputMode="email"
                spellCheck={false}
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (error) setError(''); }}
                placeholder="vous@exemple.com"
                icon={<Mail size={15} />}
                valid={emailValid}
              />
            </div>
          )}

          {/* -------- Étape 2 : accès sécurisé -------- */}
          {currentStep === 1 && (
            <div className="vy-step-enter space-y-4">
              <div>
                <AuthField
                  label="Mot de passe"
                  autoComplete="new-password"
                  required
                  autoFocus
                  revealable
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); if (error) setError(''); }}
                  placeholder="8 caractères minimum"
                  icon={<LockKeyhole size={15} />}
                  hint="Au moins 8 caractères."
                />
                <PasswordMeter value={password} />
              </div>
              <AuthField
                label="Confirmer le mot de passe"
                autoComplete="new-password"
                required
                revealable
                value={confirm}
                onChange={(e) => { setConfirm(e.target.value); if (error) setError(''); }}
                placeholder="••••••••"
                icon={<LockKeyhole size={15} />}
                valid={confirmValid}
                error={confirm.length > 0 && password !== confirm ? 'Les mots de passe ne correspondent pas encore.' : undefined}
                hint={password.length >= 8 ? 'Les deux champs doivent être identiques.' : undefined}
              />
            </div>
          )}

          {/* -------- Étape 3 : confirmation -------- */}
          {currentStep === 2 && (
            <div className="vy-step-enter space-y-4">
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3.5">
                <p className="vy-metric-label">Votre futur espace</p>
                <div className="mt-2 flex items-center gap-2.5">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-cyan-300/25 to-violet-400/25 font-display text-[13px] font-bold text-white">
                    {(fullName.trim()[0] ?? 'V').toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-white">{fullName.trim() || 'Votre nom'}</p>
                    <p className="truncate text-[11.5px] text-slate-500">{email.trim() || 'votre adresse e-mail'}</p>
                  </div>
                  <button type="button" onClick={() => setStep(0)} className="ml-auto shrink-0 text-[11px] font-medium text-cyan-300 hover:text-cyan-200">Modifier</button>
                </div>
              </div>

              <div className="grid gap-2">
                {[
                  { icon: Clapperboard, title: 'SORAHNEX Studio', text: 'Vidéos UGC, scripts, avatars et montage.' },
                  { icon: Sparkles, title: 'SORAHNEX Grow', text: 'Pilotage, revenus et modules métier.' },
                ].map((item) => (
                  <div key={item.title} className="flex items-start gap-2.5 rounded-xl border border-white/[0.07] bg-black/20 p-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-cyan-200">
                      <item.icon size={14} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[12px] font-semibold text-white">{item.title}</p>
                      <p className="text-[11px] leading-relaxed text-slate-500">{item.text}</p>
                    </div>
                  </div>
                ))}
              </div>

              <label className="flex items-start gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-[11.5px] leading-relaxed text-slate-400">
                <input
                  type="checkbox"
                  checked={accept}
                  onChange={(e) => { setAccept(e.target.checked); if (error) setError(''); }}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-cyan-400"
                />
                <span>
                  J’accepte les <Link to="/conditions" className="font-medium text-cyan-300 hover:text-cyan-200">conditions d’utilisation</Link> et la{' '}
                  <Link to="/confidentialite" className="font-medium text-cyan-300 hover:text-cyan-200">politique de confidentialité</Link>, et je confirme disposer des droits sur les avatars et contenus que je génère.
                </span>
              </label>
            </div>
          )}

          {error && <AuthNotice>{error}</AuthNotice>}

          {/* -------- Navigation d'étapes -------- */}
          {currentStep < 2 ? (
            <div className="flex items-center gap-2 pt-1">
              {currentStep > 0 && (
                <button type="button" onClick={goBack} className="vy-btn min-h-12 shrink-0 border border-white/[0.09] bg-white/[0.03] px-4 text-[12.5px] text-slate-300 hover:text-white">
                  <ArrowLeft size={15} /> Retour
                </button>
              )}
              <button
                type="button"
                onClick={goNext}
                className="vy-btn vy-btn-accent min-h-12 flex-1 px-5 text-[14px]"
              >
                Continuer <ArrowRight size={16} />
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 pt-1 sm:flex-row-reverse">
              <AuthSubmit
                state={state}
                disabled={submitting}
                loadingLabel="Création du compte…"
                successLabel="Compte créé — bienvenue !"
                icon={<UserPlus size={16} />}
                className="flex-1"
              >
                Créer mon compte
              </AuthSubmit>
              <button type="button" onClick={goBack} className="vy-btn min-h-12 border border-white/[0.09] bg-white/[0.03] px-4 text-[12.5px] text-slate-300 hover:text-white sm:w-auto">
                <ArrowLeft size={15} /> Retour
              </button>
            </div>
          )}
        </form>

        <div className={cn('mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-t border-white/[0.07] pt-4 text-[10.5px] text-slate-500')}>
          <span className="inline-flex items-center gap-1.5"><LockKeyhole size={11} className="text-emerald-400/80" /> Mot de passe chiffré</span>
          <span aria-hidden="true" className="h-3 w-px bg-white/10" />
          <span>Données isolées par espace</span>
        </div>
      </div>
    </AuthShell>
  );
}
