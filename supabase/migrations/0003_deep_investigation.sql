-- Vuryfy — Deep Investigation schema additions.
--
-- Deep Investigation shares the `verifications` table with Quick Check
-- (same result shape: verdict/confidence/summary/evidence/sources) rather
-- than a separate table, but needs two things Quick Check didn't:
--
-- 1. `mode` — so a row can be told apart as 'quick' vs 'deep' (history,
--    analytics, and so a Deep Investigation's exact-match cache entries
--    never collide with Quick Check's — see lib/verification-cache.ts,
--    which already keys on engine_version too, so this is belt-and-braces
--    rather than strictly required for correctness).
-- 2. `caveats` — Deep Investigation's reasoning-tier synthesis surfaces
--    explicit caveats/limitations (Part 26.5's summary, and the old
--    FastAPI reference implementation's `caveats_json` field) that Quick
--    Check's simpler pipeline doesn't produce. Stored as jsonb like
--    key_evidence/sources rather than a delimited string.
--
-- Also adds decrement_deep_investigation()/refund_deep_investigation(),
-- the Deep Investigation counterparts to decrement_quick_check()/
-- refund_quick_check() from 0001_init.sql/0002_quick_check_refund.sql —
-- same reserve-before-running, refund-only-on-infra-failure pattern
-- (Part 26.4 addition #1's credit-consumption principle applies to Deep
-- Investigation exactly the same way it does to Quick Check).
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and
-- vuryfy-prod, same as 0001_init.sql and 0002_quick_check_refund.sql.

alter table public.verifications
  add column if not exists mode text not null default 'quick' check (mode in ('quick', 'deep'));

alter table public.verifications
  add column if not exists caveats jsonb not null default '[]'::jsonb;

create index if not exists verifications_mode_idx on public.verifications(mode);

create or replace function public.decrement_deep_investigation(p_user_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_remaining integer;
begin
  update public.credit_balances
    set deep_investigations_remaining = deep_investigations_remaining - 1,
        updated_at = now()
    where user_id = p_user_id
      and deep_investigations_remaining > 0
    returning deep_investigations_remaining into v_remaining;

  return v_remaining; -- NULL if no row updated (no balance row, or already 0)
end;
$$;

create or replace function public.refund_deep_investigation(p_user_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_remaining integer;
begin
  update public.credit_balances
    set deep_investigations_remaining = deep_investigations_remaining + 1,
        updated_at = now()
    where user_id = p_user_id
    returning deep_investigations_remaining into v_remaining;

  return v_remaining; -- NULL if the user has no credit_balances row at all
end;
$$;
