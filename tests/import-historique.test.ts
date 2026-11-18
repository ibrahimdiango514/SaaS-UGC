/**
 * Historique des imports — normalisation et rendu des libellés.
 *
 * L'historique est une vue en lecture : ces tests vérifient qu'un import d'une
 * autre entreprise, une ligne incomplète ou un statut inconnu ne se traduisent
 * jamais par un affichage inventé (par exemple « terminé » sur un import
 * échoué).
 */
import { describe, expect, it } from 'vitest';
import {
  FORMAT_LABELS, STATUS_LABELS, formatJobDate, normalizeHistory, normalizeJob, normalizeReport,
  originLabel, summaryLine,
} from '../src/business/importer/history-model';

const job = (surcharge: Record<string, unknown> = {}) => ({
  id: 'j1',
  created_at: '2026-11-18T09:30:00.000Z',
  source: 'file',
  reference: 'produits.csv',
  status: 'completed',
  products_created: 2,
  products_failed: 0,
  variants_created: 6,
  errors_count: 0,
  ...surcharge,
});

describe('normalizeJob', () => {
  it('lit une ligne complète', () => {
    const resultat = normalizeJob(job());
    expect(resultat).toMatchObject({
      id: 'j1', status: 'completed', reference: 'produits.csv',
      productsCreated: 2, variantsCreated: 6, errorsCount: 0,
    });
  });

  it('déduit le format du nom de fichier', () => {
    expect(normalizeJob(job({ reference: 'catalogue.xlsx' }))?.format).toBe('xlsx');
    expect(normalizeJob(job({ reference: 'produits.csv' }))?.format).toBe('csv');
    expect(normalizeJob(job({ reference: 'https://boutique.example/catalog' }))?.format).toBe('url');
  });

  it('traite un fichier sans extension connue comme fichier générique', () => {
    expect(normalizeJob(job({ reference: 'export' }))?.format).toBe('fichier');
  });

  it('refuse une ligne sans identifiant', () => {
    expect(normalizeJob(job({ id: '' }))).toBeNull();
    expect(normalizeJob(null)).toBeNull();
  });

  it('ramène un compteur négatif ou illisible à zéro', () => {
    const resultat = normalizeJob(job({ products_created: -3, variants_created: 'beaucoup' }));
    expect(resultat?.productsCreated).toBe(0);
    expect(resultat?.variantsCreated).toBe(0);
  });

  it('ne traduit pas un statut inconnu en succès', () => {
    // Un statut inconnu devient « failed » : mieux vaut alerter que rassurer à tort.
    expect(normalizeJob(job({ status: 'weird' }))?.status).toBe('failed');
  });
});

describe('normalizeHistory', () => {
  it('lit la page et ses bornes', () => {
    const page = normalizeHistory({ total: 42, limit: 20, offset: 20, jobs: [job(), job({ id: 'j2' })] });
    expect(page.total).toBe(42);
    expect(page.offset).toBe(20);
    expect(page.jobs).toHaveLength(2);
  });

  it('supporte une réponse vide', () => {
    expect(normalizeHistory(null)).toEqual({ total: 0, limit: 50, offset: 0, jobs: [] });
  });
});

describe('normalizeReport', () => {
  it('lit les échecs ligne par ligne', () => {
    const rapport = normalizeReport({
      ...job({ status: 'partial', errors_count: 2 }),
      failures: [{ name: 'Sérum', reason: 'prix invalide' }, { name: 'Savon', reason: 'nom manquant' }],
    });
    expect(rapport?.failures).toEqual([
      { name: 'Sérum', reason: 'prix invalide' },
      { name: 'Savon', reason: 'nom manquant' },
    ]);
  });

  it('ignore un échec sans motif exploitable', () => {
    const rapport = normalizeReport({ ...job(), failures: [{ name: 'X' }, { reason: 'sans nom' }] });
    expect(rapport?.failures).toEqual([]);
  });
});

describe('libellés', () => {
  it('donne un libellé français à chaque statut et format', () => {
    expect(STATUS_LABELS.completed).toBeTruthy();
    expect(STATUS_LABELS.partial).toBeTruthy();
    expect(STATUS_LABELS.failed).toBeTruthy();
    for (const cle of ['csv', 'xlsx', 'url', 'fichier'] as const) expect(FORMAT_LABELS[cle]).toBeTruthy();
  });

  it('affiche le fichier, ou la source quand le nom manque', () => {
    expect(originLabel(normalizeJob(job())!)).toBe('produits.csv');
    // Sans nom de fichier, on nomme la source plutôt que d'afficher « null ».
    expect(originLabel(normalizeJob(job({ reference: null }))!)).toBe('Fichier');
    expect(originLabel(normalizeJob(job({ reference: null }))!)).not.toMatch(/null/);
  });

  it('résume sans inventer de chiffres', () => {
    const complet = summaryLine(normalizeJob(job())!);
    expect(complet).toMatch(/2 produit/);
    expect(complet).toMatch(/6 variante/);
    expect(complet).not.toMatch(/erreur/);

    const partiel = summaryLine(normalizeJob(job({ status: 'partial', errors_count: 3 }))!);
    expect(partiel).toMatch(/3 erreur/);
  });
});

describe('formatJobDate', () => {
  it('rend une date lisible, sans « Invalid Date »', () => {
    const rendu = formatJobDate('2026-11-18T09:30:00.000Z');
    expect(rendu).toMatch(/2026/);
    expect(rendu).not.toMatch(/Invalid/);
  });

  it('signale une date absente plutôt que d’afficher « Invalid Date »', () => {
    expect(formatJobDate('')).toBe('Date inconnue');
    expect(formatJobDate('pas une date')).toBe('Date inconnue');
  });
});
