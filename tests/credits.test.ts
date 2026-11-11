import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), from: vi.fn(), storageRemove: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
    functions: { invoke: mocks.invoke },
    storage: { from: vi.fn(() => ({ remove: mocks.storageRemove })) },
  },
  STORAGE_BUCKET: 'ugc-assets',
  SITE_URL: 'http://localhost:5173',
}));

import {
  countAssets, createAvatar, createBrand, createPreset, createProduct, createProject, createPrompt, deleteAsset,
  deleteBrand, deleteProduct, estimateVideo, listAssets, listVideoModels,
  deleteAvatar, deletePreset, deleteProject, deletePrompt, deleteScript, newGenerationIdempotencyKey,
  startGeneration, listJobs, listLedger, updateAvatar, updateBrand, updatePreset, updateProduct, updateProfile, updateProject,
  updatePrompt, updateScript, updateWorkspace, saveScript,
} from '../src/lib/api';
import { humanizeError } from '../src/lib/errors';

const PROJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QUOTE_ID = '99999999-9999-4999-8999-999999999999';

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.invoke.mockReset();
  mocks.from.mockReset();
  mocks.storageRemove.mockReset();
});

describe('Réservation de crédits et idempotence (RPC mockés)', () => {
  it.each([
    ['projet', () => createProject({ title: 'Campagne' })],
    ['script', () => saveScript({ project_id: PROJECT_ID, script_text: 'Texte de script' })],
    ['génération', () => startGeneration(PROJECT_ID, 'ugc_clip_8s', { quote_id: QUOTE_ID })],
  ])('refuse une confirmation de création sans identifiant Supabase (%s)', async (_entity, operation) => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    await expect(operation()).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
  });

  it('transmet un identifiant d’idempotence stable pour une opération donnée', async () => {
    mocks.rpc.mockResolvedValue({ data: JOB_ID, error: null });
    const key = newGenerationIdempotencyKey();
    const id = await startGeneration(PROJECT_ID, 'ugc_clip_8s', {
      quote_id: QUOTE_ID, model_id: '11111111-1111-4111-8111-111111111112',
    }, key);
    expect(id).toBe(JOB_ID);
    expect(mocks.rpc).toHaveBeenCalledWith('reelora_start_generation', expect.objectContaining({
      p_project_id: PROJECT_ID, p_service_key: 'ugc_clip_8s', p_idempotency_key: key,
      p_quote_id: QUOTE_ID,
    }));
  });

  it('deux générations distinctes reçoivent deux identifiants différents (pas de double débit)', async () => {
    mocks.rpc.mockResolvedValue({ data: JOB_ID, error: null });
    const k1 = newGenerationIdempotencyKey();
    const k2 = newGenerationIdempotencyKey();
    expect(k1).not.toBe(k2);
    await startGeneration(PROJECT_ID, 'ugc_clip_8s', { quote_id: QUOTE_ID }, k1);
    await startGeneration(PROJECT_ID, 'ugc_clip_8s', { quote_id: QUOTE_ID }, k2);
    expect(mocks.rpc.mock.calls[0][1].p_idempotency_key).toBe(k1);
    expect(mocks.rpc.mock.calls[1][1].p_idempotency_key).toBe(k2);
  });

  it('un replay du même identifiant renvoie le même job (aucune réservation supplémentaire)', async () => {
    mocks.rpc.mockResolvedValue({ data: JOB_ID, error: null });
    const key = 'ugc-replay-0001';
    const first = await startGeneration(PROJECT_ID, 'ugc_clip_8s', { quote_id: QUOTE_ID }, key);
    const second = await startGeneration(PROJECT_ID, 'ugc_clip_8s', { quote_id: QUOTE_ID }, key);
    expect(first).toBe(second);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0][1]).toEqual(mocks.rpc.mock.calls[1][1]);
  });

  it('un solde insuffisant est refusé avec un message compréhensible', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'insufficient_credits', code: 'P0001' } });
    await expect(startGeneration(PROJECT_ID, 'ugc_clip_15s', { quote_id: QUOTE_ID })).rejects.toMatchObject({
      name: 'AppError', code: 'P0001',
      message: 'Crédits insuffisants. Rechargez votre solde depuis l’abonnement.',
    });
    expect(humanizeError('insufficient_credits')).toBe('Crédits insuffisants. Rechargez votre solde depuis l’abonnement.');
  });

  it('les erreurs MuAPI sont traduites en français pour l’utilisateur', () => {
    expect(humanizeError('MUAPI_NOT_CONFIGURED')).toContain('génération vidéo est indisponible');
    expect(humanizeError('IMAGE_MISSING')).toContain('image de référence');
    expect(humanizeError('SCRIPT_MISSING')).toContain('script');
    expect(humanizeError('timeout')).toContain('restitués');
  });
});

describe('Statistiques réelles du tableau de bord', () => {
  it('demande le compte exact des créations au lieu de compter seulement la liste paginée', async () => {
    const select = vi.fn().mockResolvedValue({ count: 19, error: null });
    mocks.from.mockReturnValue({ select });

    await expect(countAssets()).resolves.toBe(19);

    expect(mocks.from).toHaveBeenCalledWith('ugc_generated_assets');
    expect(select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
  });

  it('remonte une erreur Supabase au lieu de présenter une statistique non fiable', async () => {
    const select = vi.fn().mockResolvedValue({
      count: null,
      error: { message: 'permission denied', code: '42501' },
    });
    mocks.from.mockReturnValue({ select });

    await expect(countAssets()).rejects.toMatchObject({
      name: 'AppError',
      code: '42501',
    });
  });
});

describe('Pagination réelle de la bibliothèque', () => {
  it('demande une plage ordonnée à Supabase au lieu de tronquer l’historique', async () => {
    const range = vi.fn().mockResolvedValue({ data: [], error: null });
    const order = vi.fn(() => ({ range }));
    const select = vi.fn(() => ({ order }));
    mocks.from.mockReturnValue({ select });

    await expect(listAssets(24, 48)).resolves.toEqual([]);

    expect(mocks.from).toHaveBeenCalledWith('ugc_generated_assets');
    expect(select).toHaveBeenCalledWith('*');
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(range).toHaveBeenCalledWith(48, 71);
  });

  it('normalise des limites négatives sans produire de plage invalide', async () => {
    const range = vi.fn().mockResolvedValue({ data: [], error: null });
    mocks.from.mockReturnValue({
      select: vi.fn(() => ({ order: vi.fn(() => ({ range })) })),
    });

    await listAssets(-3, -10);

    expect(range).toHaveBeenCalledWith(0, 0);
  });
});

describe('Pagination réelle de l’historique', () => {
  it('filtre les générations côté Supabase et demande la plage correspondante', async () => {
    const range = vi.fn().mockResolvedValue({ data: [], error: null });
    const eq = vi.fn(() => ({ range }));
    const order = vi.fn(() => ({ eq }));
    const select = vi.fn(() => ({ order }));
    mocks.from.mockReturnValue({ select });

    await expect(listJobs(51, 50, 'failed')).resolves.toEqual([]);

    expect(mocks.from).toHaveBeenCalledWith('ugc_generation_jobs');
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(eq).toHaveBeenCalledWith('status', 'failed');
    expect(range).toHaveBeenCalledWith(50, 100);
  });

  it('limite les générations chargées aux identifiants du projet demandé', async () => {
    const range = vi.fn().mockResolvedValue({ data: [], error: null });
    const eq = vi.fn(() => ({ range }));
    const order = vi.fn(() => ({ eq }));
    const select = vi.fn(() => ({ order }));
    mocks.from.mockReturnValue({ select });

    await expect(listJobs(200, 0, undefined, PROJECT_ID)).resolves.toEqual([]);

    expect(eq).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(range).toHaveBeenCalledWith(0, 199);
  });

  it('charge les mouvements de crédits par plage ordonnée', async () => {
    const range = vi.fn().mockResolvedValue({ data: [], error: null });
    const order = vi.fn(() => ({ range }));
    const select = vi.fn(() => ({ order }));
    mocks.from.mockReturnValue({ select });

    await expect(listLedger(51, 50)).resolves.toEqual([]);

    expect(mocks.from).toHaveBeenCalledWith('ugc_credit_ledger');
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(range).toHaveBeenCalledWith(50, 100);
  });
});

describe('Mise à jour des catalogues métier', () => {
  it('met à jour une marque via une requête filtrée par identifiant et vérifie le retour Supabase', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'brand-1' }, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eq = vi.fn().mockReturnValue({ select });
    const update = vi.fn().mockReturnValue({ eq });
    mocks.from.mockReturnValue({ update });

    await updateBrand('brand-1', { name: 'Marque modifiée', voice_guidelines: 'Ton concis' });

    expect(mocks.from).toHaveBeenCalledWith('ugc_brands');
    expect(update).toHaveBeenCalledWith({ name: 'Marque modifiée', voice_guidelines: 'Ton concis' });
    expect(eq).toHaveBeenCalledWith('id', 'brand-1');
    expect(select).toHaveBeenCalledWith('id');
  });

  it('refuse de confirmer une marque inaccessible ou absente', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eq = vi.fn().mockReturnValue({ select });
    mocks.from.mockReturnValue({ update: vi.fn().mockReturnValue({ eq }) });

    await expect(updateBrand('private-brand', { name: 'Tentative' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('persiste les champs métier du produit sans contourner les règles RLS', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'product-1' }, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eq = vi.fn().mockReturnValue({ select });
    const update = vi.fn().mockReturnValue({ eq });
    mocks.from.mockReturnValue({ update });

    await updateProduct('product-1', {
      name: 'Sérum amélioré',
      key_benefits: ['Hydrate', 'Protège'],
      price_amount: 12900,
      price_currency: 'XOF',
    });

    expect(mocks.from).toHaveBeenCalledWith('ugc_products');
    expect(update).toHaveBeenCalledWith({
      name: 'Sérum amélioré',
      key_benefits: ['Hydrate', 'Protège'],
      price_amount: 12900,
      price_currency: 'XOF',
    });
    expect(eq).toHaveBeenCalledWith('id', 'product-1');
  });
});

describe('Persistance vérifiée du compte et de l’espace Reelora', () => {
  it('vérifie que la mise à jour du profil a affecté le profil authentifié', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { user_id: 'user-1' }, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ update });

    await updateProfile('user-1', { display_name: 'Nouveau nom' });

    expect(mocks.from).toHaveBeenCalledWith('ugc_profiles');
    expect(update).toHaveBeenCalledWith({ display_name: 'Nouveau nom' });
    expect(eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(select).toHaveBeenCalledWith('user_id');
  });

  it('ne confirme pas la mise à jour d’un profil absent ou inaccessible', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ update: vi.fn(() => ({ eq })) });

    await expect(updateProfile('private-user', { display_name: 'Tentative' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('vérifie que la mise à jour de l’espace de travail a affecté la ligne demandée', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'workspace-1' }, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ update });

    await updateWorkspace('workspace-1', { name: 'Espace actualisé' });

    expect(mocks.from).toHaveBeenCalledWith('ugc_workspaces');
    expect(update).toHaveBeenCalledWith({ name: 'Espace actualisé' });
    expect(eq).toHaveBeenCalledWith('id', 'workspace-1');
    expect(select).toHaveBeenCalledWith('id');
  });

  it('ne confirme pas la mise à jour d’un espace inaccessible', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ update: vi.fn(() => ({ eq })) });

    await expect(updateWorkspace('private-workspace', { name: 'Tentative' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('Persistance vérifiée des projets et scripts Studio', () => {
  it('vérifie la ligne renvoyée après la mise à jour d’un projet', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'project-1' }, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ update });

    await updateProject('project-1', { title: 'Campagne mise à jour' });

    expect(mocks.from).toHaveBeenCalledWith('ugc_video_projects');
    expect(update).toHaveBeenCalledWith({ title: 'Campagne mise à jour' });
    expect(eq).toHaveBeenCalledWith('id', 'project-1');
    expect(select).toHaveBeenCalledWith('id');
  });

  it('remonte une erreur au lieu de confirmer un projet absent ou inaccessible', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ update: vi.fn(() => ({ eq })) });

    await expect(updateProject('private-project', { title: 'Tentative' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('vérifie la suppression effective d’un projet', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'project-1' }, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ delete: vi.fn(() => ({ eq })) });

    await deleteProject('project-1');

    expect(mocks.from).toHaveBeenCalledWith('ugc_video_projects');
    expect(eq).toHaveBeenCalledWith('id', 'project-1');
    expect(select).toHaveBeenCalledWith('id');
  });

  it('ne confirme pas la suppression d’un projet inaccessible', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ delete: vi.fn(() => ({ eq })) });

    await expect(deleteProject('private-project')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('vérifie les modifications et suppressions de scripts avant de retourner', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'script-1' }, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ update });

    await updateScript('script-1', { script_text: 'Texte mis à jour' });

    expect(mocks.from).toHaveBeenCalledWith('ugc_project_scripts');
    expect(update).toHaveBeenCalledWith({ script_text: 'Texte mis à jour' });
    expect(eq).toHaveBeenCalledWith('id', 'script-1');
    expect(select).toHaveBeenCalledWith('id');

    const deleteMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const deleteSelect = vi.fn(() => ({ maybeSingle: deleteMaybeSingle }));
    const deleteEq = vi.fn(() => ({ select: deleteSelect }));
    mocks.from.mockReturnValue({ delete: vi.fn(() => ({ eq: deleteEq })) });

    await expect(deleteScript('script-missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.from).toHaveBeenLastCalledWith('ugc_project_scripts');
  });
});

describe('Suppression vérifiée des entrées du catalogue', () => {
  it.each([
    ['ugc_brands', deleteBrand, 'Marque introuvable ou inaccessible.'],
    ['ugc_products', deleteProduct, 'Produit introuvable ou inaccessible.'],
  ] as const)('ne confirme pas la suppression si %s ne retourne aucune ligne', async (table, remove, message) => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    const deleteQuery = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ delete: deleteQuery });

    await expect(remove('missing-entry')).rejects.toMatchObject({ code: 'NOT_FOUND', message });

    expect(mocks.from).toHaveBeenCalledWith(table);
    expect(eq).toHaveBeenCalledWith('id', 'missing-entry');
    expect(select).toHaveBeenCalledWith('id');
  });
});

describe('Écritures vérifiées des autres modules Studio', () => {
  it.each([
    ['marque', () => createBrand({ workspace_id: 'workspace-1', name: 'Marque' })],
    ['produit', () => createProduct({ workspace_id: 'workspace-1', name: 'Produit' })],
    ['avatar', () => createAvatar({ workspace_id: 'workspace-1', created_by: 'user-1', name: 'Avatar' })],
    ['prompt', () => createPrompt({ workspace_id: 'workspace-1', created_by: 'user-1', title: 'Prompt', content: 'Texte' })],
    ['réglage vidéo', () => createPreset({ workspace_id: 'workspace-1', created_by: 'user-1', name: 'Réglage' })],
  ])('refuse de confirmer une création si Supabase ne retourne pas la ligne (%s)', async (_entity, create) => {
    const select = vi.fn().mockResolvedValue({ data: [], error: null });
    const insert = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ insert });

    await expect(create()).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
    expect(insert).toHaveBeenCalledOnce();
  });

  it.each([
    ['avatar', (id: string) => updateAvatar(id, { name: 'Nom' })],
    ['prompt', (id: string) => updatePrompt(id, { title: 'Titre' })],
    ['réglage vidéo', (id: string) => updatePreset(id, { name: 'Nom' })],
  ])('refuse de confirmer une mise à jour sans ligne affectée (%s)', async (_entity, update) => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ update: vi.fn(() => ({ eq })) });

    await expect(update('missing-entry')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['avatar', deleteAvatar],
    ['prompt', deletePrompt],
    ['réglage vidéo', deletePreset],
  ])('refuse de confirmer une suppression sans ligne retournée (%s)', async (_entity, remove) => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ delete: vi.fn(() => ({ eq })) });

    await expect(remove('missing-entry')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('Suppression des créations privées', () => {
  it('supprime le fichier avec le chemin RLS lu depuis Supabase puis vérifie la suppression de la fiche', async () => {
    const lookupMaybeSingle = vi.fn().mockResolvedValue({
      data: { storage_path: 'workspace-a/assets/video.mp4' }, error: null,
    });
    const deleteMaybeSingle = vi.fn().mockResolvedValue({ data: { id: 'asset-1' }, error: null });
    const deleteSelect = vi.fn(() => ({ maybeSingle: deleteMaybeSingle }));
    const deleteEq = vi.fn(() => ({ select: deleteSelect }));
    const deleteCall = vi.fn(() => ({ eq: deleteEq }));
    mocks.from.mockImplementationOnce(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: lookupMaybeSingle })) })),
    })).mockImplementationOnce(() => ({
      delete: deleteCall,
    }));
    mocks.storageRemove.mockResolvedValue({ data: [{ name: 'video.mp4' }], error: null });

    await deleteAsset('asset-1', 'untrusted/other-user.mp4');

    expect(mocks.storageRemove).toHaveBeenCalledWith(['workspace-a/assets/video.mp4']);
    expect(mocks.from).toHaveBeenCalledTimes(2);
    expect(deleteCall).toHaveBeenCalled();
    expect(deleteEq).toHaveBeenCalledWith('id', 'asset-1');
    expect(deleteSelect).toHaveBeenCalledWith('id');
  });

  it('préserve la fiche et remonte une erreur si Storage refuse la suppression', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { storage_path: 'workspace-a/assets/video.mp4' }, error: null });
    mocks.from.mockReturnValue({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
    });
    mocks.storageRemove.mockResolvedValue({
      data: null,
      error: { message: 'storage permission denied', code: '42501' },
    });

    await expect(deleteAsset('asset-1')).rejects.toMatchObject({
      code: 'STORAGE_DELETE_ERROR',
      message: 'storage permission denied',
    });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it('ne confirme pas une suppression si la fiche est inaccessible', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    mocks.from.mockReturnValue({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
    });

    await expect(deleteAsset('asset-other-user')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.storageRemove).not.toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledTimes(1);
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
