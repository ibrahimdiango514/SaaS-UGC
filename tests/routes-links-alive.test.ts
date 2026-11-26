import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * BLOC C — aucun lien interne ne doit mener à une page inexistante.
 *
 * ## Le défaut trouvé
 * `src/ai/Sidebar.tsx` exposait deux entrées dont la cible n'existait pas :
 *   - « Images » → `/app/ai/images` ;
 *   - « Explorer » → `/app/ai/explorer`.
 * Aucune route `/app/ai/*` n'étant déclarée dans `App.tsx`, un clic affichait la
 * page « introuvable ». Rien ne le signalait : ni le typecheck (les chemins sont
 * des chaînes), ni les tests existants (ils ne vérifiaient pas les cibles).
 *
 * ## Ce que ce test vérifie
 * Que CHAQUE chemin `/app/...` écrit en dur dans le code correspond à une route
 * réellement déclarée dans `App.tsx`, segments dynamiques (`:id`, `:moduleKey`,
 * `*`) compris.
 *
 * ## Ce qu'il ne vérifie pas
 * Les chemins construits dynamiquement (`\`/app/x/${id}\``) sont ignorés : ils ne
 * peuvent pas être résolus sans exécution. Les fichiers de test sont exclus : ils
 * citent parfois une route volontairement fausse pour vérifier un repli.
 */

const RACINE = process.cwd();

/** Déclaration des routes : tout ce que `App.tsx` accepte réellement. */
export function routesDeclarees(): Set<string> {
  const source = readFileSync(join(RACINE, 'src/App.tsx'), 'utf8');
  const routes = new Set<string>();
  let dansApp = false;
  for (const ligne of source.split('\n')) {
    const m = /<Route\s+path="([^"]+)"/.exec(ligne);
    if (!m) continue;
    const chemin = m[1];
    /*
     * Deux pièges d'extraction, tous deux vérifiés :
     *  - `path="/app"` ouvre la portée imbriquée : les chemins suivants sont
     *    RELATIFS à `/app` ;
     *  - `path="*"` déclaré à la RACINE (hors de `/app`) est la page
     *    « introuvable ». Le préfixer en `/app/*` ferait correspondre n'importe
     *    quelle URL : le test ne détecterait plus aucun lien mort.
     */
    if (chemin === '/app') { dansApp = true; routes.add('/app'); continue; }
    if (chemin.startsWith('/')) { dansApp = false; routes.add(chemin); continue; }
    if (!dansApp) continue;
    routes.add(`/app/${chemin}`);
  }
  return routes;
}

function fichiersSource(dossier: string, sortie: string[] = []): string[] {
  for (const entree of readdirSync(dossier)) {
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) fichiersSource(chemin, sortie);
    else if (/\.(ts|tsx)$/.test(entree)) sortie.push(chemin);
  }
  return sortie;
}

/** Un chemin correspond-il à une route déclarée, segments dynamiques inclus ? */
export function routeExiste(chemin: string, routes: ReadonlySet<string>): boolean {
  const cible = chemin.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  if (routes.has(cible)) return true;
  for (const route of routes) {
    // `*` capte tout le reste ; `:param` capte un segment, jamais un `/`.
    const motif = `^${route.split('/').map((segment) => {
      if (segment === '*') return '.*';
      if (segment.startsWith(':')) return '[^/]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/')}$`;
    if (new RegExp(motif).test(cible)) return true;
  }
  return false;
}

describe('Liens internes — aucune destination morte', () => {
  const routes = routesDeclarees();

  it('le registre de routes est bien lu (sinon le test ne prouverait rien)', () => {
    // Garde-fou : si l'extraction cassait, l'ensemble serait vide et tous les
    // liens sembleraient morts — ou pire, le test passerait sans rien vérifier.
    expect(routes.size).toBeGreaterThan(30);
    expect(routes.has('/app/studio/accueil')).toBe(true);
    expect(routes.has('/app/business/*')).toBe(true);
    expect(routes.has('/app/agent/*')).toBe(true);
  });

  it('résout correctement les segments dynamiques', () => {
    expect(routeExiste('/app/projets/abc-123', routes)).toBe(true);
    expect(routeExiste('/app/studio/espace/image', routes)).toBe(true);
    expect(routeExiste('/app/business/crm', routes)).toBe(true);
    expect(routeExiste('/app/agent/historique', routes)).toBe(true);
    // Une route qui n'existe nulle part doit bien être détectée comme morte.
    expect(routeExiste('/app/ai/explorer', routes)).toBe(false);
    expect(routeExiste('/app/ai/images', routes)).toBe(false);
    // La route « introuvable » racine ne doit pas valider n'importe quoi.
    expect(routes.has('/app/*')).toBe(false);
  });

  it('chaque lien /app écrit en dur pointe vers une route réelle', () => {
    const fautifs: string[] = [];
    for (const fichier of fichiersSource(join(RACINE, 'src'))) {
      const source = readFileSync(fichier, 'utf8');
      const motif = /(?:to|path)=["'](\/app[^"']*)["']/g;
      for (const m of source.matchAll(motif)) {
        const chemin = m[1];
        // Une interpolation ne peut pas être résolue sans exécution.
        if (chemin.includes('${')) continue;
        if (!routeExiste(chemin, routes)) {
          fautifs.push(`${relative(RACINE, fichier)} → ${chemin}`);
        }
      }
    }
    expect(
      fautifs,
      `Ces liens mènent à une page inexistante (404) :\n${fautifs.join('\n')}`,
    ).toEqual([]);
  });
});
