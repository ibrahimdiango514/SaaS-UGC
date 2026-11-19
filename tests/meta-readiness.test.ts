import { describe, expect, it, vi } from 'vitest';
import {
  BASE,
  ORIGINES_ATTENDUES,
  PROJECT_REF,
  requeteCallback,
  requeteStatusSansJwt,
  requeteWebhookFauxJeton,
  sonder,
} from '../scripts/meta-readiness.mjs';

/**
 * Sonde de mise en service.
 *
 * Ce script est le seul outil que le titulaire du compte lancera entre deux
 * étapes de configuration. Deux défauts seraient graves :
 *   1. annoncer un succès alors que la fonction n'est pas déployée ;
 *   2. annoncer un échec alors que le réseau du poste est en cause.
 * Les tests ci-dessous verrouillent ces deux comportements, sans réseau.
 */

const reponse = (statut: number, corps: string, entetes: Record<string, string> = {}) =>
  new Response(corps, { status: statut, headers: entetes });

describe('URL sondées — dérivées de l’architecture, jamais devinées', () => {
  it('cible le projet Supabase de production et le chemin /callback', () => {
    expect(PROJECT_REF).toBe('xbuuhfwobrafcbgtdgjx');
    expect(BASE).toBe('https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1');
    const { url } = requeteCallback(ORIGINES_ATTENDUES[0]);
    expect(url).toBe(
      'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-connect/callback?state=state-de-sonde-invalide&code=code-de-sonde',
    );
  });

  it('la poignée de main utilise un jeton FAUX : elle ne doit jamais réussir', () => {
    expect(requeteWebhookFauxJeton()).toContain('hub.verify_token=sonde-jeton-faux');
  });

  it('la requête sans JWT porte une entreprise nulle, pour ne rien toucher', () => {
    const { corps, methode } = requeteStatusSansJwt();
    expect(methode).toBe('POST');
    expect(JSON.parse(corps).workspaceId).toBe('00000000-0000-0000-0000-000000000000');
  });
});

describe('jugement des réponses', () => {
  it('une fonction absente (404) est signalée comme non déployée', async () => {
    const fetchImpl = vi.fn(async () => reponse(404, 'not found'));
    const { rapport, reseauIndisponible } = await sonder({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(reseauIndisponible).toBe(false);
    expect(rapport.every((l) => l.ok === false)).toBe(true);
    expect(rapport[0].detail).toMatch(/pas déployée/);
    expect(rapport[1].detail).toMatch(/pas déployée/);
  });

  it('un 401 UNAUTHENTICATED prouve que le handler tourne et exige un JWT', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/callback')) {
        return reponse(303, '', {
          location: 'https://vyora-saas-ugc.netlify.app/app/business?section=integrations&meta=error&product=facebook&code=STATE_INVALID',
        });
      }
      if (url.includes('/meta-webhook')) return reponse(403, 'vérification refusée (TOKEN_MISMATCH)');
      return reponse(401, JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }));
    });
    const { rapport } = await sonder({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rapport.map((l) => l.ok)).toEqual([true, true, true]);
  });

  it('un 200 sur /callback est un ÉCHEC : le contrôle de state aurait dû refuser', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/callback')) return reponse(200, 'ok');
      if (url.includes('/meta-webhook')) return reponse(403, 'vérification refusée (TOKEN_MISMATCH)');
      return reponse(401, JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }));
    });
    const { rapport } = await sonder({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rapport[1].ok).toBe(false);
  });

  it('un webhook qui accepte un jeton faux est un ÉCHEC grave', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/callback')) {
        return reponse(303, '', { location: 'https://x.test/app/business?meta=error&code=STATE_INVALID' });
      }
      if (url.includes('/meta-webhook')) return reponse(200, '12345');
      return reponse(401, JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }));
    });
    const { rapport } = await sonder({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rapport[2].ok).toBe(false);
  });

  it('un Verify Token absent côté serveur (503 TOKEN_NOT_CONFIGURED) reste un échec attendu', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/callback')) {
        return reponse(303, '', { location: 'https://x.test/app/business?meta=error&code=STATE_INVALID' });
      }
      if (url.includes('/meta-webhook')) return reponse(503, 'webhook non configuré (TOKEN_NOT_CONFIGURED)');
      return reponse(401, JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }));
    });
    const { rapport } = await sonder({ fetchImpl: fetchImpl as unknown as typeof fetch });
    // 503 est reconnu (la fonction existe) mais le motif indique qu'il manque un secret.
    expect(rapport[2].ok).toBe(true);
    expect(rapport[2].detail).toMatch(/TOKEN_NOT_CONFIGURED/);
  });

  it('le vrai Verify Token rend le challenge quand il correspond', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('hub.verify_token=attendu')) return reponse(200, '97531');
      if (url.includes('/callback')) {
        return reponse(303, '', { location: 'https://x.test/app/business?meta=error&code=STATE_INVALID' });
      }
      if (url.includes('/meta-webhook')) return reponse(403, 'vérification refusée (TOKEN_MISMATCH)');
      return reponse(401, JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }));
    });
    const { rapport } = await sonder({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webhookToken: 'attendu',
    });
    const ligne = rapport.find((l) => l.label.includes('Verify Token réel'));
    expect(ligne?.ok).toBe(true);
  });

  it('une panne réseau n’est jamais présentée comme un échec de déploiement', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { rapport, reseauIndisponible } = await sonder({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(reseauIndisponible).toBe(true);
    expect(rapport.every((l) => l.ok === false)).toBe(true);
  });

  it('le rapport ne contient jamais de secret', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/callback')) {
        return reponse(303, '', { location: 'https://x.test/app/business?meta=error&code=STATE_INVALID' });
      }
      if (url.includes('/meta-webhook')) return reponse(403, 'vérification refusée (TOKEN_MISMATCH)');
      return reponse(401, JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }));
    });
    const { rapport } = await sonder({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webhookToken: 'jeton-tres-secret',
    });
    const serialise = JSON.stringify(rapport);
    expect(serialise).not.toContain('jeton-tres-secret');
    expect(serialise).not.toMatch(/EAA[A-Za-z0-9]{8,}/);
  });
});
