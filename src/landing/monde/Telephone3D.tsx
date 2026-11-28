/**
 * Téléphone 3D du hero — vrai volume, vraie lumière.
 *
 * ## Ce qui est réellement 3D ici
 * - châssis arrondi (RoundedBox, congés réels) avec un cadre métallique qui
 *   capte les lumières colorées de la scène ;
 * - écran incliné dans l'épaisseur du corps, texture redessinée en continu
 *   (brief → script → storyboard → vidéo) ;
 * - îlot photo avec trois optiques et deux boutons latéraux ;
 * - reflet mobile : une bande de lumière additive qui balaie la vitre ;
 * - ombre portée douce (ContactShadows) sous l'appareil ;
 * - deux étiquettes (« Studio », « Grow ») en orbite, tournées vers la caméra.
 *
 * ## Ce que la scène ne fait pas
 * Aucune texture distante, aucun modèle à télécharger : la géométrie est
 * construite en code et les seules images sont des WebP locaux de 17 à 34 Ko.
 */
import { RoundedBox } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useContext, useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { PALETTE } from '../../systeme/palette';
import { dessinerEcranTelephone, dessinerEtiquette, dessinerHalo } from './ecran';
import { lireProgres } from './progres';
import { QualiteContexte } from './qualite';

const POSTER_VIDEO = '/landing/ugc-cosmetique.webp';

/**
 * Écran découpé en rectangle arrondi, en géométrie réelle.
 *
 * Une texture arrondie sur un plan carré oblige à activer `transparent` : le
 * plan se mélange alors avec ce qui est derrière (la nébuleuse, constatée à
 * l'image). Ici la forme elle-même est arrondie : le matériau reste opaque,
 * et l'écran ne peut plus laisser passer le fond.
 */
function geometrieEcran(largeur: number, hauteur: number, rayon: number) {
  const x = -largeur / 2;
  const y = -hauteur / 2;
  const forme = new THREE.Shape();
  forme.moveTo(x + rayon, y);
  forme.lineTo(x + largeur - rayon, y);
  forme.quadraticCurveTo(x + largeur, y, x + largeur, y + rayon);
  forme.lineTo(x + largeur, y + hauteur - rayon);
  forme.quadraticCurveTo(x + largeur, y + hauteur, x + largeur - rayon, y + hauteur);
  forme.lineTo(x + rayon, y + hauteur);
  forme.quadraticCurveTo(x, y + hauteur, x, y + hauteur - rayon);
  forme.lineTo(x, y + rayon);
  forme.quadraticCurveTo(x, y, x + rayon, y);
  const geometrie = new THREE.ShapeGeometry(forme, 10);
  geometrie.computeBoundingBox();
  const boite = geometrie.boundingBox;
  const positions = geometrie.attributes.position;
  const uvs = geometrie.attributes.uv;
  if (boite && uvs) {
    for (let i = 0; i < uvs.count; i += 1) {
      uvs.setXY(
        i,
        (positions.getX(i) - boite.min.x) / (boite.max.x - boite.min.x),
        (positions.getY(i) - boite.min.y) / (boite.max.y - boite.min.y),
      );
    }
    uvs.needsUpdate = true;
  }
  return geometrie;
}

/**
 * Le canvas du téléphone garde un canal alpha côté WebGL : l'écran se
 * composait donc avec le fond de la scène (nébuleuse visible à travers la
 * dalle, constaté à la capture). On force l'alpha du fragment à 1 pour un
 * écran réellement opaque, quelle que soit la texture.
 */
const ecranOpaque = (shader: { fragmentShader: string }) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <dithering_fragment>',
    '#include <dithering_fragment>\n  gl_FragColor.a = 1.0;',
  );
};

function useEcranTelephone(poster: HTMLImageElement | null) {
  const reglages = useContext(QualiteContexte);
  const toile = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = reglages.resolutionEcran;
    canvas.height = reglages.resolutionEcran * 2;
    // Force la création du contexte opaque avant le premier dessin.
    canvas.getContext('2d', { alpha: false });
    return canvas;
    // La résolution suit le palier : un écran redessiné en 320 px coûte moins
    // cher à uploader qu'un 512 px, à chaque redessin.
  }, [reglages.resolutionEcran]);

  const texture = useMemo(() => {
    const tex = new THREE.CanvasTexture(toile);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    /*
     * Pas de mipmaps : la texture est redessinée en continu. Le renderer
     * régénérait des niveaux de mip à chaque image, et les niveaux lointains
     * apparaissaient comme des nuages roses à travers l'écran (constaté à la
     * capture). En filtrage linéaire simple, l'écran reste net et stable.
     */
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    return tex;
  }, [toile]);

  const dernier = useRef(-1);

  useFrame((state) => {
    /*
     * Contexte SANS canal alpha. Avec un contexte alpha, l'upload de la
     * texture se composait avec le fond de la scène au travers de l'écran
     * (constaté à l'image) ; sans alpha, l'écran est réellement opaque.
     */
    const ctx = toile.getContext('2d', { alpha: false });
    if (!ctx) return;
    const temps = state.clock.elapsedTime;
    /*
     * 12 images par seconde pour l'écran : chaque redessin upload une texture
     * de 512×1024, et Chrome lit le canvas 2D pour l'envoyer au GPU (les
     * avertissements « GPU stall due to ReadPixels » venaient de là). À 24 Hz
     * ce seul upload coûtait plus que la scène entière.
     */
    if (temps - dernier.current < 1 / reglages.ecranHz) return;
    dernier.current = temps;
    dessinerEcranTelephone(ctx, toile.width, toile.height, { secondes: temps, poster });
    texture.needsUpdate = true;
  });

  return texture;
}

/** Halo doux : un plan additif, pas un post-traitement. */
function Halo({
  position,
  echelle,
  teinte,
  opacite,
}: {
  position: [number, number, number];
  echelle: number;
  teinte: string;
  opacite: number;
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

  if (!reglages.halos) return null;

  return (
    <mesh position={position} scale={echelle} userData={{ role: 'halo' }}>
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

/** Étiquette de verre en orbite, toujours face caméra. */
function Etiquette({
  texte,
  detail,
  teinte,
  base,
  phase,
  echelle,
}: {
  texte: string;
  detail: string;
  teinte: string;
  base: [number, number];
  phase: number;
  echelle: number;
}) {
  const groupe = useRef<THREE.Group>(null);
  const { camera } = useThree();

  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    if (ctx) dessinerEtiquette(ctx, 512, 160, texte, teinte, detail);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }, [texte, teinte, detail]);

  useFrame((state) => {
    if (!groupe.current) return;
    const t = state.clock.elapsedTime;
    groupe.current.position.set(
      base[0] + Math.sin(t * 0.35 + phase) * 0.16,
      base[1] + Math.sin(t * 0.55 + phase) * 0.12,
      // L'étiquette passe devant puis derrière l'appareil : la profondeur est
      // réelle, elle n'est pas simulée par une opacité.
      Math.cos(t * 0.42 + phase) * 0.55,
    );
    groupe.current.quaternion.copy(camera.quaternion);
  });

  return (
    <group ref={groupe} scale={echelle} userData={{ role: 'etiquette' }}>
      <mesh>
        <planeGeometry args={[1.35, 0.42]} />
        <meshBasicMaterial map={texture} transparent toneMapped={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Bande de reflet qui balaie la vitre. */
function Reflet({ allege }: { allege: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);

  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const g = ctx.createLinearGradient(0, 0, 256, 512);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 512);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  useFrame((state) => {
    if (!mesh.current) return;
    const t = (state.clock.elapsedTime % 7) / 7;
    mesh.current.position.x = -1.9 + t * 3.8;
    mesh.current.position.y = 2.1 - t * 4 - 1.3;
  });

  if (!texture) return null;

  return (
    <mesh ref={mesh} position={[-1.6, 0.8, 0.098]} rotation={[0, 0, -0.42]}>
      <planeGeometry args={[0.62, 2.9]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={allege ? 0.12 : 0.2}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </mesh>
  );
}

/**
 * Coque profilée : rectangle arrondi extrudé avec un biseau.
 *
 * Un RoundedBox de drei applique le même rayon dans les trois axes ; avec une
 * épaisseur de 0,16 unité, un rayon de 0,17 rendait la face avant dégénérée —
 * on voyait la nébuleuse au travers de l'écran (constaté à la capture). Une
 * extrusion donne de vrais grands congés dans le plan du téléphone et un
 * biseau fin sur l'épaisseur, comme un appareil réel.
 */
function geometrieCorps(largeur: number, hauteur: number, rayon: number, profondeur: number) {
  const x = -largeur / 2;
  const y = -hauteur / 2;
  const forme = new THREE.Shape();
  forme.moveTo(x + rayon, y);
  forme.lineTo(x + largeur - rayon, y);
  forme.quadraticCurveTo(x + largeur, y, x + largeur, y + rayon);
  forme.lineTo(x + largeur, y + hauteur - rayon);
  forme.quadraticCurveTo(x + largeur, y + hauteur, x + largeur - rayon, y + hauteur);
  forme.lineTo(x + rayon, y + hauteur);
  forme.quadraticCurveTo(x, y + hauteur, x, y + hauteur - rayon);
  forme.lineTo(x, y + rayon);
  forme.quadraticCurveTo(x, y, x + rayon, y);
  const geometrie = new THREE.ExtrudeGeometry(forme, {
    depth: profondeur,
    bevelEnabled: true,
    bevelThickness: 0.014,
    bevelSize: 0.016,
    bevelSegments: 3,
    curveSegments: 12,
    steps: 1,
  });
  geometrie.center();
  return geometrie;
}

/** Le châssis : corps, cadre, boutons, îlot photo. */
function Chassis({ children }: { children?: ReactNode }) {
  const corps = useMemo(() => geometrieCorps(1.55, 3.2, 0.24, 0.13), []);
  const cadre = useMemo(() => geometrieCorps(1.585, 3.235, 0.255, 0.12), []);

  return (
    <group>
      {/* Cadre métallique : il dépasse d'un demi-millimètre et capte la lumière. */}
      <mesh geometry={cadre} position={[0, 0, -0.004]}>
        <meshStandardMaterial color="#5A3E63" metalness={1} roughness={0.18} />
      </mesh>
      {/* Corps : verre noir légèrement dépolis, biseau compris. */}
      <mesh geometry={corps}>
        <meshPhysicalMaterial
          color="#170D20"
          metalness={0.6}
          roughness={0.34}
          clearcoat={0.85}
          clearcoatRoughness={0.2}
        />
      </mesh>

      {/* Boutons : épaisseur réelle, pas une ligne peinte. */}
      <mesh position={[0.79, 0.55, 0]} rotation={[0, 0, Math.PI / 2]}>
        <boxGeometry args={[0.035, 0.055, 0.42]} />
        <meshStandardMaterial color="#3A2743" metalness={1} roughness={0.3} />
      </mesh>
      <mesh position={[-0.79, 0.4, 0]} rotation={[0, 0, Math.PI / 2]}>
        <boxGeometry args={[0.035, 0.05, 0.3]} />
        <meshStandardMaterial color="#3A2743" metalness={1} roughness={0.3} />
      </mesh>
      <mesh position={[-0.79, 0.02, 0]} rotation={[0, 0, Math.PI / 2]}>
        <boxGeometry args={[0.035, 0.05, 0.3]} />
        <meshStandardMaterial color="#3A2743" metalness={1} roughness={0.3} />
      </mesh>

      {/* Îlot photo à trois optiques, sur la face arrière. */}
      <group position={[0.3, 1.03, -0.095]}>
        <RoundedBox args={[0.66, 0.7, 0.07]} radius={0.03} smoothness={4}>
          <meshStandardMaterial color="#241631" metalness={0.9} roughness={0.25} />
        </RoundedBox>
        {[
          [-0.16, 0.17],
          [0.16, 0.17],
          [-0.16, -0.17],
        ].map(([x, y], index) => (
          <group key={index} position={[x, y, -0.045]}>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.105, 0.105, 0.035, 32]} />
              <meshStandardMaterial color="#0B0610" metalness={0.8} roughness={0.2} />
            </mesh>
            <mesh position={[0, 0, -0.022]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.055, 0.055, 0.012, 24]} />
              <meshPhysicalMaterial
                color="#1B2A3A"
                metalness={1}
                roughness={0.05}
                clearcoat={1}
                emissive={PALETTE.violet}
                emissiveIntensity={0.35}
              />
            </mesh>
          </group>
        ))}
      </group>

      {children}
    </group>
  );
}

export function TelephoneHero({
  poster,
  portrait,
  allege,
}: {
  poster: HTMLImageElement | null;
  portrait: boolean;
  allege: boolean;
}) {
  const texture = useEcranTelephone(poster);
  const ecran = useMemo(() => geometrieEcran(1.46, 2.92, 0.16), []);
  const groupe = useRef<THREE.Group>(null);
  /*
   * Angle de rotation accumulé, indépendant de la fréquence d'images : la
   * vitesse est en radians par seconde. Un tour complet en 48 s.
   */
  const angle = useRef(0);
  const { size } = useThree();
  const echelle = portrait ? 1 : 1.02;
  const y = portrait ? -0.95 : 0;
  // En paysage le téléphone est décalé à droite : le titre occupe la gauche.
  const x = portrait ? 0 : 1.5;

  useFrame((state, delta) => {
    if (!groupe.current) return;
    const t = state.clock.elapsedTime;
    const k = 1 - Math.exp(-delta * 2.2);
    // Flottement lent + parallaxe du pointeur (limitée : le texte ne bouge pas).
    const cibleX = x + state.pointer.x * 0.12;
    const cibleY = y + Math.sin(t * 0.62) * 0.055;
    groupe.current.position.x = THREE.MathUtils.lerp(groupe.current.position.x, cibleX, k);
    groupe.current.position.y = THREE.MathUtils.lerp(groupe.current.position.y, cibleY, k);
    /*
     * ROTATION PERMANENTE. L'appareil tourne sans interruption, à vitesse
     * constante (un tour en 48 s), sur l'axe vertical. L'angle est accumulé
     * avec `delta` : la vitesse reste la même à 30 comme à 60 images/s, et
     * l'arrêt d'un onglet ne crée pas de saut. Le pointeur ne fait qu'ajouter
     * un léger décalage, il ne remplace pas la rotation.
     */
    angle.current = (angle.current + delta * ((Math.PI * 2) / 48)) % (Math.PI * 2);
    groupe.current.rotation.y = angle.current + state.pointer.x * 0.1;
    groupe.current.rotation.x = Math.sin(t * 0.55) * 0.035 - state.pointer.y * 0.05;
    groupe.current.rotation.z = Math.sin(t * 0.4) * 0.012;
    // Au-delà de 30 % la caméra a dépassé le téléphone et entre dans le
    // couloir : le garder visible le faisait traverser le cadre en gros plan,
    // par-dessus l'écran du Studio (constaté à la capture).
    groupe.current.visible = lireProgres() < 0.3;
  });

  // Le cadrage (taille du téléphone dans le champ) est décidé par la caméra :
  // voir `partHauteurTelephone`. `size` est lu pour forcer un rendu correct au
  // redimensionnement.
  void size;

  return (
    <>
      <Halo position={[x + 0.2, y + 0.1, -1.4]} echelle={5.6} teinte={PALETTE.magenta} opacite={allege ? 0.28 : 0.42} />
      <Halo position={[x - 1.2, y - 1.2, -0.8]} echelle={3.6} teinte={PALETTE.rose} opacite={allege ? 0.2 : 0.3} />
      <Halo position={[x + 1.5, y + 1.3, -1.8]} echelle={2.8} teinte={PALETTE.orange} opacite={allege ? 0.12 : 0.2} />

      <group ref={groupe} scale={echelle}>
        <Chassis>
          {/* L'écran est nettement devant la face avant : à 1 mm de la coque,
              il perdait le test de profondeur et laissait voir le reflet du
              corps. Constaté à la capture, corrigé ici. */}
          <mesh geometry={ecran} position={[0, 0, 0.09]}>
            <meshBasicMaterial map={texture} toneMapped={false} onBeforeCompile={ecranOpaque} />
          </mesh>
          {/* Vitre : un reflet spéculaire discret, jamais un voile gris. */}
          <mesh position={[0, 0, 0.103]}>
            <planeGeometry args={[1.5, 3.08]} />
            <meshPhysicalMaterial
              transparent
              opacity={0.07}
              roughness={0.04}
              metalness={0.35}
              color="#FFFFFF"
              depthWrite={false}
            />
          </mesh>
          <Reflet allege={allege} />
        </Chassis>
      </group>

      {/* Sur mobile le téléphone remplit la largeur : les étiquettes
          sortaient du cadre, coupées net. Elles ne servent qu'en paysage,
          où il reste du vide autour de l'appareil. */}
      {!portrait && (
        <>
        <Etiquette
          texte="Studio"
          detail="Brief · script · vidéo"
          teinte={PALETTE.magenta}
          base={portrait ? [-0.93, -0.42] : [0.05, 1.62]}
          phase={0}
          echelle={portrait ? 0.62 : 0.62}
        />
        <Etiquette
          texte="Grow"
          detail="CRM · ventes · trésorerie"
          teinte={PALETTE.rose}
          base={portrait ? [0.93, -1.62] : [3.0, -1.55]}
          phase={Math.PI}
          echelle={portrait ? 0.62 : 0.62}
        />
        </>
      )}
    </>
  );
}

export { POSTER_VIDEO };
