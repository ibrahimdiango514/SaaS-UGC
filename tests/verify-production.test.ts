import { describe, expect, it } from 'vitest';
import { judgeFunctionStatus, judgeRevision, revisionFromHtml } from '../scripts/verify-production.mjs';

/**
 * Le constat de production doit être sans ambiguïté : chaque réponse possible a
 * un verdict explicitement favorable ou défavorable. Un « je ne sais pas » ne
 * doit jamais être présenté comme un succès — c'est exactement le piège qu'on
 * veut éviter en annonçant un déploiement.
 */
describe('constat de production', () => {
  it('lit le cachet de révision dans le HTML servi', () => {
    expect(revisionFromHtml('<head><meta name="vyora-revision" content="799ae49"></head>')).toBe('799ae49');
    expect(revisionFromHtml("<head><meta name='vyora-revision' content='799ae49'></head>")).toBeNull();
    expect(revisionFromHtml('<head></head>')).toBeNull();
  });

  it('ne déclare concordant que si le cachet égale le commit de main', () => {
    expect(judgeRevision('799ae49', '799ae49').ok).toBe(true);
    expect(judgeRevision('2b6af20', '799ae49')).toMatchObject({ ok: false });
    expect(judgeRevision(null, '799ae49').ok).toBe(false);
    expect(judgeRevision('dev', '799ae49').ok).toBe(false);
    expect(judgeRevision('799ae49', '').ok).toBe(false);
  });

  it('interprète le refus anonyme de l’Edge Function', () => {
    expect(judgeFunctionStatus(401).ok).toBe(true);
    expect(judgeFunctionStatus(503)).toMatchObject({ ok: false });
    expect(judgeFunctionStatus(0)).toMatchObject({ ok: false });
    expect(judgeFunctionStatus(200)).toMatchObject({ ok: false });
    expect(judgeFunctionStatus(502)).toMatchObject({ ok: false });
  });

  it('formule chaque verdict sans ambiguïté', () => {
    expect(judgeRevision('2b6af20', '799ae49').verdict).toContain('2b6af20');
    expect(judgeFunctionStatus(503).verdict).toContain('artefact');
    expect(judgeFunctionStatus(0).verdict).toContain('injoignable');
  });
});
