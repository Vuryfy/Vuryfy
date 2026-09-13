import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server-side Supabase client bound to the incoming request's cookies.
// Use this in API routes / Server Components to find out WHO is logged
// in (via supabase.auth.getUser()) — it respects the real user session,
// not an admin/service-role override. It does NOT bypass Row Level
// Security, which is intentional: it should only ever be used to read
// the current user's identity, never to read/write business tables
// directly (use lib/supabase/admin.ts for that, after you've confirmed
// the user's identity with this client).
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll called from a Server Component — safe to ignore
            // as long as middleware.ts is also refreshing the session.
          }
        },
      },
    }
  );
}
