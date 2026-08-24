-- ============================================================================
-- 038: AI Portfolio Copilot - usage metering only. This app's first live LLM
--      API call (Anthropic Claude, confirmed by the user) needs a hard daily
--      per-user cap so a bug or a curious user hammering it can't run up
--      unexpected API cost - the same race-safe, atomic-update spirit as
--      fn_gold_provider_record_fetch() (019_gold_intelligence.sql), but
--      keyed per (user, day) instead of one shared global row, since this
--      cap is per-user by nature and RLS can scope it correctly without
--      needing SECURITY DEFINER.
--
--      No conversation/question history table exists here on purpose - each
--      question is answered statelessly (kept in the browser tab only, never
--      persisted). Nothing about this feature needs a permanent record of a
--      user's free-text financial questions, and this counter already gives
--      admin enough to audit volume.
-- ============================================================================

create table if not exists public.copilot_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default current_date,
  requests_used int not null default 0,
  primary key (user_id, usage_date)
);

alter table public.copilot_usage enable row level security;

drop policy if exists "select own copilot_usage" on public.copilot_usage;
create policy "select own copilot_usage"
  on public.copilot_usage for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own copilot_usage" on public.copilot_usage;
create policy "insert own copilot_usage"
  on public.copilot_usage for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own copilot_usage" on public.copilot_usage;
create policy "update own copilot_usage"
  on public.copilot_usage for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update on public.copilot_usage to authenticated;

-- ----------------------------------------------------------------------------
-- fn_copilot_check_and_record_usage(p_daily_limit) - SECURITY INVOKER (this
-- table is per-user from the start, so RLS already scopes it correctly - no
-- need for the DEFINER-plus-explicit-ownership-check gold_providers needs
-- for its single shared row). One atomic upsert, no read-then-write, so two
-- near-simultaneous questions can never both slip past a limit check based
-- on a stale read. The Edge Function calls this FIRST, before ever calling
-- Anthropic, and rejects the question if the returned count exceeds
-- p_daily_limit - never spending API cost on an over-cap request.
-- ----------------------------------------------------------------------------
create or replace function public.fn_copilot_check_and_record_usage(p_daily_limit int)
returns table (requests_used int, allowed boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then
    raise exception 'Not authenticated.';
  end if;

  insert into public.copilot_usage (user_id, usage_date, requests_used)
  values (v_uid, current_date, 1)
  on conflict (user_id, usage_date) do update set requests_used = public.copilot_usage.requests_used + 1
  returning public.copilot_usage.requests_used into v_count;

  return query select v_count, (v_count <= p_daily_limit);
end;
$$;

revoke execute on function public.fn_copilot_check_and_record_usage(int) from public, anon;
grant execute on function public.fn_copilot_check_and_record_usage(int) to authenticated;
