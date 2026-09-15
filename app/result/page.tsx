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

type PaymentRequestInfo = {
  payeeName?: string;
  payeeId?: string;
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
  // Payment-REQUEST carve-out (Sept 15, 2026, see lib/detect-payment-
  // request.ts): sibling of payment_receipt above, for text/OCR shaped
  // like a "scan to pay" identity card (name + UPI ID, no completed
  // transaction) rather than a completed-payment confirmation — the same
  // informational, non-verdict treatment, just a different source shape
  // (most commonly a photographed/OCR'd screenshot of someone's own QR
  // display screen).
  type?: "verification" | "payment_receipt" | "payment_request";
  receipt?: PaymentReceiptInfo | null;
  payment_request?: PaymentRequestInfo | null;
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
  const [payeeChecking, setPayeeChecking] = useState<"quick" | "deep" | null>(null);
  const [payeeCheckError, setPayeeCheckError] = useState("");

  useEffect(() => {
    const x = sessionStorage.getItem("vuryfy_result");
    if (x) setR(JSON.parse(x));
    else router.replace("/");
  }, [router]);

  if (!r) return null;

  // Reuses app/api/verify-payee and app/api/deep-payee (see
  // app/verify/qr/page.tsx for the original of this pattern, added for a
  // QR-decoded payment link). Available here too since a payment_request
  // card carries the same payee name/UPI ID a QR-decoded one does — the
  // question "does this payee have any public reputation" is answerable
  // either way. Swaps the displayed result in place rather than
  // navigating, since we're already on /result.
  async function investigatePayee(mode: "quick" | "deep") {
    if (!r?.payment_request?.payeeId) return;
    setPayeeChecking(mode);
    setPayeeCheckError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-payee" : "/api/deep-payee";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payee_name: r.payment_request.payeeName ?? "",
          upi_id: r.payment_request.payeeId,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Investigation failed");
      const next = { ...d, return_to: r.return_to };
      sessionStorage.setItem("vuryfy_result", JSON.stringify(next));
      setR(next);
    } catch (e: any) {
      setPayeeCheckError(e.message);
    } finally {
      setPayeeChecking(null);
    }
  }

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

  if (r.type === "payment_request") {
    return (
      <main className="shell narrow">
        <nav>
          <button className="back" onClick={() => router.push(newCheckHref)}>
            ← New check
          </button>
          <div className="credits">Credits · {r.credits.total}</div>
        </nav>
        <section className="result">
          <p className="eyebrow">PAYMENT REQUEST / QR CODE</p>
          <div className="qr-payment">
            <span>THIS LOOKS LIKE A "SCAN TO PAY" CARD</span>
            <h3>{r.payment_request?.payeeName || "Unnamed payee"}</h3>
            {r.payment_request?.payeeId && <p className="payee-id">{r.payment_request.payeeId}</p>}
            <p className="caution">
              Vuryfy can&apos;t verify who actually controls a payment ID like this — that
              isn&apos;t something a web search can confirm, whether it arrives as a scannable QR
              code or a screenshot of one. Before paying, make sure the name above matches who
              you intend to pay, and confirm directly with them if you&apos;re unsure. No credit
              was charged for this check.
            </p>
          </div>

          {r.payment_request?.payeeId && (
            <div className="qr-decoded" style={{ marginTop: 20 }}>
              <span>INVESTIGATE THIS PAYEE</span>
              <p className="hint">
                This searches the public web for the payee&apos;s name and ID — scam reports,
                complaints, or a legitimate business presence. It still can&apos;t confirm who
                controls the ID; it can only tell you what&apos;s publicly findable, which may be
                nothing either way.
              </p>
              <div className="result-actions">
                <button
                  className="secondary"
                  onClick={() => investigatePayee("deep")}
                  disabled={!!payeeChecking}
                >
                  {payeeChecking === "deep" ? "Investigating…" : "Deep Investigation"}
                </button>
                <button onClick={() => investigatePayee("quick")} disabled={!!payeeChecking}>
                  {payeeChecking === "quick" ? "Checking…" : "Quick Check"}
                </button>
              </div>
              {payeeCheckError && <p className="error">{payeeCheckError}</p>}
            </div>
          )}

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
