-- ============================================================================
-- 015: Recurring Investments & Commitments (spec addendum Sections 56-93)
-- ============================================================================
-- A deliberately SEPARATE module from deals/payments (spec Section 56, 88,
-- 89): a deal is capital deployed that generates a return; a recurring item
-- is a repeated obligation/investment where the user must explicitly
-- confirm each period. Nothing here ever feeds deal ROI/interest math, and
-- nothing in v_deal_metrics/v_portfolio_summary is touched by this file.
--
-- The same non-negotiable rule this app already enforces for deal payments
-- (a schedule row only becomes "received" through a real payments row, never
-- inferred from the date) applies here: a due date arriving never
-- auto-completes an occurrence (Section 62, 68) - only an explicit Confirm
-- action does, via fn_confirm_recurring_occurrence below.
--
-- Reuses existing infrastructure rather than duplicating it (see the app's
-- plan file for the full rationale):
--   - Reminders/overdue notifications go through the existing public.
--     notifications table (new `type` values added to its check constraint),
--     not a separate recurring_notifications table - same bell, same
--     realtime channel, same dedupe_key idempotency the rest of the app uses.
--   - Investment-performance tracking (Section 78/86, itself marked
--     "optional" by the spec) is two nullable columns on
--     recurring_occurrences (actual_units, actual_nav), not three extra
--     tables - answers "what did this period's investment become worth"
--     without a second position-tracking subsystem.
--   - "Consecutive confirmed periods" (Section 80) is computed client-side
--     from the occurrence list the History tab already fetches, rather than
--     as a fragile ordered-window SQL expression that can't be tested
--     against a live database in this session.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- recurring_items (Sections 57, 58) - the master record.
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_items (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,

  external_reference text,
  item_name text not null,
  item_type text not null check (item_type in (
    'SIP', 'Mutual Fund', 'Gold Scheme', 'Gold Savings', 'Stocks / Shares', 'ETF',
    'Insurance', 'Term Insurance', 'Health Insurance', 'Life Insurance',
    'Recurring Deposit', 'NPS', 'Pension', 'Loan / EMI', 'Credit Card Bill', 'Rent',
    'Education Fee', 'Subscription', 'Membership', 'Savings Contribution',
    'Tax Payment', 'Other', 'Custom'
  )),
  -- Only populated/shown when item_type = 'Custom' (Section 58 "allow
  -- user-defined custom categories") - the app's own free-text label for the
  -- type, since item_type itself stays a closed list for reporting/grouping.
  custom_type_label text,
  category text,
  sub_category text,
  provider text,
  account_reference text,
  source text not null default 'Manual' check (source in ('Manual', 'Excel Import', 'CSV Import')),
  notes text,

  expected_amount numeric(14, 2) not null check (expected_amount > 0),
  minimum_amount numeric(14, 2),
  maximum_amount numeric(14, 2),
  currency text not null default 'INR',
  amount_type text not null default 'Fixed'
    check (amount_type in ('Fixed', 'Variable', 'Range', 'User Entered Each Period')),

  frequency text not null
    check (frequency in ('Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Custom')),
  -- Only meaningful when frequency = 'Custom' (Section 59): one flexible
  -- column rather than a dozen nullable scheduling columns, matching how
  -- `deals` already keeps type-specific optionals nullable.
  --   {"type":"day_of_month","day":10}
  --   {"type":"weekday","weekday":1}              -- ISO weekday, 1=Monday
  --   {"type":"every_n_months","n":3,"day":10}
  --   {"type":"explicit_dates","dates":["2026-09-01","2026-12-01"]}
  custom_rule jsonb,
  start_date date not null,
  end_date date,
  payment_day int check (payment_day between 1 and 31),
  first_due_date date,
  next_due_date date,
  last_confirmed_date date,
  duration_months int,
  number_of_occurrences int,

  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'EXPIRED')),

  reminder_enabled boolean not null default true,
  reminder_days_before jsonb not null default '[7,3,1,0]'::jsonb,
  overdue_reminder_enabled boolean not null default true,
  escalation_days jsonb not null default '[1,3,7]'::jsonb,

  -- Optional investment-specific fields (Section 57). Only relevant to some
  -- item_types (SIP/Mutual Fund/Gold/Stocks/Insurance/...); left nullable and
  -- the UI only shows the ones relevant to the selected item_type.
  expected_return numeric(14, 2),
  expected_roi numeric(9, 4),
  folio_number text,
  policy_number text,
  scheme_name text,
  units_expected numeric(18, 4),
  reference_price numeric(14, 4),
  beneficiary text,
  maturity_date date,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (end_date is null or end_date >= start_date)
);

create index if not exists recurring_items_user_id_idx on public.recurring_items (user_id);
create index if not exists recurring_items_status_idx on public.recurring_items (status);
create index if not exists recurring_items_item_type_idx on public.recurring_items (item_type);
create index if not exists recurring_items_next_due_date_idx on public.recurring_items (next_due_date);

alter table public.recurring_items enable row level security;

drop policy if exists "select own recurring_items" on public.recurring_items;
create policy "select own recurring_items"
  on public.recurring_items for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "insert own recurring_items" on public.recurring_items;
create policy "insert own recurring_items"
  on public.recurring_items for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own recurring_items" on public.recurring_items;
create policy "update own recurring_items"
  on public.recurring_items for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own recurring_items" on public.recurring_items;
create policy "delete own recurring_items"
  on public.recurring_items for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_recurring_items_updated_at on public.recurring_items;
create trigger set_recurring_items_updated_at
  before update on public.recurring_items
  for each row execute function public.set_updated_at();

drop trigger if exists audit_recurring_items on public.recurring_items;
create trigger audit_recurring_items
  after insert or update or delete on public.recurring_items
  for each row execute function public.audit_row_change();

grant select, insert, update, delete on table public.recurring_items to authenticated;

-- ----------------------------------------------------------------------------
-- recurring_occurrences (Sections 60, 61) - one row per period, always
-- independently stored, never inferred from a date. Unique on
-- (recurring_item_id, scheduled_date) rather than the spec's literal
-- period_label: scheduled_date is the true natural key regardless of
-- frequency (period_label alone would collide across weeks within the same
-- month for Weekly/Biweekly items), and this is exactly what makes both
-- occurrence generation and repeated Excel imports idempotent (Section 70).
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_occurrences (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  recurring_item_id bigint not null references public.recurring_items(id) on delete cascade,

  period_label text not null,
  scheduled_date date not null,
  due_date date not null,
  expected_amount numeric(14, 2) not null,
  actual_amount numeric(14, 2),
  paid_date date,
  status text not null default 'UPCOMING'
    check (status in ('UPCOMING', 'DUE', 'IN_PROGRESS', 'CONFIRMED', 'PAID', 'INVESTED',
                       'PARTIALLY_PAID', 'OVERDUE', 'SKIPPED', 'FAILED', 'CANCELLED', 'NOT_APPLICABLE')),
  payment_reference text,
  payment_method text,
  confirmation_method text,
  notes text,
  receipt_document_id bigint references public.documents(id) on delete set null,

  -- Optional investment-performance fields (Section 78/86 scope note above).
  actual_units numeric(18, 4),
  actual_nav numeric(14, 4),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (recurring_item_id, scheduled_date)
);

create index if not exists recurring_occurrences_user_id_idx on public.recurring_occurrences (user_id);
create index if not exists recurring_occurrences_item_id_idx on public.recurring_occurrences (recurring_item_id);
create index if not exists recurring_occurrences_status_idx on public.recurring_occurrences (status);
create index if not exists recurring_occurrences_due_date_idx on public.recurring_occurrences (due_date);

alter table public.recurring_occurrences enable row level security;

drop policy if exists "select own recurring_occurrences" on public.recurring_occurrences;
create policy "select own recurring_occurrences"
  on public.recurring_occurrences for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "insert own recurring_occurrences" on public.recurring_occurrences;
create policy "insert own recurring_occurrences"
  on public.recurring_occurrences for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own recurring_occurrences" on public.recurring_occurrences;
create policy "update own recurring_occurrences"
  on public.recurring_occurrences for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own recurring_occurrences" on public.recurring_occurrences;
create policy "delete own recurring_occurrences"
  on public.recurring_occurrences for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_recurring_occurrences_updated_at on public.recurring_occurrences;
create trigger set_recurring_occurrences_updated_at
  before update on public.recurring_occurrences
  for each row execute function public.set_updated_at();

drop trigger if exists audit_recurring_occurrences on public.recurring_occurrences;
create trigger audit_recurring_occurrences
  after insert or update or delete on public.recurring_occurrences
  for each row execute function public.audit_row_change();

grant select, insert, update, delete on table public.recurring_occurrences to authenticated;

-- ----------------------------------------------------------------------------
-- recurring_amount_history / recurring_schedule_history (Sections 83, 84) -
-- populated automatically by a trigger (below) whenever expected_amount or
-- frequency actually changes on recurring_items, so future amount/frequency
-- changes never require the UI to remember to log anything, and historical
-- occurrences (which already carry their own expected_amount captured at
-- generation time) are never retroactively touched.
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_amount_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  recurring_item_id bigint not null references public.recurring_items(id) on delete cascade,
  effective_from date not null default current_date,
  old_amount numeric(14, 2),
  new_amount numeric(14, 2) not null,
  changed_at timestamptz not null default now()
);

create index if not exists recurring_amount_history_item_id_idx on public.recurring_amount_history (recurring_item_id);

alter table public.recurring_amount_history enable row level security;

drop policy if exists "select own recurring_amount_history" on public.recurring_amount_history;
create policy "select own recurring_amount_history"
  on public.recurring_amount_history for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

-- No insert/update/delete policy for regular users - every row here is
-- written exclusively by the trigger below (which runs with the privileges
-- of whoever updates recurring_items, i.e. the owner), same "read-only
-- audit trail" reasoning as audit_logs.
grant select, insert on table public.recurring_amount_history to authenticated;

create table if not exists public.recurring_schedule_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  recurring_item_id bigint not null references public.recurring_items(id) on delete cascade,
  effective_from date not null default current_date,
  old_frequency text,
  new_frequency text not null,
  changed_at timestamptz not null default now()
);

create index if not exists recurring_schedule_history_item_id_idx on public.recurring_schedule_history (recurring_item_id);

alter table public.recurring_schedule_history enable row level security;

drop policy if exists "select own recurring_schedule_history" on public.recurring_schedule_history;
create policy "select own recurring_schedule_history"
  on public.recurring_schedule_history for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

grant select, insert on table public.recurring_schedule_history to authenticated;

create or replace function private.fn_track_recurring_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.expected_amount is distinct from old.expected_amount then
    insert into public.recurring_amount_history (user_id, recurring_item_id, effective_from, old_amount, new_amount)
    values (new.user_id, new.id, current_date, old.expected_amount, new.expected_amount);
  end if;
  if new.frequency is distinct from old.frequency then
    insert into public.recurring_schedule_history (user_id, recurring_item_id, effective_from, old_frequency, new_frequency)
    values (new.user_id, new.id, current_date, old.frequency, new.frequency);
  end if;
  return new;
end;
$$;

drop trigger if exists track_recurring_changes on public.recurring_items;
create trigger track_recurring_changes
  before update on public.recurring_items
  for each row execute function private.fn_track_recurring_changes();

-- ----------------------------------------------------------------------------
-- recurring_pauses (Section 81). An open pause (resumed_at is null) blocks
-- occurrence generation for any scheduled_date >= paused_from; resuming only
-- generates occurrences from the resume date forward - never backfills
-- overdue periods for the paused window (the spec's explicit rule).
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_pauses (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  recurring_item_id bigint not null references public.recurring_items(id) on delete cascade,
  paused_from date not null default current_date,
  resumed_at date,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists recurring_pauses_item_id_idx on public.recurring_pauses (recurring_item_id);

alter table public.recurring_pauses enable row level security;

drop policy if exists "select own recurring_pauses" on public.recurring_pauses;
create policy "select own recurring_pauses"
  on public.recurring_pauses for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "insert own recurring_pauses" on public.recurring_pauses;
create policy "insert own recurring_pauses"
  on public.recurring_pauses for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own recurring_pauses" on public.recurring_pauses;
create policy "update own recurring_pauses"
  on public.recurring_pauses for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update on table public.recurring_pauses to authenticated;

-- ----------------------------------------------------------------------------
-- notifications: allow the new recurring notification types (same
-- drop/recreate-constraint idiom used in 014 for 'Support Ticket').
-- ----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('Payment Due', 'Payment Overdue', 'Maturity Approaching', 'Maturity Today',
                   'Principal Expected', 'Large Payment Expected', 'Missed Payment',
                   'Reinvestment Opportunity', 'Deal Closure', 'Document Expiry', 'Tax Reporting',
                   'Support Ticket', 'Recurring Reminder', 'Recurring Overdue'));

alter table public.notifications add column if not exists recurring_item_id bigint references public.recurring_items(id) on delete cascade;
alter table public.notifications add column if not exists recurring_occurrence_id bigint references public.recurring_occurrences(id) on delete cascade;
create index if not exists notifications_recurring_item_id_idx on public.notifications (recurring_item_id);

-- ----------------------------------------------------------------------------
-- Frequency engine (Section 59). private.fn_month_day_clamped: adding
-- (day-1) days to the 1st of a month and clamping to the month's own last
-- day handles every month-length/leap-year edge case in one expression - a
-- day of 31 in a 30-day month lands on the 30th, not next month.
-- ----------------------------------------------------------------------------
create or replace function private.fn_month_day_clamped(p_first_of_month date, p_day int)
returns date
language sql
immutable
set search_path = ''
as $$
  select least(
    p_first_of_month + (greatest(p_day, 1) - 1) * interval '1 day',
    p_first_of_month + interval '1 month - 1 day'
  )::date;
$$;

grant execute on function private.fn_month_day_clamped(date, int) to authenticated;

-- private.fn_recurring_next_date: given the item's frequency/custom_rule and
-- the date of the last occurrence, returns the single next occurrence date
-- (or null once an 'explicit_dates' custom series is exhausted).
create or replace function private.fn_recurring_next_date(p_item public.recurring_items, p_after date)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  v_next date;
  v_day int := coalesce(p_item.payment_day, extract(day from coalesce(p_item.first_due_date, p_item.start_date))::int, 1);
  v_rule jsonb := p_item.custom_rule;
  v_candidate date;
  v_d date;
begin
  case p_item.frequency
    when 'Weekly' then
      v_next := p_after + 7;
    when 'Biweekly' then
      v_next := p_after + 14;
    when 'Monthly' then
      v_next := private.fn_month_day_clamped((date_trunc('month', p_after) + interval '1 month')::date, v_day);
    when 'Quarterly' then
      v_next := private.fn_month_day_clamped((date_trunc('month', p_after) + interval '3 months')::date, v_day);
    when 'Half-Yearly' then
      v_next := private.fn_month_day_clamped((date_trunc('month', p_after) + interval '6 months')::date, v_day);
    when 'Yearly' then
      v_next := private.fn_month_day_clamped((date_trunc('month', p_after) + interval '12 months')::date, v_day);
    when 'Custom' then
      case coalesce(v_rule ->> 'type', 'day_of_month')
        when 'day_of_month' then
          v_next := private.fn_month_day_clamped(
            (date_trunc('month', p_after) + interval '1 month')::date,
            coalesce((v_rule ->> 'day')::int, v_day));
        when 'weekday' then
          v_candidate := p_after + 1;
          while extract(isodow from v_candidate)::int <> coalesce((v_rule ->> 'weekday')::int, 1) loop
            v_candidate := v_candidate + 1;
          end loop;
          v_next := v_candidate;
        when 'every_n_months' then
          v_next := private.fn_month_day_clamped(
            (date_trunc('month', p_after) + (coalesce((v_rule ->> 'n')::int, 1) || ' months')::interval)::date,
            coalesce((v_rule ->> 'day')::int, v_day));
        when 'explicit_dates' then
          v_next := null;
          for v_d in
            select (elem)::date as d
            from jsonb_array_elements_text(v_rule -> 'dates') as elem
            order by 1
          loop
            if v_d > p_after then
              v_next := v_d;
              exit;
            end if;
          end loop;
        else
          v_next := private.fn_month_day_clamped((date_trunc('month', p_after) + interval '1 month')::date, v_day);
      end case;
    else
      v_next := p_after + 30;
  end case;

  return v_next;
end;
$$;

grant execute on function private.fn_recurring_next_date(public.recurring_items, date) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_generate_recurring_occurrences (Sections 59, 60, 93 - "the system
-- generates the next occurrence automatically"). SECURITY INVOKER: runs as
-- the calling user, gated by the normal RLS on recurring_items/
-- recurring_occurrences/recurring_pauses, same reasoning as
-- fn_generate_payment_schedule. Bounded to a 90-day lookahead and a 500-
-- iteration safety valve so a malformed custom_rule can't runaway-generate
-- rows; called after every create/edit and after every confirmation
-- (fn_confirm_recurring_occurrence below), plus swept nightly across all
-- users by fn_generate_recurring_occurrences_all as a safety net.
-- ----------------------------------------------------------------------------
create or replace function public.fn_generate_recurring_occurrences(p_recurring_item_id bigint)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item public.recurring_items;
  v_last_date date;
  v_next date;
  v_horizon date := current_date + 90;
  v_period_label text;
  v_occ_count int;
  v_inserted int := 0;
  v_iterations int := 0;
  v_row_count int;
  v_open_pause_id bigint;
begin
  select * into v_item from public.recurring_items where id = p_recurring_item_id;
  if v_item.id is null then
    raise exception 'Recurring item % not found or not accessible', p_recurring_item_id;
  end if;
  if v_item.status <> 'ACTIVE' then
    return 0;
  end if;

  select max(scheduled_date) into v_last_date
  from public.recurring_occurrences
  where recurring_item_id = p_recurring_item_id;

  if v_last_date is null then
    v_next := coalesce(v_item.first_due_date, v_item.start_date);
  else
    v_next := private.fn_recurring_next_date(v_item, v_last_date);
  end if;

  select count(*) into v_occ_count
  from public.recurring_occurrences
  where recurring_item_id = p_recurring_item_id;

  while v_next is not null and v_next <= v_horizon and v_iterations <= 500 loop
    exit when v_item.end_date is not null and v_next > v_item.end_date;
    exit when v_item.number_of_occurrences is not null and v_occ_count >= v_item.number_of_occurrences;

    select id into v_open_pause_id
    from public.recurring_pauses
    where recurring_item_id = p_recurring_item_id
      and paused_from <= v_next
      and (resumed_at is null or v_next < resumed_at)
    limit 1;

    if v_open_pause_id is null then
      v_period_label := case when v_item.frequency in ('Weekly', 'Biweekly')
        then to_char(v_next, 'DD Mon YYYY') else to_char(v_next, 'Mon YYYY') end;

      insert into public.recurring_occurrences
        (user_id, recurring_item_id, period_label, scheduled_date, due_date, expected_amount, status)
      values
        (v_item.user_id, v_item.id, v_period_label, v_next, v_next, v_item.expected_amount, 'UPCOMING')
      on conflict (recurring_item_id, scheduled_date) do nothing;

      get diagnostics v_row_count = row_count;
      if v_row_count > 0 then
        v_inserted := v_inserted + 1;
        v_occ_count := v_occ_count + 1;
      end if;
    end if;

    v_last_date := v_next;
    v_next := private.fn_recurring_next_date(v_item, v_last_date);
    v_iterations := v_iterations + 1;
  end loop;

  update public.recurring_items
  set next_due_date = (
    select min(scheduled_date) from public.recurring_occurrences
    where recurring_item_id = p_recurring_item_id and status in ('UPCOMING', 'DUE', 'OVERDUE')
  )
  where id = p_recurring_item_id;

  return v_inserted;
end;
$$;

grant execute on function public.fn_generate_recurring_occurrences(bigint) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_confirm_recurring_occurrence (Section 63 - the "Confirm & Save"
-- pipeline in one transaction). SECURITY INVOKER, same RLS-gated reasoning
-- as fn_record_payment. Partial payments (Section 65) reuse this same
-- function against the same occurrence row (status = 'PARTIALLY_PAID',
-- actual_amount < expected_amount) - a later top-up call updates that row
-- again rather than creating a duplicate. Skipping an occurrence (Section
-- 82) also goes through here with status = 'SKIPPED'.
-- ----------------------------------------------------------------------------
create or replace function public.fn_confirm_recurring_occurrence(
  p_occurrence_id bigint,
  p_actual_amount numeric,
  p_paid_date date,
  p_status text,
  p_payment_reference text default null,
  p_payment_method text default null,
  p_notes text default null,
  p_actual_units numeric default null,
  p_actual_nav numeric default null
)
returns public.recurring_occurrences
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_occ public.recurring_occurrences;
begin
  if p_status not in ('CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID', 'SKIPPED', 'FAILED') then
    raise exception 'Unsupported confirm status %', p_status;
  end if;

  update public.recurring_occurrences
  set actual_amount = p_actual_amount,
      paid_date = p_paid_date,
      status = p_status,
      payment_reference = p_payment_reference,
      payment_method = p_payment_method,
      notes = coalesce(p_notes, notes),
      actual_units = coalesce(p_actual_units, actual_units),
      actual_nav = coalesce(p_actual_nav, actual_nav),
      confirmation_method = 'Manual'
  where id = p_occurrence_id
  returning * into v_occ;

  if v_occ.id is null then
    raise exception 'Occurrence % not found or not accessible', p_occurrence_id;
  end if;

  if p_status <> 'SKIPPED' then
    update public.recurring_items
    set last_confirmed_date = p_paid_date
    where id = v_occ.recurring_item_id;
  end if;

  perform public.fn_generate_recurring_occurrences(v_occ.recurring_item_id);

  return v_occ;
end;
$$;

grant execute on function public.fn_confirm_recurring_occurrence(bigint, numeric, date, text, text, text, text, numeric, numeric) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_pause_recurring_item / fn_resume_recurring_item (Section 81). Pausing
-- also removes any already-generated future UPCOMING rows that now fall
-- inside the paused window, so a previously-generated row can't sit there
-- contradicting the pause. Resuming only ever walks forward from whatever
-- occurrence already exists - it never backfills the paused window (dates
-- inside an open pause are skipped, not inserted, by
-- fn_generate_recurring_occurrences above).
-- ----------------------------------------------------------------------------
create or replace function public.fn_pause_recurring_item(
  p_recurring_item_id bigint,
  p_paused_from date default current_date,
  p_reason text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  select user_id into v_user_id from public.recurring_items where id = p_recurring_item_id;
  if v_user_id is null then
    raise exception 'Recurring item % not found or not accessible', p_recurring_item_id;
  end if;

  insert into public.recurring_pauses (user_id, recurring_item_id, paused_from, reason)
  values (v_user_id, p_recurring_item_id, p_paused_from, p_reason);

  update public.recurring_items set status = 'PAUSED' where id = p_recurring_item_id;

  delete from public.recurring_occurrences
  where recurring_item_id = p_recurring_item_id
    and status = 'UPCOMING'
    and scheduled_date >= p_paused_from;
end;
$$;

grant execute on function public.fn_pause_recurring_item(bigint, date, text) to authenticated;

create or replace function public.fn_resume_recurring_item(
  p_recurring_item_id bigint,
  p_resume_date date default current_date
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.recurring_pauses
  set resumed_at = p_resume_date
  where recurring_item_id = p_recurring_item_id and resumed_at is null;

  update public.recurring_items
  set status = 'ACTIVE'
  where id = p_recurring_item_id;

  perform public.fn_generate_recurring_occurrences(p_recurring_item_id);
end;
$$;

grant execute on function public.fn_resume_recurring_item(bigint, date) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_refresh_recurring_statuses (Section 61 - status transitions). SECURITY
-- DEFINER, cron-only (same lockdown as fn_refresh_schedule_statuses). Only
-- ever moves UPCOMING -> DUE -> OVERDUE; never transitions anything to
-- CONFIRMED/PAID/INVESTED, enforcing Section 68 ("do not auto-confirm") at
-- the database level, not just in the UI.
-- ----------------------------------------------------------------------------
create or replace function public.fn_refresh_recurring_statuses()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.recurring_occurrences
  set status = 'DUE'
  where status = 'UPCOMING' and due_date <= current_date;

  with newly_overdue as (
    update public.recurring_occurrences
    set status = 'OVERDUE'
    where status = 'DUE' and due_date < current_date
    returning id, user_id, recurring_item_id, due_date, expected_amount
  )
  insert into public.notifications (user_id, recurring_item_id, recurring_occurrence_id, type, title, message, priority, dedupe_key)
  select no.user_id, no.recurring_item_id, no.id, 'Recurring Overdue',
    format('Overdue - %s', ri.item_name),
    format('%s expected on %s from %s has not been confirmed and is now overdue.',
           to_char(no.expected_amount, 'FM999,999,990.00'), no.due_date, ri.item_name),
    'High',
    'Recurring Overdue' || '|' || no.recurring_item_id::text || '|' || no.id::text || '|' || '' || '|' || current_date::text
  from newly_overdue no
  join public.recurring_items ri on ri.id = no.recurring_item_id
  on conflict (user_id, dedupe_key) do nothing;
end;
$$;

revoke execute on function public.fn_refresh_recurring_statuses() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- fn_generate_recurring_reminders (Sections 66, 67, 85). SECURITY DEFINER,
-- cron-only. Reads each item's OWN reminder_days_before/escalation_days
-- (Section 66's worked examples show different offsets per item type, e.g.
-- SIP 2 days before vs Credit Card 7/2/0) rather than a single global
-- preference. Escalation stops immediately once an occurrence is no longer
-- UPCOMING/DUE/OVERDUE (Section 85) since it simply drops out of every WHERE
-- clause here the moment it's confirmed.
-- ----------------------------------------------------------------------------
create or replace function public.fn_generate_recurring_reminders()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_offsets jsonb;
  v_offset int;
  v_row record;
  v_rows int;
  v_inserted int := 0;
begin
  for v_item in
    select id, user_id, item_name, reminder_enabled, reminder_days_before, overdue_reminder_enabled, escalation_days
    from public.recurring_items
    where status = 'ACTIVE'
  loop
    if v_item.reminder_enabled then
      v_offsets := coalesce(v_item.reminder_days_before, '[7,3,1,0]'::jsonb);
      for v_offset in select jsonb_array_elements_text(v_offsets)::int loop
        for v_row in
          select ro.id as occurrence_id, ro.due_date, ro.expected_amount
          from public.recurring_occurrences ro
          where ro.recurring_item_id = v_item.id
            and ro.status in ('UPCOMING', 'DUE')
            and ro.due_date = current_date + v_offset
        loop
          insert into public.notifications
            (user_id, recurring_item_id, recurring_occurrence_id, type, title, message, priority, dedupe_key)
          values (
            v_item.user_id, v_item.id, v_row.occurrence_id, 'Recurring Reminder',
            case when v_offset = 0 then format('Due today - %s', v_item.item_name)
                 else format('Due in %s day(s) - %s', v_offset, v_item.item_name) end,
            format('%s expected for %s on %s.', to_char(v_row.expected_amount, 'FM999,999,990.00'), v_item.item_name, v_row.due_date),
            case when v_offset <= 1 then 'High' else 'Medium' end,
            'Recurring Reminder' || '|' || v_item.id::text || '|' || v_row.occurrence_id::text || '|due' || v_offset::text || '|' || current_date::text
          )
          on conflict (user_id, dedupe_key) do nothing;
          get diagnostics v_rows = row_count;
          v_inserted := v_inserted + v_rows;
        end loop;
      end loop;
    end if;

    if v_item.overdue_reminder_enabled then
      v_offsets := coalesce(v_item.escalation_days, '[1,3,7]'::jsonb);
      for v_offset in select jsonb_array_elements_text(v_offsets)::int loop
        for v_row in
          select ro.id as occurrence_id, ro.due_date, ro.expected_amount
          from public.recurring_occurrences ro
          where ro.recurring_item_id = v_item.id
            and ro.status = 'OVERDUE'
            and ro.due_date = current_date - v_offset
        loop
          insert into public.notifications
            (user_id, recurring_item_id, recurring_occurrence_id, type, title, message, priority, dedupe_key)
          values (
            v_item.user_id, v_item.id, v_row.occurrence_id, 'Recurring Reminder',
            format('%s day(s) overdue - %s', v_offset, v_item.item_name),
            format('%s from %s was due on %s and is still not confirmed (%s day(s) overdue).',
                   to_char(v_row.expected_amount, 'FM999,999,990.00'), v_item.item_name, v_row.due_date, v_offset),
            'Urgent',
            'Recurring Reminder' || '|' || v_item.id::text || '|' || v_row.occurrence_id::text || '|overdue' || v_offset::text || '|' || current_date::text
          )
          on conflict (user_id, dedupe_key) do nothing;
          get diagnostics v_rows = row_count;
          v_inserted := v_inserted + v_rows;
        end loop;
      end loop;
    end if;
  end loop;

  return v_inserted;
end;
$$;

revoke execute on function public.fn_generate_recurring_reminders() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- fn_generate_recurring_occurrences_all - SECURITY DEFINER cron sweep across
-- every user's active items, a safety net alongside the on-create/
-- on-confirm calls (e.g. in case a browser session ends before the next
-- occurrence gets generated client-side).
-- ----------------------------------------------------------------------------
create or replace function public.fn_generate_recurring_occurrences_all()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_total int := 0;
begin
  for v_item in select id from public.recurring_items where status = 'ACTIVE' loop
    v_total := v_total + public.fn_generate_recurring_occurrences(v_item.id);
  end loop;
  return v_total;
end;
$$;

revoke execute on function public.fn_generate_recurring_occurrences_all() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Views (Sections 73-76, 79, 80) - both security_invoker so RLS on the
-- underlying tables still applies to whoever queries them, same as
-- v_deal_metrics/v_portfolio_summary in 008_views.sql.
-- ----------------------------------------------------------------------------
create or replace view public.v_recurring_summary
with (security_invoker = true)
as
with items as (
  select user_id, count(*) filter (where status = 'ACTIVE') as active_items_count
  from public.recurring_items
  group by user_id
),
occ as (
  select
    ri.user_id,
    sum(ro.expected_amount) filter (where date_trunc('month', ro.scheduled_date) = date_trunc('month', current_date)) as month_expected,
    sum(ro.actual_amount) filter (where date_trunc('month', ro.scheduled_date) = date_trunc('month', current_date)
      and ro.status in ('CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID')) as month_confirmed,
    count(*) filter (where date_trunc('month', ro.scheduled_date) = date_trunc('month', current_date)
      and ro.status = 'IN_PROGRESS') as month_in_progress_count,
    count(*) filter (where date_trunc('month', ro.scheduled_date) = date_trunc('month', current_date)
      and ro.status in ('UPCOMING', 'DUE')) as month_yet_to_confirm_count,
    count(*) filter (where date_trunc('month', ro.scheduled_date) = date_trunc('month', current_date)
      and ro.status = 'OVERDUE') as month_overdue_count,
    sum(ro.expected_amount) filter (where date_trunc('month', ro.scheduled_date) = date_trunc('month', current_date)
      and ro.status = 'OVERDUE') as month_overdue_amount,

    sum(ro.expected_amount) filter (where date_trunc('year', ro.scheduled_date) = date_trunc('year', current_date)) as year_expected,
    sum(ro.actual_amount) filter (where date_trunc('year', ro.scheduled_date) = date_trunc('year', current_date)
      and ro.status in ('CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID')) as year_confirmed,
    count(*) filter (where date_trunc('year', ro.scheduled_date) = date_trunc('year', current_date)
      and ro.status in ('UPCOMING', 'DUE')) as year_pending_count,
    count(*) filter (where date_trunc('year', ro.scheduled_date) = date_trunc('year', current_date)
      and ro.status = 'SKIPPED') as year_skipped_count,
    count(*) filter (where date_trunc('year', ro.scheduled_date) = date_trunc('year', current_date)
      and ro.status = 'OVERDUE') as year_overdue_count,

    sum(ro.expected_amount) filter (where ro.due_date between current_date and current_date + 7
      and ro.status in ('UPCOMING', 'DUE')) as next_7_days_amount,
    sum(ro.expected_amount) filter (where ro.due_date between current_date and current_date + 30
      and ro.status in ('UPCOMING', 'DUE')) as next_30_days_amount
  from public.recurring_items ri
  join public.recurring_occurrences ro on ro.recurring_item_id = ri.id
  group by ri.user_id
)
select
  coalesce(items.user_id, occ.user_id) as user_id,
  coalesce(items.active_items_count, 0) as active_items_count,
  occ.month_expected, occ.month_confirmed, occ.month_in_progress_count,
  occ.month_yet_to_confirm_count, occ.month_overdue_count, occ.month_overdue_amount,
  occ.year_expected, occ.year_confirmed, occ.year_pending_count,
  occ.year_skipped_count, occ.year_overdue_count,
  occ.next_7_days_amount, occ.next_30_days_amount
from items
full outer join occ on occ.user_id = items.user_id;

grant select on public.v_recurring_summary to authenticated;

-- v_recurring_consistency (Section 80) - one row per item. Skipped
-- occurrences are excluded from the consistency denominator, per the spec's
-- explicit rule that a skip is intentional and must not read as a failure.
create or replace view public.v_recurring_consistency
with (security_invoker = true)
as
select
  ri.id as recurring_item_id,
  ri.user_id,
  ri.item_name,
  count(ro.*) filter (where ro.status in ('CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID')) as confirmed_count,
  count(ro.*) filter (where ro.status = 'SKIPPED') as skipped_count,
  count(ro.*) filter (where ro.status in ('OVERDUE', 'FAILED')) as missed_count,
  case when count(ro.*) filter (where ro.status in ('CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID', 'OVERDUE', 'FAILED')) > 0
    then round(
      count(ro.*) filter (where ro.status in ('CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID'))::numeric
      / count(ro.*) filter (where ro.status in ('CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID', 'OVERDUE', 'FAILED')) * 100, 2)
  end as consistency_pct,
  round(avg(ro.paid_date - ro.due_date) filter (
    where ro.paid_date is not null and ro.status in ('CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID')
  ), 1) as avg_delay_days,
  sum(ro.expected_amount) as total_expected_amount,
  sum(ro.actual_amount) as total_actual_amount
from public.recurring_items ri
left join public.recurring_occurrences ro on ro.recurring_item_id = ri.id
group by ri.id, ri.user_id, ri.item_name;

grant select on public.v_recurring_consistency to authenticated;

-- ----------------------------------------------------------------------------
-- Admin automation button (admin.js's "Run Automation Now") now also covers
-- recurring items.
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
  return 'ok';
end;
$$;

-- ----------------------------------------------------------------------------
-- Cron: fold the recurring automation into the same 15-minute job rather
-- than adding a second cron job (unschedule-by-name/reschedule idiom, same
-- as 014's own extension of 010_cron.sql's original job).
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
  $$
);
