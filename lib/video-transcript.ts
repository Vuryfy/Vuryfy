import { callStructured } from "@/lib/ai-gateway";

// Video transcription — the first half of video input (the second half,
// authenticity/deepfake-style analysis of the video itself, is
// lib/video-analysis.ts). Mirrors lib/audio-transcript.ts exactly, one
// level down: Gemini natively processes a video's own audio track from the
// same video content used for the authenticity pass, so this needs no
// separate audio-extraction step. Once transcribed, the text is run
// through the EXACT SAME evidence-grounded text pipeline as a typed claim,
// QR-decoded link, OCR-extracted text, or audio transcript — via
// /api/verify and /api/deep with input_type "video_transcript".
//
// Kept free for the same reason audio transcription is free (see
// audio-transcript.ts's header): UX consistency with every other input
// type's "extract first, see what you're checking, THEN spend a credit"
// pattern, and because it's a preprocessing step, not a completed Quick
// Check/Deep Investigation. Same "cheap" tier regardless of which mode the
// user picks afterward.
//
// Sept 15, 2026: takes a Gemini File API reference (fileUri) instead of
// inline base64 data — video now uploads to Gemini's File API rather than
// embedding raw bytes in the request, since the size cap needed to raise
// (per the direct-to-storage rework, see lib/gemini-file-upload.ts and
// supabase/migrations/0009_temp_video_storage.sql) no longer fits Gemini's
// own inline-request limit either. The caller (the route handler) owns
// the upload and the cleanup — this function only runs the transcription
// call itself.

interface TranscriptOutput {
  transcript: string;
}

const TRANSCRIPT_SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string" },
  },
  required: ["transcript"],
};

const SYSTEM_PROMPT = `You transcribe spoken audio from this video verbatim, in the language it was spoken in. Output only the transcript text — no speaker labels, no timestamps, no commentary, no translation, no description of the visuals. If the video has no discernible speech (music only, silence, noise, or you genuinely cannot make out any words), return an empty string for transcript. Respond with only the requested JSON.`;

const MIN_USABLE_LENGTH = 3; // trimmed length below which we treat it as "no speech found" rather than a real transcript

export async function transcribeVideoSpeech(fileUri: string, mimeType: string): Promise<string> {
  const { data } = await callStructured<TranscriptOutput>({
    tier: "cheap",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: "Transcribe the speech in the attached video.",
    responseSchema: TRANSCRIPT_SCHEMA,
    videoFileRef: { fileUri, mimeType },
    timeoutMs: 90_000, // longer clips (now up to several minutes) take longer to process than the old short-clip cap ever needed; still bounded
  });

  const transcript = typeof data.transcript === "string" ? data.transcript.trim() : "";
  return transcript.length >= MIN_USABLE_LENGTH ? transcript : "";
}
