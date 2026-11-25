/** Only official declarations are authority. Never infer an endpoint from ID.
 *
 * A model sheet and its detail evidence can declare two different paths. That is
 * a real conflict, not a reason to guess. This module resolves it ONLY when the
 * official MuAPI OpenAPI document proves which declaration is executable:
 *
 *  - exactly one declared path exists as a documented POST operation;
 *  - or two documented POST operations share the same request/response contract
 *    (only `operationId`, `summary` and `description` may differ), in which case
 *    one canonical path is chosen and both are kept as evidence.
 *
 * Everything else stays a conflict. The chosen proof is persisted as
 * `endpoint_evidence.resolution` so later runs (and the runtime) keep using the
 * same path without re-reading the document; changing declarations invalidates
 * that recorded proof, which forces a fresh resolution.
 */
export type EndpointResolution =
  | 'declared'
  | 'openapi_single'
  | 'openapi_equivalent_contracts'
  | 'recorded_evidence';
export type EndpointResolutionStatus = 'missing' | 'invalid' | 'conflict' | 'declared';
export interface RecordedResolution {
  status: 'resolved';
  path: string;
  resolution: EndpointResolution;
  operation_id: string | null;
  contract_fingerprint: string;
  document_sha256: string | null;
  declared_paths: string[];
  documented_paths: string[];
}
export type EndpointBinding =
  | {
      status: 'declared';
      path: string;
      url: string;
      differs: boolean;
      resolution: EndpointResolution;
      operation_id: string | null;
      contract_fingerprint: string | null;
      document_sha256: string | null;
      declared_paths: string[];
      documented_paths: string[];
    }
  | {
      status: 'missing' | 'invalid' | 'conflict';
      path: null;
      url: null;
      differs: false;
      declared_paths: string[];
      documented_paths: string[];
    };

const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const text = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const PATH = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$/;
const RESOLUTIONS: EndpointResolution[] = ['declared', 'openapi_single', 'openapi_equivalent_contracts', 'recorded_evidence'];

/** Accepts `path` or `/api/v1/path` and returns a safe relative path, or null. */
function normalizePath(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const raw = candidate.trim();
  if (raw.length > 260) return null;
  const path = raw.startsWith('/api/v1/') ? raw.slice(8) : raw;
  if (!path || path.length > 240 || !PATH.test(path)) return null;
  return path;
}

function declaredPaths(schema: unknown, evidence: unknown): string[] | null {
  const root = object(object(object(schema).schemas).input_data);
  const official = object(evidence);
  const candidates = [root.endpoint_url, official.endpoint_url, official.endpoint]
    .filter((x) => x !== undefined && x !== null && x !== '');
  const paths: string[] = [];
  for (const candidate of candidates) {
    const path = normalizePath(candidate);
    if (!path) return null; // invalid evidence never silently falls back
    paths.push(path);
  }
  return paths;
}

/** Stable JSON used to compare two officially documented operations. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
/** Deterministic contract fingerprint (two independent 32-bit lanes). */
function fingerprint(value: unknown): string {
  const source = stable(value);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b + code, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
/** Only the functional contract is compared; labels are not behaviour. */
function contractOf(operation: unknown): string {
  const op = object(operation);
  return fingerprint({ requestBody: op.requestBody ?? null, responses: op.responses ?? null, tags: op.tags ?? null });
}
function postOperation(openapi: unknown, path: string): Record<string, unknown> | null {
  const paths = object(object(openapi).paths);
  const entry = object(paths[`/api/v1/${path}`]);
  const post = entry.post;
  return post && typeof post === 'object' && !Array.isArray(post) ? (post as Record<string, unknown>) : null;
}
function recordedResolution(evidence: unknown, declared: string[]): RecordedResolution | null {
  const recorded = object(object(evidence).resolution);
  if (text(recorded.status, 20) !== 'resolved') return null;
  const path = normalizePath(recorded.path);
  if (!path || !declared.includes(path)) return null;
  const resolution = text(recorded.resolution, 40) as EndpointResolution;
  if (!RESOLUTIONS.includes(resolution) || resolution === 'recorded_evidence') return null;
  const storedDeclared = Array.isArray(recorded.declared_paths)
    ? recorded.declared_paths.filter((x): x is string => typeof x === 'string')
    : [];
  if (storedDeclared.length !== declared.length) return null;
  const left = [...storedDeclared].sort().join('\u0000');
  const right = [...declared].sort().join('\u0000');
  if (left !== right) return null;
  const operationId = text(recorded.operation_id, 200) || null;
  const documented = Array.isArray(recorded.documented_paths)
    ? recorded.documented_paths.filter((x): x is string => typeof x === 'string').slice(0, 8)
    : [];
  return {
    status: 'resolved',
    path,
    resolution,
    operation_id: operationId,
    contract_fingerprint: text(recorded.contract_fingerprint, 64),
    document_sha256: /^[0-9a-f]{64}$/.test(text(recorded.document_sha256, 64)) ? text(recorded.document_sha256, 64) : null,
    declared_paths: [...declared].sort(),
    documented_paths: documented,
  };
}

export function resolveMuapiEndpoint(
  modelId: string,
  schema: unknown,
  evidence?: unknown,
  openapi?: unknown,
): EndpointBinding {
  const declared = declaredPaths(schema, evidence);
  const fail = (status: 'missing' | 'invalid' | 'conflict', documented: string[] = []): EndpointBinding => ({
    status,
    path: null,
    url: null,
    differs: false,
    declared_paths: declared ? [...declared].sort() : [],
    documented_paths: documented,
  });
  if (declared === null) return fail('invalid');
  if (!declared.length) return fail('missing');

  const unique = [...new Set(declared)];
  const documented = unique.filter((path) => postOperation(openapi, path) !== null);
  const base = {
    differs: false,
    operation_id: null as string | null,
    contract_fingerprint: null as string | null,
    document_sha256: text(object(openapi).__document_sha256, 64) || null,
    declared_paths: [...unique].sort(),
    documented_paths: documented.sort(),
  };
  const resolved = (
    path: string,
    resolution: EndpointResolution,
    operationId: string | null,
    contract: string | null,
    documentSha: string | null,
  ): EndpointBinding => ({
    status: 'declared',
    path,
    url: `https://api.muapi.ai/api/v1/${path}`,
    differs: path !== modelId,
    resolution,
    operation_id: operationId,
    contract_fingerprint: contract,
    document_sha256: documentSha,
    declared_paths: base.declared_paths,
    documented_paths: base.documented_paths,
  });

  // One declaration: official by itself, no inference involved.
  if (unique.length === 1) return resolved(unique[0], 'declared', null, null, base.document_sha256);

  // A previously recorded proof stays valid only for the exact same declarations.
  const recorded = recordedResolution(evidence, unique);
  if (recorded) {
    // Keep the ORIGINAL proof label so a replayed evaluation produces the exact
    // same evidence object (no hourly invalidation, no invalid report).
    return resolved(recorded.path, recorded.resolution, recorded.operation_id, recorded.contract_fingerprint || null, recorded.document_sha256);
  }

  // Exactly one declared path is a documented POST operation.
  if (documented.length === 1) {
    const path = documented[0];
    const operation = postOperation(openapi, path);
    return resolved(path, 'openapi_single', text(operation?.operationId, 200) || null, fingerprint(operation ?? null), base.document_sha256);
  }

  // Two documented POST operations with an identical functional contract.
  if (documented.length === 2) {
    const [first, second] = documented;
    const contractFirst = contractOf(postOperation(openapi, first));
    const contractSecond = contractOf(postOperation(openapi, second));
    if (contractFirst === contractSecond) {
      // Canonical choice: the path named after the model itself when documented,
      // otherwise the lexicographically smallest documented path.
      const path = documented.includes(modelId) ? modelId : [...documented].sort()[0];
      const operation = postOperation(openapi, path);
      return resolved(path, 'openapi_equivalent_contracts', text(operation?.operationId, 200) || null, contractFirst, base.document_sha256);
    }
  }

  return fail('conflict', documented);
}

/** Shape persisted on the model row; null when the model is not resolvable. */
export function endpointResolutionEvidence(binding: EndpointBinding): RecordedResolution | null {
  if (binding.status !== 'declared') return null;
  return {
    status: 'resolved',
    path: binding.path,
    resolution: binding.resolution,
    operation_id: binding.operation_id,
    contract_fingerprint: binding.contract_fingerprint ?? '',
    document_sha256: binding.document_sha256,
    declared_paths: binding.declared_paths,
    documented_paths: binding.documented_paths,
  };
}
