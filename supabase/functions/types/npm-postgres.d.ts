/**
 * Déclaration du module Deno `npm:postgres@3.4.5`.
 *
 * ## Pourquoi ce fichier existe
 * `tsconfig.json` ne couvrait que `src/` et `tests/` : les Edge Functions
 * n'étaient vérifiées par AUCUN `tsc`. C'est ainsi que `index.ts` a pu utiliser
 * `importFile` sans l'importer — le défaut ne cassait qu'à l'exécution, en
 * production, par un 500 opaque. `tsconfig.edge.json` les couvre désormais.
 *
 * TypeScript ne sait pas résoudre les spécificateurs `npm:` (propres à Deno) :
 * sans cette déclaration, chaque vérification échouait sur « Cannot find
 * module » et masquait les erreurs réelles.
 *
 * ## Pourquoi une signature permissive
 * `postgres` s'appelle de deux façons dans ce code :
 *   - en gabarit : `` sql`select …` `` (le gabarit est le premier argument) ;
 *   - en constructeur d'insertion : `` sql('table', valeur) ``.
 *
 * Déclarer deux signatures d'appel ne fonctionne pas : TypeScript applique la
 * dernière et reprochait au gabarit d'être un `TemplateStringsArray`. On
 * déclare donc un seul appel, volontairement large. C'est un chien de garde
 * contre les oublis, pas une réimplémentation des types de la bibliothèque :
 * les formes précises sont couvertes par les tests qui exécutent le code.
 */
declare module 'npm:postgres@3.4.5' {
  /**
   * Un seul appel, générique, dont le premier paramètre accepte le gabarit
   * ET la forme `sql(table, valeur)`. `unknown` plutôt qu'une union : TypeScript
   * refuse un littéral d'objet face à `TemplateStringsArray`, alors que
   * `postgres` l'accepte à l'exécution (il construit la clause lui-même).
   */
  type Query = <T = unknown>(first: unknown, ...rest: unknown[]) => Promise<T>;

  interface Extras {
    end(options?: { timeout?: number }): Promise<void>;
    unsafe<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T[]>;
  }

  type Sql = Query & Extras;

  interface Options {
    max?: number;
    idle_timeout?: number;
    connect_timeout?: number;
    ssl?: 'require' | 'prefer' | boolean;
    prepare?: boolean;
    connection?: { application_name?: string };
  }

  export default function postgres(url: string, options?: Options): Sql;
}
