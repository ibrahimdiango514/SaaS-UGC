import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config, { buildRevision } from '../vite.config';

/**
 * Cachet de révision du build.
 *
 * Publier ne suffit pas : le CDN peut continuer à servir l'ancien HTML après un
 * déploiement « réussi ». Sans repère dans la page, impossible de distinguer
 * « pas déployé » de « déployé mais pas encore propagé ».
 *
 * Le cachet est donc une donnée vérifiable publiquement, et il ne doit jamais
 * mentir : on préfère « dev » (aveu d'absence) à un SHA inventé.
 */
describe('cachet de révision du build', () => {
  it('accepte le SHA fourni par le CI, tronqué à 7 caractères', () => {
    expect(buildRevision({ COMMIT_REF: '8c304e7aabbccddeeff00112233445566778899a' })).toBe('8c304e7');
    expect(buildRevision({ VITE_COMMIT_REF: 'abc1234' })).toBe('abc1234');
  });

  it('refuse une valeur qui n’est pas un SHA et se rabat sur git ou « dev »', () => {
    // Une valeur trop longue n'est pas un SHA : elle ne doit pas être tronquée
    // en douce puis affichée comme une révision.
    expect(buildRevision({ COMMIT_REF: '8c304e7aabbccddeeff00112233445566778899ab1' })).not.toBe('8c304e7');
    const revision = buildRevision({ COMMIT_REF: 'branche-courante' });
    // Dans ce dépôt, `git` répond : on exige alors un vrai SHA court.
    expect(revision === 'dev' || /^[0-9a-f]{7}$/.test(revision)).toBe(true);
    expect(revision).not.toBe('branche-courante');
  });

  it('privilégie COMMIT_REF (CI) sur la valeur locale', () => {
    expect(buildRevision({ COMMIT_REF: 'deadbee', VITE_COMMIT_REF: 'abc1234' })).toBe('deadbee');
  });

  it('injecte la balise de révision dans le HTML généré', () => {
    const resolved = config({ command: 'build', mode: 'production' });
    const plugin = (resolved.plugins as Array<{ name?: string; transformIndexHtml?: (html: string) => string }>)
      .flat()
      .find((item) => item?.name === 'vyora-build-revision');
    expect(plugin?.transformIndexHtml).toBeTypeOf('function');

    const html = plugin!.transformIndexHtml!('<html><head><title>SORAHNEX</title></head><body></body></html>');
    expect(html).toContain('<meta name="vyora-revision" content="');
    // Le cachet est bien dans <head>, pas après </head>.
    expect(html.indexOf('vyora-revision')).toBeLessThan(html.indexOf('</head>'));
  });

  it('le build livré porte un cachet cohérent avec le dépôt', () => {
    let html: string;
    try {
      html = readFileSync('dist/index.html', 'utf8');
    } catch {
      return; // pas de build local : rien à vérifier, surtout pas à inventer
    }
    const match = html.match(/<meta name="vyora-revision" content="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1] === 'dev' || /^[0-9a-f]{7}$/.test(match![1])).toBe(true);
  });
});
