// Banc PostgREST — harnais commun aux suites de tests (appels REST + compteurs).
import assert from 'node:assert/strict';
export { assert };

export function makeHarness({ baseUrl, title, log = (m) => console.log(m) }) {
  let passed = 0;
  const checks = [];
  const ok = (label, detail = null) => { passed += 1; checks.push({ ok: true, label, detail }); log(`  ✓ ${label}`); };
  const bad = (label, detail = null) => { checks.push({ ok: false, label, detail }); log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); throw new Error(`vérification échouée : ${label}`); };
  const check = (cond, label, detail = null) => (cond ? ok(label, detail) : bad(label, detail));

  async function http(method, path, { token = null, body = null, prefer = null, accept = null, raw = false } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    headers.apikey = 'bench-anon';
    if (body != null) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    if (accept) headers.Accept = accept;
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* pas de JSON */ }
    return { status: res.status, headers: res.headers, text, json, raw };
  }
  const rpc = (token, fn, args = {}, opts = {}) => http('POST', `/rest/v1/rpc/${fn}`, { token, body: args, ...opts });
  const get = (token, path, opts = {}) => http('GET', path, { token, ...opts });
  const post = (token, path, body, opts = {}) => http('POST', path, { token, body, ...opts });
  const patch = (token, path, body, opts = {}) => http('PATCH', path, { token, body, ...opts });
  const del = (token, path, opts = {}) => http('DELETE', path, { token, ...opts });

  const finish = () => ({ title, passed, failed: checks.filter((c) => !c.ok).length, total: checks.length, checks });
  return { ok, bad, check, http, rpc, get, post, patch, del, finish };
}
