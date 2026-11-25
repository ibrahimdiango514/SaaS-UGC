import { describe, expect, it } from 'vitest';
// @ts-expect-error — script Node sans déclaration de types, importé pour ses fonctions pures.
import { classer, estEchec, rediger, sondes } from '../scripts/verify-authenticated.mjs';

/**
 * Harnais de vérification authentifiée (`scripts/verify-authenticated.mjs`).
 *
 * Ces tests ne touchent PAS le réseau : ils vérifient la logique qui décide si
 * une réponse réelle prouve quelque chose, et la rédaction des journaux. Le
 * déroulé réseau lui-même est exécuté par un runner GitHub, seul à avoir l'accès.
 */

describe('Rédaction des journaux — aucun secret ne doit sortir', () => {
  it('masque un JWT complet', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF1234567890_signature';
    const sortie = rediger(`réponse ${jwt} fin`);
    expect(sortie).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(sortie).toContain('<jeton-masqué>');
  });

  it('masque les clés Supabase, publiables comme secrètes', () => {
    expect(rediger('clé sb_publishable_utbZhw8dg-2M1-g0nXIhfA_n6dZCDZz')).toContain('<clé-masquée>');
    expect(rediger('clé sb_secret_neDoitJamaisSortir')).toContain('<clé-masquée>');
    expect(rediger('clé sb_secret_neDoitJamaisSortir')).not.toContain('neDoitJamaisSortir');
  });

  it('masque access_token, refresh_token et password dans un corps JSON', () => {
    const corps = '{"access_token":"valeur-sensible","refresh_token":"autre-valeur","password":"mot-de-passe"}';
    const sortie = rediger(corps);
    expect(sortie).not.toContain('valeur-sensible');
    expect(sortie).not.toContain('autre-valeur');
    expect(sortie).not.toContain('mot-de-passe');
    expect(sortie).toContain('<masqué>');
  });

  it('tronque les réponses longues pour rester lisible', () => {
    expect(rediger('x'.repeat(5000)).length).toBeLessThanOrEqual(240);
  });

  it('tolère null et undefined sans lever', () => {
    expect(rediger(null)).toBe('');
    expect(rediger(undefined)).toBe('');
  });
});

describe('Classement des réponses — ce qui prouve que le handler a tourné', () => {
  it('une 2xx est un succès', () => {
    expect(classer(200, { records: [] })).toBe('OK');
    expect(estEchec('OK')).toBe(false);
  });

  it('un refus métier structuré (4xx) prouve que le handler a tourné : pas un échec', () => {
    expect(classer(400, { error: { code: 'UNKNOWN_ACTION' } })).toBe('REFUS MÉTIER');
    expect(estEchec('REFUS MÉTIER')).toBe(false);
    expect(classer(404, { error: { code: 'MODULE_RECORD_NOT_FOUND' } })).toBe('REFUS MÉTIER');
  });

  it('une session refusée est un échec : le but du test est précisément d’être connecté', () => {
    expect(classer(401, { error: { code: 'UNAUTHENTICATED' } })).toBe('SESSION REFUSÉE');
    expect(estEchec('SESSION REFUSÉE')).toBe(true);
    expect(classer(403, {})).toBe('SESSION REFUSÉE');
  });

  it('un artefact non chargeable est un échec, quel que soit le code HTTP', () => {
    expect(classer(503, { error: { code: 'BUSINESS_GROW_ARTIFACT_UNAVAILABLE' } })).toBe('ARTEFACT');
    expect(classer(200, { error: { code: 'STORE_IMPORT_ARTIFACT_UNAVAILABLE' } })).toBe('ARTEFACT');
    expect(estEchec('ARTEFACT')).toBe(true);
  });

  it('une 5xx est une panne, et une absence de réponse ne prouve rien', () => {
    expect(classer(500, {})).toBe('PANNE');
    expect(classer(0, 'fetch failed')).toBe('AUCUNE RÉPONSE');
    expect(estEchec('PANNE')).toBe(true);
    expect(estEchec('AUCUNE RÉPONSE')).toBe(true);
  });

  it('ne confond pas un 401 de passerelle avec une réponse du handler', () => {
    // UNAUTHORIZED_NO_AUTH_HEADER vient de la passerelle : la fonction n'a pas tourné.
    expect(classer(401, { code: 'UNAUTHORIZED_NO_AUTH_HEADER' })).toBe('SESSION REFUSÉE');
  });
});

describe('Sondes — les actions réellement appelées par l’interface', () => {
  const liste = sondes('jeton-de-test');

  it('couvre Grow, ses modules métier, MCP, le catalogue et Studio', () => {
    const noms = liste.map((s: { nom: string }) => s.nom);
    for (const attendu of [
      'business-grow · status',
      'business-grow · quota.status',
      'business-grow · conversations.list',
      'business-grow · memory.get',
      'business-grow · integrations.list',
      'business-grow · tools.list',
      'business-grow · agent.reports.list',
      'mcp-client · gestion/lister',
      'universal-catalog · catalog',
      'studio-runtime · quotas',
    ]) {
      expect(noms, `sonde manquante : ${attendu}`).toContain(attendu);
    }
    expect(noms.filter((n: string) => n.includes('module ')).length).toBeGreaterThanOrEqual(6);
  });

  it('n’envoie AUCUNE écriture : ni création, ni suppression, ni génération payante', () => {
    for (const sonde of liste) {
      const corps = String(sonde.init.body ?? '');
      expect(corps, sonde.nom).not.toMatch(/"op":"(create|update|delete)"/);
      expect(corps, sonde.nom).not.toMatch(/"(generate_|start|estimate|quote|sync_muapi)/);
      expect(corps, sonde.nom).not.toMatch(/integrations\.(request|disconnect)|conversations\.(create|delete|rename)|memory\.(item\.put|consent|profile\.save)/);
    }
  });

  it('porte le jeton de session et la clé publique sur chaque appel', () => {
    for (const sonde of liste) {
      const entetes = sonde.init.headers as Record<string, string>;
      expect(entetes.authorization, sonde.nom).toBe('Bearer jeton-de-test');
      expect(entetes.apikey, sonde.nom).toMatch(/^sb_publishable_/);
      expect(sonde.url).toMatch(/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\//);
    }
  });

  it('n’utilise aucune clé secrète', () => {
    for (const sonde of liste) {
      expect(JSON.stringify(sonde.init.headers)).not.toContain('sb_secret_');
    }
  });

  it('les catégories de modules respectent le motif exigé par le backend', () => {
    for (const sonde of liste.filter((s: { nom: string }) => s.nom.includes('module '))) {
      const corps = JSON.parse(String(sonde.init.body));
      expect(corpusValide(corps.category)).toBe(true);
      expect(corps.op).toBe('list');
    }
  });
});

/** Le backend exige /^bg_module_[a-z0-9_]{2,60}$/ (business-grow/handler.ts). */
function corpusValide(category: unknown): boolean {
  return typeof category === 'string' && /^bg_module_[a-z0-9_]{2,60}$/.test(category);
}
