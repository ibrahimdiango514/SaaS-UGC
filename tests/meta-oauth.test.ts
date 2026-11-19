import { describe, expect, it } from 'vitest';
import {
  META_STATE_TTL_MS,
  buildLoginForBusinessUrl,
  callbackUri,
  embeddedSignupLaunch,
  expiresAtFrom,
  isWellFormedState,
  randomPin,
  randomState,
  returnUrl,
} from '../src/business/meta/oauth';
import { META_EMBEDDED_SIGNUP_VERSION, META_GRAPH_VERSION } from '../src/business/meta/products';

/**
 * Construction du parcours d'autorisation.
 *
 * Ce que ces tests protègent :
 * - le `state` a une entropie suffisante et une forme exacte : tout ce qui n'est
 *   pas produit par `randomState()` est refusé (pas de « commence par », pas de
 *   longueur approximative) ;
 * - l'URI de redirection est FIXE et HTTPS, dérivée du projet Supabase — jamais
 *   reçue d'un client : c'est la valeur à déclarer dans Meta, au caractère près ;
 * - la configuration (`config_id`) n'est jamais remplacée par un scope libre :
 *   Facebook Login for Business exige la configuration créée dans Meta.
 */

const SUPABASE = 'https://xbuuhfwobrafcbgtdgjx.supabase.co';
const APP = 'https://vyora-saas-ugc.netlify.app';

describe('state — usage unique, entropie réelle', () => {
  it('produit 32 octets en base64url (43 caractères)', () => {
    const state = randomState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedState(state)).toBe(true);
  });

  it('ne produit jamais deux fois la même valeur', () => {
    const valeurs = new Set(Array.from({ length: 200 }, () => randomState()));
    expect(valeurs.size).toBe(200);
  });

  it('refuse tout ce qui n’a pas la forme exacte attendue', () => {
    for (const invalide of [
      '', null, undefined, 42, 'court', 'a'.repeat(39), 'a'.repeat(65),
      'a'.repeat(42) + '=', 'a'.repeat(42) + '+', 'a'.repeat(42) + '/', 'a'.repeat(42) + ' ',
    ]) {
      expect(isWellFormedState(invalide), String(invalide)).toBe(false);
    }
  });

  it('la durée de vie d’un état est de 10 minutes', () => {
    expect(META_STATE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('le PIN WhatsApp a exactement 6 chiffres', () => {
    for (let i = 0; i < 50; i += 1) expect(randomPin()).toMatch(/^\d{6}$/);
  });
});

describe('URI de redirection — fixe et HTTPS', () => {
  it('dérive la même URI du projet Supabase, slash final compris ou non', () => {
    expect(callbackUri(SUPABASE)).toBe('https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-connect/callback');
    expect(callbackUri(`${SUPABASE}/`)).toBe(callbackUri(SUPABASE));
    expect(callbackUri(`${SUPABASE}///`)).toBe(callbackUri(SUPABASE));
  });

  it('ne dépend d’aucune donnée fournie par le navigateur', () => {
    // Aucun paramètre : c'est la signature elle-même qui l'impose.
    expect(callbackUri.length).toBe(1);
    expect(callbackUri(SUPABASE)).toMatch(/^https:\/\//);
  });
});

describe('Login for Business — l’URL suit le contrat Meta', () => {
  const state = randomState();
  const url = new URL(buildLoginForBusinessUrl({
    appId: '1692282959171281',
    product: 'facebook',
    configId: 'CONFIG_FB',
    redirectUri: callbackUri(SUPABASE),
    state,
  }));

  it('cible le dialogue OAuth de la version Graph utilisée', () => {
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe(`/${META_GRAPH_VERSION}/dialog/oauth`);
  });

  it('transmet config_id (et non un scope seul) avec response_type=code', () => {
    expect(url.searchParams.get('config_id')).toBe('CONFIG_FB');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('override_default_response_type')).toBe('true');
  });

  it('transmet le state et l’URI de redirection exacts', () => {
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('redirect_uri')).toBe(callbackUri(SUPABASE));
  });

  it('ne contient aucun secret', () => {
    expect(url.toString()).not.toContain('client_secret');
    expect(url.toString()).not.toContain('app_secret');
  });

  it('déclare les permissions du produit dans scope, sans doublon', () => {
    const scopes = (url.searchParams.get('scope') ?? '').split(',');
    expect(scopes).toContain('pages_show_list');
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});

describe('Embedded Signup — paramètres publics seulement', () => {
  it('rend l’App ID, la configuration et le state, jamais un secret', () => {
    const lancement = embeddedSignupLaunch({ appId: '1692282959171281', configId: 'CONFIG_WA', state: randomState() });
    expect(lancement.mode).toBe('embedded-signup');
    expect(lancement.appId).toBe('1692282959171281');
    expect(lancement.configId).toBe('CONFIG_WA');
    expect(lancement.graphVersion).toBe(META_GRAPH_VERSION);
    // Sans `version` explicite, Meta sert la version par défaut (v4 aujourd'hui).
    expect(lancement.embeddedSignupVersion).toBe(META_EMBEDDED_SIGNUP_VERSION);
    expect(lancement.embeddedSignupVersion).toMatch(/^v[45](-public-preview)?$/);
    expect(lancement.scopes).toEqual(['whatsapp_business_management', 'whatsapp_business_messaging']);
    expect(JSON.stringify(lancement)).not.toMatch(/secret/i);
  });
});

describe('retour dans le SaaS', () => {
  it('renvoie sur l’écran Intégrations avec le produit concerné', () => {
    const succes = new URL(returnUrl(APP, { product: 'whatsapp', ok: true }));
    expect(succes.origin + succes.pathname).toBe(`${APP}/app/business`);
    expect(succes.searchParams.get('section')).toBe('integrations');
    expect(succes.searchParams.get('meta')).toBe('connected');
    expect(succes.searchParams.get('product')).toBe('whatsapp');
    // Aucun jeton, aucun code d'autorisation dans l'URL de retour.
    expect(succes.searchParams.get('code')).toBeNull();
  });

  it('expose un code d’erreur court et expurgé, jamais Meta brut', () => {
    const echec = new URL(returnUrl(APP, { product: 'facebook', ok: false, code: 'STATE_INVALID' }));
    expect(echec.searchParams.get('meta')).toBe('error');
    expect(echec.searchParams.get('code')).toBe('STATE_INVALID');
    const long = new URL(returnUrl(APP, { product: 'facebook', ok: false, code: 'x'.repeat(300) }));
    expect((long.searchParams.get('code') ?? '').length).toBe(64);
  });

  it('tolère un slash final sur l’URL de l’application', () => {
    expect(returnUrl(`${APP}/`, { product: 'messenger', ok: true }))
      .toBe(returnUrl(APP, { product: 'messenger', ok: true }));
  });
});

describe('expiration des jetons', () => {
  it('convertit expires_in en date absolue', () => {
    const maintenant = new Date('2026-11-14T10:00:00Z');
    // 60 jours exactement (5184000 s) : 14 novembre → 13 janvier.
    expect(expiresAtFrom(5184000, maintenant)?.toISOString()).toBe('2027-01-13T10:00:00.000Z');
  });

  it('rend null pour un jeton sans expiration (jeton système WhatsApp)', () => {
    expect(expiresAtFrom(undefined)).toBeNull();
    expect(expiresAtFrom(0)).toBeNull();
    expect(expiresAtFrom(-5)).toBeNull();
    expect(expiresAtFrom(Number.NaN)).toBeNull();
  });
});
