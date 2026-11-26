/**
 * Écran Veille marché et concurrence.
 *
 * Les concurrents viennent de la mémoire métier existante (`growth/model.ts`,
 * catégorie `competitor`) : on ne crée pas un second stockage pour la même
 * information. Les signaux viennent de la catégorie `signal`, déjà utilisée par
 * Grow. Aucune collecte automatique.
 */
import { useMemo, useState } from 'react';
import { Eye, Upload } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, cn } from '../../components/ui';
import { useOptionalToast } from '../../context/ToastContext';
import type { BusinessMemory } from '../api';
import { readCompetitors, readSignals } from './model';
import {
  concurrentDepuisMemoire, fichesConcurrents, importerConcurrentsCsv, syntheseVeille,
  type ConcurrentImporte,
} from './veille';
import { todayIso } from '../finance/model';

export function VeilleWorkspace({
  memory,
  prixMaison,
  deviseMaison = '',
  onOpenAssistant,
}: {
  memory: BusinessMemory | null | undefined;
  /** Votre prix de référence, saisi ou lu dans le catalogue. */
  prixMaison: number | null;
  deviseMaison?: string;
  onOpenAssistant?: (prompt: string) => void;
}) {
  const toast = useOptionalToast();
  const [importes, setImportes] = useState<ConcurrentImporte[]>([]);
  const today = todayIso();

  const concurrentsMemoire = useMemo(() => readCompetitors(memory).map(concurrentDepuisMemoire), [memory]);
  const signaux = useMemo(() => readSignals(memory), [memory]);
  const concurrents = useMemo(() => [...concurrentsMemoire, ...importes], [concurrentsMemoire, importes]);
  const fiches = useMemo(() => fichesConcurrents(concurrents, prixMaison, deviseMaison), [concurrents, prixMaison, deviseMaison]);
  const synthese = useMemo(() => syntheseVeille(fiches, signaux, today), [fiches, signaux, today]);

  const importer = (fichier: File | null) => {
    if (!fichier) return;
    const lecteur = new FileReader();
    lecteur.onload = () => {
      const resultat = importerConcurrentsCsv(String(lecteur.result ?? ''));
      if (resultat.erreurs.length > 0) toast?.error(resultat.erreurs[0]);
      if (resultat.concurrents.length === 0) {
        toast?.error('Aucun concurrent lisible dans ce fichier.');
        return;
      }
      setImportes((actuel) => [...actuel, ...resultat.concurrents]);
      toast?.success(`${resultat.concurrents.length} concurrent(s) importé(s)${resultat.ignorees > 0 ? `, ${resultat.ignorees} ligne(s) ignorée(s)` : ''}.`);
    };
    lecteur.readAsText(fichier);
  };

  return (
    <Card data-testid="veille-workspace">
      <CardHeader
        title="Veille marché et concurrence"
        description="Ce que vous avez saisi ou importé, mis en perspective. Aucune collecte automatique sur les sites concurrents."
        action={<Badge tone="neutral">{fiches.length} fiche(s)</Badge>}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-slate-300">
          <Upload size={12} className="mr-1 inline" />
          Importer des concurrents (CSV)
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(event) => { importer(event.target.files?.[0] ?? null); event.target.value = ''; }}
          />
        </label>
        <span className="text-[10px] text-slate-500">Colonnes : nom, url, positionnement, forces, faiblesses, prix, devise, releve_le</span>
        {onOpenAssistant && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenAssistant(`Synthétise la veille concurrentielle enregistrée (${fiches.length} concurrent(s), ${signaux.length} signal/signaux). Appuie-toi uniquement sur ces données et signale ce qui manque.`)}
          >
            Demander une synthèse à l’agent
          </Button>
        )}
      </div>

      {synthese.vide ? (
        <EmptyState
          icon={<Eye size={22} />}
          title="Aucune donnée de veille"
          description="Ajoutez un concurrent dans le module Croissance, ou importez un fichier CSV. Sans donnée, aucune synthèse n’est produite : elle serait inventée."
        />
      ) : (
        <div className="space-y-2">
          {synthese.constats.length > 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">Constaté dans vos données</p>
              <ul className="space-y-1">
                {synthese.constats.map((constat) => (
                  <li key={constat} className="text-[11.5px] text-slate-300">· {constat}</li>
                ))}
              </ul>
            </div>
          )}

          {synthese.manques.length > 0 && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-2.5">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-amber-200/90">Ce qui manque pour conclure</p>
              <ul className="space-y-1">
                {synthese.manques.map((manque) => (
                  <li key={manque} className="text-[11px] text-amber-100/80">· {manque}</li>
                ))}
              </ul>
            </div>
          )}

          <ul className="liste-mobile overflow-hidden rounded-xl border border-white/[0.06]">
            {fiches.map((fiche) => (
              <li key={fiche.nom} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-semibold text-white">{fiche.nom}</p>
                    <p className="mt-0.5 text-[10.5px] text-slate-500">
                      {fiche.positionnement || 'Positionnement non décrit'}
                    </p>
                  </div>
                  <div className="text-right">
                    {typeof fiche.prix === 'number' ? (
                      <Badge tone="neutral">{new Intl.NumberFormat('fr-FR').format(fiche.prix)} {fiche.devise ?? deviseMaison}</Badge>
                    ) : (
                      <Badge tone="warning">Prix non relevé</Badge>
                    )}
                    <p className={cn('mt-0.5 text-[10px]',
                      fiche.ecartPourcent === null ? 'text-slate-500' : fiche.ecartPourcent < 0 ? 'text-rose-300' : 'text-emerald-300')}>
                      {fiche.ecartPourcent === null ? '—' : `${fiche.ecartPourcent > 0 ? '+' : ''}${fiche.ecartPourcent} % vs votre prix`}
                    </p>
                  </div>
                </div>
                {fiche.incompletudes.length > 0 && (
                  <p className="mt-1 text-[10px] text-amber-200/70">À compléter : {fiche.incompletudes.join(' · ')}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
