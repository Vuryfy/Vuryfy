"use client";
import { Suspense, useEffect,useState } from "react";
import { useSearchParams,useRouter } from "next/navigation";

// NOTE: this page predates the Supabase rewrite — it still calls the old
// FastAPI backend at localhost:8000 and reads a localStorage token instead
// of a Supabase session. Deep Investigation is deferred past V1 (see
// architecture-decisions.md), so this page is not wired up to anything
// real yet. Wrapped in Suspense below only to satisfy Next.js's
// useSearchParams()-needs-a-Suspense-boundary requirement for static
// builds — functional rework happens whenever Deep Investigation is
// actually built.
function DeepStatusInner(){
 const params=useSearchParams(); const router=useRouter(); const id=params.get("id"); const [d,setD]=useState<any>(null); const [error,setError]=useState("");
 useEffect(()=>{
  const t=localStorage.getItem("vuryfy_token"); if(!t||!id){router.replace("/");return}
  let timer:any;
  const poll=async()=>{
   try{const r=await fetch(`http://localhost:8000/api/v1/verification/deep-investigation/${id}`,{headers:{Authorization:`Bearer ${t}`}}); const x=await r.json();
    if(!r.ok)throw new Error(x.detail||"Unable to load investigation"); setD(x);
    if(x.status==="completed"){sessionStorage.setItem("vuryfy_result",JSON.stringify(x));router.replace(`/result?id=${x.verification_id}`);return}
    if(x.status==="failed"){setError(x.error||"Investigation failed");return}
    timer=setTimeout(poll,1500);
   }catch(e:any){setError(e.message)}
  }; poll(); return()=>clearTimeout(timer)
 },[id,router]);
 return <main className="shell narrow"><nav><button className="back" onClick={()=>router.push("/")}>← Home</button><div className="credits">Deep Investigation</div></nav>
 <section className="hero status-hero"><p className="eyebrow">INVESTIGATION IN PROGRESS</p><h1>{d?.progress ?? 0}%</h1>
 <p className="sub">{d?.current_step || "Preparing the investigation…"}</p>{error&&<p className="error">{error}</p>}
 <p className="hint">You can keep this screen open while Vuryfy works.</p></section></main>
}

export default function DeepStatus(){
 return <Suspense fallback={null}><DeepStatusInner/></Suspense>
}
