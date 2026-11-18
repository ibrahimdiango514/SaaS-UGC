/** Déclaration du constat de production (script exécutable en Node). */
export declare const DEFAULTS: { site: string; fn: string; repo: string };
/** Cachet `vyora-revision` présent dans le HTML servi, ou `null`. */
export declare function revisionFromHtml(html: string): string | null;
/** Verdict sur le code HTTP d'un appel anonyme à l'Edge Function. */
export declare function judgeFunctionStatus(code: number): { ok: boolean; verdict: string };
/** Verdict sur le cachet servi, comparé au commit de `main`. */
export declare function judgeRevision(
  served: string | null,
  expected: string,
): { ok: boolean; verdict: string };
