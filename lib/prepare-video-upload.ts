// Client-side prep for video input — the last step in the locked media-type
// build order (text + link -> QR -> image -> audio -> video), shipping
// after audio per the user's explicit sequencing call (video is the more
// complex of the pair, so audio shipped and got fully tested first).
//
// Same "no viable deterministic client-side tool" situation as audio (see
// prepare-audio-upload.ts's header) — there's no small WASM model in this
// app for speech-to-text or frame analysis, so the file goes to the server
// for both of video's sub-paths (transcript and authenticity analysis),
// same as audio. No re-encoding/downscaling/frame-extraction here either —
// that would need a heavy client-side library (ffmpeg.wasm and similar);
// V1 keeps this simple: read the file as-is, validate size, base64-encode.
//
// The size cap below is NOT primarily a Gemini limit (see ai-gateway.ts's
// header) — it's driven by a harder, non-negotiable constraint discovered
// the same day this shipped: Vercel Serverless Functions cap the incoming
// REQUEST BODY at 4.5MB, a hard platform limit that cannot be raised on
// any plan, including this app's own Hobby tier. This video goes to the
// server as a base64 JSON body (video_base64 + mime_type + context), and
// base64 inflates raw bytes by ~4/3 — so the real ceiling on raw video
// size is well under Gemini's own inline-data limit, and far under the
// original 15MB this shipped with (which produced a silent, confusing 413
// "Content Too Large" for literally any real video file). 3MB raw keeps
// the base64 JSON body comfortably under 4.5MB with margin for the JSON
// wrapper and context field.
//
// This is a real, current V1 constraint on clip length (roughly a few
// seconds of typical phone-camera compression), not a stopgap fixed by
// tuning a number further — going meaningfully bigger needs a different
// upload path entirely (e.g. uploading straight to object storage from
// the browser and having the server fetch it from there, bypassing the
// serverless function's request body altogether), which is real
// additional work deliberately left for a follow-up rather than bundled
// into this fix.
const MAX_BYTES = 3 * 1024 * 1024; // ~3MB raw — keeps the base64 JSON body under Vercel's 4.5MB hard request-body cap

export interface PreparedVideo {
  base64: string; // no "data:video/...;base64," prefix
  mimeType: string;
}

export async function prepareVideoForUpload(file: File): Promise<PreparedVideo> {
  if (file.size > MAX_BYTES) {
    throw new Error(
      "That video is too large — Vercel's request size limit means we can only accept very short clips right now (under ~3MB, so a few seconds of typical phone video). Try trimming it or recording a shorter clip."
    );
  }
  const mimeType = file.type || "video/mp4";
  const base64 = await readFileAsBase64(file);
  if (!base64) throw new Error("Couldn't read that video file.");
  return { base64, mimeType };
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Couldn't read that video file."));
    reader.readAsDataURL(file);
  });
}
