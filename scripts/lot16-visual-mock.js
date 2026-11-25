/* Mock navigateur du lot 16 — aucune requête Supabase réelle.
 * Injecté avant le chargement de l'application par le harnais Playwright.
 * Ce fichier ne fait partie ni du build ni du produit : il sert uniquement à
 * vérifier le rendu et les interactions de l'interface.
 */
(() => {
  const ADMIN = localStorage.getItem('lot16.admin') === '1';
  const USER = {
    id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated',
    email: ADMIN ? 'admin@vyora.local' : 'preview@vyora.local',
    email_confirmed_at: '2026-11-01T00:00:00Z', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: ADMIN ? 'Admin VYORA' : 'Preview VYORA' }, identities: [],
  };
  const SESSION = {
    access_token: 'preview.header.signature', token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'preview-refresh', user: USER,
  };
  localStorage.setItem('reelora.auth.v1', JSON.stringify(SESSION));

  const WORKSPACE = '22222222-2222-4222-8222-222222222222';
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
  const MP4 = 'data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==';

  const schema = (fields, required = ['prompt']) => ({ schemas: { input_data: {
    type: 'object', required,
    properties: Object.fromEntries(fields.map(([key, def]) => [key, def])),
  } } });
  const prompt = { type: 'string', title: 'Prompt', description: 'Description de la création' };
  const model = (over) => ({
    model_id: 'model', display_name: 'Modèle', category: 'Text to Image', provider: 'MuAPI',
    schema: schema([['prompt', prompt]]), credits: 4, operational: true, blockers: [],
    plan_allowed: true, technical_blockers: [], quota_family: 'image', billing: 'metered', ...over,
  });
  const models = [
    model({ model_id: 'flux-2-pro', display_name: 'Flux 2 Pro', category: 'Text to Image', credits: 4, quota_family: 'image' }),
    model({ model_id: 'seedance-2', display_name: 'Seedance 2 (texte → vidéo)', category: 'Text to Video', credits: 9, quota_family: 'video',
      schema: schema([['prompt', prompt], ['duration', { type: 'string', title: 'Durée', enum: ['5', '10'], default: '5' }]]) }),
    model({ model_id: 'suno-v5', display_name: 'Suno v5 (musique)', category: 'Text to Audio', credits: 3, quota_family: 'music',
      schema: schema([['prompt', prompt], ['style', { type: 'string', title: 'Style' }]]) }),
    model({ model_id: 'meshy-v7', display_name: 'Meshy v7 (image → 3D)', category: 'Image to 3D', credits: 6, quota_family: 'model_3d',
      schema: schema([['image_url', { type: 'string', title: 'Image de référence', field: 'image' }]], ['image_url']) }),
    model({ model_id: 'add-image-watermark', display_name: 'Filigrane image (gratuit)', category: 'Image to Image', credits: 0, billing: 'free', quota_family: 'image',
      schema: schema([['image_url', { type: 'string', title: 'Image', field: 'image' }], ['watermark_image_url', { type: 'string', title: 'Filigrane', field: 'image' }]], ['image_url', 'watermark_image_url']) }),
    model({ model_id: 'qwen-3-llm', display_name: 'Qwen 3 (texte)', category: 'Text to Text', credits: 1, quota_family: 'script' }),
  ];
  const pendingPlan = [
    model({ model_id: 'lora-style', display_name: 'LoRA style (prêt, hors offre)', category: 'Image to Image', credits: 5, quota_family: 'lora',
      operational: false, plan_allowed: false, blockers: ['PLAN_UNAVAILABLE'], technical_blockers: [] }),
    model({ model_id: 'voice-clone', display_name: 'Voix clonée (prêt, hors offre)', category: 'Text to Audio', credits: 8, quota_family: 'voice',
      operational: false, plan_allowed: false, blockers: ['PLAN_UNAVAILABLE'], technical_blockers: [] }),
  ];
  const quotaPending = [
    model({ model_id: 'audio-fx', display_name: 'Effets audio (quota à arbitrer)', category: 'Text to Audio', credits: 2, quota_family: 'audio',
      operational: false, plan_allowed: false, blockers: ['QUOTA_POLICY_MISSING', 'PLAN_UNAVAILABLE'], technical_blockers: ['QUOTA_POLICY_MISSING'] }),
  ];
  const jobs = [
    { id: 'job-image', status: 'succeeded', credits: 4, display_name: 'Flux 2 Pro', provider_model_id: 'flux-2-pro', created_at: '2026-11-20T10:00:00Z', error_code: null,
      outputs: [{ kind: 'file', url: PNG, mime: 'image/png' }] },
    { id: 'job-video', status: 'succeeded', credits: 9, display_name: 'Seedance 2', provider_model_id: 'seedance-2', created_at: '2026-11-20T09:40:00Z', error_code: null,
      outputs: [{ kind: 'file', url: MP4, mime: 'video/mp4' }] },
    { id: 'job-audio', status: 'succeeded', credits: 3, display_name: 'Suno v5', provider_model_id: 'suno-v5', created_at: '2026-11-20T09:30:00Z', error_code: null,
      outputs: [{ kind: 'file', url: WAV, mime: 'audio/wav' }] },
    { id: 'job-3d', status: 'succeeded', credits: 6, display_name: 'Meshy v7', provider_model_id: 'meshy-v7', created_at: '2026-11-20T09:20:00Z', error_code: null,
      outputs: [{ kind: 'file', url: 'https://cdn.example.com/resultat.glb', mime: 'model/gltf-binary' }] },
    { id: 'job-text', status: 'succeeded', credits: 1, display_name: 'Qwen 3', provider_model_id: 'qwen-3-llm', created_at: '2026-11-20T09:10:00Z', error_code: null,
      outputs: [{ kind: 'text', text: 'Un script de démonstration, généré en texte et restitué tel quel.' }] },
    // Résultat de DONNÉE (`muapi_output_json_v1`) et texte hostile : ils doivent
    // s'afficher comme des données/texte, jamais comme du HTML.
    { id: 'job-json', status: 'succeeded', credits: 2, display_name: 'SEO domain overview', provider_model_id: 'seo-domain-overview', created_at: '2026-11-20T09:05:00Z', error_code: null,
      outputs: [{ kind: 'text', text: JSON.stringify({ domain: 'vyora.app', domain_rank: 412345, organic: { keywords: 1280, traffic: 24310, cost_usd: 5120.5 }, top_pages: [{ url: '/studio', visits: 8120 }, { url: '/tarifs', visits: 3204 }] }, null, 0) }] },
    { id: 'job-hostile', status: 'succeeded', credits: 1, display_name: 'Recherche web', provider_model_id: 'research-web-answer', created_at: '2026-11-20T09:02:00Z', error_code: null,
      outputs: [{ kind: 'text', text: '<img src=x onerror="alert(1)"> <script>alert(1)</script>' }] },
    { id: 'job-failed', status: 'failed', credits: 4, display_name: 'Flux 2 Pro', provider_model_id: 'flux-2-pro', created_at: '2026-11-20T08:00:00Z', error_code: 'PROVIDER_FAILED', outputs: [] },
    { id: 'job-uncertain', status: 'uncertain', credits: 9, display_name: 'Seedance 2', provider_model_id: 'seedance-2', created_at: '2026-11-20T07:00:00Z', error_code: 'SUBMISSION_UNCERTAIN', outputs: [] },
  ];
  const quotas = {
    plan: 'pro', period: '2026-11',
    items: [
      { family: 'image', display_name: 'Image', generator: true, limit: 160, used: 12, remaining: 148, policy: 'active' },
      { family: 'video', display_name: 'Vidéo', generator: true, limit: 80, used: 9, remaining: 71, policy: 'active' },
      { family: 'music', display_name: 'Musique et chansons', generator: true, limit: 80, used: 3, remaining: 77, policy: 'active' },
      { family: 'audio', display_name: 'Audio', generator: true, limit: 160, used: 0, remaining: 160, policy: 'pending_approval' },
      { family: 'model_3d', display_name: 'Modèle 3D', generator: true, limit: 80, used: 1, remaining: 79, policy: 'active' },
      { family: 'lora', display_name: 'LoRA / adaptation', generator: true, limit: null, used: 0, remaining: null, policy: 'missing' },
    ],
  };

  const families = [
    ['script', 'Script / texte'], ['prompt', 'Prompt IA'], ['video', 'Vidéo'], ['image', 'Image'],
    ['audio', 'Audio'], ['music', 'Musique et chansons'], ['voice', 'Voix / synthèse vocale'],
    ['model_3d', 'Modèle 3D'], ['lora', 'LoRA / adaptation'], ['tool', 'Outil fournisseur'], ['export', 'Export'],
  ];
  const planMatrix = ['free', 'studio', 'pro', 'enterprise'].map((plan_key, index) => ({
    plan_key, display_name: ['Découverte', 'Studio', 'Pro', 'Entreprise'][index],
    families: families.map(([family, display_name], i) => ({
      family, display_name,
      allowed: i < 8,
      entitlement_approved: i < 4,
      monthly_limit: [1, 20, 160, 2000][index] / (i === 0 ? 1 : i === 1 ? 2 : 1) | 0,
      quota_enabled: true,
      quota_approved: i < 4,
      source_note: i < 4 ? 'politique existante' : 'proposition dérivée de video',
    })),
  }));
  const proposals = ['audio', 'music', 'voice', 'model_3d', 'lora', 'tool'].map((family, i) => ({
    family, display_name: families.find(([f]) => f === family)[1],
    anchor_family: 'video', multiplier: [2, 1, 2, 1, 1, 5][i], minimum: [1, 1, 1, 1, 1, 5][i],
    rationale: 'Proposition calculée depuis un quota déjà approuvé, jamais un quota vidéo emprunté.',
    quota_approved_plans: family === 'model_3d' ? 4 : 0,
    entitlement_approved_plans: family === 'model_3d' ? 3 : 0,
    models_prepared: [44, 0, 0, 8, 8, 0][i],
    plans: ['free', 'studio', 'pro', 'enterprise'].map((plan_key, p) => ({
      plan_key, anchor_limit: [1, 20, 80, 1000][p], anchor_approved: true,
      proposed_limit: [[1, 20, 80, 1000][p] * [2, 1, 2, 1, 1, 5][i]][0],
      quota_approved: family === 'model_3d', quota_enabled: true,
      entitlement_allowed: p > 0, entitlement_approved: family === 'model_3d' && p > 0,
    })),
  }));
  const adminSummary = {
    models: 867, present: 867, removed: 0, prepared: 812, configurable: 812, runtime_configured: 812,
    technical_test_passed: 0, integrated: 812, operational: 0, enabled: 0, studio_available: 0,
    free_billing: 3, problems: 867, pricing_missing: 0, real_tests_missing: 812, estimate_missing: 0,
    quota_policy_pending: 81, configurable_quota_pending: 81, configurable_plan_pending: 812, plan_policy_pending: 812,
    quota_families: 11, quota_families_proposed_only: 6, plans: ['enterprise', 'free', 'pro', 'studio'],
    status: { catalogued: 867, prepared: 812, configurable: 812, runtime_configured: 812, technical_test_passed: 0, operational: 0, enabled: 0, studio_available: 0 },
  };
  const adminModels = {
    total: 4, next_cursor: null,
    items: [
      { provider_model_id: 'flux-2-pro', display_name: 'Flux 2 Pro', category: 'Text to Image', detail_status: 'ok', account_access: 'available', integration_status: 'integration_prepared', studio_enabled: false },
      { provider_model_id: 'seedance-2', display_name: 'Seedance 2', category: 'Text to Video', detail_status: 'ok', account_access: 'available', integration_status: 'integration_prepared', studio_enabled: false },
      { provider_model_id: 'ad-library-search', display_name: 'Ad Library Search', category: 'Multimodal', detail_status: 'http_error', account_access: 'unverified', integration_status: 'blocked', studio_enabled: false },
      { provider_model_id: 'flux-lora-trainer', display_name: 'Flux LoRA Trainer', category: 'Training', detail_status: 'ok', account_access: 'available', integration_status: 'integration_prepared', studio_enabled: false },
    ],
  };
  const adminDetail = {
    provider_model_id: 'flux-2-pro', display_name: 'Flux 2 Pro', provider_key: 'muapi', category: 'Text to Image',
    public_catalog_present: true, description: 'Génération d’images haute fidélité.',
    input_schema: schema([['prompt', prompt], ['aspect_ratio', { type: 'string', title: 'Ratio', enum: ['1:1', '9:16', '16:9'], default: '1:1' }]]),
    output_schema: { schemas: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, output: { type: 'object', properties: { image: { type: 'string', format: 'uri' } } } } } },
    endpoint_evidence: { endpoint: '/api/v1/flux-2-pro', endpoint_url: 'flux-2-pro' },
    detail_status: 'ok', detail_http_status: 200, account_access: 'available', adapter_key: 'muapi_prediction_v1',
    integration_status: 'integration_prepared', studio_enabled: false,
    input_fields: ['prompt', 'aspect_ratio'], required_fields: ['prompt'],
    detail_checked_at: '2026-11-20T10:00:00Z', recent_changes: [],
  };
  const trainerDetail = {
    ...adminDetail, provider_model_id: 'flux-lora-trainer', display_name: 'Flux LoRA Trainer', category: 'Training',
    description: 'Entraînement LoRA à partir d’une archive ZIP publique.',
    input_schema: schema([['images_data_url', { type: 'string', field: 'zip', title: 'Images Zip URL', description: 'Public URL to a .zip archive containing 10-50 training images.', examples: ['https://cdn.example.com/train.zip'] }], ['trigger_phrase', prompt]]),
    output_schema: { schemas: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, output: { type: 'object', properties: { lora_url: { type: 'string', format: 'uri' } } } } } },
    endpoint_evidence: { endpoint: '/api/v1/flux-lora-trainer', endpoint_url: 'flux-lora-trainer' },
    input_fields: ['images_data_url', 'trigger_phrase'], required_fields: ['images_data_url'],
  };
  const catalogSummary = { models: 867, details_ok: 723, detail_errors: 144, enabled: 0, last_sync: '2026-11-20T10:00:00Z',
    categories: { 'Text to Video': 407, 'Text to Image': 165, 'Text to Text': 91 }, prepared: 812, configurable: 812,
    technical_test_passed: 0, integrated: 812,
    operational: 0, studio_available: 0, problems: 867, present: 867, removed: 0, pricing_missing: 0,
    real_tests_missing: 812, measured_at: '2026-11-20T10:00:00Z' };

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const rpc = (name, args) => {
    switch (name) {
      case 'reelora_bootstrap': return { user_id: USER.id, workspace_id: WORKSPACE, plan: 'pro', credits: 120, is_admin: ADMIN };
      case 'reelora_admin_overview': return { users: 1, projects: 0, jobs_succeeded: 0, jobs_failed: 0, credits_available: 120, credits_charged: 25, services: 3 };
      case 'vyora_admin_metrics': return {
        revenue: { collected_total_minor: 0, collected_orders: 0, currency: 'XOF' },
        mrr: { current_minor: 0, active_recurring_subscriptions: 0 },
        history: { months_of_history: 0, exploitable_from: '2026-11' },
        models: { total: 867 },
      };
      case 'reelora_admin_list_users': return [];
      case 'admin_provider_spend_summary': return { max_usd: 0, spent_usd: 0, remaining_usd: 0 };
      case 'admin_provider_balance': return { configured: false, balances: [], message: 'Aucune clé fournisseur.' };
      case 'studio_catalog_admin_summary': return catalogSummary;
      case 'studio_catalog_admin_models': return adminModels;
      case 'studio_catalog_admin_model_detail': return args?.p_model_id === 'flux-lora-trainer' ? trainerDetail : adminDetail;
      case 'studio_catalog_health': return catalogSummary;
      case 'studio_credit_grid': return { currency: 'XOF', usd_to_xof: 620, credit_value_xof: 100, target_margin_percent: 60, processing_cost_usd: 0.01, packs: [], custom_recharge: {} };
      case 'studio_credit_history': return { purchases: [], ledger: [] };
      case 'reelora_quota_status': return { plan: { plan_key: 'pro', display_name: 'Pro', monthly_credits: 500 }, credits: 120, period: '2026-11', usage: {} };
      default: return null;
    }
  };
  const tables = {
    reelora_plans: [{ id: 'p1', plan_key: 'pro', display_name: 'Pro', active: true, sort_order: 3, monthly_credits: 500 }],
    ugc_service_catalog: [], ugc_recharge_orders: [], ugc_app_settings: [], reelora_audit_logs: [],
    ugc_profiles: [{ user_id: USER.id, display_name: 'Preview' }],
    ugc_workspaces: [{ id: WORKSPACE, name: 'Studio VYORA (démo)', owner_id: USER.id, default_language: 'fr' }],
    reelora_avatars: [], ugc_generations: [], reelora_notifications: [],
  };
  const edge = (name, body) => {
    if (name === 'studio-runtime') {
      switch (body.action) {
        case 'models': {
          if (body.query === 'zzz') return { total: 0, categories: {}, items: [], next_cursor: null, credits: 120, workspace_id: WORKSPACE, plan: 'pro' };
          return { total: 867, categories: { 'Text to Image': 165, 'Text to Video': 407, 'Text to Audio': 44, 'Image to 3D': 8 }, items: [...models, ...pendingPlan, ...quotaPending], next_cursor: null, credits: 120, workspace_id: WORKSPACE, plan: 'pro' };
        }
        case 'quotas': return quotas;
        case 'history': return { jobs };
        case 'quote': return { quote_id: '44444444-4444-4444-8444-444444444444', credits: 4, expires_at: new Date(Date.now() + 600000).toISOString(), balance: 120 };
        case 'start': return { job_id: 'job-image', status: 'accepted' };
        case 'status': return { job_id: 'job-image', status: 'succeeded', credits: 4, error_code: null };
        case 'admin_summary': return adminSummary;
        case 'admin_plan_matrix': return { plans: planMatrix };
        case 'admin_plan_proposals': return { proposed_only: true, families: proposals };
        case 'admin_plan_family': return { saved: true };
        case 'admin_plan_quota': return { saved: true };
        case 'admin_plan_propose': return { derived: true, proposed_only: true, families: proposals.map((p) => ({ family: p.family })) };
        case 'admin_plan_approve': return { saved: { family: body.family, quota_plans_approved: 4, entitlement_plans_approved: body.approve_entitlements ? 3 : 0, entitlements_approved: body.approve_entitlements === true } };
        case 'admin_limits': return { saved: true };
        case 'admin_progress': return { counts: { total: 867, assessed: 867, prepared: 812, technical_tests: 0 }, families: { 'text-to-video': 119, 'image-to-video': 160 }, items: [] };
        case 'admin_report': return { syncs: [], detail_events: [], errors: [] };
        case 'admin_config': return { config: { credits: 4, max_cost_usd: 0.02, quota_kind: 'image', output_kind: 'media', allowed_plans: ['pro'], enabled: false, verified_at: null, verification_reference: null, billing: 'metered' }, spec_hash: 'abc', plans: ['enterprise', 'free', 'pro', 'studio'], families: families.map(([family, display_name]) => ({ family, display_name, generator: true })), limits: { enabled: false, daily_usd: 0 } };
        default: return { ok: true };
      }
    }
    if (name === 'reelora-video') {
      if (body.action === 'admin-catalog') return {
        models: [],
        catalog: { source: 'muapi_public', fetched_at: '2026-11-20T10:00:00Z', public_total: 867, authenticated_total: null,
          detected_video: 407, active: 0, unavailable: 407, verified: false, reasons: { unsupported: 407 }, endpoints: [],
          account: { key_configured: false, key_valid: false, catalog_status: null, balance_status: null, keys_status: null, key_is_test: false, error: null } },
      };
      return { models: [], catalog: { fetched_at: '2026-11-20T10:00:00Z', detected_video: 0, active: 0, unavailable: 0, verified: false } };
    }
    if (name === 'universal-catalog') return { error: { code: 'PREVIEW_ONLY', message: 'Synchronisation désactivée dans la vérification visuelle.' } };
    if (name === 'reelora-owner-bootstrap') return { user_id: USER.id, workspace_id: WORKSPACE, role: ADMIN ? 'owner' : 'user', needs_bootstrap: false };
    return { error: { code: 'PREVIEW_ONLY', message: 'Fonction non simulée : ' + name } };
  };

  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    let parsed;
    try { parsed = new URL(url, location.href); } catch { return original(input, init); }
    if (!/supabase\.co$/.test(parsed.hostname)) return original(input, init);
    const body = (() => { try { return init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch { return {}; } })();
    if (parsed.pathname.startsWith('/auth/v1/')) {
      if (parsed.pathname.endsWith('/user')) return json(USER);
      return json(SESSION);
    }
    if (parsed.pathname.startsWith('/rest/v1/rpc/')) {
      const name = parsed.pathname.split('/').pop();
      const payload = rpc(name, body);
      if (payload !== null) return json(payload);
      return json({ error: 'PREVIEW_ONLY', message: 'RPC non simulée : ' + name }, 400);
    }
    if (parsed.pathname.startsWith('/functions/v1/')) {
      const name = parsed.pathname.split('/').pop();
      if (name === 'studio-runtime' && body.query === 'erreur') {
        return json({ error: { code: 'RUNTIME_UNAVAILABLE', message: 'Le catalogue n’a pas pu être chargé. Réessayez.' } }, 503);
      }
      return json(edge(name, body));
    }
    if (parsed.pathname.startsWith('/storage/v1/')) return json({});
    if (parsed.pathname.startsWith('/rest/v1/')) {
      const table = parsed.pathname.replace('/rest/v1/', '').split('/')[0];
      const single = (init?.headers?.Accept ?? init?.headers?.accept ?? '').includes?.('vnd.pgrst.object');
      const rows = tables[table] ?? [];
      return json(single ? (rows[0] ?? null) : rows);
    }
    return json({});
  };
  window.__LOT16_MOCK__ = true;
})();
