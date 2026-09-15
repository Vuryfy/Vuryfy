-- Widen verifications.input_type to accept "audio_transcript" and "audio"
-- -- Sept 2026.
--
-- Next step in the locked media-type build order (text + link -> QR ->
-- image -> audio/video), widening the same check constraint one step
-- further (see 0001_init.sql's, 0004_qr_input_type.sql's, and
-- 0005_image_input_types.sql's comments on this column). Audio ships
-- first of the last pair (audio/video) per the user's explicit sequencing
-- call — video follows once audio is fully shipped and tested.
--
-- Audio input ships as two distinct sub-paths, hence two new values,
-- mirroring image's ocr/image split exactly:
--   - "audio_transcript" — speech transcribed from an audio recording
--                          (see lib/audio-transcript.ts), then run through
--                          the exact same text pipeline as a typed claim,
--                          via /api/verify and /api/deep — same as "ocr"
--                          already does for OCR-extracted text. Unlike
--                          "ocr" (fully client-side), transcription itself
--                          is a real server-side AI call via the free
--                          /api/transcribe-audio preview route — see that
--                          file's header for why it's still kept free.
--   - "audio"            — the recording itself is the thing being judged
--                          (lib/audio-analysis.ts's authenticity pipeline,
--                          via the new /api/verify-audio and
--                          /api/deep-audio routes). This DOES send the
--                          audio to the server and to the Gemini call —
--                          see lib/audio-analysis.ts's file header for the
--                          media-retention decision that goes with that
--                          (never persisted to storage, passed through
--                          only for the duration of the request) — same
--                          pattern as image's photo-as-claim sub-path.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod.

alter table public.verifications drop constraint if exists verifications_input_type_check;
alter table public.verifications add constraint verifications_input_type_check
  check (input_type in ('text', 'link', 'qr', 'ocr', 'image', 'audio_transcript', 'audio'));
