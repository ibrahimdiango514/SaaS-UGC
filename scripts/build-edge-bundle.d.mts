/** Déclaration du générateur de bundle Edge (source de vérité unique). */
export declare const ENTRY: string;
export declare const SHARED: string;
export declare const BUNDLE: string;
/** Artefact minifié réellement téléversé. */
export declare const EDGE: string;
/** Construit le contenu exact du bundle livré pour `reelora-video`. */
export declare function buildBundle(root?: string, options?: { minify?: boolean }): string;
/** Code déployé + son empreinte SHA-256 tronquée à 12 hex. */
export declare function buildEdgeArtifact(root?: string): { content: string; digest: string };
