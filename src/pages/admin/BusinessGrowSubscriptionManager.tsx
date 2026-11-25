/*
 * Attribution manuelle d'une formule SORAHNEX Grow (administration).
 *
 * ## Pourquoi ce composant existe
 * Les formules SORAHNEX Grow n'ont pas de prix et la facturation est
 * désactivée : aucun compte ne peut souscrire en ligne. Tant que les tarifs ne
 * sont pas définis, seul un administrateur peut ouvrir l'accès à un compte
 * précis, pour une durée précise, par la RPC `vyora_admin_set_business_subscription`.
 *
 * ## Ce que ce composant ne fait PAS
 * - Il ne décide rien : le rôle administrateur, l'identité du compte ciblé, la
 *   formule et la date de fin sont revérifiés en base. Un client modifié ne
 *   peut rien obtenir de plus.
 * - Il n'active aucun paiement et n'invente aucun prix.
 * - Il n'accorde rien automatiquement : chaque attribution est un geste
 *   explicite, journalisé avec son auteur, sa cible, sa formule et sa date.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Brain, CalendarClock, ShieldCheck, XCircle } from 'lucide-react';

import { Badge, Banner, Button, Input, Modal, Select } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import {
  adminRevokeBusinessSubscription, adminSetBusinessSubscription, listBusinessGrowPlans,
  type AdminBusinessSubscriptionResult,
} from '../../lib/api';

/** Durées proposées — l'administrateur peut aussi saisir une date précise. */
const DUREES: Array<{ label: string; jours: number }> = [
  { label: '30 jours', jours: 30 },
  { label: '90 jours', jours: 90 },
  { label: '180 jours', jours: 180 },
  { label: '365 jours', jours: 365 },
];

/** Date de fin par défaut (J+30), au format attendu par `<input type="date">`. */
export function defaultPeriodEndInput(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 30 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Convertit la date saisie (jour, fuseau local) en instant de fin : fin de
 * journée locale, pour que « jusqu'au 30/11 » inclue bien le 30/11.
 * Renvoie `null` si la date n'est pas exploitable, passée, ou au-delà de 366 j
 * (mêmes bornes que la RPC — qui reste seule juge).
 */
export function parsePeriodEndInput(value: string, now: Date = new Date()): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const end = new Date(y, m - 1, d, 23, 59, 59, 0);
  if (Number.isNaN(end.getTime())) return null;
  if (end.getTime() <= now.getTime()) return null;
  if (end.getTime() > now.getTime() + 366 * 86_400_000) return null;
  return end;
}

/** Traduction des codes d'erreur de la RPC vers un message actionnable. */
export function describeAdminSubscriptionError(message: string): string {
  const code = message.trim();
  // `rpc()` humanise déjà certains codes (« forbidden » devient un message de droits) : on les reconnaît aussi.
  if (/forbidden|droits nécessaires/i.test(code)) return 'Réservé aux administrateurs : le serveur a refusé l’opération.';
  switch (code) {
    case 'not_authenticated': return 'Session expirée : reconnectez-vous.';
    case 'target_required': return 'Aucun compte ciblé.';
    case 'target_not_found': return 'Ce compte n’existe pas.';
    case 'target_not_vyora_customer': return 'Ce compte n’est pas un compte client SORAHNEX (ou c’est un administrateur) : attribution refusée.';
    case 'self_assignment_forbidden': return 'Un administrateur ne peut pas s’attribuer une formule à lui-même.';
    case 'plan_not_found': return 'Formule inconnue.';
    case 'plan_inactive': return 'Cette formule n’est plus proposée.';
    case 'period_end_must_be_future': return 'La date de fin doit être dans le futur.';
    case 'period_end_too_far': return 'La date de fin ne peut pas dépasser 366 jours.';
    case 'subscription_conflict': return 'Ce compte a déjà un abonnement payé en cours : aucune attribution manuelle ne l’écrase.';
    case 'manual_subscription_not_found': return 'Aucune attribution manuelle active à résilier pour ce compte.';
    default: return message;
  }
}

export default function BusinessGrowSubscriptionManager({ user, onClose, onApplied }: {
  user: { id: string; email: string } | null;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const toast = useToast();
  const [plans, setPlans] = useState<Array<{ plan_key: string; display_name: string }>>([]);
  const [plansError, setPlansError] = useState('');
  const [planKey, setPlanKey] = useState('');
  const [periodEnd, setPeriodEnd] = useState(defaultPeriodEndInput());
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AdminBusinessSubscriptionResult | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    if (!user) return;
    setResult(null); setNote(''); setPeriodEnd(defaultPeriodEndInput()); setConfirmRevoke(false); setPlansError('');
    listBusinessGrowPlans()
      .then((rows) => {
        const actives = rows.filter((p) => p.active);
        setPlans(actives);
        setPlanKey((current) => current || actives[0]?.plan_key || '');
      })
      .catch((err) => setPlansError(asAppError(err, 'Impossible de charger les formules SORAHNEX Grow.').message));
  }, [user]);

  const periodEndDate = useMemo(() => parsePeriodEndInput(periodEnd), [periodEnd]);
  const canSubmit = Boolean(user && planKey && periodEndDate && !submitting);

  const applyDuration = (jours: number) => {
    setPeriodEnd(new Date(Date.now() + jours * 86_400_000).toISOString().slice(0, 10));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || !planKey || !periodEndDate) return;
    setSubmitting(true);
    try {
      const res = await adminSetBusinessSubscription({ userId: user.id, planKey, periodEnd: periodEndDate, note });
      setResult(res);
      toast.success(res.renewed ? 'Formule SORAHNEX Grow renouvelée.' : 'Formule SORAHNEX Grow attribuée.');
      onApplied?.();
    } catch (err) {
      toast.error(describeAdminSubscriptionError(asAppError(err).message));
    } finally {
      setSubmitting(false);
    }
  };

  const revoke = async () => {
    if (!user) return;
    setSubmitting(true);
    try {
      const res = await adminRevokeBusinessSubscription(user.id, note);
      setResult(res);
      setConfirmRevoke(false);
      toast.success('Attribution SORAHNEX Grow résiliée : accès fermé.');
      onApplied?.();
    } catch (err) {
      toast.error(describeAdminSubscriptionError(asAppError(err).message));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={Boolean(user)}
      onClose={onClose}
      title="Abonnement SORAHNEX Grow (attribution manuelle)"
      description={user?.email ?? ''}
      size="md"
    >
      <Banner tone="info" title="Aucune facturation engagée">
        Les formules SORAHNEX Grow n’ont pas de prix et la souscription en ligne est désactivée.
        Cette attribution ouvre l’accès au compte ciblé jusqu’à la date de fin, puis se ferme seule.
        Elle est journalisée avec votre identité. Le serveur revérifie le rôle administrateur, le compte
        ciblé, la formule et la date.
      </Banner>

      {plansError && <p className="mt-3 text-xs text-rose-300">{plansError}</p>}

      <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-3" data-testid="bg-admin-subscription-form">
        <label className="block text-xs text-slate-400">
          Formule
          <Select value={planKey} onChange={(e) => setPlanKey(e.target.value)} className="mt-1 w-full" disabled={plans.length === 0}>
            {plans.length === 0 && <option value="">Aucune formule active</option>}
            {plans.map((p) => <option key={p.plan_key} value={p.plan_key}>{p.display_name}</option>)}
          </Select>
        </label>

        <div>
          <label className="block text-xs text-slate-400">
            Fin d’accès (incluse, heure locale)
            <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="mt-1 w-full" />
          </label>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {DUREES.map((d) => (
              <Button key={d.jours} type="button" size="sm" variant="ghost" icon={<CalendarClock size={12} />} onClick={() => applyDuration(d.jours)}>
                {d.label}
              </Button>
            ))}
          </div>
          {!periodEndDate && (
            <p className="mt-1 text-xs text-amber-300">Date invalide : elle doit être future et à moins de 366 jours.</p>
          )}
        </div>

        <label className="block text-xs text-slate-400">
          Motif (journalisé, facultatif)
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Ex. : compte pilote, période d’essai encadrée…" className="mt-1 w-full" />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" icon={<XCircle size={13} />} onClick={() => setConfirmRevoke(true)} disabled={submitting}>
            Résilier l’attribution
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Fermer</Button>
            <Button type="submit" icon={<Brain size={14} />} loading={submitting} disabled={!canSubmit}>
              Attribuer la formule
            </Button>
          </div>
        </div>
      </form>

      {confirmRevoke && (
        <div className="mt-3 rounded-xl border border-rose-400/25 bg-rose-400/[0.06] p-3 text-xs text-rose-100">
          <p className="font-medium">Résilier l’attribution manuelle de ce compte ?</p>
          <p className="mt-1 opacity-80">L’accès à Import & Connect se ferme immédiatement. L’opération est journalisée.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(false)} disabled={submitting}>Annuler</Button>
            <Button size="sm" variant="danger" loading={submitting} onClick={() => void revoke()}>Confirmer la résiliation</Button>
          </div>
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-xl border border-line bg-white/[0.02] p-3 text-xs" data-testid="bg-admin-subscription-result">
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} className="text-emerald-300" />
            <p className="font-medium text-white">Résultat vérifié par le serveur</p>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-slate-300">
            <dt className="text-slate-500">Statut</dt>
            <dd><Badge tone={result.status === 'active' ? 'success' : 'neutral'}>{result.status}</Badge></dd>
            {result.plan_key && (<><dt className="text-slate-500">Formule</dt><dd>{result.plan_key}</dd></>)}
            {result.current_period_end && (
              <><dt className="text-slate-500">Fin d’accès</dt><dd>{new Date(result.current_period_end).toLocaleString('fr-FR')}</dd></>
            )}
            {result.reference && (<><dt className="text-slate-500">Référence</dt><dd className="truncate">{result.reference}</dd></>)}
            <dt className="text-slate-500">Accès Import &amp; Connect</dt>
            <dd>
              <Badge tone={result.access.allowed ? 'success' : 'warning'}>{result.access.allowed ? 'ouvert' : 'fermé'}</Badge>
              <span className="ml-1.5 text-slate-400">{result.access.message}</span>
            </dd>
          </dl>
        </div>
      )}
    </Modal>
  );
}
