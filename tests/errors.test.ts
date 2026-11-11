import { describe, expect, it } from 'vitest';
import { AppError, asAppError, humanizeError } from '../src/lib/errors';

describe('humanizeError', () => {
  it('traduit les erreurs de quota et de crédits', () => {
    expect(humanizeError('quota_exceeded:video:3:3')).toContain('Limite mensuelle de vidéos');
    expect(humanizeError('quota_exceeded:script:5:5')).toContain('scripts');
    expect(humanizeError('project_limit_reached:2')).toContain('projets');
    expect(humanizeError('insufficient_credits')).toContain('Crédits insuffisants');
    expect(humanizeError('account_not_active')).toContain('suspendu');
  });
  it('signale les problèmes réseau et les échecs CORS/Edge', () => {
    expect(humanizeError('Failed to fetch')).toContain('Connexion impossible');
    expect(humanizeError('Failed to send a request to the Edge Function')).toContain('service VYORA');
  });
  it('utilise le message de secours si rien n’est fourni', () => {
    expect(humanizeError(null, 'Oups')).toBe('Oups');
  });
  it('limite la longueur des messages bruts', () => {
    expect(humanizeError('x'.repeat(400)).length).toBeLessThan(270);
  });
});

describe('asAppError', () => {
  it('conserve un AppError existant', () => {
    const e = new AppError('message', 'CODE');
    expect(asAppError(e)).toBe(e);
    expect(asAppError(e).code).toBe('CODE');
  });
  it('convertit une Error, une chaîne et une valeur inconnue', () => {
    expect(asAppError(new Error('quota_exceeded:prompt'))).toBeInstanceOf(AppError);
    expect(asAppError('not_authenticated').message).toContain('reconnecter');
    expect(asAppError(undefined).message).toContain('erreur');
  });
});
