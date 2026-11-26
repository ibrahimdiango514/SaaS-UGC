/**
 * Écran Litiges — dossiers, échéances, preuves rassemblées, brouillon relu.
 *
 * Le module `finance/litiges.ts` calcule ; cet écran le rend utilisable :
 *  - il ne dit JAMAIS qu'une preuve existe si la donnée est absente ;
 *  - le brouillon de réponse est copié par l'utilisateur, aucun envoi ;
 *  - montant et échéance sont OPTIONNELS : les dossiers créés avant cette
 *    version restent lisibles et modifiables.
 */
import { useMemo, useState } from 'react';
import { Copy, FileCheck2, FileWarning, Scale, ShieldAlert } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, Modal, Select, Textarea, cn } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { CRM_CATEGORIES, FINANCE_CATEGORIES, useRecords } from '../records/useRecords';
import { SALES_CATEGORIES } from '../sales/model';
import {
  computeReceivableView, disputeFromRecord, paymentFromRecord, receivableFromRecord, reminderFromRecord,
  DISPUTE_STATUSES, todayIso, type ReceivableDispute,
} from './model';
import {
  alerteEcheance, brouillonReponse, dossierFrom, dossiersAQctiver, inventorierPreuves,
  preuvesManquantes, type DossierLitige, type SourcePreuves,
} from './litiges';

const TON_ALERTE = { aucune: 'neutral', proche: 'warning', aujourdhui: 'danger', depassee: 'danger' } as const;

export function LitigesWorkspace({ workspaceId, onOpenFinance }: { workspaceId: string | null; onOpenFinance: () => void }) {
  const toast = useToast();
  const disputesStore = useRecords(FINANCE_CATEGORIES.disputes, workspaceId);
  const receivablesStore = useRecords(FINANCE_CATEGORIES.receivables, workspaceId);
  const paymentsStore = useRecords(FINANCE_CATEGORIES.payments, workspaceId);
  const remindersStore = useRecords(FINANCE_CATEGORIES.reminders, workspaceId);
  const activitiesStore = useRecords(CRM_CATEGORIES.activities, workspaceId);
  const invoicesStore = useRecords(SALES_CATEGORIES.invoices, workspaceId);
  const [detail, setDetail] = useState<DossierLitige | null>(null);
  const [enCours, setEnCours] = useState(false);
  const today = todayIso();

  const payments = useMemo(() => paymentsStore.records.map(paymentFromRecord), [paymentsStore.records]);
  const receivables = useMemo(() => receivablesStore.records.map(receivableFromRecord), [receivablesStore.records]);
  const receivableById = useMemo(() => new Map(receivables.map((r) => [r.id, r])), [receivables]);

  const dossiers = useMemo(() => disputesStore.records.map((record) => {
    const dispute = disputeFromRecord(record);
    return dossierFrom(dispute, record.data ?? {}, today);
  }), [disputesStore.records, today]);

  const classement = useMemo(() => dossiersAQctiver(dossiers, 200), [dossiers]);

  /** Sources de preuves RÉELLES pour un dossier, calculées depuis les données. */
  const sourcesPour = (dossier: DossierLitige): SourcePreuves => {
    const receivable = receivableById.get(dossier.dispute.receivableId) ?? null;
    const view = receivable ? computeReceivableView(receivable, payments) : null;
    const facture = receivable
      ? invoicesStore.records.map((record) => record.data).find((data) => String(data?.contactId ?? '') === receivable.contactId)
      : undefined;
    return {
      creance: receivable ? {
        reference: receivable.reference || '—',
        montantInitial: receivable.initialAmount,
        devise: typeof disputesStore.records.find((r) => r.id === dossier.dispute.id)?.data.devise === 'string'
          ? String(disputesStore.records.find((r) => r.id === dossier.dispute.id)!.data.devise).toUpperCase()
          : 'XOF',
        dueDate: receivable.dueDate,
        conditions: receivable.terms,
      } : null,
      relances: remindersStore.records.filter((record) => reminderFromRecord(record).receivableId === dossier.dispute.receivableId).length,
      paiements: view ? (view.balance < (receivable?.initialAmount ?? 0) ? 1 : 0) : 0,
      commande: facture ? { numero: String(facture.number ?? ''), statut: String(facture.status ?? '') } : null,
      echanges: activitiesStore.records.filter((record) => String(record.data?.contactId ?? '') === dossier.dispute.contactId).length,
    };
  };

  const changerStatut = async (dossier: DossierLitige, statut: ReceivableDispute['status']) => {
    setEnCours(true);
    try {
      const record = disputesStore.records.find((r) => r.id === dossier.dispute.id);
      await disputesStore.update(dossier.dispute.id, { ...(record?.data ?? {}), status: statut });
      toast.success('Statut du dossier mis à jour.');
    } catch (cause) {
      toast.error(asAppError(cause).message);
    } finally {
      setEnCours(false);
    }
  };

  const copierBrouillon = async (dossier: DossierLitige) => {
    const preuves = inventorierPreuves(sourcesPour(dossier));
    const brouillon = brouillonReponse(dossier, preuves);
    const texte = `Objet : ${brouillon.objet}\n\n${brouillon.corps}`;
    try {
      await navigator.clipboard?.writeText(texte);
      toast.success('Brouillon copié. Relisez-le avant envoi — aucun envoi automatique.');
    } catch {
      toast.error('Copie impossible : sélectionnez le texte manuellement.');
    }
  };

  const chargement = disputesStore.loading || receivablesStore.loading || paymentsStore.loading;
  if (chargement) return <LoadingState label="Chargement des litiges…" />;
  const erreur = disputesStore.error || receivablesStore.error;
  if (erreur) return <ErrorState message={erreur} onRetry={() => { void disputesStore.reload(); void receivablesStore.reload(); }} />;

  return (
    <div className="space-y-3" data-testid="litiges-workspace">
      <Card>
        <CardHeader
          title="Litiges et contestations"
          description="Preuves rassemblées depuis vos données, brouillon relu par vous. Aucune preuve inventée, aucune promesse de résultat."
          action={<Badge tone={classement.length > 0 ? 'warning' : 'success'}>{classement.length} à traiter</Badge>}
        />
        {classement.length === 0 ? (
          <EmptyState
            icon={<Scale size={22} />}
            title={dossiers.length === 0 ? 'Aucun dossier de litige' : 'Aucun dossier à traiter'}
            description={dossiers.length === 0
              ? 'Ouvrez un dossier depuis une créance dans Finance : le motif, le montant et l’échéance y sont saisis une seule fois.'
              : 'Tous vos dossiers sont résolus ou annulés.'}
            action={<Button size="sm" variant="primary" onClick={onOpenFinance}>Ouvrir Finance</Button>}
          />
        ) : (
          <ul className="liste-mobile overflow-hidden rounded-xl border border-white/[0.06]">
            {classement.map((dossier) => {
              const alerte = alerteEcheance(dossier);
              const preuves = inventorierPreuves(sourcesPour(dossier));
              const manquantes = preuvesManquantes(preuves).length;
              return (
                <li key={dossier.dispute.id} className="px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-semibold text-white">{dossier.dispute.reason || 'Motif non précisé'}</p>
                      <p className="mt-0.5 text-[10.5px] text-slate-400">
                        {dossier.montant !== null && dossier.devise
                          ? `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(dossier.montant)} ${dossier.devise}`
                          : 'Montant non renseigné'}
                        {dossier.echeance ? ` · échéance ${dossier.echeance}` : ' · aucune échéance'}
                      </p>
                    </div>
                    <Badge tone="neutral">{DISPUTE_STATUSES.find((s) => s.value === dossier.dispute.status)?.label ?? dossier.dispute.status}</Badge>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {alerte.niveau !== 'aucune' && <Badge tone={TON_ALERTE[alerte.niveau]}>{alerte.label}</Badge>}
                    <span className={cn('inline-flex items-center gap-1 text-[10px]', manquantes === 0 ? 'text-emerald-200' : 'text-amber-200')}>
                      {manquantes === 0 ? <FileCheck2 size={11} /> : <FileWarning size={11} />}
                      {preuves.length - manquantes}/{preuves.length} preuve(s) disponible(s)
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="primary" onClick={() => setDetail(dossier)}>Ouvrir le dossier</Button>
                    <Button size="sm" variant="outline" icon={<Copy size={12} />} onClick={() => void copierBrouillon(dossier)}>Copier la réponse</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title="Dossier de litige"
        description="Preuves réellement présentes dans votre espace. Une preuve absente est affichée comme absente."
        size="lg"
        footer={detail && (
          <>
            <Button variant="ghost" onClick={() => setDetail(null)}>Fermer</Button>
            <Button icon={<Copy size={13} />} onClick={() => void copierBrouillon(detail)}>Copier la réponse</Button>
          </>
        )}
      >
        {detail && (
          <div className="space-y-3">
            <div className="rounded-lg border border-white/[0.07] p-2.5">
              <p className="text-[11px] font-semibold text-white">{detail.dispute.reason || 'Motif non précisé'}</p>
              <p className="mt-1 text-[10.5px] text-slate-400">{detail.dispute.description || 'Aucune description.'}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge tone={TON_ALERTE[alerteEcheance(detail).niveau]}>{alerteEcheance(detail).label}</Badge>
                {detail.montant !== null && detail.devise && (
                  <span className="text-[10.5px] text-slate-300">
                    {new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(detail.montant)} {detail.devise}
                  </span>
                )}
              </div>
            </div>

            <div>
              <p className="text-[11px] font-semibold text-white">Preuves</p>
              <ul className="mt-1.5 space-y-1.5">
                {inventorierPreuves(sourcesPour(detail)).map((preuve) => (
                  <li key={preuve.type} className="flex items-start gap-2 text-[10.5px]">
                    {preuve.disponible ? <FileCheck2 size={12} className="mt-0.5 shrink-0 text-emerald-300" /> : <FileWarning size={12} className="mt-0.5 shrink-0 text-amber-300" />}
                    <span className="min-w-0">
                      <span className={preuve.disponible ? 'text-slate-200' : 'text-slate-500'}>{preuve.label}</span>
                      <span className="block text-[10px] text-slate-500">
                        {preuve.disponible ? preuve.detail : `Absente — à retrouver dans ${preuve.source}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-lg border border-white/[0.07] p-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white"><ShieldAlert size={12} /> Réponse préparée</p>
              <p className="mt-1 whitespace-pre-wrap text-[10.5px] text-slate-300">{brouillonReponse(detail, inventorierPreuves(sourcesPour(detail))).corps}</p>
              <ul className="mt-1.5 list-inside list-disc text-[10px] text-amber-200">
                {brouillonReponse(detail, inventorierPreuves(sourcesPour(detail))).avertissements.map((a) => <li key={a}>{a}</li>)}
              </ul>
            </div>

            <Select
              label="Statut du dossier"
              value={detail.dispute.status}
              disabled={enCours}
              onChange={(event) => void changerStatut(detail, event.target.value as ReceivableDispute['status'])}
            >
              {DISPUTE_STATUSES.map((statut) => <option key={statut.value} value={statut.value}>{statut.label}</option>)}
            </Select>
            <Textarea
              label="Résolution (à remplir par vous)"
              value={detail.dispute.resolution}
              readOnly
              hint="La résolution est saisie dans Finance, sur le dossier d’origine. Cet écran ne l’écrase pas."
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
