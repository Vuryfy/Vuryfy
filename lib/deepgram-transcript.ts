import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

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
// Deepgram's own docs/guides extract audio from video before calling
// /v1/listen rather than sending the video container directly — see
// https://deepgram.com/learn/transcribe-videos-nodejs. ffmpeg-static
// bundles a static ffmpeg binary that works in Vercel's Node.js serverless
// runtime; see next.config.ts's outputFileTracingIncludes for the config
// needed so that binary actually ships with the deployed function (Next's
// file tracing doesn't pick it up automatically — a real, easy-to-miss
// gotcha with this package on Vercel).

export class DeepgramTranscriptionError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DeepgramTranscriptionError";
    this.cause = cause;
  }
}

const DEEPGRAM_ENDPOINT = "https://api.deepgram.com/v1/listen";

const EXTENSION_FOR_MIME_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/3gpp": "3gp",
  "video/x-msvideo": "avi",
};

// Strips the video track and downmixes to 16kHz mono WAV — Deepgram only
// needs the audio, and a smaller, simpler file uploads and transcribes
// faster than sending full-quality stereo audio would.
async function extractAudioToWav(videoBytes: Buffer, mimeType: string): Promise<Buffer> {
  if (!ffmpegPath) {
    throw new DeepgramTranscriptionError("ffmpeg binary is not available in this environment");
  }

  const ext = EXTENSION_FOR_MIME_TYPE[mimeType] ?? "mp4";
  const id = randomUUID();
  const inPath = path.join(os.tmpdir(), `${id}-in.${ext}`);
  const outPath = path.join(os.tmpdir(), `${id}-out.wav`);

  await writeFile(inPath, videoBytes);

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath as string, [
        "-hide_banner",
        "-y",
        "-i",
        inPath,
        "-vn", // drop the video stream — audio only
        "-ac",
        "1", // mono
        "-ar",
        "16000", // 16kHz — plenty for speech, keeps the upload small
        outPath,
      ]);

      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) => reject(new DeepgramTranscriptionError("Failed to launch ffmpeg", err)));
      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new DeepgramTranscriptionError(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
        }
      });
    });

    return await readFile(outPath);
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

// Sept 15, 2026: language "multi" (rather than a hardcoded "hi" or "en")
// is Deepgram's documented setting for Hindi-English code-switched speech
// — the app's real content is frequently Hinglish (see the "Mummy beta
// happy ho jao" test claim), not cleanly one language or the other.
// Real-world Hinglish accuracy varies a lot by vendor/model per published
// benchmarks, so this is explicitly a pilot: compare its output against
// what Gemini was producing before deciding this replaces it for good.
export async function transcribeVideoSpeechViaDeepgram(videoBytes: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new DeepgramTranscriptionError("DEEPGRAM_API_KEY is not set");
  }

  const wavBytes = await extractAudioToWav(videoBytes, mimeType);

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
        "Content-Type": "audio/wav",
      },
      body: wavBytes,
      // Audio-only upload, already downmixed and small — no need for the
      // long timeouts the direct-video Gemini calls need.
      signal: AbortSignal.timeout(60_000),
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
