// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';

/**
 * Preuve de rendu — panneau d'import universel, étape d'aperçu.
 *
 * Le fichier produit (`artifacts/import-universel.html`) montre l'écran d'aperçu
 * tel qu'il s'affiche quand le serveur renvoie un catalogue réel : prix,
 * catégories, variantes, prix à compléter et doublons. Il s'ouvre dans un
 * navigateur avec le CSS de l'application, ce qui rend l'écran vérifiable sans
 * exécuter l'application.
 *
 * L'aperçu vient désormais de l'Edge Function (`invokeEdge`), puisque l'analyse
 * a été déplacée côté serveur pour que l'abonnement soit contrôlé avant toute
 * lecture de fichier. La fixture reproduit donc la réponse serveur.
 */

const api = vi.hoisted(() => ({ createProduct: vi.fn(), invokeEdge: vi.fn() }));
vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...reel, createProduct: api.createProduct, invokeEdge: api.invokeEdge };
});

/** Aperçu serveur reproduisant le catalogue de démonstration. */
const APERCU = {
  previewId: 'apercu-demo',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  summary: { total: 4, importable: 3, duplicateInBatch: 1, duplicateExisting: 1, unpriced: 1 },
  products: [
    { index: 0, name: 'Sérum éclat', price: '12 000 XOF', currency: 'XOF', productUrl: 'https://boutique.example/serum', warnings: [], duplicate: null, importable: true },
    { index: 1, name: 'Baume lèvres', price: '4 500 XOF', currency: 'XOF', productUrl: 'https://boutique.example/baume', warnings: [], duplicate: 'existing', importable: true },
    { index: 2, name: 'Coffret découverte', price: 'à compléter', currency: 'XOF', productUrl: 'https://boutique.example/coffret', warnings: [], duplicate: null, importable: true },
    { index: 3, name: 'SERUM ECLAT', price: '12 000 XOF', currency: 'XOF', productUrl: 'https://boutique.example/serum-2', warnings: [], duplicate: 'in-batch', importable: false },
  ],
  rejected: [],
  warnings: [],
  origin: { kind: 'file', platform: 'unknown', endpoint: 'csv', reference: 'catalogue-boutique.csv' },
  connectedTo: '',
};

import { StoreImportPanel } from '../src/business/importer/StoreImportPanel';

const CATALOGUE = [
  'Nom;Prix;Devise;Catégorie;Description;Lien',
  'Sérum éclat;12 000;XOF;Soin;Sérum vitaminé concentré;https://boutique.example/serum',
  'Baume lèvres;4 500;XOF;Soin;Baume nourrissant;https://boutique.example/baume',
  'Coffret découverte;;XOF;Coffret;Trois formats à essayer;https://boutique.example/coffret',
  'SERUM ECLAT;12 000;XOF;Soin;Doublon volontaire du sérum;https://boutique.example/serum-2',
].join('\n');

const STYLES = `
  body { margin: 0; background: #070b12; color: #e2e8f0; font-family: ui-sans-serif, system-ui, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 28px 16px 48px; }
  .capture-title { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #64748b; margin: 0 0 4px; }
  .capture-sub { font-size: 12px; color: #475569; margin: 0 0 18px; }
  .capture-note { margin-top: 18px; font-size: 11px; color: #64748b; border-top: 1px solid rgba(255,255,255,.08); padding-top: 12px; }
`;

describe('preuve de rendu — import universel', () => {
  it('produit un artefact HTML à l’étape d’aperçu', async () => {
    cleanup();
    api.createProduct.mockResolvedValue({ id: 'p-1' });
    api.invokeEdge.mockResolvedValue({ data: APERCU });

    const { container } = render(
      <StoreImportPanel
        workspaceId="workspace-demo"
        existing={[{ id: 'p-existant', name: 'Baume lèvres' }]}
        onImported={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const fichier = new File([CATALOGUE], 'catalogue-boutique.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fichier] } });

    await waitFor(() => expect(screen.getByTestId('import-preview')).toBeTruthy());

    // L'aperçu serveur est bien celui affiché : doublons, prix manquant.
    expect(screen.getByText(/1 doublon\(s\) dans la source/i)).toBeTruthy();
    expect(screen.getByText(/1 déjà dans votre catalogue/i)).toBeTruthy();
    expect(screen.getByText(/1 sans prix/i)).toBeTruthy();
    expect(screen.getByText('à compléter')).toBeTruthy();
    // Rien n'a été écrit pendant l'aperçu.
    expect(api.createProduct).not.toHaveBeenCalled();

    const css = existsSync('dist/assets')
      ? readdirSync('dist/assets').filter((f) => f.endsWith('.css')).map((f) => readFileSync(`dist/assets/${f}`, 'utf8')).join('\n')
      : '';

    mkdirSync('artifacts', { recursive: true });
    const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SORAHNEX — Import universel de catalogue (preuve de rendu)</title>
<style>${css}</style>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <p class="capture-title">SORAHNEX · Grow → Croissance → Catalogue</p>
  <p class="capture-sub">Aperçu renvoyé par le serveur pour un CSV de 4 lignes. Rien n’a été enregistré.</p>
  ${container.innerHTML}
  <p class="capture-note">
    Doublon dans la source : « SERUM ECLAT » face à « Sérum éclat », détecté par empreinte insensible aux accents et à la casse.
    Doublon du catalogue : « Baume lèvres » déjà présent dans l’entreprise.
    Prix manquant : le coffret est conservé avec un prix à compléter, jamais remplacé par zéro.
  </p>
</div>
</body>
</html>`;

    writeFileSync('artifacts/import-universel.html', html, 'utf8');
    expect(existsSync('artifacts/import-universel.html')).toBe(true);
  });
});
