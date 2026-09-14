import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runQuickCheck, normalizeClaim, ENGINE_VERSION, type QuickCheckResult } from "@/lib/quick-check";
import { computeCacheKey, getCachedVerification, writeCache, type CachedVerification } from "@/lib/verification-cache";

// Quick Check — Sprint 1 scope: text + link input only (per the locked
// build order — QR/image/audio/video come one at a time after this).
//
// Credit consumption principle (locked, Part 26.4 addition #1): a credit
// is spent whenever Quick Check COMPLETES with any verdict, including
// "Unverified" — only genuine infrastructure failures (network errors,
// provider outages, timeouts) are non-chargeable.
//
// To satisfy that without letting a 0-credit user trigger a paid AI/search
// call, and without a read-then-write race between concurrent requests,
// the flow below RESERVES the credit up front via the atomic
// decrement_quick_check() RPC (same as before), runs the real pipeline,
// and only KEEPS that charge if the pipeline actually returns a verdict.
// If the pipeline throws (genuine infra failure), the reservation is given
// back via refund_quick_check() (see supabase/migrations/0002_quick_check_
// refund.sql) and no verification row is written.
//
// Exact-match caching (Part 11, added Sept 14, 2026): after the credit is
// reserved, we check verification_cache_exact for a live (non-expired)
// entry keyed on hash(normalized_claim + input_type + engine_version). A
// HIT skips runQuickCheck() entirely — no Gemini call, no Tavily call —
// and reuses the previously-computed verdict/evidence. A cache hit still:
//   (a) charges the normal credit — caching exists to cut provider cost,
//       not to create a free-recheck loophole, consistent with the
//       "charge on completion" rule above; and
//   (b) creates a fresh `verifications` row for THIS user — verifications
//       is private-by-default per-user data (Part 15), so every user needs
//       their own history row even when the underlying computation was
//       reused from someone else's earlier check.
// A cache MISS runs the pipeline as before, then writes the result to the
// cache after the new verification row is saved (so the cache row can
// reference a real verification_id). Cache lookup/write failures are
// non-fatal by design (see verification-cache.ts) — a caching bug must
// never be able to break the core Quick Check flow.
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
  if (inputType !== "text" && inputType !== "link" && inputType !== "qr") {
    return NextResponse.json(
      { error: `Input type "${inputType}" isn't supported yet — only text, link, and QR so far.` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const normalizedClaim = normalizeClaim(claim);
  const cacheKey = computeCacheKey(normalizedClaim, inputType, ENGINE_VERSION);

  // Atomic conditional decrement via the decrement_quick_check() Postgres
  // function (see supabase/migrations/0001_init.sql) — only succeeds if
  // the user actually has a quick check left, and can't go negative even
  // under two concurrent requests racing for the same last credit.
  const { data: remaining, error: rpcError } = await admin.rpc("decrement_quick_check", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[verify] decrement_quick_check RPC failed:", rpcError);
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

  // Credit is now reserved — from here on we owe the user a verdict (and
  // keep the charge) if we can produce one (fresh or cached), or refund it
  // if the pipeline itself fails for infrastructure reasons.
  const cached = await getCachedVerification(admin, cacheKey);
  const cacheHit = cached !== null;

  let result: QuickCheckResult | CachedVerification;
  if (cached) {
    result = cached;
  } else {
    try {
      result = await runQuickCheck(claim);
    } catch (err) {
      console.error("[verify] Quick Check pipeline failed (refunding credit):", err);

      const { data: refunded, error: refundError } = await admin.rpc("refund_quick_check", {
        p_user_id: user.id,
      });
      if (refundError) {
        // Worst case here: the user was charged for a check that never ran.
        // Logged loudly since there's no user-facing recovery for this.
        console.error("[verify] refund_quick_check RPC ALSO failed:", refundError);
      } else {
        console.error("[verify] credit refunded, new balance:", refunded);
      }

      // Audit trail for both the reservation and the refund — every balance
      // change gets a row, per the locked ledger principle, even when net
      // effect is zero.
      await admin.from("credit_transactions").insert([
        { user_id: user.id, credit_type: "quick_check", amount: -1, reason: "quick_check_reserved" },
        { user_id: user.id, credit_type: "quick_check", amount: 1, reason: "quick_check_refunded_infra_error" },
      ]);

      // User-facing message kept short by request — "Try Again" — since the
      // AI Gateway now retries transient provider failures (503/429/5xx)
      // internally before ever surfacing an error here (see ai-gateway.ts).
      // Reaching this branch means even those retries were exhausted, so a
      // manual retry is the right next step. Full detail stays in the dev
      // debug field and the server logs above.
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
      input_type: inputType,
      claim_text: claim,
      normalized_claim: normalizedClaim,
      verdict: result.verdict,
      confidence: result.confidence,
      summary: result.summary,
      key_evidence: result.key_evidence,
      sources: result.sources,
      engine_version: result.engine_version,
      credit_charged: true,
    })
    .select()
    .single();

  if (insertError || !verification) {
    console.error("[verify] verifications insert failed:", insertError);
    return NextResponse.json(
      {
        error: "Verification ran but couldn't be saved. Please try again.",
        // Dev-only detail so we don't have to go spelunking in server logs
        // to see the actual Postgres error. Never expose this in prod.
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

  // Only write a NEW cache entry on a miss — a hit already has a live
  // cache row (that's what made it a hit), and re-upserting it here would
  // just reset its TTL clock for no benefit.
  if (!cacheHit) {
    await writeCache(admin, cacheKey, verification.id, claim);
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "quick_check",
    amount: -1,
    reason: cacheHit ? "quick_check_completed_cache_hit" : "quick_check_completed",
    verification_id: verification.id,
  });
  if (txnError) {
    // Non-fatal — the credit was already decremented via the RPC above and
    // the verification is saved, so we don't fail the request. But this
    // audit-trail row missing silently would be a pain to debug later.
    console.error("[verify] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  return NextResponse.json({
    id: verification.id,
    mode: "quick",
    claim: verification.claim_text,
    verdict: verification.verdict,
    confidence: verification.confidence,
    explanation: verification.summary,
    evidence: verification.key_evidence,
    sources: verification.sources,
    cached: cacheHit,
    cached_at: cacheHit ? (result as CachedVerification).cached_at : null,
    credits: {
      quick_checks: balance?.quick_checks_remaining ?? 0,
      deep_investigations: balance?.deep_investigations_remaining ?? 0,
      total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
    },
  });
}
