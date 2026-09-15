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
// The size cap is deliberately tighter than audio's (15MB, same absolute
// number, but video packs far less duration per MB than compressed audio
// does) — this is a real, explicit V1 scope limit: it comfortably covers a
// short phone-camera clip (a few seconds to maybe 20-30s of typical mobile
// H.264 compression) but not a long video. That's an acceptable trade for
// V1 (see lib/ai-gateway.ts's header on why this stays on Gemini's inline
// data path rather than its File API) — revisit if real usage shows people
// routinely need to check longer clips.
const MAX_BYTES = 15 * 1024 * 1024; // ~15MB — keeps base64 payload comfortably under Gemini's inline request limit

export interface PreparedVideo {
  base64: string; // no "data:video/...;base64," prefix
  mimeType: string;
}

export async function prepareVideoForUpload(file: File): Promise<PreparedVideo> {
  if (file.size > MAX_BYTES) {
    throw new Error("That video is too large. Try a shorter clip (under ~15MB).");
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
