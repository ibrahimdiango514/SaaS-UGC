/** Déclaration du générateur de chargeurs Edge publiés par tranches. */
export declare const SLICE_CHARS: number;
export declare const SLICES_TABLE: string;
/**
 * Migration de publication de chaque chargeur.
 *
 * `republish: true` signale un artefact republié dans une migration NOUVELLE
 * (plusieurs artefacts peuvent alors partager un même fichier).
 */
export declare const LOADER_TARGETS: Record<
  string,
  { migration: string; republish?: boolean }
>;
/** Migrations de publication historiques, figées : jamais réécrites. */
export declare const FROZEN_ARTIFACT_MIGRATIONS: Record<string, string>;
/** Bundle compilé, gzip+base64 et découpé en tranches prêtes à publier. */
export declare function buildBundle(
  root: string,
  slug: string,
): {
  source: string;
  sha256: string;
  base64: string;
  /** MD5 de la concaténation base64 : vérifié par le garde SQL de publication. */
  base64Md5: string;
  slices: string[];
  chars: number;
  gzBytes: number;
};
/** Retire `export` / `import` : le code est exécuté par `new Function`. */
export declare function stripModuleSyntax(source: string): string;
/** gzip reproductible (MTIME forcé à 0). */
export declare function deterministicGzip(input: string | Buffer): Buffer;
/** Texte échappé en littéral SQL. */
export declare function sqlLiteral(value: string): string;
/** Contenu exact du chargeur déployé (`supabase/functions/<slug>/loader.ts`). */
export declare function renderLoader(
  slug: string,
  built: { sha256: string; chars: number },
): string;
/** SQL de publication des tranches + garde d'intégrité. */
export declare function renderSeedSql(
  slug: string,
  built: {
    source: string;
    sha256: string;
    base64: string;
    base64Md5: string;
    slices: string[];
    chars: number;
  },
): string;
/**
 * SQL d'une migration de republication groupée : en-tête explicatif puis la
 * publication de chaque artefact du groupe.
 */
export declare function renderRepublishSql(
  entries: Array<{ slug: string; built: { source: string; sha256: string; base64: string; base64Md5: string; slices: string[]; chars: number } }>,
): string;
/** Slugs publiés par le même fichier de migration que `slug`. */
export declare function republishGroup(slug: string): string[];
