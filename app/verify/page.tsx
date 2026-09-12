"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function VerifyPage(){
 const router=useRouter(); const [claim,setClaim]=useState(""); const [loading,setLoading]=useState(false); const [error,setError]=useState("");
 useEffect(()=>{ if(!localStorage.getItem("vuryfy_token")) router.replace("/"); },[router]);
 async function submit(){ const token=localStorage.getItem("vuryfy_token"); if(!token||claim.trim().length<5)return; setLoading(true);setError("");
  try{const r=await fetch("http://localhost:8000/api/v1/verification/quick-check",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({claim:claim.trim(),input_type:"text"})}); const d=await r.json(); if(!r.ok)throw new Error(d.detail||"Verification failed"); sessionStorage.setItem("vuryfy_result",JSON.stringify(d)); router.push(`/result?id=${d.id}`);}catch(e:any){setError(e.message)}finally{setLoading(false)} }
 return <main className="shell narrow"><nav><button className="back" onClick={()=>router.push("/")}>← Back</button><div className="credits">Credits</div></nav><section className="verify"><p className="eyebrow">QUICK CHECK</p><h1>What should we verify?</h1><textarea value={claim} onChange={e=>setClaim(e.target.value)} placeholder="Paste a claim, statement, or URL…" maxLength={10000}/><div className="actions"><span>{claim.length}/10,000</span><button onClick={submit} disabled={loading||claim.trim().length<5}>{loading?"Checking…":"Verify"}</button></div>{error&&<p className="error">{error}</p>}</section></main>
}
