-- Payee look-alike detection — Sept 15, 2026.
--
-- Prompted by a real near-miss the user reported: a payment QR displaying
-- "BABLI ORGANIC PRIVATE LIMITED" — one word off from "Babli Organics",
-- the user's own real business — a classic UPI scam pattern (a
-- near-identical payee NAME on a DIFFERENT payment ID, hoping the payer
-- doesn't look closely at the actual VPA).
--
-- This does NOT attempt to verify who legitimately owns a UPI ID (see
-- lib/detect-payment-link.ts's header — there's no public source for
-- that, which is exactly why payment QR codes were pulled out of the
-- normal fact-checking pipeline in the first place). Instead, this table
-- just remembers every payee (name + UPI ID) a user has ever scanned
-- through Vuryfy's QR checker, so a NEW payment ID with a name that's
-- near-identical to one already on file can be flagged as worth a closer
-- look — see app/api/check-payee/route.ts for the comparison logic.
--
-- Deliberately per-user (not a shared/global registry across all Vuryfy
-- users): a global "verified businesses" list is a much bigger feature —
-- it would need a real business-verification process, and could itself be
-- gamed by an attacker registering a fake "real" entry before the
-- legitimate business does. This only protects a user from a payee
-- impersonating someone THAT SAME USER has already scanned before.
--
-- RLS: enabled with no policies, same "automatic RLS blocks the anon key
-- entirely; the service_role key used by API routes does the per-user
-- scoping in application code" pattern as every other table (see
-- 0001_init.sql's header comment) — not a deviation, just following the
-- established security model.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod.

create table if not exists public.payment_payees_seen (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  upi_id text not null,
  payee_name text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  times_seen integer not null default 1,
  unique (user_id, upi_id)
);
alter table public.payment_payees_seen enable row level security;
create index if not exists payment_payees_seen_user_id_idx on public.payment_payees_seen(user_id);
