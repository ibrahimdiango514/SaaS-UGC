import { describe, expect, it, vi } from 'vitest';
import { extractSignedRequest, handleMetaLifecycle, type LifecycleDeps } from '../supabase/functions/meta-lifecycle/handler.ts';

/**
 * Rappels de cycle de vie Meta : routage et échec fermé.
 *
 * ## Ce que ces tests protègent
 * 1. **La signature est la seule barrière.** Ces routes sont publiques, sans
 *    JWT. Un POST non signé ne doit RIEN écrire.
 * 2. **Les deux routes ne sont pas interchangeables.** `/deauthorize` révoque
 *    les autorisations d'utilisateur ; `/data-deletion` efface tout. Confondre
 *    les deux coupe une messagerie WhatsApp en production ou conserve des
 *    données qu'on devait supprimer.
 * 3. **La réponse de suppression a la forme exigée par Meta**, sinon le rappel
 *    est désactivé et l'application peut être suspendue.
 */

const SECRET = 'SECRET_DE_TEST_JAMAIS_EXPOSE';

function b64url(octets: Uint8Array): string {
  let binaire = '';
  for (const o of octets) binaire += String.fromCharCode(o);
  return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signer(payload: Record<string, unknown>, secret = SECRET): Promise<string> {
  const clef = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', clef, new TextEncoder().encode(payloadB64)),
  );
  return `${b64url(signature)}.${payloadB64}`;
}

/** Dépendances espionnes : on veut savoir ce qui a été APPELÉ, pas seulement le statut. */
function depsEspionnes(overrides: Partial<LifecycleDeps> = {}) {
  return {
    appSecret: SECRET,
    appUrl: 'https://vyora.test',
    now: () => new Date(1700000000000),
    revokeUserConnections: vi.fn(async () => ({ removed: 2, tokenRefs: ['ref-page-1', 'ref-user-1'] })),
    deleteUserData: vi.fn(async () => ({ connectionsRemoved: 3, tokenRefs: ['ref-a', 'ref-b'] })),
    recordDeletionRequest: vi.fn(async () => {}),
    deleteSecrets: vi.fn(async () => 2),
    log: vi.fn(),
    ...overrides,
  } satisfies LifecycleDeps;
}

function corps(signed: string): string {
  return `signed_request=${encodeURIComponent(signed)}`;
}

describe('extractSignedRequest', () => {
  it('lit un corps de formulaire encodé', () => {
    expect(extractSignedRequest('foo=bar&signed_request=abc%2Edef')).toBe('abc.def');
  });

  it('tolère la forme JSON', () => {
    expect(extractSignedRequest('{"signed_request":"xyz"}')).toBe('xyz');
  });

  it('renvoie null sur un corps vide ou illisible', () => {
    expect(extractSignedRequest('')).toBeNull();
    expect(extractSignedRequest('autre=1')).toBeNull();
    expect(extractSignedRequest('{')).toBeNull();
  });

  it('renvoie null sur un encodage pourcent invalide au lieu de lever', () => {
    expect(extractSignedRequest('signed_request=%E0%A4%A')).toBeNull();
  });
});

describe('handleMetaLifecycle — la signature commande', () => {
  it('REFUSE un POST non signé sans rien écrire', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'data-deletion', contentType: 'application/x-www-form-urlencoded', rawBody: 'user_id=42' },
      deps,
    );
    expect(r.status).toBe(401);
    // Le point capital : aucune suppression n'a été tentée.
    expect(deps.deleteUserData).not.toHaveBeenCalled();
    expect(deps.revokeUserConnections).not.toHaveBeenCalled();
    expect(deps.deleteSecrets).not.toHaveBeenCalled();
  });

  it('REFUSE une signature faite avec un autre secret', async () => {
    const deps = depsEspionnes();
    const faux = await signer({ algorithm: 'HMAC-SHA256', user_id: '42' }, 'AUTRE_SECRET');
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'deauthorize', contentType: 'application/x-www-form-urlencoded', rawBody: corps(faux) },
      deps,
    );
    expect(r.status).toBe(401);
    expect(deps.revokeUserConnections).not.toHaveBeenCalled();
  });

  it('ne dit pas POURQUOI la signature a échoué', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'deauthorize', contentType: 'application/x-www-form-urlencoded', rawBody: 'signed_request=a.b' },
      deps,
    );
    // Un message précis aiderait un attaquant à distinguer les causes.
    expect(JSON.stringify(r.body)).not.toContain('SIGNATURE_INVALID');
  });

  it('refuse les méthodes autres que POST', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(
      { method: 'GET', route: 'deauthorize', contentType: '', rawBody: '' },
      deps,
    );
    expect(r.status).toBe(405);
  });

  it('refuse une route inconnue même correctement signée', async () => {
    const deps = depsEspionnes();
    const bon = await signer({ algorithm: 'HMAC-SHA256', user_id: '42' });
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'autre', contentType: 'application/x-www-form-urlencoded', rawBody: corps(bon) },
      deps,
    );
    expect(r.status).toBe(404);
    expect(deps.deleteUserData).not.toHaveBeenCalled();
  });
});

describe('handleMetaLifecycle — deauthorize', () => {
  it('révoque les connexions et efface les secrets', async () => {
    const deps = depsEspionnes();
    const bon = await signer({ algorithm: 'HMAC-SHA256', user_id: '42' });
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'deauthorize', contentType: 'application/x-www-form-urlencoded', rawBody: corps(bon) },
      deps,
    );
    expect(r.status).toBe(200);
    expect(deps.revokeUserConnections).toHaveBeenCalledWith('42');
    // Les références de page ET le jeton utilisateur doivent être effacés.
    expect(deps.deleteSecrets).toHaveBeenCalledWith(['ref-page-1', 'ref-user-1']);
    // Une déautorisation n'efface PAS toutes les données : ce serait excessif.
    expect(deps.deleteUserData).not.toHaveBeenCalled();
  });

  it('répond 200 même quand aucune connexion ne correspond', async () => {
    // Cas légitime : la personne a retiré VYORA sans jamais l'avoir connectée.
    const deps = depsEspionnes({ revokeUserConnections: vi.fn(async () => ({ removed: 0, tokenRefs: [] })) });
    const bon = await signer({ algorithm: 'HMAC-SHA256', user_id: '999' });
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'deauthorize', contentType: 'application/x-www-form-urlencoded', rawBody: corps(bon) },
      deps,
    );
    expect(r.status).toBe(200);
  });
});

describe('handleMetaLifecycle — data-deletion', () => {
  it('efface tout et renvoie la forme exacte exigée par Meta', async () => {
    const deps = depsEspionnes();
    const bon = await signer({ algorithm: 'HMAC-SHA256', user_id: '218471000222' });
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'data-deletion', contentType: 'application/x-www-form-urlencoded', rawBody: corps(bon) },
      deps,
    );
    expect(r.status).toBe(200);
    expect(deps.deleteUserData).toHaveBeenCalledWith('218471000222');
    expect(deps.deleteSecrets).toHaveBeenCalledWith(['ref-a', 'ref-b']);

    const corpsReponse = r.body as { url: string; confirmation_code: string };
    // Meta exige ces deux clés, exactement.
    expect(Object.keys(corpsReponse).sort()).toEqual(['confirmation_code', 'url']);
    expect(corpsReponse.url).toContain('https://vyora.test');
    expect(corpsReponse.confirmation_code).toBeTruthy();
  });

  it('journalise la demande pour permettre le suivi', async () => {
    const deps = depsEspionnes();
    const bon = await signer({ algorithm: 'HMAC-SHA256', user_id: '42' });
    await handleMetaLifecycle(
      { method: 'POST', route: 'data-deletion', contentType: 'application/x-www-form-urlencoded', rawBody: corps(bon) },
      deps,
    );
    expect(deps.recordDeletionRequest).toHaveBeenCalledWith('42', expect.any(String), 3);
  });

  it('répond quand même si le journal échoue — la suppression est déjà faite', async () => {
    const deps = depsEspionnes({
      recordDeletionRequest: vi.fn(async () => { throw new Error('base indisponible'); }),
    });
    const bon = await signer({ algorithm: 'HMAC-SHA256', user_id: '42' });
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'data-deletion', contentType: 'application/x-www-form-urlencoded', rawBody: corps(bon) },
      deps,
    );
    // Meta n'a aucun moyen de rejouer : échouer ici désactiverait le rappel.
    expect(r.status).toBe(200);
    expect((r.body as { url: string }).url).toBeTruthy();
  });

  it('ne journalise jamais d’identifiant Meta ni de jeton', async () => {
    const journal: string[] = [];
    const deps = depsEspionnes({
      log: (message, details) => { journal.push(`${message} ${JSON.stringify(details)}`); },
    });
    const bon = await signer({ algorithm: 'HMAC-SHA256', user_id: '218471000222' });
    await handleMetaLifecycle(
      { method: 'POST', route: 'data-deletion', contentType: 'application/x-www-form-urlencoded', rawBody: corps(bon) },
      deps,
    );
    const trace = journal.join('\n');
    expect(trace).not.toContain('218471000222');
    expect(trace).not.toContain(SECRET);
    expect(trace).not.toContain('ref-a');
  });
});
