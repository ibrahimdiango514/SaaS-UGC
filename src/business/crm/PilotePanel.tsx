/**
 * Onglet « Pilote » du CRM — fonctionnalité 6 branchée.
 *
 * Réutilise le scoring existant (`scoreContact`, déjà calculé par `CrmWorkspace`)
 * et y ajoute ce qui manquait : la **prochaine action obligatoire** et un
 * classement par urgence réelle. Aucune duplication de score.
 *
 * « Préparer » écrit une proposition dans le journal de l'agent : rien n'est
 * appliqué au contact sans validation.
 */
import { useMemo, useState } from 'react';
import { ClipboardCopy, Gauge, UserRoundCheck } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { useRecords } from '../records/useRecords';
import { CATEGORIE_JOURNAL, entreeToData, type EntreeJournal } from '../agent/socle/journal';
import { preparerAction } from '../agent/socle/outils';
import {
  joursDepuisContact, messageRelance, montantEnJeu, prospectsAPiloter, type ProspectPrioritaire,
} from './pilote';
import type { Contact, ContactScore, Opportunity } from './model';

const TON_PRIORITE: Record<string, 'danger' | 'warning' | 'neutral' | 'success'> = {
  urgente: 'danger', elevee: 'warning', normale: 'neutral', faible: 'neutral',
};

export function PilotePanel({
  workspaceId, contacts, opportunities, scores, onOpenContact, onEdit,
}: {
  workspaceId: string | null;
  contacts: Contact[];
  opportunities: Opportunity[];
  scores: Map<string, ContactScore>;
  onOpenContact: (id: string) => void;
  onEdit: (contact: Contact) => void;
}) {
  const toast = useToast();
  const journalStore = useRecords(CATEGORIE_JOURNAL, workspaceId);
  const [enCours, setEnCours] = useState<string | null>(null);
  const aujourdhui = new Date().toISOString().slice(0, 10);

  const classement = useMemo(() => prospectsAPiloter(contacts, {
    scoreDe: (contact) => scores.get(contact.id)?.score ?? 0,
    montantDe: (contact) => montantEnJeu(contact, opportunities),
    daysSinceContactDe: (contact) => joursDepuisContact(contact, aujourdhui),
    aujourdhui,
  }, 8), [contacts, opportunities, scores, aujourdhui]);

  const preparer = async (prospect: ProspectPrioritaire) => {
    if (!workspaceId) return;
    setEnCours(prospect.contact.id);
    try {
      // On prépare une TÂCHE datée : c'est l'action réelle derrière « relancer ».
      const preparation = preparerAction('creer_tache', {
        titre: `${prospect.action.libelle} — ${[prospect.contact.firstName, prospect.contact.lastName].filter(Boolean).join(' ') || 'prospect'}`.slice(0, 160),
        echeance: prospect.action.quand,
        contactId: prospect.contact.id,
      });
      if (!preparation.ok) {
        toast.error('Action non préparée : ' + preparation.erreurs.map((e) => e.champ).join(', '));
        return;
      }
      const entree: EntreeJournal = {
        id: '', horodatage: new Date().toISOString(), outil: 'creer_tache',
        resume: preparation.proposition.resume, statut: 'proposee', decidePar: 'utilisateur',
        regleId: null, avant: null, apres: preparation.proposition.donnees,
        resultat: preparation.proposition.decision.raison, enregistrementId: null,
        categorie: preparation.proposition.categorie, annulable: false,
      };
      await journalStore.create(entreeToData(entree), null);
      toast.success('Action préparée dans l’historique de l’agent.');
    } catch (cause) {
      toast.error(asAppError(cause).message);
    } finally {
      setEnCours(null);
    }
  };

  const copier = async (prospect: ProspectPrioritaire) => {
    const texte = messageRelance(prospect.contact, prospect.action, prospect.contact.company);
    try {
      await navigator.clipboard?.writeText(texte);
      toast.success('Message copié. Aucun envoi automatique.');
    } catch {
      toast.error('Copie impossible : sélectionnez le texte manuellement.');
    }
  };

  return (
    <Card data-testid="pilote-prospects">
      <CardHeader
        title="Pilote des prospects"
        description="Un prospect sans action datée est un prospect oublié. L’agent propose l’action ; vous validez."
        action={<Badge tone="neutral">{classement.length}</Badge>}
      />
      {classement.length === 0 ? (
        <EmptyState
          icon={<UserRoundCheck size={22} />}
          title="Aucun prospect à piloter"
          description="Ajoutez un contact de type prospect, ou sortez un contact du statut « archivé », pour qu’il apparaisse ici."
        />
      ) : (
        <ul className="liste-mobile overflow-hidden rounded-xl border border-white/[0.06]">
          {classement.map((prospect) => {
            const score = scores.get(prospect.contact.id);
            const nom = [prospect.contact.firstName, prospect.contact.lastName].filter(Boolean).join(' ') || 'Contact';
            const due = prospect.action.quand <= aujourdhui;
            return (
              <li key={prospect.contact.id} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <button type="button" onClick={() => onOpenContact(prospect.contact.id)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-[12.5px] font-semibold text-white">{nom}</p>
                    <p className="truncate text-[10.5px] text-slate-400">{prospect.contact.company || 'Sans entreprise'}</p>
                  </button>
                  <div className="shrink-0 text-right">
                    {score && <Badge tone={TON_PRIORITE[score.priority] ?? 'neutral'}>{score.score}</Badge>}
                    {prospect.montantEnJeu !== null && (
                      <p className="mt-0.5 text-[10px] text-slate-400">
                        {new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(prospect.montantEnJeu)} FCFA
                      </p>
                    )}
                  </div>
                </div>

                <p className="mt-1 text-[10.5px] text-slate-300">
                  <span className={due ? 'text-amber-200' : 'text-slate-400'}>
                    {due ? 'À faire' : 'Prévu'} le {prospect.action.quand}
                  </span>
                  {' · '}{prospect.action.libelle}
                  {!prospect.action.dejaPlanifiee && <span className="text-slate-500"> (proposé par l’agent)</span>}
                </p>
                <p className="text-[10px] text-slate-500">{prospect.action.pourquoi}</p>

                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" icon={<Gauge size={12} />} onClick={() => onEdit(prospect.contact)}>Planifier</Button>
                  <Button size="sm" variant="ghost" icon={<ClipboardCopy size={12} />} onClick={() => void copier(prospect)}>Copier le message</Button>
                  {!prospect.action.dejaPlanifiee && (
                    <Button size="sm" variant="primary" loading={enCours === prospect.contact.id} onClick={() => void preparer(prospect)}>
                      L’agent s’en occupe
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[10px] text-slate-500">
        Le score est celui du CRM, avec ses raisons détaillées sur la fiche du contact. Aucun chiffre n’est ajouté ici.
      </p>
    </Card>
  );
}
