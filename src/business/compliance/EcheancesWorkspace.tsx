/**
 * Écran Échéances et conformité.
 *
 * Saisie libre de dates, rappels visuels, et un avertissement qui n'est jamais
 * masqué : l'application rappelle des dates, elle ne dit pas quoi déclarer.
 * Aucun taux, aucune sanction, aucun pays n'est codé en dur.
 */
import { useMemo, useState } from 'react';
import { CalendarClock, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, Select, cn } from '../../components/ui';
import { useOptionalToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { useRecords } from '../records/useRecords';
import { todayIso } from '../finance/model';
import {
  AVERTISSEMENT_CONFORMITE, CATEGORIES_ECHEANCE, REPERES_COURANTS,
  dateReelle, echeanceFromRecord, echeanceToData, echeancesProches, echeancesVues,
  type Echeance, type UrgenceEcheance,
} from './echeances';

const TON_URGENCE: Record<UrgenceEcheance, 'danger' | 'warning' | 'neutral' | 'success'> = {
  passee: 'danger', aujourdhui: 'danger', proche: 'warning', a_venir: 'neutral',
};

const LIBELLE_URGENCE: Record<UrgenceEcheance, string> = {
  passee: 'Dépassée', aujourdhui: 'Aujourd’hui', proche: 'Sous 30 jours', a_venir: 'À venir',
};

/** Catégorie réelle, scopée à l'entreprise par `useRecords`. */
export const CATEGORIE_ECHEANCES = 'bg_module_compliance_deadlines';

const vide = (): Echeance => ({
  id: '', label: '', categorie: 'taxes', date: '', recurrence: 'annuelle', notes: '', verifiee: false,
});

export function EcheancesWorkspace({ workspaceId }: { workspaceId: string | null }) {
  const toast = useOptionalToast();
  /*
   * Une catégorie DÉDIÉE, pas une collection métier détournée.
   *
   * Glisser des échéances dans les dépenses fausserait les totaux de trésorerie
   * (une échéance n'est pas une sortie d'argent), et une catégorie inventée
   * serait refusée par le serveur. `bg_module_compliance_deadlines` est une
   * catégorie `bg_module_*` valide côté SQL : elle fonctionne sans migration,
   * car le socle valide le motif, pas une liste fermée.
   */
  const store = useRecords(CATEGORIE_ECHEANCES, workspaceId);
  const [brouillon, setBrouillon] = useState<Echeance>(vide);
  const [enCours, setEnCours] = useState(false);
  const today = todayIso();

  const echeances = useMemo(() => store.records.map(echeanceFromRecord), [store.records]);
  const vues = useMemo(() => echeancesVues(echeances, today), [echeances, today]);
  const proches = echeancesProches(vues);

  const ajouter = async () => {
    if (!workspaceId) return;
    if (!brouillon.label.trim()) {
      toast?.error('Donnez un nom à l’échéance.');
      return;
    }
    if (!dateReelle(brouillon.date)) {
      toast?.error('Cette date n’existe pas : vérifiez le jour et le mois.');
      return;
    }
    setEnCours(true);
    try {
      await store.create(echeanceToData({ ...brouillon, label: brouillon.label.trim().slice(0, 160) }), null);
      setBrouillon(vide());
      toast?.success('Échéance ajoutée. Vérifiez la date auprès de votre source avant de vous y fier.');
    } catch (cause) {
      toast?.error(asAppError(cause).message);
    } finally {
      setEnCours(false);
    }
  };

  if (store.loading) return <LoadingState label="Chargement des échéances…" />;
  if (store.error) return <ErrorState message={store.error} onRetry={() => void store.reload()} />;

  return (
    <Card data-testid="echeances-workspace">
      <CardHeader
        title="Échéances et conformité"
        description="Vos dates, rappelées à temps. Vous décidez ce qui s’applique : l’application ne donne aucun conseil."
        action={<Badge tone={proches.length > 0 ? 'warning' : 'neutral'}>{proches.length} à traiter</Badge>}
      />

      <p className="mb-3 flex items-start gap-1.5 rounded-lg border border-sky-500/25 bg-sky-500/[0.06] px-2.5 py-1.5 text-[10.5px] text-sky-100/90">
        <ShieldAlert size={12} className="mt-0.5 shrink-0" />
        {AVERTISSEMENT_CONFORMITE}
      </p>

      <div className="mb-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
        <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">Ajouter une échéance</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-[10.5px] text-slate-400">
            Nom
            <input
              type="text"
              value={brouillon.label}
              onChange={(event) => setBrouillon((actuel) => ({ ...actuel, label: event.target.value }))}
              placeholder="Ex. : déclaration périodique"
              list="reperes-echeances"
              aria-label="Nom de l’échéance"
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[12px] text-white placeholder:text-slate-600"
            />
            <datalist id="reperes-echeances">
              {REPERES_COURANTS.map((repere) => <option key={repere.label} value={repere.label} />)}
            </datalist>
          </label>
          <Select
            label="Catégorie"
            value={brouillon.categorie}
            onChange={(event) => setBrouillon((actuel) => ({ ...actuel, categorie: event.target.value as Echeance['categorie'] }))}
          >
            {CATEGORIES_ECHEANCE.map((categorie) => (
              <option key={categorie.value} value={categorie.value}>{categorie.label}</option>
            ))}
          </Select>
          <label className="text-[10.5px] text-slate-400">
            Date
            <input
              type="date"
              value={brouillon.date}
              onChange={(event) => setBrouillon((actuel) => ({ ...actuel, date: event.target.value }))}
              aria-label="Date de l’échéance"
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[12px] text-white"
            />
          </label>
          <Select
            label="Répétition"
            value={brouillon.recurrence}
            onChange={(event) => setBrouillon((actuel) => ({ ...actuel, recurrence: event.target.value as Echeance['recurrence'] }))}
          >
            <option value="aucune">Aucune (une seule fois)</option>
            <option value="mensuelle">Chaque mois</option>
            <option value="annuelle">Chaque année</option>
          </Select>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10.5px] text-slate-400">
            <input
              type="checkbox"
              checked={brouillon.verifiee}
              onChange={(event) => setBrouillon((actuel) => ({ ...actuel, verifiee: event.target.checked }))}
            />
            J’ai vérifié cette date auprès de ma source
          </label>
          <Button size="sm" variant="primary" icon={<Plus size={12} />} loading={enCours} onClick={() => void ajouter()}>
            Ajouter
          </Button>
        </div>
        <p className="mt-1.5 text-[10px] text-slate-500">
          Repères proposés, à confirmer : {REPERES_COURANTS.map((repere) => repere.label).join(' · ')}.
        </p>
      </div>

      {vues.length === 0 ? (
        <EmptyState
          icon={<CalendarClock size={22} />}
          title="Aucune échéance enregistrée"
          description="Ajoutez une date que vous devez tenir. L’application vous la rappellera ; elle ne décidera pas à votre place de ce qui est obligatoire."
        />
      ) : (
        <ul className="liste-mobile overflow-hidden rounded-xl border border-white/[0.06]">
          {vues.map((vue) => (
            <li key={vue.echeance.id} className="flex items-start justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-semibold text-white">{vue.echeance.label}</p>
                <p className="mt-0.5 text-[10.5px] text-slate-500">
                  {vue.prochaineDate} · {vue.echeance.recurrence === 'aucune' ? 'une seule fois' : vue.echeance.recurrence}
                  {vue.joursRestants >= 0 ? ` · dans ${vue.joursRestants} jour(s)` : ` · dépassée de ${Math.abs(vue.joursRestants)} jour(s)`}
                </p>
                <p className={cn('mt-0.5 text-[10px]', vue.echeance.verifiee ? 'text-emerald-300/80' : 'text-amber-300/80')}>
                  {vue.echeance.verifiee ? 'Date confirmée par vous' : 'Date non confirmée : à vérifier'}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Badge tone={TON_URGENCE[vue.urgence]}>{LIBELLE_URGENCE[vue.urgence]}</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Supprimer ${vue.echeance.label}`}
                  onClick={() => {
                    void store.remove(vue.echeance.id).catch((cause) => toast?.error(asAppError(cause).message));
                  }}
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
