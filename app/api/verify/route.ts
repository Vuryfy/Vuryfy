import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Quick Check — Sprint 1 scope: text + link input only (per the locked
// build order — QR/image/audio/video come one at a time after this).
//
// Credit consumption principle (locked, Part 26.4 addition #1): a credit
// is spent whenever Quick Check COMPLETES with any verdict, including
// "Unverified" — only genuine infra failures are non-chargeable. So we
// charge the credit BEFORE calling the AI stub below, and the stub always
// returns a verdict (never throws for a "the claim was weird" reason).
//
// ⚠️ STUB: runQuickCheckStub() below does not call any real AI or search
// provider yet — Gemini/Tavily API keys don't exist in this environment
// yet. It returns a clearly-labeled placeholder verdict so the rest of
// the pipeline (auth → credit deduction → DB write → result screen) can
// be built and tested end-to-end today. Replace its body with a real call
// through the AI Gateway (Part 11) once those keys are available — the
// request/response contract below is designed not to need to change when
// that happens.
async function runQuickCheckStub(claim: string) {
  return {
    verdict: "Unverified",
    confidence: 0,
    summary:
      "Vuryfy's AI verification isn't connected yet — this is a placeholder result so the rest of the app can be tested end-to-end.",
    key_evidence: [] as { title: string; url: string; publisher?: string; snippet?: string }[],
    sources: [] as { title: string; url: string }[],
    engine_version: "v1-stub",
  };
}

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
  if (inputType !== "text" && inputType !== "link") {
    return NextResponse.json(
      { error: `Input type "${inputType}" isn't supported yet — only text and link so far.` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

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

  // Credit is now spent — from here on we owe the user a verdict, per the
  // locked credit-consumption principle, even if it's "Unverified."
  const result = await runQuickCheckStub(claim);

  const { data: verification, error: insertError } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      input_type: inputType,
      claim_text: claim,
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

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "quick_check",
    amount: -1,
    reason: "quick_check_completed",
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
    claim: verification.claim_text,
    verdict: verification.verdict,
    confidence: verification.confidence,
    explanation: verification.summary,
    evidence: verification.key_evidence,
    caveats: ["This is a placeholder result — real AI verification isn't connected yet."],
    credits: {
      quick_checks: balance?.quick_checks_remaining ?? 0,
      deep_investigations: balance?.deep_investigations_remaining ?? 0,
      total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
    },
  });
}
