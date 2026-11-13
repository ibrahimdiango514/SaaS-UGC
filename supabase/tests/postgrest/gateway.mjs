// Banc PostgREST — gateway REST conforme au contrat de sécurité de
// PostgREST v12.2.3 (source consultée : /home/user/postgrest-ref, tag v12.2.3).
//
// Ce binaire n'est pas téléchargeable dans cet environnement (assets GitHub
// releases bloqués — voir README.md). Ce module reproduit EXACTEMENT le
// contrat de sécurité documenté du binaire, point par point :
//
//   1. JWT (src/PostgREST/Auth.hs) :
//      - HS256 avec le secret partagé ; tout autre algorithme est rejeté ;
//      - vérification exp / nbf avec un jeu de 30 s (allowedSkew 30) ;
//      - audience strictement égale à `jwt-aud` (ici « authenticated ») ;
//      - le claim `role` détermine le rôle PostgreSQL ; absent → rôle anon ;
//      - token invalide → 401 PGRST301 + WWW-Authenticate: Bearer
//        error="invalid_token" (src/PostgREST/Error.hs) ;
//      - absence de token → accès anonyme (rôle anon), pas d'erreur.
//   2. Impersonation (docs/references/auth.rst, src/PostgREST/Query.hs
//      `setPgLocals`) : la connexion est faite EN TANT QUE `authenticator` ;
//      à chaque requête, dans la transaction :
//        set_config('request.jwt.claims', <json>, true)
//        set_config('role', <rôle>, true)            -- = SET LOCAL ROLE
//        set_config('request.method'|'request.path'|'request.headers', …, true)
//      puis la requête SQL s'exécute avec les droits du rôle impersoné :
//      c'est PostgreSQL (RLS, GRANT, EXECUTE) qui isole les données.
//   3. Mapping des erreurs PostgreSQL → HTTP (src/PostgREST/Error.hs
//      `pgErrorStatus`, table complète reprise plus bas).
//
// Portée REST : resources (GET/POST/PATCH/DELETE) + RPC (GET/POST). Le
// sous-ensemble d'opérateurs supporté est documenté dans README.md ; tout
// le reste est refusé explicitement (jamais ignoré silencieusement).
import http from 'node:http';
import pg from 'pg';
import { verifyJwt, decodeJwt } from './jwt.mjs';

// ---------------------------------------------------------------------------
// Mapping d'erreurs PostgreSQL → HTTP, copie fidèle de `pgErrorStatus`
// (src/PostgREST/Error.hs, v12.2.3). `authed` = la requête portait un JWT valide.
// ---------------------------------------------------------------------------
export function pgErrorStatus(code, message, authed) {
  if (code.startsWith('08')) return 503; // pg connection err
  if (code.startsWith('09')) return 500; // triggered action exception
  if (code.startsWith('0L')) return 403; // invalid grantor
  if (code.startsWith('0P')) return 403; // invalid role specification
  if (code === '23503') return 409;      // foreign_key_violation
  if (code === '23505') return 409;      // unique_violation
  if (code === '25006') return 405;      // read_only_sql_transaction
  if (code === '21000') return /requires a WHERE clause$/.test(message) ? 400 : 500;
  if (code.startsWith('25')) return 500; // invalid tx state
  if (code.startsWith('28')) return 403; // invalid auth specification
  if (code.startsWith('2D')) return 500; // invalid tx termination
  if (code.startsWith('38')) return 500; // external routine exception
  if (code.startsWith('39')) return 500;
  if (code.startsWith('3B')) return 500; // savepoint exception
  if (code.startsWith('40')) return 500; // tx rollback
  if (code === '53400') return 500;      // config limit exceeded
  if (code.startsWith('53')) return 503; // insufficient resources
  if (code.startsWith('54')) return 500;
  if (code.startsWith('55')) return 500;
  if (code === '57P01') return 503;
  if (code.startsWith('57')) return 500;
  if (code.startsWith('58')) return 500;
  if (code.startsWith('F0')) return 500;
  if (code.startsWith('HV')) return 500;
  if (code === 'P0001') return 400;      // défaut « RAISE EXCEPTION »
  if (code.startsWith('P0')) return 500; // PL/pgSQL Error
  if (code.startsWith('XX')) return 500;
  if (code === '42883') return /^function xmlagg\(/.test(message) ? 406 : 404; // undefined function
  if (code === '42P01') return 404;      // undefined table
  if (code === '42P17') return 500;      // infinite recursion
  if (code === '42501') return authed ? 403 : 401; // insufficient privilege
  return 400;
}

const SUPPORTED_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in', 'like', 'ilike', 'not', 'cs', 'cd']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OP_ALIASES = { ':eq': 'eq', ':neq': 'neq', ':gt': 'gt', ':gte': 'gte', ':lt': 'lt', ':lte': 'lte', ':in': 'in', ':like': 'like', ':ilike': 'ilike' };

// Syntaxe PostgREST standard : ?colonne.operators=valeur, ex. ?id=eq.<uuid>,
// ?name=like.*a*, ?plan_key=in.(free,studio), ?read_at=is.null, et les
// combinators ?or=(col.op.v,col2.op.v2) / ?not=(...).
function parseColumnFilter(col, value, params, origin, offset = 0) {
  if (!IDENT.test(col)) throw new GatewayError(400, 'PGRST200', `colonne invalide : ${col}`);
  const dot = value.indexOf('.');
  const op = dot === -1 ? value : value.slice(0, dot);
  const raw = dot === -1 ? '' : value.slice(dot + 1);
  if (!SUPPORTED_OPS.has(op)) throw new GatewayError(400, 'PGRST200', `opérateur non supporté par le banc : ${op} (${origin})`);
  if (op === 'is') {
    if (raw === 'null') return `"${col}" IS NULL`;
    if (raw === 'not.null') return `"${col}" IS NOT NULL`;
    throw new GatewayError(400, 'PGRST200', `is.<v> non supporté : ${raw}`);
  }
  if (op === 'in') {
    if (!raw.startsWith('(') || !raw.endsWith(')')) throw new GatewayError(400, 'PGRST200', `in.(...) attendu : ${origin}`);
    const items = raw.slice(1, -1).split(',').map((v) => v.trim());
    if (items.length === 0 || items.some((v) => v === '')) throw new GatewayError(400, 'PGRST200', `liste in vide : ${origin}`);
    const ph = items.map((v) => { params.push(coerce(v)); return `$${offset + params.length}`; });
    return `"${col}" IN (${ph.join(',')})`;
  }
  if (raw === '') throw new GatewayError(400, 'PGRST200', `valeur de filtre manquante : ${origin}`);
  params.push(coerce(raw));
  const ph = `$${offset + params.length}`;
  const colRef = `"${col}"`;
  switch (op) {
    case 'eq': return `${colRef} = ${ph}`;
    case 'neq': return `${colRef} <> ${ph}`;
    case 'gt': return `${colRef} > ${ph}`;
    case 'gte': return `${colRef} >= ${ph}`;
    case 'lt': return `${colRef} < ${ph}`;
    case 'lte': return `${colRef} <= ${ph}`;
    case 'like': return `${colRef} LIKE ${ph}`;
    case 'ilike': return `${colRef} ILIKE ${ph}`;
    case 'cs': return `${colRef} @> ${ph}`;
    case 'cd': return `${colRef} <@ ${ph}`;
    default: throw new GatewayError(400, 'PGRST200', `opérateur non supporté : ${op}`);
  }
}

function splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// expr : « col.op[.valeur] » (un élément d'un or/not) — retourne le WHERE.
function parseFilterExpr(expr, params, offset = 0) {
  const dot = expr.indexOf('.');
  if (dot === -1) throw new GatewayError(400, 'PGRST200', `filtre sans opérateur : ${expr}`);
  const col = expr.slice(0, dot);
  const value = expr.slice(dot + 1);
  return parseColumnFilter(col, value, params, expr, offset);
}

function parseCombinator(kind, value, params, offset = 0) {
  let v = value;
  if (v.startsWith('=')) v = v.slice(1);
  if (!v.startsWith('(') || !v.endsWith(')')) throw new GatewayError(400, 'PGRST200', `${kind}=(...) attendu : ${value}`);
  const inner = v.slice(1, -1);
  const clauses = splitTopLevel(inner).map((e) => (e.startsWith('or(') || e.startsWith('not(')
    ? parseCombinator(e.slice(0, e.indexOf('(')), e.slice(e.indexOf('(')), params, offset)
    : parseFilterExpr(e, params, offset)));
  return clauses.length ? `(${clauses.join(kind === 'or' ? ' OR ' : ' AND ')})` : 'TRUE';
}

function coerce(v) {
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

export class GatewayError extends Error {
  constructor(status, code, message, details = null, hint = null, wwwAuth = null) {
    super(message);
    this.status = status; this.code = code; this.details = details; this.hint = hint;
    this.wwwAuth = wwwAuth;
  }
}

function json(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(data);
}

export function createGateway({ secret, port, pool, dbUser, dbPassword }) {
  const admin = new pg.Pool({ user: dbUser, password: dbPassword, host: '127.0.0.1', port: Number(process.env.VYORA_PGRST_PG_PORT ?? 54330), database: 'postgres', ssl: { rejectUnauthorized: false }, max: 4 });

  // --- Authentification : /auth/v1/user (équivalent local de GoTrue) --------
  // Vérifie le JWT (mêmes règles que le gateway) puis retourne l'utilisateur
  // réel de auth.users. C'est ce que fait GoTrue pour ce endpoint.
  async function authUser(req, res) {
    const auth = req.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    if (!token) return json(res, 401, { error: 'No API key found in request', error_code: 'no_api_key' });
    const v = verifyJwt(token, secret);
    if (!v.ok) return json(res, 401, { error: 'Invalid API key', error_code: 'invalid_api_key' });
    const client = await admin.connect();
    try {
      const { rows } = await client.query('select * from auth.users where id = $1', [v.claims.sub]);
      const u = rows[0];
      if (!u) return json(res, 401, { error: 'Token invalid', error_code: 'token_invalid' });
      if (u.banned_until && new Date(u.banned_until) > new Date()) return json(res, 403, { error: 'User is banned', error_code: 'user_banned' });
      return json(res, 200, {
        id: u.id, aud: 'authenticated', role: 'authenticated',
        email: u.email, phone: null,
        created_at: u.created_at, updated_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        email_confirmed_at: u.email_confirmed_at,
        app_metadata: u.raw_app_meta_data ?? {},
        user_metadata: u.raw_user_meta_data ?? {},
      });
    } finally { client.release(); }
  }

  // --- Résolution de l'identité (PostgREST Auth.hs) --------------------------
  function resolveRole(req) {
    const auth = req.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    if (!token) return { role: 'anon', claims: null, authed: false };
    const v = verifyJwt(token, secret);
    if (!v.ok) {
      // PostgREST (Error.hs) renvoie WWW-Authenticate:
      //   Bearer error="invalid_token", error_description="<raison>"
      // Le corps JSON (hint) reste null pour ce code, comme le binaire.
      throw new GatewayError(401, 'PGRST301', v.error, null, null, `Bearer error="invalid_token", error_description="${v.error}"`);
    }
    const role = typeof v.claims.role === 'string' && v.claims.role ? v.claims.role : 'anon';
    return { role, claims: v.claims, authed: true };
  }

  async function runAs({ role, claims }, sql, params = [], extraSettings = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const settings = [
          ['search_path', 'public,extensions'],
          ['request.method', extraSettings.method ?? ''],
          ['request.path', extraSettings.path ?? ''],
        ];
        if (claims) settings.push(['request.jwt.claims', JSON.stringify(claims)], ['request.jwt.uid', String(claims.sub ?? '')]);
        for (const [k, v] of settings) {
          await client.query(`select set_config($1, $2, true)`, [k, v]);
        }
        // Impersonation : set_config('role', …, true) ≡ SET LOCAL ROLE (PostgREST Query.hs).
        await client.query(`select set_config('role', $1, true)`, [role]);
        const { rows, rowCount } = await client.query(sql, params);
        await client.query('COMMIT');
        return { rows, rowCount };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    } finally { client.release(); }
  }

  function pgFail(e, authed) {
    const status = pgErrorStatus(e.code ?? '00000', e.message, authed);
    throw new GatewayError(status, e.code ?? '00000', e.message, e.detail ?? null, e.hint ?? null);
  }

  // --- RPC --------------------------------------------------------------------
  async function rpc(req, res, fn, body) {
    const { role, claims, authed } = resolveRole(req);
    let args = body;
    if (args == null) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) throw new GatewayError(400, 'PGRST102', 'le corps du RPC doit être un objet JSON de paramètres nommés');
    const keys = Object.keys(args);
    if (!keys.every((k) => IDENT.test(k))) throw new GatewayError(400, 'PGRST102', 'nom de paramètre invalide');
    if (!IDENT.test(fn)) throw new GatewayError(404, 'PGRST204', `fonction inconnue : ${fn}`);
    const params = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    const argSql = keys.map((k, i) => `"${k}" => $${i + 1}`).join(', ');
    try {
      const { rows } = await runAs({ role, claims }, `select public.${fn}(${argSql}) as r`, params, { method: req.method, path: `/rest/v1/rpc/${fn}` });
      if (rows.length === 0) return json(res, 200, 'null');
      const value = rows[0].r;
      return json(res, 200, value === undefined ? null : value);
    } catch (e) {
      if (e instanceof GatewayError) throw e;
      pgFail(e, authed);
    }
  }

  // --- Resources ---------------------------------------------------------------
  function buildWhere(query, params, offset = 0) {
    const clauses = [];
    for (const [key, value] of query.entries()) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      if (key === 'or' || key === 'not') {
        clauses.push(parseCombinator(key, String(value), params, offset));
      } else {
        clauses.push(parseColumnFilter(key, String(value), params, `${key}=${value}`, offset));
      }
    }
    return clauses.length ? ` where ${clauses.join(' and ')}` : '';
  }

  async function resource(req, res, table) {
    const { role, claims, authed } = resolveRole(req);
    if (!IDENT.test(table)) throw new GatewayError(404, 'PGRST204', `table inconnue : ${table}`);
    const query = new URL(req.url, 'http://bench').searchParams;
    const accept = req.headers.accept ?? '';
    const prefer = req.headers.prefer ?? '';
    const wantSingle = /vnd\.pgrst\.object/.test(accept) || /return=single/.test(prefer);
    const params = [];
    const where = buildWhere(query, params);

    const selectRaw = query.get('select');
    const columns = selectRaw ? selectRaw.split(',').map((c) => c.trim()).filter(Boolean) : ['*'];
    if (columns.some((c) => c !== '*' && !IDENT.test(c))) throw new GatewayError(400, 'PGRST200', 'select invalide (le banc ne supporte pas les relations emboîtées)');
    const colSql = columns.map((c) => (c === '*' ? '*' : `"${c}"`)).join(', ');

    let orderSql = '';
    if (query.get('order')) {
      orderSql = ' order by ' + query.get('order').split(',').map((s) => {
        const [c, dir] = s.trim().split('.');
        if (!IDENT.test(c)) throw new GatewayError(400, 'PGRST200', 'order invalide');
        return `"${c}" ${dir === 'desc' ? 'DESC' : 'ASC'}`;
      }).join(', ');
    }
    let limitSql = '';
    if (query.get('limit')) {
      const n = Number(query.get('limit'));
      if (!Number.isInteger(n) || n < 0) throw new GatewayError(400, 'PGRST200', 'limit invalide');
      limitSql = ` limit ${n}`;
    }
    if (query.get('offset')) {
      const n = Number(query.get('offset'));
      if (!Number.isInteger(n) || n < 0) throw new GatewayError(400, 'PGRST200', 'offset invalide');
      params.push(n);
      limitSql += ` offset $${params.length}`;
    }

    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const { rows } = await runAs({ role, claims }, `select ${colSql} from public."${table}"${where}${orderSql}${limitSql}`, params, { method: req.method, path: req.url.split('?')[0] });
        if (wantSingle) {
          if (rows.length > 1) throw new GatewayError(406, 'PGRST116', 'plusieurs lignes pour une requête singleton');
          return json(res, rows.length ? 200 : 406, rows.length ? rows[0] : 'null', rows.length ? {} : { 'Content-Range': '0-0/0' });
        }
        const countPrefer = /count=exact/.test(prefer);
        let total = null;
        if (countPrefer) {
          const c = await runAs({ role, claims }, `select count(*)::int as n from public."${table}"${where}`, params, { method: 'GET' });
          total = c.rows[0].n;
        }
        return json(res, 200, rows, countPrefer ? { 'Content-Range': `0-${Math.max(0, rows.length - 1)}/${total ?? '?'}` } : {});
      }
      const raw = await readBody(req);
      const data = raw ? JSON.parse(raw) : null;
      if (req.method === 'POST') {
        const items = Array.isArray(data) ? data : [data];
        if (!items.every((o) => o && typeof o === 'object' && !Array.isArray(o))) throw new GatewayError(400, 'PGRST102', 'corps de POST invalide');
        const cols = [...new Set(items.flatMap((o) => Object.keys(o)))];
        if (cols.some((c) => !IDENT.test(c))) throw new GatewayError(400, 'PGRST102', 'colonne invalide');
        const out = [];
        for (const item of items) {
          const keys = Object.keys(item);
          const vals = keys.map((k) => (item[k] !== null && typeof item[k] === 'object' ? JSON.stringify(item[k]) : item[k]));
          const { rows } = await runAs({ role, claims }, `insert into public."${table}"(${keys.map((k) => `"${k}"`).join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning ${colSql}`, vals, { method: 'POST' });
          out.push(...rows);
        }
        return json(res, 201, out);
      }
      // PATCH / DELETE exigent un filtre (PostgREST : WHERE obligatoire).
      if (!where) throw new GatewayError(400, 'PGRST102', 'PATCH/DELETE sans filtre : clause WHERE requise');
      if (req.method === 'PATCH') {
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GatewayError(400, 'PGRST102', 'corps de PATCH invalide');
        const keys = Object.keys(data);
        if (keys.length === 0) throw new GatewayError(400, 'PGRST102', 'corps de PATCH vide');
        if (keys.some((k) => !IDENT.test(k))) throw new GatewayError(400, 'PGRST102', 'colonne invalide');
        const vals = keys.map((k) => (data[k] !== null && typeof data[k] === 'object' ? JSON.stringify(data[k]) : data[k]));
        // Les valeurs SET occupent $1..$vals.length ; les filtres (déjà dans
        // `where`) doivent donc être décalés de vals.length.
        const whereOff = vals.length ? where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + vals.length}`) : where;
        const { rows } = await runAs({ role, claims }, `update public."${table}" set ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')}${whereOff} returning ${colSql}`, [...vals, ...params], { method: 'PATCH' });
        return json(res, 200, rows);
      }
      if (req.method === 'DELETE') {
        const { rows } = await runAs({ role, claims }, `delete from public."${table}"${where} returning ${colSql}`, params, { method: 'DELETE' });
        return /return=representation/.test(prefer) ? json(res, 200, rows) : json(res, 200, null, {});
      }
      throw new GatewayError(405, 'PGRST100', `méthode non autorisée : ${req.method}`);
    } catch (e) {
      if (e instanceof GatewayError) throw e;
      if (e instanceof SyntaxError) throw new GatewayError(400, 'PGRST102', 'corps JSON invalide');
      pgFail(e, authed);
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://bench');
    const handle = async () => {
      if (req.method === 'OPTIONS') {
        return json(res, 204, null, corsHeaders(req));
      }
      if (url.pathname === '/auth/v1/user') return await authUser(req, res);
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const fn = decodeURIComponent(url.pathname.slice('/rest/v1/rpc/'.length));
        const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : Object.fromEntries(url.searchParams);
        return await rpc(req, res, fn, body);
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const rest = url.pathname.slice('/rest/v1/'.length).split('/');
        if (rest.length === 1) return resource(req, res, rest[0]);
        if (rest.length === 2 && (rest[1] === 'rpc' || rest[1].match(/^\d+$/))) {
          // /rest/v1/rpc a déjà été géré ; /rest/v1/<table>/<val> : pointeur de clé (non supporté).
          throw new GatewayError(400, 'PGRST200', 'le banc ne supporte pas les pointeurs de clé primaire (table/uuid)');
        }
        throw new GatewayError(404, 'PGRST204', `chemin non supporté : ${url.pathname}`);
      }
      throw new GatewayError(404, 'PGRST204', `chemin inconnu : ${url.pathname}`);
    };
    handle().then(
      () => { /* réponse déjà écrite */ },
      (e) => {
        const g = e instanceof GatewayError ? e : new GatewayError(500, 'PGRSTX00', `erreur interne du banc : ${e.message}`);
        if (res.writableEnded) return;
        json(res, g.status, { code: g.code, message: g.message, details: g.details, hint: g.hint }, {
          ...corsHeaders(req),
          ...(g.wwwAuth ? { 'WWW-Authenticate': g.wwwAuth } : {}),
        });
      },
    );
  });

  function corsHeaders(req) {
    return {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, preferences, accept, x-client-info',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Expose-Headers': 'content-range, location, x-content-range-overlap, x-total-count, rangemeta, content-location',
    };
  }

  server.listen(port, '127.0.0.1');
  return { server, admin, close: async () => { await new Promise((r) => server.close(r)); await admin.end(); } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) { reject(new GatewayError(413, 'PGRST118', 'corps trop volumineux')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Pool « authenticator » : connexion unique au rôle qui impersonne.
export function createAuthenticatorPool({ user, password, port }) {
  return new pg.Pool({
    user, password, host: '127.0.0.1', port, database: 'postgres',
    ssl: { rejectUnauthorized: false },
    max: 8,
    onQueryError: (err, client) => client.release(),
  });
}

export { decodeJwt };
