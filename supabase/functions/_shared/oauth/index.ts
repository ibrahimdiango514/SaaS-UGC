// VYORA — surface publique du socle OAuth (réexport).
//
// Les fonctions Edge importent ce module plutôt que des fichiers internes :
// le chemin de réexport est stable même si l'organisation interne change.

export {
  createPkcePair,
  createState,
  decryptSecret,
  encryptSecret,
  generateKeyBase64,
  keyFingerprint,
  parseKey,
  type EncryptedValue,
} from './crypto.ts';

export {
  AUTH_ENDPOINT,
  CapabilityDeniedError,
  PROVIDERS,
  REVOKE_ENDPOINT,
  TOKEN_ENDPOINT,
  assertCapability,
  buildAuthorizationUrl,
  capabilitiesFromScopes,
  decodeIdTokenClaims,
  exchangeCode,
  isCapabilitySupported,
  refreshAccessToken,
  revokeToken,
  scopesFor,
  type AuthorizationUrlInput,
  type GoogleProvider,
  type OAuthCapability,
  type TokenSet,
} from './google.ts';
