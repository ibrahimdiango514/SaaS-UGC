/** Déclaration du générateur d'artefact Edge `business-grow`. */
export declare const ENTRY: string;
/** Chargeur réellement déployé (GitHub épinglé). */
export declare const LOADER: string;
/** Alias de `LOADER` : un seul fichier est déployé. */
export declare const HOSTED_LOADER: string;
/** Bundle exact, épinglé par empreinte dans le chargeur. */
export declare const BUNDLE: string;
/** Alias de `LOADER` : le chargeur historique séparé a été retiré. */
export declare const GITHUB_LOADER: string;
/** Dépôt public dont le bundle est téléchargé. */
export declare const GITHUB_REPO: string;
/** Table d'artefacts héritée (plus utilisée par le chargeur déployé). */
export declare const ARTIFACT_TABLE: string;
export declare const ARTIFACT_NAME: string;
/** Bundle ES2022 minifié, sans import relatif, exécutable par `new Function`. */
export declare function bundleBusinessGrow(root?: string): string;
/** Bundle + empreinte : l'artefact tel qu'il est épinglé. */
export declare function artifact(root?: string): {
  source: string;
  sha256: string;
  chars: number;
};
/** Contenu exact du chargeur déployé, pour un commit épinglé (40 hexadécimaux). */
export declare function renderGithubLoader(input: {
  sha256: string;
  chars: number;
}, commit: string): string;
