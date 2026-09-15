import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { nameSimilarity } from "@/lib/payee-similarity";

// Payee look-alike detection — Sept 15, 2026 (see migration 0007's header
// for the full feature rationale, prompted by a real near-miss the user
// reported: a payment QR reading "BABLI ORGANIC PRIVATE LIMITED", one
// word off from "Babli Organics", his own real business).
//
// Grounding: this does NOT ask an AI "does this name look fake" — that
// would be exactly the ungrounded, hallucination-prone verdict
// lib/detect-payment-link.ts already rejected for payment QR codes (no
// way to confirm who actually controls a UPI ID). Instead this is a
// plain, deterministic comparison against the user's OWN scan history:
// every payee they've ever scanned via Vuryfy's QR checker is recorded
// (payment_payees_seen), and a new UPI ID with a name that's near-
// identical (Levenshtein-based, see lib/payee-similarity.ts) to one
// already on file gets flagged. This makes no claim about which of the
// two is the real one — it surfaces the anomaly (same-ish name, different
// ID) for the user to investigate before paying.
//
// Free: no AI call, no credit charged, pure DB comparison — consistent
// with the rest of QR's payment-link handling (decode, payment detection,
// and this check are all free; only fact-checking a non-payment QR's
// decoded text costs a credit).
//
// Re-scanning the exact same UPI ID again is treated as "already known" —
// no new warning, since there's nothing new to flag. This means the
// FIRST time a given ID is ever seen (fraudulent or not) is recorded
// without objection; the value here is catching a SECOND, different ID
// later trying to pass as the same name, not judging the first sighting.
const SIMILARITY_THRESHOLD = 0.82;
const MAX_NAME_LENGTH = 200;
const MAX_UPI_ID_LENGTH = 200;

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const upiIdRaw: string = (body?.upi_id ?? "").trim();
  const payeeNameRaw: string = (body?.payee_name ?? "").trim();

  if (!upiIdRaw) {
    return NextResponse.json({ error: "No payee ID was provided." }, { status: 400 });
  }

  const upiId = upiIdRaw.toLowerCase().slice(0, MAX_UPI_ID_LENGTH);
  const payeeName = payeeNameRaw.slice(0, MAX_NAME_LENGTH);

  const admin = createAdminClient();

  const { data: history, error: historyError } = await admin
    .from("payment_payees_seen")
    .select("upi_id, payee_name, first_seen_at, times_seen")
    .eq("user_id", user.id);

  if (historyError) {
    console.error("[check-payee] history lookup failed:", historyError);
    // Fail open — a lookup bug should never block the QR payment-info
    // display itself; this check is a bonus safety layer, not the core flow.
    return NextResponse.json({ isNewUpi: true, similarMatch: null });
  }

  const rows = history ?? [];
  const existing = rows.find((row) => row.upi_id === upiId);

  if (existing) {
    const { error: updateError } = await admin
      .from("payment_payees_seen")
      .update({
        last_seen_at: new Date().toISOString(),
        times_seen: (existing.times_seen ?? 1) + 1,
      })
      .eq("user_id", user.id)
      .eq("upi_id", upiId);
    if (updateError) {
      console.error("[check-payee] update failed:", updateError);
    }
    return NextResponse.json({ isNewUpi: false, similarMatch: null });
  }

  let similarMatch: { payeeName: string; upiId: string; similarity: number; firstSeenAt: string } | null = null;
  if (payeeName) {
    for (const row of rows) {
      if (!row.payee_name) continue;
      const score = nameSimilarity(payeeName, row.payee_name);
      if (score >= SIMILARITY_THRESHOLD && (!similarMatch || score > similarMatch.similarity)) {
        similarMatch = {
          payeeName: row.payee_name,
          upiId: row.upi_id,
          similarity: score,
          firstSeenAt: row.first_seen_at,
        };
      }
    }
  }

  const { error: insertError } = await admin.from("payment_payees_seen").insert({
    user_id: user.id,
    upi_id: upiId,
    payee_name: payeeName || "(no name provided)",
  });
  if (insertError) {
    console.error("[check-payee] insert failed:", insertError);
  }

  return NextResponse.json({ isNewUpi: true, similarMatch });
}
