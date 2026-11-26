// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listModuleRecords: vi.fn(),
  createModuleRecord: vi.fn(),
  updateModuleRecord: vi.fn(),
  deleteModuleRecord: vi.fn(),
}));

vi.mock('../src/business/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/business/api')>();
  return { ...actual, businessGrowApi: { ...actual.businessGrowApi, ...api } };
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../src/context/ToastContext';
import { RecouvrementWorkspace } from '../src/business/finance/RecouvrementWorkspace';
import {
  etapePour, langueDuClient, messageRelanceImpaye, relancesDues, SEQUENCE_PAR_DEFAUT,
  totalRelancable,
} from '../src/business/finance/relances';
import { reminderFromRecord, type Receivable } from '../src/business/finance/model';
import type { Contact } from '../src/business/crm/model';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const WS = '11111111-1111-4111-8111-111111111111';
const record = (id: string, category: string, data: Record<string, unknown>) => ({
  id, category, data, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
});

const creance = (surcharge: Partial<Receivable> = {}): Receivable => ({
  id: 'r1', reference: 'FAC-42', contactId: 'k1', description: '',
  initialAmount: 500000, issuedAt: '2026-09-01', dueDate: '2026-10-01', terms: '',
  status: 'en_attente', notes: '', owner: '', createdAt: '', updatedAt: '',
  ...surcharge,
});

const contact = (surcharge: Partial<Contact> = {}): Contact => ({
  id: 'k1', firstName: 'Awa', lastName: 'Traoré', company: '', jobTitle: '',
  phone: '', whatsapp: '', email: 'awa@example.test', address: '', city: '', country: 'Mali',
  source: '', type: 'client', tags: [], notes: '', owner: '',
  lastContactAt: '', nextAction: '', nextActionAt: '', status: 'actif',
  ...surcharge,
} as Contact);

describe('Séquence de relances — calculs', () => {
  it('ne relance pas une créance qui n’est pas échue', () => {
    // C'est le point le plus important : relancer trop tôt abîme la relation.
    expect(etapePour(0)).toBe('termine');
    expect(etapePour(-5)).toBe('termine');
    expect(etapePour(Number.NaN)).toBe('termine');
  });

  it('applique des étapes de plus en plus fermes', () => {
    expect(etapePour(3)).toBe('rappel_court');
    expect(etapePour(15)).toBe('relance_ferme');
    expect(etapePour(30)).toBe('mise_en_demeure');
    expect(etapePour(60)).toBe('contentieux');
    expect(etapePour(400)).toBe('contentieux');
  });

  it('respecte des seuils personnalisés', () => {
    const sequence = SEQUENCE_PAR_DEFAUT.map((definition) => (
      definition.etape === 'relance_ferme' ? { ...definition, aPartirDe: 7 } : { ...definition }
    ));
    expect(etapePour(7, sequence)).toBe('relance_ferme');
    expect(etapePour(6, sequence)).toBe('rappel_court');
  });

  it('choisit la langue du client, pas celle de l’interface', () => {
    expect(langueDuClient(contact({ country: 'Mali' }))).toBe('fr');
    expect(langueDuClient(contact({ country: 'Nigeria' }))).toBe('en');
    expect(langueDuClient(contact({ country: 'Espagne' }))).toBe('es');
    expect(langueDuClient(contact({ country: 'Maroc' }))).toBe('ar');
    // Pays inconnu ou vide : français par défaut, jamais de message vide.
    expect(langueDuClient(contact({ country: 'Inconnu' }))).toBe('fr');
    expect(langueDuClient(null)).toBe('fr');
  });

  it('rédige le message dans la langue du client', () => {
    const base = { entreprise: 'Maison Karité', montantDu: 250000, devise: 'XOF', reference: 'FAC-9', echeance: '2026-10-01' };
    const fr = messageRelanceImpaye('rappel_court', { ...base, contact: contact({ country: 'Mali' }) });
    const en = messageRelanceImpaye('rappel_court', { ...base, contact: contact({ country: 'Ghana' }) });
    const es = messageRelanceImpaye('rappel_court', { ...base, contact: contact({ country: 'Espagne' }) });

    expect(fr).toContain('Bonjour Awa Traoré');
    expect(fr).toContain('FAC-9');
    expect(fr).toContain('Maison Karité');
    expect(en).toContain('Hello Awa Traoré');
    expect(es).toContain('Hola Awa Traoré');
    // Le ton monte avec l'étape : la mise en demeure n'est pas un rappel.
    expect(messageRelanceImpaye('mise_en_demeure', { ...base, contact: contact() }))
      .toContain('demeure impayée');
  });

  it('n’invente aucun montant quand il est inconnu', () => {
    const message = messageRelanceImpaye('rappel_court', {
      entreprise: 'X', montantDu: null, devise: 'XOF', reference: 'FAC-1',
      echeance: '2026-10-01', contact: contact(),
    });
    expect(message).toContain('montant à confirmer');
    expect(message).not.toMatch(/\b0\b\s*(FCFA|XOF)/);
  });

  it('calcule les relances dues et écarte litiges, soldes et annulations', () => {
    const dues = relancesDues(
      [
        creance({ id: 'r1', dueDate: '2026-10-01' }),
        creance({ id: 'r2', dueDate: '2026-10-01', status: 'litige' }),
        creance({ id: 'r3', dueDate: '2026-10-01', status: 'annulee' }),
        // r4 échoit DANS LE FUTUR par rapport à la date de référence : elle ne
        // doit pas être relancée. C'est la garantie qui protège la relation client.
        creance({ id: 'r4', dueDate: '2026-12-20', initialAmount: 500000 }),
        // r5 est échue de peu : elle doit apparaître, en rappel cordial.
        creance({ id: 'r5', dueDate: '2026-11-20', initialAmount: 500000 }),
      ],
      [],
      [],
      [contact()],
      { aujourdHui: '2026-11-25' },
    );
    // r4 n'est pas échue ; r2 (litige) et r3 (annulée) ne se relancent pas ici.
    // Le tri place la plus ancienne en tête.
    expect(dues.map((due) => due.receivable.id)).toEqual(['r1', 'r5']);
    expect(dues[0].joursDeRetard).toBe(55);
    expect(dues[0].etape).toBe('mise_en_demeure');
    expect(dues[0].montantDu).toBe(500000);
    expect(dues[0].contact?.firstName).toBe('Awa');
  });

  it('marque une étape déjà faite pour ne pas la répéter', () => {
    const reminders = [
      reminderFromRecord(record('m1', 'bg_module_receivable_reminders', {
        receivableId: 'r1', contactId: 'k1', dueDate: '2026-10-01', channel: 'email',
        template: 'rappel_court', message: 'msg', status: 'termine',
      })),
    ];
    const [due] = relancesDues(
      [creance({ dueDate: '2026-11-20' })], [], reminders, [contact()], { aujourdHui: '2026-11-25' },
    );
    expect(due.etape).toBe('rappel_court');
    expect(due.dejaFaite).toBe(true);
    // Une relance ANNULÉE ne compte pas comme faite.
    const annulee = [reminderFromRecord(record('m2', 'bg_module_receivable_reminders', {
      receivableId: 'r1', contactId: 'k1', template: 'rappel_court', status: 'annule',
    }))];
    expect(relancesDues([creance({ dueDate: '2026-11-20' })], [], annulee, [contact()], { aujourdHui: '2026-11-25' })[0].dejaFaite).toBe(false);
  });

  it('n’additionne pas des montants dont la devise est inconnue', () => {
    const dues = relancesDues([creance()], [], [], [contact()], { aujourdHui: '2026-11-25' });
    expect(totalRelancable(dues, 'XOF')).toBe(500000);
    expect(totalRelancable(dues, '')).toBeNull();
    // Un montant inconnu rend le total inconnu, il ne vaut pas 0.
    const sansMontant = relancesDues([creance({ initialAmount: null })], [], [], [contact()], { aujourdHui: '2026-11-25' });
    expect(sansMontant[0].montantDu).toBeNull();
    expect(totalRelancable(sansMontant, 'XOF')).toBeNull();
  });

  it('signale les étapes qui exigent une décision humaine', () => {
    const [recente] = relancesDues([creance({ dueDate: '2026-11-20' })], [], [], [contact()], { aujourdHui: '2026-11-25' });
    const [ancienne] = relancesDues([creance({ dueDate: '2026-05-01' })], [], [], [contact()], { aujourdHui: '2026-11-25' });
    expect(recente.decisionRequise).toBe(false);
    expect(ancienne.etape).toBe('contentieux');
    expect(ancienne.decisionRequise).toBe(true);
  });

  it('décrit la prochaine échéance de la séquence', () => {
    const [due] = relancesDues([creance({ dueDate: '2026-11-20' })], [], [], [contact()], { aujourdHui: '2026-11-25' });
    expect(due.prochaine).toContain('Relance ferme');
  });
});

describe('Écran Recouvrement — visible et honnête', () => {
  function mockData(options: { reminders?: Array<Record<string, unknown>> } = {}) {
    api.listModuleRecords.mockImplementation(async (category: string) => {
      if (category === 'bg_module_receivables') {
        // Échéance FIXE dans un passé lointain : le test reste vrai quelle que
        // soit la date d'exécution (aucun `jour` en dur dans les assertions).
        return { records: [record('r1', category, {
          reference: 'FAC-42', contactId: 'k1', initialAmount: 500000,
          issuedAt: '2019-12-01', dueDate: '2020-01-01', status: 'en_attente',
        })] };
      }
      if (category === 'bg_module_crm_contacts') {
        return { records: [record('k1', category, { firstName: 'Awa', lastName: 'Traoré', country: 'Mali', email: 'awa@example.test', type: 'client' })] };
      }
      if (category === 'bg_module_receivable_reminders') {
        return { records: options.reminders ?? [] };
      }
      return { records: [] };
    });
  }

  it('affiche la créance, son retard, son étape et son montant', async () => {
    mockData();
    render(<ToastProvider><RecouvrementWorkspace workspaceId={WS} onOpenFinance={() => {}} /></ToastProvider>);

    const panneau = await screen.findByTestId('recouvrement-workspace');
    await waitFor(() => expect(panneau.textContent).toContain('FAC-42'));
    expect(panneau.textContent).toContain('Awa Traoré');
    expect(panneau.textContent).toMatch(/jour\(s\) de retard/);
    // L'étape affichée est celle du badge de CETTE créance (« À décider » pour
    // un retard de plus de 60 jours), et non l'un des libellés de réglage.
    const ligne = panneau.querySelector('[data-etape]');
    expect(ligne?.getAttribute('data-etape')).toBe('contentieux');
    expect(panneau.textContent).toContain('À décider');
    expect(panneau.textContent).toContain('Décision à prendre');
  });

  it('prépare un message copiable et n’envoie rien', async () => {
    mockData();
    const writeText = vi.fn<(texte: string) => Promise<void>>(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<ToastProvider><RecouvrementWorkspace workspaceId={WS} onOpenFinance={() => {}} /></ToastProvider>);
    await screen.findByTestId('recouvrement-workspace');
    fireEvent.click(await screen.findByRole('button', { name: /copier le message/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const texte = writeText.mock.calls[0][0];
    expect(texte).toContain('FAC-42');
    expect(texte).toContain('Awa Traoré');
    // Aucune écriture n'a eu lieu au simple fait de copier.
    expect(api.createModuleRecord).not.toHaveBeenCalled();
  });

  it('enregistre une relance faite dans le bon journal, avec son étape', async () => {
    mockData();
    api.createModuleRecord.mockResolvedValue({ recordId: 'm9' });

    render(<ToastProvider><RecouvrementWorkspace workspaceId={WS} onOpenFinance={() => {}} /></ToastProvider>);
    await screen.findByTestId('recouvrement-workspace');
    fireEvent.click(await screen.findByRole('button', { name: /marquer comme relancée/i }));

    await waitFor(() => expect(api.createModuleRecord).toHaveBeenCalledTimes(1));
    const [categorie, data, , workspaceId] = api.createModuleRecord.mock.calls[0];
    expect(categorie).toBe('bg_module_receivable_reminders');
    expect(workspaceId).toBe(WS);
    // Échéance 2020 → plus de 60 jours de retard → étape « contentieux ».
    expect(data).toMatchObject({ receivableId: 'r1', template: 'contentieux', status: 'termine', channel: 'email' });
  });

  it('affiche un état vide sans inventer de créance', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [] });
    render(<ToastProvider><RecouvrementWorkspace workspaceId={WS} onOpenFinance={() => {}} /></ToastProvider>);

    const panneau = await screen.findByTestId('recouvrement-workspace');
    await waitFor(() => expect(panneau.textContent).toContain('Aucune créance à relancer'));
  });

  it('signale un montant inconnu au lieu d’afficher zéro', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => {
      if (category === 'bg_module_receivables') {
        return { records: [record('r1', category, { reference: 'FAC-7', contactId: 'k1', dueDate: '2020-01-01', status: 'en_attente' })] };
      }
      return { records: [] };
    });
    render(<ToastProvider><RecouvrementWorkspace workspaceId={WS} onOpenFinance={() => {}} /></ToastProvider>);

    const panneau = await screen.findByTestId('recouvrement-workspace');
    await waitFor(() => expect(panneau.textContent).toContain('Montant dû inconnu'));
    expect(panneau.textContent).not.toContain('Reste dû : 0');
  });
});
