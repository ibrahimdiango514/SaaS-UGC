import { describe, expect, it, vi } from 'vitest';
import { extractSignedRequest, handleMetaLifecycle, type DeletionStatus, type LifecycleDeps } from '../supabase/functions/meta-lifecycle/handler.ts';

/**
 * Rappels de cycle de vie Meta : contrat, idempotence, échec fermé.
 *
 * ## Ce que ces tests protègent
 * 1. **La signature est la seule barrière.** Ces routes sont publiques, sans
 *    JWT. Un POST non signé ne doit RIEN écrire.
 * 2. **Les deux rappels ne sont pas interchangeables.** `/deauthorize` révoque
 *    les autorisations d'utilisateur ; `/data-deletion` efface tout. Confondre
 *    les deux coupe une messagerie WhatsApp en production ou conserve des
 *    données qu'on devait supprimer.
 * 3. **La réponse de suppression a la forme exacte exigée par Meta**, et le code
 *    qu'elle contient est celui réellement enregistré.
 * 4. **Une requête répétée n'échoue pas et ne vise jamais un autre utilisateur.**
 * 5. **Une panne de base ne produit pas un 200 mensonger.**
 */

const SECRET = 'SECRET_DE_TEST_JAMAIS_EXPOSE';
const CODE = 'vyora-0123456789abcdef0123456789abcdef';

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
    revokeUserConnections: vi.fn(async () => ({ removed: 2 })),
    deleteUserData: vi.fn(async () => ({ confirmationCode: CODE, connectionsRemoved: 3 })),
    readDeletionStatus: vi.fn(async (): Promise<DeletionStatus | null> => ({
      status: 'completed',
      requestedAt: '2026-11-14T10:00:00.000Z',
      completedAt: '2026-11-14T10:00:01.000Z',
      hasFailure: false,
    })),
    log: vi.fn(),
    ...overrides,
  } satisfies LifecycleDeps;
}

/** Corps de formulaire tel que Meta le poste. */
function corps(signed: string): string {
  return `signed_request=${encodeURIComponent(signed)}`;
}

/** Requête de rappel signée valide. */
async function rappel(route: string, userId = '218471000222') {
  return {
    method: 'POST',
    route,
    contentType: 'application/x-www-form-urlencoded',
    rawBody: corps(await signer({ algorithm: 'HMAC-SHA256', user_id: userId })),
  };
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

/* ------------------------------------------------------------------------- */
/* 1. Signature absente / invalide → rien n'est écrit                          */
/* ------------------------------------------------------------------------- */
describe('signature absente ou invalide', () => {
  it('REFUSE un POST non signé sans rien écrire', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'data-deletion', contentType: 'application/x-www-form-urlencoded', rawBody: 'user_id=42' },
      deps,
    );
    expect(r.status).toBe(401);
    expect(deps.deleteUserData).not.toHaveBeenCalled();
    expect(deps.revokeUserConnections).not.toHaveBeenCalled();
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

  it('refuse un App Secret vide — jamais de validation « par défaut »', async () => {
    // Secret serveur non posé : la fonction doit refuser, pas accepter tout.
    const deps = depsEspionnes({ appSecret: '' });
    // On signe avec un secret QUELCONQUE non vide : HMAC n'accepte pas de clé
    // vide, et le handler doit de toute façon rejeter faute de secret configuré.
    const bon = await signer({ algorithm: 'HMAC-SHA256', user_id: '42' }, 'PEU_IMPORTE');
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'data-deletion', contentType: 'application/x-www-form-urlencoded', rawBody: corps(bon) },
      deps,
    );
    expect(r.status).toBe(401);
    expect(deps.deleteUserData).not.toHaveBeenCalled();
  });

  it('ne dit pas POURQUOI la signature a échoué', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'deauthorize', contentType: 'application/x-www-form-urlencoded', rawBody: 'signed_request=a.b' },
      deps,
    );
    expect(JSON.stringify(r.body)).not.toContain('SIGNATURE_INVALID');
  });

  it('refuse les méthodes autres que POST sur les rappels', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(
      { method: 'GET', route: 'deauthorize', contentType: '', rawBody: '' },
      deps,
    );
    expect(r.status).toBe(405);
  });

  it('refuse une route inconnue même correctement signée', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(await rappel('autre'), deps);
    expect(r.status).toBe(404);
    expect(deps.deleteUserData).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------- */
/* 2. Contrat de réponse de data-deletion                                     */
/* ------------------------------------------------------------------------- */
describe('data-deletion — contrat Meta', () => {
  it('renvoie un JSON avec EXACTEMENT url et confirmation_code', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(await rappel('data-deletion'), deps);
    expect(r.status).toBe(200);
    const corpsReponse = r.body as { url: string; confirmation_code: string };
    expect(Object.keys(corpsReponse).sort()).toEqual(['confirmation_code', 'url']);
    expect(corpsReponse.confirmation_code).toBe(CODE);
    expect(r.headers['content-type']).toContain('application/json');
  });

  it('l’URL renvoyée contient le code réellement enregistré', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(await rappel('data-deletion'), deps);
    const { url, confirmation_code } = r.body as { url: string; confirmation_code: string };
    // Un code recalculé ne correspondrait pas à la ligne en base : la page de
    // suivi répondrait « demande inconnue ».
    expect(new URL(url).searchParams.get('code')).toBe(confirmation_code);
  });

  it('ne renvoie jamais de jeton ni d’identifiant Meta dans la réponse', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(await rappel('data-deletion', '218471000222'), deps);
    const texte = JSON.stringify(r.body);
    expect(texte).not.toContain('218471000222');
    expect(texte).not.toContain(SECRET);
  });
});

/* ------------------------------------------------------------------------- */
/* 3. Idempotence et utilisateur inconnu                                      */
/* ------------------------------------------------------------------------- */
describe('idempotence et utilisateur inconnu', () => {
  it('une seconde réception réussit et produite une réponse valide', async () => {
    // Simule la 2ᵉ réception : plus rien à supprimer, l'appel ne doit pas lever.
    const deps = depsEspionnes({
      deleteUserData: vi.fn(async () => ({ confirmationCode: 'vyora-000222-ffffffffffffffffffffffffffffffff', connectionsRemoved: 0 })),
    });
    const premiere = await handleMetaLifecycle(await rappel('data-deletion'), deps);
    const seconde = await handleMetaLifecycle(await rappel('data-deletion'), deps);
    expect(premiere.status).toBe(200);
    expect(seconde.status).toBe(200);
    // Deux réceptions = deux appels, mais aucune erreur.
    expect(deps.deleteUserData).toHaveBeenCalledTimes(2);
  });

  it('un identifiant inconnu ne touche rien et répond 200', async () => {
    const deps = depsEspionnes({
      deleteUserData: vi.fn(async () => ({ confirmationCode: CODE, connectionsRemoved: 0 })),
    });
    const r = await handleMetaLifecycle(await rappel('data-deletion', '999999'), deps);
    expect(r.status).toBe(200);
    // La personne n'était pas cliente : ce n'est pas une erreur.
    expect((r.body as { confirmation_code: string }).confirmation_code).toBe(CODE);
  });

  it('transmet l’identifiant de la signature, jamais un identifiant du corps', async () => {
    const deps = depsEspionnes();
    // Le corps contient un AUTRE identifiant : il ne doit pas être utilisé.
    const signed = await signer({ algorithm: 'HMAC-SHA256', user_id: '111' });
    await handleMetaLifecycle(
      { method: 'POST', route: 'data-deletion', contentType: 'application/x-www-form-urlencoded', rawBody: `user_id=222&${corps(signed)}` },
      deps,
    );
    expect(deps.deleteUserData).toHaveBeenCalledWith('111');
    expect(deps.deleteUserData).not.toHaveBeenCalledWith('222');
  });

  it('deauthorize répété ne supprime plus rien mais ne casse pas', async () => {
    const deps = depsEspionnes({ revokeUserConnections: vi.fn(async () => ({ removed: 0 })) });
    const r1 = await handleMetaLifecycle(await rappel('deauthorize'), deps);
    const r2 = await handleMetaLifecycle(await rappel('deauthorize'), deps);
    expect([r1.status, r2.status]).toEqual([200, 200]);
  });
});

/* ------------------------------------------------------------------------- */
/* 4. Erreur de base de données                                               */
/* ------------------------------------------------------------------------- */
describe('erreur de base de données', () => {
  it('data-deletion renvoie 500, pas un 200 mensonger', async () => {
    const deps = depsEspionnes({
      deleteUserData: vi.fn(async () => { throw new Error('connexion perdue'); }),
    });
    const r = await handleMetaLifecycle(await rappel('data-deletion'), deps);
    // 200 ferait croire à Meta que la suppression a eu lieu : elle cesserait de
    // réessayer, et les données resteraient en place.
    expect(r.status).toBe(500);
    expect(r.body).not.toHaveProperty('confirmation_code');
  });

  it('deauthorize renvoie 500 pour que Meta puisse réessayer', async () => {
    const deps = depsEspionnes({
      revokeUserConnections: vi.fn(async () => { throw new Error('timeout'); }),
    });
    const r = await handleMetaLifecycle(await rappel('deauthorize'), deps);
    // Un 200 laisserait l'utilisateur « déconnecté chez Meta mais connecté chez
    // VYORA » : c'est précisément le défaut que ce module corrige.
    expect(r.status).toBe(500);
  });

  it('ne journalise jamais d’identifiant Meta ni de jeton, même en échec', async () => {
    const journal: string[] = [];
    const deps = depsEspionnes({
      log: (message, details) => { journal.push(`${message} ${JSON.stringify(details)}`); },
      deleteUserData: vi.fn(async () => { throw new Error('panne'); }),
    });
    await handleMetaLifecycle(await rappel('data-deletion', '218471000222'), deps);
    const trace = journal.join('\n');
    expect(trace).not.toContain('218471000222');
    expect(trace).not.toContain(SECRET);
  });
});

/* ------------------------------------------------------------------------- */
/* 5. Page publique de suivi                                                  */
/* ------------------------------------------------------------------------- */
describe('deletion-status — page publique de suivi', () => {
  it('renvoie l’état pour un code valide, sans identifiant', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(
      { method: 'GET', route: 'deletion-status', contentType: '', rawBody: '', query: { code: CODE } },
      deps,
    );
    expect(r.status).toBe(200);
    const corps = r.body as DeletionStatus;
    expect(corps.status).toBe('completed');
    // Aucun champ ne doit permettre de remonter au client.
    expect(Object.keys(corps).sort()).toEqual(['completedAt', 'hasFailure', 'requestedAt', 'status']);
  });

  it('n’est pas mise en cache : le code est dans l’URL', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(
      { method: 'GET', route: 'deletion-status', contentType: '', rawBody: '', query: { code: CODE } },
      deps,
    );
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('REFUSE un code contenant un identifiant Meta en clair', async () => {
    /*
     * Défaut réellement constaté en base avant correction : le code était
     * `vyora-<6 derniers de l'ASID>-<aléa>`, donc un identifiant Meta en clair
     * dans une URL publique. On verrouille ici le format : plus aucun fragment
     * d'identifiant ne doit être accepté.
     */
    const deps = depsEspionnes();
    for (const fuite of [
      'vyora-WABA_1-9f4a3edfe43c41e18a60c9eea29f7cf9',
      'vyora-218471-9f4a3edfe43c41e18a60c9eea29f7cf9',
    ]) {
      const r = await handleMetaLifecycle(
        { method: 'GET', route: 'deletion-status', contentType: '', rawBody: '', query: { code: fuite } },
        deps,
      );
      expect(r.status, fuite).toBe(400);
    }
    expect(deps.readDeletionStatus).not.toHaveBeenCalled();
  });

  it('refuse un code mal formé SANS interroger la base', async () => {
    const deps = depsEspionnes();
    for (const mauvais of ['', 'abc', 'vyora-', 'vyora-123-short', "1' or '1'='1"]) {
      const r = await handleMetaLifecycle(
        { method: 'GET', route: 'deletion-status', contentType: '', rawBody: '', query: { code: mauvais } },
        deps,
      );
      expect(r.status, mauvais).toBe(400);
    }
    // La page est publique et sonder la base à chaque chaîne serait un vecteur
    // d'épuisement de connexions.
    expect(deps.readDeletionStatus).not.toHaveBeenCalled();
  });

  it('renvoie 404 pour un code valide mais inconnu', async () => {
    const deps = depsEspionnes({ readDeletionStatus: vi.fn(async () => null) });
    const r = await handleMetaLifecycle(
      { method: 'GET', route: 'deletion-status', contentType: '', rawBody: '', query: { code: CODE } },
      deps,
    );
    expect(r.status).toBe(404);
  });

  it('expose l’état « en attente » distinctement', async () => {
    const deps = depsEspionnes({
      readDeletionStatus: vi.fn(async () => ({
        status: 'pending' as const,
        requestedAt: '2026-11-14T10:00:00.000Z',
        completedAt: null,
        hasFailure: false,
      })),
    });
    const r = await handleMetaLifecycle(
      { method: 'GET', route: 'deletion-status', contentType: '', rawBody: '', query: { code: CODE } },
      deps,
    );
    expect((r.body as DeletionStatus).status).toBe('pending');
    expect((r.body as DeletionStatus).completedAt).toBeNull();
  });

  it('expose « aucune donnée à supprimer » distinctement', async () => {
    const deps = depsEspionnes({
      readDeletionStatus: vi.fn(async () => ({
        status: 'no_data' as const,
        requestedAt: '2026-11-14T10:00:00.000Z',
        completedAt: null,
        hasFailure: false,
      })),
    });
    const r = await handleMetaLifecycle(
      { method: 'GET', route: 'deletion-status', contentType: '', rawBody: '', query: { code: CODE } },
      deps,
    );
    expect((r.body as DeletionStatus).status).toBe('no_data');
  });

  it('refuse POST sur la route de suivi', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(
      { method: 'POST', route: 'deletion-status', contentType: '', rawBody: '', query: { code: CODE } },
      deps,
    );
    expect(r.status).toBe(405);
  });

  it('remonte une erreur d’accès base sans faire croire à une absence', async () => {
    const deps = depsEspionnes({
      readDeletionStatus: vi.fn(async () => { throw new Error('base indisponible'); }),
    });
    // Le handler ne doit pas transformer une panne en 404 : la personne
    // conclurait que sa demande n'existe pas.
    await expect(handleMetaLifecycle(
      { method: 'GET', route: 'deletion-status', contentType: '', rawBody: '', query: { code: CODE } },
      deps,
    )).rejects.toThrow('base indisponible');
  });
});

/* ------------------------------------------------------------------------- */
/* 6. deauthorize ne touche que Facebook / Instagram / Messenger              */
/* ------------------------------------------------------------------------- */
describe('deauthorize — périmètre des produits', () => {
  it('appelle la révocation, pas la suppression de données', async () => {
    const deps = depsEspionnes();
    const r = await handleMetaLifecycle(await rappel('deauthorize'), deps);
    expect(r.status).toBe(200);
    expect(deps.revokeUserConnections).toHaveBeenCalledWith('218471000222');
    // Une déautorisation n'efface PAS les contenus : ce serait excessif, et cela
    // ferait perdre les messages d'une conversation en cours.
    expect(deps.deleteUserData).not.toHaveBeenCalled();
  });

  it('la révocation est bien restreinte aux produits non-WhatsApp', async () => {
    /*
     * Vérification statique du SQL : le contrat « ne pas couper WhatsApp » vit
     * dans la migration, pas dans le handler. Sans cette garde, un futur
     * remaniement du SQL pourrait supprimer la clause sans qu'aucun test JS ne
     * bronche.
     */
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('supabase/migrations/20261126100000_meta_lifecycle_callbacks.sql', 'utf8');
    const corpsFonction = sql.slice(
      sql.indexOf('function saas_business.meta_revoke_user_connections'),
      sql.indexOf('function saas_business.meta_delete_user_data'),
    );
    expect(corpsFonction).toContain("in ('facebook', 'messenger', 'instagram')");
    // WhatsApp ne doit apparaître dans AUCUNE clause de suppression de cette
    // fonction — ni en filtre positif, ni comme produit ciblé.
    const suppressions = corpsFonction.split('\n').filter((l) => /^\s*delete\s+from/i.test(l));
    expect(suppressions.length).toBeGreaterThan(0);
    expect(corpsFonction).not.toMatch(/product\s*=\s*'whatsapp'/);
  });

  it('la suppression de données, elle, n’exclut aucun produit', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('supabase/migrations/20261126100000_meta_lifecycle_callbacks.sql', 'utf8');
    const corpsFonction = sql.slice(
      sql.indexOf('function saas_business.meta_delete_user_data'),
      sql.indexOf('function saas_business.meta_deletion_status'),
    );
    // Une demande de suppression doit tout effacer, WhatsApp compris.
    expect(corpsFonction).not.toMatch(/product\s*in\s*\(\s*'facebook'/);
    expect(corpsFonction).toContain('delete from saas_business.meta_connections');
    expect(corpsFonction).toContain('delete from saas_business.meta_messages');
    expect(corpsFonction).toContain('delete from vault.secrets');
  });

  it('la suppression ne se rattache jamais au workspace', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('supabase/migrations/20261126100000_meta_lifecycle_callbacks.sql', 'utf8');
    const corpsFonction = sql.slice(
      sql.indexOf('function saas_business.meta_delete_user_data'),
      sql.indexOf('function saas_business.meta_deletion_status'),
    );
    // `workspace_id` peut réunir plusieurs clients : l'utiliser comme critère
    // de suppression détruirait les données d'un tiers.
    const instructionsDelete = corpsFonction
      .split(';')
      .filter((bloc) => /delete\s+from/i.test(bloc));
    for (const bloc of instructionsDelete) {
      expect(bloc, `suppression rattachée au workspace : ${bloc.slice(0, 120)}`).not.toMatch(/workspace_id\s*=/);
    }
  });

  it('la suppression et l’enregistrement sont dans la même fonction (atomicité)', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('supabase/migrations/20261126100000_meta_lifecycle_callbacks.sql', 'utf8');
    const corpsFonction = sql.slice(
      sql.indexOf('function saas_business.meta_delete_user_data'),
      sql.indexOf('function saas_business.meta_deletion_status'),
    );
    // Un échec de l'enregistrement doit annuler la suppression, sinon on peut
    // détruire des données sans pouvoir prouver l'état de la demande.
    expect(corpsFonction).toContain('insert into saas_business.meta_deletion_requests');
    expect(corpsFonction).toContain('delete from saas_business.meta_connections');
  });
});
