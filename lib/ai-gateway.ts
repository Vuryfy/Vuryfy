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
//
// Transient-failure retry (added Sept 14, 2026): Gemini's `503 The model is
// currently experiencing high demand` (UNAVAILABLE) is a well-documented,
// recurring condition — not a rare fluke — especially on preview-tier
// models like gemini-3.1-flash-lite. Confirmed in production the same day
// this was added (see architecture-decisions.md). callStructured() now
// retries a SHORT, bounded number of times with backoff specifically for
// transient provider failures (503/429/5xx/network-timeout) before giving
// up, so most overload spikes recover silently without the user ever
// seeing an error or needing to click Verify again. This is layered
// underneath (wraps) the existing malformed-JSON retry, which is a
// separate concern (bad output, not a failed request).

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
  // HTTP status from the provider, when the failure came back as a non-ok
  // response (as opposed to a network/timeout failure, which has none).
  // Used by isRetryableTransientError() to decide whether to retry.
  status?: number;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AiGatewayError";
    this.cause = cause;
  }
}

// Statuses worth a short retry: 429 (rate limited), 503 (overloaded — the
// common Gemini case), and the other classic transient 5xx codes. NOT
// retried: 4xx auth/validation errors (400/401/403/404) — those will never
// succeed on retry and should fail fast.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function isRetryableTransientError(err: unknown): boolean {
  if (!(err instanceof AiGatewayError)) return false;
  if (err.message.includes("network/timeout")) return true;
  if (err.status !== undefined && RETRYABLE_STATUSES.has(err.status)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const err = new AiGatewayError(`Gemini API error ${response.status}: ${bodyText.slice(0, 500)}`);
    err.status = response.status;
    throw err;
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
// tier, with one retry on malformed JSON output (Part 19: "schema-validate
// before use, retry/fallback on malformed output, never pass raw model
// text to users").
async function attemptWithJsonRetry<T>(params: StructuredCallParams, apiKey: string): Promise<StructuredCallResult<T>> {
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

const TRANSIENT_RETRY_DELAYS_MS = [500, 1500]; // 2 retries (3 attempts total), short backoff

export async function callStructured<T>(params: StructuredCallParams): Promise<StructuredCallResult<T>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AiGatewayError("GEMINI_API_KEY is not set");
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await attemptWithJsonRetry<T>(params, apiKey);
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === TRANSIENT_RETRY_DELAYS_MS.length;
      if (!isLastAttempt && isRetryableTransientError(err)) {
        await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw err;
    }
  }
  // Unreachable — loop always returns or throws — but keeps TypeScript happy.
  throw lastErr;
}
