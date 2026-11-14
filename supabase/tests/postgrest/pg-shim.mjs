// Banc PostgREST — shim `postgres` (porsager) sur node-postgres.
//
// L'Edge Function business-grow importe `npm:postgres@3.4.5` (pilote
// porsager, runtime Deno). Le banc Node exécute EXACTEMENT les mêmes requêtes
// SQL (mêmes templates taggés, mêmes paramètres, même rôle bg_edge) via
// node-postgres. Seule la couche pilote change ; le SQL exécuté par
// PostgreSQL est identique. Sous-ensemble utilisé par
// supabase/functions/business-grow/index.ts :
//   - template taggé  db`select … (${param}::uuid) …`
//   - db.json(value)  → paramètre jsonb
//   - db.array(v, n)  → paramètre tableau texte (limité à n)
//   - résultat : tableau d'objets (RowList itérable en porsager)
import pg from 'pg';

class JsonParam {
  constructor(value) { this.value = value; }
}
class ArrayParam {
  constructor(value, limit) { this.value = value; this.limit = limit; }
}

function parseUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    ssl: u.searchParams.get('sslmode') ? { rejectUnauthorized: false } : false,
  };
}

export default function postgres(url, _options = {}) {
  const conf = parseUrl(url);
  // max:1 en production → sérialisation équivalente : une seule requête à la
  // fois par « pool » de 1 connexion.
  let busy = null;
  const exec = (fn) => {
    if (busy) busy = busy.then(fn, fn);
    else busy = fn().finally(() => { busy = null; });
    return busy;
  };

  const run = async (sqlText, params) => {
    const client = new pg.Client(conf);
    try {
      await client.connect();
      const res = await client.query(sqlText, params);
      return res.rows;
    } finally {
      await client.end();
    }
  };

  const sql = (strings, ...values) => {
    const parts = Array.isArray(strings) ? strings : [String(strings)];
    let text = '';
    const params = [];
    parts.forEach((p, i) => {
      text += p;
      if (i < values.length) {
        params.push(values[i]);
        text += `$${params.length}`;
      }
    });
    return exec(() => run(text, params.map(serialize)));
  };

  sql.json = (value) => new JsonParam(value ?? null);
  sql.array = (value, limit = null) => new ArrayParam(Array.isArray(value) ? value : [], limit);

  function serialize(v) {
    if (v instanceof JsonParam) {
      // Équivalent de postgres().json() du pilote porsager : la valeur est
      // encodée en littéral JSON (chaînes encadrées, objets sérialisés). PG
      // parse ce littéral en json/jsonb.
      return JSON.stringify(v.value === undefined ? null : v.value);
    }
    if (v instanceof ArrayParam) {
      // node-postgres sérialise un tableau JS en littéral de tableau PG.
      return (v.value ?? []).map((x) => (x == null ? null : String(x))).slice(0, v.limit ?? 64);
    }
    return v;
  }

  return sql;
}
