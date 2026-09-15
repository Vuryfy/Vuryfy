import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { transcribeVideoSpeech } from "@/lib/video-transcript";

// Route-level execution budget (Sept 2026 fix): without this, Vercel kills
// the function at its platform default — 10 seconds on Hobby — long before
// the Gemini call (up to 30s, see video-transcript.ts) can ever finish.
// That kill is silent from the browser's side: no JSON error body comes
// back, so a real user just sees the request hang forever with no
// feedback. 60 is the maximum allowed on Hobby, giving real headroom above
// the in-app timeout plus request overhead (auth check, base64 parsing).
// Audio's routes have run under the unset 10s default without this
// surfacing, since a much smaller audio-only payload usually finishes
// well under it — video's larger payload routinely does not.
export const maxDuration = 60;

// Free preview step for video input's transcript sub-path — mirrors
// app/api/transcribe-audio/route.ts exactly (see that file's header for
// the full rationale on why transcription is kept free despite being a
// real AI call). Charges NO credit and writes NO verifications row — it
// only produces a transcript for the user to review (and edit) before
// deciding whether to spend a Quick Check or Deep Investigation credit
// checking it, via /api/verify or /api/deep with
// input_type: "video_transcript".
const ALLOWED_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/3gpp",
  "video/x-msvideo",
]);
const MAX_BASE64_LENGTH = 20_000_000; // ~15MB binary — matches prepare-video-upload.ts's client-side cap, with headroom

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const videoBase64: string = body?.video_base64 ?? "";
  const mimeType: string = body?.mime_type ?? "";

  if (!videoBase64) {
    return NextResponse.json({ error: "No video was provided." }, { status: 400 });
  }
  if (videoBase64.length > MAX_BASE64_LENGTH) {
    return NextResponse.json({ error: "That video is too large. Try a shorter clip." }, { status: 400 });
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return NextResponse.json({ error: "Unsupported video type." }, { status: 400 });
  }

  try {
    const transcript = await transcribeVideoSpeech(videoBase64, mimeType);
    return NextResponse.json({ transcript });
  } catch (err) {
    console.error("[transcribe-video] transcription failed:", err);
    return NextResponse.json(
      {
        error: "Try Again",
        ...(process.env.NODE_ENV !== "production"
          ? { debug: { message: err instanceof Error ? err.message : String(err) } }
          : {}),
      },
      { status: 502 }
    );
  }
}
