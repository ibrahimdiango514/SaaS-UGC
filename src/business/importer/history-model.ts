/**
 * Historique des imports — modèle pur (lecture et mise en forme).
 *
 * Aucun réseau ici : `lib/api.ts` touche `window`, et un module qui l'importe ne
 * peut pas être testé hors navigateur. Les appels sont dans `history.ts`.
 *
 * ## Pourquoi une RPC et pas PostgREST
 * `saas_ugc` n'est pas exposé à PostgREST (seul `public` l'est) : la table
 * `ugc_import_jobs` est donc inatteignable depuis le navigateur, et c'est
 * volontaire. La RPC `vyora_ugc_import_history` filtre sur `auth.uid()` en base
 * et ne rend que les champs d'affichage — jamais le `payload` d'un aperçu, ni
 * l'identifiant de l'utilisateur qui a lancé l'import.
 *
 * ## Ce que ce module fait, et ne fait pas
 * Il traduit en libellés lisibles et formate les dates. Il ne décide d'aucun
 * droit : un refus vient de la base (42501) et remonte tel quel. Un compte
 * expiré consulte son historique — la lecture ne dépend pas de l'abonnement.
 */

/** Statuts réellement produits par l'Edge Function. */
export type ImportJobStatus = 'completed' | 'partial' | 'failed';

/** Format déduit du nom de fichier, ou `url` pour une boutique. */
export type ImportJobFormat = 'csv' | 'xlsx' | 'url' | 'fichier';

export interface ImportJobSummary {
  id: string;
  createdAt: string;
  source: 'file' | 'url';
  /** Nom du fichier déposé, ou adresse de la boutique. Peut être absent. */
  reference: string | null;
  status: ImportJobStatus;
  productsCreated: number;
  productsFailed: number;
  variantsCreated: number;
  errorsCount: number;
  format: ImportJobFormat;
}

export interface ImportJobReport extends ImportJobSummary {
  failures: Array<{ name: string; reason: string }>;
}

export interface ImportHistoryPage {
  total: number;
  limit: number;
  offset: number;
  jobs: ImportJobSummary[];
}

/* ------------------------------ normalisation ----------------------------- */

/**
 * Déduit le format d'un import.
 *
 * La RPC le fournit déjà ; cette déduction sert quand il manque (ligne ancienne,
 * test, appel direct) et suit exactement la même règle que le SQL : URL d'abord,
 * puis extension, puis « fichier » générique. Diverger ici afficherait « CSV »
 * sur un XLSX importé.
 */
export function inferFormat(source: 'file' | 'url', reference: string | null): ImportJobFormat {
  if (source === 'url') return 'url';
  if (!reference) return 'fichier';
  if (/^https?:\/\//i.test(reference)) return 'url';
  if (/\.xlsx?$/i.test(reference)) return 'xlsx';
  if (/\.csv$/i.test(reference)) return 'csv';
  return 'fichier';
}

const STATUTS: ReadonlySet<string> = new Set<ImportJobStatus>(['completed', 'partial', 'failed']);
const FORMATS: ReadonlySet<string> = new Set<ImportJobFormat>(['csv', 'xlsx', 'url', 'fichier']);

function nombre(valeur: unknown): number {
  const n = Number(valeur);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function texte(valeur: unknown): string | null {
  return typeof valeur === 'string' && valeur.trim() !== '' ? valeur : null;
}

/**
 * Lit une ligne d'historique telle que la RPC la renvoie.
 *
 * Toute valeur inattendue retombe sur une valeur sûre : un statut inconnu est
 * traité comme `failed` (on ne présente jamais un import douteux comme réussi)
 * et un format inconnu comme `fichier`.
 */
export function normalizeJob(raw: unknown): ImportJobSummary | null {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = texte(source.id);
  if (!id) return null;

  const statut = texte(source.status) ?? '';
  const formatExplicite = texte(source.format) ?? '';
  const forme: 'file' | 'url' = source.source === 'url' ? 'url' : 'file';
  const reference = texte(source.reference);

  return {
    id,
    createdAt: texte(source.created_at) ?? '',
    source: forme,
    reference,
    status: STATUTS.has(statut) ? (statut as ImportJobStatus) : 'failed',
    productsCreated: nombre(source.products_created),
    productsFailed: nombre(source.products_failed),
    variantsCreated: nombre(source.variants_created),
    errorsCount: nombre(source.errors_count),
    format: FORMATS.has(formatExplicite) ? (formatExplicite as ImportJobFormat) : inferFormat(forme, reference),
  };
}

export function normalizeHistory(raw: unknown): ImportHistoryPage {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const jobs = Array.isArray(source.jobs)
    ? source.jobs.map(normalizeJob).filter((job): job is ImportJobSummary => job !== null)
    : [];
  return {
    total: nombre(source.total),
    limit: nombre(source.limit) || 50,
    offset: nombre(source.offset),
    jobs,
  };
}

export function normalizeReport(raw: unknown): ImportJobReport | null {
  const base = normalizeJob(raw);
  if (!base) return null;
  const source = raw as Record<string, unknown>;
  const failures = Array.isArray(source.failures)
    ? source.failures
      .map((entree) => {
        const item = (entree && typeof entree === 'object' ? entree : {}) as Record<string, unknown>;
        const name = texte(item.name);
        const reason = texte(item.reason);
        return name && reason ? { name, reason } : null;
      })
      .filter((item): item is { name: string; reason: string } => item !== null)
    : [];
  return { ...base, failures };
}

/* -------------------------------- libellés -------------------------------- */

export const STATUS_LABELS: Record<ImportJobStatus, string> = {
  completed: 'Terminé',
  partial: 'Partiel',
  failed: 'Échoué',
};

/**
 * Couleur associée au statut, pour la pastille de l'historique.
 *
 * Trois familles distinctes : vert (rien à faire), ambre (à vérifier), rouge
 * (rien n'est passé). Un import partiel n'est ni un succès ni un échec — le
 * confondre avec l'un des deux ferait ignorer des produits manquants.
 */
export const STATUS_TONES: Record<ImportJobStatus, string> = {
  completed: 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-100',
  partial: 'border-amber-400/25 bg-amber-400/[0.08] text-amber-100',
  failed: 'border-rose-400/25 bg-rose-400/[0.08] text-rose-100',
};

export const FORMAT_LABELS: Record<ImportJobFormat, string> = {
  csv: 'CSV',
  xlsx: 'XLSX',
  url: 'URL de boutique',
  fichier: 'Fichier',
};

/**
 * Nom lisible de l'origine.
 *
 * `reference` peut manquer (import ancien, source sans nom) : on retombe alors
 * sur le format, plutôt que d'afficher « null » à l'écran.
 */
export function originLabel(job: ImportJobSummary): string {
  if (job.reference) return job.reference;
  return FORMAT_LABELS[job.format];
}

/**
 * Date lisible en français, indépendante du fuseau du serveur.
 *
 * `fr-FR` et non la locale du navigateur : un rapport d'import se partage, et
 * deux personnes doivent lire la même date.
 */
export function formatJobDate(iso: string): string {
  if (!iso) return 'Date inconnue';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Date inconnue';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/**
 * Résumé d'une ligne en une phrase.
 *
 * Les variantes ne sont mentionnées que si l'import en a créé : « 0 variante »
 * sur un CSV sans déclinaison serait du bruit.
 */
export function summaryLine(job: ImportJobSummary): string {
  const produits = `${job.productsCreated} produit${job.productsCreated > 1 ? 's' : ''}`;
  const variantes = job.variantsCreated > 0
    ? ` · ${job.variantsCreated} variante${job.variantsCreated > 1 ? 's' : ''}`
    : '';
  const erreurs = job.errorsCount > 0
    ? ` · ${job.errorsCount} erreur${job.errorsCount > 1 ? 's' : ''}`
    : '';
  return `${produits}${variantes}${erreurs}`;
}

/* --------------------------------- appels --------------------------------- */

/**
 * Charge une page d'historique.
 *
 * `workspaceId` ne sert qu'à désigner l'espace : la base exige que l'appelant
 * en soit membre, donc cet identifiant ne peut pas élargir la portée.
 */
