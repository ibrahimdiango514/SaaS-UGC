import { describe, expect, it } from 'vitest';
import { dataDeletionResponse, parseSignedRequest } from '../src/business/meta/deauthorize.ts';

/**
 * Rappels de cycle de vie signés par Meta.
 *
 * ## Ce que ces tests protègent
 * Ces rappels arrivent sur une URL publique, sans JWT. Si la signature n'était
 * pas vérifiée, n'importe qui pourrait poster `{ user_id: <victime> }` et faire
 * supprimer les données d'un client — un déni de service ciblé, et une perte de
 * données irréversible.
 *
 * Le test le plus important est donc celui qui REFUSE une signature fabriquée,
 * pas celui qui accepte une signature valide.
 */

const SECRET = 'APP_SECRET_DE_TEST_NE_DOIT_PAS_FUIRER';

/** Encode en base64url, comme Meta. */
function b64url(octets: Uint8Array): string {
  let binaire = '';
  for (const o of octets) binaire += String.fromCharCode(o);
  return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Fabrique un signed_request comme Meta le fait. */
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

describe('parseSignedRequest — la signature décide', () => {
  it('accepte un signed_request légitime', async () => {
    const brut = await signer({ algorithm: 'HMAC-SHA256', issued_at: 1700000000, user_id: '218471' });
    const r = await parseSignedRequest(brut, SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userId).toBe('218471');
      expect(r.issuedAt).toBe(1700000000);
    }
  });

  it('REFUSE une signature fabriquée avec un autre secret', async () => {
    // Le cœur du module : un tiers qui connaît l'identifiant d'un client ne
    // peut pas déclencher de suppression.
    const brut = await signer({ algorithm: 'HMAC-SHA256', user_id: '218471' }, 'MAUVAIS_SECRET');
    const r = await parseSignedRequest(brut, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SIGNATURE_INVALID');
  });

  it('REFUSE un payload modifié après signature', async () => {
    /*
     * Attaque classique : intercepter un signed_request valide et remplacer le
     * user_id. La signature porte sur le payload encodé, donc toute altération
     * la casse.
     */
    const brut = await signer({ algorithm: 'HMAC-SHA256', user_id: '218471' });
    const [, payload] = brut.split('.');
    const falsifie = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    falsifie.user_id = '999999';
    const nouveauPayload = b64url(new TextEncoder().encode(JSON.stringify(falsifie)));
    const attaque = `${brut.split('.')[0]}.${nouveauPayload}`;
    const r = await parseSignedRequest(attaque, SECRET);
    expect(r.ok).toBe(false);
  });

  it('REFUSE sans secret configuré — jamais de validation « par défaut »', async () => {
    const brut = await signer({ algorithm: 'HMAC-SHA256', user_id: '218471' });
    expect((await parseSignedRequest(brut, '')).ok).toBe(false);
  });

  it('REFUSE les formes malformées', async () => {
    for (const mauvais of ['', 'pasdepoint', '.', 'abc.', '.abc', null, undefined]) {
      const r = await parseSignedRequest(mauvais as string | null | undefined, SECRET);
      expect(r.ok, String(mauvais)).toBe(false);
    }
  });

  it('REFUSE un algorithme non pris en charge', async () => {
    const brut = await signer({ algorithm: 'RSA-SHA256', user_id: '218471' });
    const r = await parseSignedRequest(brut, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ALGORITHM_UNSUPPORTED');
  });

  it('REFUSE un payload sans identifiant utilisateur', async () => {
    const brut = await signer({ algorithm: 'HMAC-SHA256', issued_at: 1700000000 });
    const r = await parseSignedRequest(brut, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NO_USER');
  });

  it('ne renvoie jamais le secret ni la signature dans son résultat', async () => {
    const brut = await signer({ algorithm: 'HMAC-SHA256', user_id: '218471' });
    const r = await parseSignedRequest(brut, SECRET);
    const texte = JSON.stringify(r);
    expect(texte).not.toContain(SECRET);
    expect(texte).not.toContain(brut.split('.')[0]);
  });
});

describe('dataDeletionResponse — la forme exigée par Meta', () => {
  it('renvoie les deux champs obligatoires', () => {
    const r = dataDeletionResponse('https://vyora-saas-ugc.netlify.app', '218471000222', new Date(1700000000000));
    // Meta exige exactement `url` et `confirmation_code`.
    expect(Object.keys(r).sort()).toEqual(['confirmation_code', 'url']);
    expect(r.url).toBe('https://vyora-saas-ugc.netlify.app/confidentialite#suppression-des-donnees');
    expect(r.confirmation_code).toMatch(/^vyora-/);
  });

  it('produit un code différent selon l’utilisateur et l’instant', () => {
    const a = dataDeletionResponse('https://x.test', '218471000222', new Date(1700000000000));
    const b = dataDeletionResponse('https://x.test', '218471000333', new Date(1700000000000));
    const c = dataDeletionResponse('https://x.test', '218471000222', new Date(1700000009999));
    expect(a.confirmation_code).not.toBe(b.confirmation_code);
    expect(a.confirmation_code).not.toBe(c.confirmation_code);
  });

  it('ne met jamais le jeton ni l’identifiant complet dans l’URL', () => {
    const r = dataDeletionResponse('https://x.test', '218471000222', new Date(1700000000000));
    expect(r.url).not.toContain('218471000222');
  });
});

/**
 * Garde : l'URL renvoyée à Meta doit mener à une page réelle qui explique la
 * procédure de suppression.
 *
 * Meta exige que la réponse contienne « une URL où la personne peut suivre
 * l'état de sa demande » et une « explication lisible ». Si l'ancre disparaît de
 * la page légale, la réponse pointerait vers une page qui ne dit rien de la
 * suppression — un lien mort, et un manquement aux Platform Terms. Ce test relie
 * les deux fichiers pour qu'ils ne puissent pas diverger en silence.
 */
describe('dataDeletionResponse — le lien mène à une page réelle', () => {
  it('l’ancre de suivi existe dans la page légale', async () => {
    const { readFileSync } = await import('node:fs');
    const page = readFileSync('src/pages/Legal.tsx', 'utf8');
    const reponse = dataDeletionResponse('https://vyora.test', '218471', new Date(1700000000000));
    const ancre = reponse.url.split('#')[1];
    expect(ancre).toBeTruthy();
    expect(page, `ancre #${ancre} absente de src/pages/Legal.tsx`).toContain(`id: '${ancre}'`);
  });

  it('la page est bien routée sur /confidentialite', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync('src/App.tsx', 'utf8');
    const chemin = new URL(dataDeletionResponse('https://vyora.test', '218471', new Date(0)).url).pathname;
    expect(app).toContain(`path="${chemin}"`);
  });
});
