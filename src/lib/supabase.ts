import { createClient } from '@supabase/supabase-js';
import { DEFAULT_SUPABASE_URL } from './public-config';

// These two values are PUBLIC by design (Supabase publishable/anon key).
// Server secrets (FREE_LLM_API_KEY, MUAPI_API_KEY, SUPABASE_SERVICE_ROLE_KEY)
// are never referenced in frontend code.
const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_utbZhw8dg-2M1-g0nXIhfA_n6dZCDZz';

export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || DEFAULT_SUPABASE_URL;
export const SUPABASE_PUBLISHABLE_KEY =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) || DEFAULT_PUBLISHABLE_KEY;
/**
 * Origine publique utilisée pour les redirections d'authentification
 * (`emailRedirectTo`, réinitialisation de mot de passe).
 *
 * ## Pourquoi le navigateur fait foi
 * Cette valeur est utilisée UNIQUEMENT côté navigateur (`api.ts`,
 * `OwnerBootstrap.tsx`). L'origine de la page est donc, par construction,
 * l'adresse depuis laquelle l'utilisateur navigue : elle ne peut pas être
 * périmée, et elle suit automatiquement tout changement de domaine.
 *
 * ## L'incident du 25/11/2026
 * Un build avait gravé l'adresse du site PRÉCÉDENT dans le bundle alors que le
 * domaine vivant avait changé : l'email de confirmation renvoyait donc vers un
 * site supprimé. La variable Netlify est figée au moment du
 * build et n'est pas lisible depuis ce dépôt — on ne peut donc pas garantir sa
 * valeur ici. Ne plus la faire passer devant supprime la cause, au lieu de la
 * contourner par une liste de domaines morts qui deviendrait elle-même une
 * dette.
 *
 * `VITE_SITE_URL` reste utile comme secours pour les contextes sans `window`
 * (tests, rendu hors navigateur). Elle doit figurer dans `uri_allow_list` côté
 * Supabase Auth ; un navigateur, lui, retombe toujours sur sa propre origine.
 */
export const SITE_URL = (() => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  const configuree = import.meta.env.VITE_SITE_URL as string | undefined;
  return configuree ? configuree.replace(/\/+$/, '') : '';
})();

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'reelora.auth.v1',
  },
});

export const STORAGE_BUCKET = 'ugc-assets';
