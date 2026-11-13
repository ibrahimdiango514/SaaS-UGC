import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '../ui';

/**
 * Animations de la vitrine VYORA.
 *
 * Principes :
 * - uniquement `opacity` et `transform` (aucun recalcul de layout) ;
 * - aucune animation ne conditionne l’affichage du contenu : si
 *   `IntersectionObserver` manque ou si le navigateur est ralenti, le contenu
 *   est révélé après un délai de sécurité ;
 * - `prefers-reduced-motion` est respecté côté CSS (feuille globale) et côté JS
 *   pour les textes qui défilent (ils se figent alors sur la première phrase).
 */

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}

interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Délai en millisecondes, appliqué après l’entrée dans le viewport. */
  delay?: number;
  style?: CSSProperties;
}

export function Reveal({ children, className, delay = 0, style }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) {
      setShown(true);
      return;
    }
    const node = ref.current;
    if (!node) return;

    // Filet de sécurité : le contenu ne doit jamais rester invisible.
    const fallback = window.setTimeout(() => setShown(true), 1400);
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      window.clearTimeout(fallback);
      return () => window.clearTimeout(fallback);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
          window.clearTimeout(fallback);
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.08 },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
      window.clearTimeout(fallback);
    };
  }, [reduced]);

  return (
    <div
      ref={ref}
      className={cn('vyora-reveal', shown && 'vyora-reveal-in', className)}
      style={{ ...style, transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/**
 * Titre révélé mot à mot. Le texte complet reste lisible par les lecteurs
 * d’écran et sélectionnable : chaque mot est un simple `span` animé.
 */
export function WordReveal({
  text,
  className,
  delay = 0,
  step = 44,
}: {
  text: string;
  className?: string;
  delay?: number;
  step?: number;
}) {
  const reduced = usePrefersReducedMotion();
  const words = text.split(' ');

  return (
    <span className={cn('vyora-words', className)}>
      {words.map((word, index) => (
        <Fragment key={`${word}-${index}`}>
          <span
            className="vyora-word"
            style={reduced ? undefined : { animationDelay: `${delay + index * step}ms` }}
          >
            {word}
          </span>
          {index < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </span>
  );
}

/** Bandeau de textes qui tournent, figé dès que les animations sont réduites. */
export function RotatingText({
  items,
  interval = 2800,
  className,
}: {
  items: readonly string[];
  interval?: number;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduced || items.length < 2) {
      setIndex(0);
      return;
    }
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % items.length);
    }, interval);
    return () => window.clearInterval(timer);
  }, [interval, items.length, reduced]);

  return (
    <span className={cn('relative inline-flex min-w-0 items-baseline', className)}>
      <span className="sr-only">{items.join(' · ')}</span>
      <span aria-hidden="true" className="vyora-rotate-item" key={index}>
        {items[index]}
      </span>
    </span>
  );
}

/**
 * Observateur de section pour les compteurs visuels : renvoie `true` dès que
 * l’élément est visible, une seule fois.
 */
export function useInView<T extends HTMLElement>(rootMargin = '0px 0px -10% 0px') {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || inView) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin, threshold: 0.1 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return { ref, inView };
}
