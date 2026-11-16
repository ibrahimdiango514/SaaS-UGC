/**
 * VYORA — scène 3D du parcours d'authentification (« atrium »).
 *
 * Un noyau de verre distordu, deux anneaux orbitaux et une poussière d'étoiles.
 * Léger par construction :
 * - `dpr` plafonné à 1.5, géométrie de faible complexité ;
 * - aucun post-traitement, aucune ombre, aucune texture ;
 * - rendu mis en pause dès que l'onglet est masqué (`frameloop`) ;
 * - la parallaxe suit le pointeur avec un lerp exponentiel (indépendant du FPS).
 *
 * Le composant n'est monté que si WebGL est disponible ET si l'utilisateur
 * n'a pas demandé de réduire les animations (voir `AuthStage`).
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Float, MeshDistortMaterial, Sparkles } from '@react-three/drei';
import { useEffect, useRef, type ReactNode } from 'react';
import * as THREE from 'three';

function AuroraCore() {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!mesh.current) return;
    const t = state.clock.elapsedTime;
    mesh.current.rotation.y = t * 0.12;
    mesh.current.rotation.x = Math.sin(t * 0.18) * 0.12;
  });
  return (
    <mesh ref={mesh}>
      <icosahedronGeometry args={[1.25, 32]} />
      <MeshDistortMaterial
        color="#0e7490"
        emissive="#22d3ee"
        emissiveIntensity={0.28}
        roughness={0.22}
        metalness={0.62}
        distort={0.28}
        speed={1.1}
      />
    </mesh>
  );
}

function OrbitRing({ radius, tilt, speed, color }: { radius: number; tilt: [number, number, number]; speed: number; color: string }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!ring.current) return;
    ring.current.rotation.z = state.clock.elapsedTime * speed;
  });
  return (
    <group rotation={tilt}>
      <mesh ref={ring}>
        <torusGeometry args={[radius, 0.006, 8, 128]} />
        <meshBasicMaterial color={color} transparent opacity={0.42} />
      </mesh>
      {/* Satellite : un point lumineux qui parcourt l'anneau. */}
      <mesh position={[radius, 0, 0]}>
        <sphereGeometry args={[0.028, 12, 12]} />
        <meshBasicMaterial color="#e0f2fe" />
      </mesh>
    </group>
  );
}

function PointerRig({ children, intensity = 0.22 }: { children: ReactNode; intensity?: number }) {
  const group = useRef<THREE.Group>(null);
  useFrame((state, delta) => {
    if (!group.current) return;
    const k = 1 - Math.exp(-delta * 2.2);
    group.current.rotation.y = THREE.MathUtils.lerp(group.current.rotation.y, state.pointer.x * intensity, k);
    group.current.rotation.x = THREE.MathUtils.lerp(group.current.rotation.x, -state.pointer.y * intensity * 0.7, k);
  });
  return <group ref={group}>{children}</group>;
}

/** Met le rendu sur `demand` quand l'onglet est masqué : aucun GPU gaspillé. */
function VisibilityGovernor() {
  const setFrameloop = useThree((state) => state.setFrameloop);
  useEffect(() => {
    const onVisibility = () => setFrameloop(document.hidden ? 'demand' : 'always');
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [setFrameloop]);
  return null;
}

export default function AuthScene({ variant = 'create' }: { variant?: 'create' | 'enter' }) {
  const accent = variant === 'enter' ? '#a78bfa' : '#22d3ee';
  const secondary = variant === 'enter' ? '#22d3ee' : '#a78bfa';

  return (
    <Canvas
      dpr={[1, 1.5]}
      camera={{ position: [0, 0, 4.6], fov: 44 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      aria-hidden="true"
      className="!absolute inset-0"
    >
      <VisibilityGovernor />
      <ambientLight intensity={0.45} />
      <pointLight position={[3.5, 2.5, 4]} intensity={30} color={accent} />
      <pointLight position={[-4, -2, -3]} intensity={26} color={secondary} />
      <PointerRig>
        <Float speed={1.05} rotationIntensity={0.24} floatIntensity={0.7}>
          <AuroraCore />
          <OrbitRing radius={1.85} tilt={[1.15, 0.2, 0]} speed={0.18} color={accent} />
          <OrbitRing radius={2.15} tilt={[-0.85, 0.5, 0.4]} speed={-0.13} color={secondary} />
        </Float>
        <Sparkles count={70} scale={[6.2, 4.2, 4]} size={1.9} speed={0.28} opacity={0.45} color="#a5b4fc" />
      </PointerRig>
    </Canvas>
  );
}
