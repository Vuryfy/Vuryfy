"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { decodeQrFromFile } from "@/lib/decode-qr";
import { detectPaymentLink, type PaymentLinkInfo } from "@/lib/detect-payment-link";

// QR Quick Check — the next step in the locked media-type build order
// (text + link, then QR, then image, then audio/video). The QR image is
// decoded entirely client-side (see lib/decode-qr.ts) and only the
// decoded text is ever sent to the server, through the exact same
// /api/verify path a typed claim uses — just with input_type: "qr"
// instead of "text"/"link". No new backend pipeline, no image
// upload/storage: this reuses everything Quick Check already has.
//
// Payment QR codes (UPI upi://pay?... links, etc.) are a deliberate
// exception, added the same day after testing against a real UPI QR: they
// never reach /api/verify (or /api/deep) at all. See lib/detect-payment-link.ts
// for why — neither pipeline has a way to confirm who controls a payment
// ID, so running one through either produces a misleading low-confidence
// result for legitimate and fraudulent payees alike. Detected payment
// links get an informational card instead — payee name/ID surfaced
// plainly with a caution note, no verdict, no credit charged, for either
// mode.
//
// Decoded (non-payment) claims offer BOTH Quick Check and Deep
// Investigation from the same screen, rather than QR having its own
// mode-specific entry point. This is a deliberate standing pattern (Sept
// 2026): whatever a claim's source — typed, QR, and any future input type
// (image, audio/video) — the two verification modes should stay two
// buttons on one confirm screen, not two separate capture flows. It keeps
// the payment-QR guard, the decode/extract step, and any per-input-type
// UI in exactly one place per input type, while both /api/verify and
// /api/deep stay reachable from it.
//
// Payee look-alike detection (added Sept 15, 2026, prompted by a real
// near-miss the user reported — see app/api/check-payee/route.ts and
// migration 0007 for the full rationale): every detected payment QR's
// payee name + UPI ID is checked against the user's own scan history via
// the free /api/check-payee route. A name that's near-identical to one
// already seen, but under a DIFFERENT UPI ID, surfaces an extra warning
// card above the standard payment-QR caution — a common impersonation
// pattern this doesn't claim to resolve (it never says which of the two
// is the real one), only surfaces for the user to check before paying.
//
// Payee reputation investigation (added Sept 15, 2026, prompted by "what
// if I want Deep Investigation on this payment QR?"): the payment-QR
// carve-out above is correct that NEITHER pipeline can confirm who
// controls a payment ID or that a transaction happened — that's still
// true here. But a genuinely different, answerable question exists: does
// this payee's NAME or UPI ID have any public reputation (scam reports,
// complaints, a legitimate business footprint)? That's an ordinary
// evidence-grounded web search, same as any other claim, just constructed
// from the payee's identity rather than typed by the user — see
// app/api/verify-payee/route.ts and app/api/deep-payee/route.ts. Offered
// as its own Quick Check/Deep Investigation pair, separate from the
// payment-info card's "Scan another" action, and only for UPI payment
// links (there's no payee identity to search for a bare payment-link URL
// like paypal.me).
type PayeeSimilarMatch = { payeeName: string; upiId: string; similarity: number; firstSeenAt: string };

export default function VerifyQrPage() {
  const router = useRouter();
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [decoding, setDecoding] = useState(false);
  const [decoded, setDecoded] = useState<string | null>(null);
  const [paymentInfo, setPaymentInfo] = useState<PaymentLinkInfo | null>(null);
  const [payeeWarning, setPayeeWarning] = useState<PayeeSimilarMatch | null>(null);
  const [decodeError, setDecodeError] = useState("");
  const [submitting, setSubmitting] = useState<"quick" | "deep" | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [payeeChecking, setPayeeChecking] = useState<"quick" | "deep" | null>(null);
  const [payeeCheckError, setPayeeCheckError] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  async function handleFile(file: File) {
    setDecoding(true);
    setDecodeError("");
    setDecoded(null);
    setPaymentInfo(null);
    setPayeeWarning(null);
    setPayeeCheckError("");
    try {
      const result = await decodeQrFromFile(file);
      if (!result) {
        setDecodeError(
          "Couldn't find a QR code in that image. Try a clearer, well-lit photo where the code fills more of the frame."
        );
        return;
      }
      const payment = detectPaymentLink(result);
      if (payment) {
        setPaymentInfo(payment);
        if (payment.payeeId) {
          try {
            const r = await fetch("/api/check-payee", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ upi_id: payment.payeeId, payee_name: payment.payeeName ?? "" }),
            });
            const d = await r.json();
            if (r.ok && d.similarMatch) {
              setPayeeWarning(d.similarMatch);
            }
          } catch {
            // Bonus safety check only — never let a failure here block the
            // payment-info card the user actually needs to see.
          }
        }
      } else {
        setDecoded(result);
      }
    } catch {
      setDecodeError("Couldn't read that image. Try a different photo.");
    } finally {
      setDecoding(false);
    }
  }

  async function confirm(mode: "quick" | "deep") {
    if (!decoded) return;
    setSubmitting(mode);
    setSubmitError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify" : "/api/deep";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim: decoded, input_type: "qr" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Verification failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify(d));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(null);
    }
  }

  async function investigatePayee(mode: "quick" | "deep") {
    if (!paymentInfo?.payeeId) return;
    setPayeeChecking(mode);
    setPayeeCheckError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-payee" : "/api/deep-payee";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payee_name: paymentInfo.payeeName ?? "", upi_id: paymentInfo.payeeId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Investigation failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: "/verify/qr" }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setPayeeCheckError(e.message);
    } finally {
      setPayeeChecking(null);
    }
  }

  function reset() {
    setDecoded(null);
    setPaymentInfo(null);
    setPayeeWarning(null);
    setDecodeError("");
    setSubmitError("");
    setPayeeCheckError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          ← Back
        </button>
        <div className="credits">Credits</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">QR CODE</p>
        <h1>Scan a QR code.</h1>
        <p className="sub">
          Upload a photo of a QR code and choose Quick Check or Deep Investigation for what it
          points to. Only the text inside the code is sent to us — the photo itself never leaves
          your device.
        </p>

        {!decoded && !paymentInfo && (
          <>
            <input
              ref={fileInputRef}
              id="qr-file"
              type="file"
              accept="image/*"
              capture="environment"
              className="qr-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <label htmlFor="qr-file" className="primary-link">
              {decoding ? "Reading…" : "Choose or take a photo"}
            </label>
            {decodeError && <p className="error">{decodeError}</p>}
            <p className="hint">
              Got a regular photo instead of a QR code? <Link href="/verify/image">Check it</Link>
            </p>
            <p className="hint">
              Got audio? <Link href="/verify/audio">Check it</Link>
            </p>
            <p className="hint">
              Got a video? <Link href="/verify/video">Check it</Link>
            </p>
          </>
        )}

        {paymentInfo && (
          <div className="qr-payment">
            <span>THIS IS A PAYMENT QR CODE</span>
            <h3>{paymentInfo.payeeName || "Unnamed payee"}</h3>
            {paymentInfo.payeeId && <p className="payee-id">{paymentInfo.payeeId}</p>}
            {payeeWarning && (
              <div className="scam-warning">
                <span>⚠ SIMILAR NAME, DIFFERENT PAYMENT ID</span>
                <p className="caution">
                  This name is very close to <strong>{payeeWarning.payeeName}</strong> (ID:{" "}
                  {payeeWarning.upiId}), which you&apos;ve scanned before in Vuryfy — but this QR
                  code uses a different payment ID. This is a common impersonation pattern.
                  Vuryfy can&apos;t tell you which of the two is the real one — verify directly
                  with who you intend to pay before proceeding.
                </p>
              </div>
            )}
            <p className="caution">
              Vuryfy can&apos;t verify who actually controls a payment ID from a QR code alone —
              that isn&apos;t something a web search can confirm. Before paying, make sure the
              name above matches who you intend to pay, and confirm directly with them if
              you&apos;re unsure.
            </p>

            {paymentInfo.kind === "upi" && paymentInfo.payeeId && (
              <div className="qr-decoded" style={{ marginTop: 20 }}>
                <span>INVESTIGATE THIS PAYEE</span>
                <p className="hint">
                  This searches the public web for the payee&apos;s name and ID — scam reports,
                  complaints, or a legitimate business presence. It still can&apos;t confirm this
                  transaction or who controls the ID; it can only tell you what&apos;s publicly
                  findable, which may be nothing either way.
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

            <div className="result-actions">
              <button className="secondary" onClick={reset}>
                Scan another
              </button>
            </div>
          </div>
        )}

        {decoded && (
          <div className="qr-decoded">
            <span>WE FOUND THIS IN YOUR QR CODE</span>
            <p>{decoded}</p>
            <p className="hint">
              Quick Check gives a fast answer. Deep Investigation researches it more thoroughly
              and takes longer.
            </p>
            <div className="result-actions">
              <button className="secondary" onClick={reset} disabled={!!submitting}>
                Scan another
              </button>
              <button className="secondary" onClick={() => confirm("deep")} disabled={!!submitting}>
                {submitting === "deep" ? "Investigating…" : "Deep Investigation"}
              </button>
              <button onClick={() => confirm("quick")} disabled={!!submitting}>
                {submitting === "quick" ? "Checking…" : "Quick Check"}
              </button>
            </div>
            {submitError && <p className="error">{submitError}</p>}
          </div>
        )}
      </section>
    </main>
  );
}
