"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Retired Sept 14, 2026: Deep Investigation now runs as a single
// synchronous request (see app/deep/page.tsx and app/api/deep/route.ts),
// so there's no job to poll status for anymore. This route is kept only so
// an old bookmark or link doesn't hit a broken page — it just bounces
// home. Safe to delete outright whenever this file is next touched; kept
// as a redirect rather than removed outright because this session doesn't
// have a way to delete files on the user's machine directly.
export default function DeepStatusRetired() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return null;
}
