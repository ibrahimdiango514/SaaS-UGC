import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { updatePassword } from '../lib/api';
import { asAppError } from '../lib/errors';
import { Button, Card, ErrorState, Input, LoadingState } from '../components/ui';
import AuthShell from '../components/AuthShell';

export default function AuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [isRecovery, setIsRecovery] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    const type = new URLSearchParams(hash.replace(/^#/, '')).get('type') || params.get('type');
    if (type === 'recovery') { setIsRecovery(true); return; }
    const next = params.get('next');
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) navigate(next && next.startsWith('/') ? next : '/app', { replace: true });
    }, 1200);
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) { window.clearTimeout(timer); navigate(next && next.startsWith('/') ? next : '/app', { replace: true }); }
    });
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [navigate, params]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    if (password.length < 8) { setError('Le mot de passe doit contenir au moins 8 caractères.'); return; }
    if (password !== confirm) { setError('Les mots de passe ne correspondent pas.'); return; }
    setSaving(true);
    try { await updatePassword(password); setDone(true); window.setTimeout(() => navigate('/app/parametres', { replace: true }), 1200); }
    catch (err) { setError(asAppError(err).message); }
    finally { setSaving(false); }
  };

  if (isRecovery) {
    return (
      <AuthShell title="Nouveau mot de passe" subtitle="Choisissez un mot de passe d’au moins 8 caractères."
        footer={<Link to="/connexion" className="font-semibold text-brand-300">Retour à la connexion</Link>}>
        <Card className="p-6">
          {done ? <p className="py-6 text-center text-sm text-emerald-300">Mot de passe mis à jour. Redirection…</p> : (
            <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
              <Input label="Nouveau mot de passe" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <Input label="Confirmer" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              {error && <ErrorState message={error} />}
              <Button type="submit" size="lg" className="w-full" loading={saving}>Enregistrer</Button>
            </form>
          )}
        </Card>
      </AuthShell>
    );
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-sm p-8 text-center">
        <LoadingState label="Connexion en cours…" />
        <p className="mt-2 text-xs text-slate-500">Vous serez redirigé automatiquement.</p>
        <Link to="/connexion" className="mt-4 inline-block text-xs text-brand-300">Aller à la connexion</Link>
      </Card>
    </div>
  );
}
