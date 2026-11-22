import { describe, expect, it } from 'vitest';
import {
  buildActionCenter, buildContactsFromRows, computeCrmDashboard, contactFromRecord,
  contactDisplayName, contactsToCsv, detectDuplicates, guessMapping, mergeContactData,
  phonesMatch, opportunityFromRecord, parseCsv, renderTemplate, scoreContact,
  contactMatchesFilters, EMPTY_SEGMENT_FILTERS, type Contact, type Opportunity,
  type CrmTask,
} from '../src/business/crm/model';

const TODAY = '2026-11-22';

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c1', firstName: 'Awa', lastName: 'Traoré', company: 'Boutique Awa', jobTitle: '',
    phone: '+223 76 12 34 56', whatsapp: '', email: 'awa@example.com', address: '', city: 'Bamako',
    country: 'Mali', source: 'instagram', type: 'prospect', tags: ['vip'], notes: '', owner: 'Ibrahim',
    lastContactAt: '2026-11-20', nextAction: 'Rappeler', nextActionAt: '2026-11-21', status: 'actif',
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z', ...overrides,
  };
}

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'o1', title: 'Pack boutique', contactId: 'c1', stage: 'proposition', amount: 500_000,
    currency: 'XOF', probability: 65, expectedCloseAt: '2026-11-25', owner: 'Ibrahim',
    product: 'Pack', source: 'instagram', notes: '', lostReason: '', nextAction: '',
    nextActionAt: '', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z', ...overrides,
  };
}

function task(overrides: Partial<CrmTask> = {}): CrmTask {
  return {
    id: 't1', title: 'Appeler Awa', type: 'appel', contactId: 'c1', opportunityId: '',
    owner: 'Ibrahim', priority: 'elevee', dueDate: '2026-11-20', dueTime: '', status: 'a_faire',
    notes: '', outcome: '', nextAction: '', nextActionAt: '', completedAt: '',
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...overrides,
  };
}

describe('CRM — normalisation et contacts', () => {
  it('normalise les téléphones pour comparer les indicatifs', () => {
    expect(phonesMatch('00223 76 12 34 56', '76 12 34 56')).toBe(true);
    expect(phonesMatch('+223 76 12 34 56', '76 12 34 56')).toBe(true);
    expect(phonesMatch('+223 76 12 34 56', '76 99 99 99')).toBe(false);
    expect(phonesMatch('', '')).toBe(false);
  });

  it('lit une fiche contact et conserve un nom affichable', () => {
    const parsed = contactFromRecord({ id: 'c9', data: { firstName: 'Moussa', lastName: 'Diallo', type: 'client', tags: 'vip, fidèle' } });
    expect(parsed.type).toBe('client');
    expect(parsed.tags).toEqual(['vip', 'fidèle']);
    expect(contactDisplayName(parsed)).toBe('Moussa Diallo');
  });
});

describe('CRM — score explicable', () => {
  it('classe un prospect récent, avancé et à fort montant comme chaud', () => {
    const score = scoreContact(contact(), { opportunities: [opportunity()], tasks: [task()], now: TODAY });
    expect(score.score).toBeGreaterThanOrEqual(55);
    expect(score.heat).toBe('chaud');
    expect(score.reasons.some((reason) => reason.label === 'Contact très récent')).toBe(true);
    expect(score.reasons.some((reason) => reason.label === 'Avancement du pipeline')).toBe(true);
  });

  it('refroidit un contact ancien sans opportunité', () => {
    const old = contact({ lastContactAt: '2026-08-01', nextActionAt: '', nextAction: '' });
    const score = scoreContact(old, { opportunities: [], tasks: [], now: TODAY });
    expect(score.heat).toBe('froid');
    expect(score.priority).toBe('faible');
    expect(score.reasons.some((reason) => reason.points < 0)).toBe(true);
  });
});

describe('CRM — doublons et fusion', () => {
  it('détecte un doublon par e-mail et téléphone avec explication', () => {
    const duplicate = contact({ id: 'c2', firstName: 'Awa', lastName: 'Traore', email: 'AWA@example.com', phone: '76 12 34 56' });
    const candidates = detectDuplicates([contact(), duplicate]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe(100);
    expect(candidates[0].reasons.join(' ')).toMatch(/E-mail identique/);
    expect(candidates[0].reasons.join(' ')).toMatch(/Téléphone identique/);
  });

  it('ne fusionne rien automatiquement et conserve les tags des deux fiches', () => {
    const merged = mergeContactData(contact(), contact({ id: 'c2', tags: ['prospect'], phone: '70 00 00 00', notes: 'Rencontrée au salon' }));
    expect(merged.id).toBe('c1');
    expect(merged.phone).toBe('+223 76 12 34 56');
    expect(merged.notes).toBe('Rencontrée au salon');
    expect(merged.tags).toEqual(['vip', 'prospect']);
  });
});

describe('CRM — centre d’action', () => {
  it('remonte les relances en retard et les opportunités stagnantes', () => {
    const actions = buildActionCenter({
      contacts: [contact()],
      opportunities: [opportunity({ updatedAt: '2026-10-01T00:00:00.000Z' })],
      tasks: [task()],
      now: TODAY,
    });
    expect(actions.some((action) => action.kind === 'relance_retard')).toBe(true);
    expect(actions.some((action) => action.kind === 'opportunite_stagnante')).toBe(true);
    expect(actions[0].severity).toBe('urgente');
  });
});

describe('CRM — tableau de bord sans double comptage', () => {
  it('calcule pipeline, pondération et conversion depuis les données réelles', () => {
    const dashboard = computeCrmDashboard({
      contacts: [contact(), contact({ id: 'c2', type: 'client', email: 'b@example.com', phone: '70 00 00 01' })],
      opportunities: [
        opportunity(),
        opportunity({ id: 'o2', stage: 'gagne', amount: 100_000, probability: 100, contactId: 'c2' }),
        opportunity({ id: 'o3', stage: 'perdu', amount: 50_000, probability: 0 }),
      ],
      tasks: [task()],
      now: TODAY,
    });
    expect(dashboard.totalContacts).toBe(2);
    expect(dashboard.openOpportunities).toBe(1);
    expect(dashboard.pipelineValue).toBe(500_000);
    expect(dashboard.weightedPipeline).toBeCloseTo(325_000);
    expect(dashboard.wonValue).toBe(100_000);
    expect(dashboard.winRate).toBe(50);
    expect(dashboard.conversionRate).toBe(50);
  });

  it('affiche un total inconnu plutôt que zéro quand un montant manque', () => {
    const dashboard = computeCrmDashboard({
      contacts: [contact()],
      opportunities: [opportunity({ amount: null })],
      tasks: [],
      now: TODAY,
    });
    expect(dashboard.pipelineValue).toBeNull();
    expect(dashboard.weightedPipeline).toBeNull();
  });
});

describe('CRM — segments', () => {
  it('filtre par inactivité, priorité et opportunité ouverte', () => {
    const score = scoreContact(contact(), { opportunities: [opportunity()], tasks: [], now: TODAY });
    expect(contactMatchesFilters(contact(), { ...EMPTY_SEGMENT_FILTERS, hasOpenOpportunity: true }, score, 500_000, 0)).toBe(true);
    expect(contactMatchesFilters(contact(), { ...EMPTY_SEGMENT_FILTERS, inactiveDays: 30 }, score, 500_000, 0)).toBe(false);
    expect(contactMatchesFilters(contact(), { ...EMPTY_SEGMENT_FILTERS, priority: 'faible' }, score, 500_000, 0)).toBe(false);
  });
});

describe('CRM — import et export CSV', () => {
  it('analyse les guillemets, les séparateurs et les accents', () => {
    const rows = parseCsv('Nom;Prénom;E-mail;Notes\r\nTraoré;Awa;awa@example.com;"Client ""VIP"", à rappeler"\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1][3]).toBe('Client "VIP", à rappeler');
  });

  it('devine les colonnes puis normalise les lignes importées', () => {
    const rows = parseCsv('Téléphone,Prénom,Nom,Type\n76 12 34 56,Awa,Traoré,Client');
    const mapping = guessMapping(rows[0]);
    const results = buildContactsFromRows(rows.slice(1), mapping);
    expect(results[0].errors).toEqual([]);
    expect(results[0].data).toMatchObject({ firstName: 'Awa', lastName: 'Traoré', phone: '76 12 34 56', type: 'client' });
  });

  it('signale une ligne inutilisable au lieu de l’importer', () => {
    const results = buildContactsFromRows([['', ''], ['Awa', 'Traoré']], { 0: 'firstName', 1: 'lastName' });
    expect(results[0].errors.length).toBeGreaterThan(0);
    expect(results[1].errors).toEqual([]);
  });

  it('exporte des contacts échappés', () => {
    const csv = contactsToCsv([contact({ notes: '' })]);
    expect(csv.split('\r\n')[0]).toContain('Prénom');
    expect(csv).toContain('Awa');
  });
});

describe('CRM — modèles de message', () => {
  it('remplit les variables et signale les variables manquantes', () => {
    expect(renderTemplate('Bonjour {{contact}} de {{entreprise}}', { contact: 'Awa' }))
      .toBe('Bonjour Awa de [entreprise]');
  });
});

describe('CRM — lecture des opportunités', () => {
  it('conserve un motif de perte et une probabilité par étape', () => {
    const lost = opportunityFromRecord({ id: 'o9', data: { title: 'Devis', stage: 'perdu', lostReason: 'Trop cher' } });
    expect(lost.stage).toBe('perdu');
    expect(lost.lostReason).toBe('Trop cher');
    const fresh = opportunityFromRecord({ id: 'o10', data: { title: 'Devis', stage: 'qualifie' } });
    expect(fresh.probability).toBe(35);
  });
});
