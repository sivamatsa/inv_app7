-- ============================================================================
-- 003: profiles, platforms, deals
-- ============================================================================

-- Reusable updated_at maintenance, used by every table below that has the
-- column (and by later migrations too).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- profiles (spec Section 3)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  mobile text,
  city text,
  country text,
  preferred_currency text not null default 'INR',
  -- Indian financial year (1 Apr - 31 Mar) by default, spec Section 27; both
  -- configurable so a non-Indian FY (e.g. 1 Jan) can be set per user.
  financial_year_start_month int not null default 4 check (financial_year_start_month between 1 and 12),
  financial_year_start_day int not null default 1 check (financial_year_start_day between 1 and 31),
  timezone text not null default 'Asia/Kolkata',
  -- Default reminder offsets in days relative to a due date, spec Section 10:
  -- 7/3/1 days before, due today, 1/3/7/30 days overdue.
  default_reminder_days jsonb not null default '[-7,-3,-1,0,1,3,7,30]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "select own profile" on public.profiles;
create policy "select own profile"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile"
  on public.profiles for insert
  to authenticated
  with check (id = (select auth.uid()));

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row when a new Supabase Auth user is created, so the
-- app never has to special-case "no profile yet".
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- platforms (spec Section 20 Sheet 4: Platform Name, Account Reference,
-- Investment Type, Notes)
-- ----------------------------------------------------------------------------
create table if not exists public.platforms (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  account_reference text,
  investment_type text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create index if not exists platforms_user_id_idx on public.platforms (user_id);

alter table public.platforms enable row level security;

drop policy if exists "select own platforms" on public.platforms;
create policy "select own platforms"
  on public.platforms for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own platforms" on public.platforms;
create policy "insert own platforms"
  on public.platforms for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own platforms" on public.platforms;
create policy "update own platforms"
  on public.platforms for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own platforms" on public.platforms;
create policy "delete own platforms"
  on public.platforms for delete
  to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_platforms_updated_at on public.platforms;
create trigger set_platforms_updated_at
  before update on public.platforms
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- deals (spec Section 4 - the universal, multi-asset-class deal master)
-- ----------------------------------------------------------------------------
-- Field-naming note (principal_amount / invested_amount / original_principal
-- / current_principal all appear in the spec without a formula tying them
-- together): this schema treats `invested_amount` as the authoritative basis
-- for Section 5's "Outstanding = Invested Amount - Principal Received", and
-- `current_principal` as the live, trigger-maintained outstanding balance.
-- `principal_amount` and `original_principal` are historical/reference
-- snapshots the user can edit independently (e.g. a top-up) and default to
-- invested_amount at creation. The app's "internal_deal_id" is simply this
-- row's `id` - no separate generated code column.
create table if not exists public.deals (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,

  external_deal_id text,
  deal_name text not null,
  platform_id bigint references public.platforms(id) on delete set null,
  investment_type text not null,
  category text,
  sub_category text,
  account_reference text,
  source text not null default 'Manual' check (source in ('Manual', 'Excel Import', 'CSV Import', 'API')),

  principal_amount numeric(14, 2) not null check (principal_amount > 0),
  invested_amount numeric(14, 2) not null check (invested_amount > 0),
  current_principal numeric(14, 2) not null check (current_principal >= 0),
  original_principal numeric(14, 2) not null check (original_principal > 0),
  interest_rate numeric(9, 4),
  interest_rate_type text,
  annual_roi numeric(9, 4),
  monthly_roi numeric(9, 4),
  expected_total_interest numeric(14, 2),
  expected_total_return numeric(14, 2),
  fees numeric(14, 2) not null default 0 check (fees >= 0),
  tax_withheld numeric(14, 2) not null default 0 check (tax_withheld >= 0),
  net_expected_return numeric(14, 2),

  investment_date date,
  start_date date not null,
  maturity_date date,
  closure_date date,
  last_payment_date date,
  next_payment_date date,

  payment_frequency text not null
    check (payment_frequency in ('Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'At Maturity', 'Irregular', 'Custom')),
  payment_day int check (payment_day between 1 and 31),
  first_payment_date date,
  payment_method text,
  payout_type text not null
    check (payout_type in ('Interest Only', 'Interest + Principal', 'Principal at Maturity', 'Interest at Maturity', 'EMI', 'Bullet', 'Custom')),
  interest_calculation_method text,
  principal_repayment_method text,

  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'MATURED', 'CLOSED', 'DEFAULTED', 'PARTIALLY_RECOVERED', 'WRITTEN_OFF', 'CANCELLED', 'ON_HOLD')),

  risk_rating text,
  risk_category text,
  collateral_available boolean not null default false,
  collateral_value numeric(14, 2),
  guarantor_available boolean not null default false,
  platform_rating text,
  user_risk_rating text,
  default_probability numeric(5, 2) check (default_probability between 0 and 100),
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (maturity_date is null or maturity_date >= start_date),
  check (closure_date is null or closure_date >= start_date)
);

create index if not exists deals_user_id_idx on public.deals (user_id);
create index if not exists deals_status_idx on public.deals (status);
create index if not exists deals_maturity_date_idx on public.deals (maturity_date);
create index if not exists deals_next_payment_date_idx on public.deals (next_payment_date);
create index if not exists deals_platform_id_idx on public.deals (platform_id);

alter table public.deals enable row level security;

drop policy if exists "select own deals" on public.deals;
create policy "select own deals"
  on public.deals for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own deals" on public.deals;
create policy "insert own deals"
  on public.deals for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own deals" on public.deals;
create policy "update own deals"
  on public.deals for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own deals" on public.deals;
create policy "delete own deals"
  on public.deals for delete
  to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_deals_updated_at on public.deals;
create trigger set_deals_updated_at
  before update on public.deals
  for each row execute function public.set_updated_at();
