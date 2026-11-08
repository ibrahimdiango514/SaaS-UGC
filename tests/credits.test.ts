import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), from: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
    functions: { invoke: mocks.invoke },
  },
  STORAGE_BUCKET: 'ugc-assets',
  SITE_URL: 'http://localhost:5173',
}));

import {
  estimateVideo, listVideoModels, newGenerationIdempotencyKey, startGeneration,
} from '../src/lib/api';
import { humanizeError } from '../src/lib/errors';

const PROJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.invoke.mockReset();
  mocks.from.mockReset();
});

describe('Réservation de crédits et idempotence (RPC mockés)', () => {
  it('transmet un identifiant d’idempotence stable pour une opération donnée', async () => {
    mocks.rpc.mockResolvedValue({ data: JOB_ID, error: null });
    const key = newGenerationIdempotencyKey();
    const id = await startGeneration(PROJECT_ID, 'ugc_clip_8s', { provider: 'muapi', model_id: 'seedance-lite-t2v' }, key);
    expect(id).toBe(JOB_ID);
    expect(mocks.rpc).toHaveBeenCalledWith('reelora_start_generation', expect.objectContaining({
      p_project_id: PROJECT_ID, p_service_key: 'ugc_clip_8s', p_idempotency_key: key,
    }));
  });

  it('deux générations distinctes reçoivent deux identifiants différents (pas de double débit)', async () => {
    mocks.rpc.mockResolvedValue({ data: JOB_ID, error: null });
    const k1 = newGenerationIdempotencyKey();
    const k2 = newGenerationIdempotencyKey();
    expect(k1).not.toBe(k2);
    await startGeneration(PROJECT_ID, 'ugc_clip_8s', {}, k1);
    await startGeneration(PROJECT_ID, 'ugc_clip_8s', {}, k2);
    expect(mocks.rpc.mock.calls[0][1].p_idempotency_key).toBe(k1);
    expect(mocks.rpc.mock.calls[1][1].p_idempotency_key).toBe(k2);
  });

  it('un replay du même identifiant renvoie le même job (aucune réservation supplémentaire)', async () => {
    mocks.rpc.mockResolvedValue({ data: JOB_ID, error: null });
    const key = 'ugc-replay-0001';
    const first = await startGeneration(PROJECT_ID, 'ugc_clip_8s', {}, key);
    const second = await startGeneration(PROJECT_ID, 'ugc_clip_8s', {}, key);
    expect(first).toBe(second);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0][1]).toEqual(mocks.rpc.mock.calls[1][1]);
  });

  it('un solde insuffisant est refusé avec un message compréhensible', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'insufficient_credits', code: 'P0001' } });
    await expect(startGeneration(PROJECT_ID, 'ugc_clip_15s', {})).rejects.toMatchObject({
      name: 'AppError', code: 'P0001',
      message: 'Crédits insuffisants. Rechargez votre solde depuis l’abonnement.',
    });
    expect(humanizeError('insufficient_credits')).toBe('Crédits insuffisants. Rechargez votre solde depuis l’abonnement.');
  });

  it('les erreurs MuAPI sont traduites en français pour l’utilisateur', () => {
    expect(humanizeError('MUAPI_NOT_CONFIGURED')).toContain('MUAPI_API_KEY');
    expect(humanizeError('IMAGE_MISSING')).toContain('image de référence');
    expect(humanizeError('SCRIPT_MISSING')).toContain('script');
    expect(humanizeError('timeout')).toContain('restitués');
  });
});

describe('Estimation affichée avant confirmation', () => {
  it('récupère le coût en crédits et le coût fournisseur depuis le serveur', async () => {
    mocks.invoke.mockResolvedValue({ data: {
      service_key: 'ugc_clip_8s', credits_cost: 9, service_active: true,
      model_id: 'seedance-lite-t2v', model_available: true,
      provider_cost_usd: 0.1, provider_cost_currency: 'USD',
    }, error: null });
    const estimate = await estimateVideo('ugc_clip_8s', 'seedance-lite-t2v');
    expect(estimate).toMatchObject({ credits_cost: 9, model_available: true, provider_cost_usd: 0.1 });
    expect(mocks.invoke).toHaveBeenCalledWith('reelora-video', { body: {
      action: 'estimate', service_key: 'ugc_clip_8s', model_id: 'seedance-lite-t2v',
    } });
  });

  it('expose le catalogue MuAPI sans aucun secret', async () => {
    mocks.invoke.mockResolvedValue({ data: { models: [
      { model_id: 'seedance-lite-t2v', endpoint: '/api/v1/seedance-lite-t2v', required_fields: ['prompt'] },
    ] }, error: null });
    const models = await listVideoModels();
    expect(models).toHaveLength(1);
    expect(models[0].endpoint).toBe('/api/v1/seedance-lite-t2v');
    expect(JSON.stringify(models)).not.toContain('x-api-key');
    expect(JSON.stringify(models)).not.toContain('MUAPI_API_KEY');
  });
});
