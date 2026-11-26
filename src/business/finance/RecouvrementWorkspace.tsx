/**
 * Recouvrement — la séquence progressive de relances, réellement utilisable.
 *
 * Le module `finance/relances.ts` calcule l'étape et rédige le message ; cet
 * écran le rend visible et actionnable :
 *  - pour chaque créance en retard : étape en cours, retard, montant réellement
 *    dû, montant à ne PAS afficher quand il est inconnu ;
 *  - le message est préparé puis COPIÉ, ou ouvert dans l'outil du client via un
 *    lien `mailto:` — jamais envoyé par l'application (aucun connecteur) ;
 *  - une relance faite est enregistrée dans `bg_module_receivable_reminders`,
 *    ce qui fait avancer la séquence et l'empêche d'être répétée ;
 *  - au-delà de la dernière étape commerciale, l'écran dit que la décision
 *    revient à l'utilisateur, sans aucun conseil juridique.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Copy, Mail, Send, Wallet } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, cn } from '../../components/ui';
import { useOptionalToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { CRM_CATEGORIES, FINANCE_CATEGORIES, useRecords } from '../records/useRecords';
import { contactFromRecord } from '../crm/model';
import {
  paymentFromRecord, receivableFromRecord, reminderFromRecord, reminderToData, todayIso,
  type CollectionReminder,
} from './model';
import {
  LANGUES, langueDuClient, relancesDues, SEQUENCE_PAR_DEFAUT, totalRelancable,
  type EtapeRelance, type Langue, type RelanceDue,
} from './relances';

const TON_ETAPE: Record<EtapeRelance, 'neutral' | 'warning' | 'danger' | 'success'> = {
  rappel_court: 'neutral',
  relance_ferme: 'warning',
  mise_en_demeure: 'danger',
  contentieux: 'danger',
  termine: 'success',
};

/** Libellé du canal : aucun envoi automatique n'existe, on nomme le canal visé. */
const CANAL_TEMPLATE = 'email';

export function RecouvrementWorkspace({ workspaceId, onOpenFinance }: {
  workspaceId: string | null;
  onOpenFinance: (contactId?: string | null) => void;
}) {
  const toast = useOptionalToast();
  const receivablesStore = useRecords(FINANCE_CATEGORIES.receivables, workspaceId);
  const paymentsStore = useRecords(FINANCE_CATEGORIES.payments, workspaceId);
  const remindersStore = useRecords(FINANCE_CATEGORIES.reminders, workspaceId);
  const contactsStore = useRecords(CRM_CATEGORIES.contacts, workspaceId);

  const [entreprise, setEntreprise] = useState('');
  const [seuilFerme, setSeuilFerme] = useState<Record<EtapeRelance, number>>(() => {
    const base = {} as Record<EtapeRelance, number>;
    for (const definition of SEQUENCE_PAR_DEFAUT) base[definition.etape] = definition.aPartirDe;
    return base;
  });
  const [selection, setSelection] = useState<string | null>(null);
  const [enCours, setEnCours] = useState<string | null>(null);
  const today = todayIso();

  const sequence = useMemo(() => SEQUENCE_PAR_DEFAUT.map((definition) => (
    Number.isFinite(seuilFerme[definition.etape]) ? { ...definition, aPartirDe: seuilFerme[definition.etape] } : { ...definition }
  )), [seuilFerme]);

  const receivables = useMemo(() => receivablesStore.records.map(receivableFromRecord), [receivablesStore.records]);
  const payments = useMemo(() => paymentsStore.records.map(paymentFromRecord), [paymentsStore.records]);
  const reminders = useMemo(() => remindersStore.records.map(reminderFromRecord), [remindersStore.records]);
  const contacts = useMemo(() => contactsStore.records.map(contactFromRecord), [contactsStore.records]);

  const dues = useMemo(() => relancesDues(receivables, payments, reminders, contacts, {
    aujourdHui: today, entreprise, sequenceUtilisee: sequence,
  }), [receivables, payments, reminders, contacts, today, entreprise, sequence]);

  /** Libellé du pays du client, pour montrer la langue réellement appliquée. */
  const langueDeLaLigne = (due: RelanceDue): Langue => langueDuClient(due.contact);

  const dueSelectionnee = dues.find((due) => due.receivable.id === selection) ?? dues[0] ?? null;

  const deviseAffichage = dueSelectionnee?.receivable ? 'XOF' : '';
  const total = totalRelancable(dues, deviseAffichage);

  const copier = async (texte: string) => {
    try {
      await navigator.clipboard.writeText(texte);
      toast?.success('Message copié. Collez-le dans votre outil d’envoi.');
    } catch {
      toast?.error('Copie impossible : sélectionnez le texte et copiez-le à la main.');
    }
  };

  /**
   * Enregistre la relance préparée.
   *
   * On écrit AVANT d'ouvrir le lien : si l'utilisateur ferme sa messagerie sans
   * envoyer, la trace existe et l'étape n'est pas répétée par erreur. Le statut
   * `a_faire` dit justement qu'on ne sait pas si elle a été envoyée.
   */
  const enregistrer = async (due: RelanceDue, envoye: boolean) => {
    if (!workspaceId) return;
    setEnCours(due.receivable.id);
    try {
      const relance: Omit<CollectionReminder, 'id' | 'createdAt'> = {
        receivableId: due.receivable.id,
        contactId: due.receivable.contactId,
        dueDate: due.receivable.dueDate,
        channel: CANAL_TEMPLATE,
        template: due.etape,
        message: due.message,
        status: envoye ? 'termine' : 'a_faire',
        note: `${due.etapeLabel} — ${due.joursDeRetard} jour(s) de retard`,
        outcome: '',
      };
      await remindersStore.create(reminderToData({ ...relance, id: '', createdAt: '' }), null);
      toast?.success(envoye
        ? 'Relance marquée comme faite. L’étape suivante est visible.'
        : 'Relance enregistrée comme à faire.');
    } catch (cause) {
      toast?.error(asAppError(cause).message);
    } finally {
      setEnCours(null);
    }
  };

  if (receivablesStore.loading || paymentsStore.loading || remindersStore.loading) {
    return <LoadingState label="Calcul des relances…" />;
  }
  if (receivablesStore.error) {
    return <ErrorState message={receivablesStore.error} onRetry={() => void receivablesStore.reload()} />;
  }

  return (
    <Card data-testid="recouvrement-workspace">
      <CardHeader
        title="Relances d’impayés"
        description="Une séquence progressive, jamais un envoi automatique : vous relisez, vous copiez, vous décidez."
        action={<Badge tone={dues.length > 0 ? 'warning' : 'success'}>{dues.length} à relancer</Badge>}
      />

      {/* Réglage des seuils : ce sont des repères commerciaux, pas des règles de droit. */}
      <div className="mb-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
        <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">Vos repères (jours de retard)</p>
        <div className="flex flex-wrap gap-2">
          {SEQUENCE_PAR_DEFAUT.filter((definition) => Number.isFinite(definition.aPartirDe)).map((definition) => (
            <label key={definition.etape} className="flex items-center gap-1.5 text-[10.5px] text-slate-400">
              {definition.label}
              <input
                type="number"
                min={0}
                max={365}
                value={Number.isFinite(seuilFerme[definition.etape]) ? seuilFerme[definition.etape] : ''}
                onChange={(event) => {
                  const valeur = Number(event.target.value);
                  setSeuilFerme((actuel) => ({ ...actuel, [definition.etape]: Number.isFinite(valeur) ? Math.max(0, Math.min(365, valeur)) : 0 }));
                }}
                aria-label={`Seuil ${definition.label}`}
                className="w-14 rounded-md border border-white/10 bg-black/30 px-1.5 py-0.5 text-right text-white"
              />
            </label>
          ))}
        </div>
      </div>

      <label className="mb-3 block">
        <span className="text-[10.5px] text-slate-400">Nom affiché dans le message</span>
        <input
          type="text"
          value={entreprise}
          onChange={(event) => setEntreprise(event.target.value)}
          placeholder="Votre entreprise"
          aria-label="Nom de votre entreprise"
          className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-white placeholder:text-slate-600"
        />
      </label>

      {dues.length === 0 ? (
        <EmptyState
          icon={<Wallet size={22} />}
          title="Aucune créance à relancer"
          description="Les créances échues apparaîtront ici dès qu’une date d’échéance sera dépassée. Aucun chiffre n’est inventé : sans échéance, il n’y a pas de retard calculable."
        />
      ) : (
        <div className="space-y-2">
          {dues.map((due) => {
            const selected = dueSelectionnee?.receivable.id === due.receivable.id;
            const nom = [due.contact?.firstName, due.contact?.lastName].filter(Boolean).join(' ') || 'Client sans fiche';
            const langue = langueDeLaLigne(due);
            return (
              <div
                key={due.receivable.id}
                data-etape={due.etape}
                className={cn('rounded-xl border p-2.5 transition',
                  selected ? 'border-amber-400/30 bg-amber-400/[0.04]' : 'border-white/[0.06] bg-white/[0.02]')}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setSelection(due.receivable.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-[12.5px] font-semibold text-white">
                      {due.receivable.reference || 'Sans référence'} · {nom}
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-slate-500">
                      {due.joursDeRetard} jour(s) de retard · échéance {due.receivable.dueDate || '—'} · {LANGUES.find((l) => l.value === langue)?.label ?? langue}
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-slate-400">
                      {due.montantDu === null
                        ? 'Montant dû inconnu — à confirmer avant relance'
                        : `Reste dû : ${new Intl.NumberFormat('fr-FR').format(due.montantDu)}`}
                    </p>
                  </button>
                  <div className="flex flex-col items-end gap-1">
                    <Badge tone={TON_ETAPE[due.etape]}>{due.etapeLabel}</Badge>
                    {due.dejaFaite && <span className="text-[10px] text-slate-500">déjà relancée à cette étape</span>}
                  </div>
                </div>

                <p className="mt-1 text-[10.5px] text-slate-500">{due.prochaine}</p>

                {due.decisionRequise && (
                  <p className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-2 py-1.5 text-[10.5px] text-rose-200/90">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    Décision à prendre de votre côté (mise en demeure, litige). L’application ne fait aucune démarche et ne donne aucun conseil juridique.
                  </p>
                )}

                {selected && (
                  <div className="mt-2 space-y-2">
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/30 p-2 text-[11px] leading-relaxed text-slate-200">
                      {due.message}
                    </pre>
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="outline" icon={<Copy size={12} />} onClick={() => void copier(due.message)}>
                        Copier le message
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        icon={<Mail size={12} />}
                        onClick={() => {
                          void enregistrer(due, false);
                          const email = due.contact?.email ?? '';
                          const sujet = encodeURIComponent(`Relance — ${due.receivable.reference || 'facture'}`);
                          const corps = encodeURIComponent(due.message);
                          // `mailto:` ouvre l'outil de l'utilisateur : rien n'est envoyé par l'application.
                          window.open(`mailto:${encodeURIComponent(email)}?subject=${sujet}&body=${corps}`, '_blank', 'noopener');
                        }}
                      >
                        Ouvrir dans ma messagerie
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<Send size={12} />}
                        loading={enCours === due.receivable.id}
                        onClick={() => void enregistrer(due, true)}
                      >
                        Marquer comme relancée
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onOpenFinance(due.receivable.contactId)}>
                        Voir la créance
                      </Button>
                    </div>
                    <p className="text-[10px] text-slate-500">
                      Aucun envoi n’est effectué par l’application : pas de connecteur de messagerie. Le lien ouvre votre logiciel de courrier avec le texte déjà rempli.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {dues.length > 0 && (
        <p className="mt-2 text-[10px] text-slate-500">
          {total === null
            ? 'Total non calculable : au moins une créance a un montant inconnu.'
            : `Total des montants restant dus : ${new Intl.NumberFormat('fr-FR').format(total)} (devise de vos factures).`}
          {' '}Les créances en litige ne sont pas relancées ici : elles suivent le circuit « Litiges ».
        </p>
      )}
    </Card>
  );
}
