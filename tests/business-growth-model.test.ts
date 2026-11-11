import { describe, expect, it } from 'vitest';
import {
  EMPTY_COMPANY_PROFILE, GROWTH_CATEGORY, buildGrowthPrompt, formatGrowthAmount, goalProgress,
  isGoalOverdue, mergeCompanyProfile, parseCatalogImport, pipelineSummary, profileFromMemory,
  readCompetitors, readGoals, readProspects, readSignals, readStrategies, upcomingActions,
  type GrowthGoal,
} from '../src/business/growth/model';
import type { BusinessMemory } from '../src/business/api';

function memory(items: Array<{ id: string; category: string; content: unknown }>, profile: Record<string, unknown> | null = null): BusinessMemory {
  return {
    consent: true,
    policyVersion: 'v1',
    profile,
    items: items.map((item, index) => ({
      id: item.id, category: item.category, content: item.content,
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: `2026-11-0${(index % 9) + 1}T00:00:00.000Z`,
    })),
  };
}

describe('Lecture défensive des enregistrements de croissance', () => {
  const data = memory([
    { id: 'g1', category: GROWTH_CATEGORY.goal, content: { title: 'Objectif A', metric: 'ventes', target: 100, current: 40, unit: 'clients', priority: 'haute' } },
    { id: 'g2', category: GROWTH_CATEGORY.goal, content: { title: '', target: 10 } },
    { id: 'p1', category: GROWTH_CATEGORY.prospect, content: { name: 'Awa', stage: 'inconnu', value: '15000', currency: 'xof' } },
    { id: 'p2', category: GROWTH_CATEGORY.prospect, content: { name: '', company: '' } },
    { id: 'c1', category: GROWTH_CATEGORY.competitor, content: { name: 'Concurrent X', url: 'https://x.example' } },
    { id: 's1', category: GROWTH_CATEGORY.signal, content: { title: 'Vidéo avant/après', kind: 'weird', metricLabel: 'vues', metricValue: 1200 } },
    { id: 'st1', category: GROWTH_CATEGORY.strategy, content: { title: 'Plan', summary: 'Résumé', actions: ['Agir', '', 42], source: 'ia' } },
  ]);

  it('ignore les enregistrements incomplets et normalise les champs', () => {
    const goals = readGoals(data);
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ id: 'g1', title: 'Objectif A', priority: 'haute', target: 100, current: 40 });
    const prospects = readProspects(data);
    expect(prospects).toHaveLength(1);
    expect(prospects[0]).toMatchObject({ name: 'Awa', stage: 'prospect', value: 15000, currency: 'xof' });
    expect(readCompetitors(data)).toHaveLength(1);
    const signals = readSignals(data);
    expect(signals[0]).toMatchObject({ kind: 'tendance', metricValue: 1200 });
    const strategies = readStrategies(data);
    expect(strategies[0]).toMatchObject({ source: 'ia', actions: ['Agir'] });
  });

  it('ne casse pas sur une mémoire absente ou désactivée', () => {
    expect(readGoals(null)).toEqual([]);
    expect(readProspects(undefined)).toEqual([]);
    expect(profileFromMemory(null)).toEqual(EMPTY_COMPANY_PROFILE);
  });

  it('lit le profil entreprise sans inventer de champs', () => {
    const profile = profileFromMemory(memory([], { legalName: 'Maison Nala', audience: '  femmes 20-35 ', unknown: 'x' }));
    expect(profile.legalName).toBe('Maison Nala');
    expect(profile.audience).toBe('femmes 20-35');
    expect(profile).not.toHaveProperty('unknown');
  });
});

describe('Mise à jour du profil entreprise', () => {
  it('fusionne sans perdre les champs existants et supprime les effacements', () => {
    const merged = mergeCompanyProfile(
      { legalName: 'Maison Nala', market: 'Bamako', extra: 'conservé' },
      { market: '', audience: '  étudiantes  ' },
    );
    expect(merged.legalName).toBe('Maison Nala');
    expect(merged.audience).toBe('étudiantes');
    expect(merged.market).toBeUndefined();
    expect(merged.extra).toBe('conservé');
    expect(typeof merged.updatedAt).toBe('string');
  });
});

describe('Indicateurs réels du pipeline', () => {
  const base = { company: '', email: '', phone: '', currency: 'XOF', nextAction: '', nextActionAt: '', notes: '', updatedAt: '' };
  const prospects = [
    { ...base, id: '1', name: 'A', stage: 'prospect' as const, value: 1000 },
    { ...base, id: '2', name: 'B', stage: 'proposition' as const, value: 2000 },
    { ...base, id: '3', name: 'C', stage: 'gagne' as const, value: 5000 },
    { ...base, id: '4', name: 'D', stage: 'perdu' as const, value: 700 },
  ];

  it('sépare pipeline ouvert, gagné et perdu', () => {
    const summary = pipelineSummary(prospects);
    expect(summary.openCount).toBe(2);
    expect(summary.openValue).toBe(3000);
    expect(summary.wonValue).toBe(5000);
    expect(summary.lostValue).toBe(700);
    expect(summary.byStage.proposition).toBe(1);
    expect(summary.totalCount).toBe(4);
  });

  it('trie les relances par date sans inventer d’action', () => {
    const actions = upcomingActions([
      { ...prospects[0], nextAction: 'Rappeler', nextActionAt: '2026-11-20' },
      { ...prospects[1], nextAction: 'Envoyer devis', nextActionAt: '2026-11-15' },
      { ...prospects[2], nextAction: 'Déjà gagné', nextActionAt: '2026-11-01' },
      { ...prospects[3], nextAction: '', nextActionAt: '2026-11-02' },
    ]);
    expect(actions.map((entry) => entry.name)).toEqual(['B', 'A']);
  });

  it('calcule la progression d’un objectif sans division par zéro', () => {
    const goal: GrowthGoal = {
      id: '1', title: 'CA', metric: '', target: 100, current: 50, unit: 'FCFA',
      dueDate: '', priority: 'moyenne', status: 'en_cours', updatedAt: '',
    };
    expect(goalProgress(goal)).toBe(50);
    expect(goalProgress({ ...goal, target: 0, current: 0 })).toBe(0);
    expect(goalProgress({ ...goal, current: 400 })).toBe(100);
    expect(isGoalOverdue({ ...goal, dueDate: '2020-01-01' })).toBe(true);
    expect(isGoalOverdue({ ...goal, dueDate: '2020-01-01', current: 100, status: 'atteint' })).toBe(false);
  });

  it('formate un montant avec repli sûr pour devise inconnue', () => {
    expect(formatGrowthAmount(15000, 'XOF')).toMatch(/15/);
    expect(formatGrowthAmount(10, 'NOT_A_CURRENCY')).toMatch(/NOT_A_CURRENCY|10/);
  });
});

describe('Import de catalogue', () => {
  it('importe un JSON valide et signale les lignes incomplètes', () => {
    const result = parseCatalogImport(JSON.stringify([
      { name: 'Sérum', price: 12000, currency: 'xof', benefits: ['éclat', 'hydratation'] },
      { name: '', price: 10 },
      { name: 'Savon', price: 'invalide' },
    ]));
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({ name: 'Sérum', priceAmount: 12000, priceCurrency: 'XOF', benefits: ['éclat', 'hydratation'] });
    expect(result.errors.length).toBe(2);
  });

  it('importe un CSV avec en-tête', () => {
    const result = parseCatalogImport('name,price,currency,description\nSavon,1500,XOF,Savon naturel\nBaume,2500,XOF,Baume karité');
    expect(result.ok).toBe(true);
    expect(result.products).toHaveLength(2);
    expect(result.products[1]).toMatchObject({ name: 'Baume', priceAmount: 2500, priceCurrency: 'XOF' });
  });

  it('refuse un CSV sans colonnes obligatoires ou un JSON invalide', () => {
    const missing = parseCatalogImport('title,prix\nA,10');
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(' ')).toMatch(/name/);
    const invalid = parseCatalogImport('[{bad json]');
    expect(invalid.ok).toBe(false);
    expect(parseCatalogImport('   ').ok).toBe(false);
  });
});

describe('Prompt IA ancré sur les données réelles', () => {
  it('interdit explicitement d’inventer des chiffres et de prétendre naviguer sur le web', () => {
    const prompt = buildGrowthPrompt('strategy', {
      company: { ...EMPTY_COMPANY_PROFILE, legalName: 'Maison Nala', market: 'Bamako' },
      goals: [{ id: '1', title: 'Ventes', metric: 'CA', target: 100, current: 10, unit: 'FCFA', dueDate: '', priority: 'haute', status: 'en_cours', updatedAt: '' }],
      prospects: [], competitors: [], signals: [],
      products: [{ name: 'Sérum', price: '12 000 FCFA' }],
      workspaceName: 'Espace test',
    });
    expect(prompt).toContain('Maison Nala');
    expect(prompt).toContain('Sérum');
    expect(prompt).toContain('N’invente aucun chiffre');
    expect(prompt).toContain('Ne prétends pas avoir consulté le web');
    expect(prompt).toContain('30/60/90');
  });

  it('ne fabrique pas de concurrent quand la liste est vide', () => {
    const prompt = buildGrowthPrompt('competition', {
      company: EMPTY_COMPANY_PROFILE, goals: [], prospects: [], competitors: [], signals: [], products: [],
    });
    expect(prompt).toContain('"concurrents":[]');
  });
});
