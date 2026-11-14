import { createClient } from '@supabase/supabase-js';
import { DEFAULT_SUPABASE_URL } from './public-config';

// These two values are PUBLIC by design (Supabase publishable/anon key).
// Server secrets (GROQ_API_KEY, MUAPI_API_KEY, SUPABASE_SERVICE_ROLE_KEY)
// are never referenced in frontend code.
const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_utbZhw8dg-2M1-g0nXIhfA_n6dZCDZz';

export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || DEFAULT_SUPABASE_URL;
export const SUPABASE_PUBLISHABLE_KEY =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) || DEFAULT_PUBLISHABLE_KEY;
export const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined) || window.location.origin;

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
