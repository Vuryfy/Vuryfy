// AI Gateway (Part 11, LOCKED) — the only place in the app that talks to an
// AI model provider directly. App code requests a MODEL_TIER ('cheap' |
// 'reasoning'), never a specific model ID, so swapping/upgrading the
// underlying model later never touches call sites.
//
// V1 "build thin, not full" (Part 11, refinement #3): only one model wired
// up for both tiers right now — no health-check/failover/auto-downgrade
// logic, no fallback provider. Per-call cost logging (Part 19) is captured
// in the returned `usage` field but not yet persisted anywhere; wire that
// up when real cost-tracking work starts.

const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export type ModelTier = "cheap" | "reasoning";

export interface StructuredCallParams {
  tier: ModelTier;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: Record<string, unknown>;
  temperature?: number;
}

export interface StructuredCallResult<T> {
  data: T;
  usage: { promptTokens: number; outputTokens: number; totalTokens: number };
}

export class AiGatewayError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AiGatewayError";
    this.cause = cause;
  }
}

// One model wired for both tiers in V1 (see file header). Kept as a lookup
// rather than using GEMINI_MODEL directly at call sites so that giving the
// reasoning tier its own (likely larger/pricier) model later — for Deep
// Investigation — is a one-line change here, not a refactor of callers.
function modelForTier(_tier: ModelTier): string {
  return GEMINI_MODEL;
}

async function attemptCall<T>(params: StructuredCallParams, apiKey: string): Promise<StructuredCallResult<T>> {
  void modelForTier(params.tier); // reserved for when tiers diverge onto different models

  let response: Response;
  try {
    response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: params.userPrompt }] }],
        systemInstruction: { role: "system", parts: [{ text: params.systemPrompt }] },
        generationConfig: {
          temperature: params.temperature ?? 0.2,
          responseMimeType: "application/json",
          responseSchema: params.responseSchema,
        },
      }),
      // Quick Check targets ~5-15s total (Part 26.4) — bound the AI call so
      // a hung request can't block the whole request indefinitely.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new AiGatewayError("Gemini request failed (network/timeout)", err);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new AiGatewayError(`Gemini API error ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  const json = await response.json().catch((err) => {
    throw new AiGatewayError("Gemini response was not a valid JSON envelope", err);
  });

  const text: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new AiGatewayError("Gemini response had no text content", json);
  }

  const parsed = JSON.parse(text) as T; // caller (attemptCall's caller) retries once on parse failure

  const usageMeta = json?.usageMetadata ?? {};
  return {
    data: parsed,
    usage: {
      promptTokens: usageMeta.promptTokenCount ?? 0,
      outputTokens: usageMeta.candidatesTokenCount ?? 0,
      totalTokens: usageMeta.totalTokenCount ?? 0,
    },
  };
}

// Structured, schema-validated call to the "cheap" or "reasoning" model
// tier. Per Part 19 (LOCKED): "schema-validate before use, retry/fallback
// on malformed output, never pass raw model text to users" — Gemini's
// responseSchema constrains the model to valid JSON matching the shape, and
// we retry once here on top of that in case a single call still comes back
// malformed (rare, but real).
export async function callStructured<T>(params: StructuredCallParams): Promise<StructuredCallResult<T>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AiGatewayError("GEMINI_API_KEY is not set");
  }

  try {
    return await attemptCall<T>(params, apiKey);
  } catch (err) {
    if (err instanceof AiGatewayError && err.message.includes("valid JSON envelope")) {
      throw err; // envelope-level failure — retrying won't help
    }
    if (err instanceof SyntaxError) {
      // JSON.parse failure on the model's text — retry once before giving up.
      try {
        return await attemptCall<T>(params, apiKey);
      } catch {
        throw new AiGatewayError("Gemini structured output was not valid JSON, even after one retry", err);
      }
    }
    throw err;
  }
}
