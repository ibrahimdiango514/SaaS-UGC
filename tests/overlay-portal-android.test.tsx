// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GrowthOsLayout } from '../src/business/os/GrowthOsLayout';
import { Modal } from '../src/components/ui';
import { PortalOverlay } from '../src/components/PortalOverlay';

const api = vi.hoisted(() => ({ listModuleRecords: vi.fn(async () => ({ records: [] })) }));
vi.mock('../src/business/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/business/api')>();
  return { ...actual, businessGrowApi: { ...actual.businessGrowApi, ...api } };
});

afterEach(cleanup);

/**
 * Bug Android confirmé — le menu mobile ne couvrait pas l'écran.
 *
 * ## Cause
 * La racine du Growth OS porte `animate-fadeUp`. Cette animation se termine en
 * `fill-mode: both`, donc elle CONSERVE `transform: translateY(0)`. `translateY(0)`
 * n'est pas `none` : l'élément reste un **référentiel de positionnement** pour
 * tout descendant `position: fixed`. Le menu, rendu sous cette racine,
 * se dimensionnait donc sur le conteneur de contenu : sur un téléphone de 360 px,
 * le panneau s'arrêtait en bas du contenu visible, la couche sombre ne couvrait
 * qu'une partie de la fenêtre, et les dernières entrées — la navigation du bas —
 * étaient inaccessibles.
 *
 * ## Ce que ces tests vérifient
 * Que les overlays plein écran ne sont PLUS des descendants du conteneur animé :
 * ils sont montés directement dans `document.body`. C'est la seule propriété qui
 * garantit la fenêtre comme référentiel, et elle ne dépend d'aucun media query
 * (jsdom ne les résout pas : un test sur la largeur ne prouverait rien).
 */

describe('Menu mobile du Growth OS — monté hors du conteneur animé', () => {
  function ouvrirMenu() {
    render(
      <MemoryRouter initialEntries={['/app/business']}>
        <GrowthOsLayout active="overview" workspaceName="Maison Karité">
          <p>Contenu</p>
        </GrowthOsLayout>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir le menu SORAHNEX Grow' }));
    return screen.getByRole('dialog', { name: 'Menu SORAHNEX Grow' });
  }

  it('rend le panneau directement dans document.body', () => {
    const dialogue = ouvrirMenu();
    // `document.body` ne contient plus qu'un enfant utile : le nœud React et le
    // portail. Le parent du dialogue doit être le body lui-même.
    expect(dialogue.parentElement).toBe(document.body);
  });

  it('ne laisse aucun ancêtre transformé entre le panneau et la fenêtre', () => {
    const dialogue = ouvrirMenu();
    // Régression exacte : aucun ancêtre ne doit porter `animate-*`, `transform`,
    // `filter` ou `will-change` — sinon `fixed` se rattache à lui.
    const porteurs = new Set(['transform', 'filter', 'perspective', 'will-change']);
    let courant: HTMLElement | null = dialogue.parentElement;
    while (courant && courant !== document.body) {
      const style = getComputedStyle(courant);
      for (const propriete of porteurs) {
        expect(
          style.getPropertyValue(propriete),
          `ancêtre ${courant.className} porte « ${propriete} » : le fixed se rattacherait à lui`,
        ).not.toBe('');
        expect(style.getPropertyValue(propriete), propriete).not.toBe('none');
      }
      // Classe d'animation : le fill-mode « both » garde le transform actif.
      expect(courant.className).not.toMatch(/(^|\s)animate-(fadeUp|riseIn|fadeRight)/);
      courant = courant.parentElement;
    }
  });

  it('garde le verrouillage du défilement et la fermeture par Échap', () => {
    ouvrirMenu();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Menu SORAHNEX Grow' })).toBeNull();
    // Le défilement est rendu à la page : sinon la page resterait figée.
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('se ferme au clic sur le fond, et pas depuis le panneau', () => {
    const dialogue = ouvrirMenu();
    // Un clic à l'intérieur du panneau ne ferme rien.
    fireEvent.click(within(dialogue).getByRole('link', { name: 'CRM' }));
    expect(document.body.style.overflow).not.toBe('hidden');

    // Rouverte, puis clic sur la couche sombre : fermeture réelle.
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir le menu SORAHNEX Grow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fermer le menu' }));
    expect(screen.queryByRole('dialog', { name: 'Menu SORAHNEX Grow' })).toBeNull();
  });

  it('affiche toutes les entrées de navigation, y compris les dernières', () => {
    const dialogue = ouvrirMenu();
    const liens = within(dialogue).getAllByRole('link');
    // Le bas du menu (Réglages) doit être présent : c'est lui qui devenait
    // inaccessible quand le panneau était tronqué par le conteneur.
    expect(within(dialogue).getByRole('link', { name: 'Intégrations' })).toBeTruthy();
    expect(within(dialogue).getByRole('link', { name: 'Échéances et conformité' })).toBeTruthy();
    expect(within(dialogue).getByRole('link', { name: 'Formule SORAHNEX Grow' })).toBeTruthy();
    expect(liens.length).toBeGreaterThanOrEqual(21);
  });
});

describe('PortalOverlay — référentiel de la fenêtre', () => {
  it('monte son contenu dans document.body, pas là où il est écrit', () => {
    const { container } = render(
      <div className="animate-fadeUp">
        <PortalOverlay><p>Panneau</p></PortalOverlay>
      </div>,
    );
    // Le conteneur de rendu ne contient pas le panneau : il est sorti du parent.
    expect(container.textContent).not.toContain('Panneau');
    expect(document.body.textContent).toContain('Panneau');
    const panneau = screen.getByText('Panneau');
    expect(panneau.parentElement).toBe(document.body);
  });
});

describe('Modal — sortie du conteneur animé', () => {
  it('rend le dialogue dans document.body et le retire à la fermeture', () => {
    const { rerender } = render(
      <div className="animate-fadeUp">
        <Modal open onClose={() => {}} title="Confirmer">Corps</Modal>
      </div>,
    );
    const dialogue = screen.getByRole('dialog', { name: 'Confirmer' });
    // Le dialogue vit DANS la couche `fixed`, elle-même montée dans `body` :
    // c'est la couche qui doit être l'enfant direct du body.
    const couche = dialogue.closest('.fixed');
    expect(couche).not.toBeNull();
    expect(couche?.parentElement).toBe(document.body);
    expect(document.body.textContent).toContain('Corps');

    rerender(<div className="animate-fadeUp"><Modal open={false} onClose={() => {}} title="Confirmer">Corps</Modal></div>);
    expect(screen.queryByRole('dialog', { name: 'Confirmer' })).toBeNull();
  });
});
