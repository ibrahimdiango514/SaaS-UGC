/*
 * Gestion réelle des crédits d'un client (administration).
 *
 * Chaque opération passe par la RPC transactionnelle `vyora_admin_credit_movement`
 * (permission admin vérifiée en base, contrôle de solde, idempotence par clé,
 * journal d'audit avec l'administrateur responsable, solde avant/après renvoyé).
 * Aucun solde n'est écrit depuis le frontend.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Coins, History, Minus, Plus, ShieldCheck } from 'lucide-react';

import { Badge, Button, Input, LoadingState, Modal } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import { adminCreditHistory, adminCreditMovement } from '../../lib/api';
import type { AdminCreditHistory, AdminCreditMovement } from '../../lib/types';

/** Clé d'idempotence unique par tentative d'opération (protège du double envoi). */
export function newIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `adm-${random}`;
  return `adm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function CreditManager({ user, onClose, onApplied }: {
  user: { id: string; email: string } | null;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const toast = useToast();
  const [history, setHistory] = useState<AdminCreditHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('100');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AdminCreditMovement | null>(null);
  const [pendingKey, setPendingKey] = useState<string>('');
  const [confirmRemoval, setConfirmRemoval] = useState(false);

  const loadHistory = useCallback(async (userId: string) => {
    setLoading(true); setError('');
    try { setHistory(await adminCreditHistory(userId, 25)); }
    catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!user) return;
    setResult(null); setReason(''); setAmount('100'); setMode('add'); setConfirmRemoval(false);
    setPendingKey(newIdempotencyKey());
    void loadHistory(user.id);
  }, [user, loadHistory]);

  const parsedAmount = Number(amount);
  const signedDelta = mode === 'add' ? Math.abs(parsedAmount || 0) : -Math.abs(parsedAmount || 0);
  const balance = history?.balance ?? 0;
  const projected = useMemo(() => balance + signedDelta, [balance, signedDelta]);
  const amountValid = Number.isInteger(parsedAmount) && Math.abs(parsedAmount) > 0 && Math.abs(parsedAmount) <= 100000;
  const reasonValid = reason.trim().length >= 3;
  const insufficient = signedDelta < 0 && projected < 0;
  const blocked = !amountValid || !reasonValid || insufficient || (mode === 'remove' && !confirmRemoval);
  const changed = projected !== balance;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || blocked || submitting) return;
    setSubmitting(true); setError('');
    try {
      const movement = await adminCreditMovement(user.id, signedDelta, reason.trim(), pendingKey);
      setResult(movement);
      if (movement.replayed) toast.warning('Opération déjà appliquée : aucun second débit.');
      else toast.success(`Solde mis à jour : ${movement.balance_before} → ${movement.balance_after}.`);
      setPendingKey(newIdempotencyKey());
      setReason(''); setAmount('100'); setConfirmRemoval(false);
      await loadHistory(user.id);
      onApplied?.();
    } catch (err) {
      const message = asAppError(err).message;
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={Boolean(user)}
      onClose={onClose}
      title="Gérer les crédits"
      description={user?.email}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Fermer</Button>
        <Button type="submit" form="credit-movement-form" loading={submitting} disabled={blocked} icon={<Coins size={14} />}>
          {mode === 'add' ? 'Ajouter les crédits' : 'Retirer les crédits'}
        </Button>
      </>}
    >
      <div className="space-y-5" data-testid="credit-manager">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-line bg-white/[0.03] p-3">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Solde actuel</p>
            <p className="mt-1 text-xl font-bold text-white">{balance}</p>
          </div>
          <div className="rounded-xl border border-line bg-white/[0.03] p-3">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Réservé</p>
            <p className="mt-1 text-xl font-bold text-white">{history?.reserved ?? 0}</p>
          </div>
          <div className={`rounded-xl border p-3 ${insufficient ? 'border-rose-400/40 bg-rose-400/[0.06]' : 'border-line bg-white/[0.03]'}`}>
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Solde après opération</p>
            <p className={`mt-1 text-xl font-bold ${insufficient ? 'text-rose-300' : 'text-emerald-300'}`}>{changed ? projected : balance}</p>
          </div>
        </div>

        <form id="credit-movement-form" onSubmit={submit} className="space-y-4">
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={mode === 'add' ? 'primary' : 'outline'} icon={<Plus size={14} />}
              onClick={() => { setMode('add'); setConfirmRemoval(false); }}>Ajouter</Button>
            <Button type="button" size="sm" variant={mode === 'remove' ? 'primary' : 'outline'} icon={<Minus size={14} />}
              onClick={() => { setMode('remove'); setConfirmRemoval(false); }}>Retirer</Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Montant (crédits)" type="number" min={1} max={100000} value={amount}
              onChange={(event) => setAmount(event.target.value)} />
            <Input label="Motif (obligatoire, tracé dans l’audit)" value={reason}
              onChange={(event) => setReason(event.target.value)} placeholder="Ex. geste commercial ticket #142" />
          </div>

          {mode === 'remove' && (
            <label className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-3 text-xs text-amber-100">
              <input type="checkbox" checked={confirmRemoval} onChange={(event) => setConfirmRemoval(event.target.checked)} className="mt-0.5" />
              <span>Je confirme le retrait de {Math.abs(parsedAmount || 0)} crédits. Le mouvement sera journalisé et ne pourra pas être supprimé.</span>
            </label>
          )}

          {insufficient && (
            <p className="text-xs text-rose-300">
              Retrait impossible : le solde deviendrait négatif ({projected}). Le serveur refusera l’opération.
            </p>
          )}
          {!reasonValid && reason.length > 0 && <p className="text-xs text-amber-300">Le motif doit contenir au moins 3 caractères.</p>}
          {error ? <p className="text-xs text-rose-300">{error}</p> : null}
        </form>

        {result ? (
          <div className={`rounded-xl border p-4 text-sm ${result.replayed ? 'border-amber-400/30 bg-amber-400/[0.06] text-amber-100' : 'border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-100'}`} data-testid="credit-result">
            <p className="flex items-center gap-2 font-semibold">
              <ShieldCheck size={16} />
              {result.replayed ? 'Opération déjà appliquée (aucun doublon)' : 'Opération appliquée et journalisée'}
            </p>
            <p className="mt-1 text-xs">
              Solde {result.balance_before} → <span className="font-semibold">{result.balance_after}</span>
              {result.delta !== 0 ? ` (${result.delta > 0 ? '+' : ''}${result.delta})` : ''} · motif : {result.reason}
            </p>
            <p className="mt-1 font-mono text-[10px] text-emerald-200/60">mouvement {result.ledger_id}</p>
          </div>
        ) : null}

        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-white"><History size={15} /> Historique des mouvements</p>
          {loading && !history ? <LoadingState label="Chargement de l’historique…" /> : !history || history.entries.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">Aucun mouvement de crédits pour ce client.</p>
          ) : (
            <div className="mt-2 max-h-64 overflow-auto rounded-xl border border-line">
              <table className="table" data-testid="credit-history">
                <thead><tr><th>Date</th><th>Mouvement</th><th>Motif</th><th>Type</th></tr></thead>
                <tbody>
                  {history.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="whitespace-nowrap text-xs text-slate-400">{formatDate(entry.created_at, true)}</td>
                      <td className={`font-semibold ${entry.delta > 0 ? 'text-emerald-300' : entry.delta < 0 ? 'text-rose-300' : 'text-slate-300'}`}>
                        {entry.delta > 0 ? '+' : ''}{entry.delta}
                      </td>
                      <td className="text-xs text-slate-300">{entry.description ?? '—'}</td>
                      <td><Badge tone="neutral">{entry.operation}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
