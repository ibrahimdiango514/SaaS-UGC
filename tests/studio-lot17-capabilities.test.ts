import { describe, expect, it } from 'vitest';
import { integrationProgress, protocolBinding, responseField, familyResult } from '../supabase/functions/studio-runtime/families';
import { declaredExternalLink, validateMuapiInput } from '../supabase/functions/universal-catalog/schema';

/**
 * Incrément 17 : capacités bornées par une DÉCLARATION officielle de la fiche.
 * - la sortie déclarée dans `input_schema.schemas.output_data` est une preuve ;
 * - un champ déclaré « public URL » est un lien, jamais un import privé ;
 * - un entraînement LoRA reste un entraînement, mais son contrat est exploitable ;
 * - une donnée `result` déclarée est restituée en JSON borné, jamais devinée.
 */
const openapi = (path: string) => ({
  paths: { [`/api/v1/${path}`]: { post: { tags: [], responses: { 200: { description: 'ok' } } } } },
});

const training = (outputData: Record<string, unknown>, description = 'Public URL to a .zip archive containing 10-50 training images.', title = 'Images Zip URL') => ({
  provider_model_id: 'trainer',
  category: 'Training',
  input_schema: {
    schemas: {
      input_data: {
        type: 'object', endpoint_url: 'trainer',
        properties: { images_data_url: { type: 'string', field: 'zip', title, description, examples: ['https://cdn.example.com/train.zip'] } },
        required: ['images_data_url'],
      },
      output_data: outputData,
    },
  },
  output_schema: { schemas: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, output: { type: 'object', properties: {} } } } },
  endpoint_evidence: { endpoint: '/api/v1/trainer', resolution: { status: 'resolved', path: 'trainer' } },
});

describe('sortie déclarée dans la fiche d’entrée (`output_data`)', () => {
  const sheetOutput = { type: 'object', properties: { video: { title: 'Image', description: 'The generated image', examples: ['https://cdn.example.com/out.jpeg'] } } };
  const model = {
    provider_model_id: 'model',
    category: 'Image to Image',
    input_schema: { schemas: { input_data: { type: 'object', properties: { prompt: { type: 'string' } }, endpoint_url: 'model' }, output_data: sheetOutput } },
    output_schema: { schemas: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, output: { type: 'object', properties: {} } } } },
    endpoint_evidence: { endpoint: '/api/v1/model', resolution: { status: 'resolved', path: 'model' } },
  };

  it('lie un exemple HTTPS déclaré même quand `type` est omis', () => {
    expect(protocolBinding(model)).toBe('muapi_output_media_v1');
    expect(responseField(model)).toBe('video');
  });

  it('refuse toujours un champ sans aucune déclaration', () => {
    const silent = { ...model, input_schema: { schemas: { output_data: { type: 'object', properties: { video: { type: 'string' } } } } } };
    expect(responseField(silent)).toBeNull();
    expect(protocolBinding(silent)).toBeNull();
  });
});

describe('entraînement LoRA', () => {
  it('lie la sortie déclarée et n’exige aucun import pour un lien public', () => {
    const bound = training({ type: 'object', properties: { lora_url: { type: 'string', format: 'uri' } } });
    expect(protocolBinding(bound)).toBe('muapi_output_media_v1');
    expect(responseField(bound)).toBe('lora_url');
    const progress = integrationProgress(bound, openapi('trainer'));
    expect(progress.stages.upload_functional).toBe(true);
    expect(progress.stages.output_media_supported).toBe(true);
    expect(progress.blockers).not.toContain('UPLOAD_FORMAT_UNSUPPORTED');
    expect(progress.blockers).not.toContain('RESPONSE_CONTRACT_UNSUPPORTED');
    expect(progress.blockers).toContain('REAL_TEST_PENDING');
  });

  it('lie une liste de fichiers déclarée « … URLs »', () => {
    const bound = training({ type: 'object', properties: { outputs: { type: 'array', items: { type: 'string' }, description: 'Generated LoRA safetensors file URLs' } } });
    expect(protocolBinding(bound)).toBe('muapi_output_media_list_v1');
    expect(responseField(bound)).toBe('outputs');
  });

  it('reste bloqué sans déclaration de sortie exploitable', () => {
    const bound = training({ type: 'object', properties: { outputs: { type: 'array', items: { type: 'string' } } } });
    expect(protocolBinding(bound)).toBeNull();
    expect(integrationProgress(bound, openapi('trainer')).status).toBe('blocked');
  });

  it('exige toujours un import privé quand le champ n’est pas déclaré public', () => {
    const bound = training({ type: 'object', properties: { lora_url: { type: 'string', format: 'uri' } } }, 'ZIP archive of training images.', 'Archives');
    expect(integrationProgress(bound, openapi('trainer')).stages.upload_functional).toBe(false);
    expect(integrationProgress(bound, openapi('trainer')).blockers).toContain('UPLOAD_FORMAT_UNSUPPORTED');
  });
});

describe('donnée déclarée (`result`)', () => {
  const data = {
    provider_model_id: 'data',
    category: 'Text to Text',
    input_schema: { schemas: { input_data: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], endpoint_url: 'data' } } },
    output_schema: { schemas: { type: 'object', properties: {
      id: { type: 'string' }, status: { type: 'string' },
      result: { type: 'object', description: 'Normalized lookup result' },
      billing: { type: 'object' }, error: { type: 'string' },
    } } },
    endpoint_evidence: { endpoint: '/api/v1/data', resolution: { status: 'resolved', path: 'data' } },
  };

  it('lie le protocole de donnée et restitue un JSON borné', () => {
    expect(protocolBinding(data)).toBe('muapi_output_json_v1');
    const parsed = familyResult('muapi_output_json_v1', { id: 'r1', status: 'completed', result: { score: 0.9, ok: true } }, 'r1');
    expect(parsed.state).toBe('succeeded');
    expect(JSON.parse(parsed.text ?? '')).toEqual({ score: 0.9, ok: true });
    expect(integrationProgress(data, openapi('data')).status).toBe('integration_prepared');
  });

  it('refuse un résultat absent, non borné ou d’un autre identifiant', () => {
    expect(() => familyResult('muapi_output_json_v1', { id: 'r1', status: 'completed' }, 'r1')).toThrow('RESULT_DATA_UNRECOGNIZED');
    // Borne en OCTETS UTF-8 (lot 18) : 65 536 « é » = 131 072 octets.
    expect(() => familyResult('muapi_output_json_v1', { id: 'r1', status: 'completed', result: { blob: 'é'.repeat(65536) } }, 'r1')).toThrow('RESULT_DATA_TOO_LARGE');
    expect(() => familyResult('muapi_output_json_v1', { id: 'other', status: 'completed', result: {} }, 'r1')).toThrow('RESULT_ID_MISMATCH');
  });

  it('ne transforme pas une donnée en média et gère échec et attente', () => {
    expect(familyResult('muapi_output_json_v1', { id: 'r1', status: 'processing' }, 'r1').state).toBe('pending');
    expect(familyResult('muapi_output_json_v1', { id: 'r1', status: 'failed' }, 'r1').state).toBe('failed');
  });
});

describe('champ déclaré « public URL »', () => {
  it('distingue une déclaration explicite d’un simple exemple HTTPS', () => {
    expect(declaredExternalLink({ type: 'string', field: 'zip', description: 'Public URL to a .zip archive.' })).toBe(true);
    expect(declaredExternalLink({ type: 'string', field: 'image', examples: ['https://cdn.example.com/a.png'] })).toBe(false);
    expect(declaredExternalLink({ type: 'string', format: 'uri' })).toBe(false);
  });

  it('reste validé en HTTPS par le schéma serveur', () => {
    const schema = { schemas: { input_data: { type: 'object', properties: {
      images_data_url: { type: 'string', field: 'zip', description: 'Public URL to a .zip archive.' },
    }, required: ['images_data_url'] } } };
    expect(validateMuapiInput(schema, { images_data_url: 'https://cdn.example.com/train.zip' }).ok).toBe(true);
    expect(validateMuapiInput(schema, { images_data_url: 'http://cdn.example.com/train.zip' }).ok).toBe(false);
  });
});

describe('archive d’entraînement déclarée par un lien', () => {
  it('accepte « URL to ZIP archive » comme lien, sans élargir les autres médias', () => {
    expect(declaredExternalLink({ type: 'string', field: 'zip', description: 'URL to ZIP archive containing training images.' })).toBe(true);
    expect(declaredExternalLink({ type: 'string', field: 'image', description: 'URL of the input image.' })).toBe(false);
  });
});
