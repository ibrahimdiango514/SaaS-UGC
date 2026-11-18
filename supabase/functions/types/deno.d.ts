/**
 * Déclaration minimale des globales Deno utilisées par les Edge Functions.
 *
 * ## Pourquoi ce fichier existe
 *
 * `tsconfig.edge.json` vérifie les Edge Functions avec les types de Node, pas
 * ceux de Deno : sans cette déclaration, `Deno.serve` et `Deno.env.get`
 * produisent `TS2304: Cannot find name 'Deno'`. Le contrôle de types échouait
 * donc sur du code correct, ce qui pousse à ignorer ses erreurs — exactement
 * ce qu'il faut éviter.
 *
 * ## Portée volontairement étroite
 *
 * On ne déclare que ce que le dépôt utilise réellement. Une déclaration
 * permissive de `Deno` laisserait passer des appels inexistants à l'exécution ;
 * ici, tout le reste est une erreur de compilation.
 */
declare namespace Deno {
  /** Démarre le serveur HTTP de la fonction. */
  function serve(handler: (request: Request) => Response | Promise<Response>): void;

  namespace env {
    /** Lit une variable d'environnement, ou `undefined` si absente. */
    function get(name: string): string | undefined;
  }
}
