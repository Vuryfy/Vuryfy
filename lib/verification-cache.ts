import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { QuickCheckEvidence } from "@/lib/quick-check";

// Exact-match cache (Part 11, LOCKED — "Exact" layer of the three-layer
// cache; Semantic and Evidence layers are deliberately deferred, see
// architecture-decisions.md "Caching, Phase 1" for the reasoning). Backed
// by the verification_cache_exact table from 0001_init.sql, which existed
// in the schema from day one but was never wired up until now.
//
// Design: cache_key = sha256(normalized_claim + "|" + input_type + "|" +
// engine_version), computed here in application code (per the table's own
// comment in the migration). A cache HIT means we skip the AI Gateway and
// Search Gateway entirely for that request — no Gemini call, no Tavily
// call — and serve the previously-computed verdict/evidence instead. The
// caller (app/api/verify/route.ts) still creates a fresh per-user
// `verifications` row and still charges the normal credit on a hit — see
// that file's comments for why.
//
// Shared with Deep Investigation (app/api/deep/route.ts, Sept 14, 2026):
// these functions are generic over the caller, not Quick-Check-specific.
// Cache keys never collide between the two modes because engine_version
// differs ("v1-gemini-tavily" vs "v1-gemini-tavily-deep"), which is one of
// the three inputs computeCacheKey() hashes over.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Shared TTL for audio caching (see writeCache's explicitFreshness note
// above) — "medium" tier, same 14-day window classifyFreshness() already
// uses as its default for non-time-sensitive text claims.
export const AUDIO_CACHE_FRESHNESS: FreshnessResult = { freshnessClass: "medium", ttlMs: 14 * DAY_MS };

export type FreshnessClass = "very_short" | "short" | "medium";

export interface FreshnessResult {
  freshnessClass: FreshnessClass;
  ttlMs: number;
}

export interface CachedVerification {
  verdict: string;
  confidence: number;
  summary: string;
  key_evidence: QuickCheckEvidence[];
  sources: { title: string; url: string }[];
  // Deep Investigation only (Sept 14, 2026 addition) — always present on
  // the underlying verifications row (defaults to '[]'), empty for every
  // Quick Check row since that pipeline doesn't produce caveats.
  caveats: string[];
  engine_version: string;
  cached_at: string;
}

export function computeCacheKey(normalizedClaim: string, inputType: string, engineVersion: string): string {
  return createHash("sha256").update(`${normalizedClaim}|${inputType}|${engineVersion}`).digest("hex");
}

// Cheap, keyword-based freshness classifier — deliberately NOT another AI
// call (that would defeat the point of caching: paying for a model call to
// decide whether to avoid a model call). Per Part 11's freshness_class
// categories (historical/scientific = long, government schemes = medium,
// current events = short, stock prices/breaking news = very short):
//
// V1 scope note: this classifier only distinguishes very_short / short /
// medium. It does NOT attempt to detect "long" (historical/scientific
// stable facts) — that would need real classification to do safely, and
// guessing wrong in the "long" direction is the expensive mistake (a
// stale wrong verdict on a trust product). "medium" (14 days) is the safe
// default for anything not clearly time-sensitive; revisit once there's
// real cache-hit-rate data to justify the extra precision.
const VERY_SHORT_RE = /\b(stock price|share price|exchange rate|live score|breaking news|right now|as of today|weather (today|now))\b/i;
const SHORT_RE = /\b(current|currently|latest|today|tonight|this week|this month|\bnow\b)\b/i;

function mentionsRecentYear(claim: string): boolean {
  const year = new Date().getFullYear();
  const re = new RegExp(`\\b(${year - 1}|${year}|${year + 1})\\b`);
  return re.test(claim);
}

export function classifyFreshness(claim: string): FreshnessResult {
  if (VERY_SHORT_RE.test(claim)) {
    return { freshnessClass: "very_short", ttlMs: 1 * HOUR_MS };
  }
  if (SHORT_RE.test(claim) || mentionsRecentYear(claim)) {
    return { freshnessClass: "short", ttlMs: 24 * HOUR_MS };
  }
  return { freshnessClass: "medium", ttlMs: 14 * DAY_MS };
}

// Returns the cached verdict if a live (non-expired) entry exists, or null
// on a miss OR on any lookup failure. Deliberately fails OPEN (treats an
// error as a cache miss rather than throwing) — a caching bug should never
// be able to take down the core Quick Check flow.
export async function getCachedVerification(
  admin: SupabaseClient,
  cacheKey: string
): Promise<CachedVerification | null> {
  try {
    const { data: cacheRow, error: cacheError } = await admin
      .from("verification_cache_exact")
      .select("verification_id, expires_at, created_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();

    if (cacheError) {
      console.error("[cache] lookup failed:", cacheError);
      return null;
    }
    if (!cacheRow) return null;
    if (new Date(cacheRow.expires_at).getTime() <= Date.now()) return null; // expired — treat as a miss

    const { data: original, error: verError } = await admin
      .from("verifications")
      .select("verdict, confidence, summary, key_evidence, sources, caveats, engine_version")
      .eq("id", cacheRow.verification_id)
      .maybeSingle();

    if (verError || !original) {
      console.error("[cache] original verification missing or fetch failed:", verError);
      return null;
    }

    return { ...original, cached_at: cacheRow.created_at };
  } catch (err) {
    console.error("[cache] unexpected lookup error:", err);
    return null;
  }
}

// Upserts the cache entry (upsert, not insert, so re-caching an expired
// claim replaces the old row rather than colliding on the cache_key
// primary key). Non-fatal on failure — same pattern as the other
// secondary/audit writes in route.ts: log and move on, never fail the
// user's actual request over a caching write.
//
// explicitFreshness (added Sept 15, 2026 for audio caching — see
// app/api/verify-audio/route.ts and friends): classifyFreshness()'s
// keyword regexes are written for TEXT CLAIMS ("current", "as of today",
// a recent year) and mean nothing run against a raw audio/base64 blob.
// Audio content doesn't go stale the way a claim about current events
// does — an authenticity verdict on a specific recording is a fixed
// property of that file, if anything arguably safe to cache even longer
// than "medium" — so audio callers pass an explicit freshness instead of
// letting classifyFreshness misread binary data. Text callers (Quick
// Check, Deep Investigation) are unaffected — they still omit this and
// get the keyword-based classification as before.
export async function writeCache(
  admin: SupabaseClient,
  cacheKey: string,
  verificationId: string,
  claim: string,
  explicitFreshness?: FreshnessResult
): Promise<void> {
  const { freshnessClass, ttlMs } = explicitFreshness ?? classifyFreshness(claim);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const { error } = await admin.from("verification_cache_exact").upsert(
    {
      cache_key: cacheKey,
      verification_id: verificationId,
      freshness_class: freshnessClass,
      expires_at: expiresAt,
    },
    { onConflict: "cache_key" }
  );

  if (error) {
    console.error("[cache] write failed:", error);
  }
}
