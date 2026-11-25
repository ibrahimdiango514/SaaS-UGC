/**
 * SORAHNEX — routes HTTP du serveur d'autorisation OAuth 2.1.
 *
 * Ce module traduit des requêtes HTTP en appels aux fonctions de `oauth.ts`
 * (validation) et aux dépendances injectées (base de données). Il ne contient
 * aucune règle de sécurité nouvelle : toute décision vient de `oauth.ts`, ici
 * on ne fait que brancher.
 *
 * ## Où vivent ces routes
 *
 * Sur la **même fonction Edge** que le serveur MCP, sous des chemins distincts :
 *
 *   GET  /.well-known/oauth-protected-resource   → RFC 9728
 *   GET  /.well-known/oauth-authorization-server → RFC 8414
 *   POST /oauth/register                         → RFC 7591
 *   GET  /oauth/authorize                        → page de consentement SORAHNEX
 *   POST /oauth/authorize                        → consentement donné
 *   POST /oauth/token                            → code ou rafraîchissement
 *
 * Un client MCP découvre ces adresses par le défi `WWW-Authenticate`, jamais
 * par convention : c'est la spécification qui l'exige, et cela permet de
 * déplacer les endpoints sans casser les clients déjà configurés.
 *
 * ## Le consentement n'est pas implicite
 *
 * `/oauth/authorize` avec une session SORAHNEX valide n'émet PAS de code : elle
 * rend une page qui énonce les portées demandées et le nom du client. Le code
 * n'est émis qu'après un `POST` explicite avec un jeton anti-rejeu. Un lien
 * forgé ne peut donc pas connecter un client IA au compte d'un utilisateur qui
 * clique dessus par réflexe.
 */
import {
  DUREE_ACCES_SECONDES,
  corpsErreur,
  echangerCode,
  metadonneesAutorisation,
  metadonneesRessource,
  validerAutorisation,
  validerEnregistrement,
  type ErreurOAuth,
} from './oauth.ts';

export const ENTETES_CORS_OAUTH: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};

/** Résultat normalisé d'une route OAuth. */
export interface ReponseOAuth {
  status: number;
  /** `null` pour une réponse vide (204). */
  body: unknown;
  headers: Record<string, string>;
  /** Renseigné quand la réponse est une redirection à suivre par le client. */
  redirectTo?: string;
}

/** Utilisateur authentifié sur la page de consentement (session SORAHNEX). */
export interface SessionSORAHNEX {
  userId: string;
  /** Jeton anti-rejeu lié au formulaire de consentement. */
  csrfToken: string;
}

/** Dépendances injectées : toutes les entrées/sorties passent par là. */
export interface DependancesOAuth {
  /** URL canonique de ce serveur MCP (ressource). */
  ressource: string;
  /** URL de ce serveur d'autorisation (émetteur). */
  emetteur: string;
  /** Lit un client enregistré, ou `null`. */
  chargerClient(clientId: string): Promise<{
    client_id: string;
    client_name: string;
    is_public: boolean;
    client_secret_sha256: string | null;
    redirect_uris: string[];
    allowed_scopes: string[];
    token_endpoint_auth_method: string;
  } | null>;
  enregistrerClient(entree: {
    client_name: string;
    redirect_uris: string[];
    is_public: boolean;
    allowed_scopes: string[];
  }): Promise<Record<string, unknown>>;
  creerCode(entree: {
    client_id: string;
    user_id: string;
    redirect_uri: string;
    scopes: string[];
    code_challenge: string;
    resource: string;
  }): Promise<string>;
  consommerCode(code: string): Promise<{
    client_id: string;
    user_id: string;
    redirect_uri: string;
    scopes: string[];
    code_challenge: string;
    resource: string;
  } | null>;
  emettreJetons(entree: {
    client_id: string;
    user_id: string;
    scopes: string[];
    resource: string;
    label: string;
  }): Promise<Record<string, unknown>>;
  faireTournerRafraichissement(refreshToken: string): Promise<Record<string, unknown> | null>;
  /** Empreinte SHA-256 d'un secret, pour comparer un client confidentiel. */
  hacher(secret: string): Promise<string>;
  purger?: () => Promise<void>;
}

function erreurOAuth(e: ErreurOAuth, entetes: Record<string, string> = {}): ReponseOAuth {
  return {
    status: e.status,
    body: corpsErreur(e.error, e.error_description),
    headers: { ...ENTETES_CORS_OAUTH, 'Content-Type': 'application/json; charset=utf-8', ...entetes },
  };
}

function json(body: unknown, status = 200, entetes: Record<string, string> = {}): ReponseOAuth {
  return {
    status,
    body,
    headers: { ...ENTETES_CORS_OAUTH, 'Content-Type': 'application/json; charset=utf-8', ...entetes },
  };
}

/**
 * Extrait le chemin logique de la requête.
 *
 * L'URL d'une Edge Function contient le préfixe `/functions/v1/<slug>`. On ne
 * veut pas en dépendre : les routes sont donc reconnues par leur suffixe, ce
 * qui permet de les servir aussi bien via l'URL publique que via un domaine
 * personnalisé un jour.
 */
export function cheminLogique(cheminBrut: string): string {
  const chemin = (cheminBrut || '/').replace(/\/+$/, '') || '/';
  const suffixes = [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/oauth/register',
    '/oauth/authorize',
    '/oauth/token',
  ];
  for (const suffixe of suffixes) {
    if (chemin.endsWith(suffixe)) return suffixe;
  }
  return '/';
}

/** Une route OAuth est-elle concernée par ce chemin ? */
export function estRouteOAuth(cheminBrut: string): boolean {
  return cheminLogique(cheminBrut) !== '/';
}

/* -------------------------------------------------------------------------- */
/* 1. Métadonnées                                                              */
/* -------------------------------------------------------------------------- */

export function repondreMetadonneesRessource(deps: DependancesOAuth): ReponseOAuth {
  return json(metadonneesRessource(deps.ressource, deps.emetteur));
}

export function repondreMetadonneesAutorisation(deps: DependancesOAuth): ReponseOAuth {
  return json(metadonneesAutorisation(deps.emetteur));
}

/* -------------------------------------------------------------------------- */
/* 2. Enregistrement de client (RFC 7591)                                      */
/* -------------------------------------------------------------------------- */

export async function traiterEnregistrement(
  deps: DependancesOAuth,
  corps: unknown,
): Promise<ReponseOAuth> {
  if (typeof corps !== 'object' || corps === null || Array.isArray(corps)) {
    return erreurOAuth({
      error: 'invalid_client_metadata',
      error_description: 'Le corps doit être un objet JSON.',
      status: 400,
    });
  }
  const validation = validerEnregistrement(corps as Record<string, unknown>);
  if (validation.ok === false) return erreurOAuth(validation.error);

  try {
    const resultat = await deps.enregistrerClient(validation.value);
    // 201 : création. Le secret éventuel n'apparaît QUE dans cette réponse.
    return json(resultat, 201);
  } catch {
    return erreurOAuth({
      error: 'invalid_client_metadata',
      error_description: 'L’enregistrement du client a échoué.',
      status: 400,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Page de consentement                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Requête d'autorisation : valide tout et prépare la page de consentement.
 *
 * Aucun code n'est émis ici. La réponse `consentement` contient ce que
 * l'interface doit afficher ; c'est l'appelant (index.ts) qui rend le HTML.
 */
export async function preparerConsentement(
  deps: DependancesOAuth,
  parametres: Record<string, string | null>,
  session: SessionSORAHNEX | null,
): Promise<
  | { type: 'erreur'; reponse: ReponseOAuth }
  | {
    type: 'consentement';
    reponse: ReponseOAuth;
    vue: {
      clientName: string;
      scopes: string[];
      redirectHost: string;
      csrfToken: string;
      /** Paramètres à rejouer dans le formulaire, déjà validés. */
      champs: Record<string, string>;
    };
  }
> {
  const clientId = parametres.client_id ?? '';
  const client = clientId ? await deps.chargerClient(clientId) : null;

  const validation = validerAutorisation(
    {
      response_type: parametres.response_type,
      client_id: parametres.client_id,
      redirect_uri: parametres.redirect_uri,
      scope: parametres.scope,
      state: parametres.state,
      code_challenge: parametres.code_challenge,
      code_challenge_method: parametres.code_challenge_method,
      resource: parametres.resource,
    },
    client ? { client_id: client.client_id, redirect_uris: client.redirect_uris, allowed_scopes: client.allowed_scopes } : null,
    deps.ressource,
  );

  if (validation.ok === false) {
    // Erreur affichée, JAMAIS redirigée : on ne renvoie pas un utilisateur vers
    // une adresse que l'on vient précisément de juger non fiable.
    return { type: 'erreur', reponse: erreurOAuth(validation.error) };
  }

  // Sans session SORAHNEX, on ne peut pas savoir POUR QUI émettre le code : on
  // renvoie 401 en laissant le client redemander après authentification.
  if (!session) {
    return {
      type: 'erreur',
      reponse: {
        status: 401,
        body: corpsErreur('login_required', 'Connectez-vous à SORAHNEX avant d’autoriser un client MCP.'),
        headers: { ...ENTETES_CORS_OAUTH, 'Content-Type': 'application/json; charset=utf-8' },
      },
    };
  }

  const v = validation.value;
  return {
    type: 'consentement',
    reponse: json({ status: 'consent_required' }),
    vue: {
      clientName: client?.client_name ?? 'Client MCP',
      scopes: v.scopes,
      redirectHost: safeHost(v.redirect_uri),
      csrfToken: session.csrfToken,
      champs: {
        client_id: v.client_id,
        redirect_uri: v.redirect_uri,
        scope: v.scopes.join(' '),
        state: v.state ?? '',
        code_challenge: v.code_challenge,
        code_challenge_method: 'S256',
        resource: v.resource,
        response_type: 'code',
      },
    },
  };
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).hostname;
  } catch {
    return '(adresse illisible)';
  }
}

/**
 * Consentement donné : émet le code et renvoie l'URL de redirection.
 *
 * Le `state` est rejoué tel quel : c'est au client de le vérifier, mais s'il
 * est absent de notre réponse, tous les clients conformes refuseront le retour.
 */
export async function donnerConsentement(
  deps: DependancesOAuth,
  parametres: Record<string, string | null>,
  session: SessionSORAHNEX | null,
): Promise<ReponseOAuth> {
  const clientId = parametres.client_id ?? '';
  const client = clientId ? await deps.chargerClient(clientId) : null;

  const validation = validerAutorisation(
    {
      response_type: parametres.response_type,
      client_id: parametres.client_id,
      redirect_uri: parametres.redirect_uri,
      scope: parametres.scope,
      state: parametres.state,
      code_challenge: parametres.code_challenge,
      code_challenge_method: parametres.code_challenge_method,
      resource: parametres.resource,
    },
    client ? { client_id: client.client_id, redirect_uris: client.redirect_uris, allowed_scopes: client.allowed_scopes } : null,
    deps.ressource,
  );
  if (validation.ok === false) return erreurOAuth(validation.error);
  if (!session) {
    return {
      status: 401,
      body: corpsErreur('login_required', 'Session SORAHNEX absente.'),
      headers: { ...ENTETES_CORS_OAUTH, 'Content-Type': 'application/json; charset=utf-8' },
    };
  }

  const v = validation.value;
  const code = await deps.creerCode({
    client_id: v.client_id,
    user_id: session.userId,
    redirect_uri: v.redirect_uri,
    scopes: v.scopes,
    code_challenge: v.code_challenge,
    resource: v.resource,
  });

  const url = new URL(v.redirect_uri);
  url.searchParams.set('code', code);
  if (v.state) url.searchParams.set('state', v.state);

  return {
    status: 302,
    body: null,
    redirectTo: url.toString(),
    headers: { ...ENTETES_CORS_OAUTH, Location: url.toString() },
  };
}

/* -------------------------------------------------------------------------- */
/* 4. Point d'entrée des jetons                                                */
/* -------------------------------------------------------------------------- */

/**
 * `POST /oauth/token` : deux subventions, et rien d'autre.
 *
 * Le corps est lu en `application/x-www-form-urlencoded` (ce que font tous les
 * clients OAuth) ou en JSON. Aucun jeton n'est accepté dans l'URL : la
 * spécification MCP l'interdit explicitement, et un jeton en query string finit
 * dans les journaux d'accès.
 */
export async function traiterJeton(
  deps: DependancesOAuth,
  corps: Record<string, string>,
): Promise<ReponseOAuth> {
  if (deps.purger) {
    try {
      await deps.purger();
    } catch {
      /* le nettoyage est un bonus, jamais un prérequis */
    }
  }

  /*
   * Le `grant_type` est contrôlé AVANT toute lecture de client.
   *
   * Sinon, une subvention non supportée (`password`, `client_credentials`)
   * sans `client_id` recevait « client inconnu » (401) au lieu de
   * « unsupported_grant_type » (400) : le client croyait à un problème
   * d'identification et retentait indéfiniment avec de bons identifiants.
   */
  const subvention = corps.grant_type ?? '';
  if (subvention !== 'authorization_code' && subvention !== 'refresh_token') {
    return erreurOAuth({
      error: 'unsupported_grant_type',
      error_description: `Subvention non supportée : « ${subvention.slice(0, 40) || '(absente)'} ». ` +
        'Seules « authorization_code » et « refresh_token » sont acceptées.',
      status: 400,
    });
  }

  if (subvention === 'refresh_token') {
    return traiterRafraichissement(deps, corps);
  }

  return traiterEchangeCode(deps, corps);
}

async function verifierSecretClient(
  deps: DependancesOAuth,
  corps: Record<string, string>,
  client: { is_public: boolean; client_secret_sha256: string | null } | null,
): Promise<boolean> {
  // Client public : PKCE est la seule preuve d'identité, aucun secret attendu.
  if (!client || client.is_public) return true;
  const secret = corps.client_secret ?? '';
  if (!secret) return false;
  const empreinte = await deps.hacher(secret);
  return empreinte === client.client_secret_sha256;
}

async function traiterEchangeCode(
  deps: DependancesOAuth,
  corps: Record<string, string>,
): Promise<ReponseOAuth> {
  const clientId = corps.client_id ?? '';
  const client = clientId ? await deps.chargerClient(clientId) : null;
  if (!client) {
    return erreurOAuth({ error: 'invalid_client', error_description: 'Client inconnu ou révoqué.', status: 401 });
  }
  if (!(await verifierSecretClient(deps, corps, client))) {
    return erreurOAuth({ error: 'invalid_client', error_description: 'Secret client invalide.', status: 401 });
  }

  const code = corps.code ?? '';
  // La consommation est atomique en base : un code déjà utilisé renvoie null.
  const stocke = code ? await deps.consommerCode(code) : null;

  const echange = await echangerCode(
    {
      grant_type: corps.grant_type,
      client_id: corps.client_id,
      redirect_uri: corps.redirect_uri,
      code: corps.code,
      code_verifier: corps.code_verifier,
      resource: corps.resource,
    },
    stocke,
    deps.ressource,
  );
  if (echange.ok === false) return erreurOAuth(echange.error);

  const jetons = await deps.emettreJetons({
    client_id: echange.value.client_id,
    user_id: echange.value.user_id,
    scopes: echange.value.scopes,
    resource: echange.value.resource,
    label: client.client_name,
  });

  return json(
    {
      access_token: jetons.access_token,
      token_type: 'Bearer',
      expires_in: DUREE_ACCES_SECONDES,
      scope: jetons.scope,
      refresh_token: jetons.refresh_token,
    },
    200,
    { Pragma: 'no-cache' },
  );
}

async function traiterRafraichissement(
  deps: DependancesOAuth,
  corps: Record<string, string>,
): Promise<ReponseOAuth> {
  const refresh = corps.refresh_token ?? '';
  if (!refresh) {
    return erreurOAuth({ error: 'invalid_request', error_description: '« refresh_token » requis.', status: 400 });
  }
  const clientId = corps.client_id ?? '';
  const client = clientId ? await deps.chargerClient(clientId) : null;
  if (clientId && !client) {
    return erreurOAuth({ error: 'invalid_client', error_description: 'Client inconnu ou révoqué.', status: 401 });
  }
  if (!(await verifierSecretClient(deps, corps, client))) {
    return erreurOAuth({ error: 'invalid_client', error_description: 'Secret client invalide.', status: 401 });
  }

  const jetons = await deps.faireTournerRafraichissement(refresh);
  if (!jetons) {
    // Un rafraîchissement mort n'est pas une panne : le client doit refaire le
    // flux complet, ce que `invalid_grant` lui indique.
    return erreurOAuth({
      error: 'invalid_grant',
      error_description: 'Jeton de rafraîchissement invalide, déjà utilisé, révoqué ou expiré.',
      status: 400,
    });
  }

  return json(
    {
      access_token: jetons.access_token,
      token_type: 'Bearer',
      expires_in: jetons.expires_in ?? DUREE_ACCES_SECONDES,
      scope: jetons.scope,
      refresh_token: jetons.refresh_token,
    },
    200,
    { Pragma: 'no-cache' },
  );
}
