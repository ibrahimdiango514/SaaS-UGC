/** Déclaration de la sonde de mise en service Meta (script exécutable en Node). */
export interface Sonde {
  label: string;
  ok: boolean;
  statut?: number;
  detail?: string;
}
export interface RapportSonde {
  rapport: Sonde[];
  reseauIndisponible: boolean;
}
export declare const PROJECT_REF: string;
export declare const BASE: string;
export declare const ORIGINES_ATTENDUES: string[];
export declare function requeteCallback(origine: string): { url: string; origine: string };
export declare function requeteStatusSansJwt(): { url: string; methode: string; corps: string };
export declare function requeteWebhookFauxJeton(): string;
export declare function sonder(options?: {
  fetchImpl?: typeof fetch;
  webhookToken?: string;
}): Promise<RapportSonde>;
