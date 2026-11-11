/**
 * Continuité de navigation Business Grow ↔ Studio UGC (priorité 2).
 *
 * Ces tests couvrent uniquement des fonctions pures : aucune requête réseau,
 * aucun appel IA, aucun débit. Ils vérifient que le contexte transmis entre
 * les deux modules reste réel (jamais inventé) et borné.
 */
import { describe, expect, it } from 'vitest';
import {
  buildBusinessGrowLocationState,
  buildBusinessGrowLocationStateFromStudio,
  buildStudioLocationStateFromBrief,
  extractUgcHandoffBriefFromLocationState,
  normalizeUgcHandoffBrief,
  parseBusinessGrowEntryIntent,
} from '../src/contracts/business-grow';

const PROJECT_UUID = '7b15bfe0-e315-4262-a8b9-9d99a5a5f6bd';
const PRODUCT_UUID = '3b4fe184-7e28-4b34-8f82-61fbe5e59ced';

describe('Studio UGC → Business Grow', () => {
  it('transmet le projet, le produit et le brief réels comme brouillon de conversation', () => {
    const state = buildBusinessGrowLocationStateFromStudio({
      projectId: PROJECT_UUID,
      projectTitle: 'Campagne Sérum Éclat',
      brandName: 'Maison Nala',
      productName: 'Sérum Éclat',
      campaignObjective: 'Conversion / ventes',
      targetAudience: 'Femmes 25–40 ans, Bamako',
      platform: 'TikTok',
      brief: 'Mettre en avant l’éclat en 7 jours.',
      scriptText: 'Hook : tu fais encore cette erreur ?',
    });

    expect(state).toBeTruthy();
    const intent = parseBusinessGrowEntryIntent(state);
    expect(intent).toMatchObject({
      version: 'reelora-bg-entry-v1',
      section: 'growth',
      growthTab: 'strategy',
      projectId: PROJECT_UUID,
      projectTitle: 'Campagne Sérum Éclat',
      brandName: 'Maison Nala',
      productName: 'Sérum Éclat',
      platform: 'TikTok',
      sourceRoute: '/app/studio',
    });
    expect(intent?.initialDraft).toContain('Projet UGC en cours : Campagne Sérum Éclat.');
    expect(intent?.initialDraft).toContain('Produit : Sérum Éclat.');
    expect(intent?.initialDraft).toContain('Objectif de campagne : Conversion / ventes.');
  });

  it('n’ouvre pas d’onglet de croissance sans contexte réel', () => {
    expect(buildBusinessGrowLocationStateFromStudio({})).toBeUndefined();
    expect(buildBusinessGrowLocationStateFromStudio({
      projectTitle: '   ', productName: null, brief: '',
    })).toBeUndefined();
  });

  it('respecte l’onglet de croissance demandé et ignore un identifiant non UUID', () => {
    const state = buildBusinessGrowLocationStateFromStudio(
      { projectId: 'proj-1', projectTitle: 'Projet local' },
      { growthTab: 'crm' },
    );
    const intent = parseBusinessGrowEntryIntent(state);
    expect(intent?.growthTab).toBe('crm');
    expect(intent?.projectId).toBeNull();
    expect(intent?.initialDraft).toContain('Projet UGC en cours : Projet local.');
  });

  it('ignore un onglet de croissance inconnu dans l’état de navigation', () => {
    const state = buildBusinessGrowLocationState({
      section: 'growth',
      growthTab: 'onglet-inexistant' as never,
    });
    expect(parseBusinessGrowEntryIntent(state)?.growthTab).toBeNull();
  });

  it('borne le brouillon transmis et ne dépasse jamais 4000 caractères', () => {
    const state = buildBusinessGrowLocationStateFromStudio({
      projectTitle: 'Titre',
      brief: 'x'.repeat(5000),
      scriptText: 'y'.repeat(5000),
    });
    const draft = parseBusinessGrowEntryIntent(state)?.initialDraft ?? '';
    expect(draft.length).toBeLessThanOrEqual(4000);
  });
});

describe('Business Grow → Studio UGC', () => {
  it('conserve l’identifiant produit réel du catalogue', () => {
    const brief = normalizeUgcHandoffBrief({
      productId: PRODUCT_UUID,
      projectId: PROJECT_UUID,
      product: 'Sérum Éclat',
      angle: 'Routine 7 jours',
      platform: 'TikTok',
      projectTitle: 'Campagne Sérum Éclat',
    });
    expect(brief).toMatchObject({
      productId: PRODUCT_UUID,
      projectId: PROJECT_UUID,
      product: 'Sérum Éclat',
      projectTitle: 'Campagne Sérum Éclat',
      platform: 'TikTok',
      consumesStudioCredits: false,
    });
    const state = buildStudioLocationStateFromBrief(brief);
    expect(extractUgcHandoffBriefFromLocationState(state)).toEqual(brief);
  });

  it('rejette un identifiant produit non UUID au lieu de le propager', () => {
    const brief = normalizeUgcHandoffBrief({
      productId: 'produit-1',
      projectId: '../../etc/passwd',
      product: 'Sérum Éclat',
      angle: 'Routine 7 jours',
    });
    expect(brief?.productId).toBeNull();
    expect(brief?.projectId).toBeNull();
  });

  it('ne fabrique jamais un brief sans contenu exploitable', () => {
    expect(normalizeUgcHandoffBrief({ productId: PRODUCT_UUID })).toBeNull();
  });
});
