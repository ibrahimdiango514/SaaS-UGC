#!/usr/bin/env node
/**
 * Préparation runtime hors-ligne : que manque-t-il aux modèles préparés ?
 *
 * Rejoue la MÊME décision que `public.studio_prepare_runtime` (migration
 * `…_studio_runtime_prepare`) sur les 867 références officielles, pour savoir,
 * avant tout déploiement, combien de configurations sont réellement
 * persistables — et pourquoi les autres ne le sont pas.
 *
 * Aucune écriture Supabase, aucune génération, aucun crédit.
 *
 *   node scripts/evaluate-muapi-catalog.mjs --cached --out /tmp/eval.json
 *   node scripts/evaluate-runtime-readiness.mjs --eval /tmp/eval.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
};
const EVAL = arg('eval', '/tmp/eval.json');
const OUT = arg('out', '');
const DETAILS = arg('details', '/tmp/muapi-details');

/**
 * Grille serveur réellement appliquée (`ugc_app_settings.studio_pricing_config`).
 * Ces valeurs viennent de la migration `20261112040000_studio_credit_grid` ;
 * la fonction SQL les relit en base, ce script ne fait que les refléter.
 */
const GRID = { usd_to_xof: 620, credit_value_xof: 100, target_margin_percent: 60, processing_cost_usd: 0.01 };

const creditsFor = (costUsd) => {
  const retail = costUsd * GRID.usd_to_xof * (1 + GRID.target_margin_percent / 100) + GRID.processing_cost_usd * GRID.usd_to_xof;
  const credits = Math.ceil(retail / GRID.credit_value_xof);
  return credits < 1 || credits > 1000000 ? null : credits;
};

/**
 * Mêmes règles que `ugc_private.studio_quota_family` (migration
 * `…_studio_quota_plan_policy`) : priorité décroissante, données en base.
 * Aucune nouvelle famille n'est inventée ici ; une catégorie inconnue reste
 * un refus explicite.
 */
const FAMILY_RULES = [
  ['model_3d', 100, /(^|[^a-z])(3d|three[ -]dimensional|mesh|glb)([^a-z]|$)/i],
  // Un entraînement LoRA consomme la famille `lora` (règle de données de la
  // migration lot 17, priorité 82) : la limite reste proposée, jamais appliquée.
  ['lora', 82, /(^|[^a-z])training([^a-z]|$)/i],
  ['tts', 90, /text[ -]?to[ -]?speech|(^|[^a-z])tts([^a-z]|$)|voice|speech synthesis/i],
  ['music', 85, /music|song|soundtrack|melod/i],
  ['lora', 80, /lora|fine[ -]?tun/i],
  ['audio', 75, /audio|sfx|sound[ -]?effect/i],
  ['video', 70, /video/i],
  ['image', 60, /image|photo|illustration/i],
  ['script', 50, /text[ -]?to[ -]?text|text generation|chat|completion|llm/i],
];
const quotaFor = (category, groupOf, integrationFamily) => {
  if (['utility', 'moderation'].includes(groupOf)) return 'tool';
  const text = `${category ?? ''} ${integrationFamily ?? ''}`;
  const rule = FAMILY_RULES.find(([, , pattern]) => pattern.test(text));
  return rule ? rule[0] : null;
};

const count = (values) => values.reduce((acc, value) => {
  const key = value ?? '(aucun)';
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

const evaluation = JSON.parse(readFileSync(EVAL, 'utf8'));
const detail = (name) => {
  try {
    const raw = JSON.parse(readFileSync(`${DETAILS}/${encodeURIComponent(name)}.json`, 'utf8'));
    return raw.body?.data ?? raw.body;
  } catch { return null; }
};

const rows = [];
for (const result of evaluation.results) {
  if (result.status !== 'integration_prepared') continue;
  const model = detail(result.model_id) ?? {};
  // Un coût officiellement nul EST un prix déclaré quand la fiche nomme sa
  // stratégie de coût (watermark-free, gemini-omni-character-cost…). Sans cette
  // preuve, 0 reste un prix manquant : aucune valeur par défaut n'est créée.
  const strategy = typeof model.cost_strategy === 'string' ? model.cost_strategy.trim() : '';
  const free = model.cost === 0 && strategy.length > 0 && model.cost_currency === 'USD';
  const cost = typeof model.cost === 'number' && model.cost_currency === 'USD' && model.cost <= 1000
    && (model.cost > 0 || free) ? model.cost : null;
  const estimate = model.estimate_endpoint === `/api/v1/models/${result.model_id}/estimate-cost` ? model.estimate_endpoint : null;
  const quota = quotaFor(model.category ?? '', model.group_of ?? null, result.family);
  const missing = [];
  if (cost === null) missing.push('PROVIDER_PRICING_NOT_DECLARED');
  if (estimate === null) missing.push('ESTIMATE_ENDPOINT_NOT_DECLARED');
  if (quota === null) missing.push('QUOTA_POLICY_MISSING');
  if (result.protocol === null) missing.push('PROTOCOL_MISSING');
  rows.push({
    model_id: result.model_id,
    family: result.family,
    category: model.category ?? null,
    group_of: model.group_of ?? null,
    protocol: result.protocol,
    declared_cost_usd: cost,
    billing: cost === 0 ? 'free' : 'metered',
    cost_strategy: strategy || null,
    estimate_path: estimate,
    quota_kind: quota,
    output_kind: ['muapi_output_text_v1', 'muapi_output_json_v1'].includes(result.protocol) ? 'text' : 'media',
    credits: cost === null ? null : cost === 0 ? 0 : creditsFor(cost),
    runtime_configured: estimate !== null && result.protocol !== null,
    scope: ['utility', 'moderation'].includes(model.group_of) ? 'tool' : 'generator',
    configurable: missing.length === 0,
    missing,
  });
}

/** Modèles non préparés : cause technique principale, hors portes externes. */
const GATES = ['CONSTRAINT_REVIEW_REQUIRED', 'REAL_TEST_PENDING'];
const blocked = evaluation.results.filter((result) => result.status !== 'integration_prepared');
const blockedByCause = {};
for (const result of blocked) {
  const technical = (result.blockers ?? []).filter((code) => !GATES.includes(code));
  const cause = technical.length ? technical.join('+') : 'GATES_ONLY';
  const entry = (blockedByCause[cause] ??= { total: 0, families: {}, examples: [] });
  entry.total += 1;
  entry.families[result.family] = (entry.families[result.family] ?? 0) + 1;
  if (entry.examples.length < 6) entry.examples.push(result.model_id);
}

const configurable = rows.filter((row) => row.configurable);
const generators = rows.filter((row) => row.scope === 'generator');
const byFamily = {};
for (const row of rows) {
  const entry = (byFamily[row.family] ??= { prepared: 0, configurable: 0, missing: {}, credits_median: null, _credits: [] });
  entry.prepared += 1;
  if (row.configurable) {
    entry.configurable += 1;
    if (row.credits) entry._credits.push(row.credits);
  } else {
    for (const reason of row.missing) entry.missing[reason] = (entry.missing[reason] ?? 0) + 1;
  }
}
for (const entry of Object.values(byFamily)) {
  const sorted = entry._credits.sort((a, b) => a - b);
  entry.credits_median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  delete entry._credits;
}

const summary = {
  measured_at_utc: new Date().toISOString(),
  source: { evaluation: EVAL, details: 'api.muapi.ai public model sheets', grid: GRID },
  prepared: rows.length,
  configurable: configurable.length,
  runtime_configured: rows.filter((row) => row.runtime_configured).length,
  configurable_generators: configurable.filter((row) => row.scope === 'generator').length,
  isolated_tools: rows.filter((row) => row.scope === 'tool').length,
  not_configurable: rows.length - configurable.length,
  // Échelle de statuts, mesurée hors ligne. Un test réel et une activation ne
  // peuvent pas être prouvés ici : ils restent à 0 par construction.
  status: {
    catalogued: evaluation.total,
    prepared: rows.length,
    configurable: configurable.length,
    runtime_configured: rows.filter((row) => row.runtime_configured).length,
    technical_test_passed: 0,
    operational: 0,
    enabled: 0,
    studio_available: 0,
  },
  billing: count(rows.map((row) => row.billing)),
  missing_reasons: count(rows.filter((row) => !row.configurable).flatMap((row) => row.missing)),
  quota_family_distribution: count(rows.map((row) => row.quota_kind)),
  quota_policy_pending: rows.filter((row) => ['audio', 'music', 'voice', 'model_3d', 'lora', 'tool'].includes(row.quota_kind)).length,
  quota_family_policy: [
    { family: 'audio', anchor: 'video', multiplier: 2, minimum: 1, models: rows.filter((row) => row.quota_kind === 'audio').length },
    { family: 'voice', anchor: 'video', multiplier: 2, minimum: 1, models: rows.filter((row) => row.quota_kind === 'voice').length },
    { family: 'music', anchor: 'video', multiplier: 1, minimum: 1, models: rows.filter((row) => row.quota_kind === 'music').length },
    { family: 'model_3d', anchor: 'video', multiplier: 1, minimum: 1, models: rows.filter((row) => row.quota_kind === 'model_3d').length },
    { family: 'lora', anchor: 'video', multiplier: 1, minimum: 1, models: rows.filter((row) => row.quota_kind === 'lora').length },
    { family: 'tool', anchor: 'video', multiplier: 5, minimum: 5, models: rows.filter((row) => row.quota_kind === 'tool').length },
  ],
  blocked: { total: blocked.length, by_technical_cause: blockedByCause },
  free_billing_models: rows.filter((row) => row.billing === 'free').map((row) => row.model_id),
  by_family: byFamily,
  // Ce qui reste, par construction, après la préparation :
  operational_now: 0,
  studio_available_now: 0,
  external_gates: [
    'ACCESS_UNCONFIRMED (clé fournisseur absente de cet environnement)',
    'PLAN_UNAVAILABLE (matrice des droits à approuver)',
    'QUOTA_POLICY_MISSING (limites audio/musique/voix/3D/LoRA à arbitrer)',
    'PAID_VALIDATION_PENDING (test fournisseur payant)',
    'ADMIN_DISABLED',
  ],
  rows,
  blocked_rows: blocked,
};

const text = `${JSON.stringify(summary, null, 2)}\n`;
if (OUT) writeFileSync(OUT, text);
console.log(JSON.stringify({
  prepared: summary.prepared, configurable: summary.configurable, runtime_configured: summary.runtime_configured,
  configurable_generators: summary.configurable_generators, isolated_tools: summary.isolated_tools,
  not_configurable: summary.not_configurable, missing_reasons: summary.missing_reasons,
  billing: summary.billing, quota_policy_pending: summary.quota_policy_pending,
  blocked: summary.blocked,
}, null, 2));
console.log('\nfamille                préparés  configurables  crédits médians');
for (const [family, stats] of Object.entries(byFamily).sort((a, b) => b[1].prepared - a[1].prepared)) {
  console.log(`${family.padEnd(22)} ${String(stats.prepared).padStart(8)} ${String(stats.configurable).padStart(14)} ${String(stats.credits_median ?? '-').padStart(16)}`);
}
