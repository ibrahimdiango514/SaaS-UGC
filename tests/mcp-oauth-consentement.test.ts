// @vitest-environment node
/**
 * Consentement OAuth — session, anti-rejeu, page HTML et primitives.
 *
 * Ces tests portent sur la partie que le client MCP ne voit jamais mais qui
 * décide de tout : qui consent, pour quel client, et si la page peut être
 * détournée. On y vérifie notamment que rien d'utilisateur ne s'échappe vers
 * une adresse choisie par l'attaquant.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  deriverJetonAntiRejeu,
  echapperHtml,
  extraireJetonSession,
  lireCookies,
  rendrePageConsentement,
  rendrePageErreur,
  verifierAntiRejeu,
} from '../supabase/functions/vyora-mcp/consentement.ts';
import { sha256Hex, tempsConstant } from '../supabase/functions/vyora-mcp/oauth.ts';

/** JWT factice : seule la forme compte, aucune signature n'est vérifiée ici. */
const JWT = 'aaa.bbb.ccc';

describe('lecture des cookies', () => {
  it('découpe les paires et ignore les morceaux vides', () => {
    expect(lireCookies('a=1; b=2;vide=; ;c')).toEqual({ a: '1', b: '2', vide: '' });
    expect(lireCookies(null)).toEqual({});
    expect(lireCookies('')).toEqual({});
  });

  it('retire les guillemets', () => {
    expect(lireCookies('sb-x-auth-token="valeur"')).toEqual({ 'sb-x-auth-token': 'valeur' });
  });

  it('garde la première occurrence d’un nom', () => {
    // Sinon, un en-tête ajouté par un intermédiaire pourrait vider la session.
    expect(lireCookies('a=bon; a=')).toEqual({ a: 'bon' });
  });
});

describe('extraction du jeton de session', () => {
  it('lit un cookie JSON brut', () => {
    const cookies = { 'sb-abc-auth-token': JSON.stringify({ access_token: JWT }) };
    expect(extraireJetonSession(cookies)).toBe(JWT);
  });

  it('lit un cookie encodé en base64', () => {
    const charge = Buffer.from(JSON.stringify({ access_token: JWT }), 'utf8').toString('base64');
    expect(extraireJetonSession({ 'sb-abc-auth-token': `base64-${charge}` })).toBe(JWT);
  });

  it('recolle un cookie découpé en morceaux', () => {
    const json = JSON.stringify({ access_token: JWT });
    const moitie = Math.floor(json.length / 2);
    expect(extraireJetonSession({
      'sb-abc-auth-token.1': json.slice(moitie),
      'sb-abc-auth-token.0': json.slice(0, moitie),
    })).toBe(JWT);
  });

  it('refuse l’absence de session et le JSON invalide', () => {
    expect(extraireJetonSession({})).toBeNull();
    expect(extraireJetonSession({ 'sb-abc-auth-token': '{pas du json' })).toBeNull();
    expect(extraireJetonSession({ 'sb-abc-auth-token': 'base64-@@@' })).toBeNull();
  });

  it('refuse un jeton qui n’a pas la forme d’un JWT', () => {
    // Un cookie forgé ne doit pas déclencher d'appel réseau.
    expect(extraireJetonSession({ 'sb-abc-auth-token': JSON.stringify({ access_token: 'court' }) })).toBeNull();
    expect(extraireJetonSession({ 'sb-abc-auth-token': JSON.stringify({}) })).toBeNull();
  });
});

describe('jeton anti-rejeu', () => {
  it('est déterministe pour une même session', () => {
    expect(deriverJetonAntiRejeu(JWT)).toBe(deriverJetonAntiRejeu(JWT));
    expect(deriverJetonAntiRejeu(JWT)).toHaveLength(64);
  });

  it('diffère d’une session à l’autre', () => {
    expect(deriverJetonAntiRejeu('aaa.bbb.ccc')).not.toBe(deriverJetonAntiRejeu('xxx.yyy.zzz'));
  });

  it('ne laisse pas deviner la session', () => {
    expect(deriverJetonAntiRejeu(JWT)).not.toContain(JWT.split('.')[0]);
  });

  it('refuse une valeur absente, vide ou différente', () => {
    const attendu = deriverJetonAntiRejeu(JWT);
    expect(verifierAntiRejeu(attendu, attendu)).toBe(true);
    expect(verifierAntiRejeu(attendu, null)).toBe(false);
    expect(verifierAntiRejeu(null, attendu)).toBe(false);
    expect(verifierAntiRejeu(attendu, '')).toBe(false);
    expect(verifierAntiRejeu(attendu, `${attendu.slice(0, -1)}x`)).toBe(false);
    expect(verifierAntiRejeu(attendu, attendu.slice(0, 32))).toBe(false);
  });
});

describe('primitives cryptographiques', () => {
  it('calcule le même SHA-256 que Node, aux bornes de padding', () => {
    for (const t of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(1000)]) {
      expect(sha256Hex(t), `longueur ${t.length}`)
        .toBe(createHash('sha256').update(t, 'utf8').digest('hex'));
    }
  });

  it('gère les caractères non ASCII', () => {
    const t = 'SORAHNEX — éàü 漢字';
    expect(sha256Hex(t)).toBe(createHash('sha256').update(t, 'utf8').digest('hex'));
  });

  it('compare à temps constant sans se tromper', () => {
    expect(tempsConstant('abc', 'abc')).toBe(true);
    expect(tempsConstant('abc', 'abd')).toBe(false);
    expect(tempsConstant('abc', 'ab')).toBe(false);
    expect(tempsConstant('', '')).toBe(true);
  });
});

describe('échappement HTML', () => {
  it('neutralise les cinq caractères dangereux', () => {
    expect(echapperHtml(`<script>alert("x")&'</script>`))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;&lt;/script&gt;');
  });

  it('laisse passer le texte anodin', () => {
    expect(echapperHtml('Claude par Anthropic')).toBe('Claude par Anthropic');
  });
});

describe('page de consentement', () => {
  const vue = {
    clientName: 'Claude',
    scopes: ['read'],
    redirectHost: 'claude.ai',
    csrfToken: 'jeton-anti-rejeu',
    champs: {
      client_id: 'vyora_client_1',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      scope: 'read',
      state: 'state-1',
      code_challenge: 'defi',
      code_challenge_method: 'S256',
      resource: 'https://exemple/functions/v1/vyora-mcp',
      response_type: 'code',
    },
  };

  it('affiche le client, l’hôte et la portée en clair', () => {
    const html = rendrePageConsentement(vue);
    expect(html).toContain('Claude');
    expect(html).toContain('claude.ai');
    expect(html).toContain('Consulter les données de votre compte');
  });

  it('rejoue tous les paramètres validés en champs cachés', () => {
    const html = rendrePageConsentement(vue);
    for (const [nom, valeur] of Object.entries(vue.champs)) {
      expect(html).toContain(`name="${nom}" value="${valeur}"`);
    }
    expect(html).toContain('name="csrf_token" value="jeton-anti-rejeu"');
  });

  it('exige un POST et propose refuser', () => {
    expect(rendrePageConsentement(vue)).toContain('method="post"');
    expect(rendrePageConsentement(vue)).toContain('value="refuser"');
  });

  it('ne charge AUCUNE ressource externe', () => {
    const html = rendrePageConsentement(vue);
    // Ni script, ni image, ni feuille de style distante : rien à exfiltrer.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/https?:\/\/[^"'\s]*\.(css|js|png|svg|woff2?)/i);
    expect(html).toContain('name="referrer" content="no-referrer"');
  });

  it('échappe un nom de client hostile', () => {
    const html = rendrePageConsentement({ ...vue, clientName: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('échappe un hôte hostile', () => {
    const html = rendrePageConsentement({ ...vue, redirectHost: '"><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)');
  });

  it('prévient quand la portée est inconnue', () => {
    const html = rendrePageConsentement({ ...vue, scopes: ['read', 'administrer'] });
    expect(html).toContain('Portée inconnue');
  });

  it('rend aussi une page d’erreur sans redirection', () => {
    const html = rendrePageErreur('Adresse de retour non fiable.');
    expect(html).toContain('Adresse de retour non fiable.');
    expect(html).not.toMatch(/http-equiv="refresh"/i);
  });
});
