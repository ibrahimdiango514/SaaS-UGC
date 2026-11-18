/**
 * Origines autorisées des Edge Functions de l'import.
 *
 * ## Le défaut que ces tests empêchent de revenir
 * `store-connect` construisait sa liste uniquement depuis une variable
 * d'environnement, vide en production : toutes les requêtes du navigateur
 * recevaient `access-control-allow-origin: null`, donc étaient bloquées. Le
 * connecteur répondait correctement à `curl`, et échouait dans l'application.
 *
 * `store-import`, de son côté, comparait les motifs par `startsWith` /
 * `endsWith` : `https://deploy-preview-*--saas-ugc-growth.netlify.app`
 * correspondait à `https://deploy-preview-X--saas-ugc-growth.netlify.app.evil.co`
 * (le suffixe est bien présent). Une origine hostile pouvait donc se faire
 * passer pour une prévisualisation.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_ORIGINS, buildAllowedOrigins, matchesOrigin, resolveCorsOrigin,
} from '../src/lib/origin-allowlist';

describe('liste d’origines', () => {
  it('n’est jamais vide : une liste vide bloquait tout le navigateur', () => {
    expect(DEFAULT_ALLOWED_ORIGINS.length).toBeGreaterThan(5);
    expect(buildAllowedOrigins(undefined)).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
    expect(buildAllowedOrigins('')).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
  });

  it('ajoute les origines configurées sans doublon', () => {
    const liste = buildAllowedOrigins('https://exemple.test, https://exemple.test ,https://autre.test');
    expect(liste).toContain('https://exemple.test');
    expect(liste).toContain('https://autre.test');
    expect(liste.filter((o) => o === 'https://exemple.test')).toHaveLength(1);
    // Les valeurs par défaut restent présentes : ajouter ne remplace pas.
    expect(liste).toContain('https://vyora-ugc.netlify.app');
  });

  it('ignore les entrées vides ou en blanc', () => {
    const liste = buildAllowedOrigins(' , ,https://x.test, ');
    expect(liste).toContain('https://x.test');
    expect(liste).not.toContain('');
  });
});

describe('correspondance des motifs', () => {
  it('accepte une origine identique', () => {
    expect(matchesOrigin('https://vyora-ugc.netlify.app', 'https://vyora-ugc.netlify.app')).toBe(true);
  });

  it('refuse une origine différente sans joker', () => {
    expect(matchesOrigin('https://vyora-ugc.netlify.app', 'https://vyora-ugc.netlify.app.evil.test')).toBe(false);
    expect(matchesOrigin('https://vyora-ugc.netlify.app', 'https://evil.test')).toBe(false);
  });

  it('accepte une prévisualisation Netlify numérotée', () => {
    expect(matchesOrigin(
      'https://deploy-preview-*--saas-ugc-growth.netlify.app',
      'https://deploy-preview-42--saas-ugc-growth.netlify.app',
    )).toBe(true);
  });

  it('refuse une origine qui ne fait que PROLONGER le motif', () => {
    // Le défaut corrigé : `endsWith` acceptait cette origine hostile.
    expect(matchesOrigin(
      'https://deploy-preview-*--saas-ugc-growth.netlify.app',
      'https://deploy-preview-42--saas-ugc-growth.netlify.app.evil.test',
    )).toBe(false);
    expect(matchesOrigin('https://*.e2b.app', 'https://x.e2b.app.evil.test')).toBe(false);
  });

  it('refuse un joker vide', () => {
    // `https://*.e2b.app` ne doit pas correspondre à `https://.e2b.app`.
    expect(matchesOrigin('https://*.e2b.app', 'https://.e2b.app')).toBe(false);
    expect(matchesOrigin('https://*.e2b.app', 'https://abc.e2b.app')).toBe(true);
  });

  it('refuse le vide et le casse invalide', () => {
    expect(matchesOrigin('', 'https://x.test')).toBe(false);
    expect(matchesOrigin('https://x.test', '')).toBe(false);
  });

  it('ne laisse pas un caractère de motif devenir une expression', () => {
    // `.` doit être littéral : `https://aXtest` ne correspond pas à `a.test`.
    expect(matchesOrigin('https://a.test', 'https://aXtest')).toBe(false);
  });
});

describe('origine renvoyée dans l’en-tête CORS', () => {
  it('renvoie l’origine exacte quand elle est autorisée', () => {
    expect(resolveCorsOrigin(DEFAULT_ALLOWED_ORIGINS, 'https://vyora-ugc.netlify.app'))
      .toBe('https://vyora-ugc.netlify.app');
    expect(resolveCorsOrigin(DEFAULT_ALLOWED_ORIGINS, 'https://deploy-preview-7--saas-ugc-growth.netlify.app'))
      .toBe('https://deploy-preview-7--saas-ugc-growth.netlify.app');
    expect(resolveCorsOrigin(DEFAULT_ALLOWED_ORIGINS, 'https://5173-abc.e2b.app'))
      .toBe('https://5173-abc.e2b.app');
  });

  it('renvoie `null` — jamais `*` — pour une origine inconnue', () => {
    // `*` laisserait toute page lire la réponse ; `null` bloque le navigateur.
    expect(resolveCorsOrigin(DEFAULT_ALLOWED_ORIGINS, 'https://vyora.pages.dev')).toBe('https://vyora.pages.dev');
    expect(resolveCorsOrigin(DEFAULT_ALLOWED_ORIGINS, 'https://preview-main.vyora.pages.dev'))
      .toBe('https://preview-main.vyora.pages.dev');
    expect(resolveCorsOrigin(DEFAULT_ALLOWED_ORIGINS, 'https://autre.pages.dev')).toBe('null');
    expect(resolveCorsOrigin(DEFAULT_ALLOWED_ORIGINS, 'https://evil.test')).toBe('null');
    expect(resolveCorsOrigin(DEFAULT_ALLOWED_ORIGINS, null)).toBe('null');
    expect(resolveCorsOrigin([], 'https://vyora-ugc.netlify.app')).toBe('null');
  });
});
