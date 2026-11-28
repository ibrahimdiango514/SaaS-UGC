/**
 * La scène WebGL : une seule caméra, un seul monde, du hero au Studio.
 *
 * ## Le choix d'un seul canvas
 * Le hero et le Studio ne sont pas deux décors : c'est le même espace. Le
 * téléphone est à l'origine, l'écran géant vingt-quatre unités derrière, et la
 * caméra vole de l'un à l'autre quand on défile. Un canvas par scène aurait
 * produit une coupure au moment précis où le visiteur doit croire qu'il entre
 * dans le produit.
 *
 * ## Coût, mesuré
 * La scène est **limitée par le fill-rate**, pas par la géométrie : 21 appels
 * de dessin et ~3 700 triangles, mais un coût proportionnel aux pixels. Sur un
 * GPU intégré de machine virtuelle, 1,29 Mpx coûtaient ~175 ms/image. D'où les
 * paliers de `qualite.ts`, appliqués ici : dpr, halos, fond, lumières,
 * brouillard, tone mapping. Le rendu `complet` est celui de la livraison 1.
 */
import { ContactShadows, Sparkles } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { PALETTE } from '../../systeme/palette';
import { etatCamera, FOV, profondeurDepart } from './camera';
import { exposerDiagnostic } from './diagnostic';
import { lireProgres } from './progres';
import { PALIERS, QualiteContexte, type Reglages } from './qualite';
import { StudioMonde } from './Studio3D';
import { TelephoneHero } from './Telephone3D';
import { useImages } from './useImages';

const NEBULEUSE = '/landing/nebula.webp';

const VISUELS = [
  NEBULEUSE,
  '/landing/ugc-cosmetique.webp',
  '/landing/ugc-sneaker.webp',
  '/landing/ugc-cafe.webp',
  '/landing/ugc-casque.webp',
] as const;

/**
 * Positions des lumières colorées du hero. Elles sont coupées par palier :
 * sur un GPU intégré, six lumières dynamiques coûtaient ~11 % de l'image.
 */
const LUMIERES_TELEPHONE: Array<{
  position: [number, number, number];
  intensite: number;
  portee: number;
  teinte: string;
}> = [
  { position: [-3.2, 1.6, 3.2], intensite: 30, portee: 16, teinte: PALETTE.magenta },
  { position: [3.4, -1, 2.4], intensite: 24, portee: 14, teinte: PALETTE.rose },
  { position: [0, 2.8, 1.2], intensite: 14, portee: 12, teinte: PALETTE.orange },
];

/**
 * Nébuleuse : fond de la scène, ou rien du tout.
 *
 * En palier dégradé (`fond: 'css'`), la scène ne dessine plus de fond du tout :
 * le canvas devient transparent et c'est l'image CSS déjà présente sous lui qui
 * apparaît, avec son propre parallaxe. Un plan 3D plein écran coûtait ~25 % de
 * l'image ; laisser le compositeur dessiner une image est gratuit à côté.
 */
function Nebuleuse({ image, actif }: { image: HTMLImageElement | null; actif: boolean }) {
  const { scene } = useThree();
  const texture = useMemo(() => {
    if (!image) return null;
    const tex = new THREE.Texture(image);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }, [image]);

  useEffect(() => {
    scene.background = actif ? texture : null;
    return () => {
      scene.background = null;
    };
  }, [scene, texture, actif]);

  return null;
}

/**
 * Applique au renderer ce qui ne peut pas passer par une prop du Canvas :
 * le tone mapping et l'alpha de fond changent quand le palier change.
 */
function ReglagesRenderer({ reglages }: { reglages: Reglages }) {
  const { gl, scene } = useThree();

  useEffect(() => {
    gl.toneMapping = reglages.tonemapping ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    gl.toneMappingExposure = 1;
    /*
     * three ne recompile pas les matières quand le tone mapping change : sans
     * cela, le palier « bas » garderait le coût du tone mapping de « complet ».
     */
    scene.traverse((objet) => {
      const matiere = (objet as THREE.Mesh).material;
      if (Array.isArray(matiere)) matiere.forEach((m) => (m.needsUpdate = true));
      else if (matiere) matiere.needsUpdate = true;
    });
  }, [gl, scene, reglages.tonemapping]);

  useEffect(() => {
    // Fond dessiné par la scène : canvas opaque. Fond CSS : canvas transparent.
    gl.setClearAlpha(reglages.fond === '3d' ? 1 : 0);
    gl.setClearColor(new THREE.Color('#05030A'), reglages.fond === '3d' ? 1 : 0);
  }, [gl, reglages.fond]);

  return null;
}

/**
 * Diagnostic : expose `renderer.info` et la coupure par rôle, uniquement
 * quand l'URL contient `perf=1` (voir `diagnostic.ts`).
 */
function Diagnostic() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    exposerDiagnostic({ gl, scene, camera });
  }, [gl, scene, camera]);
  return null;
}

/**
 * Caméra vivante : la position est recalculée à chaque image depuis le
 * progrès lissé. Le lissage est ce qui distingue une caméra d'un curseur :
 * sans lui, un cran de molette se voit.
 */
function CameraVive({ portrait }: { portrait: boolean }) {
  const { camera } = useThree();
  const cible = useRef(new THREE.Vector3(0, 0, 0));
  const lisse = useRef(0);
  const position = useRef(new THREE.Vector3(0, 0.3, profondeurDepart(portrait)));

  useFrame((state, delta) => {
    const but = lireProgres();
    // Amortissement indépendant de la fréquence d'images.
    const k = 1 - Math.exp(-delta * 5);
    lisse.current += (but - lisse.current) * k;
    const etat = etatCamera(lisse.current, portrait);
    const parallaxe = state.pointer;

    position.current.set(
      etat.position[0] + parallaxe.x * 0.16,
      etat.position[1] - parallaxe.y * 0.1,
      etat.position[2],
    );
    camera.position.lerp(position.current, 1 - Math.exp(-delta * 8));
    cible.current.lerp(new THREE.Vector3(...etat.cible), 1 - Math.exp(-delta * 8));
    camera.lookAt(cible.current);
  });

  return null;
}

export default function Experience3D({
  portrait,
  allege,
  reglages = PALIERS.complet,
}: {
  portrait: boolean;
  allege: boolean;
  reglages?: Reglages;
}) {
  const images = useImages(VISUELS);

  // Compense la perte des lumières ponctuelles : sans cela les cadres
  // s'éteignent au lieu de simplement s'aplatir.
  const ambiante = 0.5 + (3 - reglages.lumieres) * 0.4;
  const lumiereIntensite = 1.1 + (3 - reglages.lumieres) * 0.25;

  return (
    <QualiteContexte.Provider value={reglages}>
      <Canvas
        /*
         * L'anticrénelage (MSAA) ne se change pas sur un contexte WebGL
         * existant : il faut recréer le canvas. La clé ne change qu'une fois
         * (on ne remonte jamais de palier), et sans elle la machine dégradée
         * automatiquement gardait le MSAA du palier « complet » — 30 fps au
         * lieu de 44 sur le GPU de la VM.
         */
        key={reglages.nom === 'complet' ? 'msaa' : 'sans-msaa'}
        dpr={reglages.dpr}
        camera={{ position: [0, 0.3, profondeurDepart(portrait)], fov: FOV, near: 0.1, far: 120 }}
        gl={{
          antialias: reglages.nom === 'complet',
          alpha: true,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
        }}
        style={{ pointerEvents: 'none' }}
        aria-hidden="true"
      >
        <ReglagesRenderer reglages={reglages} />
        {reglages.brouillard ? <fogExp2 attach="fog" args={['#05030A', 0.019]} /> : null}
        <Nebuleuse image={images[0] ?? null} actif={reglages.fond === '3d'} />
        <ambientLight intensity={ambiante} userData={{ role: 'lumiere' }} />
        <directionalLight
          position={[4, 6, 7]}
          intensity={lumiereIntensite}
          color="#FFEAF4"
          userData={{ role: 'lumiere' }}
        />
        {LUMIERES_TELEPHONE.slice(0, reglages.lumieres).map((lumiere, index) => (
          <pointLight
            key={index}
            position={lumiere.position}
            intensity={lumiere.intensite}
            distance={lumiere.portee}
            color={lumiere.teinte}
            userData={{ role: 'lumiere' }}
          />
        ))}

        <CameraVive portrait={portrait} />
        <Diagnostic />

        <TelephoneHero poster={images[1] ?? null} portrait={portrait} allege={allege} />
        <StudioMonde posters={images.slice(1)} allege={allege} />

        {reglages.ombres ? (
          /*
           * `frames={1}` : l'ombre est rendue UNE fois. Par défaut, drei
           * re-rend toute la scène en profondeur à chaque image.
           */
          <group userData={{ role: 'ombres' }}>
            <ContactShadows
              frames={1}
              position={[0, portrait ? -2.62 : -1.78, 0]}
              opacity={0.55}
              scale={8}
              blur={2.6}
              far={4}
              resolution={256}
              color="#000000"
            />
          </group>
        ) : null}
        {reglages.etincelles ? (
          <group userData={{ role: 'etincelles' }}>
            <Sparkles count={70} scale={[8, 5.5, 5]} size={1.7} speed={0.22} opacity={0.45} color="#F7C6DE" />
          </group>
        ) : null}
      </Canvas>
    </QualiteContexte.Provider>
  );
}
