import { describe, expect, it } from 'vitest';
import { integrationProgress, protocolBinding, responseField, familyResult } from '../supabase/functions/studio-runtime/families';

/**
 * Liaison du champ de résultat : seule une DÉCLARATION officielle de la fiche
 * (format URI, titre/description « … URL(s) », ou exemples tous HTTPS) lie un
 * champ. Le nom du champ ne prouve rien, et une ambiguïté reste refusée.
 */
const model = (output: Record<string, unknown>, category = 'Text to Video') => ({
  provider_model_id: 'model',
  category,
  input_schema: { schemas: { input_data: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], endpoint_url: 'model' } } },
  output_schema: { schemas: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, output } } },
  endpoint_evidence: { endpoint: '/api/v1/model', resolution: { status: 'resolved', path: 'model' } },
});

describe('déclaration du champ de sortie', () => {
  it('lie une description officielle « Generated video URL »', () => {
    const output = { type: 'object', properties: { video: { type: 'string', description: 'Generated video URL' } } };
    expect(protocolBinding(model(output))).toBe('muapi_output_media_v1');
    expect(responseField(model(output))).toBe('video');
  });

  it('lie une liste déclarée « Generated 3D asset URLs »', () => {
    const output = { type: 'object', properties: { outputs: { type: 'array', items: { type: 'string' }, description: 'Generated 3D asset URLs' } } };
    expect(protocolBinding(model(output, 'Image to 3D'))).toBe('muapi_output_media_list_v1');
    expect(responseField(model(output, 'Image to 3D'))).toBe('outputs');
  });

  it('refuse un champ seulement nommé comme un média, sans déclaration', () => {
    const output = { type: 'object', properties: { video: { type: 'string' }, image_url: { type: 'string' } } };
    expect(responseField(model(output))).toBeNull();
    expect(protocolBinding(model(output))).toBeNull();
  });

  it('refuse une ambiguïté entre deux champs déclarés URL', () => {
    const output = { type: 'object', properties: {
      preview: { type: 'string', format: 'uri' }, final: { type: 'string', format: 'uri' },
    } };
    expect(responseField(model(output))).toBeNull();
  });

  it('conserve le comportement `format: uri` et valide le résultat en HTTPS', () => {
    const output = { type: 'object', properties: { image: { type: 'string', format: 'uri' } } };
    const bound = model(output, 'Text to Image');
    expect(protocolBinding(bound)).toBe('muapi_output_media_v1');
    expect(familyResult('muapi_output_media_v1', { id: 'r1', status: 'completed', output: { image: 'https://cdn.example.com/a.png' } }, 'r1', 'image'))
      .toMatchObject({ state: 'succeeded', media: ['https://cdn.example.com/a.png'] });
    // Un résultat non HTTPS n'est jamais accepté, même correctement lié.
    expect(() => familyResult('muapi_output_media_v1', { id: 'r1', status: 'completed', output: { image: 'http://cdn.example.com/a.png' } }, 'r1', 'image'))
      .toThrow('RESULT_OUTPUT_UNRECOGNIZED');
  });

  it('reste bloqué quand aucune déclaration de sortie n’existe', () => {
    const bound = model({ type: 'object', properties: {} }, 'Image to Image');
    expect(integrationProgress(bound).status).toBe('blocked');
    expect(integrationProgress(bound).blockers).toContain('RESPONSE_CONTRACT_UNSUPPORTED');
  });
});
