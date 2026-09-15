import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Issues a short-lived signed upload URL for the temp-video-uploads bucket
// (see supabase/migrations/0009_temp_video_storage.sql for the full
// rationale) — the first step of video's new upload flow. The browser
// calls this route (fast, no AI call, nothing to charge a credit for),
// then uploads the actual video bytes DIRECTLY to Supabase Storage using
// the returned token — never through this Next.js app, and so never
// through Vercel's 4.5MB request body limit. See lib/prepare-video-
// upload.ts for the client-side half of this flow.
//
// The storage path is always {user.id}/{uuid}.{ext} — server-generated,
// never taken from client input, so a user can never write into another
// user's folder even before RLS is considered (see the migration's own
// policies for the defense-in-depth layer).
const ALLOWED_MIME_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/3gpp": "3gp",
  "video/x-msvideo": "avi",
};

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const mimeType: string = body?.mime_type ?? "";
  const extension = ALLOWED_MIME_TYPES[mimeType];

  if (!extension) {
    return NextResponse.json({ error: "Unsupported video type." }, { status: 400 });
  }

  const admin = createAdminClient();
  const storagePath = `${user.id}/${randomUUID()}.${extension}`;

  const { data, error } = await admin.storage
    .from("temp-video-uploads")
    .createSignedUploadUrl(storagePath);

  if (error || !data) {
    console.error("[video-upload-url] createSignedUploadUrl failed:", error);
    return NextResponse.json({ error: "Could not prepare the upload. Please try again." }, { status: 500 });
  }

  return NextResponse.json({
    storage_path: storagePath,
    token: data.token,
    signed_url: data.signedUrl,
  });
}
