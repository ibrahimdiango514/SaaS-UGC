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

describe('dataDeletionResponse — le contrat exact de Meta', () => {
  const CODE = 'vyora-0123456789abcdef0123456789abcdef';

  it('renvoie EXACTEMENT url et confirmation_code', () => {
    const r = dataDeletionResponse('https://vyora-saas-ugc.netlify.app', CODE);
    // Meta exige ces deux clés, et rien d'autre : un champ supplémentaire
    // n'apporte rien et un champ manquant fait échouer le rappel.
    expect(Object.keys(r).sort()).toEqual(['confirmation_code', 'url']);
    expect(r.confirmation_code).toBe(CODE);
  });

  it('reporte le code enregistré, sans le recalculer', () => {
    // Le pire défaut possible : renvoyer un code différent de celui stocké, ce
    // qui ferait afficher « demande inconnue » à la personne dont on vient de
    // supprimer les données.
    const autre = 'vyora-fedcba9876543210fedcba9876543210';
    expect(dataDeletionResponse('https://x.test', autre).confirmation_code).toBe(autre);
  });

  it('pointe vers une page de suivi qui transporte le code', () => {
    const r = dataDeletionResponse('https://x.test', CODE);
    const url = new URL(r.url);
    expect(url.pathname).toBe('/confidentialite/suivi');
    expect(url.searchParams.get('code')).toBe(CODE);
  });

  it('ne met ni jeton ni identifiant Meta complet dans l’URL', () => {
    const r = dataDeletionResponse('https://x.test', CODE);
    // Le préfixe garde 6 caractères pour le support, jamais l'ASID entier.
    expect(r.url).not.toMatch(/Bearer|access_token/);
    expect(r.url.split('?')[0]).not.toContain(CODE.replace('vyora-', ''));
  });

  it('encode un code contenant des caractères réservés', () => {
    // Défense en profondeur : même si le format changeait, l'URL resterait valide.
    const r = dataDeletionResponse('https://x.test', 'a b&c=d');
    expect(new URL(r.url).searchParams.get('code')).toBe('a b&c=d');
  });

  it('supporte une URL d’application avec barre oblique finale', () => {
    const r = dataDeletionResponse('https://x.test/', CODE);
    expect(r.url.startsWith('https://x.test/confidentialite/suivi')).toBe(true);
  });
});

/**
 * Garde : la page de suivi doit rester PUBLIQUE et ROUTÉE.
 *
 * Meta exige une URL consultable sans authentification. Si quelqu'un déplaçait
 * cette route sous `<ProtectedRoute>`, la page deviendrait inaccessible à la
 * personne qui arrive depuis Facebook — sans aucun signal, puisque le code
 * compilerait toujours. Ce test relie la route du code à sa déclaration.
 */
describe('page de suivi — publique et routée', () => {
  it('la route correspond exactement à celle produite par dataDeletionResponse', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync('src/App.tsx', 'utf8');
    const chemin = new URL(dataDeletionResponse('https://x.test', 'c').url).pathname;
    expect(app).toContain(`path="${chemin}"`);
  });

  it('elle est déclarée AVANT le bloc protégé', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync('src/App.tsx', 'utf8');
    const indexRoute = app.indexOf('path="/confidentialite/suivi"');
    const indexProtege = app.indexOf('<ProtectedRoute />');
    expect(indexRoute).toBeGreaterThan(-1);
    // Une route déclarée sous <ProtectedRoute /> exigerait une session.
    expect(indexRoute).toBeLessThan(indexProtege);
  });

  it('la page légale renvoie vers le suivi', async () => {
    const { readFileSync } = await import('node:fs');
    const legal = readFileSync('src/pages/Legal.tsx', 'utf8');
    expect(legal).toContain('page de suivi');
    // L'ancre historique reste valide : les liens déjà publiés ne cassent pas.
    expect(legal).toContain("id: 'suppression-des-donnees'");
  });
});
