-- Vuryfy V1 schema — Sprint 1 (Quick Check: text + link only, Deep Investigation deferred)
--
-- Security model: RLS is ON for every table below (Supabase project was created with
-- "automatic RLS" enabled, and no policies are added here on purpose). That means the
-- browser's publishable/anon key has ZERO access to any of these tables — the browser
-- only ever talks to Supabase directly for Auth (phone OTP). All reads/writes to the
-- tables below happen server-side, in Next.js API routes, using the service_role key
-- (see lib/supabase/admin.ts) — the API route code is what enforces "you can only see
-- your own data," not a Postgres policy. This matches the locked decision that AI/billing
-- logic is decided by deterministic backend code only (Part 19), and keeps things simple
-- for V1 without hand-writing per-table RLS policies we'd have to keep in sync.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod — schema must
-- be identical in both; only the data differs.

-- ─────────────────────────────────────────────────────────────────────────
-- profiles: mirrors auth.users so other tables can foreign-key without
-- touching the auth schema directly (standard Supabase pattern).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Auto-create a profile row whenever a new auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, phone)
  values (new.id, new.phone);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────
-- plans: reference data for the ₹99 / ₹299 plans, editable without a
-- redeploy. Prices in whole rupees. "intro_*" = allowance for the plan's
-- first month; "monthly_*" = recurring allowance from month 2 onward.
-- No-rollover is enforced in application code, not here (each new period
-- resets remaining counts to the plan's monthly allowance).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.plans (
  code text primary key,
  display_name text not null,
  price_inr integer not null,
  intro_quick_checks integer not null default 0,
  intro_deep_investigations integer not null default 0,
  monthly_quick_checks integer not null default 0,
  monthly_deep_investigations integer not null default 0,
  is_active boolean not null default true
);
alter table public.plans enable row level security;

insert into public.plans (code, display_name, price_inr, intro_quick_checks, intro_deep_investigations, monthly_quick_checks, monthly_deep_investigations)
values
  ('plan_99', 'Vuryfy 99', 99, 5, 0, 30, 2),
  ('plan_299', 'Vuryfy 299', 299, 5, 0, 75, 5)
on conflict (code) do update set
  display_name = excluded.display_name,
  price_inr = excluded.price_inr,
  intro_quick_checks = excluded.intro_quick_checks,
  intro_deep_investigations = excluded.intro_deep_investigations,
  monthly_quick_checks = excluded.monthly_quick_checks,
  monthly_deep_investigations = excluded.monthly_deep_investigations;

-- ─────────────────────────────────────────────────────────────────────────
-- subscriptions: one active row per user. is_intro_month flips to false
-- once the first billing period rolls over, which is what switches a
-- user's credit grant from the plan's intro_* amounts to its monthly_*
-- amounts. Payment gateway wiring (Razorpay) is not part of this migration.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_code text not null references public.plans(code),
  status text not null default 'active' check (status in ('active','canceled','past_due')),
  is_intro_month boolean not null default true,
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default (now() + interval '30 days'),
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
create index if not exists subscriptions_user_id_idx on public.subscriptions(user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- credit_balances: current spendable balance per user. Per the locked
-- decision, a user with no subscription has no row here (and no credits) —
-- flagged as an open question in the architecture doc, easy to revisit.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.credit_balances (
  user_id uuid primary key references auth.users(id) on delete cascade,
  quick_checks_remaining integer not null default 0,
  deep_investigations_remaining integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.credit_balances enable row level security;

-- ─────────────────────────────────────────────────────────────────────────
-- credit_transactions: append-only audit ledger. amount is negative for
-- consumption, positive for grants/refunds. Every balance change must
-- have a corresponding row here — never mutate credit_balances without
-- also writing one of these (Part 19's "AI never controls billing" +
-- Part 26.4's credit-consumption principle both depend on this trail
-- existing and being trustworthy).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  credit_type text not null check (credit_type in ('quick_check','deep_investigation')),
  amount integer not null,
  reason text not null,
  verification_id uuid,
  created_at timestamptz not null default now()
);
alter table public.credit_transactions enable row level security;
create index if not exists credit_transactions_user_id_idx on public.credit_transactions(user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- verifications: Quick Check results. input_type is constrained to the
-- two types Sprint 1 actually builds (text, link) — widen this check
-- constraint when QR/image/audio/video are added, one at a time, per the
-- locked build order. flagged_for_review exists now (per Part 11) even
-- though the review queue itself is out of V1 scope, so no migration is
-- needed later to add it.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  input_type text not null check (input_type in ('text','link')),
  claim_text text not null,
  normalized_claim text,
  verdict text,
  confidence integer,
  summary text,
  key_evidence jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  engine_version text not null default 'v1-stub',
  flagged_for_review boolean not null default false,
  credit_charged boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.verifications enable row level security;
create index if not exists verifications_user_id_idx on public.verifications(user_id);

alter table public.credit_transactions
  add constraint credit_transactions_verification_id_fkey
  foreign key (verification_id) references public.verifications(id) on delete set null;

-- ─────────────────────────────────────────────────────────────────────────
-- verification_cache_exact: Part 11's Exact-cache layer. cache_key is
-- hash(normalized_claim + verification_type + context + engine_version),
-- computed in application code. Semantic (pgvector) and Evidence cache
-- layers are deferred until there's a real embeddings provider wired up.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.verification_cache_exact (
  cache_key text primary key,
  verification_id uuid not null references public.verifications(id) on delete cascade,
  freshness_class text not null default 'medium',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.verification_cache_exact enable row level security;

-- ─────────────────────────────────────────────────────────────────────────
-- decrement_quick_check: atomically spends one Quick Check credit.
-- Returns the new remaining count on success, or NULL if the user has no
-- credit_balances row or is already at 0 — the API route treats NULL as
-- "insufficient credits" (HTTP 402). SECURITY DEFINER + the explicit
-- "and quick_checks_remaining > 0" guard is what makes this safe under
-- concurrent requests: two simultaneous Quick Checks racing for the same
-- last credit can't both succeed, because the UPDATE's WHERE clause is
-- re-evaluated per-row inside one atomic statement, not read-then-write
-- from application code.
--
-- Deep Investigation will need its own function later with reserve-then-
-- refund-on-failure semantics (per the FastAPI reference implementation)
-- rather than this simple decrement — not built yet since Deep
-- Investigation itself is deferred past this sprint.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.decrement_quick_check(p_user_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_remaining integer;
begin
  update public.credit_balances
    set quick_checks_remaining = quick_checks_remaining - 1,
        updated_at = now()
    where user_id = p_user_id
      and quick_checks_remaining > 0
    returning quick_checks_remaining into v_remaining;

  return v_remaining; -- NULL if no row updated (no balance row, or already 0)
end;
$$;
