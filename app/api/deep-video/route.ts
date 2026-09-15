import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runVideoDeepInvestigation, VIDEO_DEEP_ENGINE_VERSION, type VideoAnalysisResult } from "@/lib/video-analysis";
import { normalizeClaim } from "@/lib/quick-check";
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
// the video Gemini call's own up-to-40s timeout — silently, with no JSON
// error body, so the browser just hangs with no feedback. 60 is Hobby's max.
export const maxDuration = 60;

// Video authenticity Deep Investigation — mirrors app/api/verify-video/
// route.ts exactly (see that file's header for the full rationale). Only
// differences from the Quick Check version: the reasoning-tier pipeline
// (runVideoDeepInvestigation), its own engine version/cache namespace, and
// decrement_deep_investigation/refund_deep_investigation — same asymmetry
// as every other Quick Check/Deep Investigation pair in this app.
const ALLOWED_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/3gpp",
  "video/x-msvideo",
]);
const MAX_BASE64_LENGTH = 20_000_000;

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
  const context: string = (body?.context ?? "").trim().slice(0, 500);

  if (!videoBase64) {
    return NextResponse.json({ error: "No video was provided." }, { status: 400 });
  }
  if (videoBase64.length > MAX_BASE64_LENGTH) {
    return NextResponse.json({ error: "That video is too large. Try a shorter clip." }, { status: 400 });
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return NextResponse.json({ error: "Unsupported video type." }, { status: 400 });
  }

  const admin = createAdminClient();
  const cacheKey = computeCacheKey(`${videoBase64}|ctx:${context}`, "video", VIDEO_DEEP_ENGINE_VERSION);

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_deep_investigation", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[deep-video] decrement_deep_investigation RPC failed:", rpcError);
    return NextResponse.json(
      { error: "Could not check your credit balance. Please try again." },
      { status: 500 }
    );
  }

  if (remaining === null || remaining === undefined) {
    return NextResponse.json(
      { error: "You're out of Deep Investigation credits. Upgrade your plan to continue." },
      { status: 402 }
    );
  }

  const cached = await getCachedVerification(admin, cacheKey);
  const cacheHit = cached !== null;

  let result: VideoAnalysisResult | CachedVerification;
  if (cached) {
    result = cached;
  } else {
    try {
      result = await runVideoDeepInvestigation(videoBase64, mimeType, context || null);
    } catch (err) {
      console.error("[deep-video] pipeline failed (refunding credit):", err);

      const { error: refundError } = await admin.rpc("refund_deep_investigation", { p_user_id: user.id });
      if (refundError) {
        console.error("[deep-video] refund_deep_investigation RPC ALSO failed:", refundError);
      }

      await admin.from("credit_transactions").insert([
        { user_id: user.id, credit_type: "deep_investigation", amount: -1, reason: "deep_investigation_reserved" },
        { user_id: user.id, credit_type: "deep_investigation", amount: 1, reason: "deep_investigation_refunded_infra_error" },
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
  }

  const claimText = context || "[Video submitted for authenticity analysis]";

  const { data: verification, error: insertError } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "deep",
      input_type: "video",
      claim_text: claimText,
      normalized_claim: normalizeClaim(claimText),
      verdict: result.verdict,
      confidence: result.confidence,
      summary: result.summary,
      key_evidence: result.key_evidence,
      sources: result.sources,
      caveats: result.caveats,
      engine_version: result.engine_version,
      credit_charged: true,
    })
    .select()
    .single();

  if (insertError || !verification) {
    console.error("[deep-video] verifications insert failed:", insertError);
    return NextResponse.json(
      {
        error: "Investigation ran but couldn't be saved. Please try again.",
        ...(process.env.NODE_ENV !== "production" && insertError
          ? { debug: { message: insertError.message, details: insertError.details, hint: insertError.hint, code: insertError.code } }
          : {}),
      },
      { status: 500 }
    );
  }

  if (!cacheHit) {
    await writeCache(admin, cacheKey, verification.id, "[video content]", AUDIO_CACHE_FRESHNESS);
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "deep_investigation",
    amount: -1,
    reason: cacheHit ? "deep_investigation_completed_cache_hit" : "deep_investigation_completed",
    verification_id: verification.id,
  });
  if (txnError) {
    console.error("[deep-video] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  return NextResponse.json({
    id: verification.id,
    mode: "deep",
    claim: verification.claim_text,
    verdict: verification.verdict,
    confidence: verification.confidence,
    explanation: verification.summary,
    evidence: verification.key_evidence,
    sources: verification.sources,
    caveats: verification.caveats,
    cached: cacheHit,
    cached_at: cacheHit ? (result as CachedVerification).cached_at : null,
    credits: {
      quick_checks: balance?.quick_checks_remaining ?? 0,
      deep_investigations: balance?.deep_investigations_remaining ?? 0,
      total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
    },
  });
}
