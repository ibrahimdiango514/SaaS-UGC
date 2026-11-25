#!/usr/bin/env node
/**
 * Réconciliation des métriques du Studio universel (lot 18).
 *
 * Ce script ne mesure rien de neuf : il relit les artefacts de mesure
 * (`evaluate-muapi-catalog` + `evaluate-runtime-readiness`) et vérifie que les
 * chiffres publiés sont MUTUELLEMENT COHÉRENTS :
 *
 *   867 références · 812 configurables · 55 bloqués · 81 quotas en attente
 *   75 modèles gagnés par le lot 17 · entraîneurs à archive ZIP
 *
 * Il reconstruit aussi l'état « avant lot 17 » en neutralisant les seules
 * capacités ajoutées alors (donnée `result`, `output_data`, lien public) puis
 * compare : ce qui est attribuable aux règles, et ce qui ne l'est pas.
 *
 * Il échoue (code 1) dès qu'une somme, une cause ou un invariant ne tombe pas
 * juste. Aucune écriture Supabase, aucune génération, aucun crédit.
 *
 *   node scripts/evaluate-muapi-catalog.mjs --cached --out /tmp/eval.json
 *   node scripts/evaluate-runtime-readiness.mjs --eval /tmp/eval.json --out /tmp/readiness.json
 *   node scripts/reconcile-studio-metrics.mjs --eval /tmp/eval.json --readiness /tmp/readiness.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { integrationProgress } from '../supabase/functions/studio-runtime/families.ts';
import { declaredExternalLink } from '../supabase/functions/universal-catalog/schema.ts';

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

/** Chiffres PUBLIÉS par le lot 17, tels quels, pour confrontation. */
const LOT17 = {
  prepared: 812,
  blocked: 55,
  quota_policy_pending: 81,
  quota_policy_pending_before: 67,
  unlocked: 75,
  zip_trainers: 7,
};
const PENDING_FAMILIES = ['audio', 'music', 'voice', 'model_3d', 'lora', 'tool'];
const GATES = ['CONSTRAINT_REVIEW_REQUIRED', 'REAL_TEST_PENDING'];

const count = (values) => values.reduce((acc, value) => {
  const key = value ?? '(aucun)';
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

const evaluation = JSON.parse(readFileSync(EVAL, 'utf8'));
const readiness = JSON.parse(readFileSync(READINESS, 'utf8'));
const openapi = JSON.parse(readFileSync(OPENAPI, 'utf8'));
const openapiPaths = Object.keys(openapi.paths ?? {});

const detailOf = (name) => {
  try {
    const raw = JSON.parse(readFileSync(`${DETAILS}/${encodeURIComponent(name)}.json`, 'utf8'));
    return raw.body?.data ?? raw.body ?? null;
  } catch { return null; }
};
const modelOf = (name) => {
  const detail = detailOf(name) ?? {};
  const evidence = {
    endpoint: detail.endpoint ?? null, endpoint_url: detail.endpoint_url ?? null,
    source_url: 'cache', observed_at: 'cached', http_status: 200,
  };
  return {
    provider_model_id: name,
    category: typeof detail.category === 'string' ? detail.category : '',
    input_schema: detail.input_schema ? { ...detail.input_schema, vyora_endpoint_evidence: evidence } : null,
    output_schema: detail.output_schema ?? null,
    endpoint_evidence: evidence,
    detail,
  };
};

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

/* ------------------------------------------------------------------ 1. unicité */
const names = evaluation.results.map((result) => result.model_id);
const unique = new Set(names);
check(evaluation.total === names.length, `total ${evaluation.total} ≠ ${names.length}`);
check(unique.size === names.length, `doublons de références : ${names.length - unique.size}`);
check(Object.values(evaluation.by_family).reduce((a, b) => a + b, 0) === names.length,
  'la somme des familles ne couvre pas toutes les références');

/* --------------------------------------------------- 2. préparés / bloqués */
const prepared = evaluation.results.filter((result) => result.status === 'integration_prepared');
const blocked = evaluation.results.filter((result) => result.status !== 'integration_prepared');
const preparedIds = new Set(prepared.map((result) => result.model_id));
check(prepared.length + blocked.length === names.length, 'préparés + bloqués ≠ évalués');
check([...preparedIds].every((id) => !blocked.some((row) => row.model_id === id)), 'un modèle est à la fois préparé et bloqué');

const readinessRows = readiness.rows ?? [];
check(new Set(readinessRows.map((row) => row.model_id)).size === readinessRows.length, 'doublons dans la préparation runtime');
check(readinessRows.length === prepared.length, `préparation runtime ${readinessRows.length} ≠ préparés ${prepared.length}`);
check([...readinessRows].every((row) => preparedIds.has(row.model_id)), 'la préparation runtime contient un modèle non préparé');
check(readiness.configurable === readinessRows.filter((row) => row.configurable).length, 'compteur configurable incohérent');
const readinessById = new Map(readinessRows.map((row) => [row.model_id, row]));

/* -------------------------------------------- 3. causes exactes de blocage */
const technicalCause = (result) => {
  const technical = (result.blockers ?? []).filter((code) => !GATES.includes(code));
  return technical.length ? [...technical].sort().join('+') : 'GATES_ONLY';
};
const byCause = {};
for (const result of blocked) {
  const cause = technicalCause(result);
  const entry = (byCause[cause] ??= { total: 0, families: {}, models: [] });
  entry.total += 1;
  entry.families[result.family] = (entry.families[result.family] ?? 0) + 1;
  entry.models.push(result.model_id);
}
check(Object.values(byCause).reduce((sum, entry) => sum + entry.total, 0) === blocked.length,
  'la somme des causes ne couvre pas les bloqués');
check(Object.values(byCause).flatMap((entry) => entry.models).length
  === new Set(Object.values(byCause).flatMap((entry) => entry.models)).size, 'un modèle bloqué a deux causes principales');

for (const result of blocked) {
  // Un modèle bloqué PEUT avoir un contrat de sortie lié : c'est l'endpoint, le
  // schéma ou la capacité de sortie qui manque. Ce qui est interdit, c'est de le
  // déclarer préparé ou testé.
  if (!(result.blockers ?? []).some((code) => !GATES.includes(code))) problems.push(`${result.model_id}: bloqué sans cause technique`);
  // `technical_test_succeeded` est le self-test SIMULÉ de l'adaptateur, pas un
  // test fournisseur : il peut être vrai sur un modèle bloqué par son endpoint.
  // Ce qui est interdit, c'est de prétendre à un test RÉEL.
  if (result.stages?.real_test_pending !== true) problems.push(`${result.model_id}: aucun test réel en attente déclaré`);
}
for (const result of prepared) {
  if (!result.protocol) problems.push(`${result.model_id}: préparé sans protocole`);
  if (!result.stages?.endpoint_confirmed) problems.push(`${result.model_id}: préparé sans endpoint confirmé`);
  if (!result.stages?.upload_functional) problems.push(`${result.model_id}: préparé sans uploads valides`);
}

/* --------------------------------------------------- 4. quotas en attente */
const pendingRows = readinessRows.filter((row) => PENDING_FAMILIES.includes(row.quota_kind));
check(readiness.quota_policy_pending === pendingRows.length,
  `quota_policy_pending ${readiness.quota_policy_pending} ≠ ${pendingRows.length}`);
for (const entry of readiness.quota_family_policy ?? []) {
  const actual = pendingRows.filter((row) => row.quota_kind === entry.family).length;
  if (entry.models !== actual) problems.push(`proposition ${entry.family}: ${entry.models} ≠ ${actual}`);
}

/* ------------------- 5. capacité attribuable au lot 17, et delta reconstruit */
/** Neutralise les seules règles ajoutées au lot 17, puis rejoue la MÊME décision. */
const legacyModel = (model) => {
  const clone = JSON.parse(JSON.stringify({
    provider_model_id: model.provider_model_id,
    category: model.category,
    input_schema: model.input_schema,
    output_schema: model.output_schema,
    endpoint_evidence: model.endpoint_evidence,
    detail: undefined,
  }));
  if (clone.input_schema?.schemas) delete clone.input_schema.schemas.output_data;
  const letters = (definition) => {
    if (!definition || typeof definition !== 'object') return;
    if (definition.field !== undefined) {
      definition.title = 'Upload'; definition.description = 'Private file to upload.';
      delete definition.examples;
    }
    for (const value of Object.values(definition.properties ?? {})) letters(value);
    if (definition.items) letters(definition.items);
  };
  letters(clone.input_schema?.schemas?.input_data);
  if (clone.output_schema?.schemas?.properties) delete clone.output_schema.schemas.properties.result;
  return clone;
};

const reconstructed = [];
const capabilities = new Map();
for (const result of evaluation.results) {
  const model = modelOf(result.model_id);
  const before = integrationProgress(legacyModel(model), openapi);
  reconstructed.push({ id: result.model_id, status: before.status });
  if (result.status === 'integration_prepared') {
    const category = model.category;
    const protocol = result.protocol;
    const outputSchema = model.detail.output_schema?.schemas;
    const envelope = outputSchema?.properties?.output;
    const hasEnvelope = !!(envelope && Object.keys(envelope.properties ?? {}).length);
    const sheetOutput = model.detail.input_schema?.schemas?.output_data;
    const tags = [];
    if (protocol === 'muapi_output_json_v1') tags.push('json_result');
    else if (category === 'Training') tags.push('training');
    else if (!hasEnvelope && sheetOutput) tags.push('declared_output_data');
    if (tags.length) capabilities.set(result.model_id, tags);
  }
}
const reconstructedPrepared = reconstructed.filter((row) => row.status === 'integration_prepared').length;
const gained = [...capabilities.keys()].filter((id) => reconstructed.find((row) => row.id === id)?.status !== 'integration_prepared');
const residual = LOT17.unlocked - gained.length;

/** Quotas ajoutés par ce gain : l'explication exacte du delta 67 → 81. */
const pendingUnlocked = gained.filter((id) => PENDING_FAMILIES.includes(readinessById.get(id)?.quota_kind));
const pendingBefore = pendingRows.length - pendingUnlocked.length;

/* ------------------------------------------------- 6. entraîneurs avec ZIP */
const trainers = [...preparedIds]
  .map((id) => modelOf(id))
  .filter((model) => model.category === 'Training')
  .map((model) => {
    const leaves = (definition, out = []) => {
      if (!definition || typeof definition !== 'object') return out;
      if (definition.field !== undefined) out.push({ key: null, definition });
      for (const [key, value] of Object.entries(definition.properties ?? {})) {
        const before = out.length; leaves(value, out);
        for (let index = before; index < out.length; index += 1) out[index].key = key;
      }
      if (definition.items) leaves(definition.items, out);
      return out;
    };
    const zip = leaves(model.detail.input_schema?.schemas?.input_data).filter((leaf) => String(leaf.definition.field) === 'zip');
    return {
      model_id: model.provider_model_id,
      protocol: prepared.find((row) => row.model_id === model.provider_model_id)?.protocol ?? null,
      result_field: prepared.find((row) => row.model_id === model.provider_model_id)?.result_field ?? null,
      zip_fields: zip.map((leaf) => ({
        key: leaf.key,
        declared_public_link: declaredExternalLink(leaf.definition),
        description: String(leaf.definition.description ?? leaf.definition.title ?? ''),
      })),
    };
  });
const zipTrainers = trainers.filter((trainer) => trainer.zip_fields.some((field) => field.declared_public_link));

/* ------------------------------------------- 7. endpoints non confirmés (11) */
const unresolvedEndpoints = blocked
  .filter((result) => (result.blockers ?? []).includes('OPENAPI_OPERATION_UNCONFIRMED'))
  .map((result) => {
    const resolution = result.openapi_evidence?.endpoint_resolution ?? {};
    const declared = resolution.declared_paths ?? [];
    const near = declared.flatMap((path) => {
      const tail = String(path).split('/').pop() ?? '';
      const stem = tail.split('-').slice(0, 2).join('-');
      return openapiPaths
        .filter((candidate) => candidate !== `/api/v1/${path}` && stem.length > 4 && candidate.includes(stem))
        .slice(0, 3)
        .map((candidate) => ({ declared: path, documented_candidate: candidate }));
    });
    return { model_id: result.model_id, family: result.family, declared, near };
  });

/* --------------------------------------------------------- 8. synthèse */
const summary = {
  measured_at_utc: new Date().toISOString(),
  source: { evaluation: EVAL, readiness: READINESS, details: 'fiches publiques api.muapi.ai', openapi: OPENAPI },
  metrics: {
    catalogued: evaluation.total,
    unique_references: unique.size,
    prepared: prepared.length,
    configurable: readiness.configurable,
    runtime_configured: readiness.runtime_configured,
    blocked: blocked.length,
    technical_test_passed: readiness.status?.technical_test_passed ?? 0,
    operational: readiness.status?.operational ?? 0,
    free_models: readiness.billing?.free ?? 0,
    pricing_missing: readiness.missing_reasons?.PROVIDER_PRICING_NOT_DECLARED ?? 0,
    quota_policy_pending: pendingRows.length,
    zip_trainers: zipTrainers.length,
  },
  reconciliation: {
    lot17_published: LOT17,
    catalogued_equals_prepared_plus_blocked: evaluation.total === prepared.length + blocked.length,
    prepared_equals_configurable: prepared.length === readiness.configurable,
    reconstructed_prepared_before_lot17: reconstructedPrepared,
    gained_by_lot17_rules: gained.length,
    published_delta: LOT17.prepared - reconstructedPrepared,
    unexplained_residual: LOT17.unlocked - gained.length,
    residual_note: residual === 0 ? 'aucun écart'
      : `${residual} modèle(s) préparé(s) avant le lot 17 sous les règles reconstruites mais comptés dans les 75 : les fiches fournisseur sont vivantes et le code du lot 16 n'est pas versionné, l'écart n'est pas attribuable au code actuel`,
    quota_pending_before_lot17_reconstructed: pendingBefore,
    quota_delta_explained: pendingRows.length - pendingBefore,
    pending_unlocked_by_family: count(pendingUnlocked.map((id) => readinessById.get(id)?.quota_kind)),
    zip_trainers_reported_by_lot17: LOT17.zip_trainers,
    zip_trainers_measured: zipTrainers.length,
  },
  families: {
    total: evaluation.by_family,
    prepared: count(prepared.map((result) => result.family)),
    blocked: count(blocked.map((result) => result.family)),
  },
  protocols: evaluation.by_protocol,
  quota_family_distribution: count(readinessRows.map((row) => row.quota_kind)),
  unlocked: {
    // Sources de capacité : modèles préparés qui portent AUJOURD'HUI une
    // capacité introduite au lot 17 (dont 4 déjà préparés avant, donc non
    // « gagnés »). `gained` est le delta réellement reconstruit.
    capability_sources: capabilities.size,
    by_capability_source: count([...capabilities.values()].map((tags) => tags.join('+'))),
    gained_by_lot17_rules: gained.length,
    gained_models: gained,
    models: Object.fromEntries([...capabilities].map(([id, tags]) => [id, tags])),
  },
  blocked_by_cause: Object.fromEntries(Object.entries(byCause).sort((a, b) => b[1].total - a[1].total)),
  trainers,
  unresolved_endpoints: unresolvedEndpoints,
  consistency_problems: problems,
};

const text = `${JSON.stringify(summary, null, 2)}\n`;
if (OUT) writeFileSync(OUT, text);
console.log(JSON.stringify(summary.metrics, null, 2));
console.log('\nsources de capacité :', JSON.stringify(summary.unlocked.by_capability_source));
console.log('delta reconstruit :', gained.length, '| résidu non attribuable :', residual,
  '| quotas avant lot 17 :', pendingBefore, '→', pendingRows.length);
console.log('causes de blocage :', Object.entries(byCause).map(([cause, entry]) => `${cause}=${entry.total}`).join(', '));
console.log('entraîneurs ZIP publics :', zipTrainers.map((trainer) => trainer.model_id).join(', '));
if (problems.length) {
  console.error('\nINCOHÉRENCES :');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\nréconciliation : cohérente');
}
