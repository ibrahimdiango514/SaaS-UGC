/** Déclaration du générateur d'artefact Edge `business-grow`. */
export declare const ENTRY: string;
/** Variante autonome (bundle inline gzip+base64). */
export declare const LOADER: string;
/** Chargeur réellement déployé : lit le bundle en base. */
export declare const HOSTED_LOADER: string;
/** Bundle exact, publié dans `public._edge_function_artifact`. */
export declare const BUNDLE: string;
export declare const ARTIFACT_TABLE: string;
export declare const ARTIFACT_NAME: string;
/** Bundle ES2022 minifié, sans import relatif. */
export declare function bundleBusinessGrow(root?: string): string;
/** gzip reproductible (MTIME forcé à 0). */
export declare function deterministicGzip(input: string | Buffer): Buffer;
/** Artefact déployable : bundle, chargeur base64 et empreinte. */
export declare function artifact(root?: string): {
  source: string;
  payload: string;
  sha256: string;
  chars: number;
  gzBytes: number;
};
/** Contenu exact de la variante autonome (`bootstrap.ts`). */
export declare function renderLoader(input: {
  payload: string;
  sha256: string;
  chars: number;
}): string;
/** Contenu exact du chargeur déployé en production (`loader.ts`). */
export declare function renderHostedLoader(input: {
  sha256: string;
  chars: number;
}): string;
