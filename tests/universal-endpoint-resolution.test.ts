import { describe, expect, it } from 'vitest';
import {
  endpointResolutionEvidence,
  resolveMuapiEndpoint,
} from '../supabase/functions/universal-catalog/endpoint';
import { integrationProgress } from '../supabase/functions/studio-runtime/families';

const schema = (path: unknown) => ({ schemas: { input_data: { type: 'object', endpoint_url: path, properties: { prompt: { type: 'string', minLength: 2 } } } } });
const official = (paths: Record<string, unknown>, sha = 'a'.repeat(64)) => ({ paths, __document_sha256: sha });
const post = (operationId: string, request: unknown = { properties: { prompt: { type: 'string' } } }, tags = ['Image: Text-to-Image']) => ({
  post: { operationId, tags, requestBody: { content: { 'application/json': { schema: request } } }, responses: { 200: { description: 'ok' } } },
});
const result = { id: { type: 'string' }, status: { type: 'string' }, output: { type: 'object', properties: { url: { type: 'string', format: 'uri' } } } };
const model = (extra: Record<string, unknown> = {}) => ({
  provider_model_id: 'flux-dev',
  category: 'Text to Image',
  input_schema: schema('flux-dev-image'),
  output_schema: { schemas: { type: 'object', properties: result } },
  ...extra,
});

describe('official OpenAPI endpoint resolution', () => {
  it('adopts the single documented POST path and keeps every original declaration', () => {
    const binding = resolveMuapiEndpoint(
      'flux-dev',
      schema('flux-dev-image'),
      { endpoint: '/api/v1/flux-dev', endpoint_url: 'flux-dev-image' },
      official({ '/api/v1/flux-dev-image': post('generate_flux_dev_image_api_v1_flux_dev_image_post') }),
    );
    expect(binding).toMatchObject({ status: 'declared', path: 'flux-dev-image', resolution: 'openapi_single' });
    expect(binding.declared_paths).toEqual(['flux-dev', 'flux-dev-image']);
    expect(binding.documented_paths).toEqual(['flux-dev-image']);
    if (binding.status !== 'declared') throw new Error('unreachable');
    expect(binding.operation_id).toBe('generate_flux_dev_image_api_v1_flux_dev_image_post');
    expect(endpointResolutionEvidence(binding)).toMatchObject({ status: 'resolved', path: 'flux-dev-image' });
  });

  it('resolves two documented POST paths only when their contracts are identical apart from labels', () => {
    const id = 'seedance-2-vip-text-to-video-1080p';
    const request = { properties: { prompt: { type: 'string' }, duration: { type: 'integer', minimum: 3, maximum: 12 } } };
    const binding = resolveMuapiEndpoint(
      id,
      schema('sd-2-vip-text-to-video-1080p'),
      { endpoint: `/api/v1/${id}`, endpoint_url: 'sd-2-vip-text-to-video-1080p' },
      official({
        [`/api/v1/${id}`]: post('sd_2_vip_text_to_video_1080p_api_v1_seedance_2_vip_text_to_video_1080p_post', request),
        '/api/v1/sd-2-vip-text-to-video-1080p': { post: { ...post('sd_2_vip_text_to_video_1080p_api_v1_sd_2_vip_text_to_video_1080p_post', request).post, summary: 'Alias' } },
      }),
    );
    expect(binding).toMatchObject({ status: 'declared', path: id, resolution: 'openapi_equivalent_contracts' });
    expect(binding.documented_paths).toEqual(['sd-2-vip-text-to-video-1080p', id]);
  });

  it('never merges two documented paths whose contracts differ', () => {
    const binding = resolveMuapiEndpoint(
      'x',
      schema('a'),
      { endpoint: '/api/v1/b' },
      official({
        '/api/v1/a': post('a', { properties: { prompt: { type: 'string' } } }),
        '/api/v1/b': post('b', { properties: { prompt: { type: 'string' }, duration: { type: 'integer' } } }),
      }),
    );
    expect(binding.status).toBe('conflict');
  });

  it('stays a conflict when no declared path is documented', () => {
    expect(resolveMuapiEndpoint('x', schema('a'), { endpoint: '/api/v1/b' }, official({ '/api/v1/c': post('c') })).status).toBe('conflict');
  });

  it('honours a recorded proof only while the declarations are unchanged', () => {
    const recorded = {
      status: 'resolved', path: 'a', resolution: 'openapi_single', operation_id: 'op',
      contract_fingerprint: 'deadbeefdeadbeef', document_sha256: 'b'.repeat(64),
      declared_paths: ['a', 'b'], documented_paths: ['a'],
    };
    const kept = resolveMuapiEndpoint('x', schema('a'), { endpoint: '/api/v1/b', resolution: recorded });
    expect(kept).toMatchObject({ status: 'declared', path: 'a', resolution: 'openapi_single' });
    // A new declaration changes the proof basis: the recorded path is not trusted.
    const changed = resolveMuapiEndpoint('x', schema('a'), { endpoint: '/api/v1/b', endpoint_url: 'c', resolution: recorded });
    expect(changed.status).toBe('conflict');
  });

  it.each([
    { status: 'resolved', path: 'https://evil.example/x', resolution: 'openapi_single', declared_paths: ['a'], documented_paths: [] },
    { status: 'resolved', path: '../a', resolution: 'openapi_single', declared_paths: ['a'], documented_paths: [] },
    { status: 'resolved', path: 'a', resolution: 'guessed', declared_paths: ['a'], documented_paths: [] },
    { status: 'pending', path: 'a', resolution: 'openapi_single', declared_paths: ['a'], documented_paths: [] },
  ])('rejects unsafe or unknown recorded proof %#', (resolution) => {
    const binding = resolveMuapiEndpoint('x', schema('a'), { endpoint: '/api/v1/b', resolution }, official({ '/api/v1/a': post('op') }));
    expect(binding).toMatchObject({ status: 'declared', path: 'a', resolution: 'openapi_single' });
  });

  it('never lets a recorded proof survive when it is not among current declarations', () => {
    const binding = resolveMuapiEndpoint('x', schema('a'), {
      endpoint: '/api/v1/b',
      resolution: { status: 'resolved', path: 'z', resolution: 'openapi_single', declared_paths: ['a', 'b'], documented_paths: ['z'] },
    }, official({ '/api/v1/b': post('op') }));
    expect(binding).toMatchObject({ status: 'declared', path: 'b', resolution: 'openapi_single' });
  });
});

describe('endpoint resolution in integration progress', () => {
  const document = official({
    '/api/v1/flux-dev-image': post('generate_flux_dev_image_api_v1_flux_dev_image_post'),
  });

  it('turns a proven endpoint conflict into a prepared integration and exposes the evidence', () => {
    const progress = integrationProgress(model({ endpoint_evidence: { endpoint: '/api/v1/flux-dev', endpoint_url: 'flux-dev-image' } }), document);
    expect(progress.status).toBe('integration_prepared');
    expect(progress.blockers).not.toContain('ENDPOINT_CONFLICT');
    expect(progress.stages.endpoint_confirmed).toBe(true);
    const evidence = progress.openapi_evidence as Record<string, unknown>;
    expect(evidence.endpoint_resolution).toMatchObject({ path: 'flux-dev-image', resolution: 'openapi_single' });
    // Deterministic: an unchanged document must not invalidate attestations.
    expect(JSON.stringify(integrationProgress(model({ endpoint_evidence: { endpoint: '/api/v1/flux-dev', endpoint_url: 'flux-dev-image' } }), document)))
      .toBe(JSON.stringify(progress));
  });

  it('still blocks an unproven conflict', () => {
    const progress = integrationProgress(model({ endpoint_evidence: { endpoint: '/api/v1/other' } }), official({}));
    expect(progress.status).toBe('blocked');
    expect(progress.blockers).toContain('ENDPOINT_CONFLICT');
    expect((progress.openapi_evidence as Record<string, unknown>).endpoint_resolution).toBeNull();
  });

  it('replays the persisted proof identically on the next worker pass', () => {
    const conflicting = { endpoint: '/api/v1/flux-dev', endpoint_url: 'flux-dev-image' };
    const first = integrationProgress(model({ endpoint_evidence: conflicting }), document);
    const proof = (first.openapi_evidence as Record<string, unknown>).endpoint_resolution as Record<string, unknown>;
    expect(proof).toMatchObject({ resolution: 'openapi_single', path: 'flux-dev-image' });
    const second = integrationProgress(model({ endpoint_evidence: { ...conflicting, resolution: proof } }), document);
    expect(second.status).toBe('integration_prepared');
    expect((second.openapi_evidence as Record<string, unknown>).endpoint_resolution).toEqual(proof);
  });

  it('keeps the proof stable when only unrelated OpenAPI paths change', () => {
    const withExtra = official({
      '/api/v1/flux-dev-image': post('generate_flux_dev_image_api_v1_flux_dev_image_post'),
      '/api/v1/unrelated': post('unrelated'),
    });
    const first = integrationProgress(model({ endpoint_evidence: { endpoint: '/api/v1/flux-dev', endpoint_url: 'flux-dev-image' } }), document);
    const second = integrationProgress(model({ endpoint_evidence: { endpoint: '/api/v1/flux-dev', endpoint_url: 'flux-dev-image' } }), withExtra);
    expect((first.openapi_evidence as Record<string, unknown>).endpoint_resolution)
      .toEqual((second.openapi_evidence as Record<string, unknown>).endpoint_resolution);
  });
});
