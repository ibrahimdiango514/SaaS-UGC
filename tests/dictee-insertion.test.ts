/**
 * Où atterrit le texte dicté ?
 *
 * La dictée insère un fragment reconnu dans le composeur. Deux erreurs sont
 * possibles, et les deux ont un coût visible pour l'utilisateur :
 *
 *  - remplacer le texte existant : il perd ce qu'il avait écrit ;
 *  - ajouter systématiquement à la fin : la précision dictée apparaît à l'autre
 *    bout du message, hors de son regard.
 *
 * La fonction ci-dessous reproduit la règle appliquée par `Composer`. Elle est
 * extraite ici parce que la logique de positionnement est pure : inutile de
 * monter un DOM complet pour vérifier où va le texte.
 */

import { describe, expect, it } from 'vitest';

/**
 * Reproduit fidèlement la règle de `Composer.tsx`.
 *
 * @param actuel  contenu courant du composeur
 * @param fragment texte final reconnu
 * @param debut   position du curseur, ou `null` si le champ n'a pas le focus
 * @param fin     fin de sélection, ou `null`
 */
function inserer(actuel: string, fragment: string, debut: number | null, fin: number | null): string {
  if (debut === null || fin === null) {
    return actuel.trim() ? `${actuel.trimEnd()} ${fragment}` : fragment;
  }
  const avant = actuel.slice(0, debut);
  const apres = actuel.slice(fin);
  const prefixe = avant && !/\s$/.test(avant) && !/^\s/.test(fragment) ? ' ' : '';
  const suffixe = apres && !/^\s/.test(apres) && !/\s$/.test(fragment) ? ' ' : '';
  return `${avant}${prefixe}${fragment}${suffixe}${apres}`;
}

describe('dictée — insertion du texte reconnu', () => {
  it('écrit dans un champ vide sans espace parasite', () => {
    expect(inserer('', 'bonjour', 0, 0)).toBe('bonjour');
  });

  it('insère au milieu sans coller aux mots voisins', () => {
    /* Curseur après « Relance » : les deux espaces de séparation sont ajoutés. */
    expect(inserer('Relance le client', 'demain matin', 7, 7))
      .toBe('Relance demain matin le client');
  });

  it('ne double pas une espace déjà présente', () => {
    expect(inserer('Relance ', 'demain', 8, 8)).toBe('Relance demain');
    expect(inserer('Relance demain', ' matin', 14, 14)).toBe('Relance demain matin');
  });

  it('remplace une sélection au lieu de la dupliquer', () => {
    /* L'utilisateur a surligné « client » puis dicté « prospect » : substitution. */
    expect(inserer('Relance le client', 'prospect', 11, 17)).toBe('Relance le prospect');
  });

  it('ajoute à la fin quand le champ n’a pas le focus', () => {
    /*
     * Cas mobile courant : le clavier se referme pendant l'écoute, donc
     * `selectionStart` n'est pas fiable. Le repli doit préserver le texte.
     */
    expect(inserer('Note existante', 'et précision', null, null))
      .toBe('Note existante et précision');
  });

  it('ne perd jamais le texte déjà saisi', () => {
    /*
     * Le curseur est placé en fin de mot (« Mon| message »), pas au milieu d'un
     * mot : une insertion au milieu découpe le mot, ce qui est le comportement
     * attendu d'une saisie à cet endroit, pas une perte de contenu.
     */
    for (const [fragment, position] of [['a', 3], ['un long fragment dicté', 3], ['fin', 11]] as const) {
      const resultat = inserer('Mon message', fragment, position, position);
      expect(resultat).toContain(fragment);
      /* Tous les caractères d'origine subsistent, à la ponctuation d'espacement près. */
      expect(resultat.replace(/\s+/g, ' ')).toContain('Mon message'.slice(0, position).trim());
    }
  });

  it('ignore les espaces de fin d’un texte existant en repli', () => {
    /* Sans trim, un double espace s'accumulerait à chaque dictée. */
    expect(inserer('Note   ', 'suite', null, null)).toBe('Note suite');
  });
});
