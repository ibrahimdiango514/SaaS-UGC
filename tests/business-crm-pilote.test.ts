import { describe, expect, it } from 'vitest';
import {
  CHAMPS_CAPTURE, delaiRelance, joursDepuisContact, messageRelance, montantEnJeu,
  prochaineAction, prospectsAPiloter, validerCapture,
} from '../src/business/crm/pilote';
import type { Contact, Opportunity } from '../src/business/crm/model';

const contact = (partiel: Partial<Contact> & { id: string }): Contact => ({
  firstName: 'Awa', lastName: 'Traoré', company: 'Atelier Awa', jobTitle: '', phone: '',
  whatsapp: '', email: '', address: '', city: '', country: 'ML', source: 'site', type: 'prospect',
  tags: [], notes: '', owner: '', lastContactAt: '', nextAction: '', nextActionAt: '',
  status: 'actif', createdAt: '', updatedAt: '',
  ...partiel,
} as Contact);

const opportunite = (partiel: Partial<Opportunity> & { id: string }): Opportunity => ({
  contactId: 'k1', title: 'Refonte', stage: 'proposition', amount: 200000, currency: 'XOF',
  expectedCloseAt: '', owner: '', notes: '', createdAt: '', updatedAt: '',
  ...partiel,
} as Opportunity);

describe('Pilote des prospects — action obligatoire', () => {
  it('respecte une action déjà planifiée par l’utilisateur', () => {
    const action = prochaineAction(contact({ id: 'k1', nextAction: 'Envoyer le devis', nextActionAt: '2026-12-01' }), {
      daysSinceContact: 20, openValue: 0, aujourdhui: '2026-11-25',
    });
    expect(action.dejaPlanifiee).toBe(true);
    expect(action.libelle).toBe('Envoyer le devis');
    expect(action.quand).toBe('2026-12-01');
  });

  it('propose une action datée quand rien n’est planifié (un prospect sans action est oublié)', () => {
    const action = prochaineAction(contact({ id: 'k1' }), {
      daysSinceContact: 20, openValue: 0, aujourdhui: '2026-11-25',
    });
    expect(action.dejaPlanifiee).toBe(false);
    expect(action.quand).toBe('2026-11-27'); // 20 jours → relance sous 2 jours
    expect(action.pourquoi).toContain('20');
  });

  it('demande la date du dernier contact quand elle manque, au lieu de deviner', () => {
    const action = prochaineAction(contact({ id: 'k1' }), {
      daysSinceContact: null, openValue: 0, aujourdhui: '2026-11-25',
    });
    expect(action.libelle).toContain('Renseigner la date');
    expect(action.quand).toBe('2026-11-25');
  });

  it('relance d’abord ce qui a de l’argent en jeu', () => {
    const action = prochaineAction(contact({ id: 'k1' }), {
      daysSinceContact: 5, openValue: 450000, aujourdhui: '2026-11-25',
    });
    expect(action.libelle).toContain('opportunité');
    expect(action.pourquoi).toContain('450');
  });

  it('raccourcit le délai quand le contact vieillit, sans jamais descendre sous 1 jour', () => {
    expect(delaiRelance(null)).toBe(1);
    expect(delaiRelance(40)).toBe(1);
    expect(delaiRelance(20)).toBe(2);
    expect(delaiRelance(10)).toBe(3);
    expect(delaiRelance(2)).toBe(7);
  });

  it('ne calcule aucun montant quand rien n’est chiffré', () => {
    expect(montantEnJeu(contact({ id: 'k1' }), [])).toBeNull();
    expect(montantEnJeu(contact({ id: 'k1' }), [opportunite({ id: 'o1', amount: 0 })])).toBeNull();
    expect(montantEnJeu(contact({ id: 'k1' }), [opportunite({ id: 'o1', amount: null })])).toBeNull();
  });

  it('ignore les opportunités gagnées ou perdues', () => {
    const montant = montantEnJeu(contact({ id: 'k1' }), [
      opportunite({ id: 'o1', stage: 'gagne', amount: 500000 }),
      opportunite({ id: 'o2', stage: 'perdu', amount: 500000 }),
      opportunite({ id: 'o3', stage: 'qualifie', amount: 100000 }),
    ]);
    expect(montant).toBe(100000);
  });

  it('rend la date du dernier contact, ou null si elle est absente', () => {
    expect(joursDepuisContact(contact({ id: 'k1', lastContactAt: '2026-11-20' }), '2026-11-25')).toBe(5);
    expect(joursDepuisContact(contact({ id: 'k1' }), '2026-11-25')).toBeNull();
  });

  it('classe les actions dues avant les autres, puis par montant, puis par score', () => {
    const contacts = [
      contact({ id: 'a', nextAction: 'Rappeler', nextActionAt: '2026-11-20' }),
      contact({ id: 'b' }),
      contact({ id: 'c', type: 'fournisseur' }),
      contact({ id: 'd', status: 'archive' }),
    ];
    const classement = prospectsAPiloter(contacts, {
      scoreDe: () => 10,
      montantDe: (k) => (k.id === 'b' ? 300000 : null),
      daysSinceContactDe: () => 10,
      aujourdhui: '2026-11-25',
    });
    expect(classement.map((p) => p.contact.id)).toEqual(['a', 'b']);
  });

  it('borne le nombre de prospects affichés', () => {
    const contacts = Array.from({ length: 12 }, (_, i) => contact({ id: `k${i}` }));
    expect(prospectsAPiloter(contacts, {
      scoreDe: () => 1, montantDe: () => null, daysSinceContactDe: () => 5, aujourdhui: '2026-11-25',
    }).length).toBe(5);
  });
});

describe('Capture de prospect — donnée publique, nettoyée', () => {
  it('accepte un prospect minimal', () => {
    const resultat = validerCapture({ nom: 'Moussa' });
    expect(resultat.valide).toBe(true);
    expect(resultat.donnees.nom).toBe('Moussa');
  });

  it('exige un nom', () => {
    expect(validerCapture({ email: 'a@b.co' }).valide).toBe(false);
  });

  it('refuse un e-mail invalide mais accepte son absence', () => {
    expect(validerCapture({ nom: 'A', email: 'pas-un-email' }).valide).toBe(false);
    expect(validerCapture({ nom: 'A', email: '' }).valide).toBe(true);
  });

  it('retire les balises : le formulaire est public', () => {
    const resultat = validerCapture({ nom: '<script>alert(1)</script>Awa', besoin: '<b>besoin</b> réel' });
    expect(resultat.donnees.nom).toBe('alert(1)Awa');
    expect(resultat.donnees.besoin).toBe('besoin réel');
  });

  it('borne la longueur des champs', () => {
    const resultat = validerCapture({ nom: 'A'.repeat(500), besoin: 'B'.repeat(5000) });
    expect(resultat.donnees.nom.length).toBe(120);
    expect(resultat.donnees.besoin.length).toBe(1000);
  });

  it('expose un formulaire court (5 champs, un seul obligatoire)', () => {
    expect(CHAMPS_CAPTURE.length).toBe(5);
    expect(CHAMPS_CAPTURE.filter((c) => c.obligatoire).length).toBe(1);
  });
});

describe('Message préparé — copié, jamais envoyé', () => {
  it('s’adresse au contact par son nom', () => {
    const action = prochaineAction(contact({ id: 'k1' }), { daysSinceContact: 10, openValue: 0, aujourdhui: '2026-11-25' });
    const message = messageRelance(contact({ id: 'k1' }), action, 'Atelier Awa');
    expect(message).toContain('Awa Traoré');
    expect(message).toContain('Atelier Awa');
  });

  it('reste en texte brut, sans lien ni envoi', () => {
    const action = prochaineAction(contact({ id: 'k1' }), { daysSinceContact: 10, openValue: 0, aujourdhui: '2026-11-25' });
    const message = messageRelance(contact({ id: 'k1' }), action, 'Atelier');
    expect(message).not.toMatch(/https?:\/\//);
    expect(message.length).toBeLessThanOrEqual(2000);
  });
});
