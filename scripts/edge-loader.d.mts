/** Déclaration du chargeur d'artefact Edge. */
export declare function parseExports(source: string): Array<{ local: string; exported: string }>;
export declare function prepareArtifact(source: string): { code: string; exports: string[] };
export declare function loadArtifact(source: string): {
  handler: (request: Request) => Promise<Response>;
  calculateVideoCredits?: (cost: number, config: Record<string, number | null>) => number | null;
  [key: string]: unknown;
};
