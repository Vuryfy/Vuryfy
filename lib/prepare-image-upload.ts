// Client-side prep for the ONE image input path that genuinely has to leave
// the device: photo-as-claim vision analysis (lib/image-analysis.ts on the
// server). Unlike QR decode and OCR text extraction — both fully
// client-side, so the photo itself never leaves the device — asking an AI
// model to actually look at the pixels requires sending the pixels
// somewhere. That's a deliberate, narrow exception to the "never leaves
// device" pattern QR/OCR established, not an oversight; see
// lib/image-analysis.ts's file header for the retention decision that goes
// with it (never stored, only ever passed through to the AI call).
//
// Downscales and re-encodes as JPEG before upload for two reasons: (1) a
// phone photo can be several MB, and Vercel's request body limit plus
// Gemini's inline-data limits make that worth avoiding regardless; (2) a
// smaller image is a faster round trip, which matters for Quick Check's
// latency target. 1600px is generous enough that visual manipulation
// artifacts (blending edges, texture repetition, inconsistent
// lighting/shadows) — the things this pipeline is actually looking for —
// survive the downscale; this isn't OCR, so unlike decode-image-text.ts
// there's no small-text-legibility reason to go higher.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

export interface PreparedImage {
  base64: string; // no "data:image/jpeg;base64," prefix
  mimeType: "image/jpeg";
}

export async function prepareImageForUpload(file: File): Promise<PreparedImage> {
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
    if (!ctx) throw new Error("Couldn't process that image.");
    ctx.drawImage(img, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const base64 = dataUrl.split(",")[1] ?? "";
    if (!base64) throw new Error("Couldn't process that image.");
    return { base64, mimeType: "image/jpeg" };
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
