// Banc PostgREST — signature et vérification des JWT de test (HS256).
//
// Clé de test GÉNÉRÉE à chaque exécution (aucun secret de production n'est
// jamais lu, copié ni commité) : 32 octets aléatoires, équivalent d'un
// JWT_SECRET Supabase de test.
import crypto from 'node:crypto';

export const AUDIENCE = 'authenticated'; // audience des access tokens Supabase
export const ISSUER = 'https://vyora-bench.local/auth/v1';

export function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signJwt(claims, secret, { now = Date.now() / 1000 } = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = {
    iss: ISSUER,
    aud: AUDIENCE,
    iat: Math.floor(now),
    exp: Math.floor(now) + 3600,
    ...claims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    return { header: JSON.parse(Buffer.from(parts[0], 'base64url')), claims: JSON.parse(Buffer.from(parts[1], 'base64url')), signature: parts[2] };
  } catch {
    return null;
  }
}

// Vérification conforme PostgREST (bibliothèque jwt) : signature HS256,
// exp/nbf avec 30 s de jeu (allowedSkew 30), audience strictement égale.
export function verifyJwt(token, secret, { audience = AUDIENCE, now = Date.now() / 1000, skew = 30 } = {}) {
  const decoded = decodeJwt(token);
  if (!decoded) return { ok: false, error: 'invalid token format' };
  if (decoded.header.alg !== 'HS256') return { ok: false, error: 'invalid JWT algorithm' };
  const [head, payload] = String(token).split('.');
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${payload}`).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(decoded.signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'invalid JWT secret' };
  const { exp, nbf, aud } = decoded.claims;
  if (typeof exp === 'number' && exp < now - skew) return { ok: false, error: 'JWT expired' };
  if (typeof nbf === 'number' && nbf > now + skew) return { ok: false, error: 'JWT not valid yet' };
  if (audience && aud !== audience) return { ok: false, error: `JWT audience "${aud}" does not match "${audience}"` };
  return { ok: true, claims: decoded.claims };
}

// Jeton utilisateur Supabase (sub/role/aud/email + claims de test).
// `exp` (epoch) permet de forger des tokens expirés ou à la limite du jeu.
export function userToken(secret, { sub, role = 'authenticated', email, metadata, company, exp = null } = {}) {
  return signJwt({
    sub, role, email,
    user_metadata: metadata ?? {},
    app_metadata: { provider: 'email' },
    ...(company ? { company } : {}),
    ...(exp !== null ? { exp } : {}),
  }, secret);
}

// Jeton service_role (le « service key ») : sub = un identifiant serveur.
export function serviceToken(secret, sub = '00000000-0000-4000-8000-000000000000') {
  return signJwt({ sub, role: 'service_role' }, secret);
}
