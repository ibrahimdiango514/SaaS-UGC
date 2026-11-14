/**
 * B3 — Hero 3D de l'accueil VYORA (react-three/fiber).
 * Scène « aurora » : noyau distordu (violet/cyan), coquille filaire,
 * particules et parallaxe souris. Légère (dpr ≤ 1.5), chargée en lazy,
 * et remplacée par l'image statique quand le motion est réduit ou que
 * WebGL est indisponible (voir HeroVisual dans Landing.tsx).
 */
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, MeshDistortMaterial, Sparkles } from '@react-three/drei';
import { useRef, type ReactNode } from 'react';
import * as THREE from 'three';

function AuroraCore() {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!mesh.current) return;
    mesh.current.rotation.y = state.clock.elapsedTime * 0.14;
  });
  return (
    <mesh ref={mesh}>
      <icosahedronGeometry args={[1.32, 48]} />
      <MeshDistortMaterial
        color="#7c3aed"
        emissive="#155e75"
        emissiveIntensity={0.5}
        roughness={0.16}
        metalness={0.74}
        distort={0.34}
        speed={1.4}
      />
    </mesh>
  );
}

function AuroraShell() {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!mesh.current) return;
    const t = state.clock.elapsedTime;
    mesh.current.rotation.x = t * 0.05;
    mesh.current.rotation.z = -t * 0.04;
  });
  return (
    <mesh ref={mesh} scale={1.62}>
      <icosahedronGeometry args={[1.32, 1]} />
      <meshBasicMaterial color="#22d3ee" wireframe transparent opacity={0.09} />
    </mesh>
  );
}

/** Parallaxe douce : le groupe suit le pointeur (lerp exponentiel). */
function PointerRig({ children }: { children: ReactNode }) {
  const group = useRef<THREE.Group>(null);
  useFrame((state, delta) => {
    if (!group.current) return;
    const k = 1 - Math.exp(-delta * 2.4);
    group.current.rotation.y = THREE.MathUtils.lerp(group.current.rotation.y, state.pointer.x * 0.38, k);
    group.current.rotation.x = THREE.MathUtils.lerp(group.current.rotation.x, -state.pointer.y * 0.24, k);
  });
  return <group ref={group}>{children}</group>;
}

export default function HeroScene() {
  return (
    <Canvas
      dpr={[1, 1.5]}
      camera={{ position: [0, 0, 4.4], fov: 42 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      aria-hidden="true"
      className="!absolute inset-0"
    >
      <ambientLight intensity={0.4} />
      <pointLight position={[4, 3, 5]} intensity={34} color="#22d3ee" />
      <pointLight position={[-4.5, -2, -4]} intensity={30} color="#8b5cf6" />
      <PointerRig>
        <Float speed={1.15} rotationIntensity={0.3} floatIntensity={0.85}>
          <AuroraCore />
          <AuroraShell />
        </Float>
        <Sparkles count={90} scale={[6.4, 4.4, 4]} size={2.1} speed={0.3} opacity={0.5} color="#a5b4fc" />
      </PointerRig>
    </Canvas>
  );
}
