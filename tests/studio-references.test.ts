import { describe, expect, it } from 'vitest';
import {
  mediaPayload, planReferences, referenceSupport, type ResolvedReference,
} from '../src/studio/references';

/**
 * Références Studio.
 *
 * La règle à prouver : un média ne part QUE si le modèle déclare le champ
 * correspondant dans son catalogue. Ces tests couvrent les vrais champs relevés
 * en production (`images_list`, `image_urls`, `reference_images`,
 * `reference_videos`, `video_url`, `last_image`).
 */

const image = (id: string): ResolvedReference => ({
  fileId: id,
  name: `${id}.png`,
  kind: 'image',
  role: 'product',
  storagePath: `ws/files/images/${id}.png`,
  url: `https://sign/${id}`,
});

const video = (id: string): ResolvedReference => ({
  fileId: id,
  name: `${id}.mp4`,
  kind: 'video',
  role: 'video_reference',
  storagePath: `ws/files/videos/${id}.mp4`,
  url: `https://sign/${id}`,
});

describe('capacité déduite des champs déclarés', () => {
  it('reconnaît un modèle multi-images', () => {
    const support = referenceSupport(['prompt', 'images_list', 'aspect_ratio']);
    expect(support.imageField).toBe('images_list');
    expect(support.imageMultiple).toBe(true);
    expect(support.imageLimit).toBeGreaterThan(1);
  });

  it('reconnaît un modèle mono-image', () => {
    const support = referenceSupport(['prompt', 'image_url']);
    expect(support.imageField).toBe('image_url');
    expect(support.imageMultiple).toBe(false);
    expect(support.imageLimit).toBe(1);
  });

  it('préfère une liste à une image unique quand les deux sont déclarées', () => {
    expect(referenceSupport(['image_url', 'images_list']).imageField).toBe('images_list');
  });

  it('reconnaît un modèle sans aucune capacité média', () => {
    const support = referenceSupport(['prompt', 'duration']);
    expect(support.imageField).toBeNull();
    expect(support.videoField).toBeNull();
    expect(support.imageLimit).toBe(0);
  });

  it('reconnaît les variantes de vidéo de référence', () => {
    expect(referenceSupport(['reference_videos']).videoField).toBe('reference_videos');
    expect(referenceSupport(['video_url']).videoField).toBe('video_url');
    expect(referenceSupport(['input_video']).videoField).toBe('input_video');
  });

  it('reconnaît les deux formes d’image de fin', () => {
    expect(referenceSupport(['last_image']).lastImageField).toBe('last_image');
    expect(referenceSupport(['end_image_url']).lastImageField).toBe('end_image_url');
    expect(referenceSupport(['prompt']).lastImageField).toBeNull();
  });

  it('est insensible à la casse', () => {
    expect(referenceSupport(['IMAGES_LIST']).imageField).toBe('images_list');
  });
});

describe('répartition des références', () => {
  it('n’envoie rien à un modèle qui n’accepte aucun média, et le dit', () => {
    const plan = planReferences([image('a'), video('b')], referenceSupport(['prompt']));
    expect(plan.images).toEqual([]);
    expect(plan.videos).toEqual([]);
    expect(plan.rejected).toHaveLength(2);
    expect(plan.warning).toMatch(/aucune des références/i);
    expect(plan.rejected[0].reason).toMatch(/n’accepte aucune image/i);
    expect(plan.rejected[1].reason).toMatch(/n’accepte aucune vidéo/i);
  });

  it('envoie plusieurs images à un modèle multi-images', () => {
    const plan = planReferences(
      [image('a'), image('b'), image('c')],
      referenceSupport(['images_list']),
    );
    expect(plan.images.map((r) => r.fileId)).toEqual(['a', 'b', 'c']);
    expect(plan.rejected).toEqual([]);
  });

  it('n’envoie qu’une image à un modèle mono-image, en expliquant les autres', () => {
    const plan = planReferences([image('a'), image('b')], referenceSupport(['image_url']));
    expect(plan.images.map((r) => r.fileId)).toEqual(['a']);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].reason).toMatch(/au plus 1 image/i);
  });

  it('respecte une limite supérieure et rejette le surplus', () => {
    const beaucoup = Array.from({ length: 12 }, (_, index) => image(`i${index}`));
    const plan = planReferences(beaucoup, referenceSupport(['images_list']));
    expect(plan.images).toHaveLength(8);
    expect(plan.rejected).toHaveLength(4);
  });

  it('n’envoie qu’une vidéo de référence et explique le reste', () => {
    const plan = planReferences([video('v1'), video('v2')], referenceSupport(['reference_videos']));
    expect(plan.videos.map((r) => r.fileId)).toEqual(['v1']);
    expect(plan.rejected[0].reason).toMatch(/une seule vidéo/i);
  });

  it('utilise la dernière image acceptée comme image de fin', () => {
    const plan = planReferences(
      [image('a'), image('b')],
      referenceSupport(['images_list', 'last_image']),
    );
    expect(plan.lastImage?.fileId).toBe('b');
  });

  it('ne renseigne pas d’image de fin avec une seule image', () => {
    const plan = planReferences([image('a')], referenceSupport(['images_list', 'last_image']));
    expect(plan.lastImage).toBeNull();
  });

  it('ne produit aucun avertissement quand tout est accepté', () => {
    const plan = planReferences([image('a')], referenceSupport(['image_url']));
    expect(plan.warning).toBeNull();
  });
});

describe('payload envoyé au serveur', () => {
  it('transmet les CHEMINS Storage, jamais les URL signées du navigateur', () => {
    const support = referenceSupport(['images_list']);
    const plan = planReferences([image('a'), image('b')], support);
    const payload = mediaPayload(plan, support);

    expect(payload.image_storage_paths).toEqual([
      'ws/files/images/a.png', 'ws/files/images/b.png',
    ]);
    // Aucune URL signée : elle expirerait avant l'exécution du job.
    expect(JSON.stringify(payload)).not.toContain('https://sign');
  });

  it('garde le premier chemin sous la forme historique', () => {
    const support = referenceSupport(['images_list']);
    const payload = mediaPayload(planReferences([image('a'), image('b')], support), support);
    expect(payload.image_storage_path).toBe('ws/files/images/a.png');
  });

  it('ajoute la vidéo seulement si le modèle l’accepte', () => {
    const avecVideo = referenceSupport(['prompt', 'reference_videos']);
    const sansVideo = referenceSupport(['prompt', 'images_list']);
    expect(mediaPayload(planReferences([video('v1')], avecVideo), avecVideo))
      .toMatchObject({ video_storage_path: 'ws/files/videos/v1.mp4' });
    expect(mediaPayload(planReferences([video('v1')], sansVideo), sansVideo))
      .not.toHaveProperty('video_storage_path');
  });

  it('ne produit aucune clé de média quand il n’y a aucune référence', () => {
    const support = referenceSupport(['images_list', 'video_url']);
    expect(mediaPayload(planReferences([], support), support)).toEqual({});
  });
});
