/**
 * VYORA — serveur MCP officiel : point d'entrée Edge.
 *
 * Ce fichier ne contient AUCUNE logique de protocole : elle vit dans
 * `core.ts` (catalogue et JSON-RPC) et `handler.ts` (transport et
 * authentification), tous deux testables sans Deno. Ici, on branche :
 *
 *   - la clé de service, qui ne sort JAMAIS de cette fonction ;
 *   - les appels PostgreSQL (REST) pour résoudre les jetons et exécuter les
 *     outils ;
 *   - `Deno.serve`, qui traduit une `Response` en réponse HTTP.
 *
 * ## Pourquoi la clé de service reste ici
 *
 * Un client MCP externe ne doit jamais détenir de clé Supabase. Il présente un
 * jeton opaque `vyora_mcp_…` ; ce jeton est haché et comparé à `mcp_tokens`
 * par le serveur, qui agit ensuite pour le compte de l'utilisateur résolu.
 * Aucune réponse, aucun en-tête et aucune erreur ne contient la clé.
 *
 * ## Allowlist de RPC
 *
 * `RPC_AUTORISEES` (dans `core.ts`) est la seule barrière entre le nom d'outil
 * demandé et la base. Avec la clé de service, tout nom non listé serait une
 * escalade de privilèges : `appelerRpc` refuse donc tout nom absent.
 */
import { RPC_AUTORISEES, type ContexteJeton, type JournalEntree } from './core.ts';
import { traiterRequete, SERVER_INFO, type DependancesServeur, type ReponseHttp } from './handler.ts';

function env(nom: string): string {
  const g = globalThis as unknown as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(nom) ?? g.process?.env?.[nom] ?? '';
}

const SUPABASE_URL = env('SUPABASE_URL').replace(/\/+$/, '');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
/**
 * L'écriture est un interrupteur de DÉPLOIEMENT, en plus de la portée du jeton
 * et de la permission par outil. Fermé par défaut : un oubli de configuration
 * ne peut pas ouvrir l'écriture.
 */
const ECRITURE_ACTIVE = env('VYORA_MCP_WRITE_ENABLED').trim().toLowerCase() === 'true';

interface Ligne {
  [cle: string]: unknown;
}

/**
 * Appel REST à Supabase, en service_role.
 *
 * Le délai est borné : une requête MCP bloquée doit échouer vite et rendre la
 * main au client, pas consommer une instance jusqu'au timeout de la plateforme.
 */
async function rest(chemin: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const reponse = await fetch(`${SUPABASE_URL}${chemin}`, {
    method: init.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(12_000),
  });
  return reponse;
}

/**
 * RPC d'AUTHENTIFICATION, hors liste blanche d'outils.
 *
 * `mcp_resolve_token`, `mcp_touch_token` et `mcp_log_activity` ne sont pas des
 * outils : aucun client ne doit pouvoir les appeler. Elles ne peuvent pas non
 * plus passer par `rpc()`, qui refuse tout nom absent de `RPC_AUTORISEES` —
 * c'est précisément ce que fait `resoudreJeton`, et l'y faire passer rendrait
 * l'authentification impossible.
 *
 * Cette fonction est donc réservée à ces trois appels, avec une liste
 * explicite : elle ne peut pas servir de porte dérobée pour exécuter un outil
 * hors liste blanche.
 */
const RPC_AUTH: ReadonlySet<string> = new Set([
  'mcp_resolve_token',
  'mcp_touch_token',
  'mcp_log_activity',
]);

async function rpcAuth(nom: string, args: Record<string, unknown>): Promise<unknown> {
  if (!RPC_AUTH.has(nom)) throw new Error(`rpc_auth_not_allowed: ${nom}`);
  const reponse = await rest(`/rest/v1/rpc/${nom}`, { body: args });
  if (!reponse.ok) throw new Error(`rpc_auth_failed: ${nom}: ${reponse.status}`);
  const texte = await reponse.text();
  return texte ? JSON.parse(texte) : null;
}

/** Exécute une RPC d'OUTIL, après vérification de la liste blanche. */
async function rpc(nom: string, args: Record<string, unknown>): Promise<unknown> {
  if (!RPC_AUTORISEES.has(nom)) {
    // Deuxième barrière, redondante avec celle de `core.ts` : si le catalogue
    // était un jour étendu par erreur, cette ligne empêche l'appel.
    throw new Error(`rpc_not_allowed: ${nom}`);
  }
  const reponse = await rest(`/rest/v1/rpc/${nom}`, { body: args });
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => '');
    /*
     * Le message PostgreSQL est transmis tel quel : il est rédigé par NOS
     * fonctions ('workspace access denied', 'user_required'). Il ne contient
     * ni secret ni donnée d'un autre utilisateur. Le tronquer à 300 caractères
     * évite de renvoyer une trace complète à un client externe.
     */
    throw new Error(detail.slice(0, 300) || `rpc_failed: ${nom}: ${reponse.status}`);
  }
  const texte = await reponse.text();
  return texte ? JSON.parse(texte) : null;
}

/** Construit les dépendances réelles du serveur. */
export function creerDependances(): DependancesServeur {
  return {
    ecritureActive: ECRITURE_ACTIVE,

    async resoudreJeton(secret: string): Promise<ContexteJeton | null> {
      const lignes = (await rpcAuth('mcp_resolve_token', { p_secret: secret })) as Ligne[] | null;
      const ligne = Array.isArray(lignes) ? lignes[0] : null;
      if (!ligne?.user_id || !ligne?.token_id) return null;
      const scopes = Array.isArray(ligne.scopes) ? (ligne.scopes as string[]) : [];
      return {
        userId: String(ligne.user_id),
        tokenId: String(ligne.token_id),
        connectionId: ligne.connection_id ? String(ligne.connection_id) : null,
        scopes,
        tokenPrefix: typeof ligne.token_prefix === 'string' ? ligne.token_prefix : '',
      };
    },

    async toucherJeton(tokenId: string) {
      await rpcAuth('mcp_touch_token', { p_token_id: tokenId });
    },

    appelerRpc: rpc,

    async outilAutorise(contexte, nomOutil) {
      /*
       * Permission par outil : absente de `mcp_tool_permissions` ⇒ autorisée.
       * Ce choix permet à un nouveau jeton de fonctionner immédiatement, tout
       * en laissant l'utilisateur restreindre ensuite. La portée, elle, reste
       * obligatoire et n'est jamais contournable par cette table.
       */
      const reponse = await rest(
        `/rest/v1/mcp_tool_permissions?select=allowed&token_id=eq.${encodeURIComponent(contexte.tokenId)}`
        + `&tool_name=eq.${encodeURIComponent(nomOutil)}&limit=1`,
        { method: 'GET' },
      );
      if (!reponse.ok) return false;
      const lignes = (await reponse.json()) as Array<{ allowed?: boolean }>;
      if (lignes.length === 0) return true;
      return lignes[0].allowed === true;
    },

    async journaliser(entree: JournalEntree) {
      /*
       * Le journal ne doit jamais faire échouer une requête : toute erreur est
       * avalée ici, et `core.ts` protège de son côté l'appel.
       */
      try {
        await rpcAuth('mcp_log_activity', {
          p_payload: {
            user_id: entree.userId,
            token_id: entree.tokenId,
            connection_id: entree.connectionId,
            token_prefix: entree.tokenPrefix,
            method: entree.method,
            tool_name: entree.toolName ?? null,
            outcome: entree.outcome,
            error_code: entree.errorCode ?? null,
            duration_ms: entree.durationMs ?? null,
            result_size: entree.resultSize ?? null,
          },
        });
      } catch {
        /* ignoré : le journal est un observateur */
      }
    },
  };
}

/** Réponse de panne de configuration, avant même de servir quoi que ce soit. */
function indisponible(message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message } }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Retry-After': '30',
      },
    },
  );
}

function versResponse(r: ReponseHttp): Response {
  if (r.body === null) return new Response(null, { status: r.status, headers: r.headers });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
}

if (!SUPABASE_URL || !SERVICE_KEY) {
  // Panne explicite et lisible : jamais un accès ouvert, jamais un 500 opaque.
  console.error('vyora-mcp : SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant');
  Deno.serve(() => indisponible('Serveur MCP indisponible : configuration serveur incomplète.'));
} else {
  const deps = creerDependances();

  Deno.serve(async (request: Request) => {
    let corps: unknown;
    let corpsIllisible = false;

    if (request.method === 'POST') {
      const texte = await request.text();
      if (texte.trim() === '') {
        corpsIllisible = true;
      } else {
        try {
          corps = JSON.parse(texte);
        } catch {
          corpsIllisible = true;
        }
      }
    }

    const resultat = await traiterRequete(deps, {
      method: request.method,
      authorization: request.headers.get('authorization'),
      body: corps,
      corpsIllisible,
      protocoleDemande: request.headers.get('mcp-protocol-version'),
    });

    return versResponse(resultat);
  });
}

// Exporté pour la vérification de types et les tests d'intégration.
export { SERVER_INFO };
