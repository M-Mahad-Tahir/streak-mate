import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when the public Supabase settings are present in the environment. */
export const isConfigured = Boolean(url && anonKey && !url.includes('YOUR-PROJECT-REF'));

// Only the public anon key is used in the browser. All authorization is enforced
// in the database through Row Level Security and SECURITY DEFINER functions.
export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** A client that never keeps a session: creating an account must not sign this browser in. */
export const signUpClient = () => createClient(url ?? 'http://localhost', anonKey ?? 'missing-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'sb-signup-only' },
});
