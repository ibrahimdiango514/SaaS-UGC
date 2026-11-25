#!/usr/bin/env node
/**
 * Audit individuel des configurations runtime persistables (lot 16).
 *
 * Une ligne « configurable » n'est PAS une intégration terminée. Ce script
 * reprend chaque modèle préparé, relit sa fiche officielle mise en cache et
 * vérifie les invariants que la préparation runtime doit respecter :
 *
 *   1. contrat de sortie lié (protocole) et champ de résultat identifiable ;
 *   2. schéma d'entrée exploitable, champs obligatoires, uploads supportés,
 *      aucun paramètre technique dangereux ;
 *   3. endpoint confirmé par l'OpenAPI officiel ;
 *   4. prix déclaré : coût positif, ou coût nul AVEC stratégie de coût et source ;
 *   5. crédits recalculés avec la grille serveur (0 pour un modèle gratuit) ;
 *   6. endpoint d'estimation exact ;
 *   7. famille de quota résolue par les règles, et famille compatible avec la
 *      sortie déclarée ;
 *   8. runtime configuré (estimation + type de sortie).
 *
 * Aucune écriture Supabase, aucun appel de génération, aucun crédit.
 *
 *   node scripts/evaluate-muapi-catalog.mjs --cached --out /tmp/eval.json
 *   node scripts/evaluate-runtime-readiness.mjs --eval /tmp/eval.json --out /tmp/readiness.json
 *   node scripts/audit-runtime-configs.mjs --eval /tmp/eval.json --readiness /tmp/readiness.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { integrationProgress } from '../supabase/functions/studio-runtime/families.ts';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
};
const EVAL = arg('eval', '/tmp/eval.json');
const READINESS = arg('readiness', '/tmp/readiness.json');
const DETAILS = arg('details', '/tmp/muapi-details');
const OPENAPI = arg('openapi', '/tmp/muapi-openapi.json');
const OUT = arg('out', '');
const GRID = { usd_to_xof: 620, credit_value_xof: 100, target_margin_percent: 60, processing_cost_usd: 0.01 };

const creditsFor = (costUsd) => {
  const retail = costUsd * GRID.usd_to_xof * (1 + GRID.target_margin_percent / 100) + GRID.processing_cost_usd * GRID.usd_to_xof;
  const credits = Math.ceil(retail / GRID.credit_value_xof);
  return credits < 1 || credits > 1000000 ? null : credits;
};

const openapiText = readFileSync(OPENAPI, 'utf8');
const openapi = JSON.parse(openapiText);
openapi.__document_sha256 = (await import('node:crypto')).createHash('sha256').update(openapiText, 'utf8').digest('hex');

const evaluation = JSON.parse(readFileSync(EVAL, 'utf8'));
const readiness = JSON.parse(readFileSync(READINESS, 'utf8'));
const byId = new Map(evaluation.results.map((result) => [result.model_id, result]));
const ready = new Map(readiness.rows.map((row) => [row.model_id, row]));
const detailOf = (name) => {
  const raw = JSON.parse(readFileSync(`${DETAILS}/${encodeURIComponent(name)}.json`, 'utf8'));
  const detail = raw.body?.data ?? raw.body ?? {};
  return { detail, cached: raw };
};

const UPLOAD_KINDS = ['image', 'video', 'audio', 'images_list', 'videos_list', 'audios_list'];
const UNSAFE = ['webhook', 'callback_url', 'api_key', 'authorization', 'endpoint'];
const MEDIA_PROTOCOLS = ['muapi_output_media_v1', 'muapi_output_media_list_v1'];
const FAMILY_OUTPUT_OK = new Set([
  'text-to-image', 'image-to-image', 'image-editing', 'image-enhancement', 'text-to-video', 'image-to-video',
  'video-to-video', 'video-editing', 'lip-sync', 'avatar-animation', 'storyboard', 'audio-to-video',
  'audio-generation', 'lora-inference', 'image-to-3d', 'text-to-3d', 'training',
]);
/** Familles qui produisent du TEXTE (sortie `muapi_output_text_v1`). */
const TEXT_FAMILIES = new Set(['text', 'multimodal']);
/** Protocoles dont la sortie est du TEXTE (texte libre ou donnée JSON déclarée). */
const TEXT_PROTOCOLS = new Set(['muapi_output_text_v1', 'muapi_output_json_v1']);

const leafUploads = (definition, out = []) => {
  if (!definition || typeof definition !== 'object') return out;
  if (definition.field !== undefined) out.push(definition);
  if (definition.properties) for (const value of Object.values(definition.properties)) leafUploads(value, out);
  if (definition.items) leafUploads(definition.items, out);
  return out;
};
const unsafeKeys = (definition) => {
  if (!definition || typeof definition !== 'object') return [];
  const found = [];
  for (const [key, value] of Object.entries(definition.properties ?? {})) {
    if (UNSAFE.includes(key.toLowerCase())) found.push(key);
    found.push(...unsafeKeys(value));
  }
  if (definition.items) found.push(...unsafeKeys(definition.items));
  return found;
};

const audits = [];
for (const [modelId, row] of ready) {
  const result = byId.get(modelId);
  const { detail, cached } = detailOf(modelId);
  const endpointEvidence = {
    endpoint: detail.endpoint ?? null,
    endpoint_url: detail.endpoint_url ?? null,
    source_url: `https://api.muapi.ai/api/v1/models/${encodeURIComponent(modelId)}`,
    observed_at: 'cached',
    http_status: cached.status ?? 200,
  };
  const progress = integrationProgress({
    provider_model_id: modelId,
    category: typeof detail.category === 'string' ? detail.category : '',
    input_schema: detail.input_schema ? { ...detail.input_schema, vyora_endpoint_evidence: endpointEvidence } : null,
    output_schema: detail.output_schema ?? null,
    endpoint_evidence: endpointEvidence,
  }, openapi);

  const issues = [];
  const warnings = [];
  const add = (code, detailText) => issues.push({ code, detail: detailText });

  if (!result || progress.status !== 'integration_prepared') add('REGRESSION_NOT_PREPARED', progress.blockers);
  if (progress.protocol !== row.protocol) add('PROTOCOL_DRIFT', { audited: progress.protocol, persisted: row.protocol });
  if (MEDIA_PROTOCOLS.includes(progress.protocol) && !progress.result_field) add('RESULT_FIELD_MISSING', progress.protocol);
  if (!progress.openapi_evidence.operation_id) add('OPENAPI_OPERATION_MISSING', progress.openapi_evidence.endpoint_resolution);
  if (progress.openapi_evidence.endpoint_resolution?.status !== 'resolved') add('ENDPOINT_NOT_RESOLVED', progress.openapi_evidence.endpoint_resolution);

  const input = detail.input_schema?.schemas?.input_data;
  const properties = input?.properties ?? {};
  if (input?.type !== 'object' || Object.keys(properties).length === 0) add('SCHEMA_INPUT_EMPTY', null);
  const required = Array.isArray(input?.required) ? input.required : [];
  // Avertissement, pas une anomalie : certaines fiches déclarent tous leurs
  // champs facultatifs (avatar HeyGen, Depth Anything). Le contrat est celui du
  // fournisseur ; on le signale pour ne pas le présenter comme un formulaire
  // « complet ».
  if (!required.length) warnings.push({ code: 'SCHEMA_NO_REQUIRED_FIELD' });
  for (const key of required) if (!Object.hasOwn(properties, key)) add('SCHEMA_REQUIRED_UNDECLARED', key);
  const unsafe = unsafeKeys(input);
  if (unsafe.length) add('UNSAFE_PARAMETER', unsafe);
  // Un champ déclaré « public URL » est un lien fourni par le client, pas un
  // téléversement : il ne requiert aucun adaptateur d'import (lot 17).
  const externalLink = (definition) => {
    const text = `${definition.title ?? ''} ${definition.description ?? ''}`;
    const external = /\bpublic\s+URLs?\b/i.test(text) || (String(definition.field) === 'zip' && /\bURLs?\b/i.test(text));
    return typeof definition.type === 'string' && external;
  };
  const uploads = leafUploads(input).filter((definition) => definition.field !== undefined && !externalLink(definition));
  for (const upload of uploads) if (!UPLOAD_KINDS.includes(String(upload.field))) add('UPLOAD_KIND_UNSUPPORTED', upload.field);

  const cost = detail.cost;
  const strategy = typeof detail.cost_strategy === 'string' ? detail.cost_strategy.trim() : '';
  const free = cost === 0 && strategy.length > 0;
  const priced = typeof cost === 'number' && detail.cost_currency === 'USD' && cost <= 1000 && (cost > 0 || free);
  if (!priced) add('PRICE_NOT_DECLARED', { cost, strategy });
  if (free && (!detail.estimate_endpoint || !String(detail.description ?? '').length)) add('FREE_EVIDENCE_INCOMPLETE', null);
  const expectedCredits = priced ? (free ? 0 : creditsFor(cost)) : null;
  if (expectedCredits === null) add('CREDITS_NOT_COMPUTABLE', cost);
  if (row.credits !== undefined && row.credits !== expectedCredits) add('CREDITS_DRIFT', { expected: expectedCredits, persisted: row.credits });
  if (priced && detail.estimate_endpoint !== `/api/v1/models/${modelId}/estimate-cost`) add('ESTIMATE_PATH_INVALID', detail.estimate_endpoint);
  const textProtocol = TEXT_PROTOCOLS.has(progress.protocol);
  if (textProtocol && row.output_kind !== 'text') add('OUTPUT_KIND_INCOHERENT', row.output_kind);
  if (!textProtocol && row.output_kind !== 'media') add('OUTPUT_KIND_INCOHERENT', row.output_kind);
  if (!row.quota_kind) add('QUOTA_FAMILY_UNRESOLVED', detail.category);
  const textOutput = textProtocol;
  if (textOutput ? !TEXT_FAMILIES.has(progress.family) : !FAMILY_OUTPUT_OK.has(progress.family)) add('FAMILY_OUTPUT_UNSUPPORTED', progress.family);
  if (!row.runtime_configured) add('RUNTIME_NOT_CONFIGURED', { estimate: row.estimate_path, output: row.output_kind });

  audits.push({
    model_id: modelId,
    family: progress.family,
    protocol: progress.protocol,
    result_field: progress.result_field,
    quota_kind: row.quota_kind,
    billing: free ? 'free' : 'metered',
    cost_usd: priced ? cost : null,
    credits: expectedCredits,
    configurable: issues.length === 0,
    issues,
    warnings,
  });
}

const byCode = {};
for (const audit of audits) for (const issue of audit.issues) {
  const entry = (byCode[issue.code] ??= { total: 0, examples: [] });
  entry.total += 1;
  if (entry.examples.length < 8) entry.examples.push(audit.model_id);
}
const failing = audits.filter((audit) => audit.issues.length > 0);
const withWarnings = audits.filter((audit) => audit.warnings.length > 0);
const report = {
  audited_at_utc: new Date().toISOString(),
  scope: 'chaque modèle préparé, relu depuis sa fiche officielle en cache ; aucune écriture, aucune génération',
  counts: {
    audited: audits.length,
    coherent: audits.length - failing.length,
    failing: failing.length,
    with_warnings: withWarnings.length,
    warnings: withWarnings.map((audit) => ({ model_id: audit.model_id, codes: audit.warnings.map((w) => w.code) })),
    by_code: byCode,
  },
  free_billing: audits.filter((audit) => audit.billing === 'free').map((audit) => audit.model_id),
  credits_range: audits.reduce((acc, audit) => {
    if (audit.credits === null) return acc;
    return { min: Math.min(acc.min, audit.credits), max: Math.max(acc.max, audit.credits) };
  }, { min: Number.MAX_SAFE_INTEGER, max: 0 }),
  failing_models: failing.map((audit) => ({ model_id: audit.model_id, issues: audit.issues })),
  audits,
};

const text = `${JSON.stringify(report, null, 2)}\n`;
if (OUT) writeFileSync(OUT, text);
console.log(JSON.stringify(report.counts, null, 2));
console.log(`gratuits déclarés : ${report.free_billing.join(', ') || 'aucun'}`);
if (failing.length) {
  console.log('\nmodèles à corriger :');
  for (const audit of failing.slice(0, 20)) console.log(`- ${audit.model_id}: ${audit.issues.map((issue) => issue.code).join(', ')}`);
  process.exitCode = 1;
}
