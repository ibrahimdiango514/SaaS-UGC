/**
 * Diagnostic de la scène 3D — mesure, pas décoration.
 *
 * ## Pourquoi ce fichier existe
 * La livraison 1 a livré une scène à 3 fps sans savoir ce qui coûtait. Profiler
 * demande de pouvoir couper un élément et de relire `renderer.info` : ce module
 * expose ces deux choses, et **seulement** quand l'URL contient `perf=1`.
 * En usage normal il ne fait rien : aucun objet global, aucun coût.
 *
 * ## Rôles
 * Chaque objet de la scène porte `userData.role`. Le diagnostic peut alors
 * masquer une famille entière (halos, affiches, lumières…) sans connaître la
 * structure du monde. C'est la même clé qui sert au profil A/B et au banc de
 * mesure, donc les chiffres du rapport décrivent exactement ce que le visiteur
 * voit.
 */
import type * as THREE from 'three';

export type Diagnostic = {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
};

export type DiagnosticExpose = Diagnostic & {
  /** Masque (ou réaffiche) tous les objets d'un rôle. Retourne le nombre touché. */
  couper: (role: string, cacher: boolean) => number;
  /** Coupe le fond de scène (la nébuleuse) — ce n'est pas un objet. */
  fond: (actif: boolean) => void;
  /** Photographie de l'état du renderer. */
  info: () => {
    appels: number;
    triangles: number;
    lignes: number;
    points: number;
    geometries: number;
    textures: number;
    programmes: number;
    memoires: { geometries: number; textures: number };
  };
};

declare global {
  interface Window {
    __sorahnex3d?: DiagnosticExpose;
  }
}

export function diagnosticActif(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('perf');
}

export function exposerDiagnostic({ gl, scene, camera }: Diagnostic): void {
  if (!diagnosticActif()) return;

  const fond = scene.background;

  window.__sorahnex3d = {
    gl,
    scene,
    camera,
    couper(role, cacher) {
      let touches = 0;
      scene.traverse((objet) => {
        if (objet.userData?.role === role) {
          objet.visible = !cacher;
          touches += 1;
        }
      });
      return touches;
    },
    fond(actif) {
      scene.background = actif ? fond : null;
    },
    info() {
      const info = gl.info;
      return {
        appels: info.render.calls,
        triangles: info.render.triangles,
        lignes: info.render.lines,
        points: info.render.points,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programmes: info.programs?.length ?? 0,
        memoires: { geometries: info.memory.geometries, textures: info.memory.textures },
      };
    },
  };
}
