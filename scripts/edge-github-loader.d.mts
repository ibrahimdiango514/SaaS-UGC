/** Déclaration du générateur partagé de chargeur Edge « GitHub épinglé ». */
export declare const GITHUB_REPO: string;
/** Commit épinglé à 40 hexadécimaux (refuse toute branche mouvante). */
export declare function validerCommit(commit: string): string;
/** Empreinte SHA-256 à 64 hexadécimaux. */
export declare function validerEmpreinte(sha256: string): string;
/** Contenu exact du chargeur pour une fonction donnée. */
export declare function renderGithubLoader(options: {
  fonction: string;
  path: string;
  sha256: string;
  chars: number;
  commit: string;
  repo?: string;
  chargeur?: string;
  codeIndisponible?: string;
}): string;
export declare const MARQUEURS_INTERDITS: Array<{ motif: RegExp; raison: string }>;
/** Liste des non-conformités ; vide signifie conforme. */
export declare function verifierChargeur(texte: string): string[];
