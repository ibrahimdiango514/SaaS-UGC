/**
 * Déclaration du générateur d'artefacts Edge (bundle committé + chargeur court).
 *
 * Les tests importent le script `.mjs` directement : sans ces types, `tsc`
 * échoue en TS7016 (module implicitement `any`) dès qu'un test touche le
 * générateur. Les signatures suivent exactement l'implémentation.
 */

/** Fonctions gérées, avec leurs chemins d'entrée et de sortie. */
export declare const FUNCTIONS: Record<
  string,
  {
    entry: string;
    artifact: string;
    loader: string;
    /** Variables d'environnement attendues par la fonction (jamais de valeur). */
    env: readonly string[];
  }
>;

/** Résultat de la compilation esbuild d'une fonction. */
export interface EdgeArtifact {
  /** Bundle ESM, syntaxe de module retirée, prêt pour `new Function`. */
  source: string;
  /** SHA-256 hexadécimal du bundle publié. */
  sha256: string;
  /** Longueur du bundle en caractères UTF-16 (`char_length` en base). */
  chars: number;
}

/** Compile la source d'une fonction en bundle exécutable. */
export declare function bundleEdgeFunction(
  name: string,
  root?: string,
): { source: string; sha256: string; chars: number };

/** Compile puis renvoie l'artefact complet (bundle + empreinte). */
export declare function buildArtifact(name: string, root?: string): EdgeArtifact;

/** Rend le chargeur court qui reconstruit le bundle déployé. */
export declare function renderLoader(
  name: string,
  artifact: { sha256: string; chars: number },
): string;

/** Rend le SQL (ou le texte) qui publie l'artefact. */
export declare function artifactSql(
  name: string,
  artifact: { source: string; sha256: string; chars: number },
): string;
