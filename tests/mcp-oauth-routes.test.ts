// @vitest-environment node
/**
 * Routes OAuth — transport HTTP, consentement, échange de jetons.
 *
 * Les dépendances sont simulées par un faux dépôt qui applique les mêmes règles
 * que les fonctions SQL (consommation atomique, rotation, empreinte). On teste
 * donc le contrat réel : ce que reçoit un client MCP, y compris malveillant.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  cheminLogique,
  donnerConsentement,
  estRouteOAuth,
  preparerConsentement,
  repondreMetadonneesAutorisation,
  repondreMetadonneesRessource,
  traiterEnregistrement,
  traiterJeton,
  type DependancesOAuth,
  type SessionSORAHNEX,
} from '../supabase/functions/vyora-mcp/oauth-routes.ts';

const RESSOURCE = 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-mcp';
const EMETTEUR = 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-oauth';

const VERIFIER = 'v'.repeat(48);
const CHALLENGE = createHash('sha256').update(VERIFIER, 'utf8').digest('base64url');
const SESSION: SessionSORAHNEX = { userId: '11111111-1111-4111-8111-111111111111', csrfToken: 'csrf-abc' };

/** Faux dépôt : même comportement observable que les fonctions SQL. */
function deps(surcharge: Partial<DependancesOAuth> = {}) {
  const clients = new Map<string, any>();
  const codes = new Map<string, any>();
  const refresh = new Map<string, any>();
  const jetonsEmis: Array<Record<string, unknown>> = [];

  const base: DependancesOAuth = {
    ressource: RESSOURCE,
    emetteur: EMETTEUR,

    async chargerClient(clientId) {
      return clients.get(clientId) ?? null;
    },

    async enregistrerClient(entree) {
      const client_id = `vyora_client_${clients.size + 1}`;
      clients.set(client_id, {
        client_id,
        client_name: entree.client_name,
        is_public: entree.is_public,
        client_secret_sha256: null,
        redirect_uris: entree.redirect_uris,
        allowed_scopes: entree.allowed_scopes,
        token_endpoint_auth_method: entree.is_public ? 'none' : 'client_secret_post',
      });
      return { client_id, client_name: entree.client_name, redirect_uris: entree.redirect_uris, scope: entree.allowed_scopes.join(' ') };
    },

    async creerCode(entree) {
      const code = `code_${codes.size + 1}_${'x'.repeat(24)}`;
      codes.set(code, { ...entree });
      return code;
    },

    async consommerCode(code) {
      const ligne = codes.get(code);
      if (!ligne || ligne.usedAt) return null;
      ligne.usedAt = new Date().toISOString();
      return {
        client_id: ligne.client_id,
        user_id: ligne.user_id,
        redirect_uri: ligne.redirect_uri,
        scopes: ligne.scopes,
        code_challenge: ligne.code_challenge,
        resource: ligne.resource,
      };
    },

    async emettreJetons(entree) {
      const jeton = {
        access_token: `vyora_mcp_${'a'.repeat(43)}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: entree.scopes.join(' '),
        refresh_token: `vyora_rt_${'b'.repeat(43)}`,
        token_id: 'token-1',
      };
      refresh.set(jeton.refresh_token, { ...entree, used: false });
      jetonsEmis.push(jeton);
      return jeton;
    },

    async faireTournerRafraichissement(token) {
      const ligne = refresh.get(token);
      if (!ligne || ligne.used) return null;
      ligne.used = true;
      return {
        access_token: `vyora_mcp_${'c'.repeat(43)}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: ligne.scopes.join(' '),
        refresh_token: `vyora_rt_${'d'.repeat(43)}`,
      };
    },

    async hacher(secret) {
      return createHash('sha256').update(secret, 'utf8').digest('hex');
    },

    ...surcharge,
  };

  return { deps: base, clients, codes, refresh, jetonsEmis };
}

/** Enregistre un client de test et renvoie l'identifiant créé. */
async function enregistrerClient(d: DependancesOAuth): Promise<string> {
  const r = await traiterEnregistrement(d, {
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    scope: 'read',
  });
  return (r.body as { client_id: string }).client_id;
}

const PARAMS = (clientId: string) => ({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  scope: 'read',
  state: 'state-1',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  resource: RESSOURCE,
});

/* -------------------------------------------------------------------------- */
/* 1. Reconnaissance des routes                                                */
/* -------------------------------------------------------------------------- */

describe('reconnaissance des routes', () => {
  it('reconnaît les chemins malgré le préfixe /functions/v1', () => {
    expect(cheminLogique('/functions/v1/vyora-mcp/.well-known/oauth-protected-resource'))
      .toBe('/.well-known/oauth-protected-resource');
    expect(cheminLogique('/oauth/token')).toBe('/oauth/token');
    expect(cheminLogique('/oauth/token/')).toBe('/oauth/token');
    expect(cheminLogique('/')).toBe('/');
    expect(cheminLogique('')).toBe('/');
  });

  it('ne confond pas la racine MCP avec une route OAuth', () => {
    expect(estRouteOAuth('/functions/v1/vyora-mcp')).toBe(false);
    expect(estRouteOAuth('/functions/v1/vyora-mcp/oauth/token')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Métadonnées servies en HTTP                                              */
/* -------------------------------------------------------------------------- */

describe('métadonnées servies', () => {
  it('sert le document de ressource avec un contenu JSON', () => {
    const r = repondreMetadonneesRessource(deps().deps);
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toContain('application/json');
    expect((r.body as any).resource).toBe(RESSOURCE);
  });

  it('sert le document d’autorisation avec les endpoints réels', () => {
    const r = repondreMetadonneesAutorisation(deps().deps);
    expect((r.body as any).token_endpoint).toBe(`${EMETTEUR}/oauth/token`);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Enregistrement                                                           */
/* -------------------------------------------------------------------------- */

describe('route d’enregistrement', () => {
  it('crée un client et renvoie 201', async () => {
    const d = deps();
    const r = await traiterEnregistrement(d.deps, {
      client_name: 'Cursor',
      redirect_uris: ['https://cursor.sh/cb'],
    });
    expect(r.status).toBe(201);
    expect((r.body as any).client_id).toMatch(/^vyora_client_/);
  });

  it('refuse une redirection en clair', async () => {
    const d = deps();
    const r = await traiterEnregistrement(d.deps, { redirect_uris: ['http://evil.example/cb'] });
    expect(r.status).toBe(400);
    expect((r.body as any).error).toBe('invalid_redirect_uri');
  });

  it('refuse un corps qui n’est pas un objet', async () => {
    const d = deps();
    const r = await traiterEnregistrement(d.deps, 'pas un objet');
    expect(r.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Consentement                                                             */
/* -------------------------------------------------------------------------- */

describe('page de consentement', () => {
  it('prépare un consentement sans émettre de code', async () => {
    const d = deps();
    const id = await enregistrerClient(d.deps);
    const r = await preparerConsentement(d.deps, PARAMS(id), SESSION);

    expect(r.type).toBe('consentement');
    if (r.type !== 'consentement') return;
    expect(r.vue.clientName).toBe('Claude');
    expect(r.vue.scopes).toEqual(['read']);
    expect(r.vue.csrfToken).toBe('csrf-abc');
    expect(r.vue.redirectHost).toBe('claude.ai');
    // Aucun code ne doit exister à ce stade : c'est tout l'intérêt.
    expect(d.codes.size).toBe(0);
  });

  it('exige une session SORAHNEX', async () => {
    const d = deps();
    const id = await enregistrerClient(d.deps);
    const r = await preparerConsentement(d.deps, PARAMS(id), null);
    expect(r.type).toBe('erreur');
    if (r.type !== 'erreur') return;
    expect(r.reponse.status).toBe(401);
    expect((r.reponse.body as any).error).toBe('login_required');
  });

  it('affiche une erreur au lieu de rediriger vers une adresse non fiable', async () => {
    const d = deps();
    const id = await enregistrerClient(d.deps);
    const r = await preparerConsentement(
      d.deps,
      { ...PARAMS(id), redirect_uri: 'https://attaquant.example/cb' },
      SESSION,
    );
    expect(r.type).toBe('erreur');
    if (r.type !== 'erreur') return;
    expect(r.reponse.redirectTo).toBeUndefined();
    expect(r.reponse.status).toBe(400);
  });
});

describe('consentement donné', () => {
  it('redirige avec un code et rejoue le state', async () => {
    const d = deps();
    const id = await enregistrerClient(d.deps);
    const r = await donnerConsentement(d.deps, PARAMS(id), SESSION);

    expect(r.status).toBe(302);
    const url = new URL(r.redirectTo as string);
    expect(url.origin + url.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code')).toBeTruthy();
  });

  it('refuse sans session', async () => {
    const d = deps();
    const id = await enregistrerClient(d.deps);
    const r = await donnerConsentement(d.deps, PARAMS(id), null);
    expect(r.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Point d'entrée des jetons                                                */
/* -------------------------------------------------------------------------- */

describe('échange de code en HTTP', () => {
  it('émet un jeton d’accès et un rafraîchissement', async () => {
    const d = deps();
    const id = await enregistrerClient(d.deps);
    const consentement = await donnerConsentement(d.deps, PARAMS(id), SESSION);
    const code = new URL(consentement.redirectTo as string).searchParams.get('code') as string;

    const r = await traiterJeton(d.deps, {
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: VERIFIER,
      resource: RESSOURCE,
    });

    expect(r.status).toBe(200);
    const corps = r.body as any;
    expect(corps.access_token).toMatch(/^vyora_mcp_/);
    expect(corps.token_type).toBe('Bearer');
    expect(corps.refresh_token).toMatch(/^vyora_rt_/);
    expect(r.headers.Pragma).toBe('no-cache');
  });

  it('refuse de rejouer le même code', async () => {
    const d = deps();
    const id = await enregistrerClient(d.deps);
    const consentement = await donnerConsentement(d.deps, PARAMS(id), SESSION);
    const code = new URL(consentement.redirectTo as string).searchParams.get('code') as string;
    const demande = {
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: VERIFIER,
      resource: RESSOURCE,
    };

    expect((await traiterJeton(d.deps, demande)).status).toBe(200);
    // Deuxième tentative : la consommation atomique renvoie null.
    const second = await traiterJeton(d.deps, demande);
    expect(second.status).toBe(400);
    expect((second.body as any).error).toBe('invalid_grant');
  });

  it('refuse un mauvais code_verifier', async () => {
    const d = deps();
    const id = await enregistrerClient(d.deps);
    const consentement = await donnerConsentement(d.deps, PARAMS(id), SESSION);
    const code = new URL(consentement.redirectTo as string).searchParams.get('code') as string;

    const r = await traiterJeton(d.deps, {
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: 'z'.repeat(48),
      resource: RESSOURCE,
    });
    expect(r.status).toBe(400);
    expect((r.body as any).error).toBe('invalid_grant');
  });

  it('refuse un client inconnu avec 401', async () => {
    const r = await traiterJeton(deps().deps, {
      grant_type: 'authorization_code',
      code: 'code_inconnu_xxxxxxxxxxxxxxxxxxxxxxxx',
      client_id: 'vyora_client_inconnu',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: VERIFIER,
      resource: RESSOURCE,
    });
    expect(r.status).toBe(401);
    expect((r.body as any).error).toBe('invalid_client');
  });
});

describe('rafraîchissement en HTTP', () => {
  it('fait tourner le rafraîchissement une seule fois', async () => {
    const d = deps();
    const id = await enregistrerClient(d.deps);
    const consentement = await donnerConsentement(d.deps, PARAMS(id), SESSION);
    const code = new URL(consentement.redirectTo as string).searchParams.get('code') as string;
    const premier = await traiterJeton(d.deps, {
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: VERIFIER,
      resource: RESSOURCE,
    });
    const refresh = (premier.body as any).refresh_token as string;

    const rotation = await traiterJeton(d.deps, { grant_type: 'refresh_token', refresh_token: refresh, client_id: id });
    expect(rotation.status).toBe(200);
    expect((rotation.body as any).access_token).toMatch(/^vyora_mcp_/);

    // Rejeu : le rafraîchissement a été consommé.
    const rejeu = await traiterJeton(d.deps, { grant_type: 'refresh_token', refresh_token: refresh, client_id: id });
    expect(rejeu.status).toBe(400);
    expect((rejeu.body as any).error).toBe('invalid_grant');
  });

  it('refuse un rafraîchissement inconnu sans fuite de détail', async () => {
    const r = await traiterJeton(deps().deps, {
      grant_type: 'refresh_token',
      refresh_token: `vyora_rt_${'q'.repeat(43)}`,
    });
    expect(r.status).toBe(400);
    expect((r.body as any).error).toBe('invalid_grant');
  });

  it('refuse un rafraîchissement vide', async () => {
    const r = await traiterJeton(deps().deps, { grant_type: 'refresh_token' });
    expect(r.status).toBe(400);
    expect((r.body as any).error).toBe('invalid_request');
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Sous-ensemble volontairement limité                                      */
/* -------------------------------------------------------------------------- */

describe('surface volontairement réduite', () => {
  it('refuse client_credentials', async () => {
    const d = deps();
    const id = await enregistrerClient(d.deps);
    const r = await traiterJeton(d.deps, { grant_type: 'client_credentials', client_id: id });
    expect(r.status).toBe(400);
    expect((r.body as any).error).toBe('unsupported_grant_type');
  });

  it('refuse un mot de passe en subvention sans exiger de client', async () => {
    // Régression : la vérification du client passait avant celle du
    // grant_type et renvoyait 401, masquant la vraie cause.
    const r = await traiterJeton(deps().deps, { grant_type: 'password', username: 'a', password: 'b' });
    expect(r.status).toBe(400);
    expect((r.body as any).error).toBe('unsupported_grant_type');
  });
});
