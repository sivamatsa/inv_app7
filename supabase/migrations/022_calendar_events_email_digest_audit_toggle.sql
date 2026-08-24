-- ============================================================================
-- 022: Calendar Events (manual events/birthdays/anniversaries/reminders/
--      countdowns with advance notifications), a real digest-frequency
--      preference for Email Notifications (021), and an admin toggle to
--      turn off Audit History (030's other tables keep writing, this only
--      gates the audit_row_change() trigger).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- calendar_events - a general-purpose personal calendar entry, separate from
-- Contacts' own contact_important_dates (which are tied to a specific
-- contact). Same category as Notes/Contacts: personal data, no admin RLS
-- bypass at all (unlike Deals/Recurring/Gold).
-- ----------------------------------------------------------------------------
create table if not exists public.calendar_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  event_type text not null default 'Event'
    check (event_type in ('Birthday', 'Anniversary', 'Reminder', 'Important Date', 'Countdown', 'Event', 'Custom')),
  event_date date not null,
  -- Birthdays/Anniversaries typically repeat every year on the same
  -- month/day; a Countdown/one-off Event/Reminder typically shouldn't -
  -- the reminder generator below branches on this to decide whether it
  -- matches by month/day only (recurring) or the exact full date (one-off).
  recurring_yearly boolean not null default false,
  reminder_days_before jsonb not null default '[7, 3, 1, 0]'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists calendar_events_user_id_idx on public.calendar_events (user_id);
create index if not exists calendar_events_event_date_idx on public.calendar_events (event_date);

alter table public.calendar_events enable row level security;

drop policy if exists "select own calendar_events" on public.calendar_events;
create policy "select own calendar_events"
  on public.calendar_events for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own calendar_events" on public.calendar_events;
create policy "insert own calendar_events"
  on public.calendar_events for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own calendar_events" on public.calendar_events;
create policy "update own calendar_events"
  on public.calendar_events for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own calendar_events" on public.calendar_events;
create policy "delete own calendar_events"
  on public.calendar_events for delete
  to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_calendar_events_updated_at on public.calendar_events;
create trigger set_calendar_events_updated_at
  before update on public.calendar_events
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on public.calendar_events to authenticated;
grant usage, select on sequence public.calendar_events_id_seq to authenticated;

-- ----------------------------------------------------------------------------
-- Notifications: one more type, same unified table as every other reminder
-- engine in this app - no parallel calendar-notification system.
-- ----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('Payment Due', 'Payment Overdue', 'Maturity Approaching', 'Maturity Today',
                   'Principal Expected', 'Large Payment Expected', 'Missed Payment',
                   'Reinvestment Opportunity', 'Deal Closure', 'Document Expiry', 'Tax Reporting',
                   'Support Ticket', 'Recurring Reminder', 'Recurring Overdue',
                   'Contact Reminder', 'Contact Birthday', 'Contact Important Date',
                   'New Message', 'Group Message', 'Mention', 'Incoming Call', 'Missed Call',
                   'Gold Target Price', 'Gold Price Drop', 'Gold Price Rise', 'Gold New Low', 'Gold New High',
                   'Calendar Reminder'));

alter table public.notifications add column if not exists calendar_event_id bigint references public.calendar_events(id) on delete cascade;
create index if not exists notifications_calendar_event_id_idx on public.notifications (calendar_event_id);

-- ----------------------------------------------------------------------------
-- fn_generate_calendar_event_reminders - cron-checked, folded into the
-- existing 15-minute job below. Loops each event's own reminder_days_before
-- array (jsonb, e.g. [7,3,1,0] - same shape/convention as recurring_items'
-- own reminder_days_before), firing one notification per offset that lands
-- on today:
--   - recurring_yearly events match by MONTH/DAY only (fires every year,
--     regardless of which year event_date itself was originally set to).
--   - one-off events (Countdown/Event/Reminder/Custom left unchecked) match
--     the exact full date, so they only ever fire once, in the correct year.
-- ----------------------------------------------------------------------------
create or replace function public.fn_generate_calendar_event_reminders()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_rows int;
  v_inserted int := 0;
begin
  for v_row in
    select ce.id, ce.user_id, ce.title, ce.event_type, ce.event_date,
           (elem.value)::int as offset_days
    from public.calendar_events ce
    cross join lateral jsonb_array_elements(coalesce(ce.reminder_days_before, '[0]'::jsonb)) as elem(value)
    where
      case when ce.recurring_yearly then
        extract(month from ce.event_date) = extract(month from current_date + (elem.value)::int)
        and extract(day from ce.event_date) = extract(day from current_date + (elem.value)::int)
      else
        ce.event_date = current_date + (elem.value)::int
      end
  loop
    insert into public.notifications (user_id, calendar_event_id, type, title, message, priority, dedupe_key)
    values (
      v_row.user_id, v_row.id, 'Calendar Reminder',
      case when v_row.offset_days = 0 then format('%s today: %s', v_row.event_type, v_row.title)
           else format('%s in %s day%s: %s', v_row.event_type, v_row.offset_days,
                        case when v_row.offset_days = 1 then '' else 's' end, v_row.title) end,
      case when v_row.offset_days = 0 then format('%s is today (%s).', v_row.title, to_char(current_date, 'DD Mon YYYY'))
           else format('%s is coming up on %s.', v_row.title, to_char(current_date + v_row.offset_days, 'DD Mon YYYY')) end,
      case when v_row.offset_days <= 1 then 'Medium' else 'Low' end,
      'Calendar Reminder' || '|' || v_row.id::text || '|' || v_row.offset_days::text || '|' || '' || '|' || current_date::text
    )
    on conflict (user_id, dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_inserted := v_inserted + v_rows;
  end loop;

  return v_inserted;
end;
$$;

revoke execute on function public.fn_generate_calendar_event_reminders() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Email digest frequency (021_email_notifications.sql's boolean toggle
-- becomes a real cadence). last_email_digest_sent_at is the sender Edge
-- Function's own bookkeeping - "when did this user's last digest actually
-- go out" - not something the frontend ever writes.
-- ----------------------------------------------------------------------------
alter table public.notification_preferences add column if not exists email_frequency text
  not null default '1_day'
  check (email_frequency in ('never', '1_day', '5_days', '7_days', '10_days', '1_month', '3_months'));
alter table public.notification_preferences add column if not exists last_email_digest_sent_at timestamptz;

-- ----------------------------------------------------------------------------
-- app_settings - a true singleton (id always 1), for global/admin-level
-- operational toggles that aren't per-user preferences and aren't shared
-- market data either. Admin-only in both directions: a regular user has no
-- reason to see or change this.
-- ----------------------------------------------------------------------------
create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  audit_history_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

drop policy if exists "admin select app_settings" on public.app_settings;
create policy "admin select app_settings"
  on public.app_settings for select
  to authenticated
  using (private.is_admin());

drop policy if exists "admin update app_settings" on public.app_settings;
create policy "admin update app_settings"
  on public.app_settings for update
  to authenticated
  using (private.is_admin())
  with check (private.is_admin());

insert into public.app_settings (id) values (1) on conflict (id) do nothing;

grant select, update on public.app_settings to authenticated;

drop trigger if exists set_app_settings_updated_at on public.app_settings;
create trigger set_app_settings_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- audit_row_change() - add the one-line disable check at the top, otherwise
-- byte-for-byte the same function from 006_audit_imports.sql. A disabled
-- toggle only stops FUTURE growth (spec's own "maintain audit history" rule
-- still applies to rows already written) - existing audit_logs rows are
-- untouched, no bulk delete happens here.
-- ----------------------------------------------------------------------------
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_user_id uuid;
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_old_val text;
  v_new_val text;
  v_ignored_keys text[] := array['updated_at', 'created_at'];
begin
  select audit_history_enabled into v_enabled from public.app_settings where id = 1;
  if coalesce(v_enabled, true) = false then
    return case tg_op when 'DELETE' then OLD else NEW end;
  end if;

  if tg_op = 'DELETE' then
    v_user_id := (to_jsonb(OLD) ->> 'user_id')::uuid;
    insert into public.audit_logs (user_id, table_name, record_id, action, old_value, source)
    values (v_user_id, tg_table_name, (to_jsonb(OLD) ->> 'id')::bigint, 'DELETE', to_jsonb(OLD)::text, 'system');
    return OLD;
  elsif tg_op = 'INSERT' then
    v_user_id := (to_jsonb(NEW) ->> 'user_id')::uuid;
    insert into public.audit_logs (user_id, table_name, record_id, action, new_value, source)
    values (v_user_id, tg_table_name, (to_jsonb(NEW) ->> 'id')::bigint, 'INSERT', to_jsonb(NEW)::text, 'system');
    return NEW;
  else
    v_user_id := (to_jsonb(NEW) ->> 'user_id')::uuid;
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any(v_ignored_keys) then
        continue;
      end if;
      v_old_val := v_old ->> v_key;
      v_new_val := v_new ->> v_key;
      if v_old_val is distinct from v_new_val then
        insert into public.audit_logs (user_id, table_name, record_id, action, field_name, old_value, new_value, source)
        values (v_user_id, tg_table_name, (v_new ->> 'id')::bigint, 'UPDATE', v_key, v_old_val, v_new_val, 'system');
      end if;
    end loop;
    return NEW;
  end if;
end;
$$;

revoke execute on function public.audit_row_change() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Admin automation button - bring fn_admin_run_automation() up to date with
-- every automation function the 15-minute cron job actually runs (it had
-- drifted: 018/019 extended the cron job but never this function), plus the
-- new calendar reminder generator.
-- ----------------------------------------------------------------------------
create or replace function public.fn_admin_run_automation()
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only an admin can run this.';
  end if;
  perform public.fn_refresh_schedule_statuses();
  perform public.fn_generate_reminders();
  perform public.fn_generate_ai_insights();
  perform public.fn_generate_recurring_occurrences_all();
  perform public.fn_refresh_recurring_statuses();
  perform public.fn_generate_recurring_reminders();
  perform public.fn_generate_contact_reminders();
  perform public.fn_refresh_call_statuses();
  perform public.fn_generate_gold_alerts();
  perform public.fn_generate_calendar_event_reminders();
  return 'ok';
end;
$$;

-- ----------------------------------------------------------------------------
-- Cron: fold the calendar reminder generator into the same 15-minute job,
-- same unschedule-by-name/reschedule idiom as every prior addendum.
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
  select public.fn_generate_gold_alerts();
  select public.fn_generate_calendar_event_reminders();
  $$
);
