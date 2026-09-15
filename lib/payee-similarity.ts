// Payee name similarity — Sept 15, 2026, built for app/api/check-payee/
// route.ts (see that file's header and migration 0007's header for the
// full feature rationale: catching a payment QR whose payee name is
// near-identical to one the user has scanned before, but under a
// different UPI ID — a common impersonation pattern).
//
// Plain Levenshtein edit distance, deliberately NOT an AI call — this is
// exactly the kind of deterministic string comparison that doesn't need
// (and shouldn't use) a model: it's cheap, instant, and its behavior is
// fully predictable, unlike asking an AI "do these names look similar."
// Normalization strips case, punctuation, and extra whitespace but
// deliberately does NOT strip corporate suffixes ("private limited",
// "pvt ltd") or otherwise fuzz the comparison further — the whole point
// is to catch subtle word-level differences like "Organic" vs "Organics",
// so being too aggressive about what counts as "the same" would defeat
// the feature.

export function normalizePayeeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j], dp[j - 1]);
      prevDiag = temp;
    }
  }
  return dp[n];
}

// Returns a similarity score from 0 (completely different) to 1 (exact
// match after normalization). Empty/unusable input returns 0 rather than
// throwing — callers treat that as "nothing to compare."
export function nameSimilarity(a: string, b: string): number {
  const na = normalizePayeeName(a);
  const nb = normalizePayeeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const distance = levenshteinDistance(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}
