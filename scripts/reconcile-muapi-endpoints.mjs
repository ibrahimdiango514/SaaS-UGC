#!/usr/bin/env node
/**
 * Réconciliation hors-ligne des conflits d'endpoints MuAPI.
 *
 * Aucune écriture base, aucun appel fournisseur payant : le script relit
 * l'OpenAPI public officiel et les déclarations constatées en lecture seule
 * (connecteur Supabase), puis exécute le MÊME résolveur que le worker Edge.
 *
 *   node scripts/reconcile-muapi-endpoints.mjs \
 *     --openapi /tmp/muapi-openapi.json \
 *     --declarations tests/fixtures/muapi-endpoint-conflicts-20261120.json
 *
 * Sortie : transitions par modèle + mesure atomique (total/préparés/bloqués).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveMuapiEndpoint } from '../supabase/functions/universal-catalog/endpoint.ts';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const openapiPath = arg('openapi', '/tmp/muapi-openapi.json');
const declarationsPath = arg('declarations', 'tests/fixtures/muapi-endpoint-conflicts-20261120.json');
const outPath = arg('out', '');

const openapi = JSON.parse(readFileSync(openapiPath, 'utf8'));
const rows = JSON.parse(readFileSync(declarationsPath, 'utf8'));
const sha256 = openapi.__document_sha256 ?? null;
if (!sha256) console.warn('attention : __document_sha256 absent de l\'OpenAPI fourni');

const transitions = rows.map((row) => {
  const schema = { schemas: { input_data: { type: 'object', endpoint_url: row.schema_endpoint } } };
  const evidence = { endpoint: row.evidence_endpoint, endpoint_url: row.evidence_endpoint_url };
  const binding = resolveMuapiEndpoint(row.model_id, schema, evidence, openapi);
  const blockers = Array.isArray(row.blockers) ? row.blockers : [];
  // These two gates are universal: every model keeps them until a real paid test.
  const UNIVERSAL = new Set(['CONSTRAINT_REVIEW_REQUIRED', 'REAL_TEST_PENDING']);
  const remaining = blockers.filter((b) => b !== 'ENDPOINT_CONFLICT' && !UNIVERSAL.has(b));
  return {
    model_id: row.model_id,
    before: blockers.includes('ENDPOINT_CONFLICT') ? 'ENDPOINT_CONFLICT' : 'none',
    status: binding.status,
    resolution: binding.status === 'declared' ? binding.resolution : null,
    path: binding.path,
    operation_id: binding.operation_id,
    remaining_blockers: remaining,
    after: remaining.length ? 'blocked' : 'integration_prepared',
  };
});

const resolved = transitions.filter((t) => t.status === 'declared');
const unresolved = transitions.filter((t) => t.status !== 'declared');
const prepared = transitions.filter((t) => t.after === 'integration_prepared');
const byResolution = resolved.reduce((acc, t) => ({ ...acc, [t.resolution]: (acc[t.resolution] ?? 0) + 1 }), {});

const summary = {
  measured_at_utc: new Date().toISOString(),
  source: { openapi: 'https://api.muapi.ai/openapi.json', declarations: declarationsPath, scope: 'read-only' },
  total: rows.length,
  conflicts_resolved: resolved.length,
  conflicts_unresolved: unresolved.length,
  newly_prepared: prepared.length,
  still_blocked_other_cause: resolved.length - prepared.length,
  by_resolution: byResolution,
  transitions,
};

for (const t of transitions) {
  console.log(
    `${t.model_id.padEnd(48)} ${String(t.status).padEnd(10)} ${String(t.resolution ?? '-').padEnd(28)} -> ${t.after}` +
      (t.status === 'declared' ? ` (${t.path})` : ''),
  );
}
console.log('\n' + JSON.stringify({ ...summary, transitions: undefined }, null, 2));
if (outPath) writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
if (unresolved.length) process.exitCode = 2;
