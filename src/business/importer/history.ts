/**
 * Historique des imports — appels serveur.
 *
 * ## Pourquoi des RPC et pas une lecture de table
 * `saas_ugc.ugc_import_jobs` n'est pas exposée à PostgREST (le schéma exposé est
 * `public`). Les RPC appliquent en base : identité par `auth.uid()`, portée
 * limitée à l'entreprise dont l'appelant est membre, et refus motivé sinon.
 * Aucun identifiant d'utilisateur n'est transmis — il ne pourrait donc pas
 * élargir la portée.
 */
import { rpc } from '../../lib/api';
import { normalizeHistory, normalizeReport, type ImportHistoryPage, type ImportJobReport } from './history-model';

export * from './history-model';

export async function loadImportHistory(input: {
  workspaceId: string;
  limit?: number;
  offset?: number;
}): Promise<ImportHistoryPage> {
  const raw = await rpc<unknown>('vyora_ugc_import_history', {
    p_workspace_id: input.workspaceId,
    p_limit: input.limit ?? 50,
    p_offset: input.offset ?? 0,
  });
  return normalizeHistory(raw);
}

/** Charge le rapport détaillé d'un import (erreurs ligne par ligne). */
export async function loadImportReport(jobId: string): Promise<ImportJobReport> {
  const raw = await rpc<unknown>('vyora_ugc_import_report', { p_job_id: jobId });
  const rapport = normalizeReport(raw);
  if (!rapport) throw new Error('Rapport d’import illisible.');
  return rapport;
}
