/**
 * Administration — remboursements et exploitation des paiements SasPay.
 *
 * Règles tenues par l'interface comme par la base :
 *  - VYORA n'envoie AUCUN argent. SasPay n'offre pas de remboursement par API :
 *    « rembourser » consiste à reprendre ce qui a été livré (crédits Studio ou
 *    jours d'abonnement Business Grow), puis à rendre l'argent hors de VYORA et à
 *    l'attester ici avec la référence du versement ;
 *  - le plafond du montant à rendre est calculé par le serveur, au prorata de ce
 *    qui est effectivement repris ;
 *  - un remboursement enregistré est définitif ;
 *  - une demande Mobile Money restée sans réponse de SasPay n'est ni payée ni
 *    échouée. Elle ne se « classe » pas : l'administrateur la tranche, soit en
 *    rattachant la transaction retrouvée (le serveur la relit chez SasPay et
 *    refuse tout écart), soit en attestant qu'aucun encaissement n'existe.
 */
import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, RefreshCw, ShieldAlert } from 'lucide-react';
import { Badge, Banner, Button, Card, CardHeader, Input, LoadingState, Modal, Textarea } from '../../components/ui';
import { asAppError } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import {
  ANOMALY_ADVICE, ANOMALY_LABELS, DECISION_ANOMALIES, RUN_STATUS_LABELS, adminAttachReviewPayment, adminCloseUnconfirmed,
  adminRecordRefund, adminRefundPreview, adminResolveAnomaly, adminSettleRefund, formatAmount, parseRefundAmount,
  type PaymentAnomaly, type PaymentHealth, type PaymentOrder, type RefundPreview, type ReviewCandidate,
  type UnconfirmedPayment,
} from '../../lib/payments';

const xof = (value: number | null | undefined) => formatAmount(value === null || value === undefined ? null : String(value));

const BLOCKED_LABELS: Record<string, string> = {
  already_refunded: 'Cette commande est déjà remboursée.',
  refund_requires_paid_order: 'Seul un paiement confirmé peut être remboursé.',
  refund_wallet_has_reserved_credits: 'Des générations sont en cours sur ce compte : attendez leur fin avant de rembourser.',
  refund_nothing_recoverable: 'Il ne reste rien à reprendre sur cette commande : aucun remboursement n’est possible depuis la console.',
  refund_subscription_missing: 'L’abonnement lié à ce paiement est introuvable.',
  refund_subscription_plan_changed: 'L’abonnement est passé à une autre formule depuis ce paiement : la période payée ici est terminée, il ne reste rien à reprendre.',
  refund_wallet_missing: 'Le solde de crédits de ce compte est introuvable.',
};

/** Résumé, en clair, de ce que le remboursement reprendra. */
function PreviewSummary({ preview }: { preview: RefundPreview }) {
  if (preview.product === 'studio') {
    return (
      <ul className="space-y-1 text-[12.5px] text-slate-300" data-testid="refund-preview">
        <li>Crédits livrés par cet achat : <strong className="text-white">{preview.credits_granted ?? '—'}</strong></li>
        <li>Crédits encore disponibles sur le compte : <strong className="text-white">{preview.wallet_available ?? '—'}</strong></li>
        <li>Crédits qui seront repris : <strong className="text-white">{preview.credits_recoverable ?? '—'}</strong></li>
        {(preview.credits_unrecoverable ?? 0) > 0 && (
          <li className="text-amber-200">Crédits déjà utilisés, non récupérables : <strong>{preview.credits_unrecoverable}</strong></li>
        )}
      </ul>
    );
  }
  if (preview.undelivered) {
    return (
      <ul className="space-y-1 text-[12.5px] text-slate-300" data-testid="refund-preview">
        <li className="text-amber-200">Ce paiement a été encaissé mais <strong>n’a jamais été appliqué</strong> : l’abonnement du client ne le permettait pas.</li>
        <li>Rien n’a été livré, il n’y a donc rien à reprendre : l’abonnement en cours et son quota restent inchangés.</li>
        <li>Le remboursement est <strong className="text-white">intégral</strong> : le montant encaissé, ni plus ni moins.</li>
      </ul>
    );
  }
  return (
    <ul className="space-y-1 text-[12.5px] text-slate-300" data-testid="refund-preview">
      <li>Période payée : <strong className="text-white">{preview.period_days ?? '—'} jours</strong></li>
      <li>Jours restants qui seront retirés : <strong className="text-white">{preview.days_recoverable ?? '—'}</strong></li>
      <li>
        {preview.will_cancel
          ? <span className="text-amber-200">L’abonnement sera résilié immédiatement et le quota ramené à sa valeur hors abonnement.</span>
          : <>L’abonnement reste actif jusqu’au <strong className="text-white">{formatDate(preview.new_period_end ?? null, true)}</strong>.</>}
      </li>
    </ul>
  );
}

export function RefundDialog({ order, onClose, onDone }: {
  order: PaymentOrder; onClose: () => void; onDone: (message: string) => void;
}) {
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [partialOk, setPartialOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    adminRefundPreview(order.product, order.id)
      .then((row) => {
        if (!alive) return;
        setPreview(row);
        // Proposé : le plafond calculé par le serveur. L'administrateur peut rendre moins.
        if (row.refundable) setAmount(String(row.max_refund_xof));
      })
      .catch((err) => { if (alive) setLoadError(asAppError(err, 'L’aperçu du remboursement n’a pas pu être calculé.').message); });
    return () => { alive = false; };
  }, [order.product, order.id]);

  const typed = preview ? parseRefundAmount(amount, preview.max_refund_xof) : null;
  // Encaissement jamais appliqué : seul le montant intégral est accepté (le serveur le revérifie).
  const parsed = preview?.undelivered && typed !== preview.max_refund_xof ? null : typed;
  const reasonOk = reason.trim().length >= 5 && reason.trim().length <= 500;
  const ready = Boolean(preview?.refundable) && parsed !== null && reasonOk && (!preview?.needs_partial || partialOk);

  const submit = async () => {
    if (!preview || parsed === null || !ready) return;
    setBusy(true); setError('');
    try {
      const result = await adminRecordRefund({
        product: order.product, orderId: order.id, reason: reason.trim(), amountXof: parsed, allowPartial: partialOk,
      });
      onDone(result.outcome === 'already_refunded'
        ? `Commande ${order.internal_reference} : déjà remboursée, rien n’a été repris une seconde fois.`
        : `Remboursement enregistré pour ${order.internal_reference}. Rendez ${xof(parsed)} au client, puis attestez le versement.`);
    } catch (err) {
      setError(asAppError(err, 'Le remboursement n’a pas pu être enregistré.').message);
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open onClose={busy ? () => undefined : onClose}
      title="Enregistrer un remboursement"
      description={`${order.label ?? 'Commande'} · ${formatAmount(order.amount, order.currency)} · ${order.internal_reference}`}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button variant="danger" loading={busy} disabled={!ready} onClick={() => void submit()}>
            {preview?.undelivered ? 'Enregistrer le remboursement' : 'Reprendre et enregistrer'}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <Banner tone="warning" title="VYORA n’envoie pas d’argent">
          SasPay ne propose pas de remboursement automatique. Cette action reprend ce qui a été livré et clôt la commande ;
          vous rendez ensuite l’argent au client par vos propres moyens, puis vous attestez le versement. Elle est définitive.
        </Banner>
        {loadError && <Banner tone="danger" title="Aperçu indisponible">{loadError}</Banner>}
        {!preview && !loadError && <LoadingState label="Calcul de ce qui peut être repris…" />}
        {preview && !preview.refundable && (
          <Banner tone="danger" title="Remboursement impossible">
            {BLOCKED_LABELS[preview.blocked ?? ''] ?? 'Cette commande ne peut pas être remboursée.'}
          </Banner>
        )}
        {preview && preview.refundable && (
          <>
            <PreviewSummary preview={preview} />
            <p className="text-[12.5px] text-slate-300">
              Montant maximal à rendre : <strong className="text-white" data-testid="refund-max">{xof(preview.max_refund_xof)}</strong>
              {preview.needs_partial && <> sur {xof(preview.price_xof)} payés (au prorata de ce qui est repris)</>}.
            </p>
            <Input
              label="Montant à rendre au client (FCFA)" inputMode="numeric" value={amount}
              onChange={(e) => setAmount(e.target.value)} disabled={Boolean(preview.undelivered)}
              error={amount !== '' && parsed === null
                ? (preview.undelivered
                  ? `Ce paiement n’a pas été appliqué : rendez exactement ${preview.max_refund_xof} FCFA.`
                  : `Saisissez un montant entier entre 1 et ${preview.max_refund_xof} FCFA.`)
                : undefined}
            />
            <Textarea
              label="Motif (note interne, non montrée au client)" rows={3} maxLength={500} value={reason}
              onChange={(e) => setReason(e.target.value)} hint="5 caractères minimum. Conservé dans le journal d’audit."
            />
            {preview.needs_partial && (
              <label className="flex items-start gap-2 text-[12.5px] text-amber-200">
                <input type="checkbox" className="mt-0.5" checked={partialOk} onChange={(e) => setPartialOk(e.target.checked)} />
                <span>Je confirme un remboursement partiel : une partie de l’achat a déjà été consommée et ne sera pas remboursée.</span>
              </label>
            )}
          </>
        )}
        {error && <Banner tone="danger" title="Enregistrement refusé">{error}</Banner>}
      </div>
    </Modal>
  );
}

export function SettleRefundDialog({ order, onClose, onDone }: {
  order: PaymentOrder; onClose: () => void; onDone: (message: string) => void;
}) {
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const text = reference.trim();
  const ready = text.length >= 3 && text.length <= 120;

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      await adminSettleRefund(order.product, order.id, text);
      onDone(`Versement attesté pour ${order.internal_reference}.`);
    } catch (err) {
      setError(asAppError(err, 'Le versement n’a pas pu être attesté.').message);
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open onClose={busy ? () => undefined : onClose}
      title="Attester le versement"
      description={`${order.internal_reference} · ${formatAmount(order.refund_amount, order.currency)} à rendre`}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button loading={busy} disabled={!ready} onClick={() => void submit()}>Attester le versement</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <p className="text-[12.5px] leading-relaxed text-slate-300">
          À remplir <strong className="text-white">après</strong> avoir rendu l’argent au client (transfert Mobile Money, décaissement
          depuis le tableau de bord SasPay…). VYORA ne vérifie pas ce versement : la référence saisie fait foi et ne pourra plus être changée.
        </p>
        <Input
          label="Référence du versement" value={reference} maxLength={120}
          onChange={(e) => setReference(e.target.value)} hint="Identifiant de la transaction de remboursement (3 caractères minimum)."
        />
        {error && <Banner tone="danger" title="Attestation refusée">{error}</Banner>}
      </div>
    </Modal>
  );
}

function ResolveAnomalyDialog({ anomaly, onClose, onDone }: {
  anomaly: PaymentAnomaly; onClose: () => void; onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = note.trim().length >= 5 && note.trim().length <= 500;

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    try { await adminResolveAnomaly(anomaly.id, note.trim()); onDone(); }
    catch (err) { setError(asAppError(err, 'L’anomalie n’a pas pu être classée.').message); }
    finally { setBusy(false); }
  };

  return (
    <Modal
      open onClose={busy ? () => undefined : onClose}
      title="Classer l’anomalie"
      description={ANOMALY_LABELS[anomaly.kind] ?? anomaly.kind}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button loading={busy} disabled={!ready} onClick={() => void submit()}>Classer</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <p className="text-[12.5px] leading-relaxed text-slate-300">
          Classer une anomalie ne modifie aucun paiement : cela consigne ce que vous avez fait. Si le problème persiste, elle réapparaîtra.
        </p>
        <Textarea label="Ce qui a été fait" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} hint="5 caractères minimum. Conservé dans le journal d’audit." />
        {error && <Banner tone="danger" title="Classement refusé">{error}</Banner>}
      </div>
    </Modal>
  );
}

const reviewNoteOk = (note: string) => note.trim().length >= 10 && note.trim().length <= 500;
const SASPAY_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Rattache une transaction SasPay à une commande restée sans réponse. Le serveur la relit et refuse tout écart. */
function AttachReviewDialog({ line, candidate, onClose, onDone }: {
  line: UnconfirmedPayment; candidate: ReviewCandidate | null; onClose: () => void; onDone: (message: string) => void;
}) {
  const [paymentId, setPaymentId] = useState(candidate?.id ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = SASPAY_ID.test(paymentId.trim()) && reviewNoteOk(note);

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      const result = await adminAttachReviewPayment({ product: line.product, orderId: line.order_id, paymentId: paymentId.trim(), note: note.trim() });
      onDone(result.credited
        ? `Paiement rattaché à ${line.internal_reference} : confirmé par SasPay, achat livré.`
        : `Paiement rattaché à ${line.internal_reference}. SasPay ne l’a pas (encore) confirmé : rien n’est livré, il sera revérifié automatiquement.`);
    } catch (err) {
      setError(asAppError(err, 'Le paiement n’a pas pu être rattaché.').message);
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open onClose={busy ? () => undefined : onClose}
      title="Rattacher un paiement SasPay"
      description={`${line.user_email ?? 'Client'} · ${formatAmount(String(line.amount), line.currency)} · ${line.internal_reference}`}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button loading={busy} disabled={!ready} onClick={() => void submit()}>Vérifier et rattacher</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <Banner tone="warning" title="Une ressemblance n’est pas une preuve">
          SasPay ne permet pas de retrouver une transaction par notre référence. Vérifiez dans le tableau de bord SasPay le numéro
          du payeur, le montant et l’heure avant de rattacher. Le serveur relira la transaction chez SasPay et refusera tout écart
          de montant, de devise ou de date ; l’achat n’est livré que si SasPay la déclare réussie.
        </Banner>
        <Input
          label="Identifiant de la transaction SasPay" value={paymentId} maxLength={64}
          onChange={(e) => setPaymentId(e.target.value)} hint="Identifiant (UUID) affiché dans le tableau de bord SasPay."
          error={paymentId !== '' && !SASPAY_ID.test(paymentId.trim()) ? 'Identifiant invalide.' : undefined}
        />
        <Textarea
          label="Comment ce paiement a été identifié" rows={3} maxLength={500} value={note}
          onChange={(e) => setNote(e.target.value)} hint="10 caractères minimum. Conservé dans le journal d’audit."
        />
        {error && <Banner tone="danger" title="Rattachement refusé">{error}</Banner>}
      </div>
    </Modal>
  );
}

/** Clôt une commande sans réponse : l'administrateur atteste qu'aucun encaissement n'existe chez SasPay. */
function CloseUnconfirmedDialog({ line, onClose, onDone }: {
  line: UnconfirmedPayment; onClose: () => void; onDone: (message: string) => void;
}) {
  const [note, setNote] = useState('');
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = attested && reviewNoteOk(note);

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      await adminCloseUnconfirmed(line.product, line.order_id, note.trim());
      onDone(`Commande ${line.internal_reference} close sans encaissement : le client peut de nouveau payer.`);
    } catch (err) {
      setError(asAppError(err, 'La commande n’a pas pu être close.').message);
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open onClose={busy ? () => undefined : onClose}
      title="Clore sans encaissement"
      description={`${line.user_email ?? 'Client'} · ${formatAmount(String(line.amount), line.currency)} · ${line.internal_reference}`}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button variant="danger" loading={busy} disabled={!ready} onClick={() => void submit()}>Clore la commande</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <Banner tone="warning" title="À ne faire qu’après vérification chez SasPay">
          Cette action annule la commande et autorise le client à payer de nouveau. Si le client avait en réalité été débité,
          il risque de payer deux fois. Un encaissement que SasPay confirmerait plus tard rouvrirait la commande et la livrerait.
        </Banner>
        {line.candidates.length > 0 && (
          <Banner tone="danger" title={`${line.candidates.length} transaction(s) ressemblante(s) trouvée(s)`}>
            Écartez-les une à une dans le tableau de bord SasPay avant de clore : elles ont le même montant et datent de la même période.
          </Banner>
        )}
        <label className="flex items-start gap-2 text-[12.5px] text-amber-200">
          <input type="checkbox" className="mt-0.5" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
          <span>
            J’ai vérifié dans le tableau de bord SasPay qu’aucun encaissement de {formatAmount(String(line.amount), line.currency)}
            {line.payer_msisdn_masked ? ` depuis le ${line.payer_msisdn_masked}` : ''} n’existe pour cette commande.
          </span>
        </label>
        <Textarea
          label="Ce qui a été vérifié" rows={3} maxLength={500} value={note}
          onChange={(e) => setNote(e.target.value)} hint="10 caractères minimum. Conservé dans le journal d’audit."
        />
        {error && <Banner tone="danger" title="Clôture refusée">{error}</Banner>}
      </div>
    </Modal>
  );
}

const CANDIDATE_SOURCES: Record<string, string> = {
  webhook: 'annoncée par SasPay', search: 'trouvée par recherche sur le numéro',
};

/** Créations Mobile Money restées sans réponse : ce que l'on sait, et les deux seules décisions possibles. */
function UnconfirmedPayments({ lines, onChanged }: { lines: UnconfirmedPayment[]; onChanged: () => void }) {
  const [attaching, setAttaching] = useState<{ line: UnconfirmedPayment; candidate: ReviewCandidate | null } | null>(null);
  const [closing, setClosing] = useState<UnconfirmedPayment | null>(null);
  const [done, setDone] = useState('');
  const finish = (message: string) => { setAttaching(null); setClosing(null); setDone(message); onChanged(); };

  return (
    <div data-testid="saspay-unconfirmed">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-300"><ShieldAlert size={12} /> Paiements sans réponse</h3>
      {done && <p className="mt-1 text-[12px] text-emerald-200" role="status">{done}</p>}
      {lines.length === 0 ? (
        <p className="mt-1 text-[12px] text-slate-500">Aucune demande de paiement n’est restée sans réponse.</p>
      ) : (
        <>
          <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">
            La demande Mobile Money est partie, mais SasPay n’a pas répondu : on ignore si le client a été débité. Rien n’est livré,
            et le client ne peut lancer aucun autre paiement tant que la commande n’est pas tranchée.
          </p>
          <ul className="mt-2 space-y-2">
            {lines.map((line) => (
              <li key={`${line.product}:${line.order_id}`} className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3" data-testid="saspay-unconfirmed-line">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-semibold text-amber-100">
                      {formatAmount(String(line.amount), line.currency)} · {line.product === 'business' ? 'Business Grow' : 'Studio'}
                      {' · '}{line.user_email ?? 'Utilisateur inconnu'}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      <span className="font-mono">{line.internal_reference}</span>
                      {line.network && <> · {line.network}</>}
                      {line.payer_msisdn_masked && <> · {line.payer_msisdn_masked}</>}
                      {' · '}{line.attempts} envoi(s), le premier le {formatDate(line.first_attempt_at, true)}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {line.last_search_at
                        ? `Dernière recherche chez SasPay : ${formatDate(line.last_search_at, true)}.`
                        : 'Pas encore de recherche chez SasPay.'}
                      {line.last_error && ` Dernière erreur : ${line.last_error}.`}
                    </p>
                  </div>
                  <Badge tone={line.in_review ? 'danger' : 'warning'}>
                    {line.in_review ? 'Décision attendue' : 'Rejeu encore possible'}
                  </Badge>
                </div>

                {line.candidates.length === 0 ? (
                  <p className="mt-2 text-[11.5px] text-slate-400">Aucune transaction ressemblante trouvée chez SasPay pour l’instant.</p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {line.candidates.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] px-2.5 py-1.5 text-[11px] text-slate-300" data-testid="saspay-candidate">
                        <span className="min-w-0">
                          Transaction ressemblante <span className="font-mono">{c.id}</span>
                          {' · '}{formatAmount(c.amount ?? null, c.currency ?? line.currency)}
                          {c.status && <> · {c.status}</>}
                          {c.created_at && <> · {formatDate(c.created_at, true)}</>}
                          {c.source && <> · {CANDIDATE_SOURCES[c.source] ?? c.source}</>}
                          {c.msisdn_match === true && <> · <strong className="text-amber-100">même numéro</strong></>}
                          {c.msisdn_match === false && <> · numéro différent</>}
                        </span>
                        <Button size="sm" variant="outline" onClick={() => setAttaching({ line, candidate: c })}>Contrôler et rattacher</Button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                  {!line.in_review && (
                    <span className="mr-auto text-[11px] text-slate-500">
                      Le client peut encore relancer sa demande ; la clôture sans encaissement ne s’ouvre qu’après ce délai.
                    </span>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setAttaching({ line, candidate: null })}>Rattacher un paiement</Button>
                  {line.in_review && (
                    <Button size="sm" variant="outline" onClick={() => setClosing(line)}>Aucun encaissement</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {attaching && (
        <AttachReviewDialog line={attaching.line} candidate={attaching.candidate} onClose={() => setAttaching(null)} onDone={finish} />
      )}
      {closing && <CloseUnconfirmedDialog line={closing} onClose={() => setClosing(null)} onDone={finish} />}
    </div>
  );
}

/** Surveillance : tâche planifiée, dernières exécutions, anomalies ouvertes. */
export function PaymentHealthCard({ health, error, busy, onReload, onOrdersChanged }: {
  health: PaymentHealth | null; error: string; busy: boolean; onReload: () => void;
  /** Une commande vient d'être tranchée : la liste des paiements doit être relue. */
  onOrdersChanged?: () => void;
}) {
  const [resolving, setResolving] = useState<PaymentAnomaly | null>(null);
  const lastRun = health?.runs[0] ?? null;
  const scheduled = Boolean(health?.cron.scheduled) && health?.cron.active !== false;
  // Prérequis de l'appel planifié. Absents de la réponse (ancienne base) : on n'affirme rien.
  const dispatch = health?.dispatch;
  const blindRun = health?.runs.slice(0, 5).find((run) => run.sweep_blind || run.sweep_truncated) ?? null;

  return (
    <Card data-testid="saspay-health">
      <CardHeader
        title="Surveillance des paiements"
        description="Toutes les 5 minutes, le serveur revérifie auprès de SasPay les paiements en attente et rattrape les notifications perdues."
        action={(
          <Button size="sm" variant="outline" icon={<RefreshCw size={13} />} loading={busy} onClick={onReload}>Actualiser</Button>
        )}
      />
      <div className="space-y-4 p-5">
        {error && <Banner tone="warning" title="Surveillance non vérifiée">{error}</Banner>}
        {!health && !error && !busy && (
          <Banner tone="warning" title="Surveillance non vérifiée">L’état de la surveillance n’a pas pu être lu.</Banner>
        )}
        {health && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-300">
              <Badge tone={scheduled ? 'success' : 'danger'}>
                {scheduled ? `Vérification automatique active (${health.cron.schedule ?? '—'})` : 'Vérification automatique inactive'}
              </Badge>
              <span>Paiements en attente — Studio : <strong className="text-white">{health.open_orders.studio}</strong> · Business Grow : <strong className="text-white">{health.open_orders.business}</strong></span>
            </div>
            {!scheduled && (
              <Banner tone="danger" title="Aucune vérification automatique">
                {health.cron.available
                  ? 'La tâche planifiée n’existe pas ou est désactivée : un paiement dont la notification se perd ne serait livré que lorsque le client rouvrira sa page de paiement.'
                  : 'pg_cron n’est pas disponible sur cette base : aucune vérification automatique ne tourne.'}
              </Banner>
            )}
            {scheduled && dispatch && !dispatch.token_present && (
              <Banner tone="danger" title="Tâche planifiée sans jeton">
                Le jeton de la tâche planifiée est absent du coffre : la tâche tourne mais ne peut pas appeler le service
                de vérification. Réappliquez la migration des paiements, ou recréez le secret <span className="font-mono">vyora_payments_reconcile_token</span>.
              </Banner>
            )}
            {scheduled && dispatch && !dispatch.http_available && (
              <Banner tone="danger" title="Appel HTTP indisponible">
                L’extension pg_net n’est pas disponible sur cette base : la tâche planifiée ne peut pas appeler le service de vérification.
              </Banner>
            )}
            {blindRun && (
              <Banner tone="warning" title="Rattrapage des paiements incomplet">
                {blindRun.sweep_blind
                  ? 'La liste des transactions SasPay ne contenait pas le libellé des paiements : un paiement dont la réponse de création s’est perdue ne peut pas être retrouvé automatiquement. '
                  : 'Trop de transactions à lire en une fois : une partie des encaissements récents n’a pas été examinée. '}
                Les paiements rattachés à une commande restent revérifiés un par un.
              </Banner>
            )}
            {health.refunds_awaiting_settlement > 0 && (
              <Banner tone="warning" title={`${health.refunds_awaiting_settlement} remboursement(s) à verser`}>
                Les crédits ou jours ont été repris, mais le versement au client n’est pas encore attesté.
              </Banner>
            )}

            <UnconfirmedPayments lines={health.unconfirmed ?? []} onChanged={() => { onReload(); onOrdersChanged?.(); }} />

            <div>
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-300"><Activity size={12} /> Dernières vérifications</h3>
              {lastRun === null ? (
                <p className="mt-1 text-[12px] text-slate-500">Aucune exécution enregistrée. La tâche ne contacte SasPay que s’il y a un paiement à vérifier.</p>
              ) : (
                <ul className="mt-1 divide-y divide-white/[0.05] text-[11.5px] text-slate-400">
                  {health.runs.slice(0, 5).map((run) => (
                    <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5" data-testid="saspay-run">
                      <span>{formatDate(run.started_at, true)}</span>
                      <span>
                        {run.checked} vérifié(s) · {run.settled} livré(s) · {run.closed} clos · {run.errors} erreur(s)
                        {run.sweep_blind && ' · rattrapage sans libellé'}
                        {run.sweep_truncated && ' · rattrapage tronqué'}
                      </span>
                      <Badge tone={run.status === 'ok' ? 'success' : run.status === 'running' ? 'info' : run.status === 'partial' ? 'warning' : 'danger'}>
                        {RUN_STATUS_LABELS[run.status] ?? run.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-300"><AlertTriangle size={12} /> Anomalies à traiter</h3>
              {health.anomalies.length === 0 ? (
                <p className="mt-1 text-[12px] text-slate-500">Aucune anomalie ouverte.</p>
              ) : (
                <ul className="mt-1 space-y-2">
                  {health.anomalies.map((a) => (
                    <li key={a.id} className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3" data-testid="saspay-anomaly">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[12.5px] font-semibold text-amber-100">{ANOMALY_LABELS[a.kind] ?? a.kind}</p>
                          <p className="text-[11px] text-slate-400">
                            {a.product === 'business' ? 'Business Grow' : a.product === 'studio' ? 'Studio' : 'Produit inconnu'}
                            {a.internal_reference && <> · <span className="font-mono">{a.internal_reference}</span></>}
                            {a.provider_payment_id && <> · transaction <span className="font-mono">{a.provider_payment_id}</span></>}
                            {' · '}vue {a.seen_count} fois, dernière le {formatDate(a.last_seen_at, true)}
                          </p>
                          {ANOMALY_ADVICE[a.kind] && <p className="mt-1 text-[11.5px] text-slate-300">{ANOMALY_ADVICE[a.kind]}</p>}
                        </div>
                        {DECISION_ANOMALIES.includes(a.kind)
                          ? <Badge tone="warning">À trancher ci-dessus</Badge>
                          : <Button size="sm" variant="outline" onClick={() => setResolving(a)}>Classer</Button>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
      {resolving && (
        <ResolveAnomalyDialog anomaly={resolving} onClose={() => setResolving(null)} onDone={() => { setResolving(null); onReload(); }} />
      )}
    </Card>
  );
}
