"use client";
import { useEffect,useState } from "react";
import { useSearchParams,useRouter } from "next/navigation";

export default function DeepStatus(){
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
