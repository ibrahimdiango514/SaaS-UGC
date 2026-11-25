/**
 * Garde-fous de l'architecture d'espaces SORAHNEX.
 *
 * Ces tests ne vérifient pas des pixels : ils vérifient des invariants de
 * structure qui, s'ils cassent, cassent la navigation pour un utilisateur
 * réel — un lien de menu sans route, un module dupliqué, une action rapide
 * morte, ou une marque héritée réintroduite dans l'interface.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUSINESS_MOBILE_NAV, BUSINESS_NAV_GROUPS, STUDIO_MOBILE_NAV, STUDIO_NAV_GROUPS,
} from '../src/navigation/config';
import {
  GROWTH_OS_MODULES, GROWTH_OS_NAV, GROWTH_OS_QUICK_ACTIONS,
} from '../src/business/os/modules';
import {
  DATABASE_RELATIONS, EDGE_FUNCTIONS, INTERNAL_HEADERS, STORAGE_BUCKETS,
  canonicalRpcName, edgeFunctionName, edgeNamingMode,
} from '../src/lib/platform-identity';

const appSource = readFileSync('src/App.tsx', 'utf8');

/** Toutes les URL réellement déclarées par le routeur. */
const ROUTES = (() => {
  const routes = new Set<string>();
  for (const match of appSource.matchAll(/path="([^"]+)"/g)) {
    const value = match[1];
    routes.add(value.startsWith('/') ? value : `/app/${value}`);
  }
  return routes;
})();

function isRoutable(path: string): boolean {
  if (ROUTES.has(path)) return true;
  // Le Growth OS monte une route `business/*` : tout module y est servi.
  if (path.startsWith('/app/business/') && ROUTES.has('/app/business/*')) return true;
  return false;
}

const navLabels = (groups: typeof STUDIO_NAV_GROUPS) => groups.flatMap((group) => [
  group.label,
  ...group.items.map((item) => `${item.label} ${item.description}`),
]);

describe('Navigation SORAHNEX Studio', () => {
  it('reste courte : cinq groupes au maximum', () => {
    expect(STUDIO_NAV_GROUPS.length).toBeLessThanOrEqual(5);
    expect(STUDIO_NAV_GROUPS.length).toBeGreaterThanOrEqual(4);
  });

  it('n’a aucun groupe vide ni aucune destination dupliquée', () => {
    const paths = STUDIO_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to));
    expect(paths.length).toBe(new Set(paths).size);
    for (const group of STUDIO_NAV_GROUPS) {
      expect(group.items.length).toBeGreaterThan(0);
      expect(group.id).toBeTruthy();
    }
  });

  it('ne pointe que vers des routes existantes', () => {
    for (const item of STUDIO_NAV_GROUPS.flatMap((group) => group.items)) {
      expect(isRoutable(item.to), `${item.label} → ${item.to}`).toBe(true);
    }
  });

  it('garde toutes les fonctionnalités historiques accessibles', () => {
    const paths = new Set(STUDIO_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to)));
    for (const path of [
      '/app/studio', '/app/studio/accueil', '/app/studio/avance', '/app/studio/classique',
      '/app/studio/montage', '/app/presets', '/app/avatars', '/app/scripts', '/app/prompts',
      '/app/projets', '/app/bibliotheque', '/app/fichiers', '/app/historique',
      '/app/ai', '/app/abonnement', '/app/credits', '/app/parametres',
    ]) {
      expect(paths.has(path), `${path} a disparu de la navigation`).toBe(true);
    }
  });
});

describe('Navigation SORAHNEX Grow', () => {
  it('dérive du Growth OS : chaque module apparaît exactement une fois', () => {
    const modulePaths = GROWTH_OS_MODULES.map((module) => module.path);
    const navPaths = BUSINESS_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to))
      .filter((path) => modulePaths.includes(path));
    expect(navPaths.sort()).toEqual([...modulePaths].sort());
    expect(navPaths.length).toBe(new Set(navPaths).size);
  });

  it('regroupe les modules par objectif, sans doublon de clé ni d’URL', () => {
    expect(GROWTH_OS_NAV.length).toBe(6);
    expect(new Set(GROWTH_OS_NAV.map((group) => group.id)).size).toBe(GROWTH_OS_NAV.length);
    const keys = GROWTH_OS_MODULES.map((module) => module.key);
    const paths = GROWTH_OS_MODULES.map((module) => module.path);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('ne pointe que vers des routes existantes', () => {
    for (const module of GROWTH_OS_MODULES) {
      expect(isRoutable(module.path), `${module.label} → ${module.path}`).toBe(true);
    }
  });

  it('propose des actions rapides toutes valides', () => {
    expect(GROWTH_OS_QUICK_ACTIONS.length).toBeGreaterThanOrEqual(3);
    const modulePaths = new Set(GROWTH_OS_MODULES.map((module) => module.path));
    for (const action of GROWTH_OS_QUICK_ACTIONS) {
      expect(modulePaths.has(action.to), `${action.label} → ${action.to}`).toBe(true);
    }
  });
});

describe('Barres de navigation mobiles', () => {
  it('tiennent en cinq entrées, dont un unique tiroir', () => {
    for (const nav of [STUDIO_MOBILE_NAV, BUSINESS_MOBILE_NAV]) {
      expect(nav.length).toBeLessThanOrEqual(5);
      expect(nav.filter((item) => item.opensDrawer)).toHaveLength(1);
    }
  });

  it('ne pointe que vers des routes existantes (hors tiroir)', () => {
    for (const item of [...STUDIO_MOBILE_NAV, ...BUSINESS_MOBILE_NAV]) {
      if (item.opensDrawer) continue;
      expect(isRoutable(item.to), `${item.label} → ${item.to}`).toBe(true);
    }
  });
});

describe('Identité visible', () => {
  it('aucune marque héritée dans la navigation', () => {
    const labels = [...navLabels(STUDIO_NAV_GROUPS), ...navLabels(BUSINESS_NAV_GROUPS)]
      .join(' ')
      .toLowerCase();
    expect(labels).not.toContain('vyora');
    expect(labels).not.toContain('reelora');
    expect(labels).not.toContain('business growth');
  });

  it('aucune marque héritée dans la coquille du Growth OS', () => {
    const source = readFileSync('src/business/os/GrowthOsLayout.tsx', 'utf8').toLowerCase();
    expect(source).not.toContain('vyora');
    expect(source).not.toContain('reelora');
  });
});

describe('Identité technique', () => {
  it('reste en mode hérité tant que le déploiement n’a pas basculé', () => {
    expect(edgeNamingMode()).toBe('legacy');
    expect(edgeFunctionName('ai')).toBe('vyora-ai');
    expect(edgeFunctionName('video')).toBe('reelora-video');
    expect(edgeFunctionName('storeConnect')).toBe('store-connect');
  });

  it('propose un nom cible unique et préfixé pour chaque fonction de marque', () => {
    const canonical = Object.values(EDGE_FUNCTIONS).map((names) => names.canonical);
    expect(new Set(canonical).size).toBe(canonical.length);
    for (const names of Object.values(EDGE_FUNCTIONS)) {
      expect(names.canonical.length).toBeGreaterThan(0);
      if (names.canonical !== names.legacy) {
        expect(names.canonical.startsWith('sorahnex-'), names.canonical).toBe(true);
      }
    }
  });

  it('accepte les deux en-têtes internes pendant la transition', () => {
    for (const header of Object.values(INTERNAL_HEADERS)) {
      expect(header.canonical.startsWith('x-sorahnex-')).toBe(true);
      expect(header.legacy.startsWith('x-')).toBe(true);
      expect(header.canonical).not.toBe(header.legacy);
    }
  });

  it('constate que les buckets ne portent pas la marque', () => {
    for (const bucket of Object.values(STORAGE_BUCKETS)) {
      expect(bucket.legacy).toBe(bucket.canonical);
      expect(bucket.legacy.toLowerCase()).not.toContain('vyora');
      expect(bucket.legacy.toLowerCase()).not.toContain('reelora');
    }
  });

  it('décrit les relations SQL à migrer sans collision de nom cible', () => {
    const targets = Object.values(DATABASE_RELATIONS);
    expect(targets.length).toBe(new Set(targets).size);
    for (const [legacy, target] of Object.entries(DATABASE_RELATIONS)) {
      expect(legacy).not.toBe(target);
      expect(target.toLowerCase()).not.toContain('vyora');
      expect(target.toLowerCase()).not.toContain('reelora');
    }
  });

  it('mappe les RPC héritées vers un préfixe SORAHNEX', () => {
    expect(canonicalRpcName('vyora_ugc_catalog')).toBe('sorahnex_ugc_catalog');
    expect(canonicalRpcName('reelora_start_generation')).toBe('sorahnex_start_generation');
    expect(canonicalRpcName('ugc_create_recharge_order')).toBe('ugc_create_recharge_order');
  });
});
