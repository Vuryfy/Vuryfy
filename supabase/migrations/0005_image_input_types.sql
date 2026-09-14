-- Widen verifications.input_type to accept "ocr" and "image" — Sept 2026.
--
-- Next step in the locked media-type build order (text + link -> QR ->
-- image -> audio/video), widening the same check constraint one step
-- further (see 0001_init.sql's and 0004_qr_input_type.sql's comments on
-- this column).
--
-- Image input ships as two distinct sub-paths, hence two new values:
--   - "ocr"   — text extracted from an image client-side (Tesseract.js,
--               see lib/decode-image-text.ts), then run through the exact
--               same text pipeline as a typed claim, via /api/verify and
--               /api/deep — same as "qr" already does for QR-decoded text.
--               The image itself never leaves the device for this path.
--   - "image" — the image itself is the thing being judged (lib/image-
--               analysis.ts's vision pipeline, via the new /api/verify-image
--               and /api/deep-image routes). This DOES send the image to
--               the server and to the Gemini vision call — see lib/image-
--               analysis.ts's file header for the media-retention decision
--               that goes with that (never persisted to storage, passed
--               through only for the duration of the request).
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod.

alter table public.verifications drop constraint if exists verifications_input_type_check;
alter table public.verifications add constraint verifications_input_type_check
  check (input_type in ('text', 'link', 'qr', 'ocr', 'image'));
