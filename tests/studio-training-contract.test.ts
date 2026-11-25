import { describe, expect, it } from 'vitest';
import { trainingContract, protocolBinding, integrationProgress } from '../supabase/functions/studio-runtime/families';

/**
 * Contrat d'entraînement LoRA : ce qui est PROUVÉ par la fiche, et ce qui ne
 * l'est pas. Aucun test ne prétend vérifier le contenu d'une archive ni le
 * résultat réel d'un entraînement (interdits sans clé et sans dépense).
 */

const openapi = (path: string) => ({
  paths: { [`/api/v1/${path}`]: { post: { tags: [], responses: { 200: { description: 'ok' } } } } },
});

const trainer = (options: { output?: Record<string, unknown>; dataset?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) => ({
  provider_model_id: 'trainer',
  category: 'Training',
  input_schema: {
    schemas: {
      input_data: {
        type: 'object', endpoint_url: 'trainer',
        required: ['dataset', 'trigger_word'],
        properties: {
          dataset: options.dataset ?? { type: 'string', field: 'zip', description: 'Public URL to a .zip archive containing 10-50 images.' },
          trigger_word: { type: 'string', minLength: 1, maxLength: 60 },
          training_steps: { type: 'int', minimum: 100, maximum: 5000, default: 1000 },
          learning_rate: { type: 'float', minimum: 0.00001, maximum: 0.01 },
          ...(options.extra ?? {}),
        },
      },
      output_data: options.output ?? { type: 'object', properties: { outputs: { type: 'array', items: { type: 'string' }, description: 'Generated LoRA safetensors file URLs' } } },
    },
  },
  output_schema: { schemas: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, output: { type: 'object', properties: {} } } } },
  endpoint_evidence: { resolution: { status: 'resolved', path: 'trainer' } },
});

describe('contrat d’entraînement LoRA', () => {
  it('décrit le jeu de données, les paramètres, la sortie et l’endpoint', () => {
    const contract = trainingContract(trainer(), openapi('trainer'))!;
    expect(contract).not.toBeNull();
    expect(contract.is_training).toBe(true);
    // `declared` = chemin déclaré par la fiche ET opération présente dans
    // l'OpenAPI officiel ; c'est l'état confirmé du résolveur.
    expect(contract.endpoint).toEqual({ path: 'trainer', status: 'declared' });
    expect(contract.dataset_fields).toEqual([{ key: 'dataset', required: true, declared_public_link: true, field: 'zip' }]);
    expect(contract.parameters.map((parameter) => parameter.key)).toEqual(['trigger_word', 'training_steps', 'learning_rate']);
    expect(contract.parameters.find((parameter) => parameter.key === 'training_steps')).toMatchObject({
      type: 'int', required: false, minimum: 100, maximum: 5000,
    });
    expect(contract.protocol).toBe('muapi_output_media_list_v1');
    expect(contract.output_field).toBe('outputs');
    expect(contract.quota_family_note).toContain('studio_family_rules');
    expect(contract.blockers).toContain('REAL_TEST_PENDING');
  });

  it('déclare honnêtement ses limites : archive non inspectée, prose non applicable', () => {
    const contract = trainingContract(trainer(), openapi('trainer'))!;
    expect(contract.limitations.join(' ')).toContain('jamais téléchargée');
    expect(contract.limitations.join(' ')).toContain('prose');
    expect(contract.limitations.join(' ')).toContain('test fournisseur');
  });

  it('distingue un lien public déclaré d’un import privé exigé', () => {
    const privateDataset = trainer({ dataset: { type: 'string', field: 'zip', description: 'ZIP archive of training images.' } });
    expect(trainingContract(privateDataset, openapi('trainer'))!.dataset_fields[0].declared_public_link).toBe(false);
    const progress = integrationProgress(privateDataset, openapi('trainer'));
    expect(progress.blockers).toContain('UPLOAD_FORMAT_UNSUPPORTED');
  });

  it('accepte plusieurs champs d’archive déclarés', () => {
    const contract = trainingContract(trainer({
      extra: { mask_dataset: { type: 'string', field: 'zip', description: 'Public URL to a mask .zip archive.' } },
    }), openapi('trainer'))!;
    expect(contract.dataset_fields.map((field) => field.key)).toEqual(['dataset', 'mask_dataset']);
    expect(contract.dataset_fields.every((field) => field.declared_public_link)).toBe(true);
  });

  it('reste bloqué quand la sortie est ambiguë, sans inventer de champ', () => {
    const ambiguous = trainer({ output: { type: 'object', properties: {
      lora_url: { type: 'string', format: 'uri' },
      preview_url: { type: 'string', format: 'uri' },
    } } });
    const contract = trainingContract(ambiguous, openapi('trainer'))!;
    expect(contract.output_field).toBeNull();
    expect(contract.protocol).toBeNull();
    expect(contract.blockers).toContain('RESPONSE_CONTRACT_UNSUPPORTED');
  });

  it('n’est pas un contrat d’entraînement pour un générateur', () => {
    const generator = trainer();
    generator.category = 'Text to Image';
    expect(trainingContract(generator, openapi('trainer'))).toBeNull();
    expect(protocolBinding(generator)).toBe('muapi_output_media_list_v1');
  });
});
