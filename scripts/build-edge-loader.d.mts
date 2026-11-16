/** Déclaration du générateur de chargeurs Edge publiés par tranches. */
export declare const SLICE_CHARS: number;
export declare const SLICES_TABLE: string;
export declare const LOADER_TARGETS: Record<string, { migration: string }>;
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

/** Nom de la table du manifeste d'empreintes (verrou de publication). */
export declare const MANIFEST_TABLE: string;
/** Constantes de publication calculées depuis le bundle réellement construit. */
export declare function publicationConstants(
  slug: string,
  built: { base64: string; chars: number; slices: string[]; sha256: string },
): {
  slicesSha256: string;
  base64Chars: number;
  chars: number;
  parts: number;
  sha256: string;
};
/** SQL de pose de l'épingle de publication (verrou). */
export declare function renderSealSql(
  slug: string,
  built: { base64: string; chars: number; slices: string[]; sha256: string },
  note?: string,
): string;
