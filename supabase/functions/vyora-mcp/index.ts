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
import {
  cheminLogique,
  donnerConsentement,
  estRouteOAuth,
  preparerConsentement,
  repondreMetadonneesAutorisation,
  repondreMetadonneesRessource,
  traiterEnregistrement,
  traiterJeton,
  ENTETES_CORS_OAUTH,
  type DependancesOAuth,
  type ReponseOAuth,
  type SessionVYORA,
} from './oauth-routes.ts';
import {
  deriverJetonAntiRejeu,
  extraireJetonSession,
  lireCookies,
  rendrePageConsentement,
  rendrePageErreur,
  verifierAntiRejeu,
} from './consentement.ts';

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
  /*
   * Fonctions du serveur d'autorisation. Elles ne sont pas des outils : aucun
   * client MCP ne doit pouvoir les appeler par le transport JSON-RPC. Elles
   * figurent donc ici, hors de `RPC_AUTORISEES`, et n'ont aucune autre voie
   * d'accès que les routes OAuth ci-dessous.
   */
  'mcp_oauth_client_get',
  'mcp_oauth_register_client',
  'mcp_oauth_code_create',
  'mcp_oauth_code_consume',
  'mcp_oauth_issue_tokens',
  'mcp_oauth_refresh_rotate',
  'mcp_oauth_purge',
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

/**
 * URL publique de ce serveur MCP.
 *
 * Sert deux fois : comme `resource` des jetons (RFC 8707) et comme `issuer` du
 * document d'autorisation. Les deux doivent désigner LA MÊME valeur, sinon un
 * client conforme refusera nos jetons — un `resource` différent de l'émetteur
 * est traité comme un jeton volé.
 *
 * `VYORA_MCP_RESOURCE_URL` permet un domaine personnalisé ; à défaut on dérive
 * de `SUPABASE_URL`, qui est toujours présente côté Edge. Aucune valeur n'est
 * inventée : si rien n'est disponible, la variable est vide et les routes OAuth
 * refusent de servir un document bancal.
 */
const RESSOURCE = (
  env('VYORA_MCP_RESOURCE_URL').trim()
  || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/vyora-mcp` : '')
).replace(/\/+$/, '');

/**
 * Résout la session VYORA d'une requête navigateur.
 *
 * Le cookie de session est présenté tel quel à `/auth/v1/user` : c'est Supabase
 * qui vérifie la signature et l'expiration, on ne fait aucune confiance locale
 * au contenu du JWT. La seule chose qu'on lit nous-mêmes, c'est le rôle, pour
 * refuser qu'un jeton de service (ou `anon`) tienne lieu de session
 * utilisateur — sinon la page de consentement serait ouverte à quiconque
 * possède la clé publique du projet.
 */
async function resoudreSession(cookieHeader: string | null): Promise<SessionVYORA | null> {
  const jeton = extraireJetonSession(lireCookies(cookieHeader));
  if (!jeton) return null;

  const charge = decoderChargeJwt(jeton);
  if (charge?.role !== 'authenticated') return null;

  const reponse = await rest('/auth/v1/user', {
    method: 'GET',
    headers: { Authorization: `Bearer ${jeton}` },
  });
  if (!reponse.ok) return null;

  const utilisateur = (await reponse.json().catch(() => null)) as { id?: unknown } | null;
  const userId = typeof utilisateur?.id === 'string' ? utilisateur.id : '';
  if (!userId) return null;

  return { userId, csrfToken: deriverJetonAntiRejeu(jeton) };
}

/** Décode la charge utile d'un JWT SANS vérifier la signature (usage : rôle). */
function decoderChargeJwt(jeton: string): Record<string, unknown> | null {
  const morceaux = jeton.split('.');
  if (morceaux.length !== 3) return null;
  try {
    const base64 = morceaux[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Construit les dépendances réelles du serveur d'autorisation. */
function creerDependancesOAuth(): DependancesOAuth {
  return {
    ressource: RESSOURCE,
    emetteur: RESSOURCE,

    async chargerClient(clientId) {
      const client = (await rpcAuth('mcp_oauth_client_get', { p_client_id: clientId })) as
        | Record<string, unknown>
        | null;
      if (!client) return null;
      return {
        client_id: String(client.client_id),
        client_name: String(client.client_name ?? 'Client MCP'),
        is_public: client.is_public === true,
        client_secret_sha256: (client.client_secret_sha256 as string | null) ?? null,
        redirect_uris: Array.isArray(client.redirect_uris) ? (client.redirect_uris as string[]) : [],
        allowed_scopes: Array.isArray(client.allowed_scopes) ? (client.allowed_scopes as string[]) : [],
        token_endpoint_auth_method: String(client.token_endpoint_auth_method ?? 'none'),
      };
    },

    async enregistrerClient(entree) {
      return (await rpcAuth('mcp_oauth_register_client', {
        p_client_name: entree.client_name,
        p_redirect_uris: entree.redirect_uris,
        p_is_public: entree.is_public,
        p_allowed_scopes: entree.allowed_scopes,
      })) as Record<string, unknown>;
    },

    async creerCode(entree) {
      const code = await rpcAuth('mcp_oauth_code_create', {
        p_client_id: entree.client_id,
        p_user_id: entree.user_id,
        p_redirect_uri: entree.redirect_uri,
        p_scopes: entree.scopes,
        p_code_challenge: entree.code_challenge,
        p_resource: entree.resource,
      });
      return typeof code === 'string' ? code.replace(/^"|"$/g, '') : '';
    },

    async consommerCode(code) {
      const ligne = (await rpcAuth('mcp_oauth_code_consume', { p_code: code })) as
        | Record<string, unknown>
        | null;
      if (!ligne) return null;
      return {
        client_id: String(ligne.client_id),
        user_id: String(ligne.user_id),
        redirect_uri: String(ligne.redirect_uri),
        scopes: Array.isArray(ligne.scopes) ? (ligne.scopes as string[]) : [],
        code_challenge: String(ligne.code_challenge),
        resource: String(ligne.resource ?? ''),
      };
    },

    async emettreJetons(entree) {
      return (await rpcAuth('mcp_oauth_issue_tokens', {
        p_client_id: entree.client_id,
        p_user_id: entree.user_id,
        p_scopes: entree.scopes,
        p_resource: entree.resource,
        p_label: entree.label,
      })) as Record<string, unknown>;
    },

    async faireTournerRafraichissement(refreshToken) {
      const jetons = (await rpcAuth('mcp_oauth_refresh_rotate', { p_refresh: refreshToken })) as
        | Record<string, unknown>
        | null;
      return jetons ?? null;
    },

    /*
     * L'empreinte d'un secret client est calculée en base (`mcp_token_hash`,
     * pgcrypto) : dupliquer un SHA-256 en Edge créerait deux implémentations à
     * garder d'accord, et une divergence silencieuse refuserait tous les
     * clients confidentiels. On délègue donc au même code que la vérification.
     */
    async hacher(secret) {
      return await empreinte(secret);
    },
  };
}

/** Empreinte SHA-256 via la fonction SQL, seule source de vérité. */
async function empreinte(secret: string): Promise<string> {
  const reponse = await rest('/rest/v1/rpc/mcp_token_hash', { body: { p_secret: secret } });
  if (!reponse.ok) throw new Error('hash_failed');
  const texte = (await reponse.text()).trim().replace(/^"|"$/g, '');
  return texte;
}

/** Construit les dépendances réelles du serveur. */
export function creerDependances(): DependancesServeur {
  return {
    ecritureActive: ECRITURE_ACTIVE,
    ressourcePublicitaire: RESSOURCE,

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
  const depsOAuth = creerDependancesOAuth();

  /** Traduit une réponse OAuth en `Response` Deno. */
  function versResponseOAuth(r: ReponseOAuth): Response {
    if (r.body === null) {
      return new Response(null, { status: r.status, headers: r.headers });
    }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }

  /** Réponse HTML : jamais de redirection, jamais de ressource externe. */
  function pageHtml(html: string, status = 200): Response {
    return new Response(html, {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  /** Lit un corps `application/x-www-form-urlencoded` ou JSON en paires texte. */
  async function lireParametres(request: Request): Promise<Record<string, string>> {
    const type = (request.headers.get('content-type') ?? '').toLowerCase();
    const brut = await request.text();
    const resultat: Record<string, string> = {};
    if (type.includes('application/json')) {
      try {
        const objet = JSON.parse(brut) as Record<string, unknown>;
        for (const [cle, valeur] of Object.entries(objet ?? {})) {
          if (valeur !== null && valeur !== undefined) resultat[cle] = String(valeur);
        }
      } catch {
        /* corps illisible : tableau vide, l'appelant refusera */
      }
      return resultat;
    }
    for (const [cle, valeur] of new URLSearchParams(brut)) resultat[cle] = valeur;
    return resultat;
  }

  Deno.serve(async (request: Request) => {
    const url = new URL(request.url);
    const route = cheminLogique(url.pathname);

    /*
     * Aiguillage AVANT le transport MCP : une route OAuth ne doit jamais être
     * lue comme du JSON-RPC. Sans ce contrôle, un `POST` sur `/oauth/token`
     * serait interprété comme une requête MCP et renverrait « méthode
     * inconnue » — un client conforme conclurait que le serveur ne sait pas
     * faire d'OAuth et abandonnerait.
     */
    if (estRouteOAuth(url.pathname)) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: ENTETES_CORS_OAUTH });
      }

      if (route === '/.well-known/oauth-protected-resource' && request.method === 'GET') {
        return versResponseOAuth(repondreMetadonneesRessource(depsOAuth));
      }

      if (route === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
        return versResponseOAuth(repondreMetadonneesAutorisation(depsOAuth));
      }

      if (route === '/oauth/register') {
        if (request.method !== 'POST') {
          return versResponseOAuth({
            status: 405,
            body: { error: 'invalid_request', error_description: 'POST attendu.' },
            headers: { ...ENTETES_CORS_OAUTH, 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' },
          });
        }
        let corps: unknown = null;
        try {
          corps = JSON.parse(await request.text());
        } catch {
          corps = null;
        }
        return versResponseOAuth(await traiterEnregistrement(depsOAuth, corps));
      }

      if (route === '/oauth/authorize') {
        let session: SessionVYORA | null = null;
        try {
          session = await resoudreSession(request.headers.get('cookie'));
        } catch {
          // Base injoignable : on ne peut pas distinguer « pas de session » de
          // « session valide ». Répondre 401 serait un mensonge coûteux ; on
          // rend une page d'attente, sans jamais émettre de code.
          return pageHtml(rendrePageErreur('VYORA est momentanément indisponible. Réessayez dans un instant.'), 503);
        }

        if (request.method === 'GET') {
          const parametres: Record<string, string | null> = {};
          for (const [cle, valeur] of url.searchParams) parametres[cle] = valeur;

          const resultat = await preparerConsentement(depsOAuth, parametres, session);
          if (resultat.type === 'erreur') {
            const description = String(
              (resultat.reponse.body as { error_description?: string })?.error_description
              ?? 'Cette demande d’autorisation est invalide.',
            );
            return pageHtml(rendrePageErreur(description), resultat.reponse.status);
          }
          return pageHtml(rendrePageConsentement(resultat.vue));
        }

        if (request.method === 'POST') {
          const champs = await lireParametres(request);

          /*
           * Le jeton anti-rejeu est RECALCULÉ depuis la session, jamais lu
           * dans le formulaire : un attaquant qui poste ne peut pas fournir
           * les deux côtés de la comparaison.
           */
          const attendu = session?.csrfToken ?? null;
          if (!session) {
            return pageHtml(rendrePageErreur('Votre session VYORA a expiré. Reconnectez-vous puis recommencez.'), 401);
          }
          if (!verifierAntiRejeu(attendu, champs.csrf_token ?? null)) {
            return pageHtml(rendrePageErreur('Formulaire expiré ou invalide. Recommencez l’autorisation depuis votre client.'), 400);
          }

          // Refus explicite : on renvoie au client l'erreur prévue par la
          // spécification, pour qu'il cesse d'attendre au lieu de tourner.
          if (champs.decision === 'refuser') {
            const cible = new URL(champs.redirect_uri ?? '');
            const client = champs.client_id ? await depsOAuth.chargerClient(champs.client_id) : null;
            const autorisee = client?.redirect_uris.includes(cible.toString());
            if (client && autorisee) {
              cible.searchParams.set('error', 'access_denied');
              if (champs.state) cible.searchParams.set('state', champs.state);
              return new Response(null, {
                status: 302,
                headers: { ...ENTETES_CORS_OAUTH, Location: cible.toString() },
              });
            }
            return pageHtml(rendrePageErreur('Accès refusé. Vous pouvez fermer cette page.'), 400);
          }

          const resultat = await donnerConsentement(depsOAuth, champs, session);
          return versResponseOAuth(resultat);
        }

        return new Response(null, { status: 405, headers: { ...ENTETES_CORS_OAUTH, Allow: 'GET, POST' } });
      }

      if (route === '/oauth/token') {
        if (request.method !== 'POST') {
          return versResponseOAuth({
            status: 405,
            body: { error: 'invalid_request', error_description: 'POST attendu.' },
            headers: { ...ENTETES_CORS_OAUTH, 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' },
          });
        }
        return versResponseOAuth(await traiterJeton(depsOAuth, await lireParametres(request)));
      }

      return new Response(null, { status: 404, headers: ENTETES_CORS_OAUTH });
    }

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
