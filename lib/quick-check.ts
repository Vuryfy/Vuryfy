import { search, type SearchResult } from "@/lib/search-gateway";
import { callStructured } from "@/lib/ai-gateway";

// Quick Check pipeline (Part 26.4, LOCKED): normalize -> search -> evaluate
// evidence -> verdict. AI call count is 0 or 1 here (0 if search returns
// nothing worth reasoning over, 1 otherwise) — deliberately thin for V1;
// the multi-call complexity classification/escalation logic Part 26.4
// describes is deferred until there's real usage data to justify it.
//
// Evidence grounding (Part 19, LOCKED — "the reasoning model may only cite
// sources the Research Engine actually retrieved; if evidence it wants
// isn't present, it must mark it as missing rather than filling the gap"):
// the model never handles real URLs. It refers to evidence only by the
// numeric id we assign to each retrieved source, and code resolves ids
// back to the real, retrieved source objects afterward — any id outside
// the retrieved set is silently dropped rather than trusted. This is the
// code-enforced half of the anti-hallucination safeguard Part 19 calls
// for; the system prompt below is the other half.
//
// normalizeClaim and ENGINE_VERSION are exported (Sept 14, 2026 addition)
// so app/api/verify/route.ts and lib/verification-cache.ts can compute the
// exact same exact-match cache key this module uses internally, without
// duplicating the normalization logic.
//
// "Scam" verdict (Sept 2026 addition): added as a fifth verdict alongside
// True/False/Misleading/Unverified specifically so a link found to be a
// phishing site, fraud operation, or scam is surfaced distinctly from a
// merely-incorrect claim — the result page gives "Scam" its own red
// warning card (see app/result/page.tsx) rather than blending it into a
// plain "False". This applies to any claim through this pipeline, not
// just QR-sourced links — QR just happens to decode into links often, and
// a scam link is a scam link regardless of how it was submitted.
//
// Same grounding rule as every other verdict (Part 19): the model may
// ONLY pick "Scam" when the retrieved evidence itself says so (a
// scam/phishing report, a fraud-database entry, news coverage, a pattern
// of user complaints) — never from the domain merely "looking suspicious"
// with no supporting evidence. That mirrors the lesson from the real UPI
// QR test earlier in this project: an unverifiable heuristic guess about
// legitimacy causes exactly the reputational harm this system exists to
// avoid. A claim with no scam-specific evidence falls back to Unverified,
// same as always — a brand-new phishing link with zero web footprint yet
// won't be caught by an evidence-grounded system, and that's an accepted
// limitation, not a bug.

export interface QuickCheckEvidence {
  title: string;
  url: string;
  publisher?: string;
  snippet?: string;
}

export interface QuickCheckResult {
  verdict: string;
  confidence: number;
  summary: string;
  key_evidence: QuickCheckEvidence[];
  sources: { title: string; url: string }[];
  engine_version: string;
}

export const ENGINE_VERSION = "v1-gemini-tavily";
const VALID_VERDICTS = ["True", "False", "Misleading", "Unverified", "Scam"];

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VALID_VERDICTS },
    confidence: { type: "integer" },
    summary: { type: "string" },
    contradiction_level: { type: "string", enum: ["none", "low", "medium", "high"] },
    cited_evidence_ids: { type: "array", items: { type: "integer" } },
    missing_information: { type: "array", items: { type: "string" } },
  },
  required: [
    "verdict",
    "confidence",
    "summary",
    "contradiction_level",
    "cited_evidence_ids",
    "missing_information",
  ],
};

interface VerdictOutput {
  verdict: string;
  confidence: number;
  summary: string;
  contradiction_level: string;
  cited_evidence_ids: number[];
  missing_information: string[];
}

const SYSTEM_PROMPT = `You are Vuryfy's claim-verification engine. You are given a claim and a numbered list of evidence excerpts retrieved by a search system. Your job:
- Decide a verdict: "True", "False", "Misleading", "Unverified", or "Scam".
- Use "Scam" only when the claim is (or points to, e.g. a link) a scam, phishing attempt, or fraud operation, AND the evidence itself supports that — a scam/phishing report, a fraud-database or blocklist entry, news coverage of the fraud, or a clear pattern of user complaints describing it as a scam. Never choose "Scam" from the link or claim merely looking suspicious, unfamiliar, or unofficial with no such evidence — that case is "Unverified", not "Scam". A confident false accusation is worse than an unresolved one.
- For anything that is simply incorrect information but not a deliberate scam/fraud attempt, use "False" or "Misleading" as appropriate, not "Scam".
- You may ONLY use the numbered evidence provided below — never rely on outside knowledge, and never invent a source. If the evidence is thin, outdated, or contradicts itself, prefer "Unverified" over guessing.
- confidence is 0-100 and must reflect how well the evidence actually supports the verdict — weak or single-source evidence should never produce a high confidence score.
- cited_evidence_ids must contain ONLY the bracketed numbers of evidence you actually relied on. Never include a number that wasn't given to you.
- missing_information should list what additional evidence would be needed to verify this claim more confidently, if anything is missing.
- summary should be 1-3 concise sentences a general reader can understand, explaining the verdict in plain language.
Respond with only the requested JSON — no extra commentary, no markdown.`;

export function normalizeClaim(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, 2000);
}

function buildEvidenceBlock(results: SearchResult[]): string {
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\nSource: ${r.source}\nURL: ${r.url}\nExcerpt: ${r.snippet}`)
    .join("\n\n");
}

export async function runQuickCheck(claimRaw: string): Promise<QuickCheckResult> {
  const claim = normalizeClaim(claimRaw);

  const results = await search(claim, { maxResults: 6 });
  const sources = results.map((r) => ({ title: r.title, url: r.url }));

  // Evidence threshold (Part 26.4, LOCKED): don't manufacture a confident
  // verdict from nothing. Zero search results -> skip the AI call entirely
  // (saves a call) and return a clearly-labeled insufficient-evidence
  // result rather than letting the model guess without grounding.
  if (results.length === 0) {
    return {
      verdict: "Unverified",
      confidence: 0,
      summary:
        "No evidence could be found to check this claim against. Try rephrasing it or adding more specific detail.",
      key_evidence: [],
      sources: [],
      engine_version: ENGINE_VERSION,
    };
  }

  const userPrompt = `Claim to verify:\n"${claim}"\n\nEvidence:\n${buildEvidenceBlock(results)}`;

  const { data } = await callStructured<VerdictOutput>({
    tier: "cheap",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    responseSchema: VERDICT_SCHEMA,
  });

  const citedIds = Array.isArray(data.cited_evidence_ids) ? data.cited_evidence_ids : [];
  const keyEvidence: QuickCheckEvidence[] = citedIds
    .filter((id) => Number.isInteger(id) && id >= 1 && id <= results.length)
    .map((id) => {
      const r = results[id - 1];
      return { title: r.title, url: r.url, publisher: r.source, snippet: r.snippet };
    });

  const verdict = VALID_VERDICTS.includes(data.verdict) ? data.verdict : "Unverified";
  const confidence = Number.isFinite(data.confidence) ? Math.max(0, Math.min(100, Math.round(data.confidence))) : 0;
  const summary = typeof data.summary === "string" && data.summary.trim() ? data.summary.trim() : "No explanation was returned.";

  return {
    verdict,
    confidence,
    summary,
    key_evidence: keyEvidence,
    sources,
    engine_version: ENGINE_VERSION,
  };
}
