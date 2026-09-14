import Tesseract from "tesseract.js";

// Client-side OCR text extraction — deterministic-tool-first per Part 11
// ("OCR use deterministic/dedicated tools first; AI is only invoked on the
// extracted output, never to 'read' what a deterministic tool can already
// extract"), same principle already applied to QR (lib/decode-qr.ts). This
// runs entirely in the browser via Tesseract.js: the photo never leaves the
// device for this path, only the extracted text is ever sent to the
// server — through the exact same /api/verify (and /api/deep) endpoint a
// manually-typed claim uses, with input_type: "ocr". No image upload, no
// storage, none of Part 15's media-retention questions apply here, exactly
// like QR.
//
// V1 scope: English only ("eng" traineddata). Vuryfy's multilingual design
// (Part 11) is about the CLAIM text once extracted — canonical
// representation, research in English, localized output — not about OCR
// itself being multilingual. Real-world screenshots in Hindi/other launch
// languages won't extract cleanly yet; adding language packs (Tesseract
// supports "eng+hin" etc.) is a follow-up once the English path is proven
// working, not bundled into this first cut ("build thin, not full", Part
// 11 refinement #3, applied here to OCR the same way it was applied to the
// AI Gateway).
//
// Downscales before recognition, same speed rationale as QR's downscale —
// phone photos can be 4000px+ and Tesseract's recognition time scales with
// pixel count — but uses a taller MAX_DIMENSION than QR's 1000px, since
// legible small text (a screenshot's captions, a forwarded message's body)
// needs materially more resolution than a QR code's coarse modules to
// survive downscaling without becoming unreadable.
const MAX_DIMENSION = 1600;

// Tesseract's own 0-100 confidence score for the whole recognized page.
// Below this, treat it as "no usable text" rather than surfacing garbled
// low-confidence OCR output as if it were a real extracted claim — a
// wrong/garbled "claim" fed into the verification pipeline would produce a
// verdict about text that was never actually in the image.
const MIN_CONFIDENCE = 40;

export async function extractTextFromImage(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(img, 0, 0, width, height);

    const { data } = await Tesseract.recognize(canvas, "eng");
    if (!data.text || data.confidence < MIN_CONFIDENCE) return "";
    return data.text.trim();
  } catch {
    // OCR failing is not an error state for the caller — it just means no
    // text was found, same as jsQR returning null for QR decode.
    return "";
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't load that image."));
    img.src = src;
  });
}
