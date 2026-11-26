/**
 * Événements de conversion de la landing.
 *
 * ## Ce qui est mesuré, et ce qui ne l'est pas
 * Trois événements seulement, ceux qui disent si la page convertit :
 *   - `cta_clic`      : clic sur le CTA principal ;
 *   - `champ_focus`   : interaction avec le champ (essai ou inscription) ;
 *   - `scroll_50`     : le visiteur a parcouru la moitié de la page.
 *
 * Aucune donnée personnelle, aucun identifiant d'appareil, aucun cookie :
 * l'événement ne porte qu'un nom et une provenance technique. Un site qui
 * compte ses conversions n'a pas besoin de savoir qui vous êtes.
 *
 * ## Pourquoi un émetteur unique
 * Sans point d'envoi central, chaque bouton finirait par pousser ses propres
 * appels à `dataLayer`, `gtag`, `plausible`… et la page se chargerait de trois
 * scripts de mesure. Ici, un seul endroit décide où va l'événement ; s'il n'y a
 * rien à qui l'envoyer, il ne se passe rien et la page n'empêche jamais un clic.
 */

export type EvenementConversion = 'cta_clic' | 'champ_focus' | 'scroll_50';

type Details = Record<string, string | number | boolean>;

/** Interface minimale du collecteur global, s'il existe. */
type CollecteurGlobal = {
  gtag?: (...args: unknown[]) => void;
  dataLayer?: unknown[];
  plausible?: (nom: string, options?: { props?: Details }) => void;
};

/**
 * Envoie un événement de conversion. Ne lève jamais : une mesure qui casse un
 * clic est pire que pas de mesure du tout.
 */
export function suivre(evenement: EvenementConversion, details: Details = {}): void {
  if (typeof window === 'undefined') return;
  const global = window as unknown as CollecteurGlobal;
  const charge = {
    event: evenement,
    page: 'landing',
    ...details,
  };

  try {
    // Ordre de préférence : GA4 s'il est présent, puis Plausible, puis un
    // collecteur maison alimenté par `dataLayer`. Aucun n'est requis.
    if (typeof global.gtag === 'function') {
      global.gtag('event', evenement, details);
      return;
    }
    if (typeof global.plausible === 'function') {
      global.plausible(evenement, { props: details });
      return;
    }
    if (Array.isArray(global.dataLayer)) {
      global.dataLayer.push(charge);
    }
  } catch {
    // Volontairement silencieux : le clic doit aboutir quoi qu'il arrive.
  }
}

/**
 * Déclenche `scroll_50` une seule fois, quand la moitié de la page est vue.
 *
 * L'événement ne doit pas se répéter si le visiteur remonte puis redescend :
 * la mesure sert à savoir combien de visiteurs dépassent la moitié, pas combien
 * de fois ils la dépassent.
 */
export function observerMoitiePage(): () => void {
  if (typeof window === 'undefined' || typeof IntersectionObserver !== 'function') {
    return () => undefined;
  }

  const jalon = document.createElement('div');
  jalon.setAttribute('aria-hidden', 'true');
  jalon.style.cssText = 'position:absolute;left:0;width:1px;height:1px;pointer-events:none;';
  document.body.appendChild(jalon);

  let envoye = false;
  const observateur = new IntersectionObserver(
    (entrees) => {
      for (const entree of entrees) {
        if (entree.isIntersecting && !envoye) {
          envoye = true;
          suivre('scroll_50');
          observateur.disconnect();
        }
      }
    },
    { threshold: 0 },
  );
  observateur.observe(jalon);

  // Le jalon doit être posé à mi-hauteur : sans ce recalage il resterait en
  // haut de page et l'événement partirait immédiatement.
  const placer = () => {
    const hauteur = Math.max(document.documentElement.scrollHeight, 1);
    jalon.style.top = `${Math.round(hauteur / 2)}px`;
  };
  placer();
  window.addEventListener('resize', placer);

  return () => {
    observateur.disconnect();
    window.removeEventListener('resize', placer);
    jalon.remove();
  };
}
