/**
 * VYORA — écran de blocage de quota.
 *
 * Exigence : « Au blocage : message clair, consommation affichée, date de
 * renouvellement, proposition d'offre supérieure ».
 *
 * Quatre informations, dans cet ordre, parce que c'est l'ordre dans lequel un
 * client se pose les questions :
 *   1. Qu'est-ce que je ne peux plus faire ?  (« Vous avez atteint vos 30 prospects »)
 *   2. Où j'en suis exactement ?              (barre + « 30 / 30 »)
 *   3. Quand ça se débloque ?                 (« le 18 décembre, dans 29 jours »)
 *   4. Qu'est-ce que je fais maintenant ?     (bouton vers l'offre supérieure)
 *
 * Aucune de ces quatre réponses n'est laissée à l'imagination de l'utilisateur.
 */

import { ArrowUpRight, CalendarClock, CircleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { LIBELLE_ACTION, dateLisible, joursAvantRenouvellement, type ActionQuota, type ResultatQuota } from '../lib/quotas';
import { cn } from './ui';

interface Props {
  action: ActionQuota;
  resultat: ResultatQuota;
  /** Route vers l'offre. Par défaut, la page d'abonnement. */
  offreHref?: string;
  /** Nom de l'offre supérieure si l'appelant le connaît. */
  offreNom?: string;
  className?: string;
  compact?: boolean;
}

export function QuotaBlocage({ action, resultat, offreHref = '/app/abonnement', offreNom, className, compact }: Props) {
  const label = LIBELLE_ACTION[action];
  const jours = joursAvantRenouvellement(resultat.periode_fin);
  const pct =
    resultat.limite && resultat.limite > 0
      ? Math.min(100, Math.round((resultat.utilise / resultat.limite) * 100))
      : 100;

  return (
    <div
      role="alert"
      className={cn(
        'rounded-2xl border border-amber-400/30 bg-amber-500/[0.07] p-4 sm:p-5',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <CircleAlert size={20} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-100">
            Vous avez atteint votre limite de {label}
          </p>

          {resultat.limite !== null && (
            <div className="mt-3">
              <div className="flex items-baseline justify-between gap-3 text-xs text-slate-400">
                <span>Utilisé ce mois-ci</span>
                <span className="tabular-nums text-slate-200">
                  {resultat.utilise} / {resultat.limite} {label}
                </span>
              </div>
              <div
                className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10"
                role="progressbar"
                aria-valuenow={resultat.utilise}
                aria-valuemin={0}
                aria-valuemax={resultat.limite}
                aria-label={`Consommation de ${label}`}
              >
                <div
                  className="h-full rounded-full bg-amber-400 transition-[width] duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}

          {resultat.periode_fin && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
              <CalendarClock size={14} aria-hidden="true" />
              Votre quota se renouvelle le{' '}
              <strong className="font-semibold text-slate-200">{dateLisible(resultat.periode_fin)}</strong>
              {jours !== null && jours > 0 ? `, dans ${jours} jour${jours > 1 ? 's' : ''}` : ''}.
            </p>
          )}

          {!compact && (
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              Vos données restent accessibles : rien n’est supprimé. Seule la création de nouveaux
              éléments est suspendue jusqu’au renouvellement.
            </p>
          )}

          <Link
            to={offreHref}
            className="btn btn-primary btn-sm mt-4 inline-flex"
          >
            {offreNom ? `Passer à ${offreNom}` : 'Voir l’offre supérieure'}
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Porte d'entrée pratique : consomme puis, si refusé, affiche le blocage.
 * Renvoie `true` si l'action peut continuer.
 *
 * Utilisation type :
 *   const ok = await verifierAvantAction(ws, 'prospect');
 *   if (!ok) return;           // le message est déjà affiché
 *   await creerProspect(...);
 */
export async function verifierAvantAction(
  workspaceId: string,
  action: ActionQuota,
  afficher: (resultat: ResultatQuota) => void,
  quantite = 1,
): Promise<boolean> {
  const { consommerQuota } = await import('../lib/quotas');
  const resultat = await consommerQuota(workspaceId, action, quantite);
  if (!resultat.autorise) {
    afficher(resultat);
    return false;
  }
  return true;
}
