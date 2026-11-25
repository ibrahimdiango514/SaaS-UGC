#!/usr/bin/env node
/**
 * Évaluation hors-ligne des 867 références MuAPI avec le code du worker.
 *
 * Pourquoi ce script existe : le worker `studio-runtime` ne peut mesurer le
 * catalogue qu'en production, en écrivant en base. Avant tout déploiement, on
 * veut la même mesure, avec le MÊME code (`integrationProgress`), sans écrire
 * en base, sans clé fournisseur, sans dépense.
 *
 * Source de données, exclusivement officielle et publique (aucune clé) :
 *   GET https://api.muapi.ai/api/v1/models          → listing (867 entrées)
 *   GET https://api.muapi.ai/api/v1/models/{name}   → fiche (input/output schema)
 * Ce sont exactement les deux appels que font `fetchMuapiCatalog` et
 * `fetchMuapiDetail` ; les fiches sont mises en cache disque pour que deux
 * exécutions consécutives portent sur les mêmes octets.
 *
 *   node scripts/evaluate-muapi-catalog.mjs --out /tmp/eval.json
 *   node scripts/evaluate-muapi-catalog.mjs --cached --repeat 2
 *
 * Aucune écriture Supabase. Aucun appel de génération. Aucun crédit.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { integrationProgress } from '../supabase/functions/studio-runtime/families.ts';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const CACHE = arg('cache', '/tmp/muapi-details');
const OUT = arg('out', '');
const OPENAPI = arg('openapi', '/tmp/muapi-openapi.json');
const LISTING = arg('listing', '/tmp/muapi-models.json');
const REPEAT = Number(arg('repeat', '2'));
const CONCURRENCY = Number(arg('concurrency', '8'));
const BASE = 'https://api.muapi.ai';

async function getJson(url, attempts = 4) {
  let last = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 404) return { status: 404, body: null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, body: JSON.parse(await res.text()) };
    } catch (error) {
      last = String(error?.message ?? error);
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: ${last}`);
}

/** Listing public : c'est la source de vérité du périmètre (867 références). */
async function listing() {
  if (flag('cached') && existsSync(LISTING)) return JSON.parse(readFileSync(LISTING, 'utf8'));
  const { body } = await getJson(`${BASE}/api/v1/models`);
  writeFileSync(LISTING, JSON.stringify(body));
  return body;
}

/** Fiche détaillée de chaque modèle, mise en cache (une requête GET gratuite). */
async function details(names) {
  mkdirSync(CACHE, { recursive: true });
  const missing = names.filter((name) => !existsSync(join(CACHE, `${encodeURIComponent(name)}.json`)));
  let done = 0;
  let failed = 0;
  for (let offset = 0; offset < missing.length; offset += CONCURRENCY) {
    const slice = missing.slice(offset, offset + CONCURRENCY);
    await Promise.all(slice.map(async (name) => {
      try {
        const { status, body } = await getJson(`${BASE}/api/v1/models/${encodeURIComponent(name)}`);
        writeFileSync(join(CACHE, `${encodeURIComponent(name)}.json`), JSON.stringify({ status, body }));
        done += 1;
      } catch {
        failed += 1;
      }
    }));
    if (slot++ % 10 === 0) process.stderr.write(`\rfiches: ${done + failed}/${missing.length} (échecs ${failed})   `);
  }
  if (missing.length) process.stderr.write('\n');
  const cache = {};
  for (const file of readdirSync(CACHE)) {
    if (!file.endsWith('.json')) continue;
    cache[decodeURIComponent(file.slice(0, -5))] = JSON.parse(readFileSync(join(CACHE, file), 'utf8'));
  }
  return cache;
}
let slot = 0;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Fiche → ligne de modèle, exactement comme `studio_save_muapi_detail`. */
function rowFrom(name, cached) {
  const detail = cached?.body?.data ?? cached?.body ?? null;
  if (!detail || typeof detail !== 'object') return null;
  const endpoint_evidence = {
    endpoint: detail.endpoint ?? null,
    endpoint_url: detail.endpoint_url ?? null,
    source_url: `${BASE}/api/v1/models/${encodeURIComponent(name)}`,
    observed_at: 'cached',
    http_status: cached.status ?? 200,
  };
  return {
    provider_model_id: name,
    category: typeof detail.category === 'string' ? detail.category : '',
    input_schema: detail.input_schema ? { ...detail.input_schema, vyora_endpoint_evidence: endpoint_evidence } : null,
    output_schema: detail.output_schema ?? null,
    endpoint_evidence,
  };
}

const count = (values) => values.reduce((acc, value) => {
  const key = value ?? '(aucun)';
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

async function main() {
  const listingBody = await listing();
  const names = (listingBody.models ?? []).map((model) => model.name).filter((name) => typeof name === 'string');
  const cache = await details(names);

  const openapiText = readFileSync(OPENAPI, 'utf8');
  const openapi = JSON.parse(openapiText);
  // Même empreinte que le worker : SHA-256 des octets du document officiel.
  openapi.__document_sha256 = sha256(openapiText);

  const missingDetail = [];
  const results = [];
  for (const name of names) {
    const row = rowFrom(name, cache[name]);
    if (!row) {
      missingDetail.push(name);
      continue;
    }
    // Deux exécutions indépendantes : la sortie doit être identique octet pour octet.
    const first = integrationProgress(row, openapi);
    const repeats = [];
    for (let index = 1; index < REPEAT; index += 1) repeats.push(JSON.stringify(integrationProgress(row, openapi)));
    const deterministic = repeats.every((value) => value === JSON.stringify(first));
    results.push({ ...first, model_id: name, deterministic, input_signature: undefined });
  }

  const prepared = results.filter((result) => result.status === 'integration_prepared');
  const blocked = results.filter((result) => result.status !== 'integration_prepared');
  const blockers = count(blocked.flatMap((result) => result.blockers));
  const causes = count(blocked.map((result) => result.blockers.filter(
    (code) => !['CONSTRAINT_REVIEW_REQUIRED', 'REAL_TEST_PENDING'].includes(code),
  ).join('+') || 'GATES_ONLY'));

  const summary = {
    measured_at_utc: new Date().toISOString(),
    source: {
      code: 'supabase/functions/studio-runtime/families.ts@worktree',
      protocol_version: results[0]?.version ?? null,
      listing: `${BASE}/api/v1/models`,
      details: `${BASE}/api/v1/models/{name}`,
      openapi: `${BASE}/openapi.json`,
      openapi_sha256: openapi.__document_sha256,
      scope: 'public, no API key, no generation, no Supabase write',
    },
    total: names.length,
    evaluated: results.length,
    missing_detail: missingDetail,
    nondeterministic: results.filter((result) => !result.deterministic).map((result) => result.model_id),
    prepared: prepared.length,
    blocked: blocked.length,
    blockers,
    blocker_combinations: causes,
    by_family: count(results.map((result) => result.family)),
    by_protocol: count(results.map((result) => result.protocol)),
    by_status_family: Object.fromEntries(
      [...new Set(results.map((result) => result.family))].sort().map((family) => {
        const rows = results.filter((result) => result.family === family);
        return [family, {
          total: rows.length,
          prepared: rows.filter((row) => row.status === 'integration_prepared').length,
          blocked: rows.filter((row) => row.status !== 'integration_prepared').length,
        }];
      }),
    ),
    results,
  };

  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (OUT) writeFileSync(OUT, text);

  const table = Object.entries(summary.by_status_family)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([family, stats]) => `${family.padEnd(20)} ${String(stats.total).padStart(4)}  prêts ${String(stats.prepared).padStart(4)}  bloqués ${String(stats.blocked).padStart(4)}`);
  console.log(table.join('\n'));
  console.log('\n' + JSON.stringify({
    total: summary.total,
    evaluated: summary.evaluated,
    prepared: summary.prepared,
    blocked: summary.blocked,
    missing_detail: summary.missing_detail.length,
    nondeterministic: summary.nondeterministic.length,
    blockers: summary.blockers,
    by_protocol: summary.by_protocol,
  }, null, 2));
  if (summary.missing_detail.length || summary.nondeterministic.length) process.exitCode = 2;
}

await main();
