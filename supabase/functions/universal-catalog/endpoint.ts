/** Only official declarations are authority. Never infer an endpoint from ID. */
export type EndpointBinding = { status: 'declared'; path: string; url: string; differs: boolean } | { status: 'missing' | 'invalid' | 'conflict'; path: null; url: null; differs: false };
const object = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string,unknown> : {};
export function resolveMuapiEndpoint(modelId: string, schema: unknown, evidence?: unknown): EndpointBinding {
  const root = object(object(object(schema).schemas).input_data);
  const official = object(evidence);
  const candidates = [root.endpoint_url, official.endpoint_url, official.endpoint].filter(x => x !== undefined && x !== null && x !== '');
  const failure = (status: 'missing' | 'invalid' | 'conflict'): EndpointBinding => ({ status, path: null, url: null, differs: false });
  if (!candidates.length) return failure('missing');
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') return failure('invalid');
    const path = candidate.startsWith('/api/v1/') ? candidate.slice(8) : candidate;
    // Supports official multi-segment paths; disallows redirects, traversal,
    // escapes, query strings, foreign origins and inferred aliases.
    if (path.length > 240 || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$/.test(path)) return failure('invalid');
    paths.push(path);
  }
  if (new Set(paths).size !== 1) return failure('conflict');
  return { status: 'declared', path: paths[0], url: `https://api.muapi.ai/api/v1/${paths[0]}`, differs: paths[0] !== modelId };
}
