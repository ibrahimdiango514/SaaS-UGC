/**
 * Le Studio en 3D : la caméra traverse un écran géant.
 *
 * ## Le décor, et pourquoi il est construit ainsi
 * - un **couloir de plans UGC** : huit affiches verticales réparties en
 *   profondeur, de part et d'autre du trajet. La caméra les dépasse une par
 *   une ; c'est ce qui donne la sensation d'avancer, pas un zoom.
 * - un **écran géant** au fond, dont la texture raconte les quatre états du
 *   Studio : brief, script, storyboard, vidéo prête.
 * - un **panneau de script** flottant qui se remplit ligne par ligne.
 * - une **barre de génération** en 3D qui se remplit avec le défilement.
 * - des halos additifs (pas de post-traitement) et une grille de sol pour
 *   donner l'échelle.
 *
 * ## Ce qui n'est jamais fait
 * Aucun texte n'est dessiné dans le HTML par-dessus un objet 3D : les titres
 * restent dans des zones libres, décidées par la caméra (voir `camera.ts`).
 */
import { RoundedBox } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useContext, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { PALETTE } from '../../systeme/palette';
import { dessinerEcranGeant, dessinerHalo } from './ecran';
import { POSITION_ECRAN } from './camera';
import { lireProgres } from './progres';
import { QualiteContexte } from './qualite';

function textureDepuisImage(image: HTMLImageElement | null): THREE.Texture | null {
  if (!image) return null;
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function Halo({
  position,
  echelle,
  teinte,
  opacite,
  rotation,
}: {
  position: [number, number, number];
  echelle: number;
  teinte: string;
  opacite: number;
  rotation?: [number, number, number];
}) {
  const reglages = useContext(QualiteContexte);
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) dessinerHalo(ctx, 256, teinte);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [teinte]);

  // Palier dégradé : les halos sont remplacés par des lueurs CSS, qui ne
  // coûtent rien au GPU (mesuré : ~30 % de l'image à eux seuls).
  if (!reglages.halos) return null;

  return (
    <mesh position={position} rotation={rotation} scale={echelle} userData={{ role: 'halo' }}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={opacite}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </mesh>
  );
}

/** Affiche verticale d'un plan UGC, avec son cadre. */
function Affiche({
  image,
  position,
  rotation,
  phase,
}: {
  image: HTMLImageElement | null;
  position: [number, number, number];
  rotation: [number, number, number];
  phase: number;
}) {
  const reglages = useContext(QualiteContexte);
  const texture = useMemo(() => textureDepuisImage(image), [image]);
  const groupe = useRef<THREE.Group>(null);

  useFrame((state) => {
    if (!groupe.current) return;
    const t = state.clock.elapsedTime;
    groupe.current.position.y = position[1] + Math.sin(t * 0.5 + phase) * 0.09;
    groupe.current.rotation.z = Math.sin(t * 0.35 + phase) * 0.02;
  });

  return (
    <group ref={groupe} position={position} rotation={rotation} userData={{ role: 'affiche' }}>
      <RoundedBox args={[1.62, 2.82, 0.075]} radius={0.08} smoothness={reglages.segments}>
        <meshStandardMaterial color="#1A0F24" metalness={0.75} roughness={0.36} />
      </RoundedBox>
      <mesh position={[0, 0.08, 0.042]}>
        <planeGeometry args={[1.48, 2.5]} />
        {texture ? (
          <meshBasicMaterial map={texture} toneMapped={false} />
        ) : (
          <meshStandardMaterial color="#2A0A2E" emissive={PALETTE.magenta} emissiveIntensity={0.12} />
        )}
      </mesh>
      {/* Filet lumineux : la carte reste lisible dans la pénombre. */}
      <mesh position={[0, 0.08, 0.043]}>
        <planeGeometry args={[1.48, 2.5]} />
        <meshBasicMaterial color={PALETTE.magenta} transparent opacity={0.05} toneMapped={false} depthWrite={false} />
      </mesh>
      <mesh position={[0, -1.36, 0.045]}>
        <planeGeometry args={[1.2, 0.012]} />
        <meshBasicMaterial color={PALETTE.rose} toneMapped={false} transparent opacity={0.5} />
      </mesh>
    </group>
  );
}

/** L'écran géant : cadre épais + dalle + halo. */
function EcranGeant({ poster, allege }: { poster: HTMLImageElement | null; allege: boolean }) {
  const toile = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 576;
    return canvas;
  }, []);

  const texture = useMemo(() => {
    const tex = new THREE.CanvasTexture(toile);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    // Texture redessinée à chaque état : pas de mipmaps (niveaux lointains
    // instables sur une texture animée).
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    return tex;
  }, [toile]);

  const derniereEtape = useRef(-1);
  const halo = useRef<THREE.Mesh>(null);
  /*
   * En portrait, la dalle de 6,68 unités débordait des deux côtés du cadre :
   * le rail d'étapes était coupé en plein mot. On la réduit pour qu'elle
   * tienne entière dans un écran de 360 px, texte compris.
   */
  const { size } = useThree();
  const portrait = size.width < 768;

  useFrame(() => {
    const progres = lireProgres();
    const etape = progres >= 0.8 ? 3 : progres >= 0.62 ? 2 : progres >= 0.44 ? 1 : 0;
    if (etape !== derniereEtape.current) {
      derniereEtape.current = etape;
      const ctx = toile.getContext('2d');
      if (ctx) {
        dessinerEcranGeant(ctx, toile.width, toile.height, etape, poster);
        texture.needsUpdate = true;
      }
    }
    if (halo.current) {
      // La lumière de l'écran monte quand la vidéo s'allume.
      const montee = Math.min(1, Math.max(0, (progres - 0.72) / 0.24));
      const mat = halo.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.12 + montee * 0.28;
      halo.current.scale.setScalar(7.4 + montee * 1.5);
    }
  });

  return (
    <group position={POSITION_ECRAN} scale={portrait ? 0.54 : 1} userData={{ role: 'ecran' }}>
      <Halo position={[0, 0, -0.6]} echelle={11} teinte={PALETTE.magenta} opacite={0.18} />
      <RoundedBox args={[7.0, 4.15, 0.3]} radius={0.12} smoothness={4}>
        <meshStandardMaterial color="#170D20" metalness={0.9} roughness={0.26} />
      </RoundedBox>
      <mesh position={[0, 0, 0.16]}>
        <planeGeometry args={[6.68, 3.82]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      {/* Halo additif devant la dalle : l'écran éclaire la scène. */}
      <mesh ref={halo} position={[0, 0, 0.9]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          color={PALETTE.rose}
          transparent
          opacity={0.16}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {/* Pied discret : l'écran est posé, pas suspendu. */}
      <mesh position={[0, -2.42, -0.1]} rotation={[0, 0, 0]}>
        <boxGeometry args={[0.22, 0.6, 0.22]} />
        <meshStandardMaterial color="#241631" metalness={0.85} roughness={0.35} />
      </mesh>
      <mesh position={[0, -2.72, -0.1]}>
        <boxGeometry args={[2.6, 0.08, 1.1]} />
        <meshStandardMaterial color="#1A1022" metalness={0.7} roughness={0.4} />
      </mesh>
      {allege ? null : <Halo position={[0, -2.2, 0.4]} echelle={5.6} teinte={PALETTE.orange} opacite={0.16} />}
    </group>
  );
}

/** Sol : grille à peine visible, pour donner l'échelle du couloir. */
function Sol() {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#05030A';
      ctx.fillRect(0, 0, 512, 512);
      ctx.strokeStyle = 'rgba(240,56,158,0.22)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 16; i += 1) {
        const p = (i / 16) * 512;
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, 512);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, p);
        ctx.lineTo(512, p);
        ctx.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 10);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -3.05, -12]} userData={{ role: 'sol' }}>
      <planeGeometry args={[38, 44]} />
      <meshBasicMaterial map={texture} transparent opacity={0.42} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

export function StudioMonde({
  posters,
  allege,
}: {
  posters: Array<HTMLImageElement | null>;
  allege: boolean;
}) {
  const reglages = useContext(QualiteContexte);
  const lumiereActive = reglages.lumieres;
  /*
   * Le couloir est décalé à droite : la caméra vise à gauche de l'écran, donc
   * les affiches défilent dans la moitié droite du champ et ne passent jamais
   * sous le titre. Les deux dernières sont écartées pour ne pas masquer
   * l'écran géant à l'arrivée.
   */
  const positions: Array<{ p: [number, number, number]; r: [number, number, number] }> = [
    { p: [-1.3, 1.0, -6], r: [0, 0.3, 0.03] },
    { p: [3.4, 0.2, -7.6], r: [0, -0.36, -0.02] },
    { p: [-1.5, -0.9, -9.6], r: [0, 0.24, -0.03] },
    { p: [3.6, 1.0, -11.6], r: [0, -0.32, 0.02] },
    { p: [-1.6, 0.35, -13.6], r: [0, 0.26, 0.04] },
    { p: [4.9, -0.7, -15.4], r: [0, -0.3, -0.02] },
    { p: [-2.6, 1.15, -17.5], r: [0, 0.22, -0.03] },
    { p: [5.2, 0.6, -19], r: [0, -0.24, 0.02] },
  ];

  // `allege` garde le comportement de la livraison 1 (une affiche sur deux) :
  // le palier, lui, agit sur le nombre d'affiches du couloir.
  const affiches = allege
    ? positions.filter((_, index) => index % 2 === 0)
    : positions.slice(0, Math.min(positions.length, reglages.affiches));
  /*
   * Le décor du Studio n'existe pas dans le hero : sans cela, les affiches du
   * couloir apparaissaient derrière le téléphone et passaient sous le titre.
   * La lumière du Studio s'allume avec lui, pas avant.
   */
  const groupe = useRef<THREE.Group>(null);
  useFrame(() => {
    if (groupe.current) groupe.current.visible = lireProgres() > 0.1;
  });

  return (
    <group ref={groupe}>
      <Sol />
      <Halo position={[1.5, 1.6, -8]} echelle={9} teinte={PALETTE.violet} opacite={0.14} />
      <Halo position={[-2.4, -1.2, -13]} echelle={7} teinte={PALETTE.rose} opacite={0.12} />

      {affiches.map((affiche, index) => (
        <Affiche
          key={index}
          image={posters[index % Math.max(1, posters.length)] ?? null}
          position={affiche.p}
          rotation={affiche.r}
          phase={index * 1.3}
        />
      ))}

      <EcranGeant poster={posters[0] ?? null} allege={allege} />

      {/* Lampes de plateau : trois sources colorées, aucune lumière blanche dure. */}
      {lumiereActive > 0 ? (
        <pointLight position={[4.5, 2.4, -8]} intensity={26} distance={22} color={PALETTE.magenta} />
      ) : null}
      {lumiereActive > 1 ? (
        <pointLight position={[-4.5, 1.2, -12]} intensity={18} distance={20} color={PALETTE.rose} />
      ) : null}
      {lumiereActive > 2 ? (
        <pointLight position={[0, 0.4, -21]} intensity={14} distance={16} color={PALETTE.orange} />
      ) : null}
    </group>
  );
}
