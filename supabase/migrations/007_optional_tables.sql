-- ============================================================================
-- 007: optional tables (spec Section 39 "Optional" + goals/idle-cash from
--      Sections 32, 35) - built now since the agreed scope is the full spec.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- portfolio_goals (spec Section 32). Multiple rows per user are allowed
-- (e.g. one per year) rather than a single overwritten row, so past goals
-- stay visible; `is_active` marks the one currently shown on the dashboard.
-- ----------------------------------------------------------------------------
create table if not exists public.portfolio_goals (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null default 'My Goals',
  target_annual_income numeric(14, 2),
  target_portfolio_size numeric(14, 2),
  target_monthly_passive_income numeric(14, 2),
  target_roi numeric(9, 4),
  target_reinvestment_ratio numeric(9, 4),
  -- Section 35's "target investment" (idle-cash tracker) lives here too -
  -- it's the same kind of user-set target as the other goal fields.
  target_cash_deployment numeric(14, 2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists portfolio_goals_user_id_idx on public.portfolio_goals (user_id);

alter table public.portfolio_goals enable row level security;

drop policy if exists "select own portfolio_goals" on public.portfolio_goals;
create policy "select own portfolio_goals"
  on public.portfolio_goals for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own portfolio_goals" on public.portfolio_goals;
create policy "insert own portfolio_goals"
  on public.portfolio_goals for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own portfolio_goals" on public.portfolio_goals;
create policy "update own portfolio_goals"
  on public.portfolio_goals for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own portfolio_goals" on public.portfolio_goals;
create policy "delete own portfolio_goals"
  on public.portfolio_goals for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_portfolio_goals_updated_at on public.portfolio_goals;
create trigger set_portfolio_goals_updated_at
  before update on public.portfolio_goals
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- cash_transactions (spec Section 35). A transaction log, not stored
-- balances: cash_balance/available_balance/reserved_balance/idle_days are
-- derived in v_idle_cash (008_views.sql) from the SUM of these rows, the
-- same "derive, don't duplicate" approach used for deal financials.
-- ----------------------------------------------------------------------------
create table if not exists public.cash_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_date date not null,
  transaction_type text not null
    check (transaction_type in ('Deposit', 'Withdrawal', 'Reserved', 'Released', 'Interest Credit', 'Other')),
  amount numeric(14, 2) not null,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists cash_transactions_user_id_idx on public.cash_transactions (user_id);
create index if not exists cash_transactions_date_idx on public.cash_transactions (transaction_date);

alter table public.cash_transactions enable row level security;

drop policy if exists "select own cash_transactions" on public.cash_transactions;
create policy "select own cash_transactions"
  on public.cash_transactions for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own cash_transactions" on public.cash_transactions;
create policy "insert own cash_transactions"
  on public.cash_transactions for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own cash_transactions" on public.cash_transactions;
create policy "update own cash_transactions"
  on public.cash_transactions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own cash_transactions" on public.cash_transactions;
create policy "delete own cash_transactions"
  on public.cash_transactions for delete to authenticated
  using (user_id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- bank_transactions + payment_matches (spec Sections 23, 24)
-- ----------------------------------------------------------------------------
create table if not exists public.bank_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_date date not null,
  amount numeric(14, 2) not null,
  description text,
  reference text,
  import_id bigint references public.imports(id) on delete set null,
  matched boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists bank_transactions_user_id_idx on public.bank_transactions (user_id);
create index if not exists bank_transactions_date_idx on public.bank_transactions (transaction_date);
create index if not exists bank_transactions_matched_idx on public.bank_transactions (matched);

alter table public.bank_transactions enable row level security;

drop policy if exists "select own bank_transactions" on public.bank_transactions;
create policy "select own bank_transactions"
  on public.bank_transactions for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own bank_transactions" on public.bank_transactions;
create policy "insert own bank_transactions"
  on public.bank_transactions for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own bank_transactions" on public.bank_transactions;
create policy "update own bank_transactions"
  on public.bank_transactions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own bank_transactions" on public.bank_transactions;
create policy "delete own bank_transactions"
  on public.bank_transactions for delete to authenticated
  using (user_id = (select auth.uid()));

create table if not exists public.payment_matches (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  bank_transaction_id bigint not null references public.bank_transactions(id) on delete cascade,
  deal_id bigint references public.deals(id) on delete set null,
  payment_id bigint references public.payments(id) on delete set null,
  match_percentage numeric(5, 2) check (match_percentage between 0 and 100),
  status text not null default 'Suggested'
    check (status in ('Suggested', 'Confirmed', 'Rejected', 'Split', 'Unidentified')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_matches_user_id_idx on public.payment_matches (user_id);
create index if not exists payment_matches_bank_transaction_id_idx on public.payment_matches (bank_transaction_id);
create index if not exists payment_matches_deal_id_idx on public.payment_matches (deal_id);

alter table public.payment_matches enable row level security;

drop policy if exists "select own payment_matches" on public.payment_matches;
create policy "select own payment_matches"
  on public.payment_matches for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own payment_matches" on public.payment_matches;
create policy "insert own payment_matches"
  on public.payment_matches for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own payment_matches" on public.payment_matches;
create policy "update own payment_matches"
  on public.payment_matches for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own payment_matches" on public.payment_matches;
create policy "delete own payment_matches"
  on public.payment_matches for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_payment_matches_updated_at on public.payment_matches;
create trigger set_payment_matches_updated_at
  before update on public.payment_matches
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- shared_portfolios + portfolio_members (spec Section 2 "Admin/Family/Friend
-- Portfolio Management"; Section 3 explicitly hedges this as "may be added
-- later"). Scope note: this pass creates the tables so the feature has a
-- home, but does NOT retrofit every other table's RLS policy with a
-- membership OR-clause - deals/payments/etc. remain strictly single-owner.
-- Wiring real cross-user read access through is a deliberately separate,
-- larger change (touches every core table's policies) - see README.
-- ----------------------------------------------------------------------------
-- Both tables are created first, before either one's RLS policies - the
-- shared_portfolios SELECT policy below references portfolio_members in a
-- subquery, and CREATE POLICY validates that referenced relations already
-- exist, so portfolio_members must exist before that policy is created
-- (not just before it's used).
create table if not exists public.shared_portfolios (
  id bigint generated always as identity primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create index if not exists shared_portfolios_owner_user_id_idx on public.shared_portfolios (owner_user_id);

create table if not exists public.portfolio_members (
  id bigint generated always as identity primary key,
  portfolio_id bigint not null references public.shared_portfolios(id) on delete cascade,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'Viewer' check (role in ('Owner', 'Editor', 'Viewer')),
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (portfolio_id, member_user_id)
);

create index if not exists portfolio_members_portfolio_id_idx on public.portfolio_members (portfolio_id);
create index if not exists portfolio_members_member_user_id_idx on public.portfolio_members (member_user_id);

alter table public.shared_portfolios enable row level security;

drop policy if exists "select owned or member portfolios" on public.shared_portfolios;
create policy "select owned or member portfolios"
  on public.shared_portfolios for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    or id in (select portfolio_id from public.portfolio_members where member_user_id = (select auth.uid()))
  );

drop policy if exists "insert own shared_portfolios" on public.shared_portfolios;
create policy "insert own shared_portfolios"
  on public.shared_portfolios for insert to authenticated
  with check (owner_user_id = (select auth.uid()));

drop policy if exists "update own shared_portfolios" on public.shared_portfolios;
create policy "update own shared_portfolios"
  on public.shared_portfolios for update to authenticated
  using (owner_user_id = (select auth.uid())) with check (owner_user_id = (select auth.uid()));

drop policy if exists "delete own shared_portfolios" on public.shared_portfolios;
create policy "delete own shared_portfolios"
  on public.shared_portfolios for delete to authenticated
  using (owner_user_id = (select auth.uid()));

alter table public.portfolio_members enable row level security;

drop policy if exists "select own membership or as owner" on public.portfolio_members;
create policy "select own membership or as owner"
  on public.portfolio_members for select to authenticated
  using (
    member_user_id = (select auth.uid())
    or portfolio_id in (select id from public.shared_portfolios where owner_user_id = (select auth.uid()))
  );

drop policy if exists "owner manages membership" on public.portfolio_members;
create policy "owner manages membership"
  on public.portfolio_members for all to authenticated
  using (portfolio_id in (select id from public.shared_portfolios where owner_user_id = (select auth.uid())))
  with check (portfolio_id in (select id from public.shared_portfolios where owner_user_id = (select auth.uid())));

-- ----------------------------------------------------------------------------
-- tax_records (spec Section 28)
-- ----------------------------------------------------------------------------
create table if not exists public.tax_records (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  deal_id bigint references public.deals(id) on delete set null,
  financial_year text not null,
  gross_interest numeric(14, 2) not null default 0,
  tax_deducted numeric(14, 2) not null default 0,
  tds numeric(14, 2) not null default 0,
  net_interest numeric(14, 2),
  tax_document_id bigint references public.documents(id) on delete set null,
  tax_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tax_records_user_id_idx on public.tax_records (user_id);
create index if not exists tax_records_deal_id_idx on public.tax_records (deal_id);
create index if not exists tax_records_financial_year_idx on public.tax_records (financial_year);

alter table public.tax_records enable row level security;

drop policy if exists "select own tax_records" on public.tax_records;
create policy "select own tax_records"
  on public.tax_records for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own tax_records" on public.tax_records;
create policy "insert own tax_records"
  on public.tax_records for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own tax_records" on public.tax_records;
create policy "update own tax_records"
  on public.tax_records for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own tax_records" on public.tax_records;
create policy "delete own tax_records"
  on public.tax_records for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_tax_records_updated_at on public.tax_records;
create trigger set_tax_records_updated_at
  before update on public.tax_records
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- ai_insights (spec Section 37) - populated by the deterministic generator
-- in 009_functions.sql, not a live LLM call. See README for why.
-- ----------------------------------------------------------------------------
create table if not exists public.ai_insights (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  insight_text text not null,
  supporting_record_ids jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now(),
  is_dismissed boolean not null default false
);

create index if not exists ai_insights_user_id_idx on public.ai_insights (user_id);

alter table public.ai_insights enable row level security;

drop policy if exists "select own ai_insights" on public.ai_insights;
create policy "select own ai_insights"
  on public.ai_insights for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "update own ai_insights" on public.ai_insights;
create policy "update own ai_insights"
  on public.ai_insights for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- No insert/delete policy for regular users: rows are only ever written by
-- the SECURITY DEFINER generator function in 009_functions.sql. Users may
-- still UPDATE (to set is_dismissed).

-- ----------------------------------------------------------------------------
-- scenario_simulations (spec Section 33 what-if simulator)
-- ----------------------------------------------------------------------------
create table if not exists public.scenario_simulations (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  scenario_name text not null,
  scenario_type text not null,
  inputs jsonb not null default '{}'::jsonb,
  outputs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists scenario_simulations_user_id_idx on public.scenario_simulations (user_id);

alter table public.scenario_simulations enable row level security;

drop policy if exists "select own scenario_simulations" on public.scenario_simulations;
create policy "select own scenario_simulations"
  on public.scenario_simulations for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own scenario_simulations" on public.scenario_simulations;
create policy "insert own scenario_simulations"
  on public.scenario_simulations for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own scenario_simulations" on public.scenario_simulations;
create policy "delete own scenario_simulations"
  on public.scenario_simulations for delete to authenticated
  using (user_id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- integration_configs - not a named spec table, added to give Section 50's
-- "design interfaces for future integrations" a concrete home: one row per
-- integration type per user, always starting 'Not Connected'.
-- ----------------------------------------------------------------------------
create table if not exists public.integration_configs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  integration_type text not null
    check (integration_type in ('Lender/Platform API', 'Bank Statement Import', 'Open Banking',
                                 'Email Statement Parsing', 'SMS Transaction Parsing', 'Telegram',
                                 'WhatsApp', 'Push Notifications', 'Google Calendar', 'Email',
                                 'Accounting/Tax Software')),
  status text not null default 'Not Connected' check (status in ('Not Connected', 'Connected', 'Error')),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, integration_type)
);

create index if not exists integration_configs_user_id_idx on public.integration_configs (user_id);

alter table public.integration_configs enable row level security;

drop policy if exists "select own integration_configs" on public.integration_configs;
create policy "select own integration_configs"
  on public.integration_configs for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own integration_configs" on public.integration_configs;
create policy "insert own integration_configs"
  on public.integration_configs for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own integration_configs" on public.integration_configs;
create policy "update own integration_configs"
  on public.integration_configs for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own integration_configs" on public.integration_configs;
create policy "delete own integration_configs"
  on public.integration_configs for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_integration_configs_updated_at on public.integration_configs;
create trigger set_integration_configs_updated_at
  before update on public.integration_configs
  for each row execute function public.set_updated_at();
