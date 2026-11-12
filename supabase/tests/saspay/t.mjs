// Outils de scénario : exécute les RPC comme PostgREST (rôle + revendications JWT).
import { client, readMigration } from './pg.mjs';
import assert from 'node:assert/strict';
export { assert };
export async function connectAs(role, sub = null) {
  const c = client('authenticator'); await c.connect();
  await c.query(`set role ${role}`);
  await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role, ...(sub ? { sub } : {}) })]);
  return c;
}
export async function rpc(c, name, args) {
  const keys = Object.keys(args);
  const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  const res = await c.query(sql, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
  return res.rows[0].r;
}
export async function fails(promise, pattern, label) {
  try { await promise; } catch (e) { assert.match(e.message, pattern, `${label}: ${e.message}`); return e.message; }
  assert.fail(`${label}: aurait dû échouer (${pattern})`);
}
let passed = 0;
export function ok(label) { passed += 1; console.log('  ✓', label); }
export function summary() { console.log(`\n${passed} vérifications réussies`); }
export async function applyMigration(file) {
  const db = client('postgres'); await db.connect();
  try { await db.query(readMigration(file)); }
  catch (e) { const sql = readMigration(file); console.log('MIGRATION FAIL', e.message, e.position ? `→ …${sql.slice(Math.max(0, e.position - 250), +e.position + 120)}…` : '', e.where ?? ''); await db.end(); process.exit(1); }
  await db.end();
}
