// Google Cloud Vision — Web Detection (added Sept 2026, user request). This
// is the reverse-image-search capability lib/image-analysis.ts's original
// file header flagged as missing from Vuryfy's stack: given an image, it
// returns other pages across the web where the same or a visually similar
// image appears. That's what actually lets image Deep Investigation move
// beyond "does this look edited" (pixels-only, still all lib/image-
// analysis.ts's vision call can do on its own) to "does this exact image
// appear somewhere else, and does that other context match what's
// claimed" — the single most common real-world photo-misinformation
// pattern: an old or unrelated photo recirculated with a new, false claim
// attached.
//
// A genuinely different kind of provider from the two already in Part
// 11's stack (Gemini for AI, Tavily for text search), so it gets its own
// small gateway function here rather than being folded into either
// existing one — same "one file per provider, one clear call site" shape
// ai-gateway.ts and search-gateway.ts already establish.
//
// Deliberately called ONLY by image Deep Investigation, never image Quick
// Check — same tiering principle already applied everywhere else in this
// app (Quick Check stays cheap/fast/single-call; Deep Investigation is
// where extra evidence-gathering happens, mirroring the role parallel
// Tavily search already plays for text Deep Investigation).
//
// Fails open: a missing key, a request error, or an empty result all
// return null, and the caller (lib/image-analysis.ts) treats that as "no
// web evidence available" and falls back to vision-only analysis rather
// than failing the whole investigation — the same fail-open principle
// verification-cache.ts already uses for a secondary/evidence layer.

export interface MatchingPage {
  url: string;
  pageTitle: string;
}

export interface WebDetectionResult {
  matchingPages: MatchingPage[];
  bestGuessLabels: string[];
}

const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const MAX_PAGES = 10;

export async function detectWeb(imageBase64: string): Promise<WebDetectionResult | null> {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) return null; // not configured yet — treated as "no web evidence", not an error

  try {
    const response = await fetch(`${VISION_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: imageBase64 },
            features: [{ type: "WEB_DETECTION", maxResults: MAX_PAGES }],
          },
        ],
      }),
      // Kept well under Deep Investigation's sub-30s end-to-end target —
      // this runs alongside (not blocking) the reasoning-tier vision call.
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      console.error("[web-detection] Vision API error", response.status, bodyText.slice(0, 500));
      return null;
    }

    const json = await response.json().catch(() => null);
    const web = json?.responses?.[0]?.webDetection;
    if (!web) return null;

    const seen = new Set<string>();
    const matchingPages: MatchingPage[] = [];
    for (const p of web.pagesWithMatchingImages ?? []) {
      if (!p?.url || seen.has(p.url)) continue;
      seen.add(p.url);
      matchingPages.push({ url: p.url, pageTitle: p.pageTitle || p.url });
      if (matchingPages.length >= MAX_PAGES) break;
    }

    const bestGuessLabels: string[] = (web.bestGuessLabels ?? [])
      .map((l: { label?: string }) => l?.label)
      .filter((l: unknown): l is string => typeof l === "string" && l.trim().length > 0);

    if (matchingPages.length === 0 && bestGuessLabels.length === 0) return null;

    return { matchingPages, bestGuessLabels };
  } catch (err) {
    console.error("[web-detection] request failed:", err);
    return null;
  }
}
