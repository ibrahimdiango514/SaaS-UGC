/** Déclaration du générateur d'artefact Edge des paiements SasPay. */
export declare const ENTRY: string;
/** Bundle exact, publié dans `public._edge_function_artifact`. */
export declare const BUNDLE: string;
export declare const ARTIFACT_TABLE: string;
export declare const ARTIFACT_NAME: string;
/** Fonctions servies par le bundle commun. */
export declare const FUNCTIONS: string[];
/** Chemin du chargeur déployé d'une fonction. */
export declare function loaderPath(name: string): string;
/** Bundle ES2022 minifié, ASCII, sans import ni export. */
export declare function bundleSaspay(root?: string): string;
export declare function artifact(root?: string): { source: string; sha256: string; chars: number };
/** Contenu exact du chargeur déployé en production (`<fonction>/loader.ts`). */
export declare function renderLoader(name: string, input: { sha256: string; chars: number }): string;
/** Tous les fichiers générés : bundle puis un chargeur par fonction. */
export declare function outputs(root?: string): {
  built: { source: string; sha256: string; chars: number };
  files: Array<[string, string]>;
};
