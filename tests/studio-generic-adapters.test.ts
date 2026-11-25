import { describe, expect, it } from 'vitest';
import {
  classifyFamily,
  familyResult,
  integrationProgress,
  protocolBinding,
} from '../supabase/functions/studio-runtime/families';
import { fileType } from '../supabase/functions/studio-runtime/core';

const uri = { type: 'string', format: 'uri' };
const promptOnly = { schemas: { input_data: { type: 'object', endpoint_url: 'documented-model', properties: { prompt: { type: 'string', minLength: 2 } } } } };
const document = {
  paths: { '/api/v1/documented-model': { post: { operationId: 'op', tags: ['Video: Text-to-Video'] } } },
  __document_sha256: 'a'.repeat(64),
};
const namedOutput = (field: string, title: string) => ({
  schemas: { type: 'object', properties: { output: { type: 'object', properties: { [field]: { type: 'string', title } } } } },
});

describe('declared media outputs without a duplicated envelope', () => {
  it.each([
    ['video_url', 'Video URL', 'Text to Video'],
    ['image_url', 'Image URL', 'Text to Image'],
    ['audio_url', 'Audio URL', 'Text to Audio'],
  ])('binds %s declared by the model sheet', (field, title, category) => {
    const model = { provider_model_id: 'documented-model', category, input_schema: promptOnly, output_schema: namedOutput(field, title) };
    expect(protocolBinding(model)).toBe('muapi_output_media_v1');
    const progress = integrationProgress(model, document);
    expect(progress.status).toBe('integration_prepared');
    expect(progress.result_field).toBe(field);
  });

  it('binds a declared URI array without a duplicated envelope', () => {
    const model = {
      provider_model_id: 'documented-model',
      category: 'Text to Image',
      input_schema: promptOnly,
      output_schema: { schemas: { type: 'object', properties: { output: { type: 'array', items: uri } } } },
    };
    expect(protocolBinding(model)).toBe('muapi_output_urls_v1');
    expect(integrationProgress(model, document).status).toBe('integration_prepared');
  });

  it('still refuses a result whose identity or status is missing at runtime', () => {
    expect(() => familyResult('muapi_output_media_v1', { output: { video_url: 'https://cdn.example.com/v.mp4' } }, 'r', 'video_url')).toThrow();
    expect(() => familyResult('muapi_output_media_v1', { id: 'r', output: { video_url: 'https://cdn.example.com/v.mp4' } }, 'r', 'video_url')).toThrow();
    expect(familyResult('muapi_output_media_v1', { id: 'r', status: 'completed', output: { video_url: 'https://cdn.example.com/v.mp4' } }, 'r', 'video_url').media).toHaveLength(1);
    expect(() => familyResult('muapi_output_media_v1', { id: 'other', status: 'completed', output: { video_url: 'https://cdn.example.com/v.mp4' } }, 'r', 'video_url')).toThrow('RESULT_ID_MISMATCH');
  });

  it('never invents a media output from an untyped or ambiguous declaration', () => {
    const untyped = { schemas: { type: 'object', properties: { output: { type: 'object', properties: { video_url: { type: 'string' } } } } } };
    expect(protocolBinding({ provider_model_id: 'x', category: 'Text to Video', input_schema: promptOnly, output_schema: untyped })).toBeNull();
    const twoUrls = {
      schemas: { type: 'object', properties: { output: { type: 'object', properties: {
        video_url: { type: 'string', title: 'Video URL' }, image_url: { type: 'string', title: 'Image URL' },
      } } } },
    };
    expect(protocolBinding({ provider_model_id: 'x', category: 'Text to Video', input_schema: promptOnly, output_schema: twoUrls })).toBeNull();
  });
});

describe('LoRA inference is not training', () => {
  const inference = {
    provider_model_id: 'z-image-turbo-text-to-image-lora',
    category: 'Lora Support',
    input_schema: promptOnly,
    output_schema: namedOutput('image_url', 'Image URL'),
  };

  it('classifies Lora Support as inference and keeps training a distinct family', () => {
    expect(classifyFamily(inference)).toBe('lora-inference');
    expect(classifyFamily({ category: 'Training' })).toBe('training');
    expect(protocolBinding(inference)).toBe('muapi_output_media_v1');
    expect(integrationProgress(inference, document).status).toBe('integration_prepared');
    // Lot 17 : un entraînement dont la fiche déclare une URL de sortie a un
    // contrat exploitable, mais il reste un entraînement (famille distincte) et
    // n'est jamais présenté comme opérationnel sans test réel.
    const training = { ...inference, category: 'Training' };
    expect(protocolBinding(training)).toBe('muapi_output_media_v1');
    const progress = integrationProgress(training, document);
    expect(classifyFamily(training)).toBe('training');
    expect(progress.status).toBe('integration_prepared');
    expect(progress.blockers).toContain('REAL_TEST_PENDING');
  });

  it('keeps a training sheet blocked when its output is not declared', () => {
    const silent = {
      ...inference,
      category: 'Training',
      output_schema: { schemas: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, output: { type: 'object', properties: {} } } } },
    };
    expect(protocolBinding(silent)).toBeNull();
    expect(integrationProgress(silent, document).blockers).toContain('RESPONSE_CONTRACT_UNSUPPORTED');
  });

  it('still blocks a LoRA sheet that requires an unsupported archive upload', () => {
    const zip = {
      ...inference,
      input_schema: { schemas: { input_data: { type: 'object', endpoint_url: 'documented-model', properties: {
        prompt: { type: 'string', minLength: 2 }, dataset: { type: 'string', field: 'zip' },
      } } } },
    };
    expect(integrationProgress(zip, document).blockers).toContain('UPLOAD_FORMAT_UNSUPPORTED');
  });
});

describe('un lien HTTPS saisi par le client n’est pas un upload', () => {
  /*
   * Cause réelle de 24 blocages `UPLOAD_FORMAT_UNSUPPORTED` : un champ
   * `format: uri|url` SANS `field` (poids LoRA, URL de référence) était compté
   * comme un emplacement de fichier à supporter. Il n'y a rien à téléverser :
   * `validateMuapiInput` impose déjà `isHttpsInput` sur ce champ.
   */
  const sheet = (properties: Record<string, unknown>) => ({
    schemas: { input_data: { type: 'object', endpoint_url: 'documented-model', properties } },
  });
  const model = (properties: Record<string, unknown>) => ({
    provider_model_id: 'documented-model',
    category: 'Lora Support',
    input_schema: sheet(properties),
    output_schema: namedOutput('image_url', 'Image URL'),
  });

  it('débloque une fiche dont le seul champ média est une URL déclarée', () => {
    const progress = integrationProgress(model({
      prompt: { type: 'string', minLength: 2 },
      lora_url: { type: 'string', format: 'url' },
    }), document);
    expect(progress.stages.upload_functional).toBe(true);
    expect(progress.status).toBe('integration_prepared');
  });

  it('continue d’exiger un adaptateur pour un vrai emplacement de fichier', () => {
    const progress = integrationProgress(model({
      prompt: { type: 'string', minLength: 2 },
      image_url: { type: 'string', field: 'image' },
    }), document);
    expect(progress.stages.upload_functional).toBe(true);
    expect(progress.status).toBe('integration_prepared');
  });

  it('refuse toujours une archive en téléversement (aucun runtime ZIP)', () => {
    const progress = integrationProgress(model({
      prompt: { type: 'string', minLength: 2 },
      dataset: { type: 'string', field: 'zip' },
    }), document);
    expect(progress.blockers).toContain('UPLOAD_FORMAT_UNSUPPORTED');
    expect(progress.status).toBe('blocked');
  });

  it('refuse un type de fichier que le schéma ne déclare pas', () => {
    // Un `field` inconnu n'est pas un upload « à supporter » : c'est une fiche
    // que le formulaire ne sait pas construire, donc refusée en amont.
    const progress = integrationProgress(model({
      prompt: { type: 'string', minLength: 2 },
      dataset: { type: 'string', field: 'document' },
    }), document);
    expect(progress.blockers).toContain('SCHEMA_UNSUPPORTED');
    expect(progress.status).toBe('blocked');
  });
});

describe('compatibilité des jobs déjà en file', () => {
  /*
   * Un job persisté avant la version 5 garde `protocol_key` + `result_field` :
   * la réconciliation relit ces deux colonnes telles quelles. Le décodage ne
   * doit donc pas dépendre de la version de l'adaptateur, seulement du contrat
   * enregistré au moment du démarrage.
   */
  it('décode les contrats persistés par les versions précédentes', () => {
    const payloads: [string, string | null, unknown, 'media' | 'text'][] = [
      ['muapi_output_text_v1', null, { id: 'r', status: 'completed', output: { text: 'ok' } }, 'text'],
      ['muapi_output_media_v1', 'image_url', { id: 'r', status: 'completed', output: { image_url: 'https://cdn.example.com/a.png' } }, 'media'],
      ['muapi_output_media_list_v1', 'images', { id: 'r', status: 'completed', output: { images: ['https://cdn.example.com/a.png'] } }, 'media'],
      ['muapi_output_urls_v1', null, { id: 'r', status: 'completed', output: ['https://cdn.example.com/a.png'] }, 'media'],
      ['muapi_output_envelope_v1', null, { id: 'r', status: 'completed', output: { id: 'r', status: 'completed', outputs: ['https://cdn.example.com/a.png'] } }, 'media'],
    ];
    for (const [protocol, field, payload, kind] of payloads) {
      const decoded = familyResult(protocol as never, payload, 'r', field);
      expect(decoded.state, protocol).toBe('succeeded');
      expect(kind === 'text' ? decoded.text : decoded.media.length, protocol).toBeTruthy();
    }
  });
});

describe('résultats 3D (.glb)', () => {
  const modele3d = (category: string) => ({
    provider_model_id: 'documented-model',
    category,
    input_schema: promptOnly,
    output_schema: { schemas: { type: 'object', properties: { output: { type: 'object', properties: { model_url: { ...uri, description: 'Generated 3D model URL (.glb)' } } } } } },
  });

  it('lie le champ déclaré et prépare les deux familles 3D', () => {
    for (const category of ['Text to 3D', 'Image to 3D']) {
      const progress = integrationProgress(modele3d(category), document);
      expect(progress.protocol).not.toBeNull();
      expect(progress.result_field).toBe('model_url');
      expect(progress.stages.output_media_supported).toBe(true);
      expect(progress.status).toBe('integration_prepared');
    }
  });

  it('reconnaît un fichier glTF binaire au téléversement du résultat', () => {
    // Sans cette signature, une génération 3D payée était jetée en
    // RESULT_FILE_UNSUPPORTED au moment d'enregistrer le résultat.
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
    expect(fileType(glb)).toEqual({ mime: 'model/gltf-binary', ext: 'glb', kind: 'model' });
    expect(fileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))?.kind).toBe('image');
    expect(fileType(new Uint8Array([0, 1, 2, 3]))).toBeNull();
  });

  it('le résultat 3D reste refusé s’il n’est pas une URL https', () => {
    expect(() => familyResult('muapi_output_media_v1', { id: 'r', status: 'completed', output: { model_url: 'http://cdn.example/m.glb' } }, 'r', 'model_url')).toThrow('RESULT_OUTPUT_UNRECOGNIZED');
  });
});
