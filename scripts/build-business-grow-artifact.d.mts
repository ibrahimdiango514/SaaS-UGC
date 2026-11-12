/** Déclaration du générateur d'artefact Edge `business-grow`. */
export declare const ENTRY: string;
export declare const LOADER: string;
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
/** Contenu exact du chargeur déployé (`bootstrap.ts`). */
export declare function renderLoader(input: {
  payload: string;
  sha256: string;
  chars: number;
}): string;
