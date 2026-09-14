"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { decodeQrFromFile } from "@/lib/decode-qr";

// QR Quick Check — the next step in the locked media-type build order
// (text + link, then QR, then image, then audio/video). The QR image is
// decoded entirely client-side (see lib/decode-qr.ts) and only the
// decoded text is ever sent to the server, through the exact same
// /api/verify path a typed claim uses — just with input_type: "qr"
// instead of "text"/"link". No new backend pipeline, no image
// upload/storage: this reuses everything Quick Check already has.
export default function VerifyQrPage() {
  const router = useRouter();
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [decoding, setDecoding] = useState(false);
  const [decoded, setDecoded] = useState<string | null>(null);
  const [decodeError, setDecodeError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  async function handleFile(file: File) {
    setDecoding(true);
    setDecodeError("");
    setDecoded(null);
    try {
      const result = await decodeQrFromFile(file);
      if (!result) {
        setDecodeError(
          "Couldn't find a QR code in that image. Try a clearer, well-lit photo where the code fills more of the frame."
        );
      } else {
        setDecoded(result);
      }
    } catch {
      setDecodeError("Couldn't read that image. Try a different photo.");
    } finally {
      setDecoding(false);
    }
  }

  async function confirm() {
    if (!decoded) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const r = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim: decoded, input_type: "qr" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Verification failed");
      sessionStorage.setItem("vuryfy_result", JSON.stringify(d));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setDecoded(null);
    setDecodeError("");
    setSubmitError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/verify")}>
          ← Back
        </button>
        <div className="credits">Credits</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">QUICK CHECK · QR CODE</p>
        <h1>Scan a QR code.</h1>
        <p className="sub">
          Upload a photo of a QR code and we&apos;ll check what it points to. Only the text inside
          the code is sent to us — the photo itself never leaves your device.
        </p>

        {!decoded && (
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
          </>
        )}

        {decoded && (
          <div className="qr-decoded">
            <span>WE FOUND THIS IN YOUR QR CODE</span>
            <p>{decoded}</p>
            <div className="result-actions">
              <button className="secondary" onClick={reset} disabled={submitting}>
                Scan another
              </button>
              <button onClick={confirm} disabled={submitting}>
                {submitting ? "Checking…" : "Verify this"}
              </button>
            </div>
            {submitError && <p className="error">{submitError}</p>}
          </div>
        )}
      </section>
    </main>
  );
}
