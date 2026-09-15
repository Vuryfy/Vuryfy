-- Temporary video upload storage — Sept 15, 2026.
--
-- Replaces video's original "browser reads the file, base64-encodes it,
-- POSTs it as JSON" upload path. That path hit a hard, non-negotiable
-- wall: Vercel Serverless Functions cap the incoming request body at
-- 4.5MB on every plan (see 0008_video_input_types.sql's era of fixes,
-- and lib/prepare-video-upload.ts's old header for the full 413
-- investigation) — no tuning of the size cap could ever support more than
-- a few seconds of real video within that ceiling. Supporting the user's
-- explicit "at least 3-5 minutes" requirement means the video bytes can
-- never go through a Vercel function's own request body at all.
--
-- This bucket is the fix: the browser uploads the video file DIRECTLY to
-- Supabase Storage using a short-lived signed upload URL (see
-- app/api/video-upload-url/route.ts), completely bypassing Vercel. The
-- server then downloads the bytes from Storage server-side (an outbound
-- fetch, not an inbound request body — no 4.5MB limit applies there) and
-- re-uploads them to Gemini's File API (lib/gemini-file-upload.ts) for
-- analysis.
--
-- Retention: this bucket is explicitly TEMPORARY, consistent with this
-- app's Part 15 media-retention principle (audio/image/video content is
-- never meant to persist). Every route that reads an object here deletes
-- it immediately after use, in a try/finally, whether the request
-- succeeds or fails — see app/api/transcribe-video/route.ts and the other
-- 4 video routes. There is deliberately no scheduled/cron cleanup job for
-- orphaned uploads in this V1; if a browser upload succeeds but the user
-- never triggers a server call that consumes it (e.g. they close the tab
-- between upload and pressing Quick Check), that object can linger. Revisit
-- with a scheduled cleanup only if real usage shows this happening enough
-- to matter — deliberately left out for now per this project's "build
-- thin" pattern.
--
-- IMPORTANT — Supabase plan ceiling: a bucket's file_size_limit can never
-- exceed the project's GLOBAL Storage limit, which is a hard, plan-based
-- ceiling Supabase enforces regardless of what this migration sets: 50MB
-- on the Free plan (cannot be raised at all), up to 500GB on Pro/Team. The
-- 250MB limit set below only takes effect if vuryfy-test / vuryfy-prod are
-- themselves on a paid Supabase plan with a global Storage limit at or
-- above 250MB (Settings -> Storage -> Global limit, in the Supabase
-- dashboard) — if either project is still on Supabase's Free plan, uploads
-- will be rejected above 50MB no matter what this bucket says, and video
-- length will be constrained accordingly regardless of the Vercel/Gemini
-- side of this change.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'temp-video-uploads',
  'temp-video-uploads',
  false, -- private — never directly browsable/linkable; every read goes through our own service-role code after an ownership check
  262144000, -- 250MB raw — see the plan-ceiling note above for why this may be capped lower in practice
  array[
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-matroska',
    'video/3gpp',
    'video/x-msvideo'
  ]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- RLS on storage.objects for this bucket: a signed user may only create,
-- read, or delete objects under their OWN user-id prefix
-- (temp-video-uploads/{auth.uid()}/...) — enforced the same way
-- app/api/video-upload-url/route.ts constructs the path server-side, but
-- also enforced here at the database level as defense in depth (the
-- signed-upload-URL flow already scopes the path, but RLS means a stolen
-- anon-key request still can't read/overwrite another user's temp upload).
--
-- Deletion after use goes through the admin/service-role client (see the
-- video routes), which bypasses RLS entirely, same as every other table in
-- this app — these policies exist for the signed-upload-URL path the
-- browser itself uses, not for our own server-side cleanup calls.

create policy "temp_video_uploads_own_folder_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'temp-video-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "temp_video_uploads_own_folder_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'temp-video-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "temp_video_uploads_own_folder_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'temp-video-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
