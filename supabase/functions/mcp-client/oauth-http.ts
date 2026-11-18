/**
 * VYORA — routes HTTP du flux OAuth 2.1 SORTANT.
 *
 * ## Deux routes, deux niveaux de confiance
 *
 * - `POST /gestion/oauth-demarrer` : authentifiée par jeton GoTrue, comme toutes
 *   les routes de gestion. Elle ne fait que préparer une autorisation.
 * - `GET /oauth/callback` : appelée par le NAVIGATEUR après redirection du
 *   serveur d'autorisation. Elle n'a donc **aucun en-tête d'authentification**
 *   et ne peut pas en avoir. Sa seule preuve d'identité est le `state`, à usage
 *   unique, lié à l'utilisateur et à la connexion au moment du démarrage, et
 *   expirant en dix minutes.
 *
 * ## Pourquoi le callback ne prend pas de jeton VYORA
 *
 * Un serveur d'autorisation redirige le navigateur par une simple navigation :
 * aucun en-tête personnalisé n'est conservé. Exiger un jeton ici rendrait le
 * flux impossible. Le `state` + PKCE sont la protection prévue par la
 * spécification, et le code d'autorisation n'est utilisable qu'avec le
 * `code_verifier` que seul le serveur VYORA connaît.
 */
import { entetesCors, construireReponse, type ResolveurIdentite } from './http.ts';
import { validerCible } from './gestion.ts';
import type { DependancesGestion, ServeurGere } from './gestion-serveur.ts';
import {
  decouvrir,
  defiDepuisVerificateur,
  echangerCode,
  enregistrerClient,
  genererEtat,
  genererVerificateur,
  urlAutorisation,
  type ClientOAuth,
} from './oauth.ts';

/**
 * Un retour d'autorisation se reconnaît à son chemin, quelle que soit la
 * racine de la fonction (`/functions/v1/mcp-client` ou un domaine personnalisé).
 */
export function estCheminCallback(chemin: string): boolean {
  return /\/oauth\/callback\/?$/.test(chemin || '');
}

export interface OptionsOAuth {
  originesSupplementaires: string | null;
  identite: ResolveurIdentite;
  journal?: (message: string, details: Record<string, unknown>) => void;
}

/** URL publique de retour, dérivée de la requête réelle (jamais codée en dur). */
export function urlCallback(request: Request): string {
  const url = new URL(request.url);
  const chemin = url.pathname;
  const base = chemin.includes('/gestion/')
    ? chemin.slice(0, chemin.indexOf('/gestion/'))
    : chemin.replace(/\/+$/, '');
  return `${url.origin}${base}/oauth/callback`;
}

/**
 * Prépare une autorisation : découverte, enregistrement, PKCE, URL.
 *
 * Ne délivre aucun jeton : elle renvoie une URL vers laquelle envoyer
 * l'utilisateur. C'est le callback qui reçoit le code.
 */
export async function traiterDemarrageOAuth(
  request: Request,
  corps: unknown,
  deps: () => DependancesGestion,
  options: OptionsOAuth,
): Promise<Response> {
  const cors = entetesCors(options.originesSupplementaires, request.headers.get('origin'));
  const journal = options.journal ?? console.error;

  const identite = await options.identite(request.headers.get('authorization') ?? '');
  if (!identite) {
    return construireReponse(401, { error: 'authentification_requise', message: 'Jeton absent ou invalide.' }, cors);
  }

  const validation = validerCible(corps);
  if (!validation.ok) {
    return construireReponse(validation.status, { error: validation.code, message: validation.message }, cors);
  }

  const base = deps().base;
  let serveur: ServeurGere | null;
  try {
    serveur = await base.lireServeur({ userId: identite.userId, serverId: validation.demande.serverId });
  } catch (erreur) {
    return erreurReponse(erreur, cors);
  }
  if (!serveur) {
    return construireReponse(404, { error: 'server_not_found', message: 'Connexion MCP introuvable.' }, cors);
  }
  if (serveur.revokedAt !== null || serveur.status === 'revoked') {
    return construireReponse(409, { error: 'revoked', message: 'Cette connexion MCP est révoquée.' }, cors);
  }
  if (serveur.authKind !== 'oauth') {
    return construireReponse(400, {
      error: 'mode_non_oauth',
      message: 'Cette connexion n’utilise pas OAuth : aucun flux d’autorisation à lancer.',
    }, cors);
  }

  let urlServeur: URL;
  try {
    urlServeur = new URL(serveur.url);
  } catch {
    return construireReponse(400, { error: 'url_invalide', message: 'URL de connexion invalide.' }, cors);
  }

  const depsReseau = deps();
  const decouverte = await decouvrir(urlServeur, depsReseau.egress, serveur.authorizationServer);
  if (!decouverte.ok) {
    // L'incompatibilité est DITE : c'est le cas « ce serveur ne parle pas OAuth
    // comme les autres », et l'utilisateur doit savoir quoi faire.
    return construireReponse(422, {
      error: decouverte.code,
      message: decouverte.message,
    }, cors);
  }
  if (!decouverte.pkceS256) {
    return construireReponse(422, {
      error: 'pkce_non_supporte',
      message: 'Ce serveur d’autorisation n’accepte pas PKCE S256. VYORA refuse de poursuivre : '
        + 'sans PKCE, un code d’autorisation intercepté serait réutilisable.',
    }, cors);
  }

  const redirectUri = urlCallback(request);

  // Client existant, ou enregistrement dynamique.
  let client: ClientOAuth | null = serveur.oauthClientId
    ? { clientId: serveur.oauthClientId, enregistre: false }
    : null;

  let clientSecret: string | undefined;
  if (client) {
    const existant = await base.lireOAuth(serveur.id);
    clientSecret = existant?.clientSecret ?? undefined;
    if (clientSecret) client = { ...client, clientSecret };
  } else {
    const enregistrement = await enregistrerClient(decouverte.metadonnees, redirectUri, depsReseau.egress);
    if (!enregistrement.ok) {
      return construireReponse(422, { error: enregistrement.code, message: enregistrement.message }, cors);
    }
    client = enregistrement.valeur;
    await base.enregistrerClientOAuth({
      userId: identite.userId,
      serverId: serveur.id,
      clientId: client.clientId,
      ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
      authorizationServer: decouverte.serveurAutorisation,
      metadonnees: decouverte.metadonnees,
    });
  }

  const verifier = genererVerificateur();
  const challenge = await defiDepuisVerificateur(verifier);
  const state = genererEtat();

  await base.creerFluxOAuth({
    state,
    userId: identite.userId,
    serverId: serveur.id,
    verifier,
    redirectUri,
  });

  const portees = decouverte.metadonnees.scopes_supported;
  const autorisation = urlAutorisation({
    metadonnees: decouverte.metadonnees,
    clientId: client.clientId,
    redirectUri,
    state,
    challenge,
    // On ne demande QUE ce que le serveur annonce : demander une portée
    // inconnue fait échouer l'autorisation chez la plupart des fournisseurs.
    ...(portees && portees.length > 0 ? { scope: portees.join(' ') } : {}),
    resource: serveur.url,
  });
  if (!autorisation.ok) {
    return construireReponse(422, { error: autorisation.code, message: autorisation.message }, cors);
  }

  journal('[mcp-client] oauth démarré', {
    userId: identite.userId,
    serverId: serveur.id,
    source: decouverte.source,
    enregistre: client.enregistre,
  });

  return construireReponse(200, {
    ok: true,
    autorisationUrl: autorisation.valeur,
    state,
    serveurAutorisation: decouverte.serveurAutorisation,
    sourceMetadonnees: decouverte.source,
    portees: portees ?? null,
    clientEnregistre: client.enregistre,
    /*
     * `pkceAnnonce = false` signifie : le serveur n'a pas listé S256 dans ses
     * métadonnées. On continue (beaucoup de serveurs l'omettent et l'exigent
     * quand même), mais l'interface doit pouvoir le dire plutôt que de laisser
     * croire à une vérification qui n'a pas eu lieu.
     */
    pkceAnnonce: Boolean(decouverte.metadonnees.code_challenge_methods_supported?.includes('S256')),
  }, cors);
}

/** Petite page HTML : c'est le navigateur qui arrive ici, pas un client JSON. */
function pageHtml(titre: string, texte: string, statut: number): Response {
  const echapper = (v: string) => v.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${echapper(titre)} — VYORA</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e2e8f0;
font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
.carte{max-width:520px;background:#111a2e;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:28px}
h1{font-size:18px;margin:0 0 12px}
p{margin:0;color:#94a3b8}
code{background:#0b1220;padding:2px 6px;border-radius:6px;color:#cbd5e1}
</style></head><body><div class="carte"><h1>${echapper(titre)}</h1><p>${texte}</p></div></body></html>`;
  return new Response(html, {
    status: statut,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Reçoit le code d'autorisation et échange les jetons.
 *
 * `state` consommé AVANT l'échange : si l'échange échoue, le state reste brûlé.
 * C'est volontaire — un code rejoué après un échec doit être refusé, pas
 * retenté indéfiniment.
 */
export async function traiterCallbackOAuth(
  request: Request,
  deps: () => DependancesGestion,
  options: { journal?: (message: string, details: Record<string, unknown>) => void } = {},
): Promise<Response> {
  const journal = options.journal ?? console.error;
  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const erreurAs = url.searchParams.get('error');
  const descriptionAs = url.searchParams.get('error_description');

  if (erreurAs) {
    // Refus explicite de l'utilisateur chez le fournisseur, ou erreur de celui-ci.
    return pageHtml(
      'Autorisation refusée',
      `Le serveur d’autorisation a refusé la demande : <code>${descriptionAs ?? erreurAs}</code>. `
        + 'Vous pouvez relancer l’autorisation depuis VYORA.',
      400,
    );
  }
  if (!state || !code) {
    return pageHtml('Requête incomplète', 'Le retour du serveur d’autorisation est incomplet (état ou code absent).', 400);
  }

  const base = deps().base;
  let flux: Awaited<ReturnType<typeof base.consommerFluxOAuth>>;
  try {
    flux = await base.consommerFluxOAuth(state);
  } catch {
    // `state_invalide` : inconnu, déjà utilisé, ou expiré. Les trois sont des refus.
    return pageHtml(
      'Autorisation expirée',
      'Ce retour d’autorisation n’est plus valable (état inconnu, déjà utilisé ou expiré). '
        + 'Relancez la connexion depuis VYORA.',
      400,
    );
  }
  if (!flux) {
    return pageHtml('Autorisation expirée', 'Ce retour d’autorisation n’est plus valable. Relancez la connexion.', 400);
  }

  const serveur = await base.lireServeur({ userId: flux.userId, serverId: flux.serverId });
  if (!serveur) {
    return pageHtml('Connexion introuvable', 'La connexion MCP visée n’existe plus.', 404);
  }

  const oauth = await base.lireOAuth(serveur.id);
  if (!oauth?.clientId) {
    return pageHtml('Configuration incomplète', 'Aucun identifiant client OAuth n’est enregistré pour cette connexion.', 409);
  }
  const tokenEndpoint = lireTokenEndpoint(serveur);
  if (!tokenEndpoint) {
    return pageHtml(
      'Métadonnées perdues',
      'Les points de terminaison OAuth de ce serveur ne sont plus disponibles. Relancez la connexion.',
      422,
    );
  }

  const client: ClientOAuth = {
    clientId: oauth.clientId,
    ...(oauth.clientSecret ? { clientSecret: oauth.clientSecret } : {}),
    enregistre: false,
  };

  const echange = await echangerCode({
    tokenEndpoint,
    code,
    verifier: flux.verifier,
    redirectUri: flux.redirectUri,
    client,
  }, deps().egress);

  if (!echange.ok) {
    journal('[mcp-client] oauth échange refusé', { serverId: serveur.id, code: echange.code });
    return pageHtml(
      'Échange refusé',
      `Le serveur d’autorisation n’a pas délivré de jeton : <code>${echange.message}</code>`,
      502,
    );
  }

  const expireLe = echange.valeur.expireDans
    ? new Date(Date.now() + echange.valeur.expireDans * 1000).toISOString()
    : null;

  try {
    await base.stockerJetonsOAuth({
      userId: flux.userId,
      serverId: serveur.id,
      access: echange.valeur.access,
      ...(echange.valeur.refresh ? { refresh: echange.valeur.refresh } : {}),
      expireLe,
      scope: echange.valeur.scope ?? null,
    });
  } catch {
    return pageHtml('Enregistrement impossible', 'Les jetons n’ont pas pu être enregistrés côté serveur.', 500);
  }

  journal('[mcp-client] oauth abouti', {
    serverId: serveur.id,
    avecRafraichissement: Boolean(echange.valeur.refresh),
    expireLe,
  });

  return pageHtml(
    'Autorisation accordée',
    'VYORA a obtenu un jeton d’accès pour cette connexion. '
      + `Il expire ${expireLe ? `le ${new Date(expireLe).toLocaleString('fr-FR')}` : 'à une date non communiquée'}. `
      + 'Vous pouvez revenir à la page « Connexions MCP » et tester la connexion.',
    200,
  );
}

/**
 * Le point de terminaison de jeton vient des métadonnées mémorisées au
 * démarrage : on ne refait pas une découverte réseau ici, et on ne fait pas
 * confiance à un endpoint fourni par le navigateur.
 */
function lireTokenEndpoint(serveur: ServeurGere): string | null {
  const endpoint = (serveur.oauthAs ?? {})['token_endpoint'];
  return typeof endpoint === 'string' && endpoint.startsWith('https://') ? endpoint : null;
}

function erreurReponse(erreur: unknown, cors: Record<string, string>): Response {
  const message = erreur instanceof Error ? erreur.message : String(erreur);
  if (message.includes('server_not_found')) {
    return construireReponse(404, { error: 'server_not_found', message: 'Connexion MCP introuvable.' }, cors);
  }
  return construireReponse(500, { error: 'erreur_base', message: 'La demande n’a pas pu être traitée.' }, cors);
}
