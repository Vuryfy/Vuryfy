"use client";

import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client. Used ONLY for Auth (phone OTP sign-in) —
// never for reading/writing business tables (credits, verifications,
// subscriptions). Those all go through our own Next.js API routes, which
// use the service_role key server-side (see lib/supabase/admin.ts).
//
// NEXT_PUBLIC_SUPABASE_ANON_KEY holds what Supabase's dashboard now calls
// the "publishable key" (sb_publishable_...) — same purpose, new name.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
