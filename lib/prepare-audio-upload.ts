// Client-side prep for audio input — the last step in the locked media-type
// build order (text + link -> QR -> image -> audio/video), audio half.
// Unlike QR decode and image OCR, there is no viable deterministic,
// client-side speech-to-text tool to run first (no small WASM model ships
// with this app, and the browser's native SpeechRecognition API works on a
// live microphone stream, not an arbitrary uploaded file, and isn't
// consistently available across browsers). So unlike QR/OCR, audio
// genuinely has to reach the server for BOTH of its sub-paths — see
// lib/audio-transcript.ts's file header for why that transcription step is
// still kept free (no credit charged) despite being a real AI call, the one
// place this app's "extraction is free, checking costs a credit" pattern
// costs something to uphold rather than being free by construction.
//
// No re-encoding/downscaling here (unlike prepare-image-upload.ts) — audio
// files are already compressed by the device/app that produced them, and
// there's no cheap client-side re-encode available without a heavy library
// (ffmpeg.wasm and similar). V1 keeps this simple: read the file as-is,
// validate size, base64-encode. Revisit if oversized uploads turn out to be
// common in practice.
const MAX_BYTES = 15 * 1024 * 1024; // ~15MB — generous for a few minutes of compressed speech audio

export interface PreparedAudio {
  base64: string; // no "data:audio/...;base64," prefix
  mimeType: string;
}

export async function prepareAudioForUpload(file: File): Promise<PreparedAudio> {
  if (file.size > MAX_BYTES) {
    throw new Error("That audio file is too large. Try a shorter clip.");
  }
  const mimeType = file.type || "audio/mpeg";
  const base64 = await readFileAsBase64(file);
  if (!base64) throw new Error("Couldn't read that audio file.");
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
    reader.onerror = () => reject(new Error("Couldn't read that audio file."));
    reader.readAsDataURL(file);
  });
}
