import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runQuickCheck, normalizeClaim, ENGINE_VERSION, type QuickCheckResult } from "@/lib/quick-check";
import { runVideoQuickCheck, VIDEO_QUICK_ENGINE_VERSION, type VideoAnalysisResult } from "@/lib/video-analysis";
import {
  computeCacheKey,
  getCachedVerification,
  writeCache,
  AUDIO_CACHE_FRESHNESS,
  type CachedVerification,
} from "@/lib/verification-cache";

// Route-level execution budget (Sept 2026 fix, see app/api/transcribe-
// video/route.ts's comment for the full rationale): without this, Vercel
// kills the function at its Hobby-plan default of 10 seconds — well under
// even the FASTER of the two parallel calls this route makes (the text
// pipeline and the up-to-35s video Gemini call) — silently, with no JSON
// error body, so the browser just hangs with no feedback. 60 is Hobby's max.
export const maxDuration = 60;

// Combined video Quick Check — mirrors app/api/verify-audio-combined/
// route.ts exactly, one level down (see that file's header for the full
// rationale: why one button runs both pipelines, the explicit 1-credit
// product decision despite two AI pipelines running, and the caching
// design). Built combined from the START for video — audio's original
// ship went through a separate "two buttons on one screen" bug and fix
// first; video learns from that directly instead of repeating it.
//
// Two verifications rows are still written — one input_type
// "video_transcript", one "video" — so each pipeline's own verdict
// vocabulary and history entry stay intact. Only the transcript row is
// credit_charged: true; the video row rides along on that single charge.
// The response bundles both under the optional `secondary` field that
// app/result/page.tsx already renders generically (built for audio, reused
// unchanged here).
const ALLOWED_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/3gpp",
  "video/x-msvideo",
]);
const MAX_BASE64_LENGTH = 4_200_000; // ~3MB raw video — see lib/prepare-video-upload.ts's header: this is capped by Vercel's hard 4.5MB request-body limit, not by Gemini

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
  const transcript: string = (body?.transcript ?? "").trim();
  const context: string = (body?.context ?? "").trim().slice(0, 500);

  if (!videoBase64) {
    return NextResponse.json({ error: "No video was provided." }, { status: 400 });
  }
  if (videoBase64.length > MAX_BASE64_LENGTH) {
    return NextResponse.json({ error: "That video is too large for this request (limit is a few seconds of video, ~3MB, due to a Vercel platform limit). Try a shorter clip." }, { status: 400 });
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return NextResponse.json({ error: "Unsupported video type." }, { status: 400 });
  }
  if (transcript.length < 5) {
    return NextResponse.json(
      { error: "No usable transcript to combine — use the video-only check instead." },
      { status: 400 }
    );
  }
  if (transcript.length > 10000) {
    return NextResponse.json({ error: "Transcript is too long (10,000 character limit)." }, { status: 400 });
  }

  const admin = createAdminClient();
  const normalizedTranscript = normalizeClaim(transcript);
  const textCacheKey = computeCacheKey(normalizedTranscript, "video_transcript", ENGINE_VERSION);
  const videoCacheKey = computeCacheKey(`${videoBase64}|ctx:${context}`, "video", VIDEO_QUICK_ENGINE_VERSION);

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_quick_check", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[verify-video-combined] decrement_quick_check RPC failed:", rpcError);
    return NextResponse.json(
      { error: "Could not check your credit balance. Please try again." },
      { status: 500 }
    );
  }
  if (remaining === null || remaining === undefined) {
    return NextResponse.json(
      { error: "You're out of Quick Check credits. Upgrade your plan to continue." },
      { status: 402 }
    );
  }

  const [textCached, videoCached] = await Promise.all([
    getCachedVerification(admin, textCacheKey),
    getCachedVerification(admin, videoCacheKey),
  ]);
  const textCacheHit = textCached !== null;
  const videoCacheHit = videoCached !== null;

  let textResult: QuickCheckResult | CachedVerification;
  let videoResult: VideoAnalysisResult | CachedVerification;
  try {
    const [freshText, freshVideo] = await Promise.all([
      textCached ? Promise.resolve(null) : runQuickCheck(transcript),
      videoCached ? Promise.resolve(null) : runVideoQuickCheck(videoBase64, mimeType, context || null),
    ]);
    textResult = textCached ?? (freshText as QuickCheckResult);
    videoResult = videoCached ?? (freshVideo as VideoAnalysisResult);
  } catch (err) {
    console.error("[verify-video-combined] pipeline failed (refunding credit):", err);

    const { error: refundError } = await admin.rpc("refund_quick_check", { p_user_id: user.id });
    if (refundError) {
      console.error("[verify-video-combined] refund_quick_check RPC ALSO failed:", refundError);
    }

    await admin.from("credit_transactions").insert([
      { user_id: user.id, credit_type: "quick_check", amount: -1, reason: "quick_check_reserved" },
      { user_id: user.id, credit_type: "quick_check", amount: 1, reason: "quick_check_refunded_infra_error" },
    ]);

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

  const claimTextForVideo = context || "[Video submitted for authenticity analysis]";

  const { data: transcriptRow, error: insertError1 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      input_type: "video_transcript",
      claim_text: transcript,
      normalized_claim: normalizedTranscript,
      verdict: textResult.verdict,
      confidence: textResult.confidence,
      summary: textResult.summary,
      key_evidence: textResult.key_evidence,
      sources: textResult.sources,
      engine_version: textResult.engine_version,
      credit_charged: true,
    })
    .select()
    .single();

  if (insertError1 || !transcriptRow) {
    console.error("[verify-video-combined] transcript verifications insert failed:", insertError1);
    return NextResponse.json(
      { error: "Check ran but couldn't be saved. Please try again." },
      { status: 500 }
    );
  }

  const { data: videoRow, error: insertError2 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      input_type: "video",
      claim_text: claimTextForVideo,
      normalized_claim: normalizeClaim(claimTextForVideo),
      verdict: videoResult.verdict,
      confidence: videoResult.confidence,
      summary: videoResult.summary,
      key_evidence: videoResult.key_evidence,
      sources: videoResult.sources,
      caveats: videoResult.caveats,
      engine_version: videoResult.engine_version,
      credit_charged: false,
    })
    .select()
    .single();

  if (insertError2 || !videoRow) {
    console.error("[verify-video-combined] video verifications insert failed:", insertError2);
  }

  if (!textCacheHit) {
    await writeCache(admin, textCacheKey, transcriptRow.id, transcript);
  }
  if (!videoCacheHit && videoRow) {
    await writeCache(admin, videoCacheKey, videoRow.id, "[video content]", AUDIO_CACHE_FRESHNESS);
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "quick_check",
    amount: -1,
    reason: "quick_check_completed_combined_video",
    verification_id: transcriptRow.id,
  });
  if (txnError) {
    console.error("[verify-video-combined] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  return NextResponse.json({
    id: transcriptRow.id,
    mode: "quick",
    claim: transcriptRow.claim_text,
    verdict: transcriptRow.verdict,
    confidence: transcriptRow.confidence,
    explanation: transcriptRow.summary,
    evidence: transcriptRow.key_evidence,
    sources: transcriptRow.sources,
    cached: textCacheHit,
    cached_at: textCacheHit ? (textCached as CachedVerification).cached_at : null,
    secondary: videoRow
      ? {
          id: videoRow.id,
          eyebrow: "THE VIDEO ITSELF",
          verdict: videoRow.verdict,
          confidence: videoRow.confidence,
          explanation: videoRow.summary,
          caveats: videoRow.caveats,
        }
      : null,
    credits: {
      quick_checks: balance?.quick_checks_remaining ?? 0,
      deep_investigations: balance?.deep_investigations_remaining ?? 0,
      total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
    },
  });
}
