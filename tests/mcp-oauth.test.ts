// @vitest-environment node
/**
 * OAuth 2.1 du serveur MCP — protocole, PKCE, redirections, ressource.
 *
 * Ces tests portent sur `oauth.ts`, qui ne fait aucune entrée/sortie. Ils
 * vérifient donc exactement ce qui sera déployé : les décisions, pas la plomberie.
 *
 * Les cas d'échec sont volontairement majoritaires. Une implémentation OAuth
 * qui « marche » pour un client honnête ne prouve rien ; ce qui la rend sûre,
 * c'est de refuser correctement un client malveillant.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  canonicaliserRessource,
  echangerCode,
  enteteDefi,
  lireBearer,
  metadonneesAutorisation,
  metadonneesRessource,
  validerAutorisation,
  validerEnregistrement,
  verifierPkce,
} from '../supabase/functions/vyora-mcp/oauth.ts';

const RESSOURCE = 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-mcp';
const EMETTEUR = 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-oauth';

/** Calcule un défi PKCE S256 comme le ferait un client réel. */
function defi(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

const VERIFIER = 'a'.repeat(43) + 'Zz9_-';
const CHALLENGE = defi(VERIFIER);

const CLIENT = {
  client_id: 'vyora_client_abc',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  allowed_scopes: ['read'],
};

/* -------------------------------------------------------------------------- */
/* 1. Métadonnées (RFC 9728 et RFC 8414)                                       */
/* -------------------------------------------------------------------------- */

describe('métadonnées OAuth', () => {
  it('décrit la ressource avec son serveur d’autorisation', () => {
    const doc = metadonneesRessource(RESSOURCE, EMETTEUR) as Record<string, unknown>;
    expect(doc.resource).toBe(RESSOURCE);
    // Sans `authorization_servers`, un client conforme ne peut pas démarrer.
    expect(doc.authorization_servers).toEqual([EMETTEUR]);
    expect(doc.scopes_supported).toEqual(['read', 'write']);
    expect(doc.bearer_methods_supported).toEqual(['header']);
  });

  it('n’annonce aucun endpoint que le code ne sert pas', () => {
    const doc = metadonneesAutorisation(EMETTEUR) as Record<string, any>;
    expect(doc.authorization_endpoint).toBe(`${EMETTEUR}/oauth/authorize`);
    expect(doc.token_endpoint).toBe(`${EMETTEUR}/oauth/token`);
    expect(doc.registration_endpoint).toBe(`${EMETTEUR}/oauth/register`);
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
    // OAuth 2.1 proscrit ces deux-là : leur absence doit être vérifiée.
    expect(doc.grant_types_supported).not.toContain('implicit');
    expect(doc.grant_types_supported).not.toContain('password');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Enregistrement de client (RFC 7591)                                      */
/* -------------------------------------------------------------------------- */

describe('enregistrement dynamique de client', () => {
  it('accepte un client public avec une redirection HTTPS', () => {
    const r = validerEnregistrement({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      scope: 'read',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.is_public).toBe(true);
    expect(r.value.allowed_scopes).toEqual(['read']);
  });

  it('tolère la boucle locale HTTP d’un client de bureau (RFC 8252)', () => {
    const r = validerEnregistrement({ redirect_uris: ['http://127.0.0.1:33418/callback'] });
    expect(r.ok).toBe(true);
  });

  it('refuse une redirection en HTTP non locale', () => {
    const r = validerEnregistrement({ redirect_uris: ['http://evil.example/cb'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('invalid_redirect_uri');
  });

  it('refuse un fragment dans la redirection', () => {
    // Un code placé après `#` ne quitte jamais le navigateur côté serveur mais
    // fuit dans l'historique : la spécification l'interdit.
    const r = validerEnregistrement({ redirect_uris: ['https://app.example/cb#x'] });
    expect(r.ok).toBe(false);
  });

  it('refuse un schéma exotique', () => {
    const r = validerEnregistrement({ redirect_uris: ['javascript:alert(1)'] });
    expect(r.ok).toBe(false);
  });

  it('refuse une portée inconnue', () => {
    const r = validerEnregistrement({
      redirect_uris: ['https://app.example/cb'],
      scope: 'read admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('invalid_scope');
  });

  it('refuse une liste vide ou trop longue', () => {
    expect(validerEnregistrement({ redirect_uris: [] }).ok).toBe(false);
    const trop = Array.from({ length: 11 }, (_, i) => `https://a${i}.example/cb`);
    expect(validerEnregistrement({ redirect_uris: trop }).ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Requête d'autorisation                                                   */
/* -------------------------------------------------------------------------- */

describe('requête d’autorisation', () => {
  const base = {
    response_type: 'code',
    client_id: CLIENT.client_id,
    redirect_uri: CLIENT.redirect_uris[0],
    scope: 'read',
    state: 'xyz',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource: RESSOURCE,
  };

  it('accepte une demande complète et conforme', () => {
    const r = validerAutorisation(base, CLIENT, RESSOURCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scopes).toEqual(['read']);
    expect(r.value.state).toBe('xyz');
  });

  it('refuse un client inconnu', () => {
    const r = validerAutorisation(base, null, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('unauthorized_client');
    expect(r.error.status).toBe(401);
  });

  it('refuse une redirection différente d’un caractère', () => {
    // Le cas d'attaque : un attaquant enregistre un préfixe voisin et espère
    // une comparaison laxiste.
    const r = validerAutorisation({ ...base, redirect_uri: `${CLIENT.redirect_uris[0]}/../evil` }, CLIENT, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error_description).toMatch(/redirect_uri/);
  });

  it('refuse l’absence de PKCE', () => {
    const r = validerAutorisation({ ...base, code_challenge: null }, CLIENT, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error_description).toMatch(/PKCE/);
  });

  it('refuse PKCE « plain »', () => {
    const r = validerAutorisation({ ...base, code_challenge_method: 'plain' }, CLIENT, RESSOURCE);
    expect(r.ok).toBe(false);
  });

  it('refuse l’absence de « resource » (RFC 8707)', () => {
    const r = validerAutorisation({ ...base, resource: null }, CLIENT, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('invalid_target');
  });

  it('refuse une « resource » qui n’est pas ce serveur', () => {
    const r = validerAutorisation({ ...base, resource: 'https://mcp.attaquant.example/mcp' }, CLIENT, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('invalid_target');
  });

  it('refuse un « response_type » implicite', () => {
    const r = validerAutorisation({ ...base, response_type: 'token' }, CLIENT, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('unsupported_response_type');
  });

  it('refuse une portée que le client n’a pas le droit de demander', () => {
    const r = validerAutorisation({ ...base, scope: 'read write' }, CLIENT, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('invalid_scope');
  });

  it('refuse un « state » contenant un saut de ligne', () => {
    const r = validerAutorisation({ ...base, state: 'a\r\nb' }, CLIENT, RESSOURCE);
    expect(r.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Canonicalisation de ressource (RFC 8707 §2)                              */
/* -------------------------------------------------------------------------- */

describe('canonicalisation de ressource', () => {
  it('normalise casse, port 443 et barre oblique finale', () => {
    expect(canonicaliserRessource('https://MCP.Example.com:443/mcp/')).toBe('https://mcp.example.com/mcp');
  });

  it('refuse une ressource non HTTPS', () => {
    expect(canonicaliserRessource('http://mcp.example.com/mcp')).toBeNull();
  });

  it('refuse un fragment et des identifiants', () => {
    expect(canonicaliserRessource('https://mcp.example.com/mcp#x')).toBeNull();
    expect(canonicaliserRessource('https://user:pw@mcp.example.com/mcp')).toBeNull();
  });

  it('distingue deux serveurs différents par leur chemin', () => {
    expect(canonicaliserRessource('https://a.example/mcp')).not.toBe(
      canonicaliserRessource('https://a.example/autre'),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 5. PKCE                                                                     */
/* -------------------------------------------------------------------------- */

describe('PKCE', () => {
  it('accepte un vérificateur correct', async () => {
    expect(await verifierPkce(VERIFIER, CHALLENGE)).toBe(true);
  });

  it('refuse un vérificateur différent', async () => {
    expect(await verifierPkce('b'.repeat(50), CHALLENGE)).toBe(false);
  });

  it('refuse un vérificateur trop court ou hors alphabet', async () => {
    expect(await verifierPkce('court', CHALLENGE)).toBe(false);
    expect(await verifierPkce(`${'a'.repeat(40)}!!!`, CHALLENGE)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Échange de code contre jeton                                             */
/* -------------------------------------------------------------------------- */

describe('échange de code', () => {
  const stocke = {
    client_id: CLIENT.client_id,
    user_id: '11111111-1111-4111-8111-111111111111',
    redirect_uri: CLIENT.redirect_uris[0],
    scopes: ['read'],
    code_challenge: CHALLENGE,
    resource: canonicaliserRessource(RESSOURCE) as string,
  };

  const demande = {
    grant_type: 'authorization_code',
    code: 'code-abc',
    client_id: CLIENT.client_id,
    redirect_uri: CLIENT.redirect_uris[0],
    code_verifier: VERIFIER,
    resource: RESSOURCE,
  };

  it('accepte un échange conforme', async () => {
    const r = await echangerCode(demande, stocke, RESSOURCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user_id).toBe(stocke.user_id);
    expect(r.value.scopes).toEqual(['read']);
  });

  it('refuse un code inconnu, déjà utilisé ou expiré', async () => {
    const r = await echangerCode(demande, null, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('invalid_grant');
  });

  it('refuse un code émis pour un autre client', async () => {
    const r = await echangerCode({ ...demande, client_id: 'vyora_client_autre' }, stocke, RESSOURCE);
    expect(r.ok).toBe(false);
  });

  it('refuse une redirect_uri différente de celle de l’autorisation', async () => {
    const r = await echangerCode({ ...demande, redirect_uri: 'https://evil.example/cb' }, stocke, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('invalid_grant');
  });

  it('refuse une ressource différente de celle de l’autorisation', async () => {
    const r = await echangerCode({ ...demande, resource: 'https://autre.example/mcp' }, stocke, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('invalid_target');
  });

  it('refuse un mauvais code_verifier', async () => {
    const r = await echangerCode({ ...demande, code_verifier: 'c'.repeat(50) }, stocke, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('invalid_grant');
  });

  it('refuse tout autre type de subvention', async () => {
    const r = await echangerCode({ ...demande, grant_type: 'client_credentials' }, stocke, RESSOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('unsupported_grant_type');
  });
});

/* -------------------------------------------------------------------------- */
/* 7. En-têtes                                                                    */
/* -------------------------------------------------------------------------- */

describe('en-têtes', () => {
  it('pointe vers les métadonnées de ressource dans le défi 401', () => {
    const entete = enteteDefi(`${RESSOURCE.replace('vyora-mcp', 'vyora-oauth')}/.well-known/oauth-protected-resource`, {
      erreur: 'invalid_token',
      portees: ['read'],
    });
    expect(entete).toContain('realm="vyora-mcp"');
    expect(entete).toContain('resource_metadata="');
    expect(entete).toContain('error="invalid_token"');
    expect(entete).toContain('scope="read"');
  });

  it('lit un Bearer sans accepter d’autre schéma', () => {
    expect(lireBearer('Bearer abc.def')).toBe('abc.def');
    expect(lireBearer('bearer   xyz')).toBe('xyz');
    expect(lireBearer('Basic dXNlcjpwYXNz')).toBeNull();
    expect(lireBearer('Bearer')).toBeNull();
    expect(lireBearer(null)).toBeNull();
  });
});
