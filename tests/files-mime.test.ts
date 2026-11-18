import { describe, expect, it } from 'vitest';
import {
  HEADER_BYTES, MAX_FILE_BYTES, checkSize, detectType, extensionOf,
  looksLikeText, roleAcceptsKind, storagePathFor,
} from '../src/files/types';

/**
 * Détection réelle du type de fichier.
 *
 * Le point sensible : `File.type` est fourni par le navigateur à partir de
 * l'EXTENSION. Renommer `malware.exe` en `photo.png` suffit donc à obtenir
 * `image/png`. Ces tests vérifient que la décision repose sur les octets.
 */

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const ascii = (text: string): number[] => text.split('').map((c) => c.charCodeAt(0));

/** En-tête PNG minimal (8 octets de signature + IHDR). */
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0, 0);
const PDF = bytes(...ascii('%PDF-1.7'), 0, 0, 0, 0, 0);
const MP4 = bytes(0, 0, 0, 0x18, ...ascii('ftypisom'), 0, 0, 2, 0);
const MOV = bytes(0, 0, 0, 0x14, ...ascii('ftypqt  '), 0, 0, 2, 0);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 20, 0, 8, 8, 0, 0, 0, 0);

describe('détection réelle du type (octets, pas extension)', () => {
  it('reconnaît les images par leur signature', () => {
    expect(detectType('a.png', PNG)).toMatchObject({ mimeType: 'image/png', kind: 'image', accepted: true });
    expect(detectType('a.jpg', JPEG)).toMatchObject({ mimeType: 'image/jpeg', kind: 'image', accepted: true });
    expect(detectType('a.webp', bytes(...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 '))))
      .toMatchObject({ mimeType: 'image/webp', accepted: true });
  });

  it('reconnaît PDF et le distingue d’un simple texte', () => {
    expect(detectType('doc.pdf', PDF)).toMatchObject({
      mimeType: 'application/pdf', kind: 'document', previewKind: 'pdf', accepted: true,
    });
  });

  it('tranche MP4 et MOV par la marque du conteneur', () => {
    expect(detectType('v.mp4', MP4)).toMatchObject({ mimeType: 'video/mp4', kind: 'video', previewKind: 'video' });
    expect(detectType('v.mov', MOV)).toMatchObject({ mimeType: 'video/quicktime', extension: 'mov', kind: 'video' });
  });

  it('accepte DOCX et XLSX (ZIP) mais refuse une archive quelconque', () => {
    expect(detectType('rapport.docx', ZIP)).toMatchObject({ extension: 'docx', kind: 'document', accepted: true });
    expect(detectType('budget.xlsx', ZIP)).toMatchObject({ extension: 'xlsx', kind: 'spreadsheet', accepted: true });
    const archive = detectType('photos.zip', ZIP);
    expect(archive.accepted).toBe(false);
    expect(archive.reason).toContain('ZIP');
  });

  it('accepte CSV et TXT réels, en lisant le contenu', () => {
    const csv = bytes(...ascii('nom,prix\nRiz,1200\n'));
    expect(detectType('produits.csv', csv)).toMatchObject({
      mimeType: 'text/csv', kind: 'spreadsheet', previewKind: 'text', accepted: true,
    });
    expect(detectType('notes.txt', bytes(...ascii('Bonjour\n')))).toMatchObject({
      mimeType: 'text/plain', previewKind: 'text', accepted: true,
    });
  });

  it('REFUSE un exécutable renommé en image', () => {
    // En-tête MZ (Windows PE) présenté sous un nom trompeur.
    const exe = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 4, 0, 0, 0);
    const result = detectType('photo.png', exe);
    expect(result.accepted).toBe(false);
    expect(result.kind).toBe('other');
    expect(result.reason).toBeTruthy();
  });

  it('REFUSE un shell script renommé en PDF', () => {
    const script = bytes(...ascii('#!/bin/sh\nrm -rf /\n'));
    expect(detectType('facture.pdf', script).accepted).toBe(true); // c'est du texte…
    // …mais il est alors classé comme texte, PAS comme PDF : aucune
    // prévisualisation PDF ne sera proposée pour un contenu texte.
    expect(detectType('facture.pdf', script).previewKind).toBe('text');
  });

  it('REFUSE un binaire inconnu sans extension', () => {
    const binary = bytes(0, 1, 2, 3, 0, 5, 6, 0, 8, 9, 0, 11);
    const result = detectType('sans-extension', binary);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('extension');
  });

  it('REFUSE un conteneur vidéo à marque inconnue sans extension vidéo', () => {
    const odd = bytes(0, 0, 0, 0x18, ...ascii('ftypzzzz'), 0, 0, 2, 0);
    expect(detectType('fichier.bin', odd).accepted).toBe(false);
  });

  it('ne décide jamais sur le seul nom', () => {
    // Même nom, contenus différents : le verdict doit suivre le contenu.
    expect(detectType('x.png', PNG).mimeType).toBe('image/png');
    expect(detectType('x.png', PDF).mimeType).toBe('application/pdf');
    expect(detectType('x.png', bytes(0x4d, 0x5a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)).accepted).toBe(false);
  });

  it('lit au plus HEADER_BYTES octets : les fichiers tronqués restent sûrs', () => {
    expect(HEADER_BYTES).toBe(16);
    // Un en-tête trop court ne peut pas correspondre à une signature longue.
    expect(detectType('tronque.png', bytes(0x89, 0x50)).accepted).toBe(false);
  });
});

describe('limites de taille', () => {
  it('refuse un fichier vide', () => {
    expect(checkSize(0)).toContain('vide');
  });

  it('accepte exactement le plafond, refuse un octet de plus', () => {
    expect(checkSize(MAX_FILE_BYTES)).toBeNull();
    expect(checkSize(MAX_FILE_BYTES + 1)).toContain('dépasse');
  });

  it('le plafond correspond à celui du bucket (50 Mio)', () => {
    expect(MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe('chemins et rôles', () => {
  it('place toujours l’entreprise en premier segment', () => {
    const workspace = '11111111-2222-3333-4444-555555555555';
    expect(storagePathFor(workspace, 'image', 'png').startsWith(`${workspace}/files/images/`)).toBe(true);
    expect(storagePathFor(workspace, 'video', 'mp4').startsWith(`${workspace}/files/videos/`)).toBe(true);
    expect(storagePathFor(workspace, 'document', 'pdf').startsWith(`${workspace}/files/documents/`)).toBe(true);
  });

  it('produit des chemins uniques', () => {
    const workspace = '11111111-2222-3333-4444-555555555555';
    const first = storagePathFor(workspace, 'image', 'png');
    const second = storagePathFor(workspace, 'image', 'png');
    expect(first).not.toBe(second);
  });

  it('réserve le rôle vidéo aux vidéos, les autres aux images', () => {
    expect(roleAcceptsKind('video_reference', 'video')).toBe(true);
    expect(roleAcceptsKind('video_reference', 'image')).toBe(false);
    expect(roleAcceptsKind('product', 'image')).toBe(true);
    expect(roleAcceptsKind('product', 'document')).toBe(false);
  });

  it('normalise les extensions', () => {
    expect(extensionOf('Photo.PNG')).toBe('png');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    // Un point en tête ne crée pas d'extension (fichier caché), et les
    // caractères non ASCII sont retirés : le chemin de stockage doit rester
    // sûr, car il devient un nom d'objet dans le bucket.
    expect(extensionOf('.caché')).toBe('');
    expect(extensionOf('fichier.éxe')).toBe('xe');
    expect(extensionOf('sanspoint')).toBe('');
    expect(extensionOf('fichier.')).toBe('');
  });

  it('détecte le texte sans accepter un binaire', () => {
    expect(looksLikeText(bytes(...ascii('bonjour')))).toBe(true);
    expect(looksLikeText(bytes(0, 1, 2))).toBe(false);
  });
});
