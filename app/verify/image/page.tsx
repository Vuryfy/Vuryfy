"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { extractTextFromImage } from "@/lib/decode-image-text";
import { prepareImageForUpload, type PreparedImage } from "@/lib/prepare-image-upload";

// Image input — the next step in the locked media-type build order (text +
// link -> QR -> image -> audio/video). Ships as two independent sub-paths
// offered from the same confirm screen, both surfaced every time a photo
// is chosen, extending the standing "both Quick Check and Deep
// Investigation, from one confirm screen" pattern QR established (Sept
// 2026) to "both analysis TYPES too" — a photo can contain meaningful
// text, be itself the thing being judged, or both:
//
//   1. Text-in-image (lib/decode-image-text.ts, Tesseract.js, entirely
//      client-side): if the photo has readable text, it's extracted and
//      run through the exact same evidence-grounded text pipeline as a
//      typed claim or a QR-decoded link, via /api/verify and /api/deep
//      with input_type "ocr". The photo never leaves the device for this
//      path — only the extracted text is sent.
//   2. Photo-as-claim (lib/image-analysis.ts, a real vision AI call, via
//      the new /api/verify-image and /api/deep-image routes): the image
//      is analyzed for visual signs of manipulation/AI generation,
//      optionally checked against a short user-provided context. Uses its
//      own honest, narrower verdict vocabulary (Clean/Suspicious/
//      Inconclusive) rather than True/False, because there's no reverse-
//      image-search provider in the stack to actually confirm a photo's
//      real-world origin — see lib/image-analysis.ts for the full
//      reasoning. This is the one case where the image really does leave
//      the device (sent to the AI provider), never stored server-side.
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
    "ocr-quick" | "ocr-deep" | "vision-quick" | "vision-deep" | null
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

  async function submitOcr(mode: "quick" | "deep") {
    if (!ocrText) return;
    setSubmitting(mode === "quick" ? "ocr-quick" : "ocr-deep");
    setSubmitError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify" : "/api/deep";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim: ocrText, input_type: "ocr" }),
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
          </>
        )}

        {hasImage && ocrText && (
          <div className="qr-decoded">
            <span>WE FOUND TEXT IN THIS IMAGE</span>
            <p>{ocrText}</p>
            <p className="hint">
              Quick Check gives a fast answer. Deep Investigation researches it more thoroughly
              and takes longer.
            </p>
            <div className="result-actions">
              <button className="secondary" onClick={() => submitOcr("deep")} disabled={anySubmitting}>
                {submitting === "ocr-deep" ? "Investigating…" : "Deep Investigation"}
              </button>
              <button onClick={() => submitOcr("quick")} disabled={anySubmitting}>
                {submitting === "ocr-quick" ? "Checking…" : "Quick Check"}
              </button>
            </div>
          </div>
        )}

        {hasImage && (
          <div className="qr-decoded">
            <span>ANALYZE THE PHOTO ITSELF</span>
            <p className="hint">
              We&apos;ll look at the image for signs of editing or AI generation — not a
              source-verified fact-check, just a visual read. Optionally tell us what this photo
              is supposed to show, and we&apos;ll note whether that looks visually consistent.
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
              <button className="secondary" onClick={() => submitVision("deep")} disabled={anySubmitting}>
                {submitting === "vision-deep" ? "Investigating…" : "Deep Investigation"}
              </button>
              <button onClick={() => submitVision("quick")} disabled={anySubmitting}>
                {submitting === "vision-quick" ? "Checking…" : "Quick Check"}
              </button>
            </div>
            {submitError && <p className="error">{submitError}</p>}
          </div>
        )}
      </section>
    </main>
  );
}
