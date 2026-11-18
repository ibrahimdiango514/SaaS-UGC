/**
 * Point d'entrée déployé de l'Edge Function `mcp-client`.
 *
 * Elle exécute un outil d'un serveur MCP EXTERNE, après avoir tout revérifié
 * côté serveur. Le corps de la requête ne peut ni choisir son identité, ni
 * élargir une permission : `route.ts` ne lit que `serverId`, `outil`,
 * `arguments` et une confirmation booléenne, et `execution.ts` relit la base.
 *
 * ## Identité : GoTrue uniquement
 *
 * Aucun en-tête `x-user-id` n'est lu. Le JWT est présenté à `/auth/v1/user` et
 * l'identifiant retourné est le seul retenu. `verify_jwt` reste activé sur la
 * fonction (défaut de la plateforme) : un appel sans Jeton valide est arrêté
 * avant même d'arriver ici.
 *
 * ## Aucun secret ne sort
 *
 * - Le jeton du serveur distant est lu par `mcp_servers_secret` (security
 *   definer, réservée à `service_role`) au moment de l'appel, jamais avant.
 * - Ni la réponse, ni les journaux ne contiennent de secret : les logs ne
 *   portent que des identifiants, un nom d'outil et un code.
 * - Aucune clé Supabase n'est renvoyée au navigateur.
 *
 * ## Ce que cette fonction refuse de faire
 *
 * - Appeler un serveur dont l'URL n'est pas https ou qui résout vers une
 *   adresse privée : c'est `safePost` qui décide, et il n'est pas contourné.
 * - Réessayer une redirection : un `POST` redirigé est un refus.
 * - Autoriser une écriture : aucune autorisation d'écriture n'existe en base.
 */
import postgres from 'npm:postgres@3.4.5';
import { traiterRequete } from './http.ts';
import { creerAccesReel, type SqlTag } from './accueil.ts';
import type { EgressDeps } from '../store-import/safe-egress.ts';
import { PinnedFetchFailure } from '../store-import/pinned-fetch.ts';
import type { DependancesP5 } from './execution.ts';

/** Lecture d'environnement sans supposer la présence de `Deno`. */
const env = (name: string): string =>
  (globalThis as unknown as { Deno?: { env?: { get(k: string): string | undefined } } })
    .Deno?.env?.get(name) ?? '';

const SUPABASE_URL = env('SUPABASE_URL');
const ANON_KEY = env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');
const DATABASE_URL = env('MCP_CLIENT_DATABASE_URL') || env('SUPABASE_DB_URL');

/*
 * Origines SUPPLÉMENTAIRES uniquement : les valeurs par défaut du dépôt
 * (`src/lib/origin-allowlist.ts`) s'appliquent toujours. La version
 * précédente ne lisait que cette variable, absente du projet, et renvoyait
 * donc `access-control-allow-origin: null` à toutes les requêtes.
 */
const ORIGINES_SUPPLEMENTAIRES = env('VYORA_ALLOWED_ORIGINS');

/* -------------------------------------------------------------------------- */
/* Dépendances réseau réelles                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Runtime Deno lu sur `globalThis` : le fichier reste vérifiable par `tsc` sans
 * les types Deno, comme `store-connect` le fait déjà.
 */
interface RuntimeDeno {
  connect(options: { hostname: string; port: number }): Promise<unknown>;
  startTls(connection: unknown, options: { hostname: string }): Promise<unknown>;
  resolveDns?(name: string, type: 'A' | 'AAAA'): Promise<string[]>;
  serve(handler: (request: Request) => Promise<Response>): unknown;
}

const runtimeDeno = (globalThis as unknown as { Deno?: RuntimeDeno }).Deno;

/**
 * Sortie réseau : exactement le même contrat que celui déjà utilisé par les
 * connecteurs boutiques. Rien n'est affaibli ici — on ne fournit que les
 * primitives du runtime, la validation reste dans `safe-egress.ts`.
 */
function egressReel(): EgressDeps {
  return {
    async resolveHost(hostname: string): Promise<string[]> {
      if (!runtimeDeno?.resolveDns) {
        throw new Error('Résolution DNS indisponible dans cet environnement.');
      }
      // On interroge les deux familles : une adresse privée en IPv6 et une
      // adresse publique en IPv4 ne doivent pas passer pour une adresse saine.
      const [v4, v6] = await Promise.all([
        runtimeDeno.resolveDns(hostname, 'A').catch(() => [] as string[]),
        runtimeDeno.resolveDns(hostname, 'AAAA').catch(() => [] as string[]),
      ]);
      return [...v4, ...v6];
    },
    /*
     * Le port est TOUJOURS 443 : `safePost` n'accepte déjà que https, et
     * `parseStoreUrl` refuse un port explicite. On ne laisse donc pas un
     * appelant choisir la destination réelle de la connexion.
     *
     * Une erreur de connexion doit remonter comme `PinnedFetchFailure` :
     * `httpGetPinned` ne reconnaît que ce type et classe toute autre exception
     * en `protocol_error`, ce qui donnerait « réponse illisible » pour un
     * serveur simplement injoignable.
     */
    async connect(ip: string, hostname: string) {
      if (!runtimeDeno?.connect || !runtimeDeno?.startTls) {
        throw new PinnedFetchFailure(
          'connect_failed',
          'Connexion épinglée indisponible dans cet environnement.',
        );
      }
      let tcp: unknown;
      try {
        tcp = await runtimeDeno.connect({ hostname: ip, port: 443 });
      } catch {
        throw new PinnedFetchFailure('connect_failed', 'Connexion impossible vers l’adresse vérifiée.');
      }
      try {
        return await runtimeDeno.startTls(tcp, { hostname }) as never;
      } catch {
        throw new PinnedFetchFailure('tls_failed', 'La connexion sécurisée avec le serveur MCP a échoué.');
      }
    },
    timeoutMs: 20_000,
  };
}

/* -------------------------------------------------------------------------- */
/* Identité GoTrue                                                              */
/* -------------------------------------------------------------------------- */

async function identiteDepuisJwt(authorization: string): Promise<{ userId: string } | null> {
  const jwt = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  if (!jwt || !SUPABASE_URL) return null;

  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), 8_000);
  try {
    const reponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { authorization: `Bearer ${jwt}`, apikey: ANON_KEY },
      signal: controleur.signal,
    });
    if (!reponse.ok) return null;
    const donnees = await reponse.json() as { id?: unknown };
    const id = typeof donnees?.id === 'string' ? donnees.id : '';
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? { userId: id }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(minuteur);
  }
}

/* -------------------------------------------------------------------------- */
/* Base                                                                         */
/* -------------------------------------------------------------------------- */

function ouvrirSql(): SqlTag {
  if (!DATABASE_URL) {
    throw new Error('SUPABASE_DB_URL absent : la fonction ne peut pas joindre la base.');
  }
  // `max: 2` : la fonction fait peu de requêtes et les instances Edge sont
  // recyclées souvent. Éviter de saturer le pooler.
  return postgres(DATABASE_URL, { max: 2, prepare: false, idle_timeout: 20 }) as unknown as SqlTag;
}

function dependances(): DependancesP5 {
  return {
    base: creerAccesReel({ sql: ouvrirSql }),
    egress: egressReel(),
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                         */
/* -------------------------------------------------------------------------- */

/*
 * Toute la logique HTTP vit dans `http.ts`, qui est testé. Ce fichier ne garde
 * que le branchement réel : c'est le seul endroit qui dépend du runtime Deno et
 * de `npm:postgres`, donc le seul qui ne peut pas être exercé par Vitest.
 */
const depsSingleton = () => dependances();

if (runtimeDeno?.serve) {
  runtimeDeno.serve((request: Request) =>
    traiterRequete(request, depsSingleton, {
      originesSupplementaires: ORIGINES_SUPPLEMENTAIRES,
      identite: identiteDepuisJwt,
    }),
  );
}
