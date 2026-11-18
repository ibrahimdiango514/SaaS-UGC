/**
 * VYORA — traitements imposés par Meta au cycle de vie des autorisations.
 *
 * ## Pourquoi ce module existe
 *
 * Un client peut retirer VYORA depuis Facebook, sans passer par VYORA. Meta
 * prévient alors l'application par deux rappels POST signés, configurés dans le
 * tableau de bord :
 *
 *   - **deauthorize callback** : la personne a retiré l'application. Les jetons
 *     qu'elle avait accordés ne valent plus rien. Si VYORA ne les efface pas,
 *     il conserve des identifiants morts — et surtout il continue d'afficher
 *     « Connecté » pour une autorisation révoquée.
 *   - **data deletion callback** : la personne demande la suppression de ses
 *     données. Meta exige une réponse contenant une URL de suivi et un code de
 *     confirmation, faute de quoi le rappel peut être désactivé et
 *     l'application suspendue.
 *
 * ## La signature n'est pas un détail
 *
 * Ces deux rappels arrivent sur une URL publique, sans JWT : n'importe qui peut
 * poster. Meta les signe (`signed_request`) avec l'App Secret. Sans vérification
 * de cette signature, un tiers pourrait faire supprimer les données d'un client
 * en devinant son identifiant — c'est un déni de service ciblé.
 *
 * Le format est `base64url(signature).base64url(payload)`, la signature étant
 * HMAC-SHA256 du **payload encodé** (la chaîne, pas l'objet décodé). Comparaison
 * à temps constant.
 */

export type SignedRequestResult =
  | { ok: true; userId: string; issuedAt: number | null }
  | { ok: false; reason: 'MALFORMED' | 'ALGORITHM_UNSUPPORTED' | 'SIGNATURE_INVALID' | 'NO_USER' };

/** Décode du base64url en octets. `atob` est disponible dans Deno et le navigateur. */
function base64urlToBytes(value: string): Uint8Array | null {
  try {
    const normalise = value.replace(/-/g, '+').replace(/_/g, '/');
    const complete = normalise + '='.repeat((4 - (normalise.length % 4)) % 4);
    const binaire = atob(complete);
    const octets = new Uint8Array(binaire.length);
    for (let i = 0; i < binaire.length; i += 1) octets[i] = binaire.charCodeAt(i);
    return octets;
  } catch {
    return null;
  }
}

/** Comparaison à temps constant : une comparaison naïve fuit la longueur du préfixe correct. */
function egalConstant(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

/**
 * Vérifie un `signed_request` Meta et en extrait l'identifiant utilisateur.
 *
 * Fonction pure vis-à-vis du réseau : elle ne fait qu'un calcul HMAC, donc elle
 * est testable intégralement.
 *
 * @param signedRequest valeur brute du champ `signed_request`
 * @param appSecret     App Secret de l'application (jamais exposé au navigateur)
 */
export async function parseSignedRequest(
  signedRequest: string | null | undefined,
  appSecret: string,
): Promise<SignedRequestResult> {
  if (!signedRequest || typeof signedRequest !== 'string') return { ok: false, reason: 'MALFORMED' };
  if (!appSecret) return { ok: false, reason: 'MALFORMED' };

  const point = signedRequest.indexOf('.');
  if (point <= 0 || point === signedRequest.length - 1) return { ok: false, reason: 'MALFORMED' };
  const signatureB64 = signedRequest.slice(0, point);
  const payloadB64 = signedRequest.slice(point + 1);

  const signature = base64urlToBytes(signatureB64);
  const payloadOctets = base64urlToBytes(payloadB64);
  if (!signature || !payloadOctets) return { ok: false, reason: 'MALFORMED' };

  /*
   * La signature porte sur la chaîne base64url du payload, TELLE QUE REÇUE.
   * Recalculer à partir de l'objet décodé puis ré-encodé changerait l'ordre des
   * clés et invaliderait une signature pourtant légitime. C'est l'erreur
   * classique de cette vérification.
   */
  const clef = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const attendu = new Uint8Array(
    await crypto.subtle.sign('HMAC', clef, new TextEncoder().encode(payloadB64)),
  );
  if (!egalConstant(signature, attendu)) return { ok: false, reason: 'SIGNATURE_INVALID' };

  let donnees: Record<string, unknown>;
  try {
    donnees = JSON.parse(new TextDecoder().decode(payloadOctets)) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  const algorithme = String(donnees.algorithm ?? '');
  if (algorithme && algorithme !== 'HMAC-SHA256') return { ok: false, reason: 'ALGORITHM_UNSUPPORTED' };

  const userId = typeof donnees.user_id === 'string' ? donnees.user_id : '';
  if (!userId) return { ok: false, reason: 'NO_USER' };

  const issuedAt = typeof donnees.issued_at === 'number' ? donnees.issued_at : null;
  return { ok: true, userId, issuedAt };
}

/** Réponse JSON exigée par Meta pour un rappel de suppression de données. */
export interface DataDeletionResponse {
  url: string;
  confirmation_code: string;
}

/**
 * Construit la réponse de suppression de données.
 *
 * Meta impose ces deux champs : une URL où la personne suit l'état de sa
 * demande, et un code de confirmation. Le code est dérivé de l'identifiant et
 * de l'instant, donc stable pour une même demande et non devinable.
 */
export function dataDeletionResponse(appUrl: string, userId: string, now: Date): DataDeletionResponse {
  const base = appUrl.replace(/\/+$/, '');
  const code = `vyora-${userId.slice(-6)}-${now.getTime().toString(36)}`;
  return {
    url: `${base}/confidentialite#suppression-des-donnees`,
    confirmation_code: code,
  };
}
