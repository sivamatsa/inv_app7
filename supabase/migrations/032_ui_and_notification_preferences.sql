-- ============================================================================
-- 032: Sidebar/dashboard UI preferences, per-notification-type delivery
-- preferences, and "clear my data"/"clear all portfolio data" functions.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ui_preferences - a single jsonb blob on profiles, same precedent as
-- analytics_consent/financial_year_start_month living directly on this table
-- rather than a new one, since this is one row per user with no independent
-- lifecycle. Shape: {sidebarOrder, sidebarHidden, sidebarCompact,
-- dashboardOrder, dashboardHidden} - all optional, absence means "default
-- order, nothing hidden, not compact" (today's actual behavior unchanged).
-- ----------------------------------------------------------------------------
alter table public.profiles add column if not exists ui_preferences jsonb;

-- ----------------------------------------------------------------------------
-- notification_type_preferences - per (user, notification type) delivery
-- toggles for In-app/Email/Push. Deliberately NOT pre-seeded for existing
-- users or the 29 current notifications.type values (031_expense_projects.sql
-- has the current full list) - absence of a row means every channel stays
-- enabled (today's real behavior), a row is written only the first time a
-- user actually flips a checkbox off. Every read is a left join with
-- coalesce(..., true), so this needs no backfill migration ever, including
-- for notification types added by a future addendum.
-- ----------------------------------------------------------------------------
create table if not exists public.notification_type_preferences (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  in_app boolean not null default true,
  email boolean not null default true,
  push boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (user_id, type)
);

create index if not exists notification_type_preferences_user_id_idx on public.notification_type_preferences (user_id);

alter table public.notification_type_preferences enable row level security;

drop policy if exists "own notification type prefs select" on public.notification_type_preferences;
create policy "own notification type prefs select"
  on public.notification_type_preferences for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own notification type prefs upsert" on public.notification_type_preferences;
create policy "own notification type prefs upsert"
  on public.notification_type_preferences for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "own notification type prefs update" on public.notification_type_preferences;
create policy "own notification type prefs update"
  on public.notification_type_preferences for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update on public.notification_type_preferences to authenticated;
grant usage, select on sequence public.notification_type_preferences_id_seq to authenticated;

-- ----------------------------------------------------------------------------
-- fn_clear_my_data() - wipes the CALLING user's own rows across every
-- strictly personal/portfolio table, keeping their auth account, profile,
-- and all settings/preferences rows intact. Deliberately excludes anything
-- shared/multi-party (community_messages, blog_posts/comments,
-- support_tickets/ticket_messages, chat conversations/messages,
-- shared_portfolios/portfolio_members) even though some of those carry the
-- caller's user_id - deleting a conversation another member is still
-- reading, or a shared portfolio a Viewer still has open, would be a
-- correctness bug, not a feature (see the plan's own scope decision #2).
-- SECURITY INVOKER (not DEFINER) so RLS still double-checks every delete as
-- a second, independent guard beyond the auth.uid() scoping below.
--
-- payments is deleted before deals deliberately: payments.deal_id is the one
-- non-cascading FK in this whole schema (`on delete restrict`,
-- 004_payment_engine.sql - by design, so a deal with real payment history
-- can't be deleted as a side effect of anything). Everything else here is
-- `on delete cascade`/`on delete set null` from its parent, confirmed by a
-- full grep of every migration's `references` clause, so no other explicit
-- ordering is required.
-- ----------------------------------------------------------------------------
create or replace function public.fn_clear_my_data()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated.';
  end if;

  delete from public.payments where user_id = v_uid;
  delete from public.payment_matches where user_id = v_uid;
  delete from public.bank_transactions where user_id = v_uid;
  delete from public.reinvestments where user_id = v_uid;
  delete from public.deals where user_id = v_uid;
  delete from public.platforms where user_id = v_uid;

  -- cascades recurring_occurrences/recurring_amount_history/
  -- recurring_schedule_history/recurring_pauses
  delete from public.recurring_items where user_id = v_uid;

  delete from public.gold_purchases where user_id = v_uid;
  delete from public.gold_alerts where user_id = v_uid;

  -- cascades expense_categories/expense_transactions/expense_advances/
  -- expense_recurring_templates/expense_project_custom_fields (and those in
  -- turn cascade expense_transaction_custom_values)
  delete from public.expense_projects where user_id = v_uid;
  delete from public.expense_vendors where user_id = v_uid;

  -- cascades contact_phones/contact_emails/contact_addresses/
  -- contact_important_dates/contact_notes/contact_reminders/
  -- contact_group_members
  delete from public.contacts where owner_user_id = v_uid;
  delete from public.contact_groups where user_id = v_uid;

  delete from public.portfolio_goals where user_id = v_uid;
  delete from public.cash_transactions where user_id = v_uid;
  delete from public.tax_records where user_id = v_uid;
  delete from public.notes where user_id = v_uid;
  delete from public.documents where user_id = v_uid;
  delete from public.imports where user_id = v_uid;
  delete from public.calendar_events where user_id = v_uid;
  delete from public.notifications where user_id = v_uid;
  delete from public.audit_logs where user_id = v_uid;
  delete from public.ai_insights where user_id = v_uid;
  delete from public.scenario_simulations where user_id = v_uid;
  delete from public.integration_configs where user_id = v_uid;
end;
$$;

revoke execute on function public.fn_clear_my_data() from public, anon;
grant execute on function public.fn_clear_my_data() to authenticated;

-- ----------------------------------------------------------------------------
-- fn_admin_clear_all_data() - the same table list, with no user_id filter at
-- all (every user's data, symmetrically) - admin-only, SECURITY DEFINER so it
-- can act across every user's rows regardless of RLS. Deliberately does NOT
-- touch auth.users/profiles - this clears portfolio content, it does not
-- delete accounts (a separate, already-existing action in
-- admin-user-management's own `delete` action).
-- ----------------------------------------------------------------------------
create or replace function public.fn_admin_clear_all_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only an admin can run this.';
  end if;

  delete from public.payments;
  delete from public.payment_matches;
  delete from public.bank_transactions;
  delete from public.reinvestments;
  delete from public.deals;
  delete from public.platforms;
  delete from public.recurring_items;
  delete from public.gold_purchases;
  delete from public.gold_alerts;
  delete from public.expense_projects;
  delete from public.expense_vendors;
  delete from public.contacts;
  delete from public.contact_groups;
  delete from public.portfolio_goals;
  delete from public.cash_transactions;
  delete from public.tax_records;
  delete from public.notes;
  delete from public.documents;
  delete from public.imports;
  delete from public.calendar_events;
  delete from public.notifications;
  delete from public.audit_logs;
  delete from public.ai_insights;
  delete from public.scenario_simulations;
  delete from public.integration_configs;
end;
$$;

revoke execute on function public.fn_admin_clear_all_data() from public, anon;
grant execute on function public.fn_admin_clear_all_data() to authenticated;
