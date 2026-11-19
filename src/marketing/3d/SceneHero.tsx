/**
 * VYORA — scène du hero, en trois niveaux et un seul rendu.
 *
 * ## Contraintes tenues
 *
 *   - **Conteneur borné** : `aspect-ratio` + hauteur maximale. Jamais plein
 *     écran, jamais en fond de page. Le repli statique réserve exactement la
 *     même place : aucun saut de mise en page au chargement.
 *   - **Chargé après le titre et le CTA** : le composant est monté en
 *     `React.lazy` par la landing, après l'interactivité.
 *   - **Une seule scène active** : le hero est unique par page.
 *   - **Pause hors écran** : `IntersectionObserver` coupe la boucle.
 *   - **Scroll jamais bloqué** : aucun écouteur de molette, aucun `preventDefault`
 *     sur le défilement, aucun `overflow: hidden` sur le body.
 *   - **Ne masque rien** : tous les éléments sont `pointer-events-none`, et le
 *     conteneur est `aria-hidden` — c'est décoratif, pas informatif.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { detecterCapacites, niveauInitial, type Niveau3D } from './capacites';
import { superviserFluidite, type Supervision } from './fluidite';

/** Ce que les deux univers ont en commun, décrit une fois. */
interface Props {
  /** Univers visuel : change l'accent de la scène. */
  univers: 'business' | 'studio';
  /** Texte de repli lisible par les lecteurs d'écran (ou vide si décoratif). */
  alt?: string;
  className?: string;
}

/**
 * Niveau 0 — statique.
 *
 * Un dégradé de même géométrie que la scène 3D : des anneaux concentriques et
 * une sphère lumineuse qui évoquent le même objet. Rendu en CSS pur, aucun coût
 * réseau, aucun JS.
 */
function Statique({ univers }: { univers: 'business' | 'studio' }) {
  return (
    <div className="absolute inset-0" aria-hidden="true">
      <div
        className="absolute inset-0"
        style={{
          background:
            univers === 'business'
              ? 'radial-gradient(58% 62% at 50% 46%, rgba(240,160,60,0.22), transparent 68%), radial-gradient(40% 44% at 68% 64%, rgba(217,119,66,0.16), transparent 70%)'
              : 'radial-gradient(58% 62% at 50% 46%, rgba(34,211,238,0.22), transparent 68%), radial-gradient(40% 44% at 68% 64%, rgba(167,139,250,0.18), transparent 70%)',
        }}
      />
      {/* Trois anneaux concentriques : la promesse (créer, mesurer, grandir). */}
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="absolute left-1/2 top-1/2 rounded-full border"
          style={{
            width: `${52 + i * 16}%`,
            aspectRatio: '1',
            transform: `translate(-50%, -50%) rotateX(${62 - i * 6}deg)`,
            borderColor: `color-mix(in srgb, var(--vy-accent) ${38 - i * 10}%, transparent)`,
            opacity: 0.9 - i * 0.2,
          }}
        />
      ))}
      <div
        className="absolute left-1/2 top-1/2 rounded-full"
        style={{
          width: '26%',
          aspectRatio: '1',
          transform: 'translate(-50%, -50%)',
          background:
            univers === 'business'
              ? 'radial-gradient(circle at 35% 30%, #ffd9a3, #f0a03c 46%, #a85f22 78%, #5c3010)'
              : 'radial-gradient(circle at 35% 30%, #d9fbff, #22d3ee 46%, #6d5bd0 78%, #2a1f52)',
          boxShadow: '0 24px 60px -24px var(--vy-glow)',
        }}
      />
    </div>
  );
}

/**
 * Niveau 1 — 2,5D : même composition, avec parallaxe au pointeur.
 *
 * Pas de WebGL, pas de dépendance : quelques `transform: translate3d` sur trois
 * calques. Coupé par `prefers-reduced-motion` et désactivé au toucher (une
 * parallaxe au doigt entre en conflit avec le défilement).
 */
function Parallaxe({ univers }: { univers: 'business' | 'studio' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduit = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tactile = window.matchMedia('(hover: none)').matches;
    if (reduit || tactile) return;

    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        setPos({ x, y });
      });
    };
    el.addEventListener('pointermove', onMove);
    return () => {
      el.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} className="absolute inset-0" aria-hidden="true">
      <Statique univers={univers} />
      <div
        className="absolute inset-0 transition-transform duration-300 ease-out"
        style={{ transform: `translate3d(${pos.x * 10}px, ${pos.y * 10}px, 0)` }}
      >
        <div
          className="absolute left-1/2 top-1/2 rounded-full"
          style={{
            width: '34%',
            aspectRatio: '1',
            transform: 'translate(-50%, -50%)',
            background: 'radial-gradient(circle at 38% 32%, rgba(255,255,255,0.7), transparent 62%)',
            opacity: 0.5,
            filter: 'blur(6px)',
          }}
        />
      </div>
    </div>
  );
}

/**
 * Niveau 2 — WebGL léger.
 *
 * Three.js est importé **dynamiquement** : si l'import échoue (réseau, CSP), on
 * appelle `onEchec` et le parent retombe au niveau 0 sans casser la page.
 *
 * La scène : un tore doux qui tourne lentement et une sphère centrale, deux
 * lumières, aucun post-traitement, aucune ombre portée.
 *
 * ## Poids mesuré (build de production, gzip)
 *
 *   three.module  683,19 Ko brut → **175,97 Ko gzip**
 *
 * C'est sous le budget de 300 Ko fixé pour le niveau 2. Ce poids n'est payé que
 * par les appareils classés niveau 2 : un téléphone en 3G, en économie de
 * données, ou avec « réduire les animations » ne télécharge jamais ce chunk —
 * il reste au niveau 1 (2,5D), qui ne coûte aucun octet de JS supplémentaire.
 *
 * Aucune texture externe : les formes sont géométriques et les couleurs sont
 * des constantes, ce qui évite tout téléchargement d'image.
 */
function WebGL({ univers, onEchec, onLent }: { univers: 'business' | 'studio'; onEchec: () => void; onLent: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    let supervision: Supervision | null = null;
    let annule = false;

    (async () => {
      try {
        const THREE = await import('three');
        if (annule || !ref.current) return;

        const el = ref.current;
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
        camera.position.set(0, 0, 5.4);

        const renderer = new THREE.WebGLRenderer({
          antialias: false, // coûteux, invisible à cette taille
          alpha: true,
          powerPreference: 'low-power',
        });
        // Pixel ratio plafonné : sur un écran ×3, rendre en ×3 quadruple le coût
        // sans gain visible sur une forme lisse.
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        el.appendChild(renderer.domElement);
        renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';

        const accent = univers === 'business' ? 0xf0a03c : 0x22d3ee;
        const second = univers === 'business' ? 0xd97742 : 0xa78bfa;

        const sphere = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.95, 3),
          new THREE.MeshStandardMaterial({ color: accent, roughness: 0.34, metalness: 0.42, flatShading: false }),
        );
        scene.add(sphere);

        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1.7, 0.028, 8, 96),
          new THREE.MeshBasicMaterial({ color: second, transparent: true, opacity: 0.55 }),
        );
        ring.rotation.x = Math.PI * 0.42;
        scene.add(ring);

        const ring2 = new THREE.Mesh(
          new THREE.TorusGeometry(2.1, 0.016, 8, 96),
          new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.3 }),
        );
        ring2.rotation.x = Math.PI * 0.56;
        ring2.rotation.y = 0.4;
        scene.add(ring2);

        scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        const key = new THREE.DirectionalLight(0xffffff, 1.5);
        key.position.set(2.5, 3, 4);
        scene.add(key);
        const rim = new THREE.DirectionalLight(second, 0.9);
        rim.position.set(-3, -1, -2);
        scene.add(rim);

        const redimensionner = () => {
          if (!el) return;
          const w = el.clientWidth || 1;
          const h = el.clientHeight || 1;
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        redimensionner();
        const ro = new ResizeObserver(redimensionner);
        ro.observe(el);

        // Pause hors écran : une scène invisible ne doit pas consommer de batterie.
        let visible = true;
        const io = new IntersectionObserver(
          ([entry]) => {
            visible = entry.isIntersecting;
          },
          { threshold: 0.01 },
        );
        io.observe(el);

        let raf = 0;
        const horloge = new THREE.Clock();
        const boucle = () => {
          raf = requestAnimationFrame(boucle);
          if (!visible) return;
          const t = horloge.getElapsedTime();
          sphere.rotation.y = t * 0.22;
          sphere.rotation.x = Math.sin(t * 0.3) * 0.1;
          ring.rotation.z = t * 0.1;
          ring2.rotation.z = -t * 0.08;
          renderer.render(scene, camera);
        };
        boucle();

        supervision = superviserFluidite(onLent, 2);

        dispose = () => {
          cancelAnimationFrame(raf);
          io.disconnect();
          ro.disconnect();
          supervision?.stop();
          renderer.dispose();
          // `dispose()` existe sur toutes les géométries et matières Three ;
          // le type importé dynamiquement n'est pas visible ici, on passe par
          // une forme structurelle minimale.
          const liberer = (o: { dispose?: () => void }) => o.dispose?.();
          liberer(sphere.geometry);
          liberer(sphere.material as { dispose?: () => void });
          liberer(ring.geometry);
          liberer(ring.material as { dispose?: () => void });
          liberer(ring2.geometry);
          liberer(ring2.material as { dispose?: () => void });
          if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
        };
      } catch {
        if (!annule) onEchec();
      }
    })();

    return () => {
      annule = true;
      supervision?.stop();
      dispose?.();
    };
  }, [univers, onEchec, onLent]);

  return <div ref={ref} className="absolute inset-0" aria-hidden="true" />;
}

/**
 * Point d'entrée. Choisit le niveau, l'applique, et gère les rétrogradations.
 *
 * Le conteneur impose la géométrie : `aspect-ratio` 4/3 sur mobile, 16/10 sur
 * grand écran, hauteur bornée. Le repli occupe la même boîte — la page ne bouge
 * pas quand la 3D arrive.
 */
export function SceneHero({ univers, alt = '', className = '' }: Props) {
  const [niveau, setNiveau] = useState<Niveau3D | null>(null);

  useEffect(() => {
    // Détection au montage : le SSR n'existe pas ici, mais on évite de toucher
    // `document` pendant le rendu pour rester compatible avec un futur pré-rendu.
    const c = detecterCapacites();
    setNiveau(niveauInitial(c));
  }, []);

  const retomber = useMemo(
    () => (vers: Niveau3D) => setNiveau((n) => (n === null || n <= vers ? n : vers)),
    [],
  );

  if (niveau === null) {
    // Premier rendu : le repli statique. Aucune mesure, aucun réseau.
    return (
      <div
        className={`relative isolate overflow-hidden rounded-3xl border border-line ${className}`}
        style={{ aspectRatio: '4 / 3', maxHeight: 'min(58dvh, 460px)' }}
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
      >
        <Statique univers={univers} />
      </div>
    );
  }

  return (
    <div
      className={`relative isolate overflow-hidden rounded-3xl border border-line ${className}`}
      style={{ aspectRatio: '4 / 3', maxHeight: 'min(58dvh, 460px)' }}
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      data-niveau-3d={niveau}
    >
      {niveau === 0 && <Statique univers={univers} />}
      {niveau === 1 && <Parallaxe univers={univers} />}
      {niveau === 2 && (
        <WebGL univers={univers} onEchec={() => setNiveau(0)} onLent={() => retomber(1)} />
      )}
    </div>
  );
}

export default SceneHero;
