"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { extractTextFromImage } from "@/lib/decode-image-text";
import { prepareImageForUpload, type PreparedImage } from "@/lib/prepare-image-upload";

// Image input — the next step in the locked media-type build order (text +
// link -> QR -> image -> audio/video). Offers up to two independent
// analyses of the same photo, but — Sept 15, 2026 — from a SINGLE set of
// buttons, not two. A photo can contain meaningful text, be itself the
// thing being judged, or both:
//
//   1. Text-in-image (lib/decode-image-text.ts, Tesseract.js, entirely
//      client-side): if the photo has readable text, it's extracted and
//      fact-checked (lib/quick-check.ts / lib/deep-investigation.ts).
//   2. Photo-as-claim (lib/image-analysis.ts, a real vision AI call): the
//      image is analyzed for visual signs of manipulation/AI generation,
//      optionally checked against a short user-provided context. Uses its
//      own honest, narrower verdict vocabulary (Clean/Suspicious/
//      Inconclusive) rather than True/False — see lib/image-analysis.ts.
//
// These originally shipped as two fully separate button pairs on one
// screen (one per analysis), mirroring how audio's transcript check and
// audio-authenticity check first shipped. Same complaint followed both
// times: two "Quick Check" buttons on one screen reads as confusing, not
// as two clearly different questions. Fixed the same way audio was fixed
// (see app/api/verify-audio-combined/route.ts): when OCR text was found,
// ONE Quick Check button and ONE Deep Investigation button now run BOTH
// analyses together via /api/verify-image-combined / /api/deep-image-
// combined, charging exactly 1 credit total, with both results shown on
// one result screen (see the `secondary` block in app/result/page.tsx).
// When no text was found in the photo, there's nothing to combine, so the
// photo-only buttons call /api/verify-image / /api/deep-image directly,
// unchanged.
//
// A photographed payment receipt (someone's "proof of payment" screenshot)
// is exactly why the combined route also runs the payment-receipt
// carve-out (lib/detect-payment-receipt.ts) on the OCR'd text before doing
// anything else — see that file and app/api/verify-image-combined/
// route.ts for the full rationale.
//
// Both OCR text extraction and the vision-upload prep run automatically,
// client-side, the moment a photo is chosen — no network call happens
// until the user explicitly presses one of the mode buttons below, same
// no-surprise-cost principle as every other confirm screen in the app.
export default function VerifyImagePage() {
  const router = useRouter();
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState("");
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedImage | null>(null);
  const [context, setContext] = useState("");
  const [submitting, setSubmitting] = useState<
    "combined-quick" | "combined-deep" | "vision-quick" | "vision-deep" | null
  >(null);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  async function handleFile(file: File) {
    setProcessing(true);
    setProcessError("");
    setOcrText(null);
    setPrepared(null);
    setSubmitError("");
    try {
      const [text, image] = await Promise.all([extractTextFromImage(file), prepareImageForUpload(file)]);
      setOcrText(text || null);
      setPrepared(image);
    } catch {
      setProcessError("Couldn't read that image. Try a different photo.");
    } finally {
      setProcessing(false);
    }
  }

  async function submitCombined(mode: "quick" | "deep") {
    if (!prepared || !ocrText) return;
    setSubmitting(mode === "quick" ? "combined-quick" : "combined-deep");
    setSubmitError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-image-combined" : "/api/deep-image-combined";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_base64: prepared.base64,
          mime_type: prepared.mimeType,
          ocr_text: ocrText,
          context: context.trim(),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Verification failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: "/verify/image" }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(null);
    }
  }

  async function submitVision(mode: "quick" | "deep") {
    if (!prepared) return;
    setSubmitting(mode === "quick" ? "vision-quick" : "vision-deep");
    setSubmitError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-image" : "/api/deep-image";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_base64: prepared.base64,
          mime_type: prepared.mimeType,
          context: context.trim(),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Analysis failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: "/verify/image" }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(null);
    }
  }

  function reset() {
    setOcrText(null);
    setPrepared(null);
    setContext("");
    setProcessError("");
    setSubmitError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const hasImage = !!prepared;
  const anySubmitting = !!submitting;
  const isCheckingCombined = submitting === "combined-quick" || submitting === "vision-quick";
  const isDeepCombined = submitting === "combined-deep" || submitting === "vision-deep";

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          ← Back
        </button>
        <div className="credits">Credits</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">IMAGE</p>
        <h1>Check a photo.</h1>
        <p className="sub">
          Upload a photo. If it has readable text, we&apos;ll offer to check that. Either way, you
          can also have us look at the photo itself for signs of editing or AI generation.
        </p>

        {!hasImage && (
          <>
            <input
              ref={fileInputRef}
              id="image-file"
              type="file"
              accept="image/*"
              capture="environment"
              className="qr-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <label htmlFor="image-file" className="primary-link">
              {processing ? "Reading…" : "Choose or take a photo"}
            </label>
            {processError && <p className="error">{processError}</p>}
            <p className="hint">
              Have a QR code instead? <Link href="/verify/qr">Scan it</Link>
            </p>
            <p className="hint">
              Got audio? <Link href="/verify/audio">Check it</Link>
            </p>
            <p className="hint">
              Got a video? <Link href="/verify/video">Check it</Link>
            </p>
          </>
        )}

        {hasImage && ocrText && (
          <div className="qr-decoded">
            <span>WE FOUND TEXT IN THIS IMAGE</span>
            <p>{ocrText}</p>
            <p className="hint">
              We&apos;ll also look at the photo itself for signs of editing or AI generation —
              both checks run from the buttons below.
            </p>
          </div>
        )}

        {hasImage && (
          <div className="qr-decoded">
            {!ocrText && <span>ANALYZE THE PHOTO ITSELF</span>}
            <p className="hint">
              {ocrText
                ? "Quick Check gives a fast answer for both. Deep Investigation researches more thoroughly and takes longer."
                : "We'll look at the image for signs of editing or AI generation — not a source-verified fact-check, just a visual read. Optionally tell us what this photo is supposed to show, and we'll note whether that looks visually consistent."}
            </p>
            <textarea
              className="context-textarea"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="What is this photo supposed to show? (optional)"
              maxLength={500}
            />
            <div className="result-actions">
              <button className="secondary" onClick={reset} disabled={anySubmitting}>
                Choose another
              </button>
              <button
                className="secondary"
                onClick={() => (ocrText ? submitCombined("deep") : submitVision("deep"))}
                disabled={anySubmitting}
              >
                {isDeepCombined ? "Investigating…" : "Deep Investigation"}
              </button>
              <button
                onClick={() => (ocrText ? submitCombined("quick") : submitVision("quick"))}
                disabled={anySubmitting}
              >
                {isCheckingCombined ? "Checking…" : "Quick Check"}
              </button>
            </div>
            {submitError && <p className="error">{submitError}</p>}
          </div>
        )}
      </section>
    </main>
  );
}
