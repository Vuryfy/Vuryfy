// ffmpeg-static ships no TypeScript declarations of its own, and this
// project doesn't want an extra dependency (@types/ffmpeg-static) just for
// one default-export string — this local ambient declaration is enough for
// strict mode. See lib/deepgram-transcript.ts for the only usage.
declare module "ffmpeg-static" {
  const ffmpegPath: string | null;
  export default ffmpegPath;
}
