-- Widen verifications.input_type to accept "qr" — Sept 14, 2026.
--
-- Quick Check's locked media-type build order is text + link, then QR,
-- then image, then audio/video, each widening this same check constraint
-- one value at a time (see 0001_init.sql's own comment on this column).
-- This is the QR step.
--
-- No other schema change is needed for QR: the QR image is decoded
-- entirely client-side in the browser (see lib/decode-qr.ts) and only the
-- decoded text is ever sent to the server — it goes through the exact same
-- /api/verify path a manually-typed claim uses, just with
-- input_type = "qr" instead of "text"/"link". The photo itself never
-- leaves the device, so there's no image upload, no storage, and none of
-- Part 15's media-retention/auto-deletion questions apply to this input
-- type at all.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod.

alter table public.verifications drop constraint if exists verifications_input_type_check;
alter table public.verifications add constraint verifications_input_type_check
  check (input_type in ('text', 'link', 'qr'));
