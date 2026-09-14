-- Vuryfy — adds refund_quick_check(), the counterpart to
-- decrement_quick_check() from 0001_init.sql.
--
-- Why this is needed now: decrement_quick_check() reserves/charges the
-- credit BEFORE the Quick Check pipeline runs (see app/api/verify/route.ts)
-- so a 0-credit user can never trigger a paid Gemini/Tavily call, and so
-- concurrent requests can't race past the same last credit. That was safe
-- with the old placeholder pipeline (it could never fail), but now that
-- Quick Check makes real external API calls, genuine infrastructure
-- failures (network errors, provider outages, timeouts) are possible. Per
-- the locked credit-consumption principle (Part 26.4 addition #1), only
-- those genuine infra failures are non-chargeable — a completed verdict
-- (even "Unverified") is always charged. refund_quick_check() is what lets
-- the API route give the reserved credit back in that one specific case.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod,
-- same as 0001_init.sql.

create or replace function public.refund_quick_check(p_user_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_remaining integer;
begin
  update public.credit_balances
    set quick_checks_remaining = quick_checks_remaining + 1,
        updated_at = now()
    where user_id = p_user_id
    returning quick_checks_remaining into v_remaining;

  return v_remaining; -- NULL if the user has no credit_balances row at all
end;
$$;
