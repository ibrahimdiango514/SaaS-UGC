// @vitest-environment node
/**
 * Parité entre le catalogue MCP du serveur et la liste affichée dans l'interface.
 *
 * ## Le risque concret
 *
 * L'écran « MCP et connexions IA » annonce à l'utilisateur ce qu'il pourra faire
 * depuis son client IA. Si cette liste diverge du catalogue réel, l'interface
 * promet un outil inexistant (le client reçoit « Outil inconnu ») ou cache un
 * outil disponible. Dans les deux cas, c'est un mensonge affiché.
 *
 * Les deux listes ne peuvent pas être fusionnées : `core.ts` s'exécute sous Deno
 * et le bundle client sous le navigateur. Ce test est donc le pont obligatoire :
 * il échoue dès qu'un outil est ajouté, retiré ou requalifié d'un côté seulement.
 */
import { describe, expect, it } from 'vitest';

import { OUTILS_ECRITURE, OUTILS_LECTURE } from '../supabase/functions/vyora-mcp/core.ts';
import { OUTILS_AFFICHES, OUTILS_LECTURE_AFFICHES } from '../src/mcp/outils';

describe('parité du catalogue MCP — serveur ↔ interface', () => {
  it('affiche exactement les outils publiés par le serveur', () => {
    const serveur = [...OUTILS_LECTURE, ...OUTILS_ECRITURE].map((o) => o.name).sort();
    const interface_ = OUTILS_AFFICHES.map((o) => o.nom).sort();
    expect(interface_).toEqual(serveur);
  });

  it('classe chaque outil dans la bonne catégorie (lecture / écriture)', () => {
    const ecritureServeur = new Set(OUTILS_ECRITURE.map((o) => o.name));
    for (const outil of OUTILS_AFFICHES) {
      expect(outil.ecriture, `portée divergente pour ${outil.nom}`).toBe(
        ecritureServeur.has(outil.nom),
      );
    }
  });

  it('n’affiche aucun outil en double', () => {
    const noms = OUTILS_AFFICHES.map((o) => o.nom);
    expect(new Set(noms).size).toBe(noms.length);
  });

  it('ne présente que des outils de lecture dans la sous-liste lecture', () => {
    expect(OUTILS_LECTURE_AFFICHES.every((o) => !o.ecriture)).toBe(true);
    expect(OUTILS_LECTURE_AFFICHES).toHaveLength(OUTILS_LECTURE.length);
  });
});
