import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Origine des redirections d'authentification.
 *
 * Le 25/11/2026, un build avait gravé l'adresse du site PRÉCÉDENT dans le
 * bundle : l'email de confirmation renvoyait vers un site supprimé. La variable
 * Netlify est figée au build et illisible depuis ce dépôt.
 *
 * La correction ne consiste pas à lister les domaines morts — cette liste
 * deviendrait elle-même une dette, et elle ne couvrirait jamais le prochain
 * renommage. Elle consiste à faire confiance au NAVIGATEUR, qui est la seule
 * source qui ne peut pas être périmée : l'utilisateur navigue forcément sur le
 * bon domaine.
 *
 * `SITE_URL` n'est utilisée que côté navigateur (api.ts, OwnerBootstrap.tsx),
 * ce qui rend ce choix sûr.
 */
const source = readFileSync(new URL('../src/lib/supabase.ts', import.meta.url), 'utf8');

/** Reproduction de la logique : navigateur d'abord, variable en secours. */
function resoudre(origineNavigateur: string | undefined, configuree: string | undefined): string {
  if (origineNavigateur) return origineNavigateur;
  return configuree ? configuree.replace(/\/+$/, '') : '';
}

const NAV = 'https://exemple.test';

describe('SITE_URL — le navigateur fait foi', () => {
  it('dans un navigateur, l’origine de la page l’emporte sur la variable', () => {
    // Même si la variable est périmée, le bon domaine gagne.
    expect(resoudre(NAV, 'https://site-precedent.test')).toBe(NAV);
  });

  it('la variable ne sert que hors navigateur (tests, rendu hors DOM)', () => {
    expect(resoudre(undefined, 'https://exemple.test/')).toBe(NAV);
    expect(resoudre(undefined, undefined)).toBe('');
  });

  it('le code ne contient AUCUN domaine en dur, commentaires compris', () => {
    // Un domaine figé ici serait gravé dans le bundle et deviendrait faux au
    // premier renommage : c'est précisément l'incident du 25/11/2026.
    expect(source).not.toMatch(/https:\/\/[a-z0-9-]+\.netlify\.app/);
    expect(source).not.toMatch(/https:\/\/[a-z0-9-]+\.pages\.dev/);
  });

  it('le navigateur est consulté AVANT la variable', () => {
    // L'ordre compte : c'est toute la correction.
    const bloc = source.slice(source.indexOf('export const SITE_URL'));
    const posNavigateur = bloc.indexOf('window.location.origin');
    const posVariable = bloc.indexOf('VITE_SITE_URL');
    expect(posNavigateur).toBeGreaterThan(-1);
    expect(posVariable).toBeGreaterThan(posNavigateur);
  });

  it('une valeur mal formée ne peut pas gagner, puisque le navigateur passe avant', () => {
    expect(resoudre(NAV, 'pas-une-url')).toBe(NAV);
  });
});
