/**
 * Tous les imports relatifs du code source pointent-ils sur un fichier réel ?
 *
 * ## Pourquoi ce test existe
 *
 * `tsc -b` ne vérifie pas les imports CSS : une page qui importe
 * `'../../ai/assistant.css'` depuis `src/business/` passe le typage, les tests
 * unitaires aussi, et casse seulement au `vite build`. C'est exactement ce qui
 * est arrivé avec `BusinessAssistantPage.tsx` — un chemin `../../` hérité d'un
 * fichier voisin, deux niveaux trop haut.
 *
 * Le coût de cette vérification est négligeable, et elle attrape une classe
 * entière d'erreurs que ni le typeur ni les tests de composants ne voient.
 *
 * ## Portée
 *
 * Seuls les fichiers de `src/` sont analysés, et seulement leurs imports
 * RELATIFS : les alias (`@/...`) et les paquets sont résolus par Vite.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);

function fichiersSource(racine: string): string[] {
  const sortie: string[] = [];
  for (const entree of readdirSync(racine)) {
    const chemin = join(racine, entree);
    if (statSync(chemin).isDirectory()) {
      sortie.push(...fichiersSource(chemin));
    } else if (EXTENSIONS.has(chemin.slice(chemin.lastIndexOf('.')))) {
      sortie.push(chemin);
    }
  }
  return sortie;
}

/** Un import est résolu s'il existe tel quel ou avec une extension implicite. */
function existe(chemin: string): boolean {
  if (existsSync(chemin)) return true;
  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.css', '/index.ts', '/index.tsx']) {
    if (existsSync(chemin + extension)) return true;
  }
  return false;
}

describe('imports relatifs de src/', () => {
  it('chaque import relatif pointe sur un fichier existant', () => {
    const manquants: string[] = [];

    for (const fichier of fichiersSource(join(process.cwd(), 'src'))) {
      const contenu = readFileSync(fichier, 'utf8');
      /* `from '…'` et les imports CSS nus `import '…'`. */
      const motif = /(?:from\s+|import\s+)['"](\.[^'"]+)['"]/g;
      let capture: RegExpExecArray | null;
      while ((capture = motif.exec(contenu)) !== null) {
        const cible = resolve(dirname(fichier), capture[1]);
        if (!existe(cible)) {
          manquants.push(`${fichier.replace(process.cwd() + '/', '')} -> ${capture[1]}`);
        }
      }
    }

    expect(
      manquants,
      `imports non résolus (le build échouerait) :\n${manquants.join('\n')}`,
    ).toEqual([]);
  });
});
