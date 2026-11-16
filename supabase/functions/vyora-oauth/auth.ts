// VYORA OAuth — vérification de l'identité de l'appelant.
//
// ## Pourquoi ce module existe
//
// L'Edge Function `vyora-oauth` est déployée avec `verify_jwt: false`, et doit
// l'être : `callback` est appelée par une redirection navigateur de Google,
// sans en-tête `Authorization`. Le passage en `verify_jwt: true` casserait le
// flux OAuth.
//
// Conséquence : la plateforme ne vérifie AUCUN jeton pour nous. Un
// `Authorization: Bearer <uuid>` arbitraire arriverait donc jusqu'au code
// métier, où il serait comparé aux `user_id` des comptes — c'est-à-dire comparé
// à lui-même. Les contrôles d'isolation deviendraient décoratifs.
//
// Ce module rétablit la vérification, action par action : seule `callback`
// reste publique, toutes les autres passent par `resolveCaller()`.
//
// ## Modèle retenu
//
// Le jeton est présenté à Supabase Auth (`GET /auth/v1/user`), qui le vérifie
// — signature, expiration, révocation — et rend l'utilisateur. Ce modèle est
// celui déjà utilisé dans ce dépôt (`authUserId()` de `business-grow`), et il a
// l'avantage de ne dépendre d'aucun secret de signature à manipuler nous-mêmes.
//
// L'identité retournée vient EXCLUSIVEMENT de cette réponse. Aucun champ du
// corps de la requête, aucun UUID décodé du jeton ne peut l'influencer.

/** Résultat d'une tentative d'authentification. */
export type AuthOutcome =
  /** Jeton vérifié : `userId` est l'identité réelle. */
  | { readonly ok: true; readonly userId: string }
  /** Jeton absent, malformé, expiré ou révoqué. */
  | { readonly ok: false; readonly reason: 'unauthenticated' }
  /** Le service d'authentification n'a pas répondu correctement. */
  | { readonly ok: false; readonly reason: 'auth_unavailable' };

export interface AuthConfig {
  /** `SUPABASE_URL` — base de l'API Auth. */
  readonly baseUrl: string;
  /** Clé publique (anon/publishable) : elle accompagne le jeton, ne le remplace pas. */
  readonly anonKey: string;
  readonly fetchImpl?: typeof fetch;
  /** Injectable pour les tests : évite une vraie attente réseau. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Résout l'identité de l'appelant à partir de l'en-tête `Authorization`.
 *
 * Ne lève jamais : toute anomalie devient un `AuthOutcome` exploitable, pour
 * que l'appelant décide du statut HTTP (401 ou 503) sans risque d'exception
 * non gérée.
 */
export async function resolveCaller(
  authorization: string | null,
  config: AuthConfig,
): Promise<AuthOutcome> {
  const bearer = readBearer(authorization);

  // Filtrage local AVANT tout appel réseau : un en-tête vide ou d'un autre
  // schéma n'a aucune raison d'occuper un aller-retour vers Auth. Cela évite
  // aussi qu'un `Bearer ` suivi d'espaces devienne l'identité « chaîne vide ».
  if (!bearer) return { ok: false, reason: 'unauthenticated' };

  // Un jeton Supabase est un JWT : trois segments séparés par des points. Un
  // UUID nu — le cas exact de l'attaque — est rejeté sans appel réseau, ce qui
  // rend l'attaque impossible même si Auth était injoignable.
  if (!looksLikeJwt(bearer)) return { ok: false, reason: 'unauthenticated' };

  if (!config.baseUrl || !config.anonKey) {
    // Sans clé publique, on ne peut pas interroger Auth. Refuser est le seul
    // choix sûr : accepter reviendrait à faire confiance au porteur.
    return { ok: false, reason: 'auth_unavailable' };
  }

  const doFetch = config.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${config.baseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
      headers: { apikey: config.anonKey, Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // Réseau coupé, DNS, délai dépassé : ce n'est pas un refus d'identité,
    // c'est une indisponibilité. La distinction compte : 503 plutôt que 401.
    return { ok: false, reason: 'auth_unavailable' };
  }

  // 401/403 = le jeton est invalide, expiré ou révoqué. C'est un refus net.
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthenticated' };
  }
  if (!response.ok) return { ok: false, reason: 'auth_unavailable' };

  let user: unknown;
  try {
    user = await response.json();
  } catch {
    // Une réponse 200 non-JSON signifie que l'on ne parle pas à Auth.
    return { ok: false, reason: 'auth_unavailable' };
  }

  const id = typeof user === 'object' && user !== null
    ? (user as Record<string, unknown>).id
    : undefined;
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, reason: 'auth_unavailable' };
  }

  return { ok: true, userId: id };
}

/** Extrait le porteur, ou `null` s'il est absent ou vide. */
function readBearer(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * Reconnaît la forme d'un JWT : `header.payload.signature`, trois segments
 * non vides en base64url.
 *
 * Ce n'est PAS une vérification cryptographique — celle-ci est déléguée à Auth.
 * C'est un rejet précoce des valeurs qui ne peuvent pas être un jeton, dont les
 * UUID nus.
 */
export function looksLikeJwt(token: string): boolean {
  const segments = token.split('.');
  if (segments.length !== 3) return false;
  return segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment));
}
