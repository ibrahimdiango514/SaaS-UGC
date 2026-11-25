/**
 * SORAHNEX — historique des imports.
 *
 * ## Ce que l'écran montre
 * Pour chaque import : la date, l'origine (CSV, XLSX, URL et nom du fichier),
 * le statut, le nombre de produits créés, de variantes créées et d'erreurs, et
 * un accès au rapport détaillé.
 *
 * ## Ce qu'il ne peut pas montrer
 * Les données d'une autre entreprise : la RPC exige l'appartenance et filtre sur
 * `auth.uid()`. Un refus arrive en 42501 et s'affiche tel quel — l'interface ne
 * décide d'aucun droit.
 *
 * ## Lecture seule
 * Un compte dont l'abonnement a expiré consulte son historique intégralement :
 * la lecture ne dépend pas de l'abonnement. Seul l'import est fermé.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Download, FileSpreadsheet, Globe, History, RefreshCw } from 'lucide-react';
import { Button, EmptyState, ErrorState, LoadingState, cn } from '../../components/ui';
import { asAppError } from '../../lib/errors';
import {
  FORMAT_LABELS, STATUS_LABELS, STATUS_TONES, formatJobDate, originLabel, summaryLine,
  type ImportHistoryPage, type ImportJobReport, type ImportJobSummary,
} from './history-model';
import { loadImportHistory, loadImportReport } from './history';

const PAGE_SIZE = 20;

export function ImportHistoryPanel({ workspaceId }: { workspaceId: string | null }) {
  const [page, setPage] = useState<ImportHistoryPage | null>(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState('');
  const [décalage, setDécalage] = useState(0);
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [rapport, setRapport] = useState<ImportJobReport | null>(null);
  const [rapportEnCours, setRapportEnCours] = useState(false);

  const charger = useCallback(async (offset: number) => {
    if (!workspaceId) {
      setPage(null);
      setChargement(false);
      return;
    }
    setChargement(true);
    setErreur('');
    try {
      const résultat = await loadImportHistory({ workspaceId, limit: PAGE_SIZE, offset });
      setPage(résultat);
      setDécalage(résultat.offset);
    } catch (cause) {
      setErreur(asAppError(cause).message);
      setPage(null);
    } finally {
      setChargement(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setOuvert(null);
    setRapport(null);
    void charger(0);
  }, [charger, workspaceId]);

  const ouvrirRapport = async (job: ImportJobSummary) => {
    if (ouvert === job.id) {
      setOuvert(null);
      setRapport(null);
      return;
    }
    setOuvert(job.id);
    setRapport(null);
    // Un import sans erreur n'a rien de plus à montrer : inutile d'appeler la
    // base pour afficher « aucune erreur ».
    if (job.errorsCount === 0) return;
    setRapportEnCours(true);
    try {
      setRapport(await loadImportReport(job.id));
    } catch (cause) {
      setErreur(asAppError(cause).message);
    } finally {
      setRapportEnCours(false);
    }
  };

  /**
   * Export du rapport affiché.
   *
   * Fait côté navigateur à partir de données déjà autorisées : aucune requête
   * supplémentaire, donc aucun risque d'élargir la portée par ce bouton.
   */
  const exporter = (job: ImportJobSummary, détail: ImportJobReport | null) => {
    const contenu = {
      exported_at: new Date().toISOString(),
      import: {
        date: job.createdAt,
        origine: originLabel(job),
        format: FORMAT_LABELS[job.format],
        statut: STATUS_LABELS[job.status],
        produits_crees: job.productsCreated,
        variantes_creees: job.variantsCreated,
        erreurs: job.errorsCount,
      },
      details_erreurs: détail?.failures ?? [],
    };
    const blob = new Blob([JSON.stringify(contenu, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const lien = document.createElement('a');
    lien.href = url;
    lien.download = `import-${job.createdAt.slice(0, 10) || 'vyora'}.json`;
    lien.click();
    URL.revokeObjectURL(url);
  };

  if (!workspaceId) {
    return (
      <EmptyState
        icon={<History size={22} />}
        title="Aucune entreprise sélectionnée"
        description="Sélectionnez une entreprise pour consulter son historique d’imports."
      />
    );
  }

  if (chargement && !page) return <LoadingState label="Chargement de l’historique…" />;
  if (erreur) return <ErrorState message={erreur} onRetry={() => void charger(décalage)} />;
  if (!page || page.jobs.length === 0) {
    return (
      <EmptyState
        icon={<History size={22} />}
        title="Aucun import pour le moment"
        description="Chaque import confirmé depuis le catalogue apparaîtra ici, avec son rapport d’erreurs."
      />
    );
  }

  const fin = page.offset + page.jobs.length;
  const suivantDisponible = fin < page.total;

  return (
    <div data-testid="import-history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-slate-400">
          {page.total} import{page.total > 1 ? 's' : ''} · {page.jobs.length} affiché
          {page.jobs.length > 1 ? 's' : ''}
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={12} />}
          onClick={() => void charger(décalage)}
          disabled={chargement}
        >
          Actualiser
        </Button>
      </div>

      <ul className="mt-3 space-y-2">
        {page.jobs.map((job) => {
          const estOuvert = ouvert === job.id;
          return (
            <li
              key={job.id}
              className="rounded-xl border border-white/[0.07] bg-black/20"
              data-testid={`import-job-${job.id}`}
            >
              <button
                type="button"
                onClick={() => void ouvrirRapport(job)}
                className="flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left"
                aria-expanded={estOuvert}
              >
                <span className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-slate-500">
                    {job.format === 'url' ? <Globe size={13} /> : <FileSpreadsheet size={13} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-white">{originLabel(job)}</span>
                    <span className="mt-0.5 block text-[10px] text-slate-500">
                      {formatJobDate(job.createdAt)} · {FORMAT_LABELS[job.format]}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-slate-400">{summaryLine(job)}</span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className={cn('rounded-full border px-2 py-0.5 text-[9px] font-medium', STATUS_TONES[job.status])}>
                    {STATUS_LABELS[job.status]}
                  </span>
                  {estOuvert ? <ChevronDown size={13} className="text-slate-500" /> : <ChevronRight size={13} className="text-slate-500" />}
                </span>
              </button>

              {estOuvert && (
                <div className="border-t border-white/[0.06] px-3 py-2.5 text-[10px]" data-testid={`import-report-${job.id}`}>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                    <div>
                      <dt className="text-slate-500">Produits créés</dt>
                      <dd className="text-slate-200">{job.productsCreated}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Variantes créées</dt>
                      <dd className="text-slate-200">{job.variantsCreated}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Produits en échec</dt>
                      <dd className="text-slate-200">{job.productsFailed}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Erreurs</dt>
                      <dd className={job.errorsCount > 0 ? 'text-rose-200' : 'text-slate-200'}>{job.errorsCount}</dd>
                    </div>
                  </dl>

                  {job.errorsCount === 0 ? (
                    <p className="mt-2 text-emerald-200/80">Aucune erreur à signaler sur cet import.</p>
                  ) : rapportEnCours ? (
                    <p className="mt-2 text-slate-500">Chargement du rapport…</p>
                  ) : rapport && rapport.id === job.id && rapport.failures.length > 0 ? (
                    <ul className="mt-2 space-y-0.5" data-testid="import-report-failures">
                      {rapport.failures.map((échec, index) => (
                        <li key={`${échec.name}-${index}`} className="text-rose-100/80">
                          · {échec.name} : {échec.reason}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-slate-500">Détail des erreurs indisponible.</p>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    icon={<Download size={11} />}
                    onClick={() => exporter(job, rapport && rapport.id === job.id ? rapport : null)}
                    data-testid={`import-export-${job.id}`}
                  >
                    Exporter le rapport
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {(page.offset > 0 || suivantDisponible) && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={page.offset === 0 || chargement}
            onClick={() => void charger(Math.max(0, page.offset - PAGE_SIZE))}
          >
            Précédent
          </Button>
          <span className="text-[10px] text-slate-500">
            {page.offset + 1}–{fin} sur {page.total}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!suivantDisponible || chargement}
            onClick={() => void charger(page.offset + PAGE_SIZE)}
          >
            Suivant
          </Button>
        </div>
      )}
    </div>
  );
}
