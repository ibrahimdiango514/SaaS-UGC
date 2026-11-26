/**
 * Briefing quotidien — fonctionnalité 8, branchée sur l'accueil Grow.
 *
 * Trois priorités maximum, tirées des DONNÉES RÉELLES de l'espace, chacune avec
 * un bouton « l'agent s'en occupe » qui PRÉPARE une action. Rien ne s'exécute :
 * la proposition part dans le journal et attend la validation de l'utilisateur.
 *
 * Aucun chiffre fictif : une priorité sans montant connu n'affiche pas « 0 ».
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, ListChecks, Sparkles, TriangleAlert } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, cn } from '../../components/ui';
import { useOptionalToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { CRM_CATEGORIES, FINANCE_CATEGORIES, useRecords } from '../records/useRecords';
import { contactFromRecord, todayIso } from '../crm/model';
import { computeReceivableView, disputeFromRecord, paymentFromRecord, receivableFromRecord } from '../finance/model';
import { construireBriefing, totalEnJeu, type Priorite } from '../agent/socle/briefing';
import type { EntreeJournal } from '../agent/socle/journal';
import { preparerAction } from '../agent/socle/outils';
import { ajouterEntree } from '../agent/journalApi';

const money = (valeur: number | null, devise: string | null) => (valeur === null || !devise)
  ? '—'
  : `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(valeur)} ${devise}`;

const TON_PAR_GRAVITE: Record<Priorite['gravite'], 'danger' | 'warning' | 'neutral'> = {
  critique: 'danger', haute: 'warning', moyenne: 'neutral',
};

export function BriefingDuJour({
  workspaceId, onNavigate,
}: {
  workspaceId: string | null;
  onNavigate: (module: 'recouvrement' | 'crm' | 'tasks' | 'finance') => void;
}) {
  const toast = useOptionalToast();
  const contactsStore = useRecords(CRM_CATEGORIES.contacts, workspaceId);
  const tasksStore = useRecords(CRM_CATEGORIES.tasks, workspaceId);
  const receivablesStore = useRecords(FINANCE_CATEGORIES.receivables, workspaceId);
  const paymentsStore = useRecords(FINANCE_CATEGORIES.payments, workspaceId);
  const disputesStore = useRecords(FINANCE_CATEGORIES.disputes, workspaceId);
  const [enCours, setEnCours] = useState<string | null>(null);
  const [preparees, setPreparees] = useState<Record<string, string>>({});
  const [today, setToday] = useState(todayIso());

  // Le briefing doit suivre le passage de minuit sans recharger la page.
  useEffect(() => {
    const minuteur = setInterval(() => setToday(todayIso()), 60_000);
    return () => clearInterval(minuteur);
  }, []);

  const donnees = useMemo(() => {
    const payments = paymentsStore.records.map(paymentFromRecord);
    const creances = receivablesStore.records.map(receivableFromRecord).map((receivable) => {
      const view = computeReceivableView(receivable, payments);
      return {
        id: view.receivable.id,
        reference: view.receivable.reference,
        solde: view.balance,
        devise: typeof receivablesStore.records.find((r) => r.id === receivable.id)?.data.devise === 'string'
          ? String(receivablesStore.records.find((r) => r.id === receivable.id)!.data.devise).toUpperCase()
          : 'XOF',
        joursDeRetard: Math.max(0, view.daysOverdue),
        statut: view.effectiveStatus,
        contactId: view.receivable.contactId,
      };
    });
    const tasks = tasksStore.records.map((record) => ({
      id: record.id,
      titre: String(record.data?.title ?? 'Tâche'),
      echeance: String(record.data?.dueDate ?? ''),
      fait: String(record.data?.status ?? 'a_faire') === 'terminee',
      contactId: String(record.data?.contactId ?? ''),
    }));
    const litiges = disputesStore.records.map(disputeFromRecord).map((dispute) => {
      const data = disputesStore.records.find((r) => r.id === dispute.id)?.data ?? {};
      const montant = typeof data.montant === 'number' ? data.montant : 0;
      return {
        id: dispute.id,
        creanceId: dispute.receivableId,
        montant,
        devise: typeof data.devise === 'string' ? String(data.devise).toUpperCase() : 'XOF',
        echeance: typeof data.echeance === 'string' ? data.echeance : '',
        statut: dispute.status,
      };
    }).filter((litige) => litige.echeance);
    const contacts = contactsStore.records.map(contactFromRecord).map((contact) => ({
      id: contact.id,
      nom: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.company || 'Contact',
      prochaineAction: contact.nextAction,
      prochaineActionAt: contact.nextActionAt,
    }));
    return { aujourdhui: today, creances, taches: tasks, litiges, contacts };
  }, [contactsStore.records, disputesStore.records, paymentsStore.records, receivablesStore.records, tasksStore.records, today]);

  const briefing = useMemo(() => construireBriefing(donnees), [donnees]);
  const enJeu = useMemo(() => totalEnJeu(briefing), [briefing]);
  const chargement = contactsStore.loading || tasksStore.loading || receivablesStore.loading;

  /**
   * « L'agent s'en occupe » : l'action est PRÉPARÉE puis journalisée en
   * `proposee`. Aucune écriture métier n'a lieu ici. L'utilisateur voit
   * ensuite la proposition dans l'historique de l'agent.
   */
  const prendreEnCharge = async (priorite: Priorite) => {
    if (!workspaceId || !priorite.outil) return;
    setEnCours(priorite.cle);
    try {
      const preparation = preparerAction(priorite.outil, priorite.argumentsOutil);
      if (!preparation.ok) {
        toast?.error('Action non préparée : ' + preparation.erreurs.map((e) => e.champ).join(', '));
        return;
      }
      const entree: EntreeJournal = {
        id: '', horodatage: new Date().toISOString(),
        outil: preparation.proposition.outil,
        resume: preparation.proposition.resume,
        statut: 'proposee',
        decidePar: 'utilisateur',
        regleId: null,
        avant: null,
        apres: preparation.proposition.donnees,
        resultat: preparation.proposition.decision.raison,
        enregistrementId: null,
        categorie: preparation.proposition.categorie,
        annulable: false,
      };
      // Écriture par le point d'accès unique du journal : la limite dédiée
      // (5 000) s'applique, et la validation de l'Edge s'exécute.
      const { id } = await ajouterEntree(workspaceId, entree);
      setPreparees((actuel) => ({ ...actuel, [priorite.cle]: id }));
      toast?.success('Action préparée. Elle attend votre validation.');
    } catch (cause) {
      toast?.error(asAppError(cause).message);
    } finally {
      setEnCours(null);
    }
  };

  const cible = (priorite: Priorite): 'recouvrement' | 'crm' | 'tasks' | 'finance' => {
    if (priorite.cle.startsWith('litige:')) return 'finance';
    if (priorite.cle.startsWith('creance:')) return 'recouvrement';
    if (priorite.cle.startsWith('tache:')) return 'tasks';
    return 'crm';
  };

  if (chargement) {
    return (
      <Card>
        <CardHeader title="Briefing du jour" description="Lecture de vos données en cours…" />
        <div className="h-16 animate-pulse rounded-lg bg-white/[0.04]" />
      </Card>
    );
  }

  return (
    <Card data-testid="briefing-du-jour">
      <CardHeader
        title="Briefing du jour"
        description="Trois priorités tirées de vos données réelles. L’agent prépare, vous validez."
        action={<Badge tone={briefing.length > 0 ? 'warning' : 'success'}>{briefing.length} priorité(s)</Badge>}
      />
      {briefing.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 size={22} />}
          title="Rien d’urgent aujourd’hui"
          description={donnees.creances.length === 0 && donnees.taches.length === 0
            ? 'Aucune donnée à analyser pour l’instant. Enregistrez une créance, une tâche ou un prospect.'
            : 'Aucune échéance dépassée, aucune créance en retard.'}
        />
      ) : (
        <div className="space-y-2">
          <ul className="liste-mobile overflow-hidden rounded-xl border border-white/[0.06]">
            {briefing.map((priorite, index) => {
              const preparee = preparees[priorite.cle];
              return (
                <li key={priorite.cle} className="px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-semibold text-slate-300">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] font-semibold text-white">{priorite.titre}</p>
                      <p className="mt-0.5 text-[11px] text-slate-400">{priorite.justification}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge tone={TON_PAR_GRAVITE[priorite.gravite]}>{priorite.gravite}</Badge>
                        {priorite.montantEnJeu !== null && (
                          <span className="text-[10.5px] text-slate-400">{money(priorite.montantEnJeu, priorite.devise)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {priorite.outil && (
                      <Button
                        size="sm"
                        variant={preparee ? 'ghost' : 'primary'}
                        icon={preparee ? <CheckCircle2 size={12} /> : <Sparkles size={12} />}
                        loading={enCours === priorite.cle}
                        disabled={Boolean(preparee)}
                        onClick={() => void prendreEnCharge(priorite)}
                      >
                        {preparee ? 'Préparée' : 'L’agent s’en occupe'}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" icon={<ArrowRight size={12} />} onClick={() => onNavigate(cible(priorite))}>
                      Ouvrir
                    </Button>
                  </div>
                  {preparee && (
                    <p className="mt-1.5 text-[10px] text-emerald-200">
                      Proposition enregistrée dans l’historique de l’agent — rien n’a été appliqué, à vous de valider.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {enJeu.montant > 0 && enJeu.devise && (
            <p className="text-[10.5px] text-slate-400">
              Total réellement suivi dans ces priorités : <span className="text-white">{money(enJeu.montant, enJeu.devise)}</span>
              {' '}(les montants de devises différentes ne sont pas additionnés).
            </p>
          )}
          <button
            type="button"
            onClick={() => onNavigate('finance')}
            className="inline-flex items-center gap-1 text-[10.5px] text-slate-400 hover:text-white"
          >
            <ListChecks size={11} /> Voir toutes les priorités dans Finance
          </button>
        </div>
      )}
      {briefing.length === 0 && donnees.litiges.length > 0 && (
        <p className={cn('mt-2 flex items-center gap-1.5 text-[10.5px] text-slate-400')}>
          <TriangleAlert size={11} /> {donnees.litiges.length} dossier(s) de litige suivis, aucune échéance proche.
        </p>
      )}
    </Card>
  );
}
