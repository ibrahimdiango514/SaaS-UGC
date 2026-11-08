import { describe, expect, it } from 'vitest';
import {
  extractVariables, formatBytes, formatDate, formatMoney, initials, interpolate,
  relativeDate, statusLabel, statusTone, truncate,
} from '../src/lib/format';

describe('formatDate', () => {
  it('formate une date ISO en français', () => {
    expect(formatDate('2026-11-08T10:30:00Z')).toContain('2026');
    expect(formatDate('2026-11-08T10:30:00Z')).toContain('nov');
  });
  it('retourne un tiret pour une valeur absente ou invalide', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('pas-une-date')).toBe('—');
  });
});

describe('formatMoney', () => {
  it('convertit les montants en unités mineures', () => {
    expect(formatMoney(150000000, 'XOF')).toContain('1');
    expect(formatMoney(0)).toBe('Sur devis');
  });
});

describe('formatBytes', () => {
  it('gère les octets, Ko et Mo', () => {
    expect(formatBytes(512)).toBe('512 o');
    expect(formatBytes(2048)).toBe('2.0 Ko');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 Mo');
    expect(formatBytes(null)).toBe('—');
  });
});

describe('statuts', () => {
  it('traduit les statuts connus et conserve les inconnus', () => {
    expect(statusLabel('draft')).toBe('Brouillon');
    expect(statusLabel('succeeded')).toBe('Réussi');
    expect(statusLabel('inconnu')).toBe('inconnu');
    expect(statusTone('failed')).toBe('danger');
    expect(statusTone('completed')).toBe('success');
  });
});

describe('variables de prompts', () => {
  it('extrait les variables sans doublons', () => {
    expect(extractVariables('Écris pour {{produit}} et {{ audience }} puis {{produit}}')).toEqual(['produit', 'audience']);
  });
  it('remplace les variables et laisse les inconnues visibles', () => {
    expect(interpolate('Bonjour {{prenom}}, {{inconnu}}', { prenom: 'Awa' })).toBe('Bonjour Awa, {{inconnu}}');
  });
});

describe('utilitaires', () => {
  it('tronque sans couper brutalement', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde…');
    expect(truncate('court', 50)).toBe('court');
  });
  it('génère des initiales à partir du nom ou de l’e-mail', () => {
    expect(initials('Awa Diango', 'a@x.com')).toBe('AW');
    expect(initials(null, 'ibrahim@example.com')).toBe('IB');
    expect(initials(null, null)).toBe('R');
  });
  it('relativeDate reste robuste', () => {
    expect(relativeDate(null)).toBe('—');
    expect(relativeDate(new Date().toISOString())).toBe('à l’instant');
  });
});
