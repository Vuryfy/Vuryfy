"use client";
import { useEffect,useState } from "react";
import { useRouter } from "next/navigation";

export default function DeepPage(){
 const router=useRouter(); const [claim,setClaim]=useState(""); const [loading,setLoading]=useState(false); const [error,setError]=useState("");
 useEffect(()=>{if(!localStorage.getItem("vuryfy_token"))router.replace("/login")},[router]);
 async function submit(){
  const t=localStorage.getItem("vuryfy_token"); if(!t||claim.trim().length<5)return;
  setLoading(true);setError("");
  try{
   const r=await fetch("http://localhost:8000/api/v1/verification/deep-investigation",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${t}`},body:JSON.stringify({claim:claim.trim(),input_type:"text"})});
   const d=await r.json(); if(!r.ok)throw new Error(d.detail||"Unable to start investigation");
   router.push(`/deep/status?id=${d.id}`);
  }catch(e:any){setError(e.message)}finally{setLoading(false)}
 }
 return <main className="shell narrow"><nav><button className="back" onClick={()=>router.push("/")}>← Back</button><div className="credits">Credits</div></nav>
 <section className="verify"><p className="eyebrow">DEEP INVESTIGATION</p><h1>Investigate thoroughly.</h1>
 <p className="sub">Vuryfy will break the claim into questions, research multiple sources, and synthesize the evidence.</p>
 <textarea value={claim} onChange={e=>setClaim(e.target.value)} placeholder="Paste a claim, statement, or URL…" maxLength={10000}/>
 <div className="actions"><span>{claim.length}/10,000</span><button onClick={submit} disabled={loading||claim.trim().length<5}>{loading?"Starting…":"Start investigation"}</button></div>
 {error&&<p className="error">{error}</p>}</section></main>
}
