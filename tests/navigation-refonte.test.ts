import { describe, expect, it } from 'vitest';
import {
  BUSINESS_NAV_GROUPS,
  BUSINESS_SHORTCUTS,
  STUDIO_NAV_GROUPS,
} from '../src/navigation/config';

/**
 * Garde-fous sur la navigation réorganisée.
 *
 * ## Pourquoi ce test existe
 *
 * Une refonte de menu est l'occasion la plus simple de perdre une
 * fonctionnalité : on regroupe, on renomme, et une destination disparaît sans
 * que personne ne s'en aperçoive — le module existe toujours en base, mais plus
 * aucun chemin ne mène à son écran.
 *
 * Ces tests fixent trois choses :
 *
 *   1. **aucune destination perdue** — la liste ci-dessous est la référence
 *      historique, extraite de la configuration d'avant la refonte ;
 *   2. **les groupes restent lisibles** — un nombre borné de groupes et
 *      d'entrées, sinon on retombe dans le menu interminable qu'on a corrigé ;
 *   3. **l'assistant a un chemin dédié** — c'était la demande principale, et
 *      c'est le genre d'acquis qu'une édition distraite peut retirer.
 */

/** Destinations présentes avant la refonte (14 groupes). */
const DESTINATIONS_HISTORIQUES = [
  '/app/business',
  '/app/business?section=chat',
  '/app/business?section=company',
  '/app/business?section=memory',
  '/app/business?section=providers',
  '/app/business?section=integrations',
  '/app/business?section=growth&growthTab=overview',
  '/app/business?section=growth&growthTab=crm',
  '/app/business?section=growth&growthTab=catalog',
  '/app/business?section=growth&growthTab=strategy',
  '/app/business?section=growth&growthTab=goals',
  '/app/business?section=growth&growthTab=market',
  '/app/business/modules',
  '/app/business/modules/lead-rescue',
  '/app/business/modules/payment-recovery',
  '/app/business/modules/order-cart-recovery',
  '/app/business/modules/customer-recovery',
  '/app/business/modules/sales-automation',
  '/app/business/modules/finance-intelligence',
  '/app/business/modules/smart-inventory',
  '/app/business/modules/operations-manager',
  '/app/business/modules/supplier-delivery',
  '/app/business/modules/customer-support-ai',
  '/app/business/modules/social-growth',
  '/app/business/modules/revenue-leak',
  '/app/business/modules/dispute-shield',
  '/app/business/abonnement',
  '/app/parametres',
];

describe('navigation Business Grow', () => {
  const destinations = BUSINESS_NAV_GROUPS.flatMap((groupe) => groupe.items.map((item) => item.to));

  it('conserve TOUTES les destinations historiques', () => {
    const manquantes = DESTINATIONS_HISTORIQUES.filter((to) => !destinations.includes(to));
    expect(manquantes, 'destinations perdues par la refonte').toEqual([]);
  });

  it('expose une destination dédiée à l’assistant', () => {
    // Exigence produit : l'assistant ne doit plus être seulement un onglet
    // encadré par des cartes métier.
    expect(destinations).toContain('/app/business/assistant');
    const assistant = BUSINESS_NAV_GROUPS.find((groupe) => groupe.id === 'assistant');
    expect(assistant).toBeDefined();
    // En tête : c'est l'entrée principale de l'espace métier.
    expect(BUSINESS_NAV_GROUPS[0].id).toBe('assistant');
  });

  it('reste un menu lisible, pas un inventaire', () => {
    // L'ancienne configuration comptait 14 groupes et 28 entrées, tous visibles
    // d'emblée. Le seuil ci-dessous est un garde-fou, pas une cible : le
    // dépasser doit être une décision consciente, accompagnée d'un sous-menu.
    expect(BUSINESS_NAV_GROUPS.length).toBeLessThanOrEqual(9);
    expect(destinations.length).toBeLessThanOrEqual(30);
    for (const groupe of BUSINESS_NAV_GROUPS) {
      expect(groupe.items.length, `groupe « ${groupe.label} » trop chargé`).toBeLessThanOrEqual(6);
    }
  });

  it('n’ouvre au premier affichage que les groupes essentiels', () => {
    const ouverts = BUSINESS_NAV_GROUPS.filter((groupe) => groupe.defaultOpen);
    // Tout laisser ouvert reconstituerait exactement le problème d'origine.
    expect(ouverts.length).toBeLessThanOrEqual(2);
    expect(ouverts.map((groupe) => groupe.id)).toEqual(['assistant', 'pilotage']);
  });

  it('donne à chaque groupe un identifiant unique et une icône', () => {
    const ids = BUSINESS_NAV_GROUPS.map((groupe) => groupe.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const groupe of BUSINESS_NAV_GROUPS) {
      expect(groupe.icon, `groupe ${groupe.id} sans icône`).toBeTruthy();
      expect(groupe.label.length).toBeGreaterThan(0);
      for (const item of groupe.items) expect(item.icon).toBeTruthy();
    }
  });

  it('ne présente aucune destination en double', () => {
    // Un doublon n'est pas anodin : il fait apparaître deux entrées actives à la
    // fois pour une même page, et fausse les compteurs de navigation.
    expect(new Set(destinations).size).toBe(destinations.length);
  });

  it('garde les raccourcis dans le périmètre Business Grow', () => {
    for (const raccourci of BUSINESS_SHORTCUTS) {
      expect(raccourci.to.startsWith('/app/business'), `${raccourci.to} sort du périmètre`).toBe(true);
    }
  });
});

describe('navigation Studio', () => {
  const destinations = STUDIO_NAV_GROUPS.flatMap((groupe) => groupe.items.map((item) => item.to));

  it('conserve le monteur vidéo et l’assistant', () => {
    // Deux exigences explicites : le monteur reste accessible, et l'assistant
    // garde son entrée.
    //
    // Le monteur a migré vers `/app/montage`, espace dédié hors coquille : dans
    // `<Layout>`, la barre et la nav comprimaient la timeline. L'ancienne route
    // `/app/studio/montage` existe toujours pour les liens conservés.
    expect(destinations).toContain('/app/montage');
    expect(destinations).toContain('/app/ai');
  });

  it('donne à chaque groupe un identifiant unique', () => {
    const ids = STUDIO_NAV_GROUPS.map((groupe) => groupe.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ne présente aucune destination en double', () => {
    expect(new Set(destinations).size).toBe(destinations.length);
  });
});
/* -------------------------------------------------------------------------- */
/* Studio — même exigence, autre périmètre                                    */
/* -------------------------------------------------------------------------- */

/** Destinations Studio avant réorganisation (9 groupes, 17 entrées). */
const DESTINATIONS_STUDIO_HISTORIQUES = [
  '/app/ai',
  '/app/studio/accueil',
  '/app/studio',
  '/app/studio/avance',
  '/app/studio/classique',
  '/app/montage',
  '/app/presets',
  '/app/avatars',
  '/app/scripts',
  '/app/prompts',
  '/app/projets',
  '/app/bibliotheque',
  '/app/fichiers',
  '/app/historique',
  '/app/abonnement',
  '/app/credits',
  '/app/parametres',
];

describe('navigation Studio — réorganisation par usage', () => {
  const destinations = STUDIO_NAV_GROUPS.flatMap((groupe) => groupe.items.map((item) => item.to));

  it('conserve les 17 destinations historiques', () => {
    for (const attendue of DESTINATIONS_STUDIO_HISTORIQUES) {
      expect(destinations, `destination perdue : ${attendue}`).toContain(attendue);
    }
  });

  it('n’a aucun doublon', () => {
    expect(destinations.length).toBe(new Set(destinations).size);
  });

  it('ouvre au plus deux groupes par défaut', () => {
    /*
     * Au-delà, la barre redevient une liste de liens : le rangement ne sert plus
     * à rien et la barre occupe autant de hauteur qu'avant la refonte.
     */
    const ouverts = STUDIO_NAV_GROUPS.filter((groupe) => groupe.defaultOpen);
    expect(ouverts.length).toBeLessThanOrEqual(2);
    expect(ouverts.map((groupe) => groupe.id)).toEqual(['accueil', 'creer']);
  });

  it('ne dépasse pas sept groupes', () => {
    /* 9 -> 7 : « Avatars », « Scripts », « Historique » étaient trop fins pour
     * justifier un niveau de premier niveau. */
    expect(STUDIO_NAV_GROUPS.length).toBeLessThanOrEqual(7);
  });

  it('suit l’ordre de travail du créateur', () => {
    expect(STUDIO_NAV_GROUPS.map((groupe) => groupe.id)).toEqual([
      'accueil', 'creer', 'projets', 'bibliotheque', 'outils', 'assistant', 'parametres',
    ]);
  });

  it('chaque groupe décrit son usage par un repère court', () => {
    /* Le `hint` évite qu'un intitulé seul ne suffise pas à décider où aller. */
    for (const groupe of STUDIO_NAV_GROUPS) {
      expect(groupe.hint, `groupe sans hint : ${groupe.id}`).toBeTruthy();
    }
  });

  it('le monteur vidéo a son entrée dédiée vers l’espace plein écran', () => {
    const creer = STUDIO_NAV_GROUPS.find((groupe) => groupe.id === 'creer');
    expect(creer?.items.map((item) => item.to)).toContain('/app/montage');
  });
});
