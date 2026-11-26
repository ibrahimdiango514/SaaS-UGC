/**
 * Scène hero — téléphone 9:16 flottant (react-three-fiber).
 *
 * ## Ce que la scène raconte, en quatre temps
 * 1. fond cosmique, nébuleuse qui respire ;
 * 2. le téléphone s'allume ;
 * 3. sur son écran, un brief se tape, un script se construit, une vidéo s'allume ;
 * 4. deux étiquettes (Studio, Grow) orbitent autour de l'appareil.
 *
 * ## Pourquoi l'écran est une texture dessinée et non une vidéo
 * Une vidéo d'exemple pèserait plusieurs mégaoctets pour un objet de 30 px de
 * haut à l'écran, et empêcherait la page de finir son chargement sous 3 Mo.
 * Le contenu de l'écran est donc dessiné dans un canvas 2D puis projeté en
 * texture : même récit, poids négligeable, et aucun fichier à valider.
 *
 * ## Ce que la scène ne fait jamais
 * - Aucune lumière spéculaire agressive : le téléphone est un objet sombre,
 *   cohérent avec le fond cosmique, pas un bijou chromé.
 * - Aucune animation dépendante du temps de chargement : la scène est identique
 *   à la première image et après dix secondes.
 */
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Sparkles } from '@react-three/drei';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { PALETTE } from '../systeme/palette';

/**
 * Dessine l'écran du téléphone : brief → script → vidéo.
 *
 * Un seul canvas réutilisé, redessiné chaque image. `progress` va de 0 à 1 en
 * boucle ; chaque temps du récit occupe un tiers de la boucle.
 */
function dessinerEcran(ctx: CanvasRenderingContext2D, taille: number, progress: number) {
  const l = taille;
  const h = taille * (16 / 9);
  ctx.clearRect(0, 0, l, h);

  // Fond de l'écran : dégradé sombre, plus clair en bas (lumière de la vidéo).
  const fond = ctx.createLinearGradient(0, 0, 0, h);
  fond.addColorStop(0, '#12071C');
  fond.addColorStop(1, '#2A0A2E');
  ctx.fillStyle = fond;
  ctx.fillRect(0, 0, l, h);

  // Le récit occupe trois tiers de la boucle.
  const etape = Math.min(2, Math.floor(progress * 3));
  const local = progress * 3 - etape; // 0 → 1 dans l'étape courante
  const marge = l * 0.09;
  const largeurUtile = l - marge * 2;

  ctx.textBaseline = 'top';

  if (etape === 0) {
    // 1. Le brief se tape.
    ctx.fillStyle = '#8B7FA0';
    ctx.font = `600 ${Math.round(l * 0.055)}px system-ui, sans-serif`;
    ctx.fillText('BRIEF', marge, h * 0.13);

    ctx.fillStyle = '#EDE4F5';
    ctx.font = `500 ${Math.round(l * 0.062)}px system-ui, sans-serif`;
    const phrase = 'Crème hydratante bio, cible 25-35 ans';
    const caracteres = Math.ceil(phrase.length * Math.min(1, local * 1.4));
    const mots = phrase.slice(0, caracteres);
    // Retour à la ligne manuel : `fillText` n'en gère aucun.
    const maxMotsParLigne = 14;
    let ligne = 0;
    for (let i = 0; i < mots.length; i += maxMotsParLigne) {
      ctx.fillText(mots.slice(i, i + maxMotsParLigne), marge, h * 0.2 + ligne * l * 0.085);
      ligne += 1;
    }
    // Curseur clignotant : montre que la saisie est en cours.
    if (Math.floor(local * 6) % 2 === 0) {
      ctx.fillStyle = PALETTE.magenta;
      const derniere = mots.slice(-maxMotsParLigne).length;
      ctx.fillRect(marge + derniere * l * 0.032, h * 0.2 + (ligne - 1) * l * 0.085, l * 0.02, l * 0.06);
    }
  } else if (etape === 1) {
    // 2. Le script se construit, ligne par ligne.
    ctx.fillStyle = '#8B7FA0';
    ctx.font = `600 ${Math.round(l * 0.055)}px system-ui, sans-serif`;
    ctx.fillText('SCRIPT', marge, h * 0.13);

    const lignes = ['Accroche : « Ta peau', 'respire enfin. »', 'Scène 2 : texture', 'en gros plan.', 'CTA : décarcasse'];
    ctx.font = `500 ${Math.round(l * 0.058)}px system-ui, sans-serif`;
    lignes.forEach((texte, index) => {
      const seuil = (index + 1) / (lignes.length + 1);
      if (local < seuil) return;
      ctx.fillStyle = index === lignes.length - 1 ? PALETTE.orange : '#EDE4F5';
      ctx.fillText(texte, marge, h * 0.2 + index * l * 0.09);
    });
  } else {
    // 3. La vidéo s'allume : halo chaud qui monte, puis barre de lecture.
    const lueur = ctx.createRadialGradient(l / 2, h * 0.42, l * 0.05, l / 2, h * 0.42, l * 0.85);
    lueur.addColorStop(0, `rgba(251,113,133,${0.55 * Math.min(1, local * 2)})`);
    lueur.addColorStop(1, 'rgba(124,58,237,0)');
    ctx.fillStyle = lueur;
    ctx.fillRect(0, 0, l, h);

    // Silhouette générique d'un produit : aucun visage, aucune personne réelle.
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.roundRect(l * 0.3, h * 0.34, l * 0.4, h * 0.26, l * 0.06);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `600 ${Math.round(l * 0.06)}px system-ui, sans-serif`;
    ctx.fillText('Vidéo prête', marge, h * 0.7);

    // Barre de lecture qui progresse.
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(marge, h * 0.8, largeurUtile, l * 0.014);
    ctx.fillStyle = PALETTE.orange;
    ctx.fillRect(marge, h * 0.8, largeurUtile * Math.min(1, local * 1.2), l * 0.014);
  }
}

/** Écran du téléphone : un plan texturé par le canvas de récit. */
function EcranRecit() {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 640;
    const ctx = canvas.getContext('2d');
    if (ctx) dessinerEcran(ctx, 360, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { canvas, ctx, tex };
  }, []);

  const debut = useRef<number | null>(null);

  useFrame((state) => {
    if (!texture.ctx) return;
    if (debut.current === null) debut.current = state.clock.elapsedTime;
    // Boucle de 9 s : assez lente pour être lue, assez courte pour se voir.
    const progress = ((state.clock.elapsedTime - debut.current) % 9) / 9;
    dessinerEcran(texture.ctx, 360, progress);
    texture.tex.needsUpdate = true;
  });

  return (
    <mesh position={[0, 0, 0.061]}>
      <planeGeometry args={[0.62, 1.1]} />
      <meshBasicMaterial map={texture.tex} toneMapped={false} />
    </mesh>
  );
}

/** Le téléphone : châssis arrondi, écran, et une lueur qui déborde. */
function Telephone() {
  return (
    <group rotation={[0, -0.22, 0]}>
      {/* Châssis */}
      <mesh>
        <boxGeometry args={[0.7, 1.42, 0.1]} />
        <meshStandardMaterial color="#0B0512" metalness={0.65} roughness={0.35} />
      </mesh>
      {/* Contour lumineux : c'est lui qui « s'allume ». */}
      <mesh scale={[1.02, 1.012, 1]}>
        <boxGeometry args={[0.7, 1.42, 0.1]} />
        <meshBasicMaterial color={PALETTE.magenta} transparent opacity={0.16} />
      </mesh>
      <EcranRecit />
    </group>
  );
}

/** Étiquette en orbite : Studio, Grow. */
function Etiquette({ texte, couleur, rayon, vitesse, phase }: {
  texte: string;
  couleur: string;
  rayon: number;
  vitesse: number;
  phase: number;
}) {
  const groupe = useRef<THREE.Group>(null);
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(10,5,18,0.82)';
      ctx.beginPath();
      ctx.roundRect(4, 4, 248, 88, 44);
      ctx.fill();
      ctx.strokeStyle = couleur;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '600 42px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(texte, 128, 50);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [texte, couleur]);

  useFrame((state) => {
    if (!groupe.current) return;
    const t = state.clock.elapsedTime * vitesse + phase;
    groupe.current.position.set(Math.cos(t) * rayon, Math.sin(t * 0.7) * 0.28 + 0.1, Math.sin(t) * rayon * 0.45);
    // Les étiquettes s'effacent derrière le téléphone : sans cela elles le traversent.
    const profondeur = groupe.current.position.z;
    const opacite = THREE.MathUtils.clamp(0.55 + profondeur * 0.5, 0.25, 1);
    groupe.current.scale.setScalar(0.42 * opacite + 0.18);
  });

  return (
    <group ref={groupe}>
      <mesh>
        <planeGeometry args={[0.86, 0.32]} />
        <meshBasicMaterial map={texture} transparent toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Nébuleuse : deux grands plans dégradés qui dérivent lentement. */
function Nebuleuse({ teinte, position, echelle, vitesse }: {
  teinte: string;
  position: [number, number, number];
  echelle: number;
  vitesse: number;
}) {
  const mesh = useRef<THREE.Mesh>(null);
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
      g.addColorStop(0, teinte);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [teinte]);

  useFrame((state) => {
    if (!mesh.current) return;
    const t = state.clock.elapsedTime;
    mesh.current.rotation.z = t * vitesse * 0.12;
    // « Respiration » : échelle qui va et vient, jamais de saut.
    mesh.current.scale.setScalar(echelle * (1 + Math.sin(t * 0.5 * vitesse) * 0.06));
  });

  return (
    <mesh ref={mesh} position={position}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={texture} transparent opacity={0.5} depthWrite={false} />
    </mesh>
  );
}

export default function HeroPhoneScene() {
  return (
    <Canvas
      dpr={[1, 1.6]}
      camera={{ position: [0, 0, 4.2], fov: 42 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      style={{ pointerEvents: 'none' }}
    >
      <ambientLight intensity={0.6} />
      {/* Lumière magenta côté gauche, rose côté droit : la marque éclaire l'objet. */}
      <pointLight position={[-2.4, 1.4, 2.6]} intensity={22} color={PALETTE.magenta} distance={9} />
      <pointLight position={[2.6, -0.6, 1.8]} intensity={16} color={PALETTE.rose} distance={9} />
      <pointLight position={[0, 2.6, 1.2]} intensity={8} color={PALETTE.orange} distance={7} />

      <Nebuleuse teinte="rgba(124,58,237,0.55)" position={[-1.5, 0.7, -3]} echelle={5.4} vitesse={1} />
      <Nebuleuse teinte="rgba(240,56,158,0.42)" position={[1.8, -0.9, -3.4]} echelle={4.6} vitesse={1.4} />

      <Float speed={1.6} rotationIntensity={0.18} floatIntensity={0.55}>
        <Telephone />
      </Float>

      <Etiquette texte="Studio" couleur={PALETTE.magenta} rayon={1.65} vitesse={0.42} phase={0} />
      <Etiquette texte="Grow" couleur={PALETTE.rose} rayon={1.7} vitesse={0.36} phase={Math.PI} />

      <Sparkles count={70} scale={[6, 4, 3]} size={1.6} speed={0.3} color="#E9D5FF" opacity={0.5} />
    </Canvas>
  );
}
