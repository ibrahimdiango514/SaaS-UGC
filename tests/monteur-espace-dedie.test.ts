/**
 * Le monteur vidéo est-il vraiment un espace de travail dédié ?
 *
 * ## Le défaut visé
 *
 * Le monteur vivait dans la coquille SaaS : barre supérieure + navigation
 * latérale retiraient de la hauteur à une interface déjà dense (timeline,
 * panneaux, aperçu). Sur un écran court, la piste de montage sortait de la vue.
 *
 * Un espace dédié se reconnaît à trois propriétés vérifiables :
 *
 *  1. il est rendu HORS de `<Layout>` (sinon il hérite de la nav) ;
 *  2. il occupe `100dvh` et gère son propre défilement ;
 *  3. on peut en revenir au Studio sans perdre son travail.
 *
 * Ces tests portent sur la structure, pas sur le pixel : ils empêchent une
 * régression qui remettrait discrètement le monteur dans la coquille.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const app = readFileSync('src/App.tsx', 'utf8');
const monteur = readFileSync('src/studio/VideoEditor.tsx', 'utf8');

/** Extrait le bloc `<Layout …>…</Layout>` pour distinguer dedans/dehors. */
function blocLayout(source: string): string {
  const debut = source.indexOf('<Layout');
  const fin = source.lastIndexOf('</Layout>');
  return debut >= 0 && fin > debut ? source.slice(debut, fin) : '';
}

describe('monteur vidéo — espace dédié', () => {
  it('la route /app/montage existe et active le plein écran', () => {
    expect(app).toContain('path="/app/montage"');
    expect(app).toContain('<VideoEditor pleinEcran />');
  });

  it('la route dédiée est rendue hors de <Layout>', () => {
    /*
     * C'est la propriété décisive : la même route DANS `<Layout>` aurait conservé
     * la barre et la nav, donc le défaut d'origine.
     */
    const dedans = blocLayout(app);
    expect(dedans).not.toContain('path="/app/montage"');
  });

  it('la route historique reste disponible avec le rendu d’origine', () => {
    /* Ne rien casser : /app/studio/montage continue de fonctionner. */
    expect(app).toContain('path="studio/montage" element={<VideoEditor />}');
  });

  it('le plein écran occupe la fenêtre et gère son défilement', () => {
    expect(monteur).toContain("h-[100dvh]");
    /* Le contenu dépasse la hauteur sur mobile : le défilement doit rester interne. */
    expect(monteur).toContain('overflow-y-auto');
  });

  it('la prop est optionnelle et vaut false par défaut', () => {
    /* Sans défaut, l'encart historique perdrait sa mise en page. */
    expect(monteur).toContain('pleinEcran = false');
  });

  it('le retour au Studio sauvegarde le brouillon avant de naviguer', () => {
    /*
     * « Retour au Studio sans perte » : la sauvegarde doit précéder la
     * navigation. L'inverse ferait perdre les modifications en cours.
     */
    const bloc = monteur.slice(monteur.indexOf('const backToStudio'));
    const corps = bloc.slice(0, bloc.indexOf('};'));
    expect(corps.indexOf('saveLocalDraft')).toBeGreaterThan(-1);
    expect(corps.indexOf('saveLocalDraft')).toBeLessThan(corps.indexOf('navigate('));
  });

  it('les points d’entrée ouvrent l’espace dédié, pas l’ancienne route', () => {
    /*
     * Un seul point d'entrée resté sur `/app/studio/montage` suffirait à faire
     * croire que le monteur est toujours comprimé.
     */
    const entrees = [
      'src/navigation/config.ts',
      'src/studio/components/StudioTopBar.tsx',
      'src/studio/VideoStudio.tsx',
      'src/studio/components/AfterGeneration.tsx',
      'src/studio/GenerationStudio.tsx',
    ];
    for (const chemin of entrees) {
      const contenu = readFileSync(chemin, 'utf8');
      expect(contenu, `${chemin} pointe encore vers l'ancienne route`).not.toContain('/app/studio/montage');
    }
  });
});
