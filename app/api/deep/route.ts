import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runDeepInvestigation, DEEP_ENGINE_VERSION, type DeepInvestigationResult } from "@/lib/deep-investigation";
import { normalizeClaim } from "@/lib/quick-check";
import { computeCacheKey, getCachedVerification, writeCache, type CachedVerification } from "@/lib/verification-cache";

// Deep Investigation (Part 11 routing logic + Part 26.5) — a heavier,
// multi-angle version of Quick Check: the claim is decomposed into a
// handful of sub-questions, each searched independently, and a
// reasoning-tier model synthesizes a verdict across all of that evidence
// with explicit contradiction analysis and caveats (see
// lib/deep-investigation.ts for the pipeline itself and the architecture
// note on why this is a single synchronous request rather than a
// background job).
//
// Everything else below deliberately mirrors app/api/verify/route.ts as
// closely as possible — same credit reserve/refund-on-infra-failure
// pattern (Part 26.4 addition #1's "charge on completion, refund only on
// genuine infra failure" principle applies identically here), same
// exact-match cache integration (a Deep Investigation cache hit still
// charges the credit and still creates a fresh per-user verifications row,
// for the same reasons as Quick Check — see verification-cache.ts and
// architecture-decisions.md's "Caching, Phase 1"). The two routes are kept
// as separate files rather than a shared parameterized handler because the
// pipelines, credit RPCs, and response shapes differ enough that a shared
// abstraction would mostly be indirection.
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const claim: string = (body?.claim ?? "").trim();
  const inputType: string = body?.input_type ?? "text";

  if (claim.length < 5) {
    return NextResponse.json({ error: "Claim is too short." }, { status: 400 });
  }
  if (claim.length > 10000) {
    return NextResponse.json({ error: "Claim is too long (10,000 character limit)." }, { status: 400 });
  }
  if (inputType !== "text" && inputType !== "link") {
    return NextResponse.json(
      { error: `Input type "${inputType}" isn't supported yet — only text and link so far.` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const normalizedClaim = normalizeClaim(claim);
  const cacheKey = computeCacheKey(normalizedClaim, inputType, DEEP_ENGINE_VERSION);

  // Atomic conditional decrement, same pattern as decrement_quick_check()
  // (see supabase/migrations/0003_deep_investigation.sql) — only succeeds
  // if the user actually has a Deep Investigation left, and can't go
  // negative under concurrent requests.
  const { data: remaining, error: rpcError } = await admin.rpc("decrement_deep_investigation", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[deep] decrement_deep_investigation RPC failed:", rpcError);
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

  let result: DeepInvestigationResult | CachedVerification;
  if (cached) {
    result = cached;
  } else {
    try {
      result = await runDeepInvestigation(claim);
    } catch (err) {
      console.error("[deep] Deep Investigation pipeline failed (refunding credit):", err);

      const { data: refunded, error: refundError } = await admin.rpc("refund_deep_investigation", {
        p_user_id: user.id,
      });
      if (refundError) {
        console.error("[deep] refund_deep_investigation RPC ALSO failed:", refundError);
      } else {
        console.error("[deep] credit refunded, new balance:", refunded);
      }

      await admin.from("credit_transactions").insert([
        { user_id: user.id, credit_type: "deep_investigation", amount: -1, reason: "deep_investigation_reserved" },
        { user_id: user.id, credit_type: "deep_investigation", amount: 1, reason: "deep_investigation_refunded_infra_error" },
      ]);

      // Same terse "Try Again" convention as Quick Check (Sept 14, 2026) —
      // the AI Gateway already retries transient provider failures
      // internally, so reaching this branch means those retries were
      // exhausted.
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

  const { data: verification, error: insertError } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "deep",
      input_type: inputType,
      claim_text: claim,
      normalized_claim: normalizedClaim,
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
    console.error("[deep] verifications insert failed:", insertError);
    return NextResponse.json(
      {
        error: "Investigation ran but couldn't be saved. Please try again.",
        ...(process.env.NODE_ENV !== "production" && insertError
          ? {
              debug: {
                message: insertError.message,
                details: insertError.details,
                hint: insertError.hint,
                code: insertError.code,
              },
            }
          : {}),
      },
      { status: 500 }
    );
  }

  if (!cacheHit) {
    await writeCache(admin, cacheKey, verification.id, claim);
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "deep_investigation",
    amount: -1,
    reason: cacheHit ? "deep_investigation_completed_cache_hit" : "deep_investigation_completed",
    verification_id: verification.id,
  });
  if (txnError) {
    console.error("[deep] credit_transactions insert failed:", txnError);
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
