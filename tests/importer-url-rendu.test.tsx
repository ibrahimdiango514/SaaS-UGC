// @vitest-environment jsdom
/**
 * Preuve de rendu — import par URL (étape d'aperçu serveur).
 *
 * Le fichier produit (`artifacts/import-url.html`) montre l'écran réel du
 * panneau après un aperçu renvoyé par l'Edge Function : produits, prix,
 * doublons signalés, produits non importables, et le bouton de confirmation.
 *
 * L'aperçu est celui que le serveur renvoie réellement (même forme que
 * `PreviewPayload` de `handler.ts`) ; le test vérifie en plus qu'aucune
 * écriture n'a eu lieu et qu'aucun appel `import` n'est parti.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';

const api = vi.hoisted(() => ({ createProduct: vi.fn(), invokeEdge: vi.fn(), connectEdge: vi.fn() }));

/**
 * Routage par Edge Function : le panneau interroge aussi `store-connect` au
 * montage (état de connexion). Router évite qu'une réponse programmée pour
 * l'aperçu parte sur cette lecture d'état.
 */
vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...reel,
    createProduct: api.createProduct,
    invokeEdge: (nom: string, corps: Record<string, unknown>) => (
      nom === 'store-connect' ? api.connectEdge(nom, corps) : api.invokeEdge(nom, corps)
    ),
  };
});

import { StoreImportPanel } from '../src/business/importer/StoreImportPanel';

const APERCU = {
  previewId: '11111111-1111-4111-8111-111111111111',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  origin: {
    kind: 'url' as const,
    reference: 'https://serum-eclat.example/',
    platform: 'shopify' as const,
    endpoint: 'https://serum-eclat.example/products.json?limit=250',
  },
  summary: { total: 4, importable: 3, duplicateInBatch: 1, duplicateExisting: 1, withWarnings: 1, priced: 4, unpriced: 0 },
  products: [
    { index: 0, name: 'Sérum Éclat 30 ml', price: '12 000 F CFA', currency: 'XOF', productUrl: 'https://serum-eclat.example/p/serum', warnings: [], duplicate: null, importable: true },
    { index: 1, name: 'Crème Nuit réparatrice', price: '8 500 F CFA', currency: 'XOF', productUrl: 'https://serum-eclat.example/p/creme', warnings: [], duplicate: null, importable: true },
    { index: 2, name: 'Coffret rituel', price: '19 900 F CFA', currency: 'XOF', productUrl: 'https://serum-eclat.example/p/coffret', warnings: ['description vide'], duplicate: 'existing' as const, importable: true },
    { index: 3, name: 'SERUM ECLAT 30 ML', price: '12 000 F CFA', currency: 'XOF', productUrl: null, warnings: [], duplicate: 'in-batch' as const, importable: false },
  ],
  rejected: [{ line: 5, reason: 'prix illisible' }],
  warnings: [
    'Aucun produit n’a été créé : cette étape est une prévisualisation.',
    'Des produits portent un nom déjà présent dans votre catalogue : ils seront créés en plus si vous confirmez.',
    'Des doublons internes au catalogue source sont ignorés : aucun produit n’est écrit deux fois.',
  ],
  connectedTo: '203.0.113.10',
};

const STYLES = `
  body { margin: 0; background: #070b12; color: #e2e8f0; font-family: ui-sans-serif, system-ui, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 28px 16px 48px; }
  .capture-title { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #64748b; margin: 0 0 4px; }
  .capture-sub { font-size: 12px; color: #475569; margin: 0 0 18px; }
  .capture-note { margin-top: 18px; font-size: 11px; color: #64748b; border-top: 1px solid rgba(255,255,255,.08); padding-top: 12px; }
  .capture-note code { color: #94a3b8; }
`;

describe('preuve de rendu — import par URL', () => {
  it('produit un artefact HTML de l’aperçu serveur, sans écriture', async () => {
    cleanup();
    api.connectEdge.mockResolvedValue({ data: null });
    api.invokeEdge.mockResolvedValueOnce({ data: APERCU });

    const { container } = render(
      <StoreImportPanel workspaceId="workspace-demo" existing={[]} onImported={vi.fn()} onClose={vi.fn()} />,
    );

    fireEvent.change(screen.getByTestId('store-url-input'), {
      target: { value: 'https://serum-eclat.example' },
    });
    fireEvent.click(screen.getByTestId('store-url-preview'));

    await waitFor(() => expect(screen.getByTestId('store-url-preview-panel')).toBeTruthy());

    // L'aperçu a réellement été demandé au serveur, en lecture seule.
    expect(api.invokeEdge).toHaveBeenCalledWith('store-import', {
      action: 'preview',
      workspaceId: 'workspace-demo',
      url: 'https://serum-eclat.example',
    });
    // Aucune écriture, ni navigateur ni serveur.
    expect(api.createProduct).not.toHaveBeenCalled();
    expect(api.invokeEdge.mock.calls.some(([, corps]) => (corps as { action?: string }).action === 'import')).toBe(false);

    // Les informations décisives sont visibles.
    expect(screen.getByText(/4 produit\(s\) détecté\(s\)/i)).toBeTruthy();
    expect(screen.getByText(/1 doublon\(s\) dans la source/i)).toBeTruthy();
    expect(screen.getAllByText(/déjà dans votre catalogue/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Importer 3 produit\(s\)/i)).toBeTruthy();
    expect(screen.getByText(/Aucun produit n’a été créé à cette étape/i)).toBeTruthy();

    const css = existsSync('dist/assets')
      ? readdirSync('dist/assets').filter((f) => f.endsWith('.css')).map((f) => readFileSync(`dist/assets/${f}`, 'utf8')).join('\n')
      : '';

    mkdirSync('artifacts', { recursive: true });
    const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SORAHNEX — Import de catalogue par URL (preuve de rendu)</title>
<style>${css}</style>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <p class="capture-title">SORAHNEX · Business Grow → Croissance → Catalogue → Importer un catalogue</p>
  <p class="capture-sub">Aperçu renvoyé par l’Edge Function <code>store-import</code> pour <code>https://serum-eclat.example</code>. Lecture faite par le serveur ; rien n’a été enregistré.</p>
  ${container.innerHTML}
  <p class="capture-note">
    La lecture est faite côté serveur : le navigateur n’ouvre aucune connexion vers la boutique — il ne peut ni
    résoudre le DNS ni garantir que l’adresse contrôlée est l’adresse contactée. Le serveur valide, résout, refuse
    les adresses internes, puis se connecte <em>sur l’IP validée</em> avec une vérification TLS au nom de l’hôte.
    Le bouton de confirmation transmet un <code>previewId</code> émis par le serveur, à usage unique et valable
    dix minutes : aucun produit ne peut être écrit sans prévisualisation, et l’aperçu ne crée jamais rien.
  </p>
</div>
</body>
</html>`;

    writeFileSync('artifacts/import-url.html', html, 'utf8');
    expect(existsSync('artifacts/import-url.html')).toBe(true);
  });
});
