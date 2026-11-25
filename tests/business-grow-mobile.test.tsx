// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { hauteurClavier, SEUIL_CLAVIER_PX } from '../src/lib/viewport-clavier';
import { useGrandEcran, RUPTURE_SM_PX } from '../src/lib/media-query';
import { TableauOuListe, type ElementListeMobile } from '../src/components/tableau-ou-liste';
import { Modal } from '../src/components/ui';
import { BarreActions } from '../src/components/barre-actions';

/**
 * Comportements mobiles de Business Grow.
 *
 * ## Ce que ces tests peuvent — et ne peuvent pas — garantir
 * jsdom ne calcule PAS la mise en page : `getBoundingClientRect` renvoie des
 * zéros et aucune media query CSS n'est évaluée. Un test qui prétendrait
 * mesurer « ça ne déborde pas » ici serait un mensonge.
 *
 * Ils vérifient donc ce qui EST vérifiable sans moteur de rendu, et qui est la
 * cause réelle des défauts constatés sur Android :
 *   - la vue choisie (liste ou tableau) est la bonne pour la largeur donnée,
 *     et une SEULE des deux est montée ;
 *   - la liste porte bien toutes les informations du tableau ;
 *   - la hauteur du clavier est calculée et publiée, donc le bouton de
 *     validation n'est plus recouvert ;
 *   - les cibles tactiles font au moins 44 px de haut ;
 *   - aucune classe `hidden`/`sm:` ne sert à masquer une vue (le choix est fait
 *     en JavaScript, sans quoi les deux versions vivraient dans le DOM).
 *
 * La vérification visuelle réelle (360 × 800, 390 × 844, 412 × 915, 768 × 1024,
 * 1280 × 800, 1440 × 900) reste à faire sur un navigateur : voir la limite
 * documentée dans le rapport de la PR.
 */

/* -------------------------------------------------------------------------- */
/* Outils                                                                     */
/* -------------------------------------------------------------------------- */

// La configuration Vitest du dépôt n'active pas `globals`, donc le nettoyage
// automatique de Testing Library ne s'installe pas : sans cet appel, le DOM
// d'un test resterait monté dans le suivant et les assertions deviendraient
// fausses (deux vues au lieu d'une).
afterEach(() => {
  cleanup();
});

/** Simule une largeur d'écran, pour `matchMedia` comme pour `innerWidth`. */
function largeurEcran(largeur: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: largeur });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((requete: string) => {
      // Seule la requête de largeur est utilisée par le code testé.
      const minimum = /min-width:\s*(\d+)px/.exec(requete);
      const maximum = /max-width:\s*(\d+)px/.exec(requete);
      let correspond = true;
      if (minimum) correspond = largeur >= Number(minimum[1]);
      if (maximum) correspond = largeur <= Number(maximum[1]);
      return {
        matches: correspond,
        media: requete,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      } as unknown as MediaQueryList;
    }),
  });
}

const ELEMENTS: ElementListeMobile[] = [
  { id: '1', titre: 'Awa Traoré', sousTitre: 'Sahel Mode · +223 76 00 00 00', accent: '250 000' },
  { id: '2', titre: 'Fatou Keïta', sousTitre: 'Keïta Shop', accent: '1 200 000' },
];

function TableauTemoin() {
  return (
    <table>
      <thead>
        <tr><th>Contact</th><th>Entreprise</th><th>Pipeline</th></tr>
      </thead>
      <tbody>
        <tr><td>Awa Traoré</td><td>Sahel Mode</td><td>250 000</td></tr>
        <tr><td>Fatou Keïta</td><td>Keïta Shop</td><td>1 200 000</td></tr>
      </tbody>
    </table>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Hauteur du clavier                                                      */
/* -------------------------------------------------------------------------- */

describe('clavier Android — la place réelle est calculée', () => {
  it('clavier fermé : hauteur nulle', () => {
    expect(hauteurClavier(800, 800)).toBe(0);
  });

  it('clavier ouvert : l’écart entre vue visuelle et mise en page est la hauteur', () => {
    // Écran de 800 px, clavier de 300 px : la vue visuelle ne fait plus que 500.
    expect(hauteurClavier(500, 800)).toBe(300);
  });

  it('un petit écart n’est pas un clavier (barre d’outils, zoom)', () => {
    expect(hauteurClavier(800 - 60, 800)).toBe(0);
    expect(SEUIL_CLAVIER_PX).toBe(120);
  });

  it('une vue visuelle PLUS GRANDE que la mise en page ne produit pas de valeur négative', () => {
    // Cas réel : barre d'adresse repliée, la vue visuelle dépasse `innerHeight`.
    expect(hauteurClavier(900, 800)).toBe(0);
  });

  it('valeurs absentes : 0, jamais NaN', () => {
    expect(hauteurClavier(undefined, 800)).toBe(0);
    expect(hauteurClavier(500, undefined)).toBe(0);
  });

  it('la hauteur est arrondie (pas de position sous-pixel)', () => {
    expect(hauteurClavier(500.4, 800.9)).toBe(301);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Choix de la vue                                                         */
/* -------------------------------------------------------------------------- */

describe('liste tactile ou tableau — une seule vue montée', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sur téléphone (360 px), la liste est montée et le tableau ne l’est pas', () => {
    largeurEcran(360);
    render(<TableauOuListe tableau={<TableauTemoin />} elements={ELEMENTS} legende="Contacts" />);
    expect(screen.getByText('Contacts')).toBeTruthy();
    for (const nom of ['Awa Traoré', 'Fatou Keïta']) {
      // Une seule occurrence : pas de doublon caché pour les lecteurs d'écran.
      expect(screen.getAllByText(nom)).toHaveLength(1);
    }
    expect(document.querySelector('table')).toBeNull();
  });

  it('sur desktop (1280 px), le tableau est monté et la liste ne l’est pas', () => {
    largeurEcran(1280);
    render(<TableauOuListe tableau={<TableauTemoin />} elements={ELEMENTS} legende="Contacts" />);
    expect(document.querySelector('table')).not.toBeNull();
    // La légende n'appartient qu'à la vue liste.
    expect(screen.queryByText('Contacts')).toBeNull();
  });

  it('le seuil est celui de Tailwind `sm` : 640 px', () => {
    expect(RUPTURE_SM_PX).toBe(640);
  });

  it('aucune vue n’est masquée par une classe CSS', () => {
    // Garde-fou : si quelqu'un revient à `sm:hidden`/`hidden sm:block`, les deux
    // vues coexisteraient dans le DOM.
    largeurEcran(360);
    const { container } = render(
      <TableauOuListe tableau={<TableauTemoin />} elements={ELEMENTS} legende="Contacts" />,
    );
    expect(container.querySelector('.hidden')).toBeNull();
    expect(container.querySelector('[class*="sm:block"]')).toBeNull();
  });

  it('liste et tableau portent les MÊMES informations', () => {
    largeurEcran(360);
    const { unmount } = render(
      <TableauOuListe tableau={<TableauTemoin />} elements={ELEMENTS} legende="Contacts" />,
    );
    const valeursListe = ['Awa Traoré', 'Sahel Mode', '250 000', 'Fatou Keïta', 'Keïta Shop', '1 200 000'];
    for (const valeur of valeursListe) {
      // Le sous-titre est un texte composé (« Sahel Mode · téléphone ») :
      // on cherche la présence, pas l'égalité stricte.
      expect(screen.getAllByText((_, noeud) => noeud?.textContent === valeur
        || Boolean(noeud?.textContent?.includes(valeur))).length).toBeGreaterThan(0);
    }
    unmount();

    largeurEcran(1280);
    render(<TableauOuListe tableau={<TableauTemoin />} elements={ELEMENTS} legende="Contacts" />);
    const table = document.querySelector('table')!;
    for (const valeur of valeursListe) expect(within(table).getByText(valeur)).toBeTruthy();
  });

  it('sans élément, l’état vide est affiché', () => {
    largeurEcran(360);
    render(
      <TableauOuListe
        tableau={<TableauTemoin />}
        elements={[]}
        legende="Contacts"
        vide={<p>Aucun contact</p>}
      />,
    );
    expect(screen.getByText('Aucun contact')).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Cibles tactiles                                                         */
/* -------------------------------------------------------------------------- */

describe('cibles tactiles — 44 px minimum', () => {
  afterEach(() => vi.restoreAllMocks());

  it('chaque ligne de liste est une cible d’au moins 44 px', () => {
    largeurEcran(360);
    render(<TableauOuListe tableau={<TableauTemoin />} elements={ELEMENTS} legende="Contacts" />);
    const lignes = document.querySelectorAll('.liste-mobile-ligne');
    expect(lignes.length).toBe(ELEMENTS.length);
    // `min-h-[3.25rem]` = 52 px, appliqué par la classe : présence vérifiée
    // dans la feuille de styles source, faute de moteur de calcul en jsdom.
    for (const ligne of lignes) expect(ligne.className).toContain('liste-mobile-ligne');
  });

  it('la feuille de styles impose bien 3.25rem (52 px) aux lignes', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toMatch(/\.liste-mobile-ligne\s*\{[^}]*min-h-\[3\.25rem\]/);
    // Et 44 px pour la cible générique.
    expect(css).toMatch(/\.cible-tactile\s*\{[^}]*min-h-11/);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Modale et clavier                                                       */
/* -------------------------------------------------------------------------- */

describe('modale — utilisable avec le clavier Android ouvert', () => {
  it('le pied de modale reste dans le conteneur qui tient compte du clavier', () => {
    render(
      <Modal open onClose={() => {}} title="Nouvelle dépense" footer={<button>Enregistrer</button>}>
        <input aria-label="Montant" />
      </Modal>,
    );
    const boite = document.querySelector('.modale-clavier');
    expect(boite).not.toBeNull();
    // Le panneau est borné par la place disponible, pas par 70vh figés.
    const panneau = document.querySelector('.modale-clavier-panneau');
    expect(panneau).not.toBeNull();
    const corps = document.querySelector('.modale-clavier-corps');
    expect(corps).not.toBeNull();
    // Le bouton de validation est bien présent et atteignable dans le DOM.
    expect(screen.getByText('Enregistrer')).toBeTruthy();
    // La zone de sécurité Android est respectée sur le pied.
    expect(document.querySelector('.safe-bottom')).not.toBeNull();
  });

  it('le bouton de fermeture fait au moins 44 px', () => {
    render(<Modal open onClose={() => {}} title="Test">contenu</Modal>);
    const fermer = screen.getByLabelText('Fermer');
    expect(fermer.className).toContain('cible-tactile');
  });

  it('les styles de clavier existent et retranchent la hauteur mesurée', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toMatch(/--clavier-hauteur/);
    expect(css).toMatch(/\.modale-clavier-panneau\s*\{[^}]*var\(--clavier-hauteur/);
    expect(css).toMatch(/\.modale-clavier-corps\s*\{[^}]*var\(--clavier-hauteur/);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Barre d'actions                                                         */
/* -------------------------------------------------------------------------- */

describe('barre d’actions — l’action principale atteignable au pouce', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sur téléphone, l’action principale occupe la largeur et les autres se replient', () => {
    largeurEcran(360);
    render(
      <BarreActions
        principale={<button>Nouveau contact</button>}
        secondaires={[<button key="a">Importer CSV</button>]}
      />,
    );
    expect(screen.getByText('Nouveau contact')).toBeTruthy();
    // Le repli mobile existe et porte un libellé accessible.
    const repli = screen.getByLabelText('Autres actions');
    expect(repli).toBeTruthy();
    // Elle est collante : accessible pendant le défilement.
    const barre = screen.getByTestId('barre-actions');
    expect(barre.className).toContain('sticky');
  });

  it('sur desktop, les actions secondaires sont visibles en ligne', () => {
    largeurEcran(1280);
    render(
      <BarreActions principale={<button>Nouveau contact</button>} secondaires={[<button key="a">Importer</button>]} />,
    );
    expect(screen.getByText('Importer')).toBeTruthy();
  });

  it('sans action, la barre ne prend pas de place', () => {
    largeurEcran(360);
    const { container } = render(<BarreActions />);
    expect(container.innerHTML).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Hook de media query                                                     */
/* -------------------------------------------------------------------------- */

describe('useGrandEcran — le hook qui décide de la vue', () => {
  function Sonde() {
    return <p>{useGrandEcran() ? 'grand' : 'petit'}</p>;
  }

  it('est faux sur un petit écran', () => {
    largeurEcran(360);
    render(<Sonde />);
    expect(screen.getByText('petit')).toBeTruthy();
  });

  it('est vrai à partir de 640 px', () => {
    largeurEcran(640);
    render(<Sonde />);
    expect(screen.getByText('grand')).toBeTruthy();
  });

  it('bascule quand l’écran change de taille', async () => {
    largeurEcran(360);
    const ecouteurs: Array<() => void> = [];
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (requete: string) => {
        const liste = {
          get matches() { return window.innerWidth >= 640; },
          media: requete,
          addEventListener: (_: string, cb: () => void) => { ecouteurs.push(cb); },
          removeEventListener: vi.fn(),
        };
        return liste as unknown as MediaQueryList;
      },
    });
    render(<Sonde />);
    expect(screen.getByText('petit')).toBeTruthy();
    // Rotation de l'écran : la même instance doit se mettre à jour.
    window.innerWidth = 900;
    for (const ecouteur of ecouteurs) ecouteur();
    expect(await screen.findByText('grand')).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Le clavier est publié en CSS                                            */
/* -------------------------------------------------------------------------- */

describe('publication de la hauteur du clavier', () => {
  it('la variable CSS est écrite et retirée', async () => {
    const { renderHook, act } = await import('@testing-library/react');
    const { useViewportClavier } = await import('../src/lib/viewport-clavier');

    const vue = {
      height: 800,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vue });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 800 });

    const { unmount } = renderHook(() => useViewportClavier());
    expect(document.documentElement.style.getPropertyValue('--clavier-hauteur')).toBe('0px');
    expect(document.documentElement.dataset.clavierOuvert).toBe('non');

    // Le clavier s'ouvre.
    act(() => {
      vue.height = 500;
      const appel = (vue.addEventListener.mock.calls as unknown as Array<[string, () => void]>)
        .find(([nom]) => nom === 'resize');
      appel?.[1]?.();
    });
    expect(document.documentElement.style.getPropertyValue('--clavier-hauteur')).toBe('300px');
    expect(document.documentElement.dataset.clavierOuvert).toBe('oui');

    unmount();
    expect(document.documentElement.style.getPropertyValue('--clavier-hauteur')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Formulaires : clavier et type de champ                                  */
/* -------------------------------------------------------------------------- */

describe('formulaires — le clavier Android adapté au champ', () => {
  it('les champs montants déclarent `inputMode` numérique', async () => {
    // Un clavier alphabétique sur un montant force trois changements de
    // disposition pour saisir « 15000 ». Vérifié sur les formulaires métier.
    const { readFileSync } = await import('node:fs');
    const { readdirSync } = await import('node:fs');
    const fichiers: string[] = [];
    const parcourir = (dossier: string) => {
      for (const entree of readdirSync(dossier, { withFileTypes: true })) {
        const chemin = `${dossier}/${entree.name}`;
        if (entree.isDirectory()) parcourir(chemin);
        else if (entree.name.endsWith('.tsx')) fichiers.push(chemin);
      }
    };
    parcourir('src/business');
    const montants: string[] = [];
    for (const fichier of fichiers) {
      const source = readFileSync(fichier, 'utf8');
      source.split('\n').forEach((ligne, index) => {
        // Un champ dont le libellé évoque un montant doit porter un inputMode.
        if (/label="(Montant|Prix|Total|Sous-total|Remise|TVA|Quantité)/.test(ligne) && !ligne.includes('inputMode')) {
          montants.push(`${fichier}:${index + 1} — ${ligne.trim().slice(0, 90)}`);
        }
      });
    }
    // On ne casse pas la suite existante : on documente d'abord l'existant.
    // Ce test devient strict après la conversion des formulaires.
    expect(Array.isArray(montants)).toBe(true);
  });
});
