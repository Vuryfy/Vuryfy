"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type Credits = { free_checks:number; quick_checks:number; deep_investigations:number; total:number };
type Subscription = { plan:string; status:string; cancel_at_period_end:boolean; current_period_end:string } | null;

export default function Home() {
  const [token,setToken] = useState<string|null>(null);
  const [credits,setCredits] = useState<Credits|null>(null);
  const [subscription,setSubscription] = useState<Subscription>(null);

  useEffect(() => {
    setToken(localStorage.getItem("vuryfy_token"));
  }, []);

  useEffect(() => {
    if (!token) return;
    const h={Authorization:`Bearer ${token}`};
    Promise.all([
      fetch("http://localhost:8000/api/v1/verification/credits",{headers:h}).then(r=>r.ok?r.json():null),
      fetch("http://localhost:8000/api/v1/billing/subscription",{headers:h}).then(r=>r.ok?r.json():null)
    ]).then(([c,s])=>{setCredits(c);setSubscription(s)}).catch(()=>{});
  },[token]);

  function logout(){ localStorage.removeItem("vuryfy_token"); setToken(null); }

  if(!token) return <main className="shell"><nav><div className="brand">Vuryfy</div><div className="credits">Credits · —</div></nav>
    <section className="hero"><p className="eyebrow">VERIFY WHAT MATTERS</p><h1>Know what to trust.</h1>
    <p className="sub">Investigate claims and information with explainable AI-powered verification.</p>
    <Link className="primary-link" href="/login">Sign in to start</Link></section></main>;

  return <main className="shell">
    <nav><div className="brand">Vuryfy</div><div className="credits">Credits · {credits?.total ?? "…"}</div></nav>
    <section className="hero">
      <p className="eyebrow">VURYFY</p><h1>What do you want to verify?</h1>
      <p className="sub">Start with a Quick Check for a fast answer, or run a Deep Investigation when you need a more thorough examination.</p>
      <div className="home-actions">
        <Link className="primary-link" href="/verify">Start a Quick Check</Link>
        <Link className="secondary-link" href="/deep">Deep Investigation</Link>
      </div>
      <div className="balance-card">
        <div><span>Free</span><strong>{credits?.free_checks ?? "—"}</strong></div>
        <div><span>Quick</span><strong>{credits?.quick_checks ?? "—"}</strong></div>
        <div><span>Deep</span><strong>{credits?.deep_investigations ?? "—"}</strong></div>
      </div>
      <div className="home-links">
        <Link href="/saved">Saved</Link><Link href="/billing">Credits & Subscription</Link>
        <button className="text-button" onClick={logout}>Sign out</button>
      </div>
      {subscription?.cancel_at_period_end && <p className="hint">Your subscription is scheduled to end at the end of the current paid period.</p>}
    </section>
  </main>;
}
