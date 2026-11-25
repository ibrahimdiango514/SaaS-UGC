/**
 * SORAHNEX — OAuth 2.1 SORTANT pour les serveurs MCP externes.
 *
 * ## Ce que ce module fait
 *
 * Le parcours complet, conforme à ce que la spécification MCP attend d'un
 * client : découverte des métadonnées (RFC 9728 puis RFC 8414), enregistrement
 * dynamique du client (RFC 7591) quand il est proposé, `Authorization Code`
 * avec PKCE (S256), échange du code, renouvellement par `refresh_token`, et
 * révocation au point de terminaison du serveur d'autorisation.
 *
 * ## Ce que ce module refuse de supposer
 *
 * **Tous les serveurs MCP ne parlent pas OAuth de la même façon.** Certains
 * publient des métadonnées de ressource protégée, d'autres seulement des
 * métadonnées de serveur d'autorisation, d'autres rien du tout et attendent une
 * URL fournie par l'utilisateur. Certains n'implémentent pas l'enregistrement
 * dynamique ; d'autres refusent PKCE autrement qu'en S256.
 *
 * Le module essaie donc les variantes connues dans un ordre défini, et quand
 * aucune ne fonctionne il renvoie un code précis (`decouverte_impossible`,
 * `pkce_non_supporte`, `enregistrement_refuse`…) plutôt qu'un « OAuth ne marche
 * pas ». Une incompatibilité expliquée vaut mieux qu'un échec opaque.
 *
 * ## Sécurité
 *
 * Toutes les requêtes passent par `oauth-egress` : URL https, résolution
 * DNS vérifiée, adresse IP épinglée, redirections refusées. Les points de
 * terminaison viennent d'un serveur distant — donc d'une source non fiable — et
 * sont traités comme tels.
 *
 * Aucun jeton ne sort de ce module vers l'appelant HTTP : les valeurs sont
 * stockées côté serveur (Vault) par les fonctions SQL dédiées.
 */
import type { EgressDeps } from '../store-import/safe-egress.ts';
import { requeteOAuthSure, type DependancesOAuthHttp } from './oauth-egress.ts';

/** Taille maximale d'une réponse de métadonnées ou de jeton. */
const MAX_REPONSE = 64 * 1024;

export interface MetadonneesServeurAutorisation {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

export type Decouverte =
  | {
    ok: true;
    serveurAutorisation: string;
    metadonnees: MetadonneesServeurAutorisation;
    /** D'où viennent les métadonnées : utile au diagnostic et au rapport. */
    source: string;
    /** Vrai si PKCE S256 est explicitement annoncé. */
    pkceS256: boolean;
    /**
     * Portées annoncées par la RESSOURCE (RFC 9728), quand elles existent.
     * Elles priment sur celles du serveur d'autorisation : l'AS liste tout ce
     * qu'il sait délivrer (Linear : `read write openid email`, Vercel :
     * `openid email offline_access profile`), la ressource ce dont ELLE a
     * besoin (`read write`, `openid`). Demander plus que la ressource n'exige
     * est contraire au moindre privilège, et certains fournisseurs refusent.
     */
    porteesRessource?: string[];
  }
  | { ok: false; code: string; message: string };

export type ResultatOAuth<T> = { ok: true; valeur: T } | { ok: false; code: string; message: string };

function json<T>(valeur: T): ResultatOAuth<T> {
  return { ok: true, valeur };
}

function echec<T>(code: string, message: string): ResultatOAuth<T> {
  return { ok: false, code, message };
}

/** Une URL utilisable pour un échange : https, sans identifiants dans l'URL. */
function urlSure(brut: unknown): URL | null {
  if (typeof brut !== 'string' || brut.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(brut);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url;
}

/**
 * Requête JSON (métadonnées, enregistrement de client) vers un point OAuth.
 *
 * Passe par la sortie dédiée `oauth-egress` et non par celle de l'importateur :
 * celle-ci n'autorise que `application/json` en POST, ce qui convient ici, mais
 * disposer d'un seul chemin réseau pour tout OAuth évite deux politiques à
 * maintenir. L'épinglage, le refus des redirections et le plafond de taille sont
 * les mêmes.
 */
/** Extrait ` (code)` d'un corps d'erreur OAuth JSON, ou une chaîne vide. */
function codeErreurOAuth(corps: string): string {
  try {
    const brut = JSON.parse(corps) as { error?: unknown; error_description?: unknown };
    const code = typeof brut.error === 'string' ? brut.error.slice(0, 64) : '';
    const description = typeof brut.error_description === 'string' ? brut.error_description.slice(0, 160) : '';
    if (!code) return '';
    return description ? ` (${code} : ${description})` : ` (${code})`;
  } catch {
    return '';
  }
}

async function lireJson(
  url: URL,
  deps: EgressDeps,
  options: { methode: 'get' | 'post'; corps?: string; entetes?: Record<string, string> } = { methode: 'get' },
): Promise<ResultatOAuth<Record<string, unknown>>> {
  const entetes = { ...options.entetes };
  const reponse = await requeteOAuthSure(url, {
    accept: 'application/json',
    methode: options.methode === 'post' ? 'POST' : 'GET',
    typeContenu: 'application/json',
    ...(options.corps !== undefined ? { corps: options.corps } : {}),
    ...(Object.keys(entetes).length > 0 ? { entetes } : {}),
    maxBytes: MAX_REPONSE,
  }, deps as DependancesOAuthHttp);

  if (!reponse.ok) {
    return echec('reseau', `Impossible de joindre ${url.host} (${reponse.error.code}).`);
  }
  if (reponse.valeur.status < 200 || reponse.valeur.status >= 300) {
    // RFC 6749 §5.2 : un refus porte un code `error` court. On le remonte, et
    // rien d'autre du corps : c'est ce qui permet de lire « invalid_redirect_uri »
    // au lieu d'un 400 muet, sans recopier une page d'erreur entière.
    return echec('http', `${url.host} a répondu ${reponse.valeur.status}${codeErreurOAuth(reponse.valeur.body)}.`);
  }
  try {
    return json(JSON.parse(reponse.valeur.body) as Record<string, unknown>);
  } catch {
    return echec('reponse_invalide', `${url.host} n’a pas renvoyé du JSON.`);
  }
}

/**
 * Candidate URLs pour la métadonnée de ressource protégée (RFC 9728).
 *
 * La spécification permet de préfixer le chemin : `/mcp` donne
 * `/.well-known/oauth-protected-resource/mcp`. On essaie les deux formes, puis
 * la racine, parce que les implémentations diffèrent.
 */
export function urlsMetadonneesRessource(urlServeur: URL): string[] {
  const chemin = urlServeur.pathname.replace(/\/+$/, '');
  const base = `${urlServeur.origin}/.well-known/oauth-protected-resource`;
  return [...new Set([chemin ? `${base}${chemin}` : base, base])];
}

/** Candidate URLs pour les métadonnées du serveur d'autorisation (RFC 8414). */
export function urlsMetadonneesAutorisation(as: URL): string[] {
  const chemin = as.pathname.replace(/\/+$/, '');
  const origines = [
    `${as.origin}/.well-known/oauth-authorization-server${chemin}`,
    `${as.origin}/.well-known/oauth-authorization-server`,
    `${as.origin}/.well-known/openid-configuration${chemin}`,
    `${as.origin}${chemin}/.well-known/openid-configuration`,
  ];
  return [...new Set(origines)];
}

function lireMetadonnees(brut: Record<string, unknown>): MetadonneesServeurAutorisation | null {
  const autorisation = brut.authorization_endpoint;
  const token = brut.token_endpoint;
  if (typeof autorisation !== 'string' || typeof token !== 'string') return null;
  const inscrire = typeof brut.registration_endpoint === 'string' ? brut.registration_endpoint : undefined;
  const revocation = typeof brut.revocation_endpoint === 'string' ? brut.revocation_endpoint : undefined;
  const methodes = Array.isArray(brut.code_challenge_methods_supported)
    ? brut.code_challenge_methods_supported.filter((m): m is string => typeof m === 'string')
    : undefined;
  const scopes = Array.isArray(brut.scopes_supported)
    ? brut.scopes_supported.filter((s): s is string => typeof s === 'string')
    : undefined;
  const methodesClient = Array.isArray(brut.token_endpoint_auth_methods_supported)
    ? brut.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === 'string')
    : undefined;
  return {
    ...(typeof brut.issuer === 'string' ? { issuer: brut.issuer } : {}),
    authorization_endpoint: autorisation,
    token_endpoint: token,
    ...(inscrire ? { registration_endpoint: inscrire } : {}),
    ...(revocation ? { revocation_endpoint: revocation } : {}),
    ...(methodes ? { code_challenge_methods_supported: methodes } : {}),
    ...(scopes ? { scopes_supported: scopes } : {}),
    ...(methodesClient ? { token_endpoint_auth_methods_supported: methodesClient } : {}),
  };
}

/**
 * Découvre les points de terminaison OAuth d'un serveur MCP.
 *
 * Ordre : métadonnées de ressource protégée → (si `asFournie`) serveur
 * d'autorisation explicite → métadonnées posées à l'origine du serveur MCP.
 *
 * `asFournie` existe parce que certains serveurs n'exposent aucune métadonnée :
 * l'utilisateur peut alors désigner lui-même son serveur d'autorisation, ce qui
 * est prévu par la spécification MCP. Ce n'est pas un contournement.
 */
export async function decouvrir(
  urlServeur: URL,
  deps: EgressDeps,
  asFournie?: string | null,
): Promise<Decouverte> {
  const essais: string[] = [];

  // 1. Métadonnées de ressource protégée : elles désignent le serveur d'autorisation.
  for (const candidate of urlsMetadonneesRessource(urlServeur)) {
    const url = urlSure(candidate);
    if (!url) continue;
    const lecture = await lireJson(url, deps);
    if (!lecture.ok) { essais.push(`${url.pathname}:${lecture.code}`); continue; }
    const serveurs = lecture.valeur.authorization_servers;
    const premier = Array.isArray(serveurs) && typeof serveurs[0] === 'string' ? serveurs[0] : null;
    if (!premier) { essais.push(`${url.pathname}:sans_authorization_servers`); continue; }
    const as = urlSure(premier);
    if (!as) { essais.push(`${url.pathname}:authorization_server_invalide`); continue; }
    const trouve = await metadonneesAutorisation(as, deps);
    if (trouve.ok) {
      const brutes = lecture.valeur.scopes_supported;
      const porteesRessource = Array.isArray(brutes)
        ? brutes.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
        : [];
      return {
        ok: true,
        ...trouve.valeur,
        source: url.pathname,
        ...(porteesRessource.length > 0 ? { porteesRessource } : {}),
      };
    }
    essais.push(`${as.host}:${trouve.code}`);
  }

  // 2. Serveur d'autorisation fourni explicitement par l'utilisateur.
  if (asFournie) {
    const as = urlSure(asFournie);
    if (!as) return { ok: false, code: 'authorization_server_invalide', message: 'L’URL du serveur d’autorisation doit être en https.' };
    const trouve = await metadonneesAutorisation(as, deps);
    if (trouve.ok) return { ok: true, ...trouve.valeur, source: 'authorization_server_fourni' };
    essais.push(`${as.host}:${trouve.code}`);
  }

  // 3. Dernier recours : métadonnées à l'origine du serveur MCP lui-même.
  //    Beaucoup de serveurs MCP auto-hébergés servent leur AS sur la même origine.
  const trouve = await metadonneesAutorisation(urlServeur, deps);
  if (trouve.ok) return { ok: true, ...trouve.valeur, source: 'origine_serveur' };
  essais.push(`${urlServeur.host}:${trouve.code}`);

  return {
    ok: false,
    code: 'decouverte_impossible',
    message: `Aucune métadonnée OAuth exploitable. Essayé : ${essais.join(', ')}. `
      + 'Ce serveur n’expose peut-être pas OAuth : utilisez un jeton Bearer ou une clé d’API.',
  };
}

async function metadonneesAutorisation(
  as: URL,
  deps: EgressDeps,
): Promise<ResultatOAuth<{ serveurAutorisation: string; metadonnees: MetadonneesServeurAutorisation; pkceS256: boolean }>> {
  const essais: string[] = [];
  for (const candidate of urlsMetadonneesAutorisation(as)) {
    const url = urlSure(candidate);
    if (!url) continue;
    const lecture = await lireJson(url, deps);
    if (!lecture.ok) { essais.push(`${url.pathname}:${lecture.code}`); continue; }
    const metadonnees = lireMetadonnees(lecture.valeur);
    if (!metadonnees) { essais.push(`${url.pathname}:incompletes`); continue; }
    if (!urlSure(metadonnees.authorization_endpoint) || !urlSure(metadonnees.token_endpoint)) {
      essais.push(`${url.pathname}:endpoint_non_https`);
      continue;
    }
    const methodes = metadonnees.code_challenge_methods_supported;
    return json({
      serveurAutorisation: as.origin,
      metadonnees,
      /*
       * `code_challenge_methods_supported` absent ne signifie pas « PKCE
       * refusé » : la spécification MCP l'exige, et beaucoup de serveurs
       * l'omettent tout en l'acceptant. En revanche une liste qui ne contient
       * que `plain` est un refus explicite de S256.
       */
      pkceS256: !methodes || methodes.includes('S256'),
    });
  }
  return echec('metadonnees_invalides', `Métadonnées d’autorisation illisibles (${essais.join(', ')}).`);
}

/* -------------------------------------------------------------------------- */
/* PKCE                                                                         */
/* -------------------------------------------------------------------------- */

function base64url(octets: Uint8Array): string {
  let binaire = '';
  for (const octet of octets) binaire += String.fromCharCode(octet);
  return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function genererVerificateur(): string {
  const octets = new Uint8Array(48);
  crypto.getRandomValues(octets);
  return base64url(octets);
}

export function genererEtat(): string {
  const octets = new Uint8Array(32);
  crypto.getRandomValues(octets);
  return Array.from(octets).map((o) => o.toString(16).padStart(2, '0')).join('');
}

/** `code_challenge` = base64url(SHA-256(verifier)) — méthode S256, jamais `plain`. */
export async function defiDepuisVerificateur(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/* -------------------------------------------------------------------------- */
/* Enregistrement dynamique du client (RFC 7591)                                */
/* -------------------------------------------------------------------------- */

export interface ClientOAuth {
  clientId: string;
  clientSecret?: string;
  /** Vrai si le client a été obtenu par enregistrement dynamique (pas saisi). */
  enregistre: boolean;
}

export async function enregistrerClient(
  metadonnees: MetadonneesServeurAutorisation,
  redirectUri: string,
  deps: EgressDeps,
  nomClient = 'SORAHNEX MCP',
): Promise<ResultatOAuth<ClientOAuth>> {
  if (!metadonnees.registration_endpoint) {
    return echec(
      'enregistrement_indisponible',
      'Ce serveur d’autorisation n’expose pas d’enregistrement dynamique de client : '
        + 'un identifiant client doit être fourni.',
    );
  }
  const url = urlSure(metadonnees.registration_endpoint);
  if (!url) return echec('enregistrement_refuse', 'Point d’enregistrement non https.');

  const corps = JSON.stringify({
    client_name: nomClient,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });

  const lecture = await lireJson(url, deps, {
    methode: 'post',
    corps,
    entetes: { 'content-type': 'application/json' },
  });
  // Le détail (statut HTTP, hôte) est conservé : « refusé (http) » ne permet
  // pas de distinguer un redirect_uri rejeté d'un point d'enregistrement fermé.
  if (!lecture.ok) return echec('enregistrement_refuse', `Enregistrement refusé : ${lecture.message}`);

  const clientId = lecture.valeur.client_id;
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    return echec('enregistrement_refuse', 'Le serveur n’a pas renvoyé d’identifiant client.');
  }
  const secret = typeof lecture.valeur.client_secret === 'string' && lecture.valeur.client_secret.trim() !== ''
    ? lecture.valeur.client_secret.trim()
    : undefined;
  return json({ clientId: clientId.trim(), ...(secret ? { clientSecret: secret } : {}), enregistre: true });
}

/* -------------------------------------------------------------------------- */
/* URL d'autorisation                                                          */
/* -------------------------------------------------------------------------- */

export function urlAutorisation(entree: {
  metadonnees: MetadonneesServeurAutorisation;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope?: string;
  resource?: string;
}): ResultatOAuth<string> {
  const url = urlSure(entree.metadonnees.authorization_endpoint);
  if (!url) return echec('as_invalide', 'Point d’autorisation non https.');

  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', entree.clientId);
  url.searchParams.set('redirect_uri', entree.redirectUri);
  url.searchParams.set('state', entree.state);
  url.searchParams.set('code_challenge', entree.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (entree.scope) url.searchParams.set('scope', entree.scope);
  /*
   * `resource` (RFC 8707) indique pour QUEL serveur MCP le jeton est demandé.
   * Un serveur d'autorisation partagé entre plusieurs ressources doit le savoir
   * pour ne pas délivrer un jeton valable partout.
   */
  if (entree.resource) url.searchParams.set('resource', entree.resource);
  return json(url.toString());
}

/* -------------------------------------------------------------------------- */
/* Échange et renouvellement                                                    */
/* -------------------------------------------------------------------------- */

export interface Jetons {
  access: string;
  refresh?: string;
  /** Durée de vie annoncée, en secondes. */
  expireDans?: number;
  scope?: string;
}

function corpsFormulaire(champs: Record<string, string | undefined>): string {
  const parametres = new URLSearchParams();
  for (const [cle, valeur] of Object.entries(champs)) {
    if (valeur !== undefined && valeur !== '') parametres.set(cle, valeur);
  }
  return parametres.toString();
}

async function demanderJetons(
  tokenEndpoint: string,
  champs: Record<string, string | undefined>,
  client: ClientOAuth,
  deps: EgressDeps,
): Promise<ResultatOAuth<Jetons>> {
  const url = urlSure(tokenEndpoint);
  if (!url) return echec('as_invalide', 'Point de jeton non https.');

  /*
   * Client confidentiel : `client_secret_basic` (en-tête). Client public : rien,
   * le `client_id` voyage dans le corps. On choisit en fonction de ce que le
   * serveur nous a réellement donné, pas d'une préférence.
   */
  const entetes: Record<string, string> = {};
  if (client.clientSecret) {
    entetes.authorization = `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`;
  }

  /*
   * Formulaire obligatoire (RFC 6749 §3.2), et non JSON : la sortie dédiée
   * l'autorise explicitement, la sortie de l'importateur ne l'aurait pas permis.
   */
  const corpsJeton = corpsFormulaire({
    ...champs,
    ...(client.clientSecret ? {} : { client_id: client.clientId }),
  });
  const reponseJeton = await requeteOAuthSure(url, {
    accept: 'application/json',
    methode: 'POST',
    typeContenu: 'application/x-www-form-urlencoded',
    corps: corpsJeton,
    ...(Object.keys(entetes).length > 0 ? { entetes } : {}),
    maxBytes: MAX_REPONSE,
  }, deps as DependancesOAuthHttp);

  let lecture: ResultatOAuth<Record<string, unknown>>;
  if (!reponseJeton.ok) {
    lecture = echec('echange_refuse', `Point de jeton injoignable (${reponseJeton.error.code}).`);
  } else if (reponseJeton.valeur.status < 200 || reponseJeton.valeur.status >= 300) {
    // Le code d'erreur RFC 6749 (`invalid_grant`, `invalid_client`…) est la
    // seule information actionnable : on le garde, borné, sans le reste du corps.
    lecture = echec('echange_refuse', `Point de jeton : statut ${reponseJeton.valeur.status}${codeErreurOAuth(reponseJeton.valeur.body)}.`);
  } else {
    try {
      lecture = json(JSON.parse(reponseJeton.valeur.body) as Record<string, unknown>);
    } catch {
      lecture = echec('echange_refuse', 'Le point de jeton n’a pas renvoyé du JSON.');
    }
  }

  if (!lecture.ok) {
    /*
     * Un 400/401 d'un point de jeton porte le plus souvent `error` :
     * `invalid_grant` (code ou refresh expiré/réutilisé), `invalid_client`…
     * On le remonte, car la différence décide de ce que l'utilisateur doit
     * faire : reconnecter, ou patienter.
     */
    return echec('echange_refuse', `Échange de jeton refusé : ${lecture.message}`);
  }

  const access = lecture.valeur.access_token;
  if (typeof access !== 'string' || access.trim() === '') {
    const erreur = typeof lecture.valeur.error === 'string' ? lecture.valeur.error : 'access_token_absent';
    return echec('echange_refuse', `Le serveur d’autorisation n’a pas délivré de jeton (${erreur}).`);
  }
  const refresh = typeof lecture.valeur.refresh_token === 'string' && lecture.valeur.refresh_token.trim() !== ''
    ? lecture.valeur.refresh_token.trim()
    : undefined;
  const expireBrut = lecture.valeur.expires_in;
  const expireDans = typeof expireBrut === 'number' && Number.isFinite(expireBrut) && expireBrut > 0
    ? Math.floor(expireBrut)
    : undefined;
  const scope = typeof lecture.valeur.scope === 'string' ? lecture.valeur.scope : undefined;

  return json({
    access: access.trim(),
    ...(refresh ? { refresh } : {}),
    ...(expireDans ? { expireDans } : {}),
    ...(scope ? { scope } : {}),
  });
}

export function echangerCode(
  entree: {
    tokenEndpoint: string;
    code: string;
    verifier: string;
    redirectUri: string;
    client: ClientOAuth;
  },
  deps: EgressDeps,
): Promise<ResultatOAuth<Jetons>> {
  return demanderJetons(entree.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: entree.code,
    code_verifier: entree.verifier,
    redirect_uri: entree.redirectUri,
  }, entree.client, deps);
}

export function rafraichirJetons(
  entree: { tokenEndpoint: string; refresh: string; client: ClientOAuth },
  deps: EgressDeps,
): Promise<ResultatOAuth<Jetons>> {
  return demanderJetons(entree.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: entree.refresh,
  }, entree.client, deps);
}

export async function revoquerJeton(
  entree: {
    revocationEndpoint: string;
    jeton: string;
    client: ClientOAuth;
    /** RFC 7009 §2.1 : indication du type, pour que l'AS cherche au bon endroit. */
    typeJeton?: 'access_token' | 'refresh_token';
  },
  deps: EgressDeps,
): Promise<ResultatOAuth<void>> {
  const url = urlSure(entree.revocationEndpoint);
  if (!url) return echec('as_invalide', 'Point de révocation non https.');
  const entetes: Record<string, string> = {};
  if (entree.client.clientSecret) {
    entetes.authorization = `Basic ${btoa(`${entree.client.clientId}:${entree.client.clientSecret}`)}`;
  }
  const revocation = await requeteOAuthSure(url, {
    accept: 'application/json',
    methode: 'POST',
    typeContenu: 'application/x-www-form-urlencoded',
    corps: corpsFormulaire({
      token: entree.jeton,
      token_type_hint: entree.typeJeton ?? 'refresh_token',
      ...(entree.client.clientSecret ? {} : { client_id: entree.client.clientId }),
    }),
    ...(Object.keys(entetes).length > 0 ? { entetes } : {}),
    maxBytes: MAX_REPONSE,
  }, deps as DependancesOAuthHttp);
  if (!revocation.ok) return echec('revocation_refusee', `Révocation injoignable (${revocation.error.code}).`);
  // RFC 7009 : un 200 vide est la réponse normale, un 400/503 signale un refus.
  if (revocation.valeur.status >= 400) {
    return echec('revocation_refusee', `Révocation refusée (statut ${revocation.valeur.status}).`);
  }
  return json(undefined);
}

/* -------------------------------------------------------------------------- */
/* État d'expiration                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Un jeton doit-il être renouvelé ?
 *
 * Marge de 60 s : renouveler « juste avant » évite qu'un jeton encore valide au
 * moment du contrôle n'expire pendant l'appel. Sans date d'expiration connue,
 * on ne renouvelle pas : c'est au serveur de répondre 401, et l'utilisateur de
 * reconnecter. Inventer une expiration provoquerait des refresh inutiles.
 */
export function fautRafraichir(expireLe: string | null | undefined, maintenant = Date.now(), margeMs = 60_000): boolean {
  if (!expireLe) return false;
  const date = Date.parse(expireLe);
  if (!Number.isFinite(date)) return false;
  return date - margeMs <= maintenant;
}

/** Date d'expiration absolue à partir d'une durée annoncée. */
export function dateExpiration(expireDans: number | undefined, maintenant = Date.now()): string | null {
  if (!expireDans || !Number.isFinite(expireDans) || expireDans <= 0) return null;
  return new Date(maintenant + expireDans * 1000).toISOString();
}
