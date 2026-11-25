import { describe, expect, it } from 'vitest';
import { declaresExternalAction, externalActionContract, externalActionBlockers } from '../supabase/functions/studio-runtime/external-actions';
import { integrationProgress, protocolBinding } from '../supabase/functions/studio-runtime/families';

/**
 * Actions externes : la détection repose sur des DÉCLARATIONS (compte connecté,
 * identifiant de publication), jamais sur le nom du modèle. Aucune de ces
 * fonctions n'exécute d'action : le contrat est un consentement, pas un envoi.
 */

const openapi = (path: string) => ({ paths: { [`/api/v1/${path}`]: { post: { tags: [] } } } });

const publishModel = (overrides: Record<string, unknown> = {}) => ({
  provider_model_id: 'tiktok-publish',
  category: 'other',
  input_schema: { schemas: { input_data: {
    type: 'object', title: 'TikTok', endpoint_url: 'tiktok-publish',
    required: ['account_id', 'media_url'],
    properties: {
      account_id: { type: 'integer', title: 'Account ID', options_source: 'social_accounts', options_platform: 'tiktok' },
      media_url: { type: 'string', field: 'video', title: 'Video URL', description: 'Public URL of the video to upload.' },
      title: { type: 'string', default: '' },
    },
  } } },
  output_schema: { schemas: { properties: { id: { type: 'string' }, status: { type: 'string' },
    output: { type: 'object', properties: { publish_id: { type: 'string' } } } } } },
  endpoint_evidence: { resolution: { status: 'resolved', path: 'tiktok-publish' } },
  ...overrides,
});

describe('détection d’une action externe', () => {
  it('reconnaît un compte connecté déclaré et un identifiant de publication', () => {
    expect(declaresExternalAction(publishModel())).toBe(true);
    // Ni compte connecté ni identifiant de publication : pas une action.
    expect(declaresExternalAction({
      provider_model_id: 'plain',
      input_schema: { schemas: { input_data: { type: 'object', properties: { caption: { type: 'string' } } } } },
      output_schema: { schemas: { properties: { id: { type: 'string' }, status: { type: 'string' } } } },
    })).toBe(false);
  });

  it('ne confond pas un simple champ `url` de sortie avec une action', () => {
    const normal = publishModel({
      provider_model_id: 'generator',
      input_schema: { schemas: { input_data: { type: 'object', endpoint_url: 'g', properties: { prompt: { type: 'string' } } } } },
      output_schema: { schemas: { properties: { id: { type: 'string' }, status: { type: 'string' },
        output: { type: 'object', properties: { url: { type: 'string', format: 'uri' } } } } } },
    });
    expect(declaresExternalAction(normal)).toBe(false);
    expect(externalActionContract(normal)).toBeNull();
  });
});

describe('contrat d’action externe', () => {
  it('décrit permissions, confirmation et absence d’exécution', () => {
    const contract = externalActionContract(publishModel())!;
    expect(contract).not.toBeNull();
    expect(contract.platform).toBe('tiktok');
    expect(contract.kind).toBe('publish');
    expect(contract.account_fields).toEqual(['account_id']);
    expect(contract.required_inputs).toEqual(['account_id', 'media_url']);
    expect(contract.permission_scopes).toEqual(['social.tiktok.account', 'social.tiktok.publish']);
    expect(contract.confirmation).toContain('tiktok');
    expect(contract.execution).toBe('unavailable');
    expect(contract.execution_blockers).toEqual(['PROVIDER_ACCOUNT_LINK_MISSING', 'EXECUTION_DISABLED', 'REAL_TEST_PENDING']);
    expect(contract.output_kind).toBe('publication_id');
  });

  it('reste une action de mise à jour quand la fiche déclare un identifiant vidéo', () => {
    const update = publishModel({
      provider_model_id: 'youtube-update-metadata',
      input_schema: { schemas: { input_data: { type: 'object', endpoint_url: 'youtube-update-metadata',
        required: ['account_id', 'video_id'], properties: {
          account_id: { type: 'integer', options_source: 'social_accounts', options_platform: 'youtube' },
          video_id: { type: 'string', title: 'Video ID' },
          title: { type: 'string' },
        } } } },
      output_schema: { schemas: { properties: { id: { type: 'string' }, status: { type: 'string' },
        output: { type: 'object', properties: { url: { type: 'string', format: 'uri' } } } } } },
    });
    const contract = externalActionContract(update)!;
    expect(contract.kind).toBe('update');
    expect(contract.permission_scopes).toEqual(['social.youtube.account', 'social.youtube.update']);
  });

  it('ne déduit jamais une exécution d’un contrat', () => {
    const contract = externalActionContract(publishModel())!;
    expect(contract).not.toHaveProperty('endpoint');
    expect(contract).not.toHaveProperty('payload');
    expect(contract).not.toHaveProperty('credits');
  });
});

describe('une action externe n’est pas une génération', () => {
  it('reste bloquée avec un motif explicite, hors pipeline de contenu', () => {
    const progress = integrationProgress(publishModel(), openapi('tiktok-publish'));
    expect(progress.status).toBe('blocked');
    expect(progress.protocol).toBeNull();
    expect(progress.stages.adapter_available).toBe(false);
    expect(progress.blockers).toContain('EXTERNAL_ACTION_REQUIRED');
    expect(progress.blockers).toContain('PROVIDER_ACCOUNT_LINK_MISSING');
    expect(progress.blockers).not.toContain('RESPONSE_CONTRACT_UNSUPPORTED');
    expect(progress.blockers).not.toContain('SCHEMA_UNSUPPORTED');
    expect(protocolBinding(publishModel())).toBeNull();
  });

  it('expose exactement les mêmes codes pour tout outil déclaré', () => {
    expect(externalActionBlockers(publishModel())).toEqual([
      'EXTERNAL_ACTION_REQUIRED', 'PROVIDER_ACCOUNT_LINK_MISSING', 'CONSTRAINT_REVIEW_REQUIRED', 'REAL_TEST_PENDING',
    ]);
    expect(externalActionBlockers({
      provider_model_id: 'plain',
      input_schema: { schemas: { input_data: { type: 'object', properties: { prompt: { type: 'string' } } } } },
      output_schema: { schemas: { properties: { id: { type: 'string' } } } },
    })).toEqual([]);
  });
});
