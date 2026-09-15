import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Sept 15, 2026: without this, Next's file tracing doesn't pick up the
  // ffmpeg-static binary (it's a native asset resolved at runtime via a
  // computed path, not a normal `require`/`import`, so the tracer can't see
  // it) — the transcribe-video route works fine locally but silently fails
  // to find ffmpeg once deployed to Vercel. See lib/deepgram-transcript.ts's
  // header for why this route needs ffmpeg at all (extracting audio from
  // video before sending it to Deepgram).
  outputFileTracingIncludes: {
    "/api/transcribe-video": ["./node_modules/ffmpeg-static/**"],
  },
};
export default nextConfig;
