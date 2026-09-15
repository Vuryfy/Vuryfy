-- Widen verifications.input_type to accept "video_transcript" and "video"
-- -- Sept 2026.
--
-- Last step in the locked media-type build order (text + link -> QR ->
-- image -> audio -> video), widening the same check constraint one final
-- step further (see 0001_init.sql's, 0004_qr_input_type.sql's,
-- 0005_image_input_types.sql's, and 0006_audio_input_types.sql's comments
-- on this column).
--
-- Video input ships as two distinct sub-paths, mirroring audio's
-- audio_transcript/audio split exactly:
--   - "video_transcript" — speech transcribed from a video's audio track
--                          (see lib/video-transcript.ts), then run through
--                          the exact same text pipeline as a typed claim,
--                          via /api/verify and /api/deep — same as
--                          "audio_transcript" already does for audio.
--   - "video"            — the video itself is the thing being judged
--                          (lib/video-analysis.ts's authenticity/deepfake
--                          pipeline, via the new /api/verify-video and
--                          /api/deep-video routes). This DOES send the
--                          video to the server and to the Gemini call —
--                          see lib/video-analysis.ts's file header for the
--                          media-retention decision that goes with that
--                          (never persisted to storage, passed through
--                          only for the duration of the request) — same
--                          pattern as image's photo-as-claim and audio's
--                          recording-itself sub-paths.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod.

alter table public.verifications drop constraint if exists verifications_input_type_check;
alter table public.verifications add constraint verifications_input_type_check
  check (input_type in ('text', 'link', 'qr', 'ocr', 'image', 'audio_transcript', 'audio', 'video_transcript', 'video'));
