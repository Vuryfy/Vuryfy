// Video transcription, take 2 (Sept 15, 2026) — moved off Gemini onto
// Deepgram's dedicated speech-to-text API. Gemini's own transcription call
// hit a *sustained* run of 503 "model overloaded" errors during real
// testing that day — three separate occurrences, the last one surviving
// even lib/video-transcript.ts's widened 4-attempt retry — which is Google
// shared-infrastructure saturation on a preview-tier model
// (gemini-3.1-flash-lite), not something client-side retries can reliably
// out-wait. Transcription is the FIRST step of every single video check
// (free preview, before any credit is spent), so it's the worst possible
// place in the pipeline for that kind of failure. Deepgram is a
// purpose-built ASR vendor — transcription is their entire product, not a
// side task on a shared general-reasoning model pool — so it should have
// materially better throughput/availability headroom for exactly this job.
//
// lib/video-transcript.ts (the Gemini version) is left in place, unused by
// this route for now, rather than deleted — video-analysis.ts's
// authenticity/deepfake pass stays on Gemini (that decision needs real
// usage data first, see architecture-decisions.md), and keeping the old
// path around costs nothing and makes reverting a one-line route change if
// this pilot doesn't work out.
//
// Sept 15, 2026, revision 2 (same day): the first version of this file
// extracted audio via ffmpeg-static + child_process before uploading, on
// the assumption Deepgram needed a plain audio file (their own blog guide
// does exactly that: https://deepgram.com/learn/transcribe-videos-nodejs).
// That hit a real wall in production: ffmpeg-static locates its binary via
// a `path.join(__dirname, 'ffmpeg')` computed at import time, and Next.js's
// serverless bundling rewrites __dirname for a bundled route to the
// route's OWN output directory (.next/server/app/api/transcribe-video/)
// rather than where the binary actually lives — so the spawn failed with
// ENOENT in production despite building and type-checking cleanly.
// Vercel's own guidance is to avoid shipping native binaries like ffmpeg
// into serverless functions at all — real risk of blowing the function's
// size limit even once the path problem is solved. Deepgram's own
// supported-formats docs explicitly list MP4 and WebM (they decode the
// audio track server-side, same as Gemini does), so this revision skips
// ffmpeg entirely and uploads the video file as-is with its real
// Content-Type. Simpler, no native binary, no bundling footgun.

export class DeepgramTranscriptionError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DeepgramTranscriptionError";
    this.cause = cause;
  }
}

const DEEPGRAM_ENDPOINT = "https://api.deepgram.com/v1/listen";

// Sept 15, 2026: language "multi" (rather than a hardcoded "hi" or "en")
// is Deepgram's documented setting for Hindi-English code-switched speech
// — the app's real content is frequently Hinglish (see the "Mummy beta
// happy ho jao" test claim), not cleanly one language or the other.
// Real-world Hinglish accuracy varies a lot by vendor/model per published
// benchmarks, so this is explicitly a pilot: compare its output against
// what Gemini was producing before deciding this replaces it for good.
export async function transcribeVideoSpeechViaDeepgram(videoBytes: ArrayBuffer, mimeType: string): Promise<string> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new DeepgramTranscriptionError("DEEPGRAM_API_KEY is not set");
  }

  const query = new URLSearchParams({
    model: "nova-3",
    language: "multi",
    smart_format: "true",
    punctuate: "true",
  });

  let response: Response;
  try {
    response = await fetch(`${DEEPGRAM_ENDPOINT}?${query.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": mimeType,
      },
      // fetch's TS signature comes from the "dom" lib (tsconfig.json's
      // `lib` array), whose BodyInit type doesn't structurally accept
      // @types/node's newer generic `Buffer<ArrayBufferLike>` even though
      // it's a real ArrayBufferView at runtime — wrapping in a plain
      // Uint8Array satisfies the DOM type exactly.
      body: new Uint8Array(videoBytes),
      // Sending the full video now (not a small extracted audio track), so
      // this gets a longer allowance than a typical fast AI call — still
      // comfortably inside this route's own 300s maxDuration.
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new DeepgramTranscriptionError("Deepgram request failed (network/timeout)", err);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new DeepgramTranscriptionError(`Deepgram API error ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  const json = await response.json().catch((err) => {
    throw new DeepgramTranscriptionError("Deepgram response was not valid JSON", err);
  });

  const transcript: unknown = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return typeof transcript === "string" ? transcript.trim() : "";
}
