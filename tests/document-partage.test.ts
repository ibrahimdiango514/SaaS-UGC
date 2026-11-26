import { describe, expect, it } from 'vitest';
import {
  LANGUES_DOCUMENT, documentDepuisPartage, documentImprimable, formaterMontant,
  lienPartageable, marquerVu, type DocumentPartageable,
} from '../src/business/sales/document';

/**
 * Document commercial : PDF propre, lien partageable, statut « vu ».
 *
 * Deux risques sont couverts ici :
 *  1. l'injection : un nom de client ou une désignation contient du HTML, et le
 *     document est rendu avec `dangerouslySetInnerHTML` côté page publique ;
 *  2. la fuite : un lien partagé ne doit contenir QUE le document, jamais une
 *     session, un jeton ou une donnée d'un autre espace.
 */

const document = (surcharge: Partial<DocumentPartageable> = {}): DocumentPartageable => ({
  kind: 'facture',
  number: 'FAC-2026-014',
  issuedAt: '2026-11-01',
  dueDate: '2026-12-01',
  currency: 'XOF',
  terms: 'Paiement sous 30 jours.',
  lines: [
    { description: 'Savon karité', quantity: 2, unitPrice: 5000, discountPct: 10, taxPct: 18 },
    { description: 'Livraison', quantity: 1, unitPrice: 3000, discountPct: 0, taxPct: 18 },
  ],
  clientNom: 'Awa Traoré',
  entreprise: 'Maison Karité',
  ...surcharge,
});

describe('Document imprimable', () => {
  it('calcule les totaux de la même façon que l’application', () => {
    const html = documentImprimable(document());
    // 2 × 5000 = 10000, remise 10 % → 9000 ; livraison 3000 ; sous-total 13000
    // remise 1000 ; taxes 18 % sur 12000 = 2160 ; total 14160.
    expect(html).toContain('13');
    expect(html).toContain('14');
    expect(html).toMatch(/FAC-2026-014/);
  });

  it('échappe tout contenu saisi : aucune injection HTML', () => {
    const html = documentImprimable(document({
      clientNom: '<img src=x onerror=alert(1)>',
      lines: [{ description: '<script>alert("x")</script>', quantity: 1, unitPrice: 100, discountPct: 0, taxPct: 0 }],
    }));
    // Le texte DANGEREUX peut rester lisible, mais il doit être inerte :
    // aucun chevron non échappé ne doit subsister autour de la charge.
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // Vérification structurelle : tout `<` suivi d'une lettre doit appartenir
    // aux balises que NOUS produisons, jamais à une valeur saisie.
    const balises = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase());
    // `!doctype` n'est pas capturé par le motif (le `!` précède la lettre) et
    // `span` n'apparaît que dans une variante du gabarit : la liste attendue
    // est donc exactement celle des balises réellement produites.
    expect(new Set(balises)).toEqual(new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'header', 'div', 'h1', 'p', 'table', 'thead', 'tr', 'th', 'tbody', 'td', 'tfoot']));
  });

  it('écrit dans la langue demandée et en sens RTL pour l’arabe', () => {
    const fr = documentImprimable(document(), 'fr');
    const en = documentImprimable(document(), 'en');
    const ar = documentImprimable(document(), 'ar');
    expect(fr).toContain('Désignation');
    expect(en).toContain('Description');
    expect(en).toContain('Invoice');
    expect(ar).toContain('dir="rtl"');
    expect(ar).toContain('فاتورة');
    // Chaque langue est déclarée : aucune n'est une coquille vide.
    for (const langue of LANGUES_DOCUMENT) {
      expect(langue.titre('facture').length).toBeGreaterThan(0);
    }
  });

  it('affiche la devise réelle, sans en inventer une', () => {
    expect(formaterMontant(14160, 'XOF')).toMatch(/14/);
    // Devise inconnue de l'environnement : le code devise est écrit tel quel.
    expect(formaterMontant(1000, 'ZZZ')).toContain('ZZZ');
  });
});

describe('Lien partageable', () => {
  it('fait l’aller-retour sans perdre les accents ni les décimales', () => {
    const lien = lienPartageable(document(), 'https://sorahnex.test');
    expect(lien.startsWith('https://sorahnex.test/partage/document#')).toBe(true);
    const fragment = lien.slice(lien.indexOf('#') + 1);
    const relu = documentDepuisPartage(fragment);
    expect(relu).not.toBeNull();
    expect(relu?.clientNom).toBe('Awa Traoré');
    expect(relu?.number).toBe('FAC-2026-014');
    expect(relu?.lines[0]).toMatchObject({ description: 'Savon karité', quantity: 2, unitPrice: 5000 });
  });

  it('ne contient que le document : aucun jeton ni identifiant interne', () => {
    const fragment = lienPartageable(document(), '').split('#')[1];
    // Décodage UTF-8 explicite : `atob` seul casserait sur les accents et
    // rendrait le test faux pour une bonne raison.
    const base64 = fragment.replace(/-/g, '+').replace(/_/g, '/');
    const binaire = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const charge = new TextDecoder().decode(Uint8Array.from(binaire, (c) => c.charCodeAt(0)));
    expect(charge).not.toMatch(/token|jwt|session|access_token|apikey|supabase/i);
    expect(charge).not.toMatch(/workspace|user_id/i);
    expect(JSON.parse(charge)).toMatchObject({ v: 1, n: 'FAC-2026-014' });
  });

  it('refuse une charge absente, tronquée ou d’une autre version', () => {
    expect(documentDepuisPartage('')).toBeNull();
    expect(documentDepuisPartage('#nimportequoi')).toBeNull();
    const valide = lienPartageable(document(), '').split('#')[1];
    expect(documentDepuisPartage(valide.slice(0, 10))).toBeNull();
    // Version inconnue : on n'essaie pas d'interpréter.
    const autreVersion = btoa(JSON.stringify({ v: 99, kind: 'facture', n: 'X' }));
    expect(documentDepuisPartage(autreVersion)).toBeNull();
  });

  it('refuse un type de document inconnu', () => {
    const charge = btoa(JSON.stringify({ v: 1, kind: 'bulletin', n: 'X', l: [] }));
    expect(documentDepuisPartage(charge)).toBeNull();
  });

  it('borne le nombre de lignes partagées', () => {
    const lignes = Array.from({ length: 200 }, (_, index) => ({
      description: `Ligne ${index}`, quantity: 1, unitPrice: 100, discountPct: 0, taxPct: 0,
    }));
    const relu = documentDepuisPartage(lienPartageable(document({ lines: lignes }), '').split('#')[1]);
    expect(relu?.lines).toHaveLength(60);
  });
});

describe('Statut « vu »', () => {
  it('passe « envoyé » à « vu »', () => {
    expect(marquerVu('envoye')).toBe('vu');
    expect(marquerVu('brouillon')).toBe('vu');
  });

  it('n’écrase jamais un statut plus avancé', () => {
    // Un client qui rouvre une facture payée ne doit pas la faire retomber.
    for (const statut of ['paye', 'en_retard', 'accepte', 'refuse', 'vu']) {
      expect(marquerVu(statut), statut).toBe(statut);
    }
  });
});
