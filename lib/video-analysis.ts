import { callStructured } from "@/lib/ai-gateway";
import type { QuickCheckEvidence } from "@/lib/quick-check";

// Video authenticity analysis — the second half of video input (the first
// half, transcript-based fact-checking, reuses quick-check.ts/
// deep-investigation.ts unchanged via input_type "video_transcript"; see
// video-transcript.ts). Last step in the locked media-type build order
// (text + link -> QR -> image -> audio -> video). This file mirrors
// lib/audio-analysis.ts's shape closely (same verdict vocabulary, same
// dual verdict+ai_generated_likelihood output, same defensive-downgrade
// logic) but for a genuinely harder question: not just "was this
// synthesized" the way a voice or soundscape can be, but "was this footage
// staged, deepfaked, or generated outright, and does the motion/lighting/
// physics hold together across frames the way real camera footage would."
//
// Same reasoning-parity note as audio: Deep Investigation here does NOT get
// an extra evidence-gathering step the way image Deep Investigation gets
// reverse image search — there is no reverse-video-search provider in this
// stack, and no "Out of Context" verdict is offered. "Deep Investigation"
// for video means a slower, more careful frame-by-frame pass with the
// reasoning-tier model, same verdict vocabulary as Quick Check.
//
// Verdict vocabulary (deliberately NOT the True/False/Misleading/
// Unverified/Scam set text claims get, same reason as image/audio — no
// evidence source exists here to ground a truth/falsity verdict on):
//   - "Clean"        — no visible/audible signs of manipulation, deepfake
//                       artifacts, or AI generation found. Does NOT mean
//                       "confirmed authentic" — see the caveats on every
//                       result.
//   - "Suspicious"   — specific, describable signals found (listed in
//                       caveats), OR the AI-generation call came back
//                       "likely".
//   - "Inconclusive" — video quality too poor/compressed/short to assess
//                       meaningfully, or signals point different
//                       directions, OR the AI-generation call came back
//                       "uncertain" (see defensive downgrade below — same
//                       fix as the audio verdict/sub-claim contradiction
//                       bug, applied here from the start).
//
// Two genuinely different fake-video shapes exist, and the prompt below
// asks the model to judge both, since a single video can only really be
// one or the other:
//   1. A real filmed video that's been manipulated — most commonly a
//      face-swap/"deepfake" of a real person's face, or a body double,
//      splicing, or misleading edits. Signals live in facial detail: eyes,
//      blinking, edges, lighting consistency on the face specifically.
//   2. Fully AI-generated video from a text/image-to-video model (Sora,
//      Runway, Kling, Pika, Veo, and similar) — no real camera involved at
//      all. Signals live in physics/continuity across the whole frame:
//      object permanence, shadow/reflection consistency, natural camera
//      noise, motion physics.
// contains_face flags which signal set is most relevant, mirroring
// contains_speech in audio-analysis.ts.
//
// Media retention (Part 15): this file itself never writes video content
// anywhere — same principle as image and audio analysis. As of Sept 15,
// 2026, the video briefly touches TWO storage points before reaching this
// file: Supabase Storage (uploaded directly by the browser to bypass
// Vercel's 4.5MB request body limit) and Gemini's File API (re-uploaded
// server-side, since Gemini's inline-request limit no longer fits the
// raised size cap either). Neither is meant to persist — see
// supabase/migrations/0009_temp_video_storage.sql and
// lib/gemini-file-upload.ts's headers for how each is cleaned up. This
// file only ever receives an already-uploaded Gemini file reference
// (fileUri), never raw bytes.
//
// Caching: reuses the same exact-match cache as audio (keyed on the video
// content itself, not a text claim) — see app/api/verify-video/route.ts.
// Not integrated by this file directly, same separation as audio-analysis.ts.

export const VIDEO_QUICK_ENGINE_VERSION = "v1-gemini-video-quick";
export const VIDEO_DEEP_ENGINE_VERSION = "v1-gemini-video-deep";

export interface VideoAnalysisResult {
  verdict: string;
  confidence: number;
  summary: string;
  key_evidence: QuickCheckEvidence[]; // always empty — no evidence source exists for video yet; kept for shape-compatibility with the verifications table
  sources: { title: string; url: string }[]; // always empty, same reason
  caveats: string[];
  engine_version: string;
}

const VERDICTS = ["Clean", "Suspicious", "Inconclusive"];
const AI_LIKELIHOODS = ["likely", "unlikely", "uncertain"];

const VIDEO_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    confidence: { type: "integer" },
    contains_face: { type: "boolean" },
    ai_generated_likelihood: { type: "string", enum: AI_LIKELIHOODS },
    ai_generated_reasoning: { type: "string" },
    summary: { type: "string" },
    signals_found: { type: "array", items: { type: "string" } },
    context_match: { type: "string", enum: ["consistent", "inconsistent", "not_applicable"] },
  },
  required: [
    "verdict",
    "confidence",
    "contains_face",
    "ai_generated_likelihood",
    "ai_generated_reasoning",
    "summary",
    "signals_found",
    "context_match",
  ],
};

interface VideoOutput {
  verdict: string;
  confidence: number;
  contains_face: boolean;
  ai_generated_likelihood: string;
  ai_generated_reasoning: string;
  summary: string;
  signals_found: string[];
  context_match: string;
}

const HONESTY_RULES = `You are analyzing the visuals and audio of this one video clip. You have no other access to metadata and no way to confirm when, where, or by whom this was actually filmed.

FIRST: set contains_face — true if a recognizable human face appears anywhere in the video, false otherwise.

THEN, and separately from everything else: decide ai_generated_likelihood — whether this video was likely manipulated, deepfaked, or generated by an AI model rather than being unaltered footage of the real world. Judge this using whichever signal set actually applies, and read both carefully — modern tools are specifically engineered to defeat the "obvious" tells, so the honest default is "uncertain" far more often than "unlikely":
- If a face is present (possible face-swap/deepfake of a real person): do NOT call "unlikely" just because the face looks sharp, well-lit, or natural — that's now table stakes for a good face-swap. Only call "unlikely" when you see evidence of a genuine, continuous camera capture: consistent film grain/sensor noise across the whole frame (not just the face), lighting on the face that matches the lighting and shadow direction on the rest of the scene, natural micro-movements and blinking with realistic timing, skin texture with visible pores/imperfections rather than an airbrushed look, and edges (hairline, glasses, earrings, jaw against background) that hold together cleanly across frames. Reserve "likely" for actual tells: a warped or shimmering boundary around the face/hairline, lighting or shadow on the face that doesn't match the surrounding scene, eyes/teeth/reflections that look subtly wrong or inconsistent, lip movement that doesn't quite match the audio, or the face's texture/detail level visibly differing from the rest of the frame.
- If no face, or the whole scene could be AI-generated (text/image-to-video models — Sora, Runway, Kling, Pika, Veo, and similar): do NOT call "unlikely" just because the footage looks smooth or high-quality — that's exactly what modern generators produce. Only call "unlikely" when you see evidence of a genuine physical camera and world: consistent object permanence (nothing subtly changes shape, merges, or vanishes between frames), physically plausible motion and physics throughout, shadows and reflections that stay geometrically consistent as the camera or subjects move, and a natural, slightly imperfect camera noise/grain and handheld micro-shake (when applicable) rather than an unnaturally smooth or "floaty" quality. Reserve "likely" for actual tells: objects or limbs that warp, merge, or morph; textures that subtly "boil" or shift between frames; shadows/reflections that don't track correctly; background details that don't hold up on close inspection (nonsensical text, melting architecture, impossible geometry); or camera motion that feels unnaturally smooth/dreamlike with no real-world imperfection.
- Also weigh editing/splicing evidence separately from generation: an abrupt, unexplained jump in background/lighting/clothing mid-clip with no visible camera cut, or audio that doesn't stay in sync with lip movement throughout, are both signals worth naming even on otherwise-real footage.
- Call it "uncertain" whenever the clip is short, heavily compressed, low-resolution, or gives genuinely mixed signals — this is the correct, honest answer far more often than "unlikely" is, since a great deepfake or a great AI-generated clip can look completely convincing on a straight watch-through.
- ai_generated_reasoning must be a specific, concrete sentence or two naming what you actually saw (or didn't see) that led to your call — never a vague "it looks fake" or "it looks real."

SEPARATELY, decide the overall verdict:
- Use "Suspicious" when you found specific, describable visual/audio evidence in signals_found (any of the signals above, or an unexplained splice/edit, or audio-video desync), OR whenever ai_generated_likelihood is "likely" — a video you believe is manipulated or AI-generated is never "Clean". Never choose "Suspicious" from a vague sense that something "looks off" with nothing specific to point to.
- Use "Clean" only when no such signals were found AND ai_generated_likelihood is "unlikely". This means nothing suspicious was visually/audibly detected — it does NOT mean the video is confirmed authentic; a well-made fake can look identical to real footage on a watch-through.
- Use "Inconclusive" when video quality is too poor/compressed/short to assess meaningfully, when signals point in genuinely different directions, OR whenever ai_generated_likelihood is "uncertain" — "uncertain" means you could not reach a confident read on the exact question this check exists to answer, so the headline verdict must say so too rather than reading as a clean bill of health next to an admission of uncertainty.
- confidence (0-100) reflects how confident you are in the signals/evidence you found (or didn't find), covering both the verdict and the AI-generation call — never let it imply certainty about whether the video is "real."
- If context describing what the video is supposed to show is given below, separately judge context_match: "consistent" if what's shown is plausible with that description, "inconsistent" if there is a clear, describable mismatch you can name, "not_applicable" if no context was given or the video gives no basis to judge it either way.
Respond with only the requested JSON — no extra commentary, no markdown.`;

const QUICK_SYSTEM_PROMPT = `You are Vuryfy's video Quick Check engine, giving a fast first-pass watch-through of a video clip. ${HONESTY_RULES}`;

const DEEP_SYSTEM_PROMPT = `You are Vuryfy's video Deep Investigation engine, giving a slower, more thorough frame-by-frame review than a Quick Check. Look carefully across the whole clip — facial edge/lighting consistency if a face is present, object permanence and physics throughout, shadow/reflection consistency as the scene moves, camera noise/grain naturalness, any abrupt cuts or audio-video desync, and any artifacts typical of face-swap deepfakes or AI video generation. ${HONESTY_RULES}`;

function buildUserPrompt(context: string | null): string {
  const contextLine = context && context.trim().length > 0
    ? `Context the user provided about what this video is supposed to show:\n"${context.trim()}"\n\n`
    : `No context was provided about what this video is supposed to show.\n\n`;
  return `${contextLine}Analyze the attached video.`;
}

// Code-enforced disclaimer, same pattern as image-analysis.ts / audio-analysis.ts.
const DISCLAIMER =
  "This is primarily a visual and audio read of the video itself — Vuryfy has no way to independently confirm who filmed this, when, or where. Deepfake and AI video generation tools keep improving, and a well-made fake can look convincing even on close review.";

const AI_LABELS: Record<string, string> = {
  likely: "Likely manipulated or AI-generated",
  unlikely: "Unlikely to be manipulated or AI-generated",
  uncertain: "Uncertain whether this is manipulated or AI-generated",
};

function toResult(data: VideoOutput, engineVersion: string): VideoAnalysisResult {
  let verdict = VERDICTS.includes(data.verdict) ? data.verdict : "Inconclusive";
  const confidence = Number.isFinite(data.confidence) ? Math.max(0, Math.min(100, Math.round(data.confidence))) : 0;
  const aiLikelihood = AI_LIKELIHOODS.includes(data.ai_generated_likelihood)
    ? data.ai_generated_likelihood
    : "uncertain";
  const aiReasoning =
    typeof data.ai_generated_reasoning === "string" && data.ai_generated_reasoning.trim()
      ? data.ai_generated_reasoning.trim()
      : "No specific signals were described.";
  const generalSummary =
    typeof data.summary === "string" && data.summary.trim() ? data.summary.trim() : "No explanation was returned.";
  const signals = Array.isArray(data.signals_found)
    ? data.signals_found.filter((s) => typeof s === "string" && s.trim().length > 0)
    : [];

  // Defensive downgrades (mirrors image-analysis.ts / audio-analysis.ts) —
  // code-enforced backstops in case the model doesn't follow the
  // instructions above:
  // 1. A "likely" AI-generation call can never be paired with verdict
  //    "Clean" — that would flatly contradict itself.
  // 2. An "uncertain" call can never be paired with verdict "Clean" either
  //    — a headline "Clean" next to "we can't tell if this is faked" reads
  //    as a contradiction (this is exactly the confusion a real user hit
  //    for audio on Sept 14, 2026; applied here from the start rather than
  //    waiting to hit the same bug again). "Uncertain" downgrades to
  //    "Inconclusive" instead.
  if (aiLikelihood === "likely" && verdict === "Clean") {
    verdict = "Suspicious";
  } else if (aiLikelihood === "uncertain" && verdict === "Clean") {
    verdict = "Inconclusive";
  }

  // The AI-generation call is the question users actually came here to ask,
  // so it leads the summary (the "WHY" section — the most prominent text on
  // the result screen) rather than being left implicit in signals_found or
  // buried in the caveats list below.
  const summary = `Manipulated/AI-generated: ${AI_LABELS[aiLikelihood]}. ${aiReasoning} ${generalSummary}`.trim();

  const caveats: string[] = [DISCLAIMER];
  if (data.contains_face && aiLikelihood !== "likely") {
    caveats.push(
      "Top-tier deepfake/face-swap tools are built to hold up on a casual watch-through, including matched lighting and natural blinking — an \"unlikely\"/\"uncertain\" call here means no inconsistency was found either way, not that the face is confirmed real."
    );
  }
  if (!data.contains_face && aiLikelihood !== "likely") {
    caveats.push(
      "Top-tier AI video generators (Sora, Runway, Kling, Veo, and similar) are improving quickly at physical plausibility — an \"unlikely\"/\"uncertain\" call here means no inconsistency was found either way, not that the footage is confirmed to be real camera footage."
    );
  }
  for (const s of signals) caveats.push(`Observed: ${s.trim()}`);
  if (data.context_match === "inconsistent") {
    caveats.push("The described context doesn't visually match what's shown in the video.");
  } else if (data.context_match === "consistent") {
    caveats.push("What's shown is at least plausible with the context described, though this is still only a watch-through, not a confirmed match.");
  }

  return {
    verdict,
    confidence,
    summary,
    key_evidence: [],
    sources: [],
    caveats,
    engine_version: engineVersion,
  };
}

// fileUri comes from lib/gemini-file-upload.ts's uploadVideoToGemini() —
// the route handler owns the upload and the post-use cleanup (deleting
// both the Gemini file and the Supabase Storage object), not this
// function. timeoutMs raised from the old 35s: a several-minutes-long clip
// genuinely takes longer for the model to work through than the old
// short-clip cap ever needed to accommodate, and Pro's maxDuration ceiling
// (see the video routes) now has real headroom for it.
export async function runVideoQuickCheck(
  fileUri: string,
  mimeType: string,
  context: string | null
): Promise<VideoAnalysisResult> {
  const { data } = await callStructured<VideoOutput>({
    tier: "cheap",
    systemPrompt: QUICK_SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(context),
    responseSchema: VIDEO_SCHEMA,
    videoFileRef: { fileUri, mimeType },
    timeoutMs: 120_000,
  });
  return toResult(data, VIDEO_QUICK_ENGINE_VERSION);
}

export async function runVideoDeepInvestigation(
  fileUri: string,
  mimeType: string,
  context: string | null
): Promise<VideoAnalysisResult> {
  const { data } = await callStructured<VideoOutput>({
    tier: "reasoning",
    systemPrompt: DEEP_SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(context),
    responseSchema: VIDEO_SCHEMA,
    videoFileRef: { fileUri, mimeType },
    timeoutMs: 150_000,
  });
  return toResult(data, VIDEO_DEEP_ENGINE_VERSION);
}
