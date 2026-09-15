"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type PaymentReceiptInfo = {
  amount?: string;
  fromName?: string;
  toName?: string;
  transactionId?: string;
  appUsed?: string;
  date?: string;
  raw: string;
};

type Result = {
  id: string | null;
  mode?: "quick" | "deep";
  verdict: string;
  confidence: number;
  explanation: string;
  claim: string;
  evidence: { title: string; url: string; publisher?: string; snippet?: string }[];
  caveats: string[];
  credits: { total: number; quick_checks: number; deep_investigations: number };
  // Payment-receipt carve-out (Sept 15, 2026, see lib/detect-payment-
  // receipt.ts): when /api/verify or /api/deep detects the claim is shaped
  // like a private payment receipt, they short-circuit before running any
  // verdict pipeline and return this shape instead — no verdict/confidence
  // exist on this response, so `type` is checked before any of the normal
  // verdict fields are touched. Mirrors the informational (non-verdict)
  // treatment payment QR codes already get on the QR page, just reachable
  // from any text-shaped input (typed claims, QR text, OCR'd photos,
  // audio transcripts) since that's where a receipt can turn up.
  type?: "verification" | "payment_receipt";
  receipt?: PaymentReceiptInfo | null;
  // Second verdict block (added for audio's combined Quick Check/Deep
  // Investigation, Sept 14, 2026 — see app/api/verify-audio-combined/
  // route.ts): when a single button press runs two independent pipelines
  // under one credit charge, this carries the second result so both show
  // on one result screen instead of forcing a second, separate check.
  // Absent on every other result type.
  secondary?: {
    id: string;
    eyebrow: string;
    verdict: string;
    confidence: number;
    explanation: string;
    caveats?: string[];
  } | null;
  // Client-side routing hint only, not something the API returns — set by
  // the page that submitted the check (added for the image page, Sept
  // 2026) so "verify another" can send the user back to the right form
  // even when that isn't simply /verify or /deep. Absent on every other
  // result, which falls back to the mode-based logic below unchanged.
  return_to?: string;
};

export default function ResultPage() {
  const router = useRouter();
  const [r, setR] = useState<Result | null>(null);

  useEffect(() => {
    const x = sessionStorage.getItem("vuryfy_result");
    if (x) setR(JSON.parse(x));
    else router.replace("/");
  }, [router]);

  if (!r) return null;

  // mode is absent on results saved before this field existed (an old
  // sessionStorage entry surviving a hard refresh) — quick is the correct
  // fallback since Deep Investigation didn't exist before mode was added.
  const isDeep = r.mode === "deep";
  const newCheckHref = r.return_to || (isDeep ? "/deep" : "/verify");

  if (r.type === "payment_receipt") {
    return (
      <main className="shell narrow">
        <nav>
          <button className="back" onClick={() => router.push(newCheckHref)}>
            ← New check
          </button>
          <div className="credits">Credits · {r.credits.total}</div>
        </nav>
        <section className="result">
          <p className="eyebrow">PAYMENT RECEIPT</p>
          <div className="qr-payment">
            <span>THIS LOOKS LIKE A PAYMENT RECEIPT</span>
            <h3>{r.receipt?.amount ? `₹${r.receipt.amount}` : "Amount not clearly readable"}</h3>
            {r.receipt?.fromName && <p className="payee-id">From: {r.receipt.fromName}</p>}
            {r.receipt?.toName && <p className="payee-id">To: {r.receipt.toName}</p>}
            {r.receipt?.appUsed && <p className="payee-id">Via: {r.receipt.appUsed}</p>}
            {r.receipt?.transactionId && <p className="payee-id">Transaction ID: {r.receipt.transactionId}</p>}
            {r.receipt?.date && <p className="payee-id">Date: {r.receipt.date}</p>}
            <p className="caution">
              Vuryfy can&apos;t confirm a private payment like this actually went through — there&apos;s
              no public record of a bank/UPI transfer for a search to check, so we can&apos;t give this
              a Verified/Unverified score the way we would a public claim. Receipts and screenshots
              like this can also be faked with widely available apps, even when they look completely
              convincing. The only way to be sure is to check your own bank or UPI app for the actual
              credit before relying on this. No credit was charged for this check.
            </p>
          </div>
          <div className="claim">
            <span>WHAT WE READ</span>
            <p>{r.claim}</p>
          </div>
          <div className="result-actions">
            <button className="secondary" onClick={() => router.push(newCheckHref)}>
              Check another
            </button>
          </div>
        </section>
      </main>
    );
  }

  // "Scam" verdict (Sept 2026 addition, see lib/quick-check.ts and
  // lib/deep-investigation.ts): gets its own red warning card instead of
  // blending into the plain verdict text every other verdict uses, so a
  // scam link doesn't read as just another "False". Applies to any claim
  // through either pipeline, not just QR-sourced ones.
  const isScam = r.verdict === "Scam";

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push(newCheckHref)}>
          ← New check
        </button>
        <div className="credits">Credits · {r.credits.total}</div>
      </nav>
      <section className="result">
        <p className="eyebrow">{isDeep ? "DEEP INVESTIGATION RESULT" : "QUICK CHECK RESULT"}</p>
        {isScam ? (
          <div className="scam-warning">
            <span>⚠ SCAM WARNING</span>
            <div className="verdict">Scam</div>
            <div className="confidence">Confidence · {r.confidence}%</div>
            <p className="caution">
              This was flagged as a scam based on the evidence found — don&apos;t click through,
              pay, or share personal details with it. Check the evidence below for what we found.
            </p>
          </div>
        ) : (
          <>
            <div className="verdict">{r.verdict}</div>
            <div className="confidence">Confidence · {r.confidence}%</div>
          </>
        )}
        <div className="claim">
          <span>CLAIM</span>
          <p>{r.claim}</p>
        </div>
        <div className="explanation">
          <span>WHY</span>
          <p>{r.explanation}</p>
        </div>
        {r.evidence?.length > 0 && (
          <div className="evidence">
            <span>EVIDENCE</span>
            {r.evidence.map((e, i) => (
              <a key={i} href={e.url} target="_blank" rel="noreferrer">
                <strong>{e.title}</strong>
                <small>{e.url}</small>
              </a>
            ))}
          </div>
        )}
        {r.caveats?.length > 0 && (
          <div className="caveats">
            <span>NOTES</span>
            {r.caveats.map((c, i) => (
              <p key={i}>{c}</p>
            ))}
          </div>
        )}
        {r.secondary && (
          <>
            <hr style={{ margin: "28px 0", border: "none", borderTop: "1px solid #e5e5e5" }} />
            <p className="eyebrow">{r.secondary.eyebrow}</p>
            <div className="verdict">{r.secondary.verdict}</div>
            <div className="confidence">Confidence · {r.secondary.confidence}%</div>
            <div className="explanation">
              <span>WHY</span>
              <p>{r.secondary.explanation}</p>
            </div>
            {r.secondary.caveats && r.secondary.caveats.length > 0 && (
              <div className="caveats">
                <span>NOTES</span>
                {r.secondary.caveats.map((c, i) => (
                  <p key={i}>{c}</p>
                ))}
              </div>
            )}
          </>
        )}
        <div className="result-actions">
          <button
            onClick={() =>
              navigator.clipboard?.writeText(r.claim + "\n\n" + r.verdict + "\n" + r.explanation)
            }
          >
            Share result
          </button>
          <button className="secondary" onClick={() => router.push(newCheckHref)}>
            Verify another
          </button>
        </div>
      </section>
    </main>
  );
}
