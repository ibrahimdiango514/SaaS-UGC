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
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/context/ToastContext';
import { MessagesWorkspace } from '../src/business/marketing/MessagesWorkspace';
import { EcheancesWorkspace, CATEGORIE_ECHEANCES } from '../src/business/compliance/EcheancesWorkspace';
import { VeilleWorkspace } from '../src/business/growth/VeilleWorkspace';
import { BriefStudioWorkspace } from '../src/business/growth/BriefStudioWorkspace';
import {
  MODELES, lienMailto, lienWhatsApp, remplirModele, trousDuMessage,
} from '../src/business/marketing/messages';
import {
  AVERTISSEMENT_CONFORMITE, dateReelle, echeancesVues, prochaineOccurrence,
  type Echeance,
} from '../src/business/compliance/echeances';
import { comparerPrix, fichesConcurrents, importerConcurrentsCsv, signalRecent, syntheseVeille } from '../src/business/growth/veille';
import { chiffresParProduit, construireBriefStudio } from '../src/business/growth/briefStudio';
import type { Invoice } from '../src/business/sales/model';
import type { Product } from '../src/business/catalog/model';
import type { GrowthSignal } from '../src/business/growth/model';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const WS = '11111111-1111-4111-8111-111111111111';
const record = (id: string, category: string, data: Record<string, unknown>) => ({
  id, category, data, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
});

/* ------------------------------------------------------------------ messages */

describe('Messages préparés — aucun envoi, aucun trou caché', () => {
  it('remplit le modèle et laisse VISIBLE une variable manquante', () => {
    const texte = remplirModele('facture_en_retard', 'fr', { client: 'Awa', numero: 'FAC-9' });
    expect(texte).toContain('Bonjour Awa');
    expect(texte).toContain('FAC-9');
    // Le montant n'a pas été fourni : il reste `{{montant}}`, pas un blanc.
    expect(trousDuMessage(texte)).toContain('montant');
  });

  it('écrit dans la langue du client', () => {
    const en = remplirModele('relance_douce', 'en', { client: 'John', numero: 'INV-2' });
    expect(en).toContain('Hello John');
    expect(en).toContain('friendly reminder');
  });

  it('couvre chaque situation par un modèle réel', () => {
    for (const modele of MODELES) {
      const fr = remplirModele(modele.situation, 'fr', {});
      const en = remplirModele(modele.situation, 'en', {});
      expect(fr.length, modele.situation).toBeGreaterThan(20);
      expect(en.length, modele.situation).toBeGreaterThan(20);
    }
  });

  it('n’envoie jamais rien : les liens sont des liens, pas des appels', () => {
    expect(lienMailto('awa@example.test', 'Sujet', 'Corps')).toMatch(/^mailto:awa%40example\.test\?/);
    expect(lienWhatsApp('+223 70 00 00 00', 'Bonjour')).toBe('https://wa.me/22370000000?text=Bonjour');
    // Un numéro vide ne produit pas de lien cassé.
    expect(lienWhatsApp('', 'Bonjour')).toBe('');
  });

  it('affiche un message rempli depuis les vraies données du contact', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => {
      if (category === 'bg_module_crm_contacts') {
        return { records: [record('k1', category, { firstName: 'Awa', lastName: 'Traoré', email: 'awa@example.test', type: 'client' })] };
      }
      if (category === 'bg_module_sales_quotes') {
        return { records: [record('q1', category, {
          number: 'DEV-7', contactId: 'k1', status: 'envoye', issuedAt: '2026-11-01',
          expiresAt: '2026-12-01', currency: 'XOF',
          lines: [{ description: 'Savon', quantity: 2, unitPrice: 5000, discountPct: 0, taxPct: 0 }],
        })] };
      }
      return { records: [] };
    });

    render(<ToastProvider><MessagesWorkspace workspaceId={WS} /></ToastProvider>);
    const panneau = await screen.findByTestId('messages-workspace');
    await waitFor(() => expect(panneau.textContent).toContain('DEV-7'));
    const champ = screen.getByLabelText('Message préparé') as HTMLTextAreaElement;
    expect(champ.value).toContain('DEV-7');
    // Le montant vient de `computeTotals`, pas d'une valeur inventée.
    expect(champ.value).toContain('10');
  });

  it('n’affiche aucun bouton d’envoi automatique', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [] });
    render(<ToastProvider><MessagesWorkspace workspaceId={WS} /></ToastProvider>);
    await screen.findByTestId('messages-workspace');
    const boutons = screen.getAllByRole('button').map((bouton) => bouton.textContent ?? '');
    expect(boutons.some((texte) => /^envoyer$/i.test(texte.trim()))).toBe(false);
    expect(screen.getByText(/Aucun message n’est envoyé par l’application/i)).toBeTruthy();
  });
});

/* --------------------------------------------------------------- échéances */

describe('Échéances — des dates, jamais de conseil', () => {
  const echeance = (surcharge: Partial<Echeance> = {}): Echeance => ({
    id: 'e1', label: 'Déclaration', categorie: 'taxes', date: '2026-12-15',
    recurrence: 'aucune', notes: '', verifiee: false, ...surcharge,
  });

  it('refuse une date qui n’existe pas', () => {
    expect(dateReelle('2026-02-31')).toBe(false);
    expect(dateReelle('2026-02-28')).toBe(true);
    expect(dateReelle('15/12/2026')).toBe(false);
  });

  it('reporte une échéance annuelle au lieu de la dire « passée depuis 2 ans »', () => {
    expect(prochaineOccurrence(echeance({ date: '2024-03-01', recurrence: 'annuelle' }), '2026-11-25')).toBe('2027-03-01');
    expect(prochaineOccurrence(echeance({ date: '2026-12-15', recurrence: 'annuelle' }), '2026-11-25')).toBe('2026-12-15');
    // Sans récurrence, la date d'origine est conservée, même passée.
    expect(prochaineOccurrence(echeance({ date: '2025-01-01', recurrence: 'aucune' }), '2026-11-25')).toBe('2025-01-01');
  });

  it('classe par urgence et n’oublie pas une échéance dépassée', () => {
    const vues = echeancesVues([
      echeance({ id: 'a', date: '2026-11-20' }),
      echeance({ id: 'b', date: '2026-11-25' }),
      echeance({ id: 'c', date: '2027-06-01' }),
    ], '2026-11-25');
    expect(vues.map((vue) => vue.echeance.id)).toEqual(['a', 'b', 'c']);
    expect(vues[0].urgence).toBe('passee');
    expect(vues[1].urgence).toBe('aujourdhui');
    expect(vues[2].urgence).toBe('a_venir');
  });

  it('porte un avertissement explicite, présent dans le code', () => {
    expect(AVERTISSEMENT_CONFORMITE).toMatch(/ni un conseil fiscal, ni un conseil juridique/i);
  });

  it('enregistre une échéance dans la catégorie dédiée et affiche l’avertissement', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [] });
    api.createModuleRecord.mockResolvedValue({ recordId: 'e9' });

    render(<ToastProvider><EcheancesWorkspace workspaceId={WS} /></ToastProvider>);
    const panneau = await screen.findByTestId('echeances-workspace');
    expect(panneau.textContent).toContain('conseil fiscal');

    fireEvent.change(screen.getByLabelText('Nom de l’échéance'), { target: { value: 'Cotisation retraite' } });
    fireEvent.change(screen.getByLabelText('Date de l’échéance'), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: /ajouter/i }));

    await waitFor(() => expect(api.createModuleRecord).toHaveBeenCalledTimes(1));
    const [categorie, data] = api.createModuleRecord.mock.calls[0];
    expect(categorie).toBe(CATEGORIE_ECHEANCES);
    expect(data).toMatchObject({ label: 'Cotisation retraite', date: '2026-12-31' });
  });

  it('refuse une date impossible à la saisie', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [] });
    render(<ToastProvider><EcheancesWorkspace workspaceId={WS} /></ToastProvider>);
    await screen.findByTestId('echeances-workspace');

    fireEvent.change(screen.getByLabelText('Nom de l’échéance'), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText('Date de l’échéance'), { target: { value: '2026-02-31' } });
    fireEvent.click(screen.getByRole('button', { name: /ajouter/i }));

    await waitFor(() => expect(screen.getByText(/Cette date n’existe pas/i)).toBeTruthy());
    expect(api.createModuleRecord).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------- veille */

describe('Veille — comparaison honnête', () => {
  it('ne compare pas des devises différentes', () => {
    const resultat = comparerPrix(150, 100000, 'EUR', 'XOF');
    expect(resultat.ecartPourcent).toBeNull();
    expect(resultat.raison).toMatch(/Devises différentes/);
  });

  it('calcule un écart quand tout est comparable', () => {
    expect(comparerPrix(80, 100, 'XOF', 'XOF').ecartPourcent).toBe(-20);
    expect(comparerPrix(120, 100, 'XOF', 'XOF').ecartPourcent).toBe(20);
  });

  it('n’invente pas de prix manquant', () => {
    const [fiche] = fichesConcurrents([{ nom: 'Rival' }], 100, 'XOF');
    expect(fiche.ecartPourcent).toBeNull();
    expect(fiche.incompletudes).toContain('Prix non relevé');
  });

  it('ne qualifie pas de « récent » un signal daté dans le futur', () => {
    const signal = { observedAt: '2027-01-01' } as GrowthSignal;
    expect(signalRecent(signal, '2026-11-25')).toBe(false);
    expect(signalRecent({ observedAt: '2026-11-20' } as GrowthSignal, '2026-11-25')).toBe(true);
  });

  it('dit ce qui manque au lieu de conclure sans donnée', () => {
    const synthese = syntheseVeille([], [], '2026-11-25');
    expect(synthese.vide).toBe(true);
    expect(synthese.constats).toHaveLength(0);
    expect(synthese.manques.length).toBeGreaterThan(0);
  });

  it('importe un CSV en signalant les lignes ignorées', () => {
    const resultat = importerConcurrentsCsv('nom;prix;devise\nRival;1200;XOF\n;500;XOF\nAutre;800;XOF');
    expect(resultat.concurrents.map((concurrent) => concurrent.nom)).toEqual(['Rival', 'Autre']);
    expect(resultat.ignorees).toBe(1);
    expect(resultat.concurrents[0].prix).toBe(1200);
  });

  it('refuse un CSV sans colonne « nom »', () => {
    const resultat = importerConcurrentsCsv('prix,devise\n1200,XOF');
    expect(resultat.concurrents).toHaveLength(0);
    expect(resultat.erreurs[0]).toMatch(/« nom » absente/);
  });

  it('affiche l’état vide sans fabriquer de synthèse', async () => {
    render(<ToastProvider><VeilleWorkspace memory={null} prixMaison={null} /></ToastProvider>);
    const panneau = await screen.findByTestId('veille-workspace');
    expect(panneau.textContent).toContain('Aucune donnée de veille');
    expect(panneau.textContent).toContain('elle serait inventée');
  });
});

/* -------------------------------------------------------------------- brief */

describe('Du chiffre à la vidéo — chiffres réels, aucun débit', () => {
  const facture = (surcharge: Partial<Invoice> = {}): Invoice => ({
    id: 'f1', number: 'FAC-1', contactId: 'k1', orderId: '', quoteId: '',
    status: 'envoyee', issuedAt: '2026-11-01', dueDate: '2026-12-01', terms: '', notes: '',
    currency: 'XOF',
    lines: [{ id: 'l1', productId: 'p1', description: 'Savon', quantity: 10, unitPrice: 5000, discountPct: 0, taxPct: 0 }],
    receivableId: '', createdAt: '', updatedAt: '', ...surcharge,
  });
  const produit = (surcharge: Partial<Product> = {}): Product => ({
    id: 'p1', name: 'Savon', sku: 'SAV-1', price: 5000, cost: 2000, stock: 10, unit: 'pièce',
    category: '', description: '', active: true, createdAt: '', updatedAt: '', ...surcharge,
  } as Product);

  it('classe les produits sur les factures réelles, pas sur les désignations libres', () => {
    const chiffres = chiffresParProduit([facture()], [produit()]);
    expect(chiffres).toHaveLength(1);
    expect(chiffres[0].produit).toBe('Savon');
    expect(chiffres[0].quantite).toBe(10);
    expect(chiffres[0].chiffreAffaires).toBe(50000);
    expect(chiffres[0].marge).toBe(30000);
  });

  it('laisse la marge inconnue quand le coût manque', () => {
    const chiffres = chiffresParProduit([facture()], [produit({ cost: null })]);
    expect(chiffres[0].marge).toBeNull();
  });

  it('exclut les brouillons : ils ne sont pas du chiffre d’affaires', () => {
    expect(chiffresParProduit([facture({ status: 'brouillon' })], [produit()])).toHaveLength(0);
  });

  it('construit un brief qui cite ses chiffres et ne promet aucun résultat', () => {
    const brief = construireBriefStudio({
      invoices: [facture()], produits: [produit()], nomEntreprise: 'Maison Karité',
    });
    expect(brief.vide).toBe(false);
    expect(brief.texte).toContain('Savon');
    expect(brief.texte).toContain('Maison Karité');
    expect(brief.texte).toMatch(/10 unité\(s\) facturée\(s\)/);
    expect(brief.texte).toMatch(/aucun chiffre de résultat n’est promis/i);
    // Aucune promesse de croissance chiffrée.
    expect(brief.texte).not.toMatch(/\+\s?\d+\s?%/);
    // L'état est directement consommable par Studio.
    expect(brief.state.ugcBrief).toMatchObject({ product: 'Savon', source: 'business_grow' });
  });

  it('signale l’absence de coût sans afficher de marge', () => {
    const brief = construireBriefStudio({
      invoices: [facture()], produits: [produit({ cost: null })], nomEntreprise: 'X',
    });
    expect(brief.manques.join(' ')).toMatch(/Coût d’achat inconnu/);
  });

  it('affiche la carte et le bouton « sans débit » vers Studio', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => {
      if (category === 'bg_module_sales_invoices') {
        return { records: [record('f1', category, {
          number: 'FAC-1', contactId: 'k1', status: 'envoyee', issuedAt: '2026-11-01',
          dueDate: '2026-12-01', currency: 'XOF',
          lines: [{ productId: 'p1', description: 'Savon', quantity: 10, unitPrice: 5000, discountPct: 0, taxPct: 0 }],
        })] };
      }
      if (category === 'bg_module_catalog_products') {
        return { records: [record('p1', category, { name: 'Savon', sku: 'SAV-1', price: 5000, cost: 2000, stock: 10 })] };
      }
      return { records: [] };
    });

    render(
      <MemoryRouter>
        <ToastProvider><BriefStudioWorkspace workspaceId={WS} nomEntreprise="Maison Karité" /></ToastProvider>
      </MemoryRouter>,
    );
    const panneau = await screen.findByTestId('brief-studio-workspace');
    await waitFor(() => expect(panneau.textContent).toContain('Savon'));
    const lien = await screen.findByTestId('ouvrir-studio-sans-debit');
    expect(lien.getAttribute('href')).toBe('/app/studio');
    expect(lien.textContent).toMatch(/sans débit/i);
    expect(panneau.textContent).toContain('aucun débit');
  });

  it('n’invente pas de brief sans facture', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [] });
    render(
      <MemoryRouter>
        <ToastProvider><BriefStudioWorkspace workspaceId={WS} nomEntreprise="X" /></ToastProvider>
      </MemoryRouter>,
    );
    const panneau = await screen.findByTestId('brief-studio-workspace');
    await waitFor(() => expect(panneau.textContent).toContain('Aucun produit facturé'));
    expect(screen.queryByTestId('ouvrir-studio-sans-debit')).toBeNull();
  });
});
