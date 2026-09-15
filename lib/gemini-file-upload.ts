// Gemini File API integration — added Sept 15, 2026 when video moved off
// inline base64 data (see lib/ai-gateway.ts's header for the full context:
// why inline data was never a robust fit for a real "3-5 minute video"
// size cap). Videos now reach this server via Supabase Storage (see
// supabase/migrations/0009_temp_video_storage.sql), and THIS file re-
// uploads those bytes to Gemini's own File API rather than embedding them
// as inline base64 in the generateContent request — Gemini's inline-
// request limit (100MB total, effectively less once base64-inflated) is
// not a robust fit for a deliberately larger video size cap, while the
// File API's own limit is far more generous: 2GB per file
// (https://ai.google.dev/gemini-api/docs/files, confirmed Sept 2026).
//
// Retention: Gemini auto-deletes uploaded files after 48 hours regardless,
// but every caller of uploadVideoToGemini() also explicitly calls
// deleteGeminiFile() immediately after use (success or failure, via
// try/finally at the call site — see the video API routes) to stay
// consistent with this app's Part 15 media-retention principle: nothing
// about a user's video content is meant to outlive the single request
// that analyzes it, on our infrastructure OR a provider's.
//
// No official Gemini Node SDK is used anywhere in this app (see
// ai-gateway.ts) — this implements Google's resumable-upload protocol
// directly via fetch, mirroring the documented two-step start / upload-
// and-finalize flow.

const FILES_UPLOAD_ENDPOINT = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const FILES_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/files";

export interface GeminiFileRef {
  fileUri: string;
  name: string; // e.g. "files/abc123" — needed to delete the file afterward
}

export class GeminiFileUploadError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GeminiFileUploadError";
    this.cause = cause;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 90_000; // videos can briefly sit in PROCESSING before Gemini can reference them — bounded wait, not unbounded

// Video files can briefly sit in a PROCESSING state right after upload
// before Gemini can reference them in generateContent. Most clips
// (especially short-to-medium ones) read ACTIVE immediately, so this loop
// is a no-op in the common case. Bounded, and deliberately non-fatal on a
// timeout or a transient check failure — if the file genuinely isn't
// ready, the subsequent generateContent call will fail with a clear error
// rather than this function hanging indefinitely.
async function waitForFileActive(name: string, apiKey: string): Promise<void> {
  const shortName = name.replace(/^files\//, "");
  const deadline = Date.now() + MAX_POLL_MS;
  while (Date.now() < deadline) {
    let response: Response;
    try {
      response = await fetch(`${FILES_ENDPOINT}/${shortName}?key=${apiKey}`, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return; // transient check failure isn't fatal — fall through to the real call
    }
    if (!response.ok) return;
    const json = await response.json().catch(() => null);
    const state = json?.state;
    if (state === "ACTIVE") return;
    if (state === "FAILED") {
      throw new GeminiFileUploadError("Gemini failed to process the uploaded video file");
    }
    await sleep(POLL_INTERVAL_MS);
  }
  // Timed out waiting — proceed anyway; worst case generateContent itself
  // returns a clear "file not ready" error instead of this hanging longer.
}

export async function uploadVideoToGemini(
  bytes: ArrayBuffer,
  mimeType: string,
  timeoutMs = 120_000
): Promise<GeminiFileRef> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiFileUploadError("GEMINI_API_KEY is not set");

  const numBytes = bytes.byteLength;

  // Step 1: start a resumable upload session — declares size/mime type up
  // front, gets back a one-time upload URL in the response headers.
  let startResponse: Response;
  try {
    startResponse = await fetch(`${FILES_UPLOAD_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(numBytes),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: "vuryfy-video" } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new GeminiFileUploadError("Gemini file upload failed to start (network/timeout)", err);
  }

  if (!startResponse.ok) {
    const bodyText = await startResponse.text().catch(() => "");
    throw new GeminiFileUploadError(
      `Gemini file upload start failed: ${startResponse.status} ${bodyText.slice(0, 300)}`
    );
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new GeminiFileUploadError("Gemini file upload did not return an upload URL");
  }

  // Step 2: send the actual bytes and finalize in one call.
  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": String(numBytes),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: bytes,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new GeminiFileUploadError("Gemini file upload failed to send bytes (network/timeout)", err);
  }

  if (!uploadResponse.ok) {
    const bodyText = await uploadResponse.text().catch(() => "");
    throw new GeminiFileUploadError(`Gemini file upload failed: ${uploadResponse.status} ${bodyText.slice(0, 300)}`);
  }

  const fileJson = await uploadResponse.json().catch((err) => {
    throw new GeminiFileUploadError("Gemini file upload response was not valid JSON", err);
  });

  const file = fileJson?.file;
  const fileUri: string | undefined = file?.uri;
  const name: string | undefined = file?.name;
  if (!fileUri || !name) {
    throw new GeminiFileUploadError("Gemini file upload response missing file URI/name", fileJson);
  }

  await waitForFileActive(name, apiKey);

  return { fileUri, name };
}

// Best-effort cleanup — logged, never thrown, since a failed delete here
// should never fail the user's actual check (Gemini's own 48h auto-expiry
// is the backstop). Called from a try/finally at every video route's call
// site regardless of whether the analysis itself succeeded.
export async function deleteGeminiFile(name: string): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;
  const shortName = name.replace(/^files\//, "");
  try {
    await fetch(`${FILES_ENDPOINT}/${shortName}?key=${apiKey}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[gemini-file-upload] failed to delete Gemini file (will auto-expire in 48h):", err);
  }
}
