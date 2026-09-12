"use client";
import {useEffect,useState} from "react";
import {useRouter} from "next/navigation";

export default function Billing(){
 const router=useRouter(); const [sub,setSub]=useState<any>(null); const [msg,setMsg]=useState("");
 async function load(){const t=localStorage.getItem("vuryfy_token"); if(!t){router.replace("/login");return}
  const r=await fetch("http://localhost:8000/api/v1/billing/subscription",{headers:{Authorization:`Bearer ${t}`}}); if(r.ok)setSub(await r.json())}
 useEffect(()=>{load()},[]);
 async function subscribe(){const t=localStorage.getItem("vuryfy_token"); const r=await fetch("http://localhost:8000/api/v1/billing/subscribe",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${t}`},body:JSON.stringify({plan:"pro"})}); const p=await r.json(); if(!r.ok){setMsg(p.detail);return}
  const c=await fetch(`http://localhost:8000/api/v1/billing/subscribe/${p.payment_id}/complete`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${t}`},body:JSON.stringify({plan:"pro"})}); const s=await c.json(); if(c.ok){setSub(s);setMsg("Development payment completed.");}else setMsg(s.detail||"Unable to activate subscription")}
 async function topup(sku:string){const t=localStorage.getItem("vuryfy_token"); const r=await fetch("http://localhost:8000/api/v1/billing/topup",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${t}`},body:JSON.stringify({sku})}); const p=await r.json(); if(!r.ok){setMsg(p.detail);return}
  const c=await fetch(`http://localhost:8000/api/v1/billing/topup/${p.payment_id}/complete`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${t}`},body:JSON.stringify({sku})}); const x=await c.json(); setMsg(c.ok?"Development top-up completed.":(x.detail||"Top-up failed"))}
 async function cancel(){const t=localStorage.getItem("vuryfy_token"); const r=await fetch("http://localhost:8000/api/v1/billing/cancel",{method:"POST",headers:{Authorization:`Bearer ${t}`}}); const x=await r.json(); if(r.ok)setSub(x);else setMsg(x.detail)}
 return <main className="shell narrow"><nav><button className="back" onClick={()=>router.push("/")}>← Home</button><div className="brand">Billing</div></nav>
 <section className="hero billing"><p className="eyebrow">CREDITS & SUBSCRIPTION</p><h1>{sub?"Your subscription.":"Choose your plan."}</h1>
 {sub?<><p className="sub">Plan: {sub.plan} · {sub.cancel_at_period_end?"Cancellation scheduled":"Active"}</p><button onClick={cancel} disabled={sub.cancel_at_period_end}>Cancel at period end</button></>:<><p className="sub">Development payment mode is active. No real payment is taken.</p><button onClick={subscribe}>Subscribe to Pro</button></>}
 <div className="topup-box"><h2>Top up</h2><p>Quick 10 · Quick 25 · Deep 3</p><div className="home-actions"><button onClick={()=>topup("quick_10")}>Quick +10</button><button onClick={()=>topup("quick_25")}>Quick +25</button><button onClick={()=>topup("deep_3")}>Deep +3</button></div></div>
 {msg&&<p className="message">{msg}</p>}</section></main>
}
