import { describe, expect, it } from 'vitest';
import {
  EXPLICATIONS,
  EXPLICATION_INCONNUE,
  FAMILLES,
  doitEtreMasque,
  expliquerBlocage,
  familleDe,
  grouperParFamille,
  motifPrincipal,
} from '../src/studio/modelFamilies';

/**
 * BLOC E — Studio : classement par FONCTION et motif exploitable.
 *
 * ## Ce que ces tests protègent
 * 1. Un modèle est rangé là où sa CATÉGORIE le justifie, jamais d'après son nom.
 * 2. Une catégorie inconnue ne disparaît pas : elle va dans « Autres outils ».
 * 3. Chaque code de blocage produit une action concrète et sait QUI peut agir.
 * 4. Aucun modèle n'est masqué, quel que soit son état.
 *
 * ## Règle de non-invention
 * Les codes testés sont ceux réellement produits par `studio-runtime/core.ts`.
 * Un code absent de cette liste doit tomber sur l'explication « inconnue » —
 * on ne prétend pas savoir.
 */

describe('Classement par fonction de création', () => {
  it('range chaque catégorie réelle dans la bonne famille', () => {
    expect(familleDe('text-to-video')).toBe('texte_video');
    expect(familleDe('txt2vid')).toBe('texte_video');
    expect(familleDe('image-to-video')).toBe('image_video');
    expect(familleDe('img2vid')).toBe('image_video');
    expect(familleDe('text-to-image')).toBe('texte_image');
    expect(familleDe('txt2img')).toBe('texte_image');
    expect(familleDe('image-to-image')).toBe('image_image');
    expect(familleDe('inpainting')).toBe('image_image');
    expect(familleDe('audio')).toBe('audio');
    expect(familleDe('text-to-speech')).toBe('audio');
    expect(familleDe('video-upscale')).toBe('video_edition');
  });

  it('place l’avatar AVANT les règles vidéo', () => {
    // Un modèle d'avatar est aussi « image → vidéo » techniquement : s'il
    // tombait dans cette famille, l'utilisateur le chercherait au mauvais endroit.
    expect(familleDe('avatar-video')).toBe('avatar');
    expect(familleDe('talking-head')).toBe('avatar');
    expect(familleDe('lip-sync')).toBe('avatar');
  });

  it('ne devine pas une famille à partir d’un nom vide ou inconnu', () => {
    expect(familleDe('')).toBe('autre');
    expect(familleDe(null)).toBe('autre');
    expect(familleDe('quantum-magic')).toBe('autre');
  });

  it('groupe sans perdre aucun modèle', () => {
    const modeles = [
      { model_id: 'a', category: 'text-to-video' },
      { model_id: 'b', category: 'text-to-video' },
      { model_id: 'c', category: 'text-to-image' },
      { model_id: 'd', category: 'inconnu-total' },
    ];
    const groupes = grouperParFamille(modeles);
    const total = groupes.reduce((n, g) => n + g.modeles.length, 0);
    // Perdre un modèle dans un regroupement serait un défaut silencieux.
    expect(total).toBe(modeles.length);
    // L'ordre suit celui d'affichage attendu (texte→vidéo d'abord).
    expect(groupes[0].famille.cle).toBe('texte_video');
    expect(groupes.map((g) => g.famille.cle)).toContain('autre');
  });

  it('ne rend aucun groupe vide', () => {
    const groupes = grouperParFamille([{ model_id: 'a', category: 'text-to-image' }]);
    for (const groupe of groupes) expect(groupe.modeles.length).toBeGreaterThan(0);
  });
});

describe('Explication des blocages — le motif dit quoi faire', () => {
  const CODES = [
    'PROVIDER_UNAVAILABLE', 'ACCESS_UNCONFIRMED', 'ENDPOINT_UNVERIFIED', 'SCHEMA_UNSUPPORTED',
    'UNSAFE_PARAMETER', 'PRICING_REQUIRED', 'ADAPTER_UNVERIFIED', 'PAID_VALIDATION_PENDING',
    'ADMIN_DISABLED', 'RUNTIME_DISABLED', 'QUOTA_POLICY_PENDING', 'QUOTA_POLICY_MISSING',
    'ESTIMATE_ENDPOINT_UNVERIFIED', 'PLAN_UNAVAILABLE',
  ];

  it('couvre les quatorze codes réellement produits par le serveur', () => {
    for (const code of CODES) {
      const e = expliquerBlocage(code);
      expect(e.libelle, code).not.toBe(EXPLICATION_INCONNUE.libelle);
      // Chaque message porte une action réelle, pas une répétition du libellé.
      expect(e.action.length, code).toBeGreaterThan(30);
      expect(e.action, code).not.toBe(e.libelle);
    }
    expect(Object.keys(EXPLICATIONS).sort()).toEqual([...CODES].sort());
  });

  it('dit QUI peut agir : utilisateur ou administration', () => {
    // Un client ne peut pas configurer les crédits d'un modèle : le lui demander
    // serait une fausse piste.
    expect(expliquerBlocage('PRICING_REQUIRED').qui).toBe('administration');
    expect(expliquerBlocage('PAID_VALIDATION_PENDING').qui).toBe('administration');
    // En revanche, changer d'offre ou de modèle dépend bien de lui.
    expect(expliquerBlocage('PLAN_UNAVAILABLE').qui).toBe('vous');
    expect(expliquerBlocage('PROVIDER_UNAVAILABLE').qui).toBe('vous');
  });

  it('un code inconnu n’est jamais présenté comme compris', () => {
    const e = expliquerBlocage('CODE_QUI_N_EXISTE_PAS');
    expect(e).toBe(EXPLICATION_INCONNUE);
    expect(e.action).toContain('n’est pas reconnu');
    expect(expliquerBlocage(null)).toBe(EXPLICATION_INCONNUE);
  });

  it('choisit le motif que l’utilisateur peut réellement changer', () => {
    // Un modèle hors offre ET sans prix : « non inclus dans votre offre » est la
    // seule information actionnable par le client.
    expect(motifPrincipal(['PRICING_REQUIRED', 'PLAN_UNAVAILABLE']).libelle)
      .toBe(EXPLICATIONS.PLAN_UNAVAILABLE.libelle);
    // Sans PLAN_UNAVAILABLE, la cause technique est retenue.
    expect(motifPrincipal(['ADMIN_DISABLED', 'PRICING_REQUIRED']).libelle)
      .toBe(EXPLICATIONS.PRICING_REQUIRED.libelle);
    expect(motifPrincipal([]).libelle).toBe('Opérationnel');
  });

  it('un modèle n’est jamais masqué, quel que soit son blocage', () => {
    expect(doitEtreMasque()).toBe(false);
    // Et l'explication existe même pour un modèle opérationnel, pour que
    // l'écran n'ait jamais à afficher un texte vide.
    expect(motifPrincipal([]).action.length).toBeGreaterThan(10);
  });
});

describe('Familles déclarées', () => {
  it('chaque famille a un libellé et une description utilisables', () => {
    expect(FAMILLES.length).toBe(8);
    for (const famille of FAMILLES) {
      expect(famille.label.length).toBeGreaterThan(3);
      expect(famille.description.length).toBeGreaterThan(10);
    }
  });

  it('les clés de famille sont uniques', () => {
    expect(new Set(FAMILLES.map((f) => f.cle)).size).toBe(FAMILLES.length);
  });
});
