-- ============================================================================
-- 037: Automation Center - a user-configurable IF-condition-THEN-notify rules
--      engine, deliberately NOTIFY-ONLY (never mutates a deal, recurring item,
--      or any other row unsupervised - an explicit user decision, not a
--      technical limitation). Mirrors fn_generate_gold_alerts()'s own exact
--      shape (019_gold_intelligence.sql) - a fixed catalog of rule types,
--      each with its own hand-written evaluation branch, rather than a
--      generic dynamic-SQL query builder (a real injection-surface risk this
--      app has never taken on anywhere else).
--
--      Six rule types this pass, each backed by data already queryable in
--      plain SQL - either letting a user override an otherwise-hardcoded
--      threshold (EXPENSE_BUDGET_PCT replaces the fixed 90%/100% in
--      fn_generate_expense_budget_alerts), or watching data nothing
--      currently monitors at all (Accounts, Liabilities, Net Worth trend).
--      Cash Flow and gold-allocation-% rules are deliberately NOT included -
--      Cash Flow has no persisted server-side data at all (computed entirely
--      client-side in cashFlow.js), and a gold-allocation-% rule would need
--      porting the client-side gold-value formula into SQL, a real
--      duplication-of-logic risk - both stated plainly as scope cuts, not
--      oversights.
-- ============================================================================

create table if not exists public.automation_rules (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_type text not null check (rule_type in (
    'EXPENSE_BUDGET_PCT', 'DEAL_RELIABILITY_BELOW', 'RECURRING_CONSISTENCY_BELOW',
    'ACCOUNT_BALANCE_BELOW', 'LIABILITY_OUTSTANDING_ABOVE', 'NET_WORTH_CHANGE_PCT'
  )),
  name text not null,
  -- Meaning depends on rule_type: expense_projects.id / accounts.id /
  -- liabilities.id for the three types that support scoping to one row;
  -- always null (meaning "any") for the other three.
  target_id bigint,
  threshold_value numeric not null,
  -- Only meaningful for NET_WORTH_CHANGE_PCT - how many days back to compare
  -- the latest net_worth_snapshots row against.
  lookback_days int,
  is_active boolean not null default true,
  last_triggered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists automation_rules_user_id_idx on public.automation_rules (user_id);

alter table public.automation_rules enable row level security;

-- Owner-only, no admin/Viewer bypass - a user's own alert configuration
-- isn't portfolio data anyone else has a reason to see, same category as
-- notification_preferences.
drop policy if exists "select own automation_rules" on public.automation_rules;
create policy "select own automation_rules"
  on public.automation_rules for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own automation_rules" on public.automation_rules;
create policy "insert own automation_rules"
  on public.automation_rules for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own automation_rules" on public.automation_rules;
create policy "update own automation_rules"
  on public.automation_rules for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own automation_rules" on public.automation_rules;
create policy "delete own automation_rules"
  on public.automation_rules for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_automation_rules_updated_at on public.automation_rules;
create trigger set_automation_rules_updated_at
  before update on public.automation_rules
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on public.automation_rules to authenticated;
grant usage, select on sequence public.automation_rules_id_seq to authenticated;

-- ----------------------------------------------------------------------------
-- notifications.type - full drop/re-add, same convention every prior
-- migration touching this constraint has used (034_help_support_suggestions.sql
-- is the previous authoritative version). One new value: 'Automation Rule
-- Triggered'.
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
                   'Calendar Reminder', 'Expense Budget Warning', 'Expense Budget Exceeded',
                   'Account Creation Request', 'Password Assistance Requested', 'Security Report Filed',
                   'Ticket Assigned', 'New Feature Suggestion', 'Suggestion Status Changed',
                   'Automation Rule Triggered'));

-- ----------------------------------------------------------------------------
-- fn_evaluate_automation_rules() - cron-checked, folded into the existing
-- 15-minute automation job below. Loops each active automation_rules row,
-- branches on rule_type with one hand-written query per type (exactly
-- fn_generate_gold_alerts()'s own shape), uses the same dedupe_key
-- idempotency convention every other generator in this app already uses
-- (type|entity|sub-entity|variant|current_date, on conflict do nothing).
-- ----------------------------------------------------------------------------
create or replace function public.fn_evaluate_automation_rules()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule record;
  v_row record;
  v_fired_this_rule boolean;
  v_inserted int := 0;
  v_rows int;
  v_latest_nw record;
  v_past_nw record;
  v_pct numeric;
begin
  for v_rule in select * from public.automation_rules where is_active loop
    v_fired_this_rule := false;

    if v_rule.rule_type = 'EXPENSE_BUDGET_PCT' then
      for v_row in
        select * from public.v_expense_category_summary
        where user_id = v_rule.user_id
          and pct_used is not null and pct_used >= v_rule.threshold_value
          and (v_rule.target_id is null or project_id = v_rule.target_id)
      loop
        insert into public.notifications (user_id, type, title, message, priority, dedupe_key)
        values (
          v_rule.user_id, 'Automation Rule Triggered',
          format('Budget alert - %s', v_row.name),
          format('"%s" has used %s%% of its budget - your Automation Center rule "%s" alerts at %s%%.', v_row.name, v_row.pct_used, v_rule.name, v_rule.threshold_value),
          'Medium',
          'Automation Rule' || '|' || v_rule.id::text || '|' || v_row.category_id::text || '|' || '' || '|' || current_date::text
        )
        on conflict (user_id, dedupe_key) do nothing;
        get diagnostics v_rows = row_count;
        if v_rows > 0 then v_inserted := v_inserted + v_rows; v_fired_this_rule := true; end if;
      end loop;

    elsif v_rule.rule_type = 'DEAL_RELIABILITY_BELOW' then
      for v_row in
        select * from public.v_deal_metrics
        where user_id = v_rule.user_id
          and payout_reliability is not null and payout_reliability < v_rule.threshold_value
      loop
        insert into public.notifications (user_id, type, title, message, priority, dedupe_key)
        values (
          v_rule.user_id, 'Automation Rule Triggered',
          'Deal payout reliability dropped',
          format('A deal''s payout reliability is now %s%% - your Automation Center rule "%s" alerts below %s%%.', v_row.payout_reliability, v_rule.name, v_rule.threshold_value),
          'Medium',
          'Automation Rule' || '|' || v_rule.id::text || '|' || v_row.deal_id::text || '|' || '' || '|' || current_date::text
        )
        on conflict (user_id, dedupe_key) do nothing;
        get diagnostics v_rows = row_count;
        if v_rows > 0 then v_inserted := v_inserted + v_rows; v_fired_this_rule := true; end if;
      end loop;

    elsif v_rule.rule_type = 'RECURRING_CONSISTENCY_BELOW' then
      for v_row in
        select * from public.v_recurring_consistency
        where user_id = v_rule.user_id
          and consistency_pct is not null and consistency_pct < v_rule.threshold_value
      loop
        insert into public.notifications (user_id, type, title, message, priority, dedupe_key)
        values (
          v_rule.user_id, 'Automation Rule Triggered',
          format('Recurring consistency dropped - %s', v_row.item_name),
          format('"%s" is now %s%% consistent - your Automation Center rule "%s" alerts below %s%%.', v_row.item_name, v_row.consistency_pct, v_rule.name, v_rule.threshold_value),
          'Medium',
          'Automation Rule' || '|' || v_rule.id::text || '|' || v_row.recurring_item_id::text || '|' || '' || '|' || current_date::text
        )
        on conflict (user_id, dedupe_key) do nothing;
        get diagnostics v_rows = row_count;
        if v_rows > 0 then v_inserted := v_inserted + v_rows; v_fired_this_rule := true; end if;
      end loop;

    elsif v_rule.rule_type = 'ACCOUNT_BALANCE_BELOW' then
      for v_row in
        select * from public.accounts
        where user_id = v_rule.user_id and is_active
          and current_balance < v_rule.threshold_value
          and (v_rule.target_id is null or id = v_rule.target_id)
      loop
        insert into public.notifications (user_id, type, title, message, priority, dedupe_key)
        values (
          v_rule.user_id, 'Automation Rule Triggered',
          format('Low balance - %s', v_row.account_name),
          format('"%s" is now at %s - your Automation Center rule "%s" alerts below %s.', v_row.account_name, v_row.current_balance, v_rule.name, v_rule.threshold_value),
          'Medium',
          'Automation Rule' || '|' || v_rule.id::text || '|' || v_row.id::text || '|' || '' || '|' || current_date::text
        )
        on conflict (user_id, dedupe_key) do nothing;
        get diagnostics v_rows = row_count;
        if v_rows > 0 then v_inserted := v_inserted + v_rows; v_fired_this_rule := true; end if;
      end loop;

    elsif v_rule.rule_type = 'LIABILITY_OUTSTANDING_ABOVE' then
      for v_row in
        select * from public.liabilities
        where user_id = v_rule.user_id and is_active
          and outstanding_amount > v_rule.threshold_value
          and (v_rule.target_id is null or id = v_rule.target_id)
      loop
        insert into public.notifications (user_id, type, title, message, priority, dedupe_key)
        values (
          v_rule.user_id, 'Automation Rule Triggered',
          format('Liability rising - %s', v_row.liability_name),
          format('"%s" is now at %s outstanding - your Automation Center rule "%s" alerts above %s.', v_row.liability_name, v_row.outstanding_amount, v_rule.name, v_rule.threshold_value),
          'Medium',
          'Automation Rule' || '|' || v_rule.id::text || '|' || v_row.id::text || '|' || '' || '|' || current_date::text
        )
        on conflict (user_id, dedupe_key) do nothing;
        get diagnostics v_rows = row_count;
        if v_rows > 0 then v_inserted := v_inserted + v_rows; v_fired_this_rule := true; end if;
      end loop;

    elsif v_rule.rule_type = 'NET_WORTH_CHANGE_PCT' then
      select * into v_latest_nw from public.net_worth_snapshots
        where user_id = v_rule.user_id order by snapshot_date desc limit 1;
      if v_latest_nw.id is not null then
        select * into v_past_nw from public.net_worth_snapshots
          where user_id = v_rule.user_id
            and snapshot_date <= v_latest_nw.snapshot_date - coalesce(v_rule.lookback_days, 30)
          order by snapshot_date desc limit 1;
        if v_past_nw.id is not null and v_past_nw.net_worth <> 0 then
          v_pct := (v_latest_nw.net_worth - v_past_nw.net_worth) / abs(v_past_nw.net_worth) * 100;
          if v_pct <= v_rule.threshold_value then
            insert into public.notifications (user_id, type, title, message, priority, dedupe_key)
            values (
              v_rule.user_id, 'Automation Rule Triggered',
              'Net Worth change alert',
              format('Net Worth changed %s%% (from %s to %s) over the last ~%s days - your Automation Center rule "%s" alerts at %s%% or worse. Based on your saved Net Worth snapshots, only as fresh as your last visit to that page.',
                round(v_pct, 1), v_past_nw.net_worth, v_latest_nw.net_worth, coalesce(v_rule.lookback_days, 30), v_rule.name, v_rule.threshold_value),
              'High',
              'Automation Rule' || '|' || v_rule.id::text || '|' || '' || '|' || '' || '|' || current_date::text
            )
            on conflict (user_id, dedupe_key) do nothing;
            get diagnostics v_rows = row_count;
            if v_rows > 0 then v_inserted := v_inserted + v_rows; v_fired_this_rule := true; end if;
          end if;
        end if;
      end if;
    end if;

    if v_fired_this_rule then
      update public.automation_rules set last_triggered_at = now() where id = v_rule.id;
    end if;
  end loop;

  return v_inserted;
end;
$$;

revoke execute on function public.fn_evaluate_automation_rules() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Fold into the existing 15-minute job and fn_admin_run_automation(), same
-- unschedule-by-name/reschedule idiom every prior addendum has used.
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
  perform public.fn_generate_expense_budget_alerts();
  perform public.fn_evaluate_automation_rules();
  return 'ok';
end;
$$;

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
  select public.fn_generate_expense_budget_alerts();
  select public.fn_evaluate_automation_rules();
  $$
);
