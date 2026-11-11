import { supabase, STORAGE_BUCKET, SITE_URL } from './supabase';
import { AppError, humanizeError } from './errors';
import type {
  AdminOverview, AdminUser, AiScene, AiScriptResult, AppNotification, Avatar, Brand,
  GeneratedAsset, GenerationJob, GenerationPreset, Json, LedgerEntry, MuApiModel, Plan, Product,
  Profile, Project, PromptTemplate, QuotaStatus, RechargeOrder, Scene, Script,
  ServiceCatalogItem, Subscription, VideoActionResult, VideoCatalogResponse, VideoCostEstimate,
  Workspace, WorkspaceMember, MuApiParamDef,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = { data: any; error: any };

async function unwrap<T>(promise: PromiseLike<AnyResult>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new AppError(humanizeError(error.message), error.code ?? 'DB_ERROR');
  return data as T;
}

function requireInserted<T>(rows: T[], entity: string): T {
  const row = rows[0];
  if (!row) throw new AppError(`Supabase n’a pas confirmé la création de ${entity}.`, 'PERSISTENCE_ERROR');
  return row;
}

function requireId(value: unknown, entity: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`Supabase n’a pas retourné l’identifiant du ${entity}.`, 'PERSISTENCE_ERROR');
  }
  return value;
}

export async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return unwrap<T>((supabase.rpc as any)(name, args));
}

async function invokeEdge<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let payload: { error?: { code?: string; message?: string } } | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const context = (error as any).context as Response | undefined;
      if (context?.json) payload = await context.json();
    } catch { /* response was not JSON */ }
    throw new AppError(
      payload?.error?.message || humanizeError(error.message),
      payload?.error?.code || 'EDGE_ERROR',
    );
  }
  return data as T;
}

/* -------------------------------------------------------------------------- */
/* Authentication & bootstrap                                                 */
/* -------------------------------------------------------------------------- */

export async function bootstrap(): Promise<{
  user_id: string; workspace_id: string; plan: string; credits: number; is_admin: boolean;
}> {
  return rpc('reelora_bootstrap');
}

export async function getQuota(): Promise<QuotaStatus> {
  return rpc('reelora_quota_status');
}

export async function getProfile(userId: string): Promise<Profile | null> {
  return unwrap<Profile | null>(
    supabase.from('ugc_profiles').select('*').eq('user_id', userId).maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
}

export async function updateProfile(userId: string, patch: Partial<Pick<Profile, 'display_name' | 'country_code' | 'preferred_language'>>) {
  const updated = await unwrap<{ user_id: string } | null>(
    supabase.from('ugc_profiles').update(patch).eq('user_id', userId).select('user_id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!updated) throw new AppError('Profil introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function getWorkspaces(): Promise<Workspace[]> {
  return unwrap<Workspace[]>(supabase.from('ugc_workspaces').select('*').order('created_at') as unknown as PromiseLike<AnyResult>);
}

export async function updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'name' | 'default_language' | 'country_code'>>) {
  const updated = await unwrap<{ id: string } | null>(
    supabase.from('ugc_workspaces').update(patch).eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!updated) throw new AppError('Espace de travail introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function getMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  return unwrap<WorkspaceMember[]>(
    supabase.from('ugc_workspace_members').select('*').eq('workspace_id', workspaceId).order('created_at') as unknown as PromiseLike<AnyResult>,
  );
}

export async function signUp(email: string, password: string, fullName: string) {
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { full_name: fullName }, emailRedirectTo: `${SITE_URL}/auth/callback` },
  });
  if (error) throw new AppError(humanizeError(error.message), 'SIGNUP_ERROR');
  return data;
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new AppError(humanizeError(error.message), 'SIGNIN_ERROR');
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new AppError(humanizeError(error.message), 'SIGNOUT_ERROR');
}

export async function sendPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${SITE_URL}/auth/callback?next=/app/parametres` });
  if (error) throw new AppError(humanizeError(error.message), 'RESET_ERROR');
}

export async function updatePassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw new AppError(humanizeError(error.message), 'PASSWORD_ERROR');
}

export async function updateEmail(email: string) {
  const { error } = await supabase.auth.updateUser({ email });
  if (error) throw new AppError(humanizeError(error.message), 'EMAIL_ERROR');
}

/* -------------------------------------------------------------------------- */
/* Projects, scripts, scenes, brands, products                                 */
/* -------------------------------------------------------------------------- */

export interface ProjectFilters { status?: string; search?: string }

export async function listProjects(filters: ProjectFilters = {}, limit = 200, offset = 0): Promise<Project[]> {
  const pageSize = Math.max(1, Math.floor(limit));
  const start = Math.max(0, Math.floor(offset));
  let q = supabase.from('ugc_video_projects').select('*').order('updated_at', { ascending: false });
  if (filters.status && filters.status !== 'all') q = q.eq('status', filters.status);
  if (filters.search) q = q.ilike('title', `%${filters.search}%`);
  q = q.range(start, start + pageSize - 1);
  return unwrap<Project[]>(q as unknown as PromiseLike<AnyResult>);
}

export async function createProject(input: {
  title: string; brief?: string; platform?: string; language?: string; aspect_ratio?: string;
  campaign_objective?: string; target_audience?: string; target_market?: string; settings?: Json;
}): Promise<string> {
  const id = await rpc<unknown>('reelora_create_project', {
    p_title: input.title,
    p_brief: input.brief || null,
    p_platform: input.platform || 'TikTok',
    p_language: input.language || 'fr',
    p_aspect_ratio: input.aspect_ratio || '9:16',
    p_campaign_objective: input.campaign_objective || null,
    p_target_audience: input.target_audience || null,
    p_target_market: input.target_market || null,
    p_settings: input.settings || {},
  });
  return requireId(id, 'projet');
}

export async function getProject(id: string): Promise<Project | null> {
  return unwrap<Project | null>(
    supabase.from('ugc_video_projects').select('*').eq('id', id).maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
}

export async function updateProject(id: string, patch: Partial<Project>) {
  const updated = await unwrap<{ id: string } | null>(
    supabase.from('ugc_video_projects').update(patch).eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!updated) throw new AppError('Projet introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function deleteProject(id: string) {
  const deleted = await unwrap<{ id: string } | null>(
    supabase.from('ugc_video_projects').delete().eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!deleted) throw new AppError('Projet introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function listScripts(projectId?: string, limit = 200, offset = 0): Promise<Script[]> {
  const pageSize = Math.max(1, Math.floor(limit));
  const start = Math.max(0, Math.floor(offset));
  let q = supabase.from('ugc_project_scripts').select('*').order('created_at', { ascending: false });
  if (projectId) q = q.eq('project_id', projectId);
  q = q.range(start, start + pageSize - 1);
  return unwrap<Script[]>(q as unknown as PromiseLike<AnyResult>);
}

export async function saveScript(input: {
  project_id: string; script_text: string; hook?: string; call_to_action?: string;
  marketing_angle?: string; language?: string; claims_to_avoid?: string[];
}): Promise<string> {
  const id = await rpc<unknown>('reelora_save_script', {
    p_project_id: input.project_id,
    p_script_text: input.script_text,
    p_hook: input.hook || '',
    p_call_to_action: input.call_to_action || '',
    p_marketing_angle: input.marketing_angle || null,
    p_language: input.language || 'fr',
    p_claims_to_avoid: input.claims_to_avoid || [],
  });
  return requireId(id, 'script');
}

export async function updateScript(id: string, patch: Partial<Script>) {
  const updated = await unwrap<{ id: string } | null>(
    supabase.from('ugc_project_scripts').update(patch).eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!updated) throw new AppError('Script introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function deleteScript(id: string) {
  const deleted = await unwrap<{ id: string } | null>(
    supabase.from('ugc_project_scripts').delete().eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!deleted) throw new AppError('Script introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function listScenes(projectId?: string): Promise<Scene[]> {
  let q = supabase.from('ugc_project_scenes').select('*').order('scene_order').limit(200);
  if (projectId) q = q.eq('project_id', projectId);
  return unwrap<Scene[]>(q as unknown as PromiseLike<AnyResult>);
}

export async function saveScenes(projectId: string, scenes: AiScene[], scriptId: string | null = null): Promise<number> {
  return rpc<number>('reelora_save_scenes', { p_project_id: projectId, p_script_id: scriptId, p_scenes: scenes });
}

export async function listBrands(workspaceId: string): Promise<Brand[]> {
  return unwrap<Brand[]>(
    supabase.from('ugc_brands').select('*').eq('workspace_id', workspaceId).order('name') as unknown as PromiseLike<AnyResult>,
  );
}

export async function createBrand(input: Partial<Brand> & { workspace_id: string; name: string }): Promise<Brand> {
  const data = await unwrap<Brand[]>(
    supabase.from('ugc_brands').insert(input).select() as unknown as PromiseLike<AnyResult>,
  );
  return requireInserted(data, 'la marque');
}

export async function updateBrand(
  id: string,
  patch: Partial<Pick<Brand, 'name' | 'website_url' | 'industry' | 'description' | 'brand_colors' | 'voice_guidelines'>>,
): Promise<void> {
  const updated = await unwrap<{ id: string } | null>(
    supabase.from('ugc_brands').update(patch).eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!updated) throw new AppError('Marque introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function deleteBrand(id: string) {
  const deleted = await unwrap<{ id: string } | null>(
    supabase.from('ugc_brands').delete().eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!deleted) throw new AppError('Marque introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function listProducts(workspaceId: string): Promise<Product[]> {
  return unwrap<Product[]>(
    supabase.from('ugc_products').select('*').eq('workspace_id', workspaceId).order('name') as unknown as PromiseLike<AnyResult>,
  );
}

export async function createProduct(input: Partial<Product> & { workspace_id: string; name: string }): Promise<Product> {
  const data = await unwrap<Product[]>(
    supabase.from('ugc_products').insert(input).select() as unknown as PromiseLike<AnyResult>,
  );
  return requireInserted(data, 'le produit');
}

export async function updateProduct(
  id: string,
  patch: Partial<Pick<Product, 'name' | 'description' | 'key_benefits' | 'features' | 'price_amount' | 'price_currency' | 'product_url' | 'product_facts'>>,
): Promise<void> {
  const updated = await unwrap<{ id: string } | null>(
    supabase.from('ugc_products').update(patch).eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!updated) throw new AppError('Produit introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function deleteProduct(id: string) {
  const deleted = await unwrap<{ id: string } | null>(
    supabase.from('ugc_products').delete().eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!deleted) throw new AppError('Produit introuvable ou inaccessible.', 'NOT_FOUND');
}

/* -------------------------------------------------------------------------- */
/* Avatars                                                                    */
/* -------------------------------------------------------------------------- */

export async function listAvatars(workspaceId: string): Promise<Avatar[]> {
  return unwrap<Avatar[]>(
    supabase.from('reelora_avatars').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }) as unknown as PromiseLike<AnyResult>,
  );
}

export async function createAvatar(input: Partial<Avatar> & { workspace_id: string; created_by: string; name: string }): Promise<Avatar> {
  const data = await unwrap<Avatar[]>(
    supabase.from('reelora_avatars').insert(input).select() as unknown as PromiseLike<AnyResult>,
  );
  return requireInserted(data, 'l’avatar');
}

export async function updateAvatar(id: string, patch: Partial<Avatar>) {
  const updated = await unwrap<{ id: string } | null>(
    supabase.from('reelora_avatars').update(patch).eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!updated) throw new AppError('Avatar introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function deleteAvatar(id: string) {
  const deleted = await unwrap<{ id: string } | null>(
    supabase.from('reelora_avatars').delete().eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!deleted) throw new AppError('Avatar introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function uploadAvatarPreview(workspaceId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
  const path = `${workspaceId}/avatars/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, { contentType: file.type, upsert: true });
  if (error) throw new AppError(humanizeError(error.message), 'STORAGE_ERROR');
  return path;
}

/**
 * Upload a Video Studio reference image into the SAME private bucket and
 * workspace prefix. The Edge Function signs this path server-side at submit
 * time; no public URL is created and no provider key reaches the browser.
 */
export async function uploadReferenceImage(workspaceId: string, file: File): Promise<string> {
  const ext = (file.name.split('.').pop()?.toLowerCase() || 'png').replace(/[^a-z0-9]/g, '') || 'png';
  const path = `${workspaceId}/references/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new AppError(humanizeError(error.message), 'STORAGE_ERROR');
  return path;
}

/**
 * Upload an editor-imported video/audio clip into the same private Storage
 * bucket. Signed URLs are created on demand; no public URL is exposed.
 */
export async function uploadEditorMedia(workspaceId: string, file: File): Promise<string> {
  const ext = (file.name.split('.').pop()?.toLowerCase() || 'mp4').replace(/[^a-z0-9]/g, '') || 'mp4';
  const path = `${workspaceId}/editor/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new AppError(humanizeError(error.message), 'STORAGE_ERROR');
  return path;
}

/** Attach an already-generated asset to one of the user's projects (RLS-checked RPC). */
export async function attachAssetToProject(assetId: string, projectId: string): Promise<boolean> {
  return rpc<boolean>('reelora_attach_asset_to_project', { p_asset_id: assetId, p_project_id: projectId });
}

export async function signedStorageUrl(path: string, expires = 3600): Promise<string> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(path, expires);
  if (error) throw new AppError(humanizeError(error.message), 'STORAGE_ERROR');
  return data.signedUrl;
}

/* -------------------------------------------------------------------------- */
/* Prompts & presets                                                           */
/* -------------------------------------------------------------------------- */

export async function listPrompts(
  category?: PromptTemplate['category'],
  limit = 300,
  offset = 0,
): Promise<PromptTemplate[]> {
  const pageSize = Math.max(1, Math.floor(limit));
  const start = Math.max(0, Math.floor(offset));
  let q = supabase.from('reelora_prompt_templates')
    .select('*')
    .order('is_system', { ascending: false })
    .order('created_at', { ascending: false });
  if (category) q = q.eq('category', category);
  q = q.range(start, start + pageSize - 1);
  return unwrap<PromptTemplate[]>(
    q as unknown as PromiseLike<AnyResult>,
  );
}

export async function createPrompt(input: Partial<PromptTemplate> & { workspace_id: string; created_by: string; title: string; content: string }): Promise<PromptTemplate> {
  const data = await unwrap<PromptTemplate[]>(
    supabase.from('reelora_prompt_templates').insert(input).select() as unknown as PromiseLike<AnyResult>,
  );
  return requireInserted(data, 'le prompt');
}

export async function updatePrompt(id: string, patch: Partial<PromptTemplate>) {
  const updated = await unwrap<{ id: string } | null>(
    supabase.from('reelora_prompt_templates').update(patch).eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!updated) throw new AppError('Prompt introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function deletePrompt(id: string) {
  const deleted = await unwrap<{ id: string } | null>(
    supabase.from('reelora_prompt_templates').delete().eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!deleted) throw new AppError('Prompt introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function listPresets(workspaceId: string): Promise<GenerationPreset[]> {
  return unwrap<GenerationPreset[]>(
    supabase.from('reelora_generation_presets').select('*').eq('workspace_id', workspaceId).order('created_at') as unknown as PromiseLike<AnyResult>,
  );
}

export async function createPreset(input: Partial<GenerationPreset> & { workspace_id: string; created_by: string; name: string }): Promise<GenerationPreset> {
  const data = await unwrap<GenerationPreset[]>(
    supabase.from('reelora_generation_presets').insert(input).select() as unknown as PromiseLike<AnyResult>,
  );
  return requireInserted(data, 'le réglage vidéo');
}

export async function updatePreset(id: string, patch: Partial<GenerationPreset>) {
  const updated = await unwrap<{ id: string } | null>(
    supabase.from('reelora_generation_presets').update(patch).eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!updated) throw new AppError('Réglage introuvable ou inaccessible.', 'NOT_FOUND');
}

export async function deletePreset(id: string) {
  const deleted = await unwrap<{ id: string } | null>(
    supabase.from('reelora_generation_presets').delete().eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!deleted) throw new AppError('Réglage introuvable ou inaccessible.', 'NOT_FOUND');
}

/* -------------------------------------------------------------------------- */
/* Generation jobs, assets, history                                            */
/* -------------------------------------------------------------------------- */

export async function listServices(): Promise<ServiceCatalogItem[]> {
  return unwrap<ServiceCatalogItem[]>(
    supabase.from('ugc_service_catalog').select('*').order('credits_cost') as unknown as PromiseLike<AnyResult>,
  );
}

/**
 * Reserve credits + create the job atomically. `idempotencyKey` is unique PER
 * GENERATION OPERATION: replaying it (double click, retry, refreshed page)
 * returns the SAME job and never creates a second reservation or debit.
 */
export async function startGeneration(
  projectId: string, serviceKey: string, payload: Json, idempotencyKey?: string,
): Promise<string> {
  const id = await rpc<unknown>('reelora_start_generation', {
    p_project_id: projectId, p_service_key: serviceKey, p_payload: payload,
    p_idempotency_key: idempotencyKey ?? null,
  });
  return requireId(id, 'job de génération');
}

/** Full live MuAPI video catalogue with explicit public/account diagnostics. */
export function getVideoCatalog(): Promise<VideoCatalogResponse> {
  return invokeEdge<VideoCatalogResponse>('reelora-video', { action: 'catalog' });
}

/** Verified MuAPI video models (kept for the classical Studio and existing tests). */
export async function listVideoModels(): Promise<MuApiModel[]> {
  const result = await invokeEdge<{ models: MuApiModel[] }>('reelora-video', { action: 'models' });
  return result.models ?? [];
}

/** Full input_schema of one real model, fetched by the server with its own key. */
export function getVideoModelDetail(modelId: string): Promise<{ model: MuApiModel }> {
  return invokeEdge<{ model: MuApiModel }>('reelora-video', { action: 'model-detail', model_id: modelId });
}

export interface VideoQuoteInput {
  params?: Record<string, string | number | boolean>;
  prompt?: string;
  image_url?: string;
  last_image_url?: string;
  /** Real schema fetched by model-detail; the server still validates every key. */
  param_schema?: Record<string, MuApiParamDef>;
}

/**
 * Server-side quote shown BEFORE confirmation. When `quote` is supplied the
 * backend may call MuAPI's non-generating estimate-cost endpoint to obtain the
 * exact USD price for these exact parameters. No inference or media is created.
 */
export function estimateVideo(serviceKey: string, modelId: string, quote?: VideoQuoteInput): Promise<VideoCostEstimate> {
  const body: Record<string, unknown> = { action: 'estimate', service_key: serviceKey, model_id: modelId };
  if (quote?.params) body.params = quote.params;
  if (quote?.prompt) body.prompt = quote.prompt;
  if (quote?.image_url) body.image_url = quote.image_url;
  if (quote?.last_image_url) body.last_image_url = quote.last_image_url;
  if (quote?.param_schema) body.param_schema = quote.param_schema;
  return invokeEdge<VideoCostEstimate>('reelora-video', body);
}

export async function cancelGeneration(jobId: string): Promise<boolean> {
  return rpc<boolean>('reelora_cancel_generation', { p_job_id: jobId });
}

export function videoStart(jobId: string): Promise<VideoActionResult> {
  return invokeEdge<VideoActionResult>('reelora-video', { action: 'start', job_id: jobId });
}

export function videoStatus(jobId: string): Promise<VideoActionResult> {
  return invokeEdge<VideoActionResult>('reelora-video', { action: 'status', job_id: jobId });
}

export async function listJobs(
  limit = 100,
  offset = 0,
  status?: GenerationJob['status'],
  projectId?: string,
): Promise<GenerationJob[]> {
  const start = Math.max(0, Math.floor(offset));
  const pageSize = Math.max(1, Math.floor(limit));
  let query = supabase.from('ugc_generation_jobs').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  if (projectId) query = query.eq('project_id', projectId);
  return unwrap<GenerationJob[]>(
    query.range(start, start + pageSize - 1) as unknown as PromiseLike<AnyResult>,
  );
}

/** RLS-scoped single job lookup for deep links and "reuse these parameters". */
export async function getJob(id: string): Promise<GenerationJob | null> {
  return unwrap<GenerationJob | null>(
    supabase.from('ugc_generation_jobs').select('*').eq('id', id).maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
}

export async function listJobEvents(jobId: string) {
  return unwrap<{ id: string; event_type: string; from_status: string | null; to_status: string | null; created_at: string }[]>(
    supabase.from('ugc_job_events').select('*').eq('generation_job_id', jobId).order('created_at') as unknown as PromiseLike<AnyResult>,
  );
}

export async function listAssets(limit = 200, offset = 0): Promise<GeneratedAsset[]> {
  const start = Math.max(0, Math.floor(offset));
  const pageSize = Math.max(1, Math.floor(limit));
  return unwrap<GeneratedAsset[]>(
    supabase.from('ugc_generated_assets')
      .select('*')
      .order('created_at', { ascending: false })
      .range(start, start + pageSize - 1) as unknown as PromiseLike<AnyResult>,
  );
}

export async function countAssets(): Promise<number> {
  const { count, error } = await supabase
    .from('ugc_generated_assets')
    .select('id', { count: 'exact', head: true });
  if (error) throw new AppError(humanizeError(error.message), error.code ?? 'DB_ERROR');
  if (count === null) throw new AppError('Impossible de compter les créations enregistrées.', 'DB_COUNT_ERROR');
  return count;
}

export async function deleteAsset(id: string, _path?: string): Promise<void> {
  const asset = await unwrap<Pick<GeneratedAsset, 'storage_path'> | null>(
    supabase.from('ugc_generated_assets').select('storage_path').eq('id', id).maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!asset) throw new AppError('Création introuvable ou inaccessible.', 'NOT_FOUND');

  if (asset.storage_path) {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([asset.storage_path]);
    if (error) throw new AppError(humanizeError(error.message), 'STORAGE_DELETE_ERROR');
  }

  const deleted = await unwrap<{ id: string } | null>(
    supabase.from('ugc_generated_assets').delete().eq('id', id).select('id').maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
  if (!deleted) throw new AppError('La création n’a pas pu être supprimée ou n’est plus accessible.', 'DELETE_FAILED');
}

export async function listLedger(limit = 100, offset = 0): Promise<LedgerEntry[]> {
  const start = Math.max(0, Math.floor(offset));
  const pageSize = Math.max(1, Math.floor(limit));
  return unwrap<LedgerEntry[]>(
    supabase.from('ugc_credit_ledger').select('*').order('created_at', { ascending: false })
      .range(start, start + pageSize - 1) as unknown as PromiseLike<AnyResult>,
  );
}

/* -------------------------------------------------------------------------- */
/* Subscription, credits, plans                                                */
/* -------------------------------------------------------------------------- */

export async function listPlans(): Promise<Plan[]> {
  return unwrap<Plan[]>(supabase.from('reelora_plans').select('*').eq('active', true).order('sort_order') as unknown as PromiseLike<AnyResult>);
}

export async function getSubscription(userId: string): Promise<Subscription | null> {
  return unwrap<Subscription | null>(
    supabase.from('reelora_subscriptions').select('*').eq('user_id', userId).maybeSingle() as unknown as PromiseLike<AnyResult>,
  );
}

export async function requestPlanChange(planKey: string): Promise<number> {
  return rpc<number>('reelora_request_plan_change', { p_plan_key: planKey });
}

export async function createRecharge(amountMinor: number, countryCode = 'ML'): Promise<string> {
  return rpc<string>('ugc_create_recharge_order', {
    p_amount_minor: amountMinor,
    p_country_code: countryCode,
    p_provider: 'manual',
    p_idempotency_key: `reelora-${crypto.randomUUID()}`,
  });
}

export async function listRecharges(): Promise<RechargeOrder[]> {
  return unwrap<RechargeOrder[]>(
    supabase.from('ugc_recharge_orders').select('*').order('created_at', { ascending: false }).limit(100) as unknown as PromiseLike<AnyResult>,
  );
}

export async function redeemPromo(code: string): Promise<string> {
  return rpc<string>('ugc_redeem_promo_code', { p_code: code });
}

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

export async function listNotifications(limit = 50): Promise<AppNotification[]> {
  return unwrap<AppNotification[]>(
    supabase.from('reelora_notifications').select('*').order('created_at', { ascending: false }).limit(limit) as unknown as PromiseLike<AnyResult>,
  );
}

export async function markNotificationRead(id: string) {
  return rpc<boolean>('reelora_mark_notification_read', { p_id: id });
}

export async function markAllNotificationsRead() {
  return rpc<number>('reelora_mark_all_notifications_read');
}

/* -------------------------------------------------------------------------- */
/* Administration                                                             */
/* -------------------------------------------------------------------------- */

export async function adminOverview(): Promise<AdminOverview> {
  return rpc<AdminOverview>('reelora_admin_overview');
}

export async function adminListUsers(): Promise<AdminUser[]> {
  return rpc<AdminUser[]>('reelora_admin_list_users');
}

export async function adminSetRole(userId: string, role: 'admin' | 'user') {
  return rpc<boolean>('reelora_admin_set_role', { p_user_id: userId, p_role: role });
}

export async function adminSetPlan(userId: string, planKey: string) {
  return rpc<boolean>('reelora_admin_set_plan', { p_user_id: userId, p_plan_key: planKey });
}

export async function adminSetAccountStatus(userId: string, status: 'active' | 'suspended' | 'cancelled') {
  return rpc<boolean>('reelora_admin_set_account_status', { p_user_id: userId, p_status: status });
}

export async function adminAdjustCredits(userId: string, delta: number, reason: string) {
  return rpc<number>('reelora_admin_adjust_credits', { p_user_id: userId, p_delta: delta, p_reason: reason });
}

export async function adminConfirmRecharge(orderId: string, reference?: string) {
  return rpc<boolean>('reelora_admin_confirm_recharge', { p_order_id: orderId, p_provider_reference: reference || null });
}

export async function adminUpdateService(serviceKey: string, creditsCost: number, active: boolean) {
  return rpc<boolean>('reelora_admin_update_service', { p_service_key: serviceKey, p_credits_cost: creditsCost, p_active: active });
}

export async function adminSetSetting(key: string, value: Json) {
  return rpc<boolean>('reelora_admin_set_setting', { p_key: key, p_value: value });
}

export async function adminCreatePromo(code: string, bonusCredits: number, maxRedemptions = 100) {
  return rpc<boolean>('reelora_admin_create_promo', {
    p_code: code, p_bonus_credits: bonusCredits, p_max_redemptions: maxRedemptions,
  });
}

export async function adminListRecharges(): Promise<RechargeOrder[]> {
  return unwrap<RechargeOrder[]>(
    supabase.from('ugc_recharge_orders').select('*').order('created_at', { ascending: false }).limit(200) as unknown as PromiseLike<AnyResult>,
  );
}

export async function adminListSettings(): Promise<{ setting_key: string; setting_value: Json; description: string | null }[]> {
  return unwrap<{ setting_key: string; setting_value: Json; description: string | null }[]>(
    supabase.from('ugc_app_settings').select('*').order('setting_key') as unknown as PromiseLike<AnyResult>,
  );
}

export async function adminListAuditLogs() {
  return unwrap<{ id: string; action: string; target_type: string | null; target_id: string | null; details: Json; created_at: string; actor_user_id: string }[]>(
    supabase.from('reelora_audit_logs').select('*').order('created_at', { ascending: false }).limit(100) as unknown as PromiseLike<AnyResult>,
  );
}

/* -------------------------------------------------------------------------- */
/* AI (Groq via Edge Function)                                                 */
/* -------------------------------------------------------------------------- */

export async function generateScript(payload: {
  project_id?: string | null; product: string; audience?: string; platform?: string; tone?: string;
  duration?: number; objective?: string; market?: string; brief?: string; template_id?: string | null; language?: string;
}): Promise<AiScriptResult> {
  return invokeEdge<AiScriptResult>('reelora-ai', { action: 'generate_script', ...payload });
}

export async function improvePrompt(content: string): Promise<{ content: string; variables: string[] }> {
  return invokeEdge('reelora-ai', { action: 'improve_prompt', content });
}

export async function generateHooks(product: string, audience: string): Promise<{ hooks: string[] }> {
  return invokeEdge('reelora-ai', { action: 'generate_hooks', product, audience });
}

export async function generateVisual(input: { product: string; scene_action: string; ambiance: string }): Promise<{ text: string }> {
  return invokeEdge('reelora-ai', { action: 'generate_visual', ...input });
}

export async function generateScenes(payload: { project_id?: string | null; script_text: string; duration?: number }): Promise<{ scenes: AiScene[] }> {
  return invokeEdge('reelora-ai', { action: 'generate_scenes', ...payload });
}

export async function healthCheck(): Promise<{ configured: Record<string, boolean> }> {
  const { data, error } = await supabase.functions.invoke('reelora-health', { method: 'GET' });
  if (error) throw new AppError(humanizeError(error.message), 'HEALTH_ERROR');
  return data as { configured: Record<string, boolean> };
}

/** A stable, per-operation idempotency key: never reuse across different videos. */
export function newGenerationIdempotencyKey(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  const id = g.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ugc-${id}`;
}
