import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Privileged server-only client using the service_role key — this
// BYPASSES Row Level Security entirely, which is exactly why every table
// in supabase/migrations/0001_init.sql has RLS enabled with no policies:
// the only way in is through this client, from server-side code, after
// the caller has already been identified via lib/supabase/server.ts.
//
// NEVER import this file from a Client Component, and never let
// SUPABASE_SERVICE_ROLE_KEY reach the browser bundle — it has no
// NEXT_PUBLIC_ prefix specifically so Next.js won't inline it client-side.
// Every function that uses this client MUST do its own authorization
// check (e.g. "does this verification's user_id match the caller's
// auth.uid()?") since Postgres itself won't stop it.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
