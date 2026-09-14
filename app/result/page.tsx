"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Result = {
  id: string;
  mode?: "quick" | "deep";
  verdict: string;
  confidence: number;
  explanation: string;
  claim: string;
  evidence: { title: string; url: string; publisher?: string; snippet?: string }[];
  caveats: string[];
  credits: { total: number; quick_checks: number; deep_investigations: number };
};

export default function ResultPage() {
  const router = useRouter();
  const [r, setR] = useState<Result | null>(null);

  useEffect(() => {
    const x = sessionStorage.getItem("vuryfy_result");
    if (x) setR(JSON.parse(x));
    else router.replace("/");
  }, [router]);

  if (!r) return null;

  // mode is absent on results saved before this field existed (an old
  // sessionStorage entry surviving a hard refresh) — quick is the correct
  // fallback since Deep Investigation didn't exist before mode was added.
  const isDeep = r.mode === "deep";
  const newCheckHref = isDeep ? "/deep" : "/verify";

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push(newCheckHref)}>
          ← New check
        </button>
        <div className="credits">Credits · {r.credits.total}</div>
      </nav>
      <section className="result">
        <p className="eyebrow">{isDeep ? "DEEP INVESTIGATION RESULT" : "QUICK CHECK RESULT"}</p>
        <div className="verdict">{r.verdict}</div>
        <div className="confidence">Confidence · {r.confidence}%</div>
        <div className="claim">
          <span>CLAIM</span>
          <p>{r.claim}</p>
        </div>
        <div className="explanation">
          <span>WHY</span>
          <p>{r.explanation}</p>
        </div>
        {r.evidence?.length > 0 && (
          <div className="evidence">
            <span>EVIDENCE</span>
            {r.evidence.map((e, i) => (
              <a key={i} href={e.url} target="_blank" rel="noreferrer">
                <strong>{e.title}</strong>
                <small>{e.url}</small>
              </a>
            ))}
          </div>
        )}
        {r.caveats?.length > 0 && (
          <div className="caveats">
            <span>NOTES</span>
            {r.caveats.map((c, i) => (
              <p key={i}>{c}</p>
            ))}
          </div>
        )}
        <div className="result-actions">
          <button
            onClick={() =>
              navigator.clipboard?.writeText(r.claim + "\n\n" + r.verdict + "\n" + r.explanation)
            }
          >
            Share result
          </button>
          <button className="secondary" onClick={() => router.push(newCheckHref)}>
            Verify another
          </button>
        </div>
      </section>
    </main>
  );
}
