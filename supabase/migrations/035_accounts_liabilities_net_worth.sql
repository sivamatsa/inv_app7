-- ============================================================================
-- 035: Accounts & Liabilities, and Net Worth - the first two items of the
--      user's own ordered wishlist, built together since Net Worth is mostly
--      aggregation over Accounts & Liabilities data. See the plan file's own
--      scope decisions for what this deliberately does NOT do: no bank feed/
--      auto-reconciliation (every balance is manually entered, same honesty
--      pattern as gold/FX/FD reference rates elsewhere in this app), no
--      re-tracking of Deals/Gold as "Accounts" (Net Worth pulls those in
--      directly, computed client-side - see netWorth.js), and Liabilities is
--      an outstanding-balance figure, a different concept from the Recurring
--      Investments module's own 'Credit Card' bill-payment tracking (never
--      merged with it).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- accounts - Bank/Cash/Wallet/Investment-Account balances only. Same
-- three-way RLS shape (owner/admin/Viewer) as deals/gold_purchases/
-- expense_projects, per the plan's scope decision #6.
-- ----------------------------------------------------------------------------
create table if not exists public.accounts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  account_name text not null,
  account_type text not null check (account_type in ('Bank', 'Cash', 'Wallet', 'Investment Account', 'Other')),
  institution text,
  account_number_masked text,
  currency text not null default 'INR',
  opening_balance numeric not null default 0,
  current_balance numeric not null default 0,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists accounts_user_id_idx on public.accounts (user_id);

alter table public.accounts enable row level security;

drop policy if exists "select own accounts" on public.accounts;
create policy "select own accounts"
  on public.accounts for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "insert own accounts" on public.accounts;
create policy "insert own accounts"
  on public.accounts for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own accounts" on public.accounts;
create policy "update own accounts"
  on public.accounts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own accounts" on public.accounts;
create policy "delete own accounts"
  on public.accounts for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_accounts_updated_at on public.accounts;
create trigger set_accounts_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

drop trigger if exists audit_accounts on public.accounts;
create trigger audit_accounts
  after insert or update or delete on public.accounts
  for each row execute function public.audit_row_change();

grant select, insert, update, delete on public.accounts to authenticated;
grant usage, select on sequence public.accounts_id_seq to authenticated;

-- ----------------------------------------------------------------------------
-- liabilities - Credit Card/Personal Loan/Home Loan/Vehicle Loan/Other Loan
-- outstanding balances. Deliberately not a payment-reminder engine - see the
-- plan's scope decision #2 for why this is distinct from Recurring
-- Investments' own 'Credit Card' bill-tracking item type.
-- ----------------------------------------------------------------------------
create table if not exists public.liabilities (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  liability_name text not null,
  liability_type text not null check (liability_type in ('Credit Card', 'Personal Loan', 'Home Loan', 'Vehicle Loan', 'Other Loan')),
  lender text,
  principal_amount numeric,
  outstanding_amount numeric not null default 0,
  interest_rate numeric,
  emi_amount numeric,
  start_date date,
  end_date date,
  next_payment_date date,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists liabilities_user_id_idx on public.liabilities (user_id);

alter table public.liabilities enable row level security;

drop policy if exists "select own liabilities" on public.liabilities;
create policy "select own liabilities"
  on public.liabilities for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "insert own liabilities" on public.liabilities;
create policy "insert own liabilities"
  on public.liabilities for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own liabilities" on public.liabilities;
create policy "update own liabilities"
  on public.liabilities for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own liabilities" on public.liabilities;
create policy "delete own liabilities"
  on public.liabilities for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_liabilities_updated_at on public.liabilities;
create trigger set_liabilities_updated_at
  before update on public.liabilities
  for each row execute function public.set_updated_at();

drop trigger if exists audit_liabilities on public.liabilities;
create trigger audit_liabilities
  after insert or update or delete on public.liabilities
  for each row execute function public.audit_row_change();

grant select, insert, update, delete on public.liabilities to authenticated;
grant usage, select on sequence public.liabilities_id_seq to authenticated;

-- ----------------------------------------------------------------------------
-- net_worth_snapshots - one row per (user, day), written client-side (no
-- server-side price lookup, no pg_cron) - see the plan's scope decision #5.
-- SELECT is the three-way shape; INSERT/UPDATE/DELETE are owner-only since
-- nothing but the owning client ever writes these.
-- ----------------------------------------------------------------------------
create table if not exists public.net_worth_snapshots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_date date not null,
  total_assets numeric not null,
  total_liabilities numeric not null,
  net_worth numeric not null,
  breakdown jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, snapshot_date)
);

create index if not exists net_worth_snapshots_user_id_idx on public.net_worth_snapshots (user_id);

alter table public.net_worth_snapshots enable row level security;

drop policy if exists "select own net_worth_snapshots" on public.net_worth_snapshots;
create policy "select own net_worth_snapshots"
  on public.net_worth_snapshots for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "insert own net_worth_snapshots" on public.net_worth_snapshots;
create policy "insert own net_worth_snapshots"
  on public.net_worth_snapshots for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own net_worth_snapshots" on public.net_worth_snapshots;
create policy "update own net_worth_snapshots"
  on public.net_worth_snapshots for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own net_worth_snapshots" on public.net_worth_snapshots;
create policy "delete own net_worth_snapshots"
  on public.net_worth_snapshots for delete to authenticated
  using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.net_worth_snapshots to authenticated;
grant usage, select on sequence public.net_worth_snapshots_id_seq to authenticated;

-- ----------------------------------------------------------------------------
-- Extend fn_clear_my_data() / fn_admin_clear_all_data() (032) to cover the
-- three new tables - this app treats "forgot to add a new portfolio table to
-- the clear-data functions" as a mandatory pre-ship check now (see the plan's
-- scope decision #6), not a follow-up fix.
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

  delete from public.recurring_items where user_id = v_uid;

  delete from public.gold_purchases where user_id = v_uid;
  delete from public.gold_alerts where user_id = v_uid;

  delete from public.expense_projects where user_id = v_uid;
  delete from public.expense_vendors where user_id = v_uid;

  delete from public.contacts where owner_user_id = v_uid;
  delete from public.contact_groups where user_id = v_uid;

  delete from public.accounts where user_id = v_uid;
  delete from public.liabilities where user_id = v_uid;
  delete from public.net_worth_snapshots where user_id = v_uid;

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
  delete from public.accounts;
  delete from public.liabilities;
  delete from public.net_worth_snapshots;
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
