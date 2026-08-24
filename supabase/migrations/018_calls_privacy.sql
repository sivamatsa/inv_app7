-- ============================================================================
-- 018: Voice/video calling (spec addendum Sections 17-19), plus folding
--      016/017's new automation into the existing cron job.
-- ============================================================================
-- 1:1 calling only (no call_participants / group calls - see the plan file's
-- scope note: a group-calling mesh/SFU is a materially larger problem this
-- stack has no media server for). WebRTC signaling itself (SDP offer/answer,
-- ICE candidates) is ephemeral and never touches the database - only the
-- call's lifecycle (who, when, how it ended) is persisted here. The INSERT
-- of a `calls` row is the "incoming call" signal, delivered the same way
-- every other realtime notification in this app already is.
-- ============================================================================

create table if not exists public.calls (
  id bigint generated always as identity primary key,
  conversation_id bigint references public.conversations(id) on delete set null,
  caller_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  call_type text not null check (call_type in ('VOICE', 'VIDEO')),
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration int,
  status text not null default 'CALLING'
    check (status in ('CALLING', 'RINGING', 'ANSWERED', 'MISSED', 'DECLINED', 'FAILED', 'ENDED')),
  check (caller_id <> receiver_id)
);

create index if not exists calls_caller_id_idx on public.calls (caller_id);
create index if not exists calls_receiver_id_idx on public.calls (receiver_id);
create index if not exists calls_started_at_idx on public.calls (started_at);

alter table public.calls enable row level security;

-- private.can_call: same shape as find_portfolio_user's privacy check
-- (016_contacts.sql) - Nobody/Anyone/Contacts-only against the receiver's
-- own settings, plus an unconditional block check either direction.
create or replace function private.can_call(p_caller uuid, p_receiver uuid)
returns boolean
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_tier text;
  v_caller_email text;
  v_caller_mobile text;
  v_ok boolean;
begin
  if private.is_blocked(p_caller, p_receiver) then
    return false;
  end if;

  select who_can_call_me into v_tier from public.user_privacy_settings where user_id = p_receiver;
  if v_tier is null then
    v_tier := 'Contacts';
  end if;

  if v_tier = 'Nobody' then return false; end if;
  if v_tier = 'Anyone' then return true; end if;

  select email, mobile into v_caller_email, v_caller_mobile from public.profiles where id = p_caller;
  select exists(
    select 1 from public.contacts c
    left join public.contact_phones cp on cp.contact_id = c.id
    left join public.contact_emails ce on ce.contact_id = c.id
    where c.owner_user_id = p_receiver
      and ((v_caller_mobile is not null and cp.phone_number = v_caller_mobile)
           or (v_caller_email is not null and ce.email = v_caller_email))
  ) into v_ok;
  return coalesce(v_ok, false);
end;
$$;

revoke execute on function private.can_call(uuid, uuid) from public, anon;
grant execute on function private.can_call(uuid, uuid) to authenticated;

drop policy if exists "select own calls" on public.calls;
create policy "select own calls"
  on public.calls for select to authenticated
  using (caller_id = (select auth.uid()) or receiver_id = (select auth.uid()));

drop policy if exists "insert own calls" on public.calls;
create policy "insert own calls"
  on public.calls for insert to authenticated
  with check (caller_id = (select auth.uid()) and private.can_call((select auth.uid()), receiver_id));

drop policy if exists "update own calls" on public.calls;
create policy "update own calls"
  on public.calls for update to authenticated
  using (caller_id = (select auth.uid()) or receiver_id = (select auth.uid()))
  with check (caller_id = (select auth.uid()) or receiver_id = (select auth.uid()));

grant select, insert, update on table public.calls to authenticated;

-- Missed-call notification, same unified-notifications reuse as everywhere
-- else in this app.
create or replace function private.notify_missed_call()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_name text;
begin
  if new.status = 'MISSED' and old.status is distinct from 'MISSED' then
    select full_name into v_caller_name from public.profiles where id = new.caller_id;
    insert into public.notifications (user_id, type, title, message, priority, dedupe_key)
    values (
      new.receiver_id, 'Missed Call',
      format('Missed call from %s', coalesce(v_caller_name, 'Someone')),
      format('%s call missed at %s.', new.call_type, to_char(new.started_at, 'HH12:MI AM')),
      'Medium',
      'Missed Call' || '|' || new.id::text || '|' || '' || '|' || '' || '|' || current_date::text
    )
    on conflict (user_id, dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_missed_call on public.calls;
create trigger notify_missed_call
  after update on public.calls
  for each row execute function private.notify_missed_call();

-- Safety net: relying purely on the caller's own browser tab to give up and
-- mark a call MISSED is fragile (tab closed, laptop slept, etc.) - this
-- cron sweep catches anything still CALLING/RINGING a minute after it
-- started, which also fires notify_missed_call above since it's a plain
-- UPDATE.
create or replace function public.fn_refresh_call_statuses()
returns int
language sql
security definer
set search_path = ''
as $$
  with updated as (
    update public.calls
    set status = 'MISSED', ended_at = coalesce(ended_at, now())
    where status in ('CALLING', 'RINGING') and started_at < now() - interval '60 seconds'
    returning id
  )
  select count(*)::int from updated;
$$;

revoke execute on function public.fn_refresh_call_statuses() from public, anon, authenticated;

-- Realtime: an INSERT on `calls` (client-filtered to receiver_id = me) is
-- the incoming-call signal; UPDATEs (answered/ended elsewhere) also push so
-- the caller's own UI reflects acceptance/decline immediately.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'calls'
  ) then
    alter publication supabase_realtime add table public.calls;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Cron: fold 016's fn_generate_contact_reminders and this file's automation
-- into the same 15-minute job (unschedule-by-name/reschedule idiom, same as
-- 014 and 015's own extensions of the original 010_cron.sql job).
-- Deliberately NOT added to fn_admin_run_automation (013/014) - contact
-- reminders read private per-user contact data that admin has no
-- relationship to anywhere else in this app; keeping it cron-only (never
-- admin-triggerable) matches the "no admin bypass at all" rule for this
-- whole module.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'portfolio-automation-15min') then
    perform cron.unschedule('portfolio-automation-15min');
  end if;
end $$;

select cron.schedule(
  'portfolio-automation-15min',
  '*/15 * * * *',
  $$
  select public.fn_refresh_schedule_statuses();
  select public.fn_generate_reminders();
  select public.fn_generate_ai_insights();
  select public.fn_generate_recurring_occurrences_all();
  select public.fn_refresh_recurring_statuses();
  select public.fn_generate_recurring_reminders();
  select public.fn_generate_contact_reminders();
  select public.fn_refresh_call_statuses();
  $$
);
